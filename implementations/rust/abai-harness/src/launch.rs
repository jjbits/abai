//! Sidecar launch (contract sections 6.3, 5.5 and 5.7): the harness
//! starts the program as its child, hands it a connection, reads its
//! output, and is the one that can pause, stop and start it.
//!
//! Everything here acts on the one child this launcher started, through
//! the handle it got when it started it.

use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::ExitStatusExt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use abai_stub::region::header;
use abai_stub::sidecar::ENV_LAUNCH_FD;
use serde_json::{Map, Value, json};

use crate::core::{Core, EVENT_EXITED, Launcher, Outside, Program, Signal};
use crate::embedded::Linked;
use crate::sidecar::{Control, Remote, WhenGone, Wired, greet, parts};
use crate::thread::{self, Shared, own_session};

/// How long a program that was just started gets to take up the launch
/// connection.
const TAKE_UP: Duration = Duration::from_secs(10);
/// How many lines a second of one stream reach the agent; the rest are
/// counted (contract section 5.7).
const LINES_PER_SECOND: u32 = 200;
/// The most bytes of one line that reach the agent.
const LINE_BYTES: usize = 4096;

/// The child, as the launcher knows it.
#[derive(Default)]
struct Supervised {
    /// The pid of the running child. It stays this child's until the
    /// field is cleared, which is done before the child is reaped.
    running: Option<u32>,
    /// How the last child ended: its exit code, or the signal it died of.
    last: Option<(Option<i32>, Option<i32>)>,
    starts: u32,
    /// The launcher's own signal ended the last child, so its exit is
    /// not the program's own verdict.
    by_launcher: bool,
    /// The last child has exited and what its pipes held has been read.
    drained: bool,
}

/// How long after the child's exit its pipes are read for. A process the
/// child started may hold them open for good.
const DRAIN: Duration = Duration::from_millis(300);

/// Raised by the signals that ask the harness to end.
static INTERRUPTED: AtomicBool = AtomicBool::new(false);

extern "C" fn interrupted(_signal: libc::c_int) {
    INTERRUPTED.store(true, Ordering::SeqCst);
}

/// A harness that is told to end stops its program first; ended at once
/// it would leave the program writing to pipes nobody reads.
fn watch_signals() {
    for signal in [libc::SIGTERM, libc::SIGHUP, libc::SIGINT] {
        // SAFETY: the handler only stores to an atomic, which a signal
        // handler may do.
        unsafe {
            libc::signal(
                signal,
                interrupted as extern "C" fn(libc::c_int) as libc::sighandler_t,
            );
        }
    }
}

type State = Arc<(Mutex<Supervised>, Condvar)>;

fn lock(state: &State) -> MutexGuard<'_, Supervised> {
    state.0.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The exit code of a run under this launcher: the program's own when it
/// ended by itself, 128 plus the signal's number when it died of one,
/// and 0 when the launcher stopped it.
fn exit_code(state: &State) -> i32 {
    let state = lock(state);
    match state.last {
        _ if state.by_launcher => 0,
        Some((Some(code), _)) => code,
        Some((None, Some(signal))) => 128 + signal,
        _ => 1,
    }
}

fn observed(outside: &Outside, name: &str, payload: Value) {
    let payload = match payload {
        Value::Object(payload) => payload,
        _ => Map::new(),
    };
    outside
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push_back((name.to_string(), payload));
}

