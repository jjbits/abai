//! Declarations in code become the manifest (contract section 7).
//!
//! A program describes itself with [`Declarations`] and the five
//! declaration types here. [`Declarations::manifest`] fills the contract's
//! defaults, so the rendered `abaigram.yaml` is explicit, appends the
//! deviations this Rust instantiation declares, and validates. An invalid
//! declaration is an error at startup: declared, not discovered.

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;

use serde_json::{Number, Value};

use crate::manifest::{
    self, ABAIGRAMMAR_VERSION, Access, AttentionDecl, AuditDecl, BudgetDecl, CapabilityDecl,
    CellDecl, CheckDecl, ContentDecl, DEFAULT_CAPABILITY_TIMEOUT, DEFAULT_KNOB_TIMEOUT,
    DecisionDecl, Dispatch, Effect, EventDecl, Field, HarnessDecl, LifecycleDecl, LifecyclePolicy,
    Manifest, Mode, NetworkDecl, Pause, Policy, PolicyDecl, Schema, StopDecl, TurnDecl, ValueType,
};

/// Where this Rust instantiation departs from the contract, in every
/// manifest it renders.
pub const INSTANTIATION_DEVIATIONS: &[&str] = &[
    "No null harness: ABAI_HARNESS=null and ABAI_HARNESS=exercise are refused, and no checker judges a Rust abaigram yet, so no conformance level is reported (sections 11.6 and 12).",
];
/// Declared by a manifest that lists `thread`.
pub const THREAD_DEVIATION: &str = "In thread mode a panic on the harness thread is caught and the program runs on as itself; a program built with panic = \"abort\" has no such isolation and must not declare thread mode (section 6.2).";
/// Declared by a manifest that lists `sidecar`.
pub const SIDECAR_DEVIATION: &str = "Under launch the program is attached when it builds its declarations, the first thing in main(), not before main() (section 6.3).";

use crate::region::calls::{CallHandler, Handlers, KnobHandler, Params, StopHandler};

/// A handler the program registered, or none. It prints as whether there
/// is one, since a closure has nothing else to show.
#[derive(Clone)]
struct Registered<T>(Option<T>);

impl<T> fmt::Debug for Registered<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(if self.0.is_some() {
            "registered"
        } else {
            "none"
        })
    }
}

/// The name of the stop handler in the manifest.
pub const STOP_HANDLER: &str = "stop";

/// A lifecycle operation that has a policy (section 5.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleOp {
    Pause,
    Resume,
    Stop,
    Restart,
}

/// The declarations do not validate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclareError {
    /// The program's name.
    pub name: String,
    /// Each `<where>: <what>`.
    pub violations: Vec<String>,
}

impl fmt::Display for DeclareError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "the declarations of {} do not validate: {}",
            self.name,
            self.violations.join("; ")
        )
    }
}

impl std::error::Error for DeclareError {}

/// A cell (section 5.2). Start from a typed constructor; `knob` makes it
/// writable by the agent.
#[derive(Debug, Clone)]
pub struct Cell {
    pub(crate) decl: CellDecl,
    on_change: Registered<KnobHandler>,
}

impl Cell {
    fn of(name: &str, ty: ValueType, doc: &str) -> Self {
        Self {
            decl: CellDecl {
                name: name.to_string(),
                ty,
                access: Access::Read,
                doc: doc.to_string(),
                max: None,
                values: None,
                range: None,
                default: None,
                cadence: None,
                policy: None,
                timeout: None,
                fields: None,
                items: None,
                nullable: None,
            },
            on_change: Registered(None),
        }
    }

