//! The harness as a process of its own: sidecar mode (contract section
//! 6.3).
//!
//! The harness connects to the program's socket, maps the program's
//! region, and from then on runs the same loop thread mode runs. Two
//! small threads feed that loop: one reads the control connection, where
//! the program's touchpoints arrive as lines; one reads the wake
//! connection, where each byte means "look at the region".

use std::collections::HashMap;
use std::io::{BufReader, Read};
use std::os::unix::net::UnixStream;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use abai_stub::content::{self, Content};
use abai_stub::link::{Outcome, Touch};
use abai_stub::manifest::{Manifest, Mode};
use abai_stub::region::calls::Target;
use abai_stub::region::{Region, header};
use abai_stub::sidecar::{PROTOCOL, line_touch, outcome_line, read_line, send_line};
use serde_json::{Value, json};

use crate::audit::{self, AuditLog};
use crate::core::{Core, Outside, Program};
use crate::embedded::{Front, Linked};
use crate::thread::{self, Job, Shared, own_session};

/// How long the harness waits for the program's line while they greet.
const HANDSHAKE: Duration = Duration::from_secs(2);
/// How long the harness waits for the program to say whether a
/// touchpoint's thread is still waiting.
const CLAIM_WAIT: Duration = Duration::from_secs(5);

/// The control connection's writing end, shared by the loop and the jobs.
#[derive(Clone)]
pub(crate) struct Control(Arc<Mutex<UnixStream>>);

impl Control {
    pub(crate) fn send(&self, line: &Value) -> bool {
        let mut stream = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        send_line(&mut stream, line).is_ok()
    }

    pub(crate) fn close(&self) {
        let stream = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }
}

/// The program, reached in another process.
pub(crate) struct Remote {
    region: Arc<Region>,
    manifest: Manifest,
    pub(crate) control: Control,
    /// Where the program's content is, as the program found it.
    pub(crate) root: Option<PathBuf>,
    /// The control connection has ended: the program has gone.
    gone: Arc<AtomicBool>,
}

impl Program for Remote {
    fn region(&self) -> &Arc<Region> {
        &self.region
    }

    fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    fn mode(&self) -> Mode {
        Mode::Sidecar
    }

    fn posted(&self, target: Target) {
        // an immediate call runs on the program's receiving thread, which
        // has to be told; a safepoint call is found through the region
        if target.immediate() {
            self.control.send(&json!({"op": "serve"}));
        }
    }

    fn drive(&self, _target: Target, limit: Duration, finished: &dyn Fn() -> bool) {
        // the program wakes this thread when the reply is in
        let parked = &self.region[header::PARKED];
        parked.store(1, Ordering::SeqCst);
        if !finished() {
            std::thread::park_timeout(limit.min(Duration::from_millis(20)));
        }
        parked.store(0, Ordering::SeqCst);
    }

    fn alive(&self) -> bool {
        !self.gone.load(Ordering::SeqCst)
    }

    fn resumed(&self) {
        self.control.send(&json!({"op": "resume"}));
    }

    fn bound(&self) {
        self.control.send(&json!({"op": "attached"}));
    }

    fn leave(&self, reason: &str) {
        self.control
            .send(&json!({"op": "detach", "reason": reason}));
        self.control.close();
    }
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// The program's answers to the harness's claims.
#[derive(Default)]
struct Claims {
    /// The claims being waited on, with the answer once it has come,
    /// and whether the program has gone.
    answers: Mutex<(HashMap<u64, Option<bool>>, bool)>,
    changed: Condvar,
}

impl Claims {
    fn answer(&self, id: u64, held: bool) {
        // an answer nobody waits for any more is not kept
        if let Some(waited) = self
            .answers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .0
            .get_mut(&id)
        {
            *waited = Some(held);
        }
        self.changed.notify_all();
    }

    /// Say that an answer for `id` will be waited for. Before the claim
    /// is sent, so the answer cannot come first and be dropped.
    fn expect(&self, id: u64) {
        self.answers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .0
            .insert(id, None);
    }

    /// The program has gone: no answer will come.
    fn close(&self) {
        self.answers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .1 = true;
        self.changed.notify_all();
    }

