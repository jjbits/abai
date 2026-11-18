//! The null harness (contract sections 6.4, 11.6 and 12): a harness with
//! no model. `ABAI_HARNESS=null` attaches it and it drives nothing;
//! `ABAI_HARNESS=exercise` attaches it and it writes every knob with its
//! default and calls every capability with its `example`. A check judges
//! an abaigram's conformance level from what it saw, which the exercise
//! form prints at exit as one JSON line on stderr.
//!
//! It lives in the stub, so a program that links no harness can be
//! checked. It has no thread: it works on the program's thread, inside
//! `attach()`, inside each touchpoint, at a safepoint while the exercise
//! has work waiting, and at exit. It stays in the program's process in
//! every mode. Events are read at those moments only, so events that
//! lap the ring in between are counted as dropped.

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Instant;

use serde_json::{Value, json};

use crate::audit::{self, AuditLog, Entry};
use crate::env::EnvFn;
use crate::link::{Harness, Outcome, StubCore, Touch};
use crate::manifest::{Dispatch, Policy};
use crate::region::calls::{self, PostError, Target, Ticket, Which};
use crate::region::cells;
use crate::region::ring::{Item, Reader};
use crate::region::{SAFEPOINT_QUEUED, header};

/// The two forms of the null harness.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Form {
    /// `ABAI_HARNESS=null`: attached, and drives nothing.
    Passive,
    /// `ABAI_HARNESS=exercise`: drives every knob and capability once.
    Exercise,
}

impl Form {
    /// The form as `ABAI_HARNESS` names it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Passive => "null",
            Self::Exercise => "exercise",
        }
    }
}

const KNOB_REASON: &str = "null harness: exercise writes the default";
const CALL_REASON: &str = "null harness: exercise calls the example";
const DECISION_REASON: &str = "null harness: the default";

/// One thing the exercise drives through a call slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Job {
    /// A sized knob, delivered to the program's handler.
    Knob(usize),
    Capability(usize),
}

#[derive(Debug)]
struct Open {
    job: Job,
    ticket: Ticket,
    started: Instant,
}

#[derive(Debug)]
struct State {
    reader: Reader,
    /// Opened at the first line: a run that does nothing writes nothing.
    audit: Option<AuditLog>,
    /// Each cell's version at the attach.
    baseline: Vec<u64>,
    events: u64,
    dropped: u64,
    decisions: u64,
    turns: u64,
    touchpoints: u64,
    reached_decisions: Vec<String>,
    reached_turns: Vec<String>,
    events_emitted: Vec<String>,
    knobs_written: Vec<String>,
    capabilities_called: Vec<String>,
    /// What the exercise tried and could not do, as `unexercised` rows.
    failed: Vec<Value>,
    queue: VecDeque<Job>,
    open: Vec<Open>,
}

/// The null harness of one program.
pub(crate) struct NullHarness {
    core: Arc<StubCore>,
    form: Form,
    /// The home directory, for an audit path under `~/`.
    home: Option<PathBuf>,
    state: Mutex<State>,
}

impl std::fmt::Debug for NullHarness {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NullHarness")
            .field("form", &self.form)
            .finish_non_exhaustive()
    }
}

fn unexercised(kind: &str, name: &str, why: &str) -> Value {
    json!({"kind": kind, "name": name, "why": why})
}

fn push_once(list: &mut Vec<String>, name: &str) {
    if !list.iter().any(|have| have == name) {
        list.push(name.to_string());
    }
}