    /// The handler of a sized knob (`string`, `object`, `list`). The
    /// agent's write is delivered to it, as JSON, at the program's next
    /// safepoint, on the thread that reached it. An error refuses the
    /// value, and the agent hears the program's words.
    pub fn on_change<F>(mut self, handler: F) -> Self
    where
        F: Fn(Params<'_>) -> Result<(), String> + Send + Sync + 'static,
    {
        self.on_change = Registered(Some(Arc::new(handler)));
        self
    }

    pub fn bool(name: &str, doc: &str) -> Self {
        Self::of(name, ValueType::Bool, doc)
    }

    pub fn int(name: &str, doc: &str) -> Self {
        Self::of(name, ValueType::Int, doc)
    }

    pub fn float(name: &str, doc: &str) -> Self {
        Self::of(name, ValueType::Float, doc)
    }

    /// An `enum` cell with its values.
    pub fn enumeration<S: Into<String>>(
        name: &str,
        values: impl IntoIterator<Item = S>,
        doc: &str,
    ) -> Self {
        let mut cell = Self::of(name, ValueType::Enum, doc);
        cell.decl.values = Some(values.into_iter().map(Into::into).collect());
        cell
    }

    pub fn string(name: &str, doc: &str) -> Self {
        Self::of(name, ValueType::String, doc)
    }

    /// An `object` cell with its fields.
    pub fn object(name: &str, fields: Schema, doc: &str) -> Self {
        let mut cell = Self::of(name, ValueType::Object, doc);
        cell.decl.fields = Some(fields);
        cell
    }

    /// A `list` cell with its item schema.
    pub fn list(name: &str, items: Field, doc: &str) -> Self {
        let mut cell = Self::of(name, ValueType::List, doc);
        cell.decl.items = Some(Box::new(items));
        cell
    }

    /// Make the cell a knob: the agent may write it. `default` is its
    /// starting value.
    pub fn knob(mut self, default: impl Into<Value>) -> Self {
        self.decl.access = Access::Readwrite;
        self.decl.default = Some(default.into());
        self
    }

    /// Ask the user before the agent's write lands (knobs).
    pub fn confirm(mut self) -> Self {
        self.decl.policy = Some(Policy::Confirm);
        self
    }

    /// The largest encoded size in bytes (sized cells).
    pub fn max(mut self, bytes: u32) -> Self {
        self.decl.max = Some(bytes);
        self
    }

    /// The least and greatest value of an `int` cell.
    pub fn range_int(mut self, min: i64, max: i64) -> Self {
        self.decl.range = Some([Number::from(min), Number::from(max)]);
        self
    }

    /// The least and greatest value of a `float` cell. A bound that is not
    /// finite is reported when the manifest is built.
    pub fn range_float(mut self, min: f64, max: f64) -> Self {
        self.decl.range = Some(match (Number::from_f64(min), Number::from_f64(max)) {
            (Some(min), Some(max)) => [min, max],
            _ => [Number::from(1), Number::from(0)],
        });
        self
    }

    /// A hint, in milliseconds, of how often the value is worth reading.
    pub fn cadence(mut self, ms: u32) -> Self {
        self.decl.cadence = Some(ms);
        self
    }

    /// How long a write waits for a safepoint (sized knobs), such as `30s`.
    pub fn timeout(mut self, duration: &str) -> Self {
        self.decl.timeout = Some(duration.to_string());
        self
    }

    /// Let the value be null.
    pub fn nullable(mut self) -> Self {
        self.decl.nullable = Some(true);
        self
    }
}

/// An event (section 5.1).
#[derive(Debug, Clone)]
pub struct Event {
    pub(crate) decl: EventDecl,
}

impl Event {
    pub fn new(name: &str, doc: &str) -> Self {
        Self {
            decl: EventDecl {
                name: name.to_string(),
                doc: doc.to_string(),
                payload: Schema::new(),
                wakes: None,
                large: None,
            },
        }
    }

    /// The payload's fields.
    pub fn payload(mut self, payload: Schema) -> Self {
        self.decl.payload = payload;
        self
    }

    /// Wake the agent every time the event is emitted.
    pub fn wakes_always(mut self) -> Self {
        self.decl.wakes = Some("always".to_string());
        self
    }

    /// Wake the agent when a condition on the payload holds, such as
    /// `depth gt 100`.
    pub fn wakes_when(mut self, condition: &str) -> Self {
        self.decl.wakes = Some(condition.to_string());
        self
    }

