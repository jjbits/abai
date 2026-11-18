//! The program with its declarations registered.

use std::fmt;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::declare::{Declarations, DeclareError};
use crate::env::{self, EnvFn, HarnessSelection, ModeSelection};
use crate::link::{Embedded, Harness, InTouchpoint, Outcome, StubCore, Touch};
use crate::manifest::{Manifest, Mode, duration_ms};
use crate::region::calls::{self, Which};
use crate::region::cells::{
    Cell, EnumCell, EnumKnob, HandleError, JsonCell, Knob, Scalar, TextCell,
};
use crate::region::ring::Event;
use crate::region::{DEFAULT_RING_SLOTS, Region, SAFEPOINT_PAUSED, header};

struct Inner {
    core: Arc<StubCore>,
    mode: ModeSelection,
    harness: HarnessSelection,
    embedded: OnceLock<Box<dyn Embedded>>,
    attached: Mutex<Option<Arc<dyn Harness>>>,
    attach_error: Mutex<Option<String>>,
    /// Sidecar mode: the endpoint a harness process connects to.
    #[cfg(unix)]
    sidecar: Option<Arc<crate::sidecar::Endpoint>>,
    /// Sidecar mode: why there is no endpoint, when there is none.
    sidecar_error: Option<String>,
    /// The environment variables an attach reads, as they were at startup.
    kept_env: Vec<(&'static str, Option<String>)>,
}

/// The variables that say where the harness binary is.
const KEPT_ENV: [&str; 4] = ["ABAI_HARNESS_BIN", "ABAI_HOME", "HOME", "PATH"];

impl Drop for Inner {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(endpoint) = &self.sidecar {
            endpoint.close();
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Inner {
    /// Hand a touchpoint to the attached harness. None means there is no
    /// harness to hand it to, whatever the flag says: nobody has audited
    /// it, so the caller counts it.
    fn touch(&self, touch: Touch) -> Option<Outcome> {
        // a handler the agent called has reached a touchpoint of its own:
        // the agent is busy with the call, so this one goes unserved
        let _inside = InTouchpoint::enter()?;
        let harness = self.harness()?;
        // a touchpoint reached during a cooperative pause waits for the
        // resume, and its own clock starts only then
        #[cfg(unix)]
        if let Some(endpoint) = &self.sidecar
            && self.core.region[header::SAFEPOINT].load(Ordering::Relaxed) & SAFEPOINT_PAUSED != 0
        {
            endpoint.pause_point(Some(&touch.label()));
        }
        let outcome = harness.touch(touch);
        if matches!(outcome, Outcome::Detached | Outcome::Unserved) {
            // forget this harness, and only this one: another thread may
            // have attached a new one meanwhile
            let mut attached = lock(&self.attached);
            if attached
                .as_ref()
                .is_some_and(|now| Arc::ptr_eq(now, &harness))
            {
                *attached = None;
            }
        }
        // every touchpoint is a safepoint: what was queued for one is
        // served before the touchpoint returns
        if calls::take_queued(&self.core.region) {
            self.core.serve(Which::Safepoint);
        }
        if let Outcome::Refused(reason) = &outcome {
            *lock(&self.attach_error) = Some(reason.clone());
        }
        (outcome != Outcome::Unserved).then_some(outcome)
    }

    /// The harness touchpoints go to, if there is one.
    fn harness(&self) -> Option<Arc<dyn Harness>> {
        #[cfg(unix)]
        if let Some(endpoint) = &self.sidecar {
            // the endpoint knows whether a harness process is connected
            return Some(endpoint.clone());
        }
        lock(&self.attached).clone()
    }

    fn kept_env(&self, name: &str) -> Option<String> {
        self.kept_env
            .iter()
            .find(|(kept, _)| *kept == name)
            .and_then(|(_, value)| value.clone())
    }

    /// Sidecar mode: start a harness process, unless one is attached.
    fn attach_sidecar(&self) -> Result<(), String> {
        #[cfg(unix)]
        if let Some(endpoint) = &self.sidecar {
            return endpoint.attach(&|name| self.kept_env(name));
        }
        Err(self
            .sidecar_error
            .clone()
            .unwrap_or_else(|| "sidecar mode needs a Unix system in this build".to_string()))
    }

    fn attach(&self) -> bool {
        match &self.harness {
            HarnessSelection::Real => {}
            HarnessSelection::Off => {
                *lock(&self.attach_error) = Some("ABAI_HARNESS=off: nothing attaches".to_string());
                return false;
            }
            HarnessSelection::Unsupported(value) => {
                *lock(&self.attach_error) = Some(format!(
                    "ABAI_HARNESS={value} is not supported (unset or off)"
                ));
                return false;
            }
        }
        // one attach at a time
        let mut attached = lock(&self.attached);
        if self.core.mode == Mode::Sidecar {
            let result = self.attach_sidecar();
            let ok = result.is_ok();
            *lock(&self.attach_error) = result.err();
            return ok;
        }
        if attached.is_some() && self.core.region.attached() {
            return true;
        }
        *attached = None;
        let result = match self.embedded.get() {
            Some(embedded) => embedded.attach(self.core.clone()),
            None => Err("no harness is linked into this program".to_string()),
        };
        match result {
            Ok(harness) => {
                *attached = Some(harness);
                *lock(&self.attach_error) = None;
                true
            }
            Err(reason) => {
                *lock(&self.attach_error) = Some(reason);
                false
            }
        }
    }
}

/// A program with its declarations registered: an abaigram. Cloning it
/// gives another handle to the same program.
#[derive(Clone)]
pub struct Abaigram {
    inner: Arc<Inner>,
}

impl fmt::Debug for Abaigram {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Abaigram")
            .field("name", &self.inner.core.manifest.name)
            .field("mode", &self.inner.mode)
            .field("harness", &self.inner.harness)
            .finish_non_exhaustive()
    }
}

/// The answer to a decision.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer<'a> {
    /// The agent's answer.
    Agent(Value),
    /// The declared default: no harness, a timeout, a refusal, an
    /// invalid answer, or a policy that forbids asking.
    Default(&'a Value),
}

impl Answer<'_> {
    /// The answer: an option's name, or a value of the answer schema.
    pub fn value(&self) -> &Value {
        match self {
            Self::Agent(value) => value,
            Self::Default(value) => value,
        }
    }

