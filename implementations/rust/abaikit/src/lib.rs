//! The authoring tool for Rust abaigrams.
//!
//! `check` verifies a repository's conformance level (contract section
//! 12) with the stub's null harness, so it needs no model. `learnabai`
//! prints the guide a coding agent follows to make a Rust abaigram.
//!
//! The tool reaches a program only through its manifest's entry and its
//! `check.run`, as command lines run by the shell in the repository.

pub mod args;
#[cfg(unix)]
pub mod check;
#[cfg(unix)]
pub mod command;
pub mod learnabai;
pub mod subject;

use std::io::Write;
use std::path::PathBuf;

use args::Parsed;

/// The version of this crate.
pub const ABAIKIT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Where a verb writes and what it knows of its surroundings.
pub struct Io<'a> {
    pub out: Box<dyn Write + 'a>,
    pub err: Box<dyn Write + 'a>,
    /// The environment, as pairs.
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
}

impl std::fmt::Debug for Io<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Io")
            .field("cwd", &self.cwd)
            .finish_non_exhaustive()
    }
}

impl Io<'static> {
    /// The process's own streams, environment and working directory.
    pub fn process() -> Self {
        Self {
            out: Box::new(std::io::stdout()),
            err: Box::new(std::io::stderr()),
            env: std::env::vars_os()
                .filter_map(|(name, value)| {
                    Some((name.into_string().ok()?, value.into_string().ok()?))
                })
                .collect(),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        }
    }
}

impl Io<'_> {
    /// An environment variable, when it is set and not empty.
    pub fn var(&self, name: &str) -> Option<&str> {
        self.env
            .iter()
            .find(|(have, value)| have == name && !value.is_empty())
            .map(|(_, value)| value.as_str())
    }
}

/// Why a verb did not run to its end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// The arguments were wrong, or name nothing that can be used: exit
    /// 2, and the usage follows.
    Usage(String),
    /// Anything else: exit 1.
    Other(String),
    /// A signal told the tool to end: exit 128 plus the signal.
    Interrupted(i32),
}

impl Failure {
    pub fn usage(message: impl Into<String>) -> Self {
        Self::Usage(message.into())
    }
}

impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Self {
        Self::Other(error.to_string())
    }
}

/// Run one invocation and return its exit code: 0 done, 1 failed, 2 the
/// arguments were wrong.
pub fn run(argv: &[String], io: &mut Io<'_>) -> u8 {
    let result = args::parse(argv).and_then(|parsed| match parsed {
        Parsed::Help => {
            writeln!(io.out, "{}", args::USAGE)?;
            Ok(0)
        }
        Parsed::Version => {
            writeln!(
                io.out,
                "abaikit-rs {ABAIKIT_VERSION} (stub {})",
                abai_stub::ABAI_STUB_VERSION
            )?;
            Ok(0)
        }
        Parsed::Learnabai(args) => learnabai::run_learnabai(&args, io),
        #[cfg(unix)]
        Parsed::Check(args) => check::run_check(&args, io),
        #[cfg(not(unix))]
        Parsed::Check(_) => Err(Failure::Other(
            "check needs a Unix system in this build".to_string(),
        )),
    });
    match result {
        Ok(code) => code,
        Err(Failure::Usage(message)) => {
            let _ = writeln!(io.err, "abaikit-rs: {message}\n{}", args::USAGE);
            2
        }
        Err(Failure::Other(message)) => {
            let _ = writeln!(io.err, "abaikit-rs: {message}");
            1
        }
        Err(Failure::Interrupted(signal)) => {
            let _ = writeln!(io.err, "abaikit-rs: ended by a signal");
            u8::try_from(128 + signal).unwrap_or(1)
        }
    }
}