    /// The payload does not fit an event slot; emitting it allocates.
    pub fn large(mut self) -> Self {
        self.decl.large = Some(true);
        self
    }
}

/// A capability (section 5.3).
#[derive(Debug, Clone)]
pub struct Capability {
    pub(crate) decl: CapabilityDecl,
    policy: Option<Policy>,
    handler: Registered<CallHandler>,
}

impl Capability {
    /// A capability that reads, dispatched at a safepoint.
    pub fn new(name: &str, doc: &str) -> Self {
        Self {
            decl: CapabilityDecl {
                name: name.to_string(),
                doc: doc.to_string(),
                params: Schema::new(),
                result: Schema::new(),
                effect: Effect::Read,
                dispatch: Dispatch::Safepoint,
                timeout: None,
                policy: Policy::Auto,
                example: None,
            },
            policy: None,
            handler: Registered(None),
        }
    }

    /// The handler: parameters in, a result or an error out. It runs
    /// where the capability's dispatch says, and what it returns is
    /// encoded straight into the reply.
    pub fn handler<T, F>(mut self, handler: F) -> Self
    where
        T: Serialize,
        F: Fn(Params<'_>) -> Result<T, String> + Send + Sync + 'static,
    {
        self.handler = Registered(Some(Arc::new(move |params, reply| match handler(params) {
            Ok(result) => reply.ok(&result),
            Err(error) => reply.error(&error),
        })));
        self
    }

    pub fn params(mut self, params: Schema) -> Self {
        self.decl.params = params;
        self
    }

    pub fn result(mut self, result: Schema) -> Self {
        self.decl.result = result;
        self
    }

    /// The capability changes the program. Its policy becomes `confirm`
    /// unless `policy` says otherwise.
    pub fn mutate(mut self) -> Self {
        self.decl.effect = Effect::Mutate;
        self
    }

    /// Run the handler as soon as the call arrives, not at a safepoint.
    pub fn immediate(mut self) -> Self {
        self.decl.dispatch = Dispatch::Immediate;
        self
    }

    /// How long a call waits, such as `5s`.
    pub fn timeout(mut self, duration: &str) -> Self {
        self.decl.timeout = Some(duration.to_string());
        self
    }

    pub fn policy(mut self, policy: Policy) -> Self {
        self.policy = Some(policy);
        self
    }

    /// Valid parameters, as an object.
    pub fn example(mut self, params: Value) -> Self {
        self.decl.example = Some(params);
        self
    }

    fn into_decl(self) -> CapabilityDecl {
        let mut decl = self.decl;
        decl.policy = self.policy.unwrap_or(match decl.effect {
            Effect::Read => Policy::Auto,
            Effect::Mutate => Policy::Confirm,
        });
        decl.timeout
            .get_or_insert_with(|| DEFAULT_CAPABILITY_TIMEOUT.to_string());
        decl
    }
}

/// A decision (section 5.4).
#[derive(Debug, Clone)]
pub struct Decision {
    pub(crate) decl: DecisionDecl,
}

impl Decision {
    fn of(name: &str, doc: &str, default: Value, timeout: &str) -> Self {
        Self {
            decl: DecisionDecl {
                name: name.to_string(),
                doc: doc.to_string(),
                context: Schema::new(),
                options: None,
                answer: None,
                default,
                timeout: timeout.to_string(),
                policy: Policy::Auto,
            },
        }
    }

    /// A decision among options. `default` is one of them, or `abort`.
    pub fn options<S: Into<String>>(
        name: &str,
        options: impl IntoIterator<Item = S>,
        default: &str,
        timeout: &str,
        doc: &str,
    ) -> Self {
        let mut decision = Self::of(name, doc, Value::String(default.to_string()), timeout);
        decision.decl.options = Some(options.into_iter().map(Into::into).collect());
        decision
    }

    /// A decision whose answer matches a schema.
    pub fn answer(name: &str, answer: Schema, default: Value, timeout: &str, doc: &str) -> Self {
        let mut decision = Self::of(name, doc, default, timeout);
        decision.decl.answer = Some(answer);
        decision
    }

    /// What the program tells the agent when it asks.
    pub fn context(mut self, context: Schema) -> Self {
        self.decl.context = context;
        self
    }

