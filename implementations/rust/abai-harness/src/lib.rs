//! The agent-side half of abai.
//!
//! A program's agent runs in this crate. The contract is
//! `spec/abaigrammar.md` at the repository root.

pub mod agent;
pub mod attention;
pub mod cli;
#[cfg(unix)]
pub mod command;
pub mod config;
pub mod core;
pub mod embedded;
#[cfg(unix)]
pub mod launch;
pub mod mcp;
pub mod model;
#[cfg(unix)]
pub mod net;
#[cfg(unix)]
pub mod network;
pub mod prompt;
#[cfg(unix)]
pub mod sidecar;
pub mod terminal;
mod thread;
pub mod tools;

// The audit log and the clock are the stub's: its null harness writes the log too.
pub use abai_stub::{audit, time};
pub use embedded::embedded;

/// The version of this crate.
pub const ABAI_HARNESS_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The line `abai-harness --version` prints.
pub fn version_line() -> String {
    format!(
        "abai-harness {ABAI_HARNESS_VERSION} (stub {})",
        abai_stub::ABAI_STUB_VERSION
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_line_names_both_halves() {
        assert_eq!(version_line(), "abai-harness 0.1.0 (stub 0.1.0)");
    }
}