    /// The answer as an option's name.
    pub fn as_str(&self) -> &str {
        self.value().as_str().unwrap_or("")
    }

    /// Whether the agent gave the answer.
    pub fn by_agent(&self) -> bool {
        matches!(self, Self::Agent(_))
    }

    /// Whether the default applied and is `abort`: the program should
    /// stop rather than go on without the agent.
    pub fn is_abort(&self) -> bool {
        matches!(self, Self::Default(value) if value.as_str() == Some("abort"))
    }
}

/// A decision the program can ask (contract section 5.4).
#[derive(Clone)]
pub struct DecisionPoint {
    inner: Arc<Inner>,
    name: String,
    counter: usize,
    default: Value,
    timeout: Duration,
}

impl fmt::Debug for DecisionPoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DecisionPoint")
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

impl DecisionPoint {
    /// Ask the agent which way to go, and block until there is an answer.
    /// With no harness attached this is one load and one increment, and
    /// the default comes back at once.
    pub fn ask<C: Serialize + ?Sized>(&self, context: &C) -> Answer<'_> {
        let region = &self.inner.core.region;
        if !region.attached() {
            region[self.counter].fetch_add(1, Ordering::Relaxed);
            return Answer::Default(&self.default);
        }
        let touch = Touch::Decide {
            name: self.name.clone(),
            context: serde_json::to_value(context).unwrap_or(Value::Null),
            timeout: self.timeout,
        };
        match self.inner.touch(touch) {
            Some(Outcome::Answer(value)) => Answer::Agent(value),
            Some(_) => Answer::Default(&self.default),
            None => {
                region[self.counter].fetch_add(1, Ordering::Relaxed);
                Answer::Default(&self.default)
            }
        }
    }
}

/// A turn the program can give the agent (contract section 4.3).
#[derive(Clone)]
pub struct TurnPoint {
    inner: Arc<Inner>,
    name: String,
    counter: usize,
    timeout: Duration,
}

impl fmt::Debug for TurnPoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TurnPoint")
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