    fn wait(&self, id: u64) -> bool {
        let deadline = Instant::now() + CLAIM_WAIT;
        let mut answers = self.answers.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            if let Some(Some(held)) = answers.0.get(&id).copied() {
                answers.0.remove(&id);
                return held;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if answers.1 || left.is_zero() {
                answers.0.remove(&id);
                return false;
            }
            answers = self
                .changed
                .wait_timeout(answers, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
}

const UNKNOWN: u8 = 0;
const HELD: u8 = 1;
const LOST: u8 = 2;

/// A touchpoint that came over the control connection, as the loop takes
/// it.
fn job(id: u64, touch: Touch, control: &Control, claims: &Arc<Claims>) -> Job {
    let (ask, answers) = (control.clone(), claims.clone());
    let known = AtomicU8::new(UNKNOWN);
    let reply = control.clone();
    Job {
        touch,
        asked: Instant::now(),
        claim: Box::new(move || {
            // asked of the program once; the answer does not change
            match known.load(Ordering::SeqCst) {
                HELD => return true,
                LOST => return false,
                _ => {}
            }
            answers.expect(id);
            let held = ask.send(&json!({"op": "claim", "id": id})) && answers.wait(id);
            known.store(if held { HELD } else { LOST }, Ordering::SeqCst);
            held
        }),
        reply: Box::new(move |outcome: Outcome| {
            reply.send(&outcome_line(id, &outcome));
        }),
        own: false,
    }
}

pub use crate::thread::SESSION_ENDED;

/// How an attached harness process ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ended {
    /// Why it detached.
    pub reason: String,
}

/// What to do once attached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Then {
    /// Serve the program until it goes or the harness detaches.
    Serve,
    /// Open a session with the user at once, and leave when it ends.
    Session,
}

/// A program that has answered the hello, with its region mapped.
pub(crate) struct Greeted {
    pub(crate) control: Control,
    reader: BufReader<UnixStream>,
    wake: UnixStream,
    pub(crate) manifest: Manifest,
    region: Arc<Region>,
    pub(crate) root: Option<PathBuf>,
}

/// Greet the program at the other end of `stream`, which waits `wait`
/// for its answer, and map its region. The wake connection is made to
/// `socket`, or to the socket the program names.
pub(crate) fn greet(
    mut stream: UnixStream,
    socket: Option<&Path>,
    wait: Duration,
) -> Result<Greeted, String> {
    let io = |error: std::io::Error| format!("the program's socket failed: {error}");
    stream.set_read_timeout(Some(wait)).map_err(io)?;
    send_line(&mut stream, &json!({"abai": "hello", "protocol": PROTOCOL})).map_err(io)?;
    let mut reader = BufReader::new(stream.try_clone().map_err(io)?);
    let hello = read_line(&mut reader)
        .ok_or("the program did not answer: it is no abaigram in sidecar mode, or another harness is attaching to it")?;
    if hello["abai"] == "refused" {
        return Err(format!(
            "the program refused: {}",
            hello["reason"].as_str().unwrap_or("no reason given")
        ));
    }
    if hello["abai"] != "hello" || hello["protocol"] != PROTOCOL {
        return Err(format!("what answered does not speak protocol {PROTOCOL}"));
    }

    // the second connection, where the program writes its wakes
    let socket = match socket {
        Some(socket) => socket.to_path_buf(),
        None => hello["socket"]
            .as_str()
            .map(PathBuf::from)
            .ok_or("the program named no socket")?,
    };
    let mut wake = UnixStream::connect(&socket)
        .map_err(|error| format!("no program is listening at {}: {error}", socket.display()))?;
    send_line(&mut wake, &json!({"abai": "wake", "token": hello["token"]})).map_err(io)?;
    stream.set_read_timeout(None).map_err(io)?;

    let control = Control(Arc::new(Mutex::new(stream)));
    // from here on the program hears why an attach did not happen
    let refuse = |reason: String| {
        control.send(&json!({"op": "detach", "reason": reason}));
        reason
    };
    let manifest: Manifest = serde_json::from_value(hello["manifest"].clone())
        .map_err(|error| refuse(format!("the program's manifest is not one: {error}")))?;
    let region_path = hello["region"]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| refuse("the program named no region".to_string()))?;
    let region = Region::open_shared(&manifest, &region_path).map_err(&refuse)?;
    let root = hello["root"].as_str().map(PathBuf::from);
    Ok(Greeted {
        control,
        reader,
        wake,
        manifest,
        region,
        root,
    })
}

/// What the loop does when the program's connection ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WhenGone {
    /// The harness detaches and ends: it only attached.
    Detach,
    /// The harness goes on: it launched the program, and hears of its
    /// exit from the process itself.
    Stay,
}

/// A program whose connections feed the loop.
pub(crate) struct Wired {
    pub(crate) program: Arc<Remote>,
    /// The wake connection, to shut when the harness leaves.
    wake_end: UnixStream,
}

impl Wired {
    /// The harness leaves: the program is told why, and the connections
    /// are shut, which ends the two threads.
    pub(crate) fn leave(&self, reason: &str) {
        self.program
            .control
            .send(&json!({"op": "detach", "reason": reason}));
        self.program.control.close();
        let _ = self.wake_end.shutdown(std::net::Shutdown::Both);
    }
}