    pub fn policy(mut self, policy: Policy) -> Self {
        self.decl.policy = policy;
        self
    }
}

/// A turn (section 4.3).
#[derive(Debug, Clone)]
pub struct Turn {
    pub(crate) decl: TurnDecl,
}

impl Turn {
    pub fn new(name: &str, timeout: &str, doc: &str) -> Self {
        Self {
            decl: TurnDecl {
                name: name.to_string(),
                doc: doc.to_string(),
                timeout: timeout.to_string(),
            },
        }
    }
}

/// Everything a program declares about itself.
#[derive(Debug, Clone)]
pub struct Declarations {
    name: String,
    entry: Option<String>,
    modes: Vec<Mode>,
    harness: Option<HarnessDecl>,
    model: Option<serde_json::Map<String, Value>>,
    check: Option<CheckDecl>,
    content: ContentDecl,
    audit: Option<String>,
    lifecycle: Option<LifecycleDecl>,
    attention: Option<AttentionDecl>,
    policy: Option<PolicyDecl>,
    network: Option<NetworkDecl>,
    deviations: Vec<String>,
    cells: Vec<Cell>,
    events: Vec<Event>,
    capabilities: Vec<Capability>,
    decisions: Vec<Decision>,
    turns: Vec<Turn>,
    stop: Registered<StopHandler>,
    root: Option<PathBuf>,
}

impl Declarations {
    /// The declarations of a program. `modes` lists the modes it supports;
    /// the first is the default.
    pub fn new(name: &str, modes: impl IntoIterator<Item = Mode>) -> Self {
        Self {
            name: name.to_string(),
            entry: None,
            modes: modes.into_iter().collect(),
            harness: None,
            model: None,
            check: None,
            content: ContentDecl {
                identity: "abai/identity.md".to_string(),
                install: None,
                use_: None,
                turns: None,
            },
            audit: None,
            lifecycle: None,
            attention: None,
            policy: None,
            network: None,
            deviations: Vec::new(),
            cells: Vec::new(),
            events: Vec::new(),
            capabilities: Vec::new(),
            decisions: Vec::new(),
            turns: Vec::new(),
            stop: Registered(None),
            root: None,
        }
    }

    /// The stop handler: it runs at a safepoint on a graceful stop, and
    /// the program is expected to exit after it.
    pub fn on_stop<F: Fn() + Send + Sync + 'static>(mut self, handler: F) -> Self {
        self.stop = Registered(Some(Arc::new(handler)));
        self
    }

    /// The directory the content paths are relative to. Without it the
    /// root is the nearest directory, up from the working directory, whose
    /// `abaigram.yaml` names this program.
    pub fn root(mut self, dir: impl Into<PathBuf>) -> Self {
        self.root = Some(dir.into());
        self
    }

    /// The directory given with [`Declarations::root`].
    pub fn root_dir(&self) -> Option<&PathBuf> {
        self.root.as_ref()
    }

    /// The handlers the program registered, by the index of their
    /// declaration.
    pub fn handlers(&self) -> Handlers {
        Handlers {
            capabilities: self
                .capabilities
                .iter()
                .map(|c| c.handler.0.clone())
                .collect(),
            knobs: self.cells.iter().map(|c| c.on_change.0.clone()).collect(),
            stop: self.stop.0.clone(),
        }
    }

    /// What is declared and has no handler to serve it, each
    /// `<where>: <what>`.
    pub fn missing_handlers(&self) -> Vec<String> {
        let mut missing = Vec::new();
        for cell in &self.cells {
            let sized_knob = cell.decl.is_knob() && cell.decl.ty.is_sized();
            if sized_knob && cell.on_change.0.is_none() {
                missing.push(format!(
                    "cells.{}: a sized knob needs a handler (on_change)",
                    cell.decl.name
                ));
            }
            if !sized_knob && cell.on_change.0.is_some() {
                missing.push(format!(
                    "cells.{}: on_change is for sized knobs; this handler would never run",
                    cell.decl.name
                ));
            }
        }
        for capability in &self.capabilities {
            if capability.handler.0.is_none() {
                missing.push(format!(
                    "capabilities.{}: no handler is registered (handler)",
                    capability.decl.name
                ));
            }
        }
        let stops = self.lifecycle.as_ref().is_some_and(|l| l.stop.is_some());
        if stops && self.stop.0.is_none() {
            missing.push("lifecycle.stop: no stop handler is registered (on_stop)".to_string());
        }
        if !stops && self.stop.0.is_some() {
            missing.push(
                "lifecycle.stop: on_stop needs stop_graceful; this handler would never run"
                    .to_string(),
            );
        }
        missing
    }