impl TurnPoint {
    /// Give the agent a turn, and block until it hands control back or
    /// the turn's timeout passes. Returns whether the agent had the turn.
    /// With no harness attached this is one load and one increment.
    pub fn give(&self) -> bool {
        let region = &self.inner.core.region;
        if !region.attached() {
            region[self.counter].fetch_add(1, Ordering::Relaxed);
            return false;
        }
        let touch = Touch::Turn {
            name: self.name.clone(),
            timeout: self.timeout,
        };
        match self.inner.touch(touch) {
            Some(outcome) => outcome == Outcome::Done,
            None => {
                region[self.counter].fetch_add(1, Ordering::Relaxed);
                false
            }
        }
    }
}

impl Abaigram {
    /// Register the declarations. Reads `ABAI_MODE` and `ABAI_HARNESS` once.
    pub fn new(declarations: &Declarations) -> Result<Self, DeclareError> {
        Self::with_env(declarations, &env::process_env)
    }

    /// Register the declarations, reading the environment through `env`.
    pub fn with_env(declarations: &Declarations, env: EnvFn) -> Result<Self, DeclareError> {
        let manifest = declarations.manifest()?;
        let missing = declarations.missing_handlers();
        if !missing.is_empty() {
            return Err(DeclareError {
                name: manifest.name,
                violations: missing,
            });
        }
        let mut mode = env::select_mode(&manifest.modes, env);
        let harness = env::select_harness(env);
        // a harness that launched this process handed it a connection:
        // the run is sidecar, whatever else is selected
        #[cfg(unix)]
        let launched = if manifest.modes.contains(&Mode::Sidecar) {
            crate::sidecar::launch_stream(env)
        } else {
            None
        };
        #[cfg(unix)]
        if launched.is_some() {
            mode = ModeSelection {
                mode: Mode::Sidecar,
                fell_back: false,
            };
        }
        #[cfg(not(unix))]
        let _ = &mut mode;
        // sidecar mode: the region is a segment a harness process maps
        // too, and the stub listens for one from now on
        let mut sidecar_error = None;
        #[cfg(unix)]
        let mut setup = None;
        if mode.mode == Mode::Sidecar && harness == HarnessSelection::Real {
            #[cfg(unix)]
            match crate::sidecar::setup(&manifest, env) {
                Ok(made) => setup = Some(made),
                Err(reason) => sidecar_error = Some(reason),
            }
            #[cfg(not(unix))]
            {
                sidecar_error = Some("sidecar mode needs a Unix system in this build".to_string());
            }
        }
        #[cfg(unix)]
        let region = match &setup {
            Some(setup) => setup.region.clone(),
            None => Region::in_process(&manifest, DEFAULT_RING_SLOTS),
        };
        #[cfg(not(unix))]
        let region = Region::in_process(&manifest, DEFAULT_RING_SLOTS);
        if mode.fell_back {
            region[header::MODE_FALLBACK].fetch_add(1, Ordering::Relaxed);
        }
        let core = Arc::new(StubCore {
            handlers: declarations.handlers(),
            region,
            mode: mode.mode,
            declared_root: declarations.root_dir().cloned(),
            found_root: OnceLock::new(),
            manifest,
        });
        #[cfg(unix)]
        let sidecar = match setup.map(|setup| crate::sidecar::start(setup, core.clone(), launched))
        {
            Some(Ok(endpoint)) => Some(endpoint),
            Some(Err(reason)) => {
                sidecar_error = Some(reason);
                None
            }
            None => None,
        };
        Ok(Self {
            inner: Arc::new(Inner {
                core,
                mode,
                harness,
                embedded: OnceLock::new(),
                attached: Mutex::new(None),
                attach_error: Mutex::new(None),
                #[cfg(unix)]
                sidecar,
                sidecar_error,
                kept_env: KEPT_ENV.map(|name| (name, env(name))).to_vec(),
            }),
        })
    }

    /// Link a harness into the program, for turns and thread modes:
    /// `Abaigram::new(&declarations)?.with_harness(abai_harness::embedded())`.
    /// Only the first call counts.
    pub fn with_harness(self, embedded: Box<dyn Embedded>) -> Self {
        let _ = self.inner.embedded.set(embedded);
        self
    }