impl NullHarness {
    /// Attach to the program: from here on the region says a harness is
    /// attached, so events are emitted and touchpoints are handed over.
    pub(crate) fn attach(core: Arc<StubCore>, form: Form, env: EnvFn) -> Arc<Self> {
        let home = env("HOME")
            .filter(|home| !home.is_empty())
            .map(PathBuf::from);
        let region = &core.region;
        let baseline = (0..core.manifest.cells.len())
            .map(|index| cells::read(region, index).map_or(0, |cell| cell.version))
            .collect();
        let harness = Arc::new(Self {
            form,
            home,
            state: Mutex::new(State {
                reader: Reader::new(region),
                audit: None,
                baseline,
                events: 0,
                dropped: 0,
                decisions: 0,
                turns: 0,
                touchpoints: 0,
                reached_decisions: Vec::new(),
                reached_turns: Vec::new(),
                events_emitted: Vec::new(),
                knobs_written: Vec::new(),
                capabilities_called: Vec::new(),
                failed: Vec::new(),
                queue: VecDeque::new(),
                open: Vec::new(),
            }),
            core,
        });
        harness.settle_counters(&mut harness.lock());
        harness.core.region[header::ATTACHED].store(1, Ordering::SeqCst);
        if form == Form::Exercise {
            // no handler runs here: the program is still being built.
            // The calls wait for its first `attach()`, touchpoint or
            // safepoint.
            harness.start_exercise();
        }
        harness
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn record(&self, state: &mut State, entry: Entry) {
        if state.audit.is_none() {
            let declared = &self.core.manifest.audit.path;
            // a path under a home directory nobody named has no place
            if self.home.is_none() && declared.starts_with("~/") {
                return;
            }
            // the root is looked for only now: a run that records
            // nothing reads no file for it
            let path = audit::resolve(declared, self.core.root(), self.home.as_deref());
            state.audit = Some(AuditLog::open(path));
        }
        if let Some(audit) = &mut state.audit {
            audit.record(entry);
        }
    }

    /// Put on the record what the stub counted because no harness served
    /// it: a mode the run fell back from, and a decision or a turn the
    /// program reached from inside a handler the exercise had called,
    /// when the harness is busy with the call. Those count as reached:
    /// the program asked, whatever answered.
    fn settle_counters(&self, state: &mut State) {
        let region = &self.core.region;
        let layout = &region.layout;
        let mut lines = Vec::new();
        for name in &layout.decisions {
            if let Some(word) = layout.decision_counter(name) {
                lines.push(("decision", name.as_str(), word, "no_harness"));
            }
        }
        for name in &layout.turns {
            if let Some(word) = layout.turn_counter(name) {
                lines.push(("turn", name.as_str(), word, "no_harness"));
            }
        }
        lines.push(("mode", "fallback", header::MODE_FALLBACK, "undeclared_mode"));
        for (act, name, word, cause) in lines {
            let count = region[word].swap(0, Ordering::Relaxed);
            if count == 0 {
                continue;
            }
            match act {
                "decision" => {
                    state.decisions += count;
                    push_once(&mut state.reached_decisions, name);
                }
                "turn" => {
                    state.turns += count;
                    push_once(&mut state.reached_turns, name);
                }
                _ => {}
            }
            self.record(
                state,
                Entry::new("counter", name)
                    .outcome("default")
                    .text("of", act)
                    .text("cause", cause)
                    .number("count", count),
            );
        }
    }

    /// Write the scalar knobs, and line up everything that goes through
    /// a call slot: immediate capabilities first, since they need no
    /// safepoint.
    fn start_exercise(&self) {
        let manifest = &self.core.manifest;
        let region = &self.core.region;
        let mut state = self.lock();
        let mut later = Vec::new();
        for (index, cell) in manifest.cells.iter().enumerate() {
            if !cell.is_knob() {
                continue;
            }
            let policy = cell.policy.unwrap_or(Policy::Auto);
            if policy == Policy::Forbid {
                state
                    .failed
                    .push(unexercised("knob", &cell.name, "policy forbids it"));
                continue;
            }
            if cell.ty.is_sized() {
                later.push(Job::Knob(index));
                continue;
            }
            let value = cell.default.clone().unwrap_or(Value::Null);
            if cells::write_scalar_knob(region, index, &value) {
                self.record(
                    &mut state,
                    Self::knob_entry(&cell.name, &value, policy, "ok"),
                );
                state.knobs_written.push(cell.name.clone());
            } else {
                state.failed.push(unexercised(
                    "knob",
                    &cell.name,
                    "the default does not fit the knob",
                ));
            }
        }
        for (index, capability) in manifest.capabilities.iter().enumerate() {
            if capability.policy == Policy::Forbid {
                state.failed.push(unexercised(
                    "capability",
                    &capability.name,
                    "policy forbids it",
                ));
            } else if capability.example.is_none() {
                state.failed.push(unexercised(
                    "capability",
                    &capability.name,
                    "no example declared",
                ));
            } else if capability.dispatch == Dispatch::Immediate {
                state.queue.push_back(Job::Capability(index));
            } else {
                later.push(Job::Capability(index));
            }
        }
        state.queue.extend(later);
        self.ask_for_a_safepoint(&state);
    }

    /// While work is lined up or open, the program's next `safepoint()`
    /// takes its slow path and moves the exercise on.
    fn ask_for_a_safepoint(&self, state: &State) {
        if !state.queue.is_empty() || !state.open.is_empty() {
            self.core.region[header::SAFEPOINT].fetch_or(SAFEPOINT_QUEUED, Ordering::SeqCst);
        }
    }

    fn knob_entry(name: &str, value: &Value, policy: Policy, outcome: &str) -> Entry {
        Entry::new("knob", name)
            .outcome(outcome)
            .value("value", value)
            .text("reason", KNOB_REASON)
            // the exercise stands in for the person's consent
            .maybe("consent", (policy == Policy::Confirm).then_some("auto"))
    }

    fn job_name(&self, job: Job) -> (&'static str, &str) {
        match job {
            Job::Knob(index) => ("knob", &self.core.manifest.cells[index].name),
            Job::Capability(index) => ("capability", &self.core.manifest.capabilities[index].name),
        }
    }

    /// The call a job posts: where it goes and what it carries.
    fn call_of(&self, job: Job) -> (Target, Value) {
        match job {
            Job::Knob(index) => (
                Target::Knob { index },
                self.core.manifest.cells[index]
                    .default
                    .clone()
                    .unwrap_or(Value::Null),
            ),
            Job::Capability(index) => {
                let capability = &self.core.manifest.capabilities[index];
                (
                    Target::Capability {
                        index,
                        immediate: capability.dispatch == Dispatch::Immediate,
                    },
                    capability.example.clone().unwrap_or_else(|| json!({})),
                )
            }
        }
    }

    /// Take the results of the calls that finished.
    fn collect(&self, state: &mut State) {
        let region = &self.core.region;
        let mut still = Vec::new();
        for open in std::mem::take(&mut state.open) {
            let Some(result) = calls::poll(region, &open.ticket) else {
                still.push(open);
                continue;
            };
            let (kind, name) = self.job_name(open.job);
            let name = name.to_string();
            let (_, carried) = self.call_of(open.job);
            let ms = open.started.elapsed().as_millis() as u64;
            match open.job {
                Job::Knob(index) => {
                    let policy = self.core.manifest.cells[index]
                        .policy
                        .unwrap_or(Policy::Auto);
                    match result {
                        Ok(_) => {
                            cells::write_mirror(region, index, &carried);
                            self.record(state, Self::knob_entry(&name, &carried, policy, "ok"));
                            state.knobs_written.push(name);
                        }
                        Err(error) => {
                            self.record(
                                state,
                                Self::knob_entry(&name, &carried, policy, "failed")
                                    .text("error", &error),
                            );
                            state.failed.push(unexercised(kind, &name, &error));
                        }
                    }
                }
                Job::Capability(index) => {
                    let policy = self.core.manifest.capabilities[index].policy;
                    let entry = |outcome: &str| {
                        Entry::new("call", &name)
                            .outcome(outcome)
                            .value("params", &carried)
                            .text("reason", CALL_REASON)
                            .maybe("consent", (policy == Policy::Confirm).then_some("auto"))
                    };
                    match result {
                        Ok(_) => {
                            self.record(state, entry("ok").number("ms", ms));
                            state.capabilities_called.push(name);
                        }
                        Err(error) => {
                            self.record(
                                state,
                                entry("failed").text("error", &error).number("ms", ms),
                            );
                            state.failed.push(unexercised(kind, &name, &error));
                        }
                    }
                }
            }
        }
        state.open = still;
    }

    /// Post the next call that is lined up, when none is open: one call
    /// at a time, as the real harness makes them, so two handlers never
    /// run at once on the exercise's account.
    fn post(&self, state: &mut State) {
        while let Some(&job) = state.queue.front() {
            if !state.open.is_empty() {
                break;
            }
            let (target, carried) = self.call_of(job);
            match calls::post(&self.core.region, target, carried.to_string().as_bytes()) {
                Ok(ticket) => {
                    state.queue.pop_front();
                    state.open.push(Open {
                        job,
                        ticket,
                        started: Instant::now(),
                    });
                }
                Err(PostError::Busy) => break,
                Err(PostError::TooLarge(bytes)) => {
                    state.queue.pop_front();
                    let (kind, name) = self.job_name(job);
                    state.failed.push(unexercised(
                        kind,
                        name,
                        &format!(
                            "{bytes} bytes is more than a call carries ({})",
                            calls::CALL_BYTES
                        ),
                    ));
                }
            }
        }
    }

    /// Read what the program emitted since the last look.
    fn drain_events(&self, state: &mut State) {
        let now = Instant::now();
        while let Some(item) = state.reader.next(now) {
            match item {
                Item::Event { event, .. } => {
                    state.events += 1;
                    if let Some(declared) = self.core.manifest.events.get(event) {
                        push_once(&mut state.events_emitted, &declared.name);
                    }
                }
                Item::Dropped(count) => state.dropped += count,
            }
        }
    }

    /// Move the exercise on: take finished results, post what is lined
    /// up, read the events. With `serve`, run the posted calls of that
    /// kind on this thread, which must be the program's when the kind
    /// includes safepoint calls. The state is never locked while a
    /// handler runs, so a handler may exit the process.
    pub(crate) fn pump(&self, serve: Option<Which>) {
        loop {
            let open = {
                let mut state = self.lock();
                self.collect(&mut state);
                // a call is posted only where it can also be served
                if serve.is_some() {
                    self.post(&mut state);
                }
                self.drain_events(&mut state);
                self.settle_counters(&mut state);
                state.open.len()
            };
            let Some(which) = serve else { break };
            if open == 0 || self.core.serve(which) == 0 {
                break;
            }
        }
        // what is still waiting is looked at again at the next safepoint
        self.ask_for_a_safepoint(&self.lock());
    }

    /// What the null harness saw, in the form a check reads.
    pub(crate) fn report(&self) -> Value {
        self.pump(None);
        let manifest = &self.core.manifest;
        let region = &self.core.region;
        let state = self.lock();
        let cells_written: Vec<&str> = manifest
            .cells
            .iter()
            .enumerate()
            // a knob is the harness's to write, so only the program's
            // own cells count
            .filter(|(index, cell)| {
                let version = cells::read(region, *index).map_or(0, |cell| cell.version);
                !cell.is_knob() && version > state.baseline[*index]
            })
            .map(|(_, cell)| cell.name.as_str())
            .collect();
        let mut rows = state.failed.clone();
        if self.form == Form::Exercise {
            for open in &state.open {
                let (kind, name) = self.job_name(open.job);
                rows.push(unexercised(kind, name, "still pending at exit"));
            }
            for &job in &state.queue {
                let (kind, name) = self.job_name(job);
                rows.push(unexercised(kind, name, "not attempted"));
            }
            for decision in &manifest.decisions {
                if !state.reached_decisions.contains(&decision.name) {
                    rows.push(unexercised("decision", &decision.name, "not reached"));
                }
            }
            for turn in &manifest.turns {
                if !state.reached_turns.contains(&turn.name) {
                    rows.push(unexercised("turn", &turn.name, "not reached"));
                }
            }
        }
        json!({
            "form": self.form.as_str(),
            "events": state.events,
            "dropped": state.dropped,
            "decisions": state.decisions,
            "turns": state.turns,
            "touchpoints": state.touchpoints,
            "cellsWritten": cells_written,
            "eventsEmitted": state.events_emitted,
            "knobsWritten": state.knobs_written,
            "capabilitiesCalled": state.capabilities_called,
            "unexercised": rows,
        })
    }
}

impl Harness for NullHarness {
    fn touch(&self, touch: Touch) -> Outcome {
        let outcome = {
            let mut state = self.lock();
            match &touch {
                Touch::Decide { name, .. } => {
                    let Some(decision) = self.core.manifest.decision(name) else {
                        return Outcome::Default;
                    };
                    if decision.policy == Policy::Forbid {
                        // nobody may be asked: not a decision reached
                        self.record(
                            &mut state,
                            Entry::new("decision", name)
                                .outcome("default")
                                .text("source", "default")
                                .text("cause", "forbidden")
                                .value("value", &decision.default),
                        );
                        return Outcome::Default;
                    }
                    state.decisions += 1;
                    push_once(&mut state.reached_decisions, name);
                    self.record(
                        &mut state,
                        Entry::new("decision", name)
                            .outcome("default")
                            .text("source", "default")
                            .text("cause", "answered")
                            .value("value", &decision.default)
                            .text("reason", DECISION_REASON),
                    );
                    Outcome::Default
                }
                Touch::Turn { name, .. } => {
                    state.turns += 1;
                    push_once(&mut state.reached_turns, name);
                    self.record(&mut state, Entry::new("turn", name).outcome("ok"));
                    Outcome::Done
                }
                Touch::Install | Touch::Session => {
                    state.touchpoints += 1;
                    self.record(
                        &mut state,
                        Entry::new("touchpoint", &touch.label()).outcome("ok"),
                    );
                    Outcome::Done
                }
            }
        };
        // a touchpoint is a safepoint: everything lined up runs now
        self.pump(Some(Which::All));
        outcome
    }
}

/// The null harness whose report this process prints at exit.
static AT_EXIT: OnceLock<Arc<NullHarness>> = OnceLock::new();

extern "C" fn print_report() {
    if let Some(harness) = AT_EXIT.get() {
        // one line in one write, after a line break of its own in case
        // the program's last words had none; a closed stderr is nobody
        // to tell
        let line = format!("\n{}\n", harness.report());
        let _ = std::io::stderr().write_all(line.as_bytes());
    }
}

/// Have the process print this null harness's report when it exits, by
/// returning from `main` or by `std::process::exit`. Only the first
/// harness of a process is registered.
pub(crate) fn report_at_exit(harness: &Arc<NullHarness>) {
    if AT_EXIT.set(harness.clone()).is_ok() {
        // SAFETY: `print_report` is an `extern "C"` function that takes
        // and returns nothing, which is what `atexit` calls.
        unsafe {
            libc::atexit(print_report);
        }
    }
}