    /// The standard entry as a command line run in the repository root,
    /// ending in `abai`. Default `<name> abai`.
    pub fn entry(mut self, command: &str) -> Self {
        self.entry = Some(command.to_string());
        self
    }

    /// Where the harness binary is.
    pub fn harness_path(mut self, path: &str) -> Self {
        self.harness = Some(HarnessDecl {
            path: Some(path.to_string()),
        });
        self
    }

    /// Constraints the model must meet, such as `tools: true`.
    pub fn model(mut self, constraints: serde_json::Map<String, Value>) -> Self {
        self.model = Some(constraints);
        self
    }

    /// The command that exercises the program's channels.
    pub fn check_run(mut self, command: &str) -> Self {
        let overhead = self.check.take().and_then(|c| c.overhead);
        self.check = Some(CheckDecl {
            run: command.to_string(),
            overhead,
        });
        self
    }

    /// The most slowdown `check` allows with the null harness attached, such as `5%`.
    pub fn check_overhead(mut self, percent: &str) -> Self {
        let run = self.check.take().map(|c| c.run).unwrap_or_default();
        self.check = Some(CheckDecl {
            run,
            overhead: Some(percent.to_string()),
        });
        self
    }

    /// The identity content's path. Default `abai/identity.md`.
    pub fn identity(mut self, path: &str) -> Self {
        self.content.identity = path.to_string();
        self
    }

    /// The install content's path.
    pub fn install_content(mut self, path: &str) -> Self {
        self.content.install = Some(path.to_string());
        self
    }

    /// The use content's path.
    pub fn use_content(mut self, path: &str) -> Self {
        self.content.use_ = Some(path.to_string());
        self
    }

    /// The directory with one file per named turn or decision.
    pub fn turns_content(mut self, dir: &str) -> Self {
        self.content.turns = Some(dir.to_string());
        self
    }

    /// The audit log's path. Default `~/.abai/audit/<name>.jsonl`.
    pub fn audit_path(mut self, path: &str) -> Self {
        self.audit = Some(path.to_string());
        self
    }

    fn lifecycle_mut(&mut self) -> &mut LifecycleDecl {
        self.lifecycle.get_or_insert(LifecycleDecl {
            pause: Pause::None,
            stop: None,
            policy: None,
        })
    }

    /// How the program can be paused.
    pub fn pause(mut self, pause: Pause) -> Self {
        self.lifecycle_mut().pause = pause;
        self
    }

    /// The program stops gracefully: its stop handler runs at a safepoint
    /// and has this long, such as `10s`.
    pub fn stop_graceful(mut self, duration: &str) -> Self {
        self.lifecycle_mut().stop = Some(StopDecl {
            graceful: duration.to_string(),
            handler: STOP_HANDLER.to_string(),
        });
        self
    }

    /// The policy of one lifecycle operation.
    pub fn lifecycle_policy(mut self, op: LifecycleOp, policy: Policy) -> Self {
        let policies = self
            .lifecycle_mut()
            .policy
            .get_or_insert_with(LifecyclePolicy::default);
        let slot = match op {
            LifecycleOp::Pause => &mut policies.pause,
            LifecycleOp::Resume => &mut policies.resume,
            LifecycleOp::Stop => &mut policies.stop,
            LifecycleOp::Restart => &mut policies.restart,
        };
        *slot = Some(policy);
        self
    }