/// Read one of the child's pipes to its end, on a thread that never
/// stops. What is read goes through to the harness's own output at once,
/// so the person sees the program as it writes, a prompt with no newline
/// included. Each whole line also goes to the agent as an event; past a
/// number of lines a second they are counted, not kept, and a line is
/// cut at a length.
fn observe(
    mut pipe: impl Read + Send + 'static,
    name: &'static str,
    outside: Outside,
) -> Option<JoinHandle<()>> {
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            let (mut second, mut seen, mut dropped) = (Instant::now(), 0u32, 0u64);
            let mut line: Vec<u8> = Vec::new();
            // the rest of a line that was cut is skipped to its end
            let mut skipping = false;
            let mut chunk = [0u8; 8192];
            let mut keep = |line: &[u8]| {
                if second.elapsed() >= Duration::from_secs(1) {
                    if dropped > 0 {
                        observed(&outside, name, json!({"dropped": dropped}));
                    }
                    (second, seen, dropped) = (Instant::now(), 0, 0);
                }
                seen += 1;
                if seen > LINES_PER_SECOND {
                    dropped += 1;
                    return;
                }
                let text = String::from_utf8_lossy(line);
                observed(&outside, name, json!({"line": text.trim_end_matches('\r')}));
            };
            loop {
                let read = match pipe.read(&mut chunk) {
                    Ok(read) if read > 0 => read,
                    _ => break,
                };
                if name == "abai.io.stderr" {
                    let _ = std::io::stderr().write_all(&chunk[..read]);
                } else {
                    let mut out = std::io::stdout();
                    let _ = out.write_all(&chunk[..read]);
                    let _ = out.flush();
                }
                for &byte in &chunk[..read] {
                    if byte == b'\n' {
                        if !skipping {
                            keep(&line);
                        }
                        line.clear();
                        skipping = false;
                    } else if !skipping {
                        line.push(byte);
                        if line.len() >= LINE_BYTES {
                            keep(&line);
                            line.clear();
                            skipping = true;
                        }
                    }
                }
            }
            if !line.is_empty() && !skipping {
                keep(&line);
            }
            if dropped > 0 {
                observed(&outside, name, json!({"dropped": dropped}));
            }
        })
        // without the thread the pipe is closed, and the program's writes
        // fail rather than block
        .ok()
}

/// The harness as the program's parent.
struct Launch {
    command: Vec<String>,
    /// The harness has a user at its terminal, so the program does not
    /// read it.
    stdin_null: bool,
    shared: Arc<Shared>,
    outside: Outside,
    state: State,
    /// The connections of the program now running.
    wired: Option<Wired>,
    /// The control connection of the program now running, where the
    /// function that owns the run can reach it if the loop fails.
    control: Arc<Mutex<Option<Control>>>,
}

impl Launch {
    /// Start the program and take it up. An error means it is not
    /// attached; whether it runs is in the state.
    fn start_remote(&mut self) -> Result<Arc<Remote>, String> {
        let (ours, theirs) = UnixStream::pair()
            .map_err(|error| format!("the launch connection could not be made: {error}"))?;
        // the child's end has to outlive the exec
        // SAFETY: a flag change on a descriptor this function owns.
        unsafe {
            libc::fcntl(theirs.as_raw_fd(), libc::F_SETFD, 0);
        }
        let mut command = Command::new(&self.command[0]);
        command
            .args(&self.command[1..])
            .env(
                ENV_LAUNCH_FD,
                format!("{}:{}", theirs.as_raw_fd(), std::process::id()),
            )
            .env_remove("ABAI_HARNESS")
            // the invite holds the member's private key, and only the
            // harness reads it
            .env_remove(crate::net::ENV_NET_TOKEN)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if self.stdin_null {
            command.stdin(Stdio::null());
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("{} could not be started: {error}", self.command[0]))?;
        drop(theirs);
        let pid = child.id();
        {
            let mut state = lock(&self.state);
            state.running = Some(pid);
            state.starts += 1;
            state.by_launcher = false;
            state.drained = false;
        }
        let pipes = [
            child
                .stdout
                .take()
                .and_then(|pipe| observe(pipe, "abai.io.stdout", self.outside.clone())),
            child
                .stderr
                .take()
                .and_then(|pipe| observe(pipe, "abai.io.stderr", self.outside.clone())),
        ];
        self.wait_for(child, pid, pipes);

        let greeted = greet(ours, None, TAKE_UP).map_err(|reason| {
            if lock(&self.state).running.is_none() {
                "the program ended before it took up the launch connection".to_string()
            } else {
                format!("the program did not take up the launch connection: {reason}")
            }
        })?;
        let wired = greeted.wire(&self.shared, &self.outside, WhenGone::Stay)?;
        let program = wired.program.clone();
        *self.control.lock().unwrap_or_else(PoisonError::into_inner) =
            Some(program.control.clone());
        self.wired = Some(wired);
        Ok(program)
    }

