//! The harness linked into the program: turns mode (contract section 6.1).
//!
//! The harness runs only inside a touchpoint, on the program's thread,
//! until the agent finishes its step. A front end decides what a step is:
//! the agent loop on a model, or a script in a test.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use abai_stub::content::{self, Content};
use abai_stub::link::{Embedded, Harness, Outcome, StubCore, Touch};
use abai_stub::manifest::{Manifest, Mode};
use abai_stub::region::Region;
use abai_stub::region::calls::{Target, Which};
use serde_json::Value;

use crate::agent::Agent;
use crate::audit::{self, AuditLog};
use crate::core::{Core, Options, Program, UserChannel};
use crate::model::resolve::resolve;
use crate::terminal::Terminal;
use crate::{cli, config};

/// Why the agent is being run.
#[derive(Debug, Clone, PartialEq)]
pub enum Wake {
    /// The program asks a decision; the agent answers it by `id`.
    Decision {
        id: String,
        name: String,
        context: Value,
    },
    /// The program gives the agent a turn.
    Turn { name: String },
    /// The install touchpoint.
    Install,
    /// Something the agent watches for happened: an event that wakes, a
    /// watch, a timer. `held` wakes before these were held back by the
    /// attention budget.
    Attention { reasons: Vec<String>, held: u64 },
}

impl Wake {
    /// The name of the content slot this wake uses, if it has one.
    pub fn slot(&self) -> Option<&str> {
        match self {
            Self::Decision { name, .. } | Self::Turn { name } => Some(name),
            Self::Install | Self::Attention { .. } => None,
        }
    }
}

/// How a step of the agent ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunEnd {
    /// The agent finished its step.
    Done,
    /// The model could not be reached; the harness detaches.
    Unreachable(String),
    /// The step could not be run at all, and the harness stays: a
    /// session with nobody to talk to.
    Failed(String),
    /// The harness was told to stop while the step ran: the step did not
    /// finish, and the harness detaches next.
    Cut,
}

/// What drives the core when the agent is given control.
pub trait Front: Send {
    /// Run the agent for one wake, until it finishes its step or
    /// `deadline` passes.
    fn run(&mut self, core: &mut Core, wake: &Wake, deadline: Option<Instant>) -> RunEnd;

    /// Run the agent for one line from the user, in a session.
    fn user_line(&mut self, core: &mut Core, line: &str) -> RunEnd;

    /// What a session says first.
    fn greeting(&self, core: &Core) -> String;

    /// The audited reason when a step ends with a decision unanswered.
    fn undecided(&self) -> &'static str {
        "the agent's turn ended without deciding"
    }
}

/// Makes the front end at attach. An error here fails the attach before
/// anything is touched: no model configured is the usual one.
pub type FrontFactory =
    Box<dyn Fn(&Manifest, &Content, Mode) -> Result<Box<dyn Front>, String> + Send + Sync>;
/// Makes the user channel at attach, or none.
pub type ChannelFactory = Box<dyn Fn() -> Option<Box<dyn UserChannel>> + Send + Sync>;

/// The program, reached in its own process.
struct InProcess {
    stub: Arc<StubCore>,
    /// Every call runs on the calling thread, whatever the mode: the
    /// process is the standard entry's, and has no program thread that
    /// would reach a safepoint.
    inline: bool,
}

impl Program for InProcess {
    fn region(&self) -> &Arc<Region> {
        &self.stub.region
    }

    fn manifest(&self) -> &Manifest {
        &self.stub.manifest
    }

    fn mode(&self) -> Mode {
        self.stub.mode
    }