    /// The effective manifest.
    pub fn manifest(&self) -> &Manifest {
        &self.inner.core.manifest
    }

    /// The mode the run selected.
    pub fn mode(&self) -> ModeSelection {
        self.inner.mode
    }

    /// The harness the run selected.
    pub fn harness_selection(&self) -> &HarnessSelection {
        &self.inner.harness
    }

    /// The region: the memory this program shares with its harness.
    pub fn region(&self) -> &Arc<Region> {
        &self.inner.core.region
    }

    /// The program's side as a linked harness holds it.
    pub fn core(&self) -> &Arc<StubCore> {
        &self.inner.core
    }

    /// Where the content paths are relative to, when it is known.
    pub fn root(&self) -> Option<&Path> {
        self.inner.core.root()
    }

    /// Attach the harness now, so the agent is present from here on.
    /// Returns whether a harness is attached. The other places the stub
    /// attaches are the standard entry, `install` and `session`; a
    /// decision or a turn never attaches.
    pub fn attach(&self) -> bool {
        self.inner.attach()
    }

    /// Whether a harness is attached now.
    pub fn attached(&self) -> bool {
        #[cfg(unix)]
        if let Some(endpoint) = &self.inner.sidecar {
            return endpoint.attached();
        }
        self.inner.core.region.attached()
    }

    /// Why the last attach failed, if it did.
    pub fn attach_error(&self) -> Option<String> {
        lock(&self.inner.attach_error).clone()
    }

    /// Run the install touchpoint: the agent works through the `install`
    /// content. Returns when it finishes; false when no harness could be
    /// attached or it went away.
    pub fn install(&self) -> bool {
        self.inner.attach() && self.inner.touch(Touch::Install) == Some(Outcome::Done)
    }

    /// Open a session between the agent and the user. Returns when the
    /// user ends it; false when no harness could be attached or it went
    /// away.
    pub fn session(&self) -> bool {
        self.inner.attach() && self.inner.touch(Touch::Session) == Some(Outcome::Done)
    }

    /// A point where the program agrees the stub may run queued work on
    /// its behalf: a capability call or a sized knob's delivery, on this
    /// thread. One load when nothing is queued.
    pub fn safepoint(&self) {
        let region = &self.inner.core.region;
        let word = region[header::SAFEPOINT].load(Ordering::Relaxed);
        if word == 0 {
            return;
        }
        if calls::take_queued(region) {
            self.inner.core.serve(Which::Safepoint);
        }
        #[cfg(unix)]
        if word & SAFEPOINT_PAUSED != 0
            && let Some(endpoint) = &self.inner.sidecar
        {
            endpoint.pause_point(None);
        }
    }

    /// `run`: sidecar launch. The harness binary starts this program
    /// again, with `args`, as its supervised child.
    pub(crate) fn run_launch(&self, args: &[String]) -> Result<i32, String> {
        let core = &self.inner.core;
        if !core.manifest.modes.contains(&Mode::Sidecar) {
            return Err(
                "run is sidecar launch, and this program does not declare sidecar mode".to_string(),
            );
        }
        #[cfg(unix)]
        {
            let program = std::env::current_exe()
                .map_err(|error| format!("this program's own path is not known: {error}"))?;
            let mut all = vec![
                "run".to_string(),
                "--".to_string(),
                program.display().to_string(),
            ];
            all.extend_from_slice(args);
            crate::sidecar::run_binary(
                &core.manifest,
                core.root(),
                &|name| self.inner.kept_env(name),
                &all,
                None,
            )
        }
        #[cfg(not(unix))]
        {
            let _ = args;
            Err("sidecar mode needs a Unix system in this build".to_string())
        }
    }

    /// The handle of a declared decision.
    pub fn decision(&self, name: &str) -> Result<DecisionPoint, HandleError> {
        let core = &self.inner.core;
        let unknown = || HandleError::Unknown(name.to_string());
        let decl = core.manifest.decision(name).ok_or_else(unknown)?;
        let counter = core
            .region
            .layout
            .decision_counter(name)
            .ok_or_else(unknown)?;
        Ok(DecisionPoint {
            inner: self.inner.clone(),
            name: name.to_string(),
            counter,
            default: decl.default.clone(),
            timeout: Duration::from_millis(duration_ms(&decl.timeout).unwrap_or(0)),
        })
    }