    /// Wait for the child's exit on a thread of its own, and say so.
    fn wait_for(&self, mut child: Child, pid: u32, pipes: [Option<JoinHandle<()>>; 2]) {
        let (state, outside, shared) = (
            self.state.clone(),
            self.outside.clone(),
            self.shared.clone(),
        );
        let spawned = std::thread::Builder::new()
            .name("abai-exit".to_string())
            .spawn(move || {
                // wait for the exit without taking it: until it is taken
                // the pid stays this child's, so a signal sent under the
                // lock below cannot reach another process
                loop {
                    // SAFETY: `waitid` writes into a live, zeroed buffer
                    // of its own type, about a child of this process.
                    let waited = unsafe {
                        let mut info: libc::siginfo_t = std::mem::zeroed();
                        libc::waitid(
                            libc::P_PID,
                            pid as libc::id_t,
                            &mut info,
                            libc::WEXITED | libc::WNOWAIT,
                        )
                    };
                    let interrupted =
                        std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted;
                    if waited == 0 || !interrupted {
                        break;
                    }
                }
                let (code, signal) = {
                    let mut state = lock(&state);
                    let status = child.wait().ok();
                    let ended = (
                        status.and_then(|status| status.code()),
                        status.and_then(|status| status.signal()),
                    );
                    state.running = None;
                    state.last = Some(ended);
                    ended
                };
                state.1.notify_all();
                // the program's last lines come before the word of its
                // exit, for the agent and for the person
                let deadline = Instant::now() + DRAIN;
                while pipes.iter().flatten().any(|pipe| !pipe.is_finished())
                    && Instant::now() < deadline
                {
                    std::thread::sleep(Duration::from_millis(2));
                }
                observed(
                    &outside,
                    EVENT_EXITED,
                    json!({"pid": pid, "code": code, "signal": signal}),
                );
                // only now is the program over for whoever asks: its exit
                // has been said
                lock(&state).drained = true;
                state.1.notify_all();
                shared.unpark();
            });
        drop(spawned);
    }
}

impl Launcher for Launch {
    fn running(&self) -> bool {
        // until its exit has been said, with its last output before it,
        // the program is not over
        let state = lock(&self.state);
        state.running.is_some() || (state.starts > 0 && !state.drained)
    }

    fn state(&self) -> Value {
        let state = lock(&self.state);
        json!({
            "command": self.command,
            "running": state.running.is_some(),
            "pid": state.running,
            "exit": state.last.map(|(code, signal)| json!({"code": code, "signal": signal})),
            "starts": state.starts,
        })
    }

    fn signal(&mut self, signal: Signal) -> Result<(), String> {
        let number = match signal {
            Signal::Stop => libc::SIGSTOP,
            Signal::Continue => libc::SIGCONT,
            Signal::Terminate => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        };
        let mut state = lock(&self.state);
        let Some(pid) = state.running else {
            return Err("the program is not running".to_string());
        };
        if matches!(signal, Signal::Terminate | Signal::Kill) {
            state.by_launcher = true;
        }
        // SAFETY: the pid is this launcher's own child, which has not
        // been reaped: the lock is held, and the reaper takes it first.
        let sent = unsafe { libc::kill(pid as libc::pid_t, number) };
        if sent == 0 {
            Ok(())
        } else {
            Err(format!(
                "the signal could not be sent: {}",
                std::io::Error::last_os_error()
            ))
        }
    }