    fn drive(&self, target: Target, limit: Duration, finished: &dyn Fn() -> bool) {
        if self.stub.mode == Mode::Turns || self.inline {
            // this is the program's thread, inside a touchpoint: every
            // call runs here and now
            if self.stub.serve(Which::All) == 0 {
                std::thread::sleep(limit.min(Duration::from_millis(1)));
            }
            return;
        }
        // thread mode: this is the harness thread. An immediate call runs
        // on it; a safepoint call waits for a program thread to reach a
        // safepoint, which wakes this thread when the reply is in.
        let immediate = matches!(
            target,
            Target::Capability {
                immediate: true,
                ..
            }
        );
        if immediate && self.stub.serve(Which::Immediate) > 0 {
            return;
        }
        let parked = &self.stub.region[abai_stub::region::header::PARKED];
        parked.store(1, std::sync::atomic::Ordering::SeqCst);
        // a reply that came in before the flag went up woke nobody
        if !finished() {
            std::thread::park_timeout(limit.min(Duration::from_millis(20)));
        }
        parked.store(0, std::sync::atomic::Ordering::SeqCst);
    }
}

struct State {
    core: Core,
    front: Box<dyn Front>,
}

/// The attached harness of turns mode.
struct TurnsHarness {
    state: Mutex<State>,
}

/// What the front is run for.
pub(crate) enum Step<'a> {
    Wake(&'a Wake, Option<Instant>),
    Line(&'a str),
}

/// Run the front for one step. A front that panics is a harness that
/// failed: it detaches.
pub(crate) fn run_front(core: &mut Core, front: &mut dyn Front, step: Step<'_>) -> RunEnd {
    let deadline = match step {
        Step::Wake(_, deadline) => deadline,
        Step::Line(_) => None,
    };
    core.set_deadline(deadline);
    // what the program or the agent's own watches bring counts against
    // the wakes budget; a line the user typed does not
    if matches!(step, Step::Wake(..)) {
        core.budget().delivered(Instant::now());
    }
    let ran = catch_unwind(AssertUnwindSafe(|| match step {
        Step::Wake(wake, deadline) => front.run(core, wake, deadline),
        Step::Line(line) => front.user_line(core, line),
    }));
    core.set_deadline(None);
    let end = ran.unwrap_or_else(|_| RunEnd::Unreachable("the harness failed".to_string()));
    // the user hears why the agent is gone, before it goes
    if let (RunEnd::Unreachable(reason), Some(channel)) = (&end, core.channel()) {
        channel.say(&format!("(the agent is detached: {reason})"));
    }
    end
}

/// What a session does with a line the user typed.
pub(crate) enum Typed<'a> {
    /// The user ended the session.
    Quit,
    /// Nothing to act on.
    Empty,
    Line(&'a str),
}

pub(crate) fn typed(line: &str) -> Typed<'_> {
    match line.trim() {
        "/quit" | "/exit" => Typed::Quit,
        "" => Typed::Empty,
        line => Typed::Line(line),
    }
}

/// Why a session cannot be opened, when it cannot.
pub(crate) fn no_session(core: &mut Core) -> Option<String> {
    core.channel().is_none().then(|| {
        "there is nobody to talk to: stdin is not a terminal (ABAI_CHANNEL=terminal uses it anyway)"
            .to_string()
    })
}

/// The person's loop of turns mode: the program is stopped inside the
/// touchpoint while the user and the agent talk.
fn session(core: &mut Core, front: &mut dyn Front) -> RunEnd {
    if let Some(why) = no_session(core) {
        return RunEnd::Failed(why);
    }
    let hello = front.greeting(core);
    if let Some(channel) = core.channel() {
        channel.say(&hello);
    }
    loop {
        let Some(line) = core.channel().and_then(|channel| channel.ask("> ")) else {
            return RunEnd::Done;
        };
        match typed(&line) {
            Typed::Quit => return RunEnd::Done,
            Typed::Empty => {}
            Typed::Line(line) => {
                core.drain();
                match run_front(core, front, Step::Line(line)) {
                    end @ (RunEnd::Unreachable(_) | RunEnd::Cut) => return end,
                    RunEnd::Done | RunEnd::Failed(_) => {}
                }
            }
        }
    }
}