    /// The handle of a declared turn.
    pub fn turn(&self, name: &str) -> Result<TurnPoint, HandleError> {
        let core = &self.inner.core;
        let unknown = || HandleError::Unknown(name.to_string());
        let decl = core.manifest.turn(name).ok_or_else(unknown)?;
        let counter = core.region.layout.turn_counter(name).ok_or_else(unknown)?;
        Ok(TurnPoint {
            inner: self.inner.clone(),
            name: name.to_string(),
            counter,
            timeout: Duration::from_millis(duration_ms(&decl.timeout).unwrap_or(0)),
        })
    }

    /// Hand a verb of the standard entry to the linked harness, if there
    /// is one and it knows the verb.
    pub(crate) fn embedded_entry(&self, verb: &str, args: &[String]) -> Option<i32> {
        let embedded = self.inner.embedded.get()?;
        embedded.entry(self.inner.core.clone(), verb, args)
    }

    /// The linked harness's checks of the model connection, if a harness
    /// is linked and has any.
    pub(crate) fn embedded_doctor(&self) -> Option<Vec<crate::doctor::DoctorCheck>> {
        let embedded = self.inner.embedded.get()?;
        embedded.doctor(self.inner.core.clone())
    }

    /// Sidecar mode: run the harness binary with a verb of the standard
    /// entry. None in the other modes.
    pub(crate) fn binary_entry(&self, verb: &str, args: &[String]) -> Option<Result<i32, String>> {
        if self.inner.core.mode != Mode::Sidecar {
            return None;
        }
        #[cfg(unix)]
        {
            let mut all = vec![verb.to_string()];
            let core = &self.inner.core;
            // `mcp` serves this process's program: the harness is told
            // where it listens, and while it serves, this thread is the
            // program thread that reaches safepoints
            let serving = verb == "mcp";
            if serving {
                let Some(endpoint) = &self.inner.sidecar else {
                    return Some(Err(self
                        .inner
                        .sidecar_error
                        .clone()
                        .unwrap_or_else(|| "this run has no sidecar endpoint".to_string())));
                };
                all.push("--socket".to_string());
                all.push(endpoint.socket().display().to_string());
            }
            // `config net` finds the program's network by its name
            if verb == "config" {
                all.push("--program".to_string());
                all.push(core.manifest.name.clone());
            }
            all.extend_from_slice(args);
            Some(crate::sidecar::run_binary(
                &core.manifest,
                core.root(),
                &|name| self.inner.kept_env(name),
                &all,
                serving.then_some(&|| self.safepoint()),
            ))
        }
        #[cfg(not(unix))]
        Some(Err(
            "sidecar mode needs a Unix system in this build".to_string()
        ))
    }

    /// Sidecar mode: the harness binary's checks of the model connection.
    /// None in the other modes.
    pub(crate) fn binary_doctor(&self) -> Option<Vec<crate::doctor::DoctorCheck>> {
        use crate::doctor::{CheckStatus, DoctorCheck};
        if self.inner.core.mode != Mode::Sidecar {
            return None;
        }
        let failed = |detail: String| {
            vec![DoctorCheck {
                name: "online".to_string(),
                status: CheckStatus::Fail,
                detail,
            }]
        };
        #[cfg(unix)]
        {
            let core = &self.inner.core;
            let found = crate::sidecar::find_harness(&core.manifest, core.root(), &|name| {
                self.inner.kept_env(name)
            });
            let bin = match found {
                Ok(bin) => bin,
                Err(reason) => return Some(failed(reason)),
            };
            let mut args = vec!["doctor", "--program", core.manifest.name.as_str()];
            match core
                .manifest
                .network
                .as_ref()
                .map(|n| n.required == Some(true))
            {
                Some(true) => args.push("--network-required"),
                Some(false) => args.push("--network-declared"),
                None => {}
            }
            args.push("--json");
            let ran = std::process::Command::new(&bin)
                .args(args)
                .stderr(std::process::Stdio::inherit())
                .output();
            Some(match ran {
                Ok(output) => serde_json::from_slice(&output.stdout).unwrap_or_else(|_| {
                    failed(format!("{} doctor --json gave no checks", bin.display()))
                }),
                Err(error) => failed(format!("{} could not be started: {error}", bin.display())),
            })
        }
        #[cfg(not(unix))]
        Some(failed(
            "sidecar mode needs a Unix system in this build".to_string(),
        ))
    }

