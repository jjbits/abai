//! Where the two halves meet: what the stub gives an attached harness,
//! and what an attached harness is to the stub (contract sections 4.1 and
//! 4.3).
//!
//! Everything fast crosses through the region. This module is the rest:
//! the touchpoints, which block the calling program thread by design, and
//! the way a harness linked into the program is started.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::Value;

use crate::manifest::{Manifest, Mode};
use crate::region::Region;
use crate::region::calls::{self, Handlers, Which};

thread_local! {
    /// Whether this thread is inside a touchpoint, or inside a handler
    /// the agent called.
    static IN_TOUCHPOINT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Marks the thread as inside a touchpoint until it is dropped. A
/// touchpoint reached from inside one, or from inside a handler the
/// agent called, goes unserved: the agent is busy with what it is doing.
pub(crate) struct InTouchpoint;

impl InTouchpoint {
    /// None when the thread is already inside one.
    pub(crate) fn enter() -> Option<Self> {
        // `then`, not `then_some`: a guard made and dropped on the "already
        // inside" path would lower the flag the outer guard holds
        IN_TOUCHPOINT.with(|inside| (!inside.replace(true)).then(|| Self))
    }
}

impl Drop for InTouchpoint {
    fn drop(&mut self) {
        IN_TOUCHPOINT.with(|inside| inside.set(false));
    }
}

/// The program's side, as a harness in the same process holds it.
#[derive(Debug)]
pub struct StubCore {
    pub manifest: Manifest,
    pub region: Arc<Region>,
    pub handlers: Handlers,
    /// The mode this run selected.
    pub mode: Mode,
    /// The root the program gave its declarations, if it gave one.
    pub declared_root: Option<PathBuf>,
    /// The root, looked for once, the first time it is asked for.
    pub(crate) found_root: OnceLock<Option<PathBuf>>,
}

impl StubCore {
    /// Where the content paths are relative to: the root the program
    /// gave, else the nearest directory, up from the working directory
    /// and then from the executable, whose `abaigram.yaml` names this
    /// program. Nothing is read until this is first called, so a plain
    /// run pays nothing for it.
    pub fn root(&self) -> Option<&Path> {
        if let Some(root) = &self.declared_root {
            return Some(root);
        }
        self.found_root
            .get_or_init(|| {
                let name = &self.manifest.name;
                let from_cwd = std::env::current_dir()
                    .ok()
                    .and_then(|cwd| crate::doctor::find_root(name, &cwd));
                from_cwd.or_else(|| {
                    let exe = std::env::current_exe().ok()?;
                    crate::doctor::find_root(name, exe.parent()?)
                })
            })
            .as_deref()
    }

    /// Run the pending calls of one kind on the calling thread.
    pub fn serve(&self, which: Which) -> usize {
        // a handler that reaches a touchpoint finds the agent busy
        let _inside = InTouchpoint::enter();
        calls::serve(&self.region, &self.handlers, which)
    }
}

/// A touchpoint the program has reached.
#[derive(Debug, Clone, PartialEq)]
pub enum Touch {
    Decide {
        name: String,
        context: Value,
        timeout: Duration,
    },
    Turn {
        name: String,
        timeout: Duration,
    },
    Install,
    Session,
}

impl Touch {
    /// The touchpoint in a few words: `decide on_limit`, `session`.
    pub fn label(&self) -> String {
        match self {
            Self::Decide { name, .. } => format!("decide {name}"),
            Self::Turn { name, .. } => format!("turn {name}"),
            Self::Install => "install".to_string(),
            Self::Session => "session".to_string(),
        }
    }
}

/// How a touchpoint ended. The harness has written the audit line.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// A decision the agent answered.
    Answer(Value),
    /// A decision whose default applies.
    Default,
    /// A turn, an install or a session that ran to its end.
    Done,
    /// The harness went while it served this; the stub forgets it.
    Detached,
    /// The harness is attached and could not serve this touchpoint, for
    /// the reason given: a session with nobody to talk to. It has
    /// written the audit line.
    Refused(String),
    /// The harness was already gone and did nothing with this: no audit
    /// line was written, so the stub counts it, and forgets the harness.
    Unserved,
}

/// An attached harness, as the stub sees it.
pub trait Harness: Send + Sync {
    /// Serve a touchpoint. Blocks the calling thread until it ends.
    fn touch(&self, touch: Touch) -> Outcome;
}

/// A harness linked into the program: how the stub starts it in turns and
/// thread modes, and hands it the entry's verbs.
pub trait Embedded: Send + Sync {
    /// Attach to the program. The harness raises the region's attached
    /// flag before this returns, and lowers it when it goes.
    fn attach(&self, core: Arc<StubCore>) -> Result<Arc<dyn Harness>, String>;

    /// Serve a verb of the standard entry the stub does not serve itself
    /// (`config`, `mcp`, the online half of `doctor`). None means the
    /// harness does not know the verb.
    fn entry(&self, core: Arc<StubCore>, verb: &str, args: &[String]) -> Option<i32>;

    /// The online half of `doctor`: checks of the model connection. None
    /// means the harness has none to give.
    fn doctor(&self, core: Arc<StubCore>) -> Option<Vec<crate::doctor::DoctorCheck>> {
        let _ = core;
        None
    }
}
