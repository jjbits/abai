//! The harness core: the agent end of every channel for one attached
//! program, the same in every mode and behind every front end.
//!
//! The core reads the region directly. It enforces policy and consent
//! (contract section 10), performs the acts, and writes the audit line of
//! each. It knows no model: a front end drives it.

use std::collections::VecDeque;
use std::fmt;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use abai_stub::content::Content;
use abai_stub::link::Outcome;
use abai_stub::manifest::{
    DEFAULT_CAPABILITY_TIMEOUT, DEFAULT_KNOB_TIMEOUT, Dispatch, Effect, Manifest, Mode, Pause,
    Policy, Schema, duration_ms, matches_type,
};
use abai_stub::region::calls::{self, Abandoned, PostError, Target};
use abai_stub::region::ring::{Item, Reader, STALL};
use abai_stub::region::{Region, SAFEPOINT_PAUSED, cells, header};
use serde_json::{Map, Value, json};

use crate::attention::{Budget, Timer, Watch, WatchOp, event_wakes};
use crate::audit::{AuditLog, Entry};
use crate::model::Cancel;

/// How long a `confirm` waits for the user when the manifest does not say.
const DEFAULT_CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);
/// How often a watched cell is looked at when neither the watch nor the
/// cell's declaration says.
const DEFAULT_WATCH_CADENCE_MS: u64 = 1000;
/// The longest between two looks at a watched cell: an hour.
const MAX_WATCH_CADENCE_MS: u64 = 3_600_000;
/// The most watches, and the most timers, at once.
const MAX_WATCHES: usize = 32;
/// The longest a timer can be set for: a day.
const MAX_TIMER_SECONDS: f64 = 86_400.0;
/// How many lines the transcript keeps.
const TRANSCRIPT_LINES: usize = 2000;
/// A decision is not answered this close to its deadline: the program
/// would have moved on before the answer landed.
const DECIDE_MARGIN: Duration = Duration::from_millis(250);

/// Why an act did not happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    /// Nothing of that name is declared.
    Unknown,
    /// Policy forbids the act.
    Forbidden,
    /// The user, or the harness's own options, refused it.
    Denied,
    /// The arguments are not what the declaration says.
    Invalid,
    /// The program did not serve it in time.
    Timeout,
    /// The program's handler failed, in its own words.
    Error,
    /// No program is attached.
    Detached,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Forbidden => "forbidden",
            Self::Denied => "denied",
            Self::Invalid => "invalid",
            Self::Timeout => "timeout",
            Self::Error => "error",
            Self::Detached => "detached",
        }
    }
}

/// An act that did not happen, with the words for the agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActError {
    pub code: Code,
    pub message: String,
}

impl ActError {
    fn new(code: Code, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ActError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ActError {}

/// What stands for the user's consent to a `confirm` act.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Consent {
    /// The user said yes.
    Approved,
    /// Nobody was asked: the harness runs with `--auto`, or its front end
    /// is a client that asks the user itself.
    Auto,
    /// The user said no, did not answer in time, or there is no user.
    Denied,
}

impl Consent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::Auto => "auto",
            Self::Denied => "denied",
        }
    }
}

/// The harness's way to the user (contract section 4.5).
pub trait UserChannel: Send {
    /// Say something to the user.
    fn say(&mut self, text: &str);
    /// Wait for the user's next line. None means the user has gone.
    fn ask(&mut self, prompt: &str) -> Option<String>;
    /// Put a `confirm` act to the user. An answer that does not come
    /// within `timeout` is a no.
    fn confirm(&mut self, question: &str, timeout: Duration) -> bool;

    /// Wait up to `wait` for the user's next line, showing nothing. None
    /// means no line yet; Some(None) means the user has gone. A channel
    /// that cannot wait with a limit waits for the line.
    fn try_line(&mut self, wait: Duration) -> Option<Option<String>> {
        let _ = wait;
        Some(self.ask(""))
    }

    /// Show the prompt for a line that `try_line` then waits for.
    fn prompt(&mut self, prompt: &str) {
        let _ = prompt;
    }
}

/// How the core reaches the program beyond the region.
pub trait Program: Send + Sync {
    fn region(&self) -> &Arc<Region>;
    fn manifest(&self) -> &Manifest;
    fn mode(&self) -> Mode;
    /// A call has just been posted.
    fn posted(&self, target: Target) {
        let _ = target;
    }
    /// A posted call is open: get it served, or wait for the program to
    /// serve it. Returns when the call may have finished, and no later
    /// than `limit`. `finished` says whether it has; a program that waits
    /// asks it once more after it has said it is waiting.
    fn drive(&self, target: Target, limit: Duration, finished: &dyn Fn() -> bool);
    /// Whether the program is still there to serve a call. A program in
    /// this process always is.
    fn alive(&self) -> bool {
        true
    }
    /// A cooperative pause has been lifted in the region: wake the
    /// threads it holds.
    fn resumed(&self) {}
    /// A core is attached to this program: its touchpoints are served
    /// from now on.
    fn bound(&self) {}
    /// The agent is gone for good: let the program go, so it stops
    /// waiting for this harness and can take another.
    fn leave(&self, reason: &str) {
        let _ = reason;
    }
}

/// What reaches the agent from outside the region, as events: the
/// program's output and its exit under launch (contract section 5.7),
/// and what the stub says over the control connection.
pub type Outside = Arc<Mutex<VecDeque<(String, Map<String, Value>)>>>;

/// The event of the program's exit.
pub const EVENT_EXITED: &str = "abai.lifecycle.exited";
/// The event of a touchpoint held by a cooperative pause.
pub const EVENT_PAUSE_BLOCKED: &str = "abai.pause.blocked";
/// How long the program gets after each of the launcher's signals.
const FORCE_GRACE: Duration = Duration::from_secs(2);

/// A signal a launcher sends the program it started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    /// Hold the process (an `os` pause).
    Stop,
    /// Let a held process go on.
    Continue,
    /// Ask it to end.
    Terminate,
    /// End it.
    Kill,
}

/// The harness as the program's parent (contract section 5.5): what only
/// a harness that launched the program can do.
pub trait Launcher: Send {
    /// Whether the program it started is running.
    fn running(&self) -> bool;
    /// The launch, for `status`: running, pid, last exit, starts.
    fn state(&self) -> Value;
    /// Send the running program a signal.
    fn signal(&mut self, signal: Signal) -> Result<(), String>;
    /// Wait until the program has exited, at most `limit`. Returns
    /// whether it has.
    fn wait_exit(&mut self, limit: Duration) -> bool;
    /// Start the program again, and return it once it is connected.
    fn start(&mut self) -> Result<Arc<dyn Program>, String>;
}

/// The harness's own switches.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Options {
    /// Treat every `confirm` act as consented to, without asking.
    pub auto: bool,
    /// Refuse every capability whose effect is `mutate`.
    pub deny_mutate: bool,
}

/// A declared field of an object may be absent; a present one must be of
/// its type; a field that is not declared is refused. Returns what is
/// wrong, if anything.
pub fn schema_problem(value: &Value, schema: &Schema) -> Option<String> {
    let Some(object) = value.as_object() else {
        return Some("must be an object".to_string());
    };
    for (key, present) in object {
        match schema.get(key) {
            None => return Some(format!("{key} is not declared")),
            Some(field) if !matches_type(present, field) => {
                return Some(format!("{key} is not of type {}", field.ty.as_str()));
            }
            Some(_) => {}
        }
    }
    None
}

/// What the harness has seen, as numbered lines the agent can reread.
#[derive(Debug, Default)]
pub struct Transcript {
    lines: VecDeque<(u64, String)>,
    next: u64,
}

impl Transcript {
    /// Add a line and return its number.
    pub fn push(&mut self, text: impl Into<String>) -> u64 {
        if self.lines.len() == TRANSCRIPT_LINES {
            self.lines.pop_front();
        }
        let number = self.next;
        self.lines.push_back((number, text.into()));
        self.next += 1;
        number
    }