impl Greeted {
    /// Tell the program why the harness will not attach after all.
    pub(crate) fn refuse(&self, reason: String) -> String {
        self.control
            .send(&json!({"op": "detach", "reason": reason}));
        reason
    }

    /// Start the two threads that feed the loop: one turns each wake
    /// byte into an unpark, one reads the control connection.
    pub(crate) fn wire(
        self,
        shared: &Arc<Shared>,
        outside: &Outside,
        when_gone: WhenGone,
    ) -> Result<Wired, String> {
        let Greeted {
            control,
            mut reader,
            mut wake,
            manifest,
            region,
            root,
        } = self;
        let failed = |error: std::io::Error| {
            let reason = format!("a thread could not be started: {error}");
            control.send(&json!({"op": "detach", "reason": reason}));
            reason
        };
        let wake_end = wake
            .try_clone()
            .map_err(|error| format!("the program's socket failed: {error}"))?;
        let waking = shared.clone();
        std::thread::Builder::new()
            .name("abai-wake".to_string())
            .spawn(move || {
                let mut bytes = [0u8; 64];
                while matches!(wake.read(&mut bytes), Ok(read) if read > 0) {
                    waking.unpark();
                }
            })
            .map_err(failed)?;

        let gone = Arc::new(AtomicBool::new(false));
        let claims = Arc::new(Claims::default());
        let (reading, replies, observed, went) = (
            shared.clone(),
            control.clone(),
            outside.clone(),
            gone.clone(),
        );
        std::thread::Builder::new()
            .name("abai-control".to_string())
            .spawn(move || {
                while let Some(line) = read_line(&mut reader) {
                    match line["op"].as_str() {
                        Some("touch") => {
                            if let Some((id, touch)) = line_touch(&line) {
                                // a job the loop no longer takes is dropped,
                                // and the program hears nothing: it counts it
                                reading.push(job(id, touch, &replies, &claims));
                            }
                        }
                        Some("claimed") => {
                            if let Some(id) = line["id"].as_u64() {
                                claims.answer(id, line["ok"] == true);
                            }
                        }
                        Some("event") => {
                            // what the stub itself reports: a touchpoint
                            // held by a pause
                            if let (Some(name), Some(payload)) =
                                (line["name"].as_str(), line["payload"].as_object())
                            {
                                observed
                                    .lock()
                                    .unwrap_or_else(PoisonError::into_inner)
                                    .push_back((name.to_string(), payload.clone()));
                                reading.unpark();
                            }
                        }
                        _ => {}
                    }
                }
                went.store(true, Ordering::SeqCst);
                claims.close();
                match when_gone {
                    WhenGone::Detach => reading.stop("the program has gone"),
                    WhenGone::Stay => reading.unpark(),
                }
            })
            .map_err(failed)?;
        Ok(Wired {
            program: Arc::new(Remote {
                region,
                manifest,
                control,
                root,
                gone,
            }),
            wake_end,
        })
    }
}

/// The content, the front end and the audit log of a program, as every
/// harness process makes them once it knows the program.
pub(crate) fn parts(
    linked: &Linked,
    manifest: &Manifest,
    root: Option<&Path>,
) -> Result<(Content, Box<dyn Front>, AuditLog), String> {
    let root = root.ok_or_else(|| {
        format!(
            "the content of {} was not found: run it from its checkout, or give the declarations a root",
            manifest.name
        )
    })?;
    let content = content::load(root, manifest)?;
    let front = (linked.front)(manifest, &content, Mode::Sidecar)?;
    let home = linked
        .home
        .clone()
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from));
    let log = AuditLog::open(audit::resolve(
        &manifest.audit.path,
        Some(root),
        home.as_deref(),
    ));
    Ok((content, front, log))
}

/// Attach to the program listening at `socket`, and serve it on the
/// calling thread until the harness detaches or the program goes.
///
/// An error means the harness never attached; the program has been told
/// why when it could be.
pub fn serve(socket: &Path, linked: &Linked, then: Then) -> Result<Ended, String> {
    let stream = UnixStream::connect(socket)
        .map_err(|error| format!("no program is listening at {}: {error}", socket.display()))?;
    let greeted = greet(stream, Some(socket), HANDSHAKE)?;
    // no model configured is said at once, before the network, which
    // can take time
    let made = parts(linked, &greeted.manifest, greeted.root.as_deref()).and_then(|parts| {
        crate::network::connect(&|name| linked.env(name), &greeted.manifest)
            .map(|connected| (connected, parts))
    });
    let (connected, (content, front, log)) = made.map_err(|reason| greeted.refuse(reason))?;
    let channel = (linked.channel)();

    let shared = Arc::new(Shared::new());
    shared.on_this_thread();
    let outside = Outside::default();
    let wired = greeted.wire(&shared, &outside, WhenGone::Detach)?;
    // the attached flag goes up in the region here, and the program is told
    let mut core = Core::attach(wired.program.clone(), content, log, linked.options, channel);
    core.set_outside(outside);
    let waking = shared.clone();
    core.set_network(connected, Arc::new(move || waking.unpark()));
    if then == Then::Session {
        shared.push(own_session(&shared, false));
    }

    // a panic in the loop is the harness's failure: the flag still goes
    // down, and the program runs on
    let region = wired.program.region().clone();
    let ended = catch_unwind(AssertUnwindSafe(|| thread::run(&shared, core, front)));
    let reason = match ended {
        Ok(reason) => reason.unwrap_or_else(|| "the harness detached".to_string()),
        Err(_) => {
            region[header::ATTACHED].store(0, Ordering::SeqCst);
            "the harness failed".to_string()
        }
    };
    shared.end();
    wired.leave(&reason);
    Ok(Ended { reason })
}

