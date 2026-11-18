//! The environment variables the stub reads (contract section 4.4).

use crate::manifest::Mode;

/// Selects the mode of a run.
pub const ENV_MODE: &str = "ABAI_MODE";
/// Selects the harness of a run.
pub const ENV_HARNESS: &str = "ABAI_HARNESS";

/// Reads one environment variable.
pub type EnvFn<'a> = &'a dyn Fn(&str) -> Option<String>;

/// The process environment.
pub fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// The mode a run selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModeSelection {
    /// The mode the run uses.
    pub mode: Mode,
    /// `ABAI_MODE` named a mode the manifest does not declare, so the run
    /// fell back to the first declared mode.
    pub fell_back: bool,
}

/// The mode `ABAI_MODE` selects among the declared modes.
pub fn select_mode(modes: &[Mode], env: EnvFn) -> ModeSelection {
    let Some(&first) = modes.first() else {
        return ModeSelection {
            mode: Mode::Turns,
            fell_back: false,
        };
    };
    let value = env(ENV_MODE).map(|v| v.trim().to_string());
    match value.as_deref() {
        None | Some("") => ModeSelection {
            mode: first,
            fell_back: false,
        },
        Some(name) => match Mode::parse(name) {
            Some(mode) if modes.contains(&mode) => ModeSelection {
                mode,
                fell_back: false,
            },
            _ => ModeSelection {
                mode: first,
                fell_back: true,
            },
        },
    }
}

/// The harness `ABAI_HARNESS` selects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HarnessSelection {
    /// Unset or empty: the real harness.
    Real,
    /// `off`: no agent.
    Off,
    /// Any other value, which this build does not support.
    Unsupported(String),
}

/// The harness `ABAI_HARNESS` selects.
pub fn select_harness(env: EnvFn) -> HarnessSelection {
    let value = env(ENV_HARNESS).map(|v| v.trim().to_string());
    match value.as_deref() {
        None | Some("") => HarnessSelection::Real,
        Some("off") => HarnessSelection::Off,
        Some(other) => HarnessSelection::Unsupported(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(name: &'static str, value: &'static str) -> impl Fn(&str) -> Option<String> {
        move |n: &str| (n == name).then(|| value.to_string())
    }

    fn none(_: &str) -> Option<String> {
        None
    }

    const MODES: &[Mode] = &[Mode::Sidecar, Mode::Turns];

    #[test]
    fn an_unset_mode_is_the_first_declared() {
        let selection = select_mode(MODES, &none);
        assert_eq!(selection.mode, Mode::Sidecar);
        assert!(!selection.fell_back);
    }

    #[test]
    fn an_empty_mode_is_the_first_declared() {
        let selection = select_mode(MODES, &with(ENV_MODE, "  "));
        assert_eq!(selection.mode, Mode::Sidecar);
        assert!(!selection.fell_back);
    }

    #[test]
    fn a_declared_mode_is_selected() {
        let selection = select_mode(MODES, &with(ENV_MODE, " turns "));
        assert_eq!(selection.mode, Mode::Turns);
        assert!(!selection.fell_back);
    }

    #[test]
    fn an_undeclared_mode_falls_back() {
        let selection = select_mode(MODES, &with(ENV_MODE, "thread"));
        assert_eq!(selection.mode, Mode::Sidecar);
        assert!(selection.fell_back);
    }

    #[test]
    fn an_unknown_mode_falls_back() {
        let selection = select_mode(MODES, &with(ENV_MODE, "bogus"));
        assert_eq!(selection.mode, Mode::Sidecar);
        assert!(selection.fell_back);
    }

    #[test]
    fn no_modes_select_turns() {
        let selection = select_mode(&[], &with(ENV_MODE, "thread"));
        assert_eq!(selection.mode, Mode::Turns);
        assert!(!selection.fell_back);
    }

    #[test]
    fn the_harness_selection() {
        assert_eq!(select_harness(&none), HarnessSelection::Real);
        assert_eq!(
            select_harness(&with(ENV_HARNESS, "")),
            HarnessSelection::Real
        );
        assert_eq!(
            select_harness(&with(ENV_HARNESS, " off ")),
            HarnessSelection::Off
        );
        assert_eq!(
            select_harness(&with(ENV_HARNESS, "null")),
            HarnessSelection::Unsupported("null".to_string())
        );
    }

    #[test]
    fn the_process_env_reads_the_environment() {
        assert!(process_env("ABAI_STUB_NO_SUCH_VARIABLE_SET").is_none());
    }
}