/// End a touchpoint that ran: its audit line and its outcome.
pub(crate) fn end_touchpoint(core: &mut Core, name: &str, end: RunEnd) -> Outcome {
    match end {
        RunEnd::Done => {
            core.record_touch("touchpoint", name, "ok", None);
            Outcome::Done
        }
        RunEnd::Failed(reason) => {
            core.record_touch("touchpoint", name, "failed", Some(&reason));
            Outcome::Refused(reason)
        }
        RunEnd::Unreachable(reason) => {
            core.record_touch("touchpoint", name, "default", Some("detached"));
            core.lose_agent(&reason);
            Outcome::Detached
        }
        // the agent is not lost: the harness is going, and says so itself
        RunEnd::Cut => {
            core.record_touch("touchpoint", name, "default", Some("detached"));
            Outcome::Detached
        }
    }
}

/// Serve a decision, a turn or an install with the agent, and write its
/// audit line. The same in every mode: the caller decides on which
/// thread this runs. `asked` is when the program reached the touchpoint:
/// its timeout counts from then.
///
/// `still_wanted` is asked once, just before a decision's answer or a
/// turn is put on the record as done: a program thread that stopped
/// waiting says no, and the record then says it took the default.
pub(crate) fn serve_touch(
    core: &mut Core,
    front: &mut dyn Front,
    touch: Touch,
    asked: Instant,
    still_wanted: &dyn Fn() -> bool,
) -> Outcome {
    if !core.is_attached() {
        return Outcome::Unserved;
    }
    match touch {
        Touch::Decide {
            name,
            context,
            timeout,
        } => {
            let left = (asked + timeout).saturating_duration_since(Instant::now());
            let id = match core.open_decision(&name, context.clone(), left) {
                Ok(id) => id,
                Err(outcome) => return outcome,
            };
            if left.is_zero() {
                // its time went by before the agent was free for it
                return core.close_decision(&id, "timeout");
            }
            let wake = Wake::Decision {
                id: id.clone(),
                name,
                context,
            };
            // a decision always wakes, whatever the budget says
            match run_front(core, front, Step::Wake(&wake, Some(asked + timeout))) {
                RunEnd::Done | RunEnd::Failed(_) => {
                    // the word and the reason the TypeScript pair writes
                    let why = front.undecided();
                    core.close_decision_if(&id, "answered", Some(why), still_wanted)
                }
                RunEnd::Unreachable(reason) => {
                    core.lose_agent(&reason);
                    Outcome::Detached
                }
                // an answer given before the stop applies; with none the
                // default does, because the harness is going
                RunEnd::Cut => core.close_decision_if(&id, "detached", None, still_wanted),
            }
        }
        Touch::Turn { name, timeout } => {
            let deadline = asked + timeout;
            let now = Instant::now();
            if now >= deadline {
                core.record_touch("turn", &name, "default", Some("timeout"));
                return Outcome::Default;
            }
            if !core.budget().allows(now) {
                // beyond the budget a turn returns at once with nothing done
                core.record_touch("turn", &name, "default", Some("budget"));
                return Outcome::Default;
            }
            let wake = Wake::Turn { name: name.clone() };
            match run_front(core, front, Step::Wake(&wake, Some(deadline))) {
                RunEnd::Done | RunEnd::Failed(_) => {
                    let outcome = if Instant::now() > deadline || !still_wanted() {
                        "timeout"
                    } else {
                        "ok"
                    };
                    core.record_touch("turn", &name, outcome, None);
                    Outcome::Done
                }
                RunEnd::Unreachable(reason) => {
                    core.record_touch("turn", &name, "default", Some("detached"));
                    core.lose_agent(&reason);
                    Outcome::Detached
                }
                RunEnd::Cut => {
                    core.record_touch("turn", &name, "default", Some("detached"));
                    Outcome::Detached
                }
            }
        }
        Touch::Install => {
            let end = run_front(core, front, Step::Wake(&Wake::Install, None));
            end_touchpoint(core, "install", end)
        }
        Touch::Session => {
            let end = session(core, front);
            end_touchpoint(core, "session", end)
        }
    }
}