    /// The number the next line will have.
    pub fn next(&self) -> u64 {
        self.next
    }

    /// The last `count` lines from number `since` on, oldest first.
    pub fn read(&self, count: usize, since: u64) -> Vec<(u64, &str)> {
        let wanted: Vec<_> = self
            .lines
            .iter()
            .filter(|(number, _)| *number >= since)
            .map(|(number, text)| (*number, text.as_str()))
            .collect();
        wanted[wanted.len().saturating_sub(count)..].to_vec()
    }
}

/// A decision the program is waiting on.
#[derive(Debug, Clone, PartialEq)]
pub struct Pending {
    pub id: String,
    pub name: String,
    pub context: Value,
    pub deadline: Instant,
    answer: Option<(Value, String)>,
    /// The agent offered an answer the declaration does not allow.
    invalid: bool,
}

/// The agent end of every channel for one attached program.
pub struct Core {
    program: Arc<dyn Program>,
    pub content: Content,
    audit: AuditLog,
    options: Options,
    channel: Option<Box<dyn UserChannel>>,
    reader: Reader,
    pub transcript: Transcript,
    pending: Vec<Pending>,
    decisions_opened: u64,
    attached: bool,
    /// Whether the transcript has said that the audit log is failing.
    audit_failure_told: bool,
    /// When the step in progress must be over: the touchpoint's timeout.
    deadline: Option<Instant>,
    watches: Vec<Watch>,
    timers: Vec<Timer>,
    budget: Budget,
    /// Why the core detached, once it has.
    detach_reason: Option<String>,
    outside: Option<Outside>,
    launcher: Option<Box<dyn Launcher>>,
    /// The pause in effect, if the agent paused the program.
    paused: Option<Pause>,
    /// The agent's model went away: nothing runs the agent any more.
    agent_lost: bool,
    /// The core goes on when its program has gone.
    stays: bool,
    cancel: Cancel,
    /// The run's network, when it is on one.
    #[cfg(unix)]
    net: Option<crate::network::Network>,
    /// Why the run has no network, when one was declared or asked for.
    net_absent: Option<String>,
    /// The pid of the launched program this core is bound to.
    bound_pid: Option<u64>,
}

impl fmt::Debug for Core {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Core")
            .field("program", &self.program.manifest().name)
            .field("attached", &self.attached)
            .finish_non_exhaustive()
    }
}

impl Core {
    /// Attach to a program: one audit line for each counter the stub
    /// kept while nothing was attached, the ring read from here on, and
    /// the attached flag raised last.
    pub fn attach(
        program: Arc<dyn Program>,
        content: Content,
        audit: AuditLog,
        options: Options,
        channel: Option<Box<dyn UserChannel>>,
    ) -> Self {
        let reader = Reader::new(program.region());
        let limits = program
            .manifest()
            .attention
            .as_ref()
            .and_then(|attention| attention.budget.clone())
            .unwrap_or_default();
        let budget = Budget::new(limits.wakes_per_minute, limits.tokens_per_hour);
        let mut core = Self {
            program,
            content,
            audit,
            options,
            channel,
            reader,
            transcript: Transcript::default(),
            pending: Vec::new(),
            decisions_opened: 0,
            attached: true,
            audit_failure_told: false,
            deadline: None,
            watches: Vec::new(),
            timers: Vec::new(),
            budget,
            detach_reason: None,
            outside: None,
            launcher: None,
            paused: None,
            agent_lost: false,
            stays: false,
            cancel: Cancel::default(),
            #[cfg(unix)]
            net: None,
            net_absent: None,
            bound_pid: None,
        };
        core.flush_counters();
        core.region()[header::ATTACHED].store(1, Ordering::SeqCst);
        core.program.bound();
        core
    }

    /// Write an audit line. The first line that cannot be written is
    /// said in the transcript, where the agent reads it.
    fn record(&mut self, entry: Entry) -> bool {
        let written = self.audit.record(entry);
        if !written && !self.audit_failure_told {
            self.audit_failure_told = true;
            let why = self.audit.failed().unwrap_or("unknown").to_string();
            self.transcript.push(format!(
                "# audit: {} cannot be written ({why}); acts are not being recorded",
                self.audit.path().display()
            ));
        }
        written
    }

    fn flush_counters(&mut self) {
        let region = self.program.region().clone();
        let layout = &region.layout;
        let mut lines = Vec::new();
        for name in &layout.decisions {
            let word = layout.decision_counter(name).expect("a declared decision");
            lines.push(("decision", name.as_str(), word, "no_harness"));
        }
        for name in &layout.turns {
            let word = layout.turn_counter(name).expect("a declared turn");
            lines.push(("turn", name.as_str(), word, "no_harness"));
        }
        lines.push(("mode", "fallback", header::MODE_FALLBACK, "undeclared_mode"));
        for (act, name, word, cause) in lines {
            let count = region[word].swap(0, Ordering::Relaxed);
            if count == 0 {
                continue;
            }
            let written = self.record(
                Entry::new("counter", name)
                    .outcome("default")
                    .text("of", act)
                    .text("cause", cause)
                    .number("count", count),
            );
            if !written {
                // not on the record: the count stays for the next attach
                region[word].fetch_add(count, Ordering::Relaxed);
            }
        }
    }

    /// Detach: the flag goes down, so every later touchpoint returns at
    /// once, and what was open settles as detached.
    pub fn detach(&mut self, reason: &str) {
        if !self.attached {
            return;
        }
        // a pause ends with the agent that asked for it: the program is
        // not left held with nobody to resume it
        // with no program attached nobody can act on a message: the
        // mailboxes are left to the daemon, after what has already been
        // taken from them is shown and put on the record
        #[cfg(unix)]
        {
            if let Some(network) = &mut self.net {
                network.pause();
            }
            let mut last = Vec::new();
            self.poll_network(&mut last);
        }
        match self.paused.take() {
            Some(Pause::Os) => {
                if let Some(launcher) = &mut self.launcher {
                    let _ = launcher.signal(Signal::Continue);
                }
            }
            Some(_) => {
                self.region()[header::SAFEPOINT].fetch_and(!SAFEPOINT_PAUSED, Ordering::SeqCst);
                self.program.resumed();
            }
            None => {}
        }
        self.attached = false;
        self.detach_reason = Some(reason.to_string());
        self.region()[header::ATTACHED].store(0, Ordering::SeqCst);
        self.transcript.push(format!("# detached: {reason}"));
        // what the agent had answered does not apply: the program takes
        // its defaults
        let open: Vec<String> = self.pending.iter().map(|p| p.id.clone()).collect();
        for pending in &mut self.pending {
            pending.answer = None;
            pending.invalid = false;
        }
        for id in open {
            self.close_decision(&id, "detached");
        }
    }

    /// Say when the step in progress must be over, or that it has no
    /// limit. Nothing the agent does in the step waits past it.
    pub fn set_deadline(&mut self, deadline: Option<Instant>) {
        self.deadline = deadline;
    }

    /// The time left in the step, when it has a limit.
    pub fn time_left(&self) -> Option<Duration> {
        self.deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
    }

    /// A wait, cut to the time left in the step.
    fn within(&self, wait: Duration) -> Duration {
        self.time_left().map_or(wait, |left| wait.min(left))
    }

    pub fn is_attached(&self) -> bool {
        self.attached
    }

    /// Why the core detached, once it has.
    pub fn detach_reason(&self) -> Option<&str> {
        self.detach_reason.as_deref()
    }

    pub fn manifest(&self) -> &Manifest {
        self.program.manifest()
    }

    pub fn region(&self) -> &Arc<Region> {
        self.program.region()
    }

    pub fn mode(&self) -> Mode {
        self.program.mode()
    }