    /// The attention budget: the most wakes a minute and model tokens an hour.
    pub fn budget(mut self, wakes_per_minute: Option<u32>, tokens_per_hour: Option<u64>) -> Self {
        self.attention = Some(AttentionDecl {
            budget: Some(BudgetDecl {
                wakes_per_minute,
                tokens_per_hour,
            }),
        });
        self
    }

    /// A confirm unanswered this long is denied, such as `60s`.
    pub fn confirm_timeout(mut self, duration: &str) -> Self {
        self.policy = Some(PolicyDecl {
            confirm_timeout: Some(duration.to_string()),
        });
        self
    }

    /// The agent may be a member of an agent network. `doc` says how its
    /// members relate to this program's own names; `required` means a run
    /// with no membership attaches no agent.
    pub fn network(mut self, doc: &str, required: bool) -> Self {
        self.network = Some(NetworkDecl {
            required: required.then_some(true),
            doc: doc.to_string(),
        });
        self
    }

    /// One of the program's own deviations from the contract.
    pub fn deviation(mut self, sentence: &str) -> Self {
        self.deviations.push(sentence.to_string());
        self
    }

    pub fn cell(mut self, cell: Cell) -> Self {
        self.cells.push(cell);
        self
    }

    pub fn event(mut self, event: Event) -> Self {
        self.events.push(event);
        self
    }

    pub fn capability(mut self, capability: Capability) -> Self {
        self.capabilities.push(capability);
        self
    }

    pub fn decision(mut self, decision: Decision) -> Self {
        self.decisions.push(decision);
        self
    }

    pub fn turn(mut self, turn: Turn) -> Self {
        self.turns.push(turn);
        self
    }