impl Harness for TurnsHarness {
    fn touch(&self, touch: Touch) -> Outcome {
        let asked = Instant::now();
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let State { core, front } = &mut *state;
        if core.is_attached() {
            // in turns mode the ring is read at touchpoints
            core.drain();
        }
        serve_touch(core, front.as_mut(), touch, asked, &|| true)
    }
}

/// A harness to link into a program, with its parts given.
pub struct Linked {
    pub front: FrontFactory,
    pub channel: ChannelFactory,
    pub options: Options,
    /// The home directory, for an audit path under `~/`. Default: `HOME`.
    pub home: Option<PathBuf>,
    /// The environment the run's network is found through. Default: the
    /// process's own.
    pub env: Option<Env>,
}

/// An environment, as a harness reads one.
pub type Env = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

impl Linked {
    /// One variable of the environment this harness reads.
    pub(crate) fn env(&self, name: &str) -> Option<String> {
        match &self.env {
            Some(env) => env(name),
            None => process_env(name),
        }
    }
}

impl std::fmt::Debug for Linked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Linked")
            .field("options", &self.options)
            .finish_non_exhaustive()
    }
}

impl Linked {
    /// `<prog> abai mcp` in turns and thread modes: serve the agent's
    /// tools for this process's program to an MCP client on stdio, until
    /// the client goes.
    fn mcp(&self, stub: Arc<StubCore>, args: &[String]) -> Result<(), String> {
        if let Some(extra) = args.first() {
            return Err(format!("mcp takes no argument ({extra})"));
        }
        self.serve_mcp(stub, crate::mcp::McpIo::stdio())
    }

    /// Serve the agent's tools for this process's program on `io`.
    pub fn serve_mcp(&self, stub: Arc<StubCore>, io: crate::mcp::McpIo) -> Result<(), String> {
        let name = &stub.manifest.name;
        let Some(root) = stub.root().map(Path::to_path_buf) else {
            return Err(format!(
                "the content of {name} was not found: run it from its checkout, or give the declarations a root"
            ));
        };
        let content = content::load(&root, &stub.manifest)?;
        let home = self
            .home
            .clone()
            .or_else(|| std::env::var_os("HOME").map(PathBuf::from));
        let log = AuditLog::open(audit::resolve(
            &stub.manifest.audit.path,
            Some(&root),
            home.as_deref(),
        ));
        #[cfg(unix)]
        let connected = crate::network::connect(&|name| self.env(name), &stub.manifest)?;
        let (front, channel) = crate::mcp::serve(io, &stub.manifest, &content, stub.mode, None);
        // the client puts each act to the person: that is the consent
        let options = Options {
            auto: true,
            ..self.options
        };
        let shared = Arc::new(crate::thread::Shared::new());
        shared.on_this_thread();
        crate::thread::wake_this_thread(&stub.region);
        let program = Arc::new(InProcess {
            stub: stub.clone(),
            inline: true,
        });
        #[allow(unused_mut)]
        let mut core = Core::attach(program, content, log, options, Some(Box::new(channel)));
        #[cfg(unix)]
        {
            let waking = shared.clone();
            core.set_network(connected, Arc::new(move || waking.unpark()));
        }
        shared.push(crate::thread::own_session(&shared, false));
        let ended = catch_unwind(AssertUnwindSafe(|| {
            crate::thread::run(&shared, core, Box::new(front))
        }));
        if ended.is_err() {
            stub.region[abai_stub::region::header::ATTACHED]
                .store(0, std::sync::atomic::Ordering::SeqCst);
        }
        shared.end();
        Ok(())
    }
}