    pub fn options(&self) -> Options {
        self.options
    }

    /// The user channel, when there is one.
    pub fn channel(&mut self) -> Option<&mut (dyn UserChannel + 'static)> {
        self.channel.as_deref_mut()
    }

    /// Where observations from outside the region are put for this core.
    pub fn set_outside(&mut self, outside: Outside) {
        self.outside = Some(outside);
    }

    /// Make this the core of a harness that launched its program.
    pub fn set_launcher(&mut self, launcher: Box<dyn Launcher>) {
        self.bound_pid = launcher.state()["pid"].as_u64();
        self.launcher = Some(launcher);
    }

    /// The agent's model went away: detach. A harness that launched the
    /// program stays as its parent, with no agent.
    pub fn lose_agent(&mut self, reason: &str) {
        self.detach(reason);
        self.agent_lost = true;
    }

    /// Let the program go, once the outcome of what was in progress has
    /// been sent: it stops waiting for this harness and can take another.
    pub fn release(&mut self) {
        let reason = self.detach_reason.clone().unwrap_or_default();
        self.program.leave(&reason);
    }

    /// Whether the agent's model went away.
    pub fn agent_lost(&self) -> bool {
        self.agent_lost
    }

    /// Whether this harness launched its program.
    pub fn launched(&self) -> bool {
        self.launcher.is_some()
    }

    /// Whether the program this harness launched is running.
    pub fn program_running(&self) -> bool {
        self.launcher.as_ref().is_some_and(|l| l.running())
    }

    /// Whether an observation from outside has not been read yet.
    pub fn outside_pending(&self) -> bool {
        if self.network_pending() {
            return true;
        }
        self.outside.as_ref().is_some_and(|outside| {
            !outside
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .is_empty()
        })
    }

    /// What ends a model request in flight: the loop that runs this core
    /// sets it.
    pub fn set_cancel(&mut self, cancel: Cancel) {
        self.cancel = cancel;
    }

    pub fn cancel(&self) -> &Cancel {
        &self.cancel
    }

    /// Make this a core that goes on when its program has gone: its front
    /// end can attach it to the program again (the MCP server).
    pub fn set_stays(&mut self, stays: bool) {
        self.stays = stays;
    }

    /// Whether this core goes on when its program has gone.
    pub fn stays(&self) -> bool {
        self.stays
    }

    /// Whether the attached program is still there.
    pub fn program_alive(&self) -> bool {
        self.program.alive()
    }

    /// Attach to the program again, once it has come back: the same
    /// program, in a new process.
    pub fn attach_program(&mut self, program: Arc<dyn Program>) {
        self.rebind(program);
        self.transcript.push("# attached again");
    }

    /// Attach to the program a launcher has just started in place of the
    /// one that went. The transcript, the watches and the audit log go on.
    fn rebind(&mut self, program: Arc<dyn Program>) {
        self.reader = Reader::new(program.region());
        self.program = program;
        self.pending.clear();
        self.paused = None;
        self.attached = true;
        self.detach_reason = None;
        self.agent_lost = false;
        #[cfg(unix)]
        if let Some(network) = &mut self.net {
            network.resume();
        }
        self.flush_counters();
        self.region()[header::ATTACHED].store(1, Ordering::SeqCst);
        self.program.bound();
    }

    /// The harness is leaving: a program it launched and that still runs
    /// is stopped, gracefully when it declares how.
    pub fn end_launch(&mut self) {
        if self.program_running() {
            let (outcome, stopped) = match self.lifecycle_stop() {
                Ok(text) => ("ok", text),
                Err(error) => ("failed", error.message),
            };
            self.record(
                Entry::new("lifecycle", "stop")
                    .outcome(outcome)
                    .text("reason", "the harness is leaving")
                    .text("result", &stopped),
            );
        }
    }

    /// Read what is ready in the ring into the transcript, without
    /// waiting, and return the events read. What was observed from
    /// outside comes after it; the program's exit detaches.
    pub fn poll_events(&mut self) -> Vec<(String, Map<String, Value>)> {
        let mut events = self.poll_ring();
        let observed: Vec<_> = match &self.outside {
            Some(outside) => outside
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .drain(..)
                .collect(),
            None => Vec::new(),
        };
        for (name, payload) in observed {
            self.transcript
                .push(format!("event {name} {}", Value::Object(payload.clone())));
            // the exit of a program this core has already left for a
            // new one says nothing about the new one
            let ours = match (payload.get("pid").and_then(Value::as_u64), self.bound_pid) {
                (Some(exited), Some(bound)) => exited == bound,
                _ => true,
            };
            if name == EVENT_EXITED && ours {
                self.detach("the program exited");
            }
            events.push((name, payload));
        }
        #[cfg(unix)]
        self.poll_network(&mut events);
        events
    }

    /// Take up the run's network: its mailboxes are read from now on,
    /// and `wake` is called when a message has come.
    #[cfg(unix)]
    pub fn set_network(
        &mut self,
        connected: crate::network::Connected,
        wake: Arc<dyn Fn() + Send + Sync>,
    ) {
        self.net_absent = connected.absent.clone();
        let (network, lines) = crate::network::Network::start(connected, wake);
        for line in lines {
            self.transcript.push(line);
        }
        self.net = network;
    }

    /// What came over the network since the last look: each message is
    /// shown, remembered, and audited when it is one an agent said.
    #[cfg(unix)]
    fn poll_network(&mut self, events: &mut Vec<(String, Map<String, Value>)>) {
        let Some(network) = &mut self.net else {
            return;
        };
        let notes = network.take_notes();
        let received = network.take_received();
        for note in notes {
            self.transcript.push(note);
        }
        for message in received {
            self.transcript.push(message.line());
            if message.speaks() {
                self.record(Self::message_entry(&message, "ok"));
            }
            events.push((crate::network::EVENT_MESSAGE.to_string(), message.payload()));
        }
    }

    /// The audit line of a message (contract sections 7 and 10).
    #[cfg(unix)]
    fn message_entry(message: &crate::network::HarnessMessage, outcome: &str) -> Entry {
        let thread = message
            .thread
            .as_deref()
            .filter(|thread| Some(*thread) != message.id.as_deref());
        Entry::new("message", &message.peer)
            .outcome(outcome)
            .text("direction", message.direction)
            .text("addr", &message.addr)
            .text("network", &message.network)
            .maybe("id", message.id.as_deref())
            .maybe("thread", thread)
            .maybe("re", message.re.as_deref())
            .text("kind", &message.kind)
            .text("body", &message.body)
    }

    /// Whether a message from the network waits to be read.
    pub fn network_pending(&self) -> bool {
        #[cfg(unix)]
        {
            self.net.as_ref().is_some_and(|network| network.pending())
        }
        #[cfg(not(unix))]
        false
    }

    /// Who is on this run's network: every member of every network it is
    /// on, with whether each is enrolled and reachable now.
    pub fn peers(&mut self) -> Result<Value, ActError> {
        #[cfg(unix)]
        if let Some(network) = &self.net {
            // a roster read waits on the network's authority: no longer
            // than the step has left
            let limit = self.within(Duration::from_millis(crate::net::AIIP_MEMBERS_TIMEOUT_MS));
            let peers = network
                .run()
                .peers_within(limit.as_millis().max(250) as u64);
            return Ok(serde_json::to_value(peers).unwrap_or(Value::Null));
        }
        Err(self.no_network())
    }

    fn no_network(&self) -> ActError {
        let why = match &self.net_absent {
            Some(reason) => format!("this run has no network: {reason}"),
            None => "this run has no network: the program declares none and ABAI_NET_DIR is unset"
                .to_string(),
        };
        ActError::new(Code::Invalid, why)
    }