    /// The explicit, validated manifest of these declarations.
    pub fn manifest(&self) -> Result<Manifest, DeclareError> {
        let cells = self
            .cells
            .iter()
            .map(|cell| {
                let mut decl = cell.decl.clone();
                if decl.is_knob() {
                    decl.policy.get_or_insert(Policy::Auto);
                    if decl.ty.is_sized() {
                        decl.timeout
                            .get_or_insert_with(|| DEFAULT_KNOB_TIMEOUT.to_string());
                    }
                }
                decl
            })
            .collect();
        let events = self
            .events
            .iter()
            .map(|event| {
                let mut decl = event.decl.clone();
                decl.wakes.get_or_insert_with(|| "never".to_string());
                decl
            })
            .collect();

        let mut deviations = self.deviations.clone();
        deviations.extend(INSTANTIATION_DEVIATIONS.iter().map(|d| d.to_string()));
        if self.modes.contains(&Mode::Thread) {
            deviations.push(THREAD_DEVIATION.to_string());
        }
        if self.modes.contains(&Mode::Sidecar) {
            deviations.push(SIDECAR_DEVIATION.to_string());
        }

        let manifest = Manifest {
            abaigrammar: ABAIGRAMMAR_VERSION.to_string(),
            name: self.name.clone(),
            entry: self
                .entry
                .clone()
                .unwrap_or_else(|| format!("{} abai", self.name)),
            modes: self.modes.clone(),
            harness: self.harness.clone(),
            model: self.model.clone(),
            check: self.check.clone(),
            content: self.content.clone(),
            audit: AuditDecl {
                path: self
                    .audit
                    .clone()
                    .unwrap_or_else(|| format!("~/.abai/audit/{}.jsonl", self.name)),
            },
            lifecycle: self.lifecycle.clone(),
            attention: self.attention.clone(),
            policy: self.policy.clone(),
            network: self.network.clone(),
            deviations,
            cells,
            events,
            capabilities: self
                .capabilities
                .iter()
                .cloned()
                .map(Capability::into_decl)
                .collect(),
            decisions: self.decisions.iter().map(|d| d.decl.clone()).collect(),
            turns: self.turns.iter().map(|t| t.decl.clone()).collect(),
        };
        let violations = manifest::validate(&manifest);
        if violations.is_empty() {
            Ok(manifest)
        } else {
            Err(DeclareError {
                name: self.name.clone(),
                violations,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn jobs() -> Declarations {
        Declarations::new("jobs", [Mode::Sidecar, Mode::Turns])
            .entry("./bin/jobs abai")
            .check_run("make bench")
            .pause(Pause::Cooperative)
            .stop_graceful("10s")
            .cell(Cell::int("queue.depth", "Number of jobs waiting."))
            .cell(
                Cell::int("worker.count", "Active worker threads.")
                    .knob(4)
                    .range_int(1, 64)
                    .cadence(1000),
            )
            .cell(Cell::string("banner", "The line shown to operators.").knob("ready"))
            .event(
                Event::new("job.failed", "A job exhausted its retries.")
                    .payload(
                        Schema::new()
                            .field("job_id", Field::string().max(64))
                            .field("error", Field::string().max(512)),
                    )
                    .wakes_always(),
            )
            .event(Event::new("tick", "One pass of the loop."))
            .capability(
                Capability::new("job.retry", "Requeue a failed job once.")
                    .params(Schema::new().field("job_id", Field::string()))
                    .result(Schema::new().field("ok", Field::bool()))
                    .mutate()
                    .timeout("5s")
                    .example(json!({"job_id": "job-0001"})),
            )
            .capability(Capability::new("queue.peek", "The next job's id."))
            .decision(
                Decision::options(
                    "on_backlog",
                    ["scale_up", "shed_oldest", "wait"],
                    "wait",
                    "5s",
                    "Asked when the queue depth crosses the high-water mark.",
                )
                .context(
                    Schema::new()
                        .field("depth", Field::int())
                        .field("workers", Field::int()),
                ),
            )
            .turn(Turn::new(
                "end_of_batch",
                "30s",
                "After each batch completes.",
            ))
    }

    #[test]
    fn declarations_become_a_valid_manifest() {
        let manifest = jobs().manifest().unwrap();
        assert_eq!(manifest.abaigrammar, "0.1");
        assert_eq!(manifest.entry, "./bin/jobs abai");
        assert_eq!(manifest.audit.path, "~/.abai/audit/jobs.jsonl");
        assert_eq!(manifest.content.identity, "abai/identity.md");
        assert_eq!(manifest.cells.len(), 3);
        assert_eq!(
            manifest.lifecycle.as_ref().unwrap().pause,
            Pause::Cooperative
        );
        assert_eq!(
            manifest.lifecycle.unwrap().stop.unwrap(),
            StopDecl {
                graceful: "10s".to_string(),
                handler: "stop".to_string()
            }
        );
    }

    #[test]
    fn the_defaults_are_written_out() {
        let manifest = jobs().manifest().unwrap();
        let depth = manifest.cell("queue.depth").unwrap();
        assert_eq!((depth.policy, depth.timeout.as_deref()), (None, None));
        let count = manifest.cell("worker.count").unwrap();
        assert_eq!(
            (count.policy, count.timeout.as_deref()),
            (Some(Policy::Auto), None)
        );
        let banner = manifest.cell("banner").unwrap();
        assert_eq!(banner.timeout.as_deref(), Some("30s"));

        assert_eq!(
            manifest.event("job.failed").unwrap().wakes.as_deref(),
            Some("always")
        );
        assert_eq!(
            manifest.event("tick").unwrap().wakes.as_deref(),
            Some("never")
        );

        let retry = manifest.capability("job.retry").unwrap();
        assert_eq!(retry.policy, Policy::Confirm);
        assert_eq!(retry.dispatch, Dispatch::Safepoint);
        assert_eq!(retry.timeout.as_deref(), Some("5s"));
        let peek = manifest.capability("queue.peek").unwrap();
        assert_eq!(peek.policy, Policy::Auto);
        assert_eq!(peek.timeout.as_deref(), Some("30s"));

        assert_eq!(
            manifest.decision("on_backlog").unwrap().policy,
            Policy::Auto
        );
    }

    #[test]
    fn a_stated_policy_wins_over_the_effect() {
        let manifest = Declarations::new("p", [Mode::Turns])
            .capability(Capability::new("a", "A.").policy(Policy::Auto).mutate())
            .capability(Capability::new("b", "B.").policy(Policy::Forbid))
            .manifest()
            .unwrap();
        assert_eq!(manifest.capability("a").unwrap().policy, Policy::Auto);
        assert_eq!(manifest.capability("b").unwrap().policy, Policy::Forbid);
    }

    #[test]
    fn the_deviations_follow_the_modes() {
        let own = "The program's own deviation (section 5).";
        let all = Declarations::new("p", [Mode::Turns, Mode::Thread, Mode::Sidecar])
            .deviation(own)
            .manifest()
            .unwrap()
            .deviations;
        assert_eq!(all[0], own);
        assert_eq!(all[1], INSTANTIATION_DEVIATIONS[0]);
        assert_eq!(all[2..], [THREAD_DEVIATION, SIDECAR_DEVIATION]);

        let turns = Declarations::new("p", [Mode::Turns]).manifest().unwrap();
        assert_eq!(turns.deviations, INSTANTIATION_DEVIATIONS);
        assert_eq!(turns.entry, "p abai");
    }

    #[test]
    fn an_invalid_declaration_is_an_error() {
        let error = Declarations::new("p", [Mode::Turns])
            .cell(Cell::int("Bad Name", "A cell."))
            .cell(
                Cell::int("level", "A knob with no room.")
                    .knob(9)
                    .range_int(1, 4),
            )
            .manifest()
            .unwrap_err();
        assert_eq!(error.name, "p");
        assert_eq!(error.violations.len(), 2);
        assert!(
            error
                .to_string()
                .starts_with("the declarations of p do not validate: ")
        );
    }

    #[test]
    fn a_non_finite_float_range_is_reported() {
        let error = Declarations::new("p", [Mode::Turns])
            .cell(Cell::float("ratio", "A ratio.").range_float(0.0, f64::INFINITY))
            .cell(Cell::float("level", "A level.").range_float(f64::NAN, 1.0))
            .manifest()
            .unwrap_err();
        assert_eq!(
            error.violations,
            [
                "cells.ratio: range must be [min, max]",
                "cells.level: range must be [min, max]",
            ]
        );
        let manifest = Declarations::new("p", [Mode::Turns])
            .cell(Cell::float("ratio", "A ratio.").range_float(0.0, 1.5))
            .manifest()
            .unwrap();
        let range = manifest.cell("ratio").unwrap().range.clone().unwrap();
        assert_eq!(
            (range[0].as_f64(), range[1].as_f64()),
            (Some(0.0), Some(1.5))
        );
    }

    #[test]
    fn check_overhead_keeps_the_run() {
        let manifest = Declarations::new("p", [Mode::Turns])
            .check_run("make bench")
            .check_overhead("5%")
            .manifest()
            .unwrap();
        assert_eq!(
            manifest.check,
            Some(CheckDecl {
                run: "make bench".to_string(),
                overhead: Some("5%".to_string()),
            })
        );
        let manifest = Declarations::new("p", [Mode::Turns])
            .check_overhead("5%")
            .check_run("make bench")
            .manifest()
            .unwrap();
        assert_eq!(manifest.check.unwrap().overhead.as_deref(), Some("5%"));

        let error = Declarations::new("p", [Mode::Turns])
            .check_overhead("5%")
            .manifest()
            .unwrap_err();
        assert_eq!(
            error.violations,
            ["check.run: is required when check is declared"]
        );
    }

    #[test]
    fn lifecycle_policies_are_kept() {
        let manifest = Declarations::new("p", [Mode::Sidecar])
            .lifecycle_policy(LifecycleOp::Stop, Policy::Forbid)
            .lifecycle_policy(LifecycleOp::Pause, Policy::Confirm)
            .manifest()
            .unwrap();
        let lifecycle = manifest.lifecycle.unwrap();
        assert_eq!(lifecycle.pause, Pause::None);
        let policy = lifecycle.policy.unwrap();
        assert_eq!(policy.stop, Some(Policy::Forbid));
        assert_eq!(policy.pause, Some(Policy::Confirm));
        assert_eq!(policy.resume, None);
    }
}