/// `abai-harness mcp`: attach to the program listening at `socket` and
/// serve its agent's tools to an MCP client on `io`, until the client
/// goes. When the program goes the server stays, and `abai_attach`
/// attaches it to the program again.
pub fn serve_mcp(
    socket: &Path,
    options: crate::core::Options,
    home: Option<PathBuf>,
    io: crate::mcp::McpIo,
) -> Result<(), String> {
    let connect = |socket: &Path| {
        UnixStream::connect(socket)
            .map_err(|error| format!("no program is listening at {}: {error}", socket.display()))
    };
    let greeted = greet(connect(socket)?, Some(socket), HANDSHAKE)?;
    let manifest = greeted.manifest.clone();
    let made = (|| {
        let root = greeted.root.as_deref().ok_or_else(|| {
            format!(
                "the content of {} was not found: run it from its checkout, or give the declarations a root",
                manifest.name
            )
        })?;
        let content = content::load(root, &manifest)?;
        let home = home.or_else(|| std::env::var_os("HOME").map(PathBuf::from));
        let log = AuditLog::open(audit::resolve(
            &manifest.audit.path,
            Some(root),
            home.as_deref(),
        ));
        let connected = crate::network::connect(&process_env, &manifest)?;
        Ok::<_, String>((content, log, connected))
    })();
    let (content, log, connected) = made.map_err(|reason| greeted.refuse(reason))?;

    let shared = Arc::new(Shared::new());
    shared.on_this_thread();
    let outside = Outside::default();
    let wired = greeted.wire(&shared, &outside, WhenGone::Stay)?;

    // the same program, come back in a new process
    let (again_shared, again_outside, name) =
        (shared.clone(), outside.clone(), manifest.name.clone());
    let later: Arc<Mutex<Vec<Wired>>> = Arc::default();
    let attached_later = later.clone();
    let attach: crate::mcp::Attach = Box::new(move |core, target| {
        // a program that has just gone is not one to stay attached to
        if core.is_attached() && !core.program_alive() {
            core.detach("the program has gone");
        }
        if core.is_attached() {
            return Ok(format!("already attached to {name}"));
        }
        let socket = crate::command::find(target.unwrap_or(&name))?;
        let greeted = greet(connect(&socket)?, Some(&socket), HANDSHAKE)?;
        if greeted.manifest != *core.manifest() {
            return Err(greeted.refuse(format!(
                "{} is not the program this server was started for ({name}), or its declarations have changed: start a server for it",
                greeted.manifest.name
            )));
        }
        let wired = greeted.wire(&again_shared, &again_outside, WhenGone::Stay)?;
        core.attach_program(wired.program.clone());
        attached_later
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(wired);
        Ok(format!("attached to {name}"))
    });
    let (front, channel) = crate::mcp::serve(io, &manifest, &content, Mode::Sidecar, Some(attach));
    // the client puts each act to the person: that is the consent
    let options = crate::core::Options {
        auto: true,
        ..options
    };
    let mut core = Core::attach(
        wired.program.clone(),
        content,
        log,
        options,
        Some(Box::new(channel)),
    );
    core.set_outside(outside);
    core.set_stays(true);
    let waking = shared.clone();
    core.set_network(connected, Arc::new(move || waking.unpark()));
    shared.push(own_session(&shared, false));

    let ended = catch_unwind(AssertUnwindSafe(|| {
        thread::run(&shared, core, Box::new(front))
    }));
    shared.end();
    // every program this server was attached to is told it has left
    let mut all = vec![wired];
    all.append(&mut later.lock().unwrap_or_else(PoisonError::into_inner));
    for wired in &all {
        if ended.is_err() {
            wired.program.region()[header::ATTACHED].store(0, Ordering::SeqCst);
        }
        wired.leave("the MCP client has gone");
    }
    Ok(())
}