    /// What this run sent and received over its network since attach,
    /// oldest first; `limit` keeps the newest.
    pub fn messages(&self, network: Option<&str>, limit: Option<usize>) -> Result<Value, ActError> {
        #[cfg(unix)]
        if let Some(net) = &self.net {
            let list = net.messages(network, limit);
            return Ok(serde_json::to_value(list).unwrap_or(Value::Null));
        }
        let _ = (network, limit);
        Err(self.no_network())
    }

    /// Send a message to a member of this run's network, by the name its
    /// authority issued or by address, in an aiap envelope. The act is
    /// audited with the agent's reason; a refusal is audited too, and
    /// said in plain words.
    pub fn send(
        &mut self,
        to: &str,
        body: &str,
        reason: &str,
        thread: Option<&str>,
        re: Option<&str>,
        network: Option<&str>,
    ) -> Result<Value, ActError> {
        Self::require_reason(reason)?;
        if !self.attached {
            return Err(ActError::new(
                Code::Detached,
                "abai_send needs an attached program: the message is the program's agent's",
            ));
        }
        #[cfg(unix)]
        {
            use crate::net::{MessageInput, encode_message};
            use crate::network::{HarnessMessage, now_ms, pick_membership, send_failure};
            let Some(net) = &self.net else {
                return Err(self.no_network());
            };
            let invalid = |why: String| ActError::new(Code::Invalid, why);
            if to.trim().is_empty() || body.is_empty() {
                return Err(invalid(
                    "a message needs a member to send to and a body".to_string(),
                ));
            }
            let memberships = net.run().status().memberships;
            let membership = pick_membership(&memberships, network)
                .map_err(invalid)?
                .clone();
            let encoded = encode_message(MessageInput {
                body: body.to_string(),
                thread: thread.map(str::to_string),
                re: re.map(str::to_string),
                id: None,
                now_ms: None,
            })
            .map_err(invalid)?;
            let started = Instant::now();
            let mut entry = HarnessMessage {
                direction: "sent",
                network: membership.network.clone(),
                peer: to.to_string(),
                addr: String::new(),
                claimed: None,
                id: Some(encoded.id.clone()),
                thread: Some(thread.map_or_else(|| encoded.id.clone(), str::to_string)),
                re: re.map(str::to_string),
                kind: "msg".to_string(),
                ts: now_ms(),
                body: body.to_string(),
            };
            // the daemon dials the member for up to a minute: no longer
            // than the step has left
            let limit = self.within(Duration::from_millis(crate::net::AIIP_SEND_TIMEOUT_MS));
            let client = &net.run().daemon.client;
            let (stop, done) = (
                std::sync::atomic::AtomicBool::new(false),
                std::sync::atomic::AtomicBool::new(false),
            );
            let sent = std::thread::scope(|scope| {
                scope.spawn(|| {
                    let until = Instant::now() + limit;
                    while !done.load(Ordering::SeqCst) && Instant::now() < until {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    if !done.load(Ordering::SeqCst) {
                        stop.store(true, Ordering::SeqCst);
                    }
                });
                let sent = client.send(&membership.id, to, &encoded.bytes, Some(&stop));
                done.store(true, Ordering::SeqCst);
                sent
            });
            let out_of_time = stop.load(Ordering::SeqCst);
            let ms = started.elapsed().as_millis() as u64;
            match sent {
                Err(error) => {
                    let why = if out_of_time {
                        format!(
                            "the time for this step ran out before {to} answered; the message may or may not have arrived"
                        )
                    } else {
                        send_failure(&error, to, &membership.network)
                    };
                    self.transcript.push(format!(
                        "# network: a message to {to} on {} was not sent: {why}",
                        membership.network
                    ));
                    self.record(
                        Self::message_entry(&entry, "error")
                            .text("reason", reason)
                            .text("error", &why)
                            .number("ms", ms),
                    );
                    Err(ActError::new(Code::Error, why))
                }
                Ok(result) => {
                    entry.peer = result.to.name.clone().unwrap_or_else(|| to.to_string());
                    entry.addr = result.to.addr.clone();
                    self.transcript.push(format!(
                        "# network: sent {} to {} on {}",
                        encoded.id, entry.peer, membership.network
                    ));
                    self.record(
                        Self::message_entry(&entry, "ok")
                            .text("reason", reason)
                            .number("ms", ms),
                    );
                    let answer = json!({
                        "id": encoded.id,
                        "network": membership.network,
                        "to": {"name": entry.peer, "addr": entry.addr},
                        "thread": entry.thread,
                    });
                    if let Some(net) = &mut self.net {
                        net.remember(entry);
                    }
                    Ok(answer)
                }
            }
        }
        #[cfg(not(unix))]
        {
            let _ = (to, body, thread, re, network);
            Err(self.no_network())
        }
    }

    fn poll_ring(&mut self) -> Vec<(String, Map<String, Value>)> {
        if !self.attached {
            // the region is the one of a program that has gone
            return Vec::new();
        }
        let layout = self.region().layout.clone();
        let mut events = Vec::new();
        while let Some(item) = self.reader.next(Instant::now()) {
            match item {
                Item::Dropped(count) => {
                    self.transcript
                        .push(format!("event abai.events.dropped {{\"count\":{count}}}"));
                }
                Item::Event {
                    event,
                    payload,
                    truncated,
                    ..
                } => {
                    let name = layout.events[event].name.clone();
                    let cut = if truncated { " (cut)" } else { "" };
                    self.transcript.push(format!(
                        "event {name} {}{cut}",
                        Value::Object(payload.clone())
                    ));
                    events.push((name, payload));
                }
            }
        }
        events
    }

    /// Whether the program has claimed a place in the ring that has not
    /// been read yet.
    pub fn events_pending(&self) -> bool {
        self.reader.pending()
    }

    /// Read what the program has emitted into the transcript and return
    /// the events read. An event still being written is waited for, for
    /// a moment.
    pub fn drain(&mut self) -> Vec<(String, Map<String, Value>)> {
        let started = Instant::now();
        let upto = self.reader.head();
        let mut events = Vec::new();
        loop {
            events.extend(self.poll_events());
            // what was claimed before this call is waited for, for a
            // moment; what producers claim meanwhile is the next call's
            if self.reader.tail() >= upto || started.elapsed() > STALL * 2 {
                return events;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// The events among these that wake the agent, as lines for it
    /// (contract section 5.1: an event declared to wake, whose condition
    /// holds).
    pub fn waking(&self, events: &[(String, Map<String, Value>)]) -> Vec<String> {
        let manifest = self.manifest();
        events
            .iter()
            .filter(|(name, payload)| {
                // the program's exit and a touchpoint its pause holds
                // always wake (contract sections 5.6 and 4.3)
                name == EVENT_EXITED
                    || name == EVENT_PAUSE_BLOCKED
                    || Self::message_wakes(name, payload)
                    || manifest
                        .event(name)
                        .is_some_and(|event| event_wakes(event.wakes.as_deref(), payload))
            })
            .map(|(name, payload)| Self::wake_reason(name, payload))
            .collect()
    }

    /// A message one agent said to another wakes; the other kinds an
    /// envelope can have are shown and do not.
    fn message_wakes(name: &str, payload: &Map<String, Value>) -> bool {
        name == "abai.net.message"
            && matches!(
                payload.get("kind").and_then(Value::as_str),
                Some("msg" | "raw")
            )
    }

    fn wake_reason(name: &str, payload: &Map<String, Value>) -> String {
        #[cfg(unix)]
        if name == crate::network::EVENT_MESSAGE {
            return crate::network::line_of(payload);
        }
        format!("event {name} {}", Value::Object(payload.clone()))
    }

    /// Watch a cell (contract section 5.2). A watch on the same cell with
    /// the same comparison replaces the old one.
    pub fn add_watch(
        &mut self,
        cell: &str,
        op: WatchOp,
        value: Value,
        cadence_ms: Option<u64>,
    ) -> Result<Value, ActError> {
        if self.mode() == Mode::Turns {
            return Err(ActError::new(
                Code::Invalid,
                "there are no watches in turns mode: nothing runs between the program's touchpoints",
            ));
        }
        let Some(decl) = self.manifest().cell(cell).cloned() else {
            return Err(ActError::new(
                Code::Unknown,
                format!("{cell} is not a cell"),
            ));
        };
        if op != WatchOp::Changed && value.is_null() {
            return Err(ActError::new(
                Code::Invalid,
                format!("a {} watch needs a value to compare with", op.as_str()),
            ));
        }
        let cadence = cadence_ms
            .or(decl.cadence.map(u64::from))
            .unwrap_or(DEFAULT_WATCH_CADENCE_MS)
            .min(MAX_WATCH_CADENCE_MS);
        self.watches.retain(|w| !(w.cell == cell && w.op == op));
        if self.watches.len() >= MAX_WATCHES {
            return Err(ActError::new(
                Code::Invalid,
                format!("{MAX_WATCHES} watches are set already; remove one first"),
            ));
        }
        let watch = Watch::new(
            cell,
            op,
            value,
            Duration::from_millis(cadence),
            Instant::now(),
        );
        let cadence_ms = watch.cadence.as_millis() as u64;
        self.watches.push(watch);
        Ok(json!({"cell": cell, "op": op.as_str(), "cadence_ms": cadence_ms}))
    }

    /// Stop watching a cell. Returns how many watches were removed.
    pub fn remove_watch(&mut self, cell: &str) -> usize {
        let before = self.watches.len();
        self.watches.retain(|w| w.cell != cell);
        before - self.watches.len()
    }

    /// Set a timer: the agent is woken when it is due.
    pub fn add_timer(&mut self, seconds: f64, note: &str) -> Result<Value, ActError> {
        if self.mode() == Mode::Turns {
            return Err(ActError::new(
                Code::Invalid,
                "there are no timers in turns mode: nothing runs between the program's touchpoints",
            ));
        }
        if !(seconds > 0.0 && seconds <= MAX_TIMER_SECONDS) {
            return Err(ActError::new(
                Code::Invalid,
                format!("a timer is set for more than 0 and at most {MAX_TIMER_SECONDS} seconds"),
            ));
        }
        if self.timers.len() >= MAX_WATCHES {
            return Err(ActError::new(
                Code::Invalid,
                format!("{MAX_WATCHES} timers are set already"),
            ));
        }
        self.timers.push(Timer {
            due: Instant::now() + Duration::from_secs_f64(seconds),
            note: note.to_string(),
        });
        Ok(json!({"seconds": seconds, "note": note}))
    }

    /// Look at the watched cells that are due and the timers that are
    /// up. Returns a line for each that fires; each is in the transcript.
    pub fn due(&mut self, now: Instant) -> Vec<String> {
        let region = self.region().clone();
        let mut fired = Vec::new();
        for watch in &mut self.watches {
            if watch.due() > now {
                continue;
            }
            let Some((index, _)) = region.layout.cell(&watch.cell) else {
                continue;
            };
            match cells::read(&region, index) {
                Some(cell) => {
                    if let Some(line) = watch.look(&cell.value, cell.version, now) {
                        fired.push(line);
                    }
                }
                // a writer kept the cell busy: look again a cadence later
                None => watch.postpone(now),
            }
        }
        let (up, waiting): (Vec<Timer>, Vec<Timer>) = std::mem::take(&mut self.timers)
            .into_iter()
            .partition(|t| t.due <= now);
        self.timers = waiting;
        for timer in up {
            fired.push(if timer.note.is_empty() {
                "timer".to_string()
            } else {
                format!("timer: {}", timer.note)
            });
        }
        for line in &fired {
            self.transcript.push(line.clone());
        }
        fired
    }

    /// When a watch or a timer is next due, if there is one.
    pub fn next_due(&self) -> Option<Instant> {
        let watches = self.watches.iter().map(Watch::due);
        let timers = self.timers.iter().map(|t| t.due);
        watches.chain(timers).min()
    }

    /// The attention budget (contract section 5.6).
    pub fn budget(&mut self) -> &mut Budget {
        &mut self.budget
    }

    /// Count tokens the model used against the budget.
    pub fn spent(&mut self, tokens: u64) {
        self.budget.spent(tokens, Instant::now());
    }

    /// The cells' current values, all of them or the named ones.
    pub fn cells(&self, names: Option<&[String]>) -> Result<Value, ActError> {
        let region = self.region();
        let mut values = Map::new();
        for (index, slot) in region.layout.cells.iter().enumerate() {
            if names.is_some_and(|names| !names.contains(&slot.name)) {
                continue;
            }
            let value = cells::read(region, index).map_or(Value::Null, |cell| cell.value);
            values.insert(slot.name.clone(), value);
        }
        let unknown = names.and_then(|names| names.iter().find(|n| !values.contains_key(*n)));
        if let Some(unknown) = unknown {
            return Err(ActError::new(
                Code::Unknown,
                format!("{unknown} is not a cell"),
            ));
        }
        Ok(Value::Object(values))
    }

    fn require_reason(reason: &str) -> Result<(), ActError> {
        if reason.trim().is_empty() {
            return Err(ActError::new(
                Code::Invalid,
                "state your reason: every act of control is audited with one",
            ));
        }
        Ok(())
    }

    fn require_attached(&self) -> Result<(), ActError> {
        if self.attached {
            Ok(())
        } else {
            Err(ActError::new(Code::Detached, "no program is attached"))
        }
    }

    /// What stands for consent to an act of a policy. `question` is what
    /// the user is asked for a `confirm` act.
    fn consent(&mut self, policy: Policy, question: &str, limit: Option<Duration>) -> Consent {
        if policy != Policy::Confirm || self.options.auto {
            return Consent::Auto;
        }
        let timeout = self
            .manifest()
            .policy
            .as_ref()
            .and_then(|p| p.confirm_timeout.as_deref())
            .and_then(duration_ms)
            .map_or(DEFAULT_CONFIRM_TIMEOUT, Duration::from_millis);
        let timeout = self.within(limit.map_or(timeout, |limit| timeout.min(limit)));
        let approved = self
            .channel
            .as_mut()
            .is_some_and(|channel| channel.confirm(question, timeout));
        if approved {
            Consent::Approved
        } else {
            Consent::Denied
        }
    }

    /// The consent an audit line shows: only a `confirm` act has one.
    fn shown(policy: Policy, consent: Consent) -> Option<&'static str> {
        (policy == Policy::Confirm).then_some(consent.as_str())
    }

    /// Post a call and wait for its result, up to its timeout.
    fn round_trip(
        &mut self,
        target: Target,
        params: &[u8],
        timeout: Duration,
    ) -> Result<Vec<u8>, ActError> {
        let region = self.region().clone();
        let ticket = calls::post(&region, target, params).map_err(|error| match error {
            PostError::Busy => ActError::new(
                Code::Error,
                "too many calls are open; wait for one to finish",
            ),
            PostError::TooLarge(bytes) => ActError::new(
                Code::Invalid,
                format!(
                    "{bytes} bytes is more than a call carries ({})",
                    calls::CALL_BYTES
                ),
            ),
        })?;
        self.program.posted(target);
        let deadline = Instant::now() + self.within(timeout);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            self.program
                .drive(target, left, &|| calls::finished(&region, &ticket));
            if let Some(result) = calls::poll(&region, &ticket) {
                return result.map_err(|message| ActError::new(Code::Error, message));
            }
            if Instant::now() >= deadline {
                let what = match calls::abandon(&region, ticket) {
                    // it finished between the last look and now
                    Abandoned::Finished(result) => {
                        return result.map_err(|message| ActError::new(Code::Error, message));
                    }
                    Abandoned::Running => {
                        "the program's handler did not finish in time; it is still running, and what it does will not be reported"
                    }
                    Abandoned::Discarded => {
                        "the program reached no safepoint in time; the call was discarded"
                    }
                };
                return Err(ActError::new(Code::Timeout, what));
            }
        }
    }

    /// Write a knob.
    pub fn set(&mut self, name: &str, value: &Value, reason: &str) -> Result<Value, ActError> {
        self.require_attached()?;
        Self::require_reason(reason)?;
        let manifest = self.manifest().clone();
        let Some(index) = manifest.cells.iter().position(|c| c.name == name) else {
            return Err(ActError::new(
                Code::Unknown,
                format!("{name} is not a cell"),
            ));
        };
        let cell = &manifest.cells[index];
        if !cell.is_knob() {
            return Err(ActError::new(
                Code::Invalid,
                format!("{name} is not a knob: only the program writes it"),
            ));
        }
        if !matches_type(value, &cell.as_field()) {
            return Err(ActError::new(
                Code::Invalid,
                format!("the value is not of type {}", cell.ty.as_str()),
            ));
        }
        if let (Some([min, max]), Some(number)) = (&cell.range, value.as_f64()) {
            let (min, max) = (
                min.as_f64().unwrap_or(f64::MIN),
                max.as_f64().unwrap_or(f64::MAX),
            );
            if number < min || number > max {
                return Err(ActError::new(
                    Code::Invalid,
                    format!("{number} is outside the range {min} to {max}"),
                ));
            }
        }
        // everything that can make the write invalid is checked before
        // the user is asked
        let json = value.to_string();
        if cell.ty.is_sized() && !value.is_null() {
            let size = value.as_str().map_or(json.len(), str::len);
            if size > cell.slot_bytes() as usize {
                return Err(ActError::new(
                    Code::Invalid,
                    format!(
                        "{size} bytes is over the knob's max of {}",
                        cell.slot_bytes()
                    ),
                ));
            }
        }
        let policy = cell.policy.unwrap_or(Policy::Auto);
        let consent = self.consent(
            policy,
            &format!("Set {name} to {value}? Reason: {reason}"),
            None,
        );
        let entry = |outcome: &str| {
            Entry::new("knob", name)
                .outcome(outcome)
                .value("value", value)
                .text("reason", reason)
                .maybe("consent", Self::shown(policy, consent))
        };
        if consent == Consent::Denied {
            self.record(entry("denied"));
            return Err(ActError::new(Code::Denied, "the user did not consent"));
        }

        let region = self.region().clone();
        if !cell.ty.is_sized() {
            if !cells::write_scalar_knob(&region, index, value) {
                return Err(ActError::new(
                    Code::Invalid,
                    "the value does not fit the knob",
                ));
            }
            self.record(entry("ok"));
            return Ok(json!({"name": name, "value": value}));
        }

        // a sized knob is delivered to the program's handler at a safepoint
        let timeout = cell
            .timeout
            .as_deref()
            .or(Some(DEFAULT_KNOB_TIMEOUT))
            .and_then(duration_ms)
            .map_or(Duration::from_secs(30), Duration::from_millis);
        match self.round_trip(Target::Knob { index }, json.as_bytes(), timeout) {
            Ok(_) => {
                cells::write_mirror(&region, index, value);
                self.record(entry("ok"));
                Ok(json!({"name": name, "value": value}))
            }
            Err(error) => {
                let outcome = if error.code == Code::Timeout {
                    "timeout"
                } else {
                    "failed"
                };
                self.record(entry(outcome).text("error", &error.message));
                Err(error)
            }
        }
    }

    /// Call a capability.
    pub fn call(&mut self, name: &str, params: &Value, reason: &str) -> Result<Value, ActError> {
        self.require_attached()?;
        Self::require_reason(reason)?;
        let manifest = self.manifest().clone();
        let Some(index) = manifest.capabilities.iter().position(|c| c.name == name) else {
            return Err(ActError::new(
                Code::Unknown,
                format!("{name} is not a capability"),
            ));
        };
        let capability = &manifest.capabilities[index];
        let empty = json!({});
        let params = if params.is_null() { &empty } else { params };
        let entry = |outcome: &str| {
            Entry::new("call", name)
                .outcome(outcome)
                .value("params", params)
                .text("reason", reason)
        };
        if capability.policy == Policy::Forbid {
            self.record(entry("forbidden"));
            return Err(ActError::new(
                Code::Forbidden,
                "policy forbids this capability",
            ));
        }
        if self.options.deny_mutate && capability.effect == Effect::Mutate {
            self.record(entry("denied").text("error", "the harness denies mutating calls"));
            return Err(ActError::new(
                Code::Denied,
                "this harness was started to refuse capabilities that change the program",
            ));
        }
        if let Some(problem) = schema_problem(params, &capability.params) {
            return Err(ActError::new(Code::Invalid, format!("params: {problem}")));
        }
        let policy = capability.policy;
        let consent = self.consent(
            policy,
            &format!("Call {name} with {params}? Reason: {reason}"),
            None,
        );
        let shown = Self::shown(policy, consent);
        if consent == Consent::Denied {
            self.record(entry("denied").maybe("consent", shown));
            return Err(ActError::new(Code::Denied, "the user did not consent"));
        }

        let timeout = capability
            .timeout
            .as_deref()
            .or(Some(DEFAULT_CAPABILITY_TIMEOUT))
            .and_then(duration_ms)
            .map_or(Duration::from_secs(30), Duration::from_millis);
        let target = Target::Capability {
            index,
            immediate: capability.dispatch == Dispatch::Immediate,
        };
        let started = Instant::now();
        let result = self.round_trip(target, params.to_string().as_bytes(), timeout);
        let ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(bytes) => {
                self.record(entry("ok").maybe("consent", shown).number("ms", ms));
                Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
            }
            Err(error) => {
                let outcome = if error.code == Code::Timeout {
                    "timeout"
                } else {
                    "failed"
                };
                self.record(
                    entry(outcome)
                        .maybe("consent", shown)
                        .text("error", &error.message)
                        .number("ms", ms),
                );
                Err(error)
            }
        }
    }

    /// A lifecycle operation (contract section 5.5): `status`, `pause`,
    /// `resume`, `stop`, `start`, `restart`.
    pub fn lifecycle(&mut self, op: &str, reason: &str) -> Result<Value, ActError> {
        Self::require_reason(reason)?;
        if self.mode() != Mode::Sidecar {
            return Err(ActError::new(
                Code::Invalid,
                "there is no lifecycle channel in turns and thread modes: the agent lives inside the program",
            ));
        }
        if !["status", "pause", "resume", "stop", "start", "restart"].contains(&op) {
            return Err(ActError::new(
                Code::Invalid,
                format!("{op} is not a lifecycle operation"),
            ));
        }
        if op == "status" {
            return Ok(self.lifecycle_status());
        }
        if !self.launched() && op != "stop" {
            return Err(ActError::new(
                Code::Invalid,
                format!(
                    "only a harness that launched the program can {op} it; attached to a running program, status and a graceful stop are available"
                ),
            ));
        }
        let declared = self.manifest().lifecycle.clone();
        let policies = declared
            .as_ref()
            .and_then(|l| l.policy.clone())
            .unwrap_or_default();
        let policy = match op {
            "pause" => policies.pause.unwrap_or(Policy::Auto),
            "resume" => policies.resume.unwrap_or(Policy::Auto),
            "stop" => policies.stop.unwrap_or(Policy::Confirm),
            // a restart is a stop first: what forbids one forbids the other
            "restart" if policies.stop == Some(Policy::Forbid) => Policy::Forbid,
            "restart" => policies.restart.unwrap_or(Policy::Confirm),
            _ => Policy::Auto,
        };
        let entry = |outcome: &str| {
            Entry::new("lifecycle", op)
                .outcome(outcome)
                .text("reason", reason)
        };
        if policy == Policy::Forbid {
            self.record(entry("forbidden"));
            return Err(ActError::new(
                Code::Forbidden,
                format!("policy forbids lifecycle {op}"),
            ));
        }
        // what cannot be done is said before the user is asked about it
        let running = self.program_running();
        let pointless = match op {
            "pause" if !running => Some("the program is not running"),
            "pause" if self.paused.is_some() => Some("the program is paused already"),
            "resume" if self.paused.is_none() => Some("the program is not paused"),
            "stop" if self.launched() && !running => Some("the program is not running"),
            "start" if running => Some("the program is running; stop or restart it"),
            _ => None,
        };
        if let Some(why) = pointless {
            self.record(entry("failed").text("error", why));
            return Err(ActError::new(Code::Invalid, why));
        }
        let consent = self.consent(policy, &format!("{op} the program? Reason: {reason}"), None);
        let shown = Self::shown(policy, consent);
        if consent == Consent::Denied {
            self.record(entry("denied").maybe("consent", shown));
            return Err(ActError::new(Code::Denied, "the user did not consent"));
        }
        let pause = declared.as_ref().map_or(Pause::None, |l| l.pause);
        let done = match op {
            "pause" => self.lifecycle_pause(pause),
            "resume" => self.lifecycle_resume(),
            "stop" => self.lifecycle_stop(),
            "start" => self.lifecycle_start(),
            _ => {
                let stopped = if self.program_running() {
                    self.lifecycle_stop()
                } else {
                    Ok("the program was not running".to_string())
                };
                stopped.and_then(|stopped| {
                    self.lifecycle_start()
                        .map(|started| format!("{stopped}; {started}"))
                })
            }
        };
        match done {
            Ok(text) => {
                self.record(entry("ok").maybe("consent", shown));
                self.transcript.push(format!("# lifecycle {op}: {text}"));
                Ok(json!({"op": op, "result": text}))
            }
            Err(error) => {
                self.record(
                    entry("failed")
                        .maybe("consent", shown)
                        .text("error", &error.message),
                );
                Err(error)
            }
        }
    }

    fn lifecycle_status(&self) -> Value {
        let mut status = json!({
            "attached": self.attached,
            "paused": self.paused.map(|pause| match pause {
                Pause::Os => "os",
                _ => "cooperative",
            }),
        });
        match &self.launcher {
            Some(launcher) => status["launch"] = launcher.state(),
            None => {
                status["launch"] = Value::Null;
                status["note"] = json!(
                    "this harness attached to a running program: status and a graceful stop are available"
                );
            }
        }
        status
    }

    fn lifecycle_pause(&mut self, pause: Pause) -> Result<String, ActError> {
        let invalid = |message: &str| Err(ActError::new(Code::Invalid, message));
        if !self.program_running() {
            return invalid("the program is not running");
        }
        if self.paused.is_some() {
            return invalid("the program is paused already");
        }
        match pause {
            Pause::None => invalid("the program declares no pause"),
            Pause::Cooperative => {
                self.require_attached()?;
                self.region()[header::SAFEPOINT].fetch_or(SAFEPOINT_PAUSED, Ordering::SeqCst);
                self.paused = Some(pause);
                Ok("paused: the program stops at its next safepoint or touchpoint".to_string())
            }
            Pause::Os => {
                let sent = self
                    .launcher
                    .as_mut()
                    .map_or(Ok(()), |launcher| launcher.signal(Signal::Stop));
                sent.map_err(|error| ActError::new(Code::Error, error))?;
                self.paused = Some(pause);
                Ok("paused (the process is held)".to_string())
            }
        }
    }

    fn lifecycle_resume(&mut self) -> Result<String, ActError> {
        match self.paused {
            None => Err(ActError::new(Code::Invalid, "the program is not paused")),
            Some(Pause::Os) => {
                let sent = self
                    .launcher
                    .as_mut()
                    .map_or(Ok(()), |launcher| launcher.signal(Signal::Continue));
                // a signal that was not sent leaves the program paused
                sent.map_err(|error| ActError::new(Code::Error, error))?;
                self.paused = None;
                Ok("resumed (the process goes on)".to_string())
            }
            Some(_) => {
                self.paused = None;
                self.region()[header::SAFEPOINT].fetch_and(!SAFEPOINT_PAUSED, Ordering::SeqCst);
                self.program.resumed();
                Ok("resumed".to_string())
            }
        }
    }

    /// Graceful stop: the program's stop handler runs at its next
    /// safepoint and the program is expected to exit. A launcher then
    /// makes sure it has; an attached harness can only say what it saw.
    fn lifecycle_stop(&mut self) -> Result<String, ActError> {
        if self.launched() && !self.program_running() {
            return Err(ActError::new(Code::Invalid, "the program is not running"));
        }
        // a held process could never reach its safepoint, or exit
        if self.paused == Some(Pause::Os)
            && let Some(launcher) = &mut self.launcher
        {
            let _ = launcher.signal(Signal::Continue);
            self.paused = None;
        }
        let graceful = self
            .manifest()
            .lifecycle
            .as_ref()
            .and_then(|l| l.stop.as_ref())
            .map(|stop| {
                duration_ms(&stop.graceful).map_or(Duration::from_secs(10), Duration::from_millis)
            });
        let started = Instant::now();
        let mut said = "the program declares no graceful stop".to_string();
        if let (Some(graceful), true) = (graceful, self.attached) {
            let region = self.region().clone();
            said = match calls::post(&region, Target::Stop, b"") {
                Err(_) => "the stop could not be queued: too many calls are open".to_string(),
                Ok(ticket) => {
                    let deadline = started + graceful;
                    let mut ran = false;
                    // the program may exit inside its handler and never
                    // reply: its going is an end of the wait too
                    while self.program.alive() && !self.launcher_gone() {
                        let left = deadline.saturating_duration_since(Instant::now());
                        if left.is_zero() {
                            break;
                        }
                        self.program
                            .drive(Target::Stop, left, &|| calls::finished(&region, &ticket));
                        if calls::finished(&region, &ticket) {
                            ran = true;
                            break;
                        }
                    }
                    let _ = calls::abandon(&region, ticket);
                    if ran {
                        "the stop handler ran".to_string()
                    } else if !self.program.alive() || self.launcher_gone() {
                        "the program ended".to_string()
                    } else {
                        format!(
                            "the program reached no safepoint in {} ms",
                            graceful.as_millis()
                        )
                    }
                }
            };
        }
        // a cooperative pause held the program at a safepoint, where the
        // stop handler ran; now the pause is lifted, so the program can
        // leave that safepoint and end
        if self.paused.take().is_some() {
            self.region()[header::SAFEPOINT].fetch_and(!SAFEPOINT_PAUSED, Ordering::SeqCst);
            self.program.resumed();
        }
        let Some(launcher) = &mut self.launcher else {
            // attached: the program stops itself or it does not
            return if graceful.is_none() {
                Err(ActError::new(Code::Invalid, said))
            } else if said == "the stop handler ran" {
                Ok(format!("{said}; the program is expected to exit"))
            } else if said == "the program ended" {
                Ok(said)
            } else {
                Err(ActError::new(
                    Code::Timeout,
                    format!("the program did not stop: {said}"),
                ))
            };
        };
        let left = graceful.map_or(Duration::ZERO, |graceful| {
            (started + graceful).saturating_duration_since(Instant::now())
        });
        if launcher.wait_exit(left) {
            return Ok(format!("{said}; the program exited"));
        }
        // past the graceful time the launcher stops it
        for (signal, name) in [(Signal::Terminate, "terminated"), (Signal::Kill, "killed")] {
            let _ = launcher.signal(signal);
            if launcher.wait_exit(FORCE_GRACE) {
                return Ok(format!("{said}; the program was {name}"));
            }
        }
        Err(ActError::new(
            Code::Error,
            format!("{said}; the program could not be stopped"),
        ))
    }

    /// Whether a launcher's program has exited.
    fn launcher_gone(&self) -> bool {
        self.launcher.as_ref().is_some_and(|l| !l.running())
    }

    fn lifecycle_start(&mut self) -> Result<String, ActError> {
        let Some(mut launcher) = self.launcher.take() else {
            return Err(ActError::new(Code::Invalid, "no launcher"));
        };
        let started = if launcher.running() {
            Err(ActError::new(
                Code::Invalid,
                "the program is running; stop or restart it",
            ))
        } else {
            launcher
                .start()
                .map_err(|error| ActError::new(Code::Error, error))
        };
        let state = launcher.state();
        self.launcher = Some(launcher);
        // the program that was bound has exited, whether or not the word
        // of it has been read yet
        self.detach("the program exited");
        // from here on only the new program's exit counts
        self.bound_pid = state["pid"].as_u64();
        let program = started?;
        self.rebind(program);
        Ok(format!("started (pid {})", state["pid"]))
    }

    /// The program asks a decision. Returns the id the agent answers by,
    /// or the outcome at once when policy forbids asking.
    pub fn open_decision(
        &mut self,
        name: &str,
        context: Value,
        timeout: Duration,
    ) -> Result<String, Outcome> {
        let Some(decision) = self.manifest().decision(name).cloned() else {
            return Err(Outcome::Default);
        };
        if decision.policy == Policy::Forbid {
            self.record(
                Entry::new("decision", name)
                    .outcome("default")
                    .text("source", "default")
                    .text("cause", "forbidden")
                    .value("value", &decision.default),
            );
            return Err(Outcome::Default);
        }
        // a confirm with nobody to ask: the default applies at once, and
        // the agent is not woken for an answer that could not apply
        if decision.policy == Policy::Confirm && !self.options.auto && self.channel.is_none() {
            self.record(
                Entry::new("decision", name)
                    .outcome("default")
                    .text("source", "default")
                    .text("cause", "denied")
                    .value("value", &decision.default)
                    .text("consent", "denied"),
            );
            return Err(Outcome::Default);
        }
        self.decisions_opened += 1;
        let id = format!("d{}", self.decisions_opened);
        self.pending.push(Pending {
            id: id.clone(),
            name: name.to_string(),
            context,
            deadline: Instant::now() + timeout,
            answer: None,
            invalid: false,
        });
        Ok(id)
    }

    /// The decisions the program is waiting on.
    pub fn pending(&self) -> &[Pending] {
        &self.pending
    }

    /// The agent answers a decision. The answer applies when the step
    /// that received the decision ends.
    pub fn decide(&mut self, id: &str, answer: &Value, reason: &str) -> Result<(), ActError> {
        Self::require_reason(reason)?;
        let Some(at) = self.pending.iter().position(|p| p.id == id) else {
            return Err(ActError::new(
                Code::Unknown,
                format!("{id} is not a decision the program is waiting on"),
            ));
        };
        if Instant::now() + DECIDE_MARGIN >= self.pending[at].deadline {
            return Err(ActError::new(
                Code::Timeout,
                "the decision's time is up; the program has taken its default",
            ));
        }
        let decision = self
            .manifest()
            .decision(&self.pending[at].name)
            .cloned()
            .expect("a pending decision is declared");
        let problem = match (&decision.options, &decision.answer) {
            (Some(options), _) => match answer.as_str() {
                Some(option) if options.iter().any(|o| o == option) => None,
                _ => Some(format!("answer with one of: {}", options.join(", "))),
            },
            (None, Some(schema)) => schema_problem(answer, schema),
            (None, None) => None,
        };
        if let Some(problem) = problem {
            self.pending[at].invalid = true;
            return Err(ActError::new(Code::Invalid, problem));
        }
        self.pending[at].invalid = false;
        self.pending[at].answer = Some((answer.clone(), reason.to_string()));
        Ok(())
    }

    /// Settle a decision when the step that received it ends: the
    /// agent's answer, after the user's consent where policy asks for it,
    /// or the default with its cause. `unanswered` is the cause when the
    /// agent gave no answer and the time is not up.
    pub fn close_decision(&mut self, id: &str, unanswered: &str) -> Outcome {
        self.close_decision_if(id, unanswered, None, &|| true)
    }

    /// As `close_decision`, for a program thread that may have stopped
    /// waiting: `still_wanted` is asked once, just before an answer would
    /// be put on the record as applied. When it says no, the program has
    /// taken its default, and the record says so.
    pub fn close_decision_if(
        &mut self,
        id: &str,
        unanswered: &str,
        why: Option<&str>,
        still_wanted: &dyn Fn() -> bool,
    ) -> Outcome {
        let Some(at) = self.pending.iter().position(|p| p.id == id) else {
            return Outcome::Default;
        };
        let pending = self.pending.remove(at);
        let decision = self
            .manifest()
            .decision(&pending.name)
            .cloned()
            .expect("a pending decision is declared");
        let default = |cause: &str, reason: Option<&str>| {
            Entry::new("decision", &pending.name)
                .outcome("default")
                .text("source", "default")
                .text("cause", cause)
                .value("value", &decision.default)
                .maybe("reason", reason)
        };
        let late = Instant::now() >= pending.deadline;
        let Some((answer, reason)) = pending.answer else {
            // `why` belongs to the caller's cause only
            let (cause, why) = if late {
                ("timeout", None)
            } else if pending.invalid {
                ("invalid", None)
            } else {
                (unanswered, why)
            };
            self.record(default(cause, why));
            return Outcome::Default;
        };
        // an answer on file was given in time (`decide` takes none close
        // to the deadline), so it applies; a confirm has what is left of
        // the decision's time to be said yes to
        let asks = decision.policy == Policy::Confirm && !self.options.auto;
        let left = pending.deadline.saturating_duration_since(Instant::now());
        if asks && left.is_zero() {
            self.record(default("timeout", Some(&reason)));
            return Outcome::Default;
        }
        let question = format!("Answer {} with {answer}? Reason: {reason}", pending.name);
        let consent = self.consent(decision.policy, &question, Some(left));
        if consent == Consent::Denied {
            self.record(default("denied", Some(&reason)).text("consent", "denied"));
            return Outcome::Default;
        }
        if !still_wanted() {
            self.record(default("timeout", Some(&reason)));
            return Outcome::Default;
        }
        self.record(
            Entry::new("decision", &pending.name)
                .outcome("ok")
                .text("source", "agent")
                .value("value", &answer)
                .text("reason", &reason)
                .maybe("consent", Self::shown(decision.policy, consent)),
        );
        Outcome::Answer(answer)
    }

    /// Write the audit line of a turn or a touchpoint that ended.
    pub fn record_touch(&mut self, act: &str, name: &str, outcome: &str, cause: Option<&str>) {
        self.record(Entry::new(act, name).outcome(outcome).maybe("cause", cause));
    }

    /// The last lines of the audit log, oldest first.
    pub fn audit_tail(&self, limit: usize) -> Value {
        json!({
            "path": self.audit.path().display().to_string(),
            "failed": self.audit.failed(),
            "records": self.audit.tail(limit),
        })
    }

    /// What the harness is attached to, and what is open.
    pub fn status(&self) -> Value {
        let manifest = self.manifest();
        json!({
            "program": manifest.name,
            "mode": self.mode().as_str(),
            "attached": self.attached,
            "audit": {
                "path": self.audit.path().display().to_string(),
                "failed": self.audit.failed(),
            },
            "decisions": self.pending.iter().map(|p| json!({
                "id": p.id,
                "name": p.name,
                "context": p.context,
                "answered": p.answer.is_some(),
            })).collect::<Vec<_>>(),
            "transcript": self.transcript.next(),
            "watches": self.watches.iter().map(|w| json!({
                "cell": w.cell,
                "op": w.op.as_str(),
                "value": w.value,
            })).collect::<Vec<_>>(),
            "timers": self.timers.len(),
        })
    }
}