    fn wait_exit(&mut self, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        let mut state = lock(&self.state);
        while state.running.is_some() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            state = self
                .state
                .1
                .wait_timeout(state, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        // it has exited in time. Its last output is still being read;
        // that is waited for too, and is not counted against the limit
        let drained = Instant::now() + DRAIN * 2;
        while !state.drained && Instant::now() < drained {
            state = self
                .state
                .1
                .wait_timeout(state, Duration::from_millis(20))
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        true
    }

    fn start(&mut self) -> Result<Arc<dyn Program>, String> {
        let program: Arc<dyn Program> = self.start_remote()?;
        Ok(program)
    }
}

/// `abai-harness run -- PROGRAM ARGS`: start the program as a supervised
/// child, attach to it, and serve it until it ends. With a user at the
/// terminal a session is open from the start, and the program is stopped
/// when the user leaves. Returns the exit code of the run.
pub fn launch(command: &[String], linked: &Linked) -> Result<i32, String> {
    if command.is_empty() {
        return Err("run needs the program's command".to_string());
    }
    let shared = Arc::new(Shared::new());
    shared.on_this_thread();
    watch_signals();
    shared.watch_interrupt(&INTERRUPTED);
    let outside = Outside::default();
    let state: State = Arc::default();
    let control: Arc<Mutex<Option<Control>>> = Arc::default();
    let channel = (linked.channel)();
    let has_user = channel.is_some();
    let mut launch = Launch {
        command: command.to_vec(),
        stdin_null: has_user,
        shared: shared.clone(),
        outside: outside.clone(),
        state: state.clone(),
        wired: None,
        control: control.clone(),
    };

    // the program runs with or without its agent: when the agent cannot
    // be attached the harness says why, and stays as the parent that
    // reads the program's output until it ends
    let plain = |state: &State, reason: &str| {
        eprintln!("abai-harness: the program runs without its agent: {reason}");
        let mut told = false;
        let mut supervised = lock(state);
        // until the program has exited and its output has been written
        while supervised.running.is_some() || !supervised.drained {
            // a harness told to end passes the word on to the program
            if let (Some(pid), true, false) =
                (supervised.running, INTERRUPTED.load(Ordering::SeqCst), told)
            {
                told = true;
                // SAFETY: the pid is this launcher's own child, not yet
                // reaped: the lock is held, and the reaper takes it first.
                unsafe {
                    libc::kill(pid as libc::pid_t, libc::SIGTERM);
                }
            }
            supervised = state
                .1
                .wait_timeout(supervised, Duration::from_millis(100))
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        drop(supervised);
        exit_code(state)
    };
    let program = match launch.start_remote() {
        Ok(program) => program,
        Err(reason) if lock(&state).starts == 0 => return Err(reason),
        Err(reason) => return Ok(plain(&state, &reason)),
    };
    let made = parts(linked, program.manifest(), program.root.as_deref()).and_then(|parts| {
        crate::network::connect(&|name| linked.env(name), program.manifest())
            .map(|connected| (connected, parts))
    });
    let (connected, (content, front, log)) = match made {
        Ok(made) => made,
        Err(reason) => {
            if let Some(wired) = &launch.wired {
                wired.leave(&reason);
            }
            return Ok(plain(&state, &reason));
        }
    };
    let region = program.region().clone();
    let mut core = Core::attach(program, content, log, linked.options, channel);
    core.set_outside(outside);
    core.set_launcher(Box::new(launch));
    let waking = shared.clone();
    core.set_network(connected, Arc::new(move || waking.unpark()));
    if has_user {
        shared.push(own_session(&shared, true));
    }

    let ended = catch_unwind(AssertUnwindSafe(|| thread::run(&shared, core, front)));
    shared.end();
    if ended.is_err() {
        // the harness failed: the program is let go and runs on as the
        // plain program. Whatever pause the agent had put it in ends.
        region[header::ATTACHED].store(0, Ordering::SeqCst);
        if let Some(control) = control
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            control.send(&json!({"op": "detach", "reason": "the harness failed"}));
            control.close();
        }
        if let Some(pid) = lock(&state).running {
            // SAFETY: as above: this launcher's own child, under the lock.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGCONT);
            }
        }
        return Ok(plain(&state, "the harness failed"));
    }
    // the last of the program's output is written before the harness goes
    let deadline = Instant::now() + DRAIN * 2;
    let mut supervised = lock(&state);
    while supervised.running.is_none() && !supervised.drained && Instant::now() < deadline {
        supervised = state
            .1
            .wait_timeout(supervised, Duration::from_millis(20))
            .unwrap_or_else(PoisonError::into_inner)
            .0;
    }
    drop(supervised);
    Ok(exit_code(&state))
}