    /// Sidecar mode: the socket a harness process connects to, when the
    /// endpoint was made.
    #[cfg(unix)]
    pub fn sidecar_socket(&self) -> Option<&Path> {
        self.inner
            .sidecar
            .as_ref()
            .map(|endpoint| endpoint.socket())
    }

    /// Sidecar mode: why there is no endpoint, when there is none.
    pub fn sidecar_error(&self) -> Option<&str> {
        self.inner.sidecar_error.as_deref()
    }

    /// The handle of a `bool`, `int` or `float` cell the program writes:
    /// `app.cell::<i64>("queue.depth")`.
    pub fn cell<T: Scalar>(&self, name: &str) -> Result<Cell<T>, HandleError> {
        Cell::new(self.region(), name)
    }

    /// The handle of a `bool`, `int` or `float` knob.
    pub fn knob<T: Scalar>(&self, name: &str) -> Result<Knob<T>, HandleError> {
        Knob::new(self.region(), name)
    }

    /// The handle of an `enum` cell the program writes.
    pub fn enum_cell(&self, name: &str) -> Result<EnumCell, HandleError> {
        EnumCell::new(self.region(), name)
    }

    /// The handle of an `enum` knob.
    pub fn enum_knob(&self, name: &str) -> Result<EnumKnob, HandleError> {
        EnumKnob::new(self.region(), name)
    }

    /// The handle of a `string` cell the program writes.
    pub fn text_cell(&self, name: &str) -> Result<TextCell, HandleError> {
        TextCell::new(self.region(), name)
    }

    /// The handle of an `object` or `list` cell the program writes.
    pub fn json_cell(&self, name: &str) -> Result<JsonCell, HandleError> {
        JsonCell::new(self.region(), name)
    }

    /// The handle of an event the program emits.
    pub fn event(&self, name: &str) -> Result<Event, HandleError> {
        Event::new(self.region(), name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Mode;

    #[test]
    fn registering_reads_the_environment() {
        let env = |name: &str| match name {
            "ABAI_MODE" => Some("turns".to_string()),
            "ABAI_HARNESS" => Some("off".to_string()),
            _ => None,
        };
        let app = Abaigram::with_env(&Declarations::new("p", [Mode::Sidecar, Mode::Turns]), &env)
            .unwrap();
        assert_eq!(app.manifest().name, "p");
        assert_eq!(
            app.mode(),
            ModeSelection {
                mode: Mode::Turns,
                fell_back: false
            }
        );
        assert_eq!(app.harness_selection(), &HarnessSelection::Off);

        assert_eq!(
            app.region()[header::MODE_FALLBACK].load(Ordering::Relaxed),
            0
        );

        let none = |_: &str| None;
        let bad = Declarations::new("p", []);
        assert!(Abaigram::with_env(&bad, &none).is_err());
    }

    #[test]
    fn handles_come_from_the_declarations() {
        use crate::declare::{Cell as CellDecl, Event as EventDecl};
        let declarations = Declarations::new("p", [Mode::Thread])
            .cell(CellDecl::int("count", "A count."))
            .cell(CellDecl::int("step", "The step.").knob(2))
            .event(EventDecl::new("tick", "A tick."));
        let undeclared = |name: &str| (name == "ABAI_MODE").then(|| "sidecar".to_string());
        let app = Abaigram::with_env(&declarations, &undeclared).unwrap();
        assert_eq!(app.mode().mode, Mode::Thread);
        assert_eq!(
            app.region()[header::MODE_FALLBACK].load(Ordering::Relaxed),
            1
        );

        app.cell::<i64>("count").unwrap().set(5);
        assert_eq!(app.knob::<i64>("step").unwrap().get(), 2);
        assert!(app.event("tick").is_ok());
        assert!(app.cell::<f64>("count").is_err());
        assert!(app.text_cell("count").is_err());
        assert!(app.event("tock").is_err());
    }
}