impl Embedded for Linked {
    fn attach(&self, stub: Arc<StubCore>) -> Result<Arc<dyn Harness>, String> {
        if stub.mode == Mode::Sidecar {
            return Err("sidecar mode is not built yet".to_string());
        }
        let name = &stub.manifest.name;
        let Some(root) = stub.root().map(Path::to_path_buf) else {
            return Err(format!(
                "the content of {name} was not found: run it from its checkout, or give the declarations a root"
            ));
        };
        let content = content::load(&root, &stub.manifest)?;
        // no model configured is said at once, before anything that can
        // take time
        let front = (self.front)(&stub.manifest, &content, stub.mode)?;
        // a program that requires a network and has none attaches no agent
        #[cfg(unix)]
        let connected = crate::network::connect(&|name| self.env(name), &stub.manifest)?;
        let options = self.options;
        let home = self
            .home
            .clone()
            .or_else(|| std::env::var_os("HOME").map(PathBuf::from));
        let log = AuditLog::open(audit::resolve(
            &stub.manifest.audit.path,
            Some(&root),
            home.as_deref(),
        ));
        let mode = stub.mode;
        let program = Arc::new(InProcess {
            stub: stub.clone(),
            inline: false,
        });
        let channel = (self.channel)();
        if mode == Mode::Thread {
            // the waker is in place before the flag goes up
            return crate::thread::start(stub, move || {
                let mut core = Core::attach(program, content, log, options, channel);
                // a member's message wakes the harness thread, which this is
                #[cfg(unix)]
                {
                    let thread = std::thread::current();
                    core.set_network(connected, Arc::new(move || thread.unpark()));
                }
                (core, front)
            });
        }
        #[allow(unused_mut)]
        let mut core = Core::attach(program, content, log, self.options, channel);
        // in turns mode a message is read at the next touchpoint
        #[cfg(unix)]
        core.set_network(connected, Arc::new(|| {}));
        Ok(Arc::new(TurnsHarness {
            state: Mutex::new(State { core, front }),
        }))
    }

    fn entry(&self, stub: Arc<StubCore>, verb: &str, args: &[String]) -> Option<i32> {
        match verb {
            "config" => Some(cli::config_stdio(args, Some(&stub.manifest.name))),
            "mcp" => Some(match self.mcp(stub, args) {
                Ok(()) => 0,
                Err(reason) => {
                    eprintln!("abai mcp: {reason}");
                    1
                }
            }),
            _ => None,
        }
    }

    fn doctor(&self, stub: Arc<StubCore>) -> Option<Vec<abai_stub::doctor::DoctorCheck>> {
        let mut checks = cli::doctor_online(&process_env);
        checks.extend(cli::doctor_network(
            &process_env,
            Some(&stub.manifest.name),
            stub.manifest.network.as_ref(),
        ));
        Some(checks)
    }
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// The harness to link into a program: the machine's configured model,
/// and the terminal as the user channel when there is one.
///
/// `Abaigram::new(&declarations)?.with_harness(abai_harness::embedded())`
pub fn embedded() -> Box<dyn Embedded> {
    Box::new(linked())
}

/// The parts of the real harness: the machine's configured model, and the
/// terminal as the user channel when there is one.
pub fn linked() -> Linked {
    Linked {
        front: Box::new(|manifest, content, mode| {
            let home = config::home(&process_env)
                .ok_or("neither ABAI_HOME nor HOME is set, so no model is configured")?;
            let settings = config::load_config(&home)?;
            let model = resolve(&home, &settings, &process_env)?;
            Ok(Box::new(Agent::new(model, manifest, content, mode)))
        }),
        channel: Box::new(|| {
            // ABAI_CHANNEL says which; unset, a terminal on stdin is the user
            let wanted = match process_env("ABAI_CHANNEL").as_deref() {
                Some("terminal") => true,
                Some("none") => false,
                _ => std::io::IsTerminal::is_terminal(&std::io::stdin()),
            };
            wanted.then(|| Box::new(Terminal::stdio()) as Box<dyn UserChannel>)
        }),
        options: Options::default(),
        home: None,
        env: None,
    }
}
