//! The program-side half of abai.
//!
//! A program includes this crate to become an abaigram. The contract is
//! `spec/abaigrammar.md` at the repository root.

pub mod app;
pub mod audit;
pub mod content;
pub mod declare;
pub mod doctor;
pub mod entry;
pub mod env;
pub mod link;
pub mod manifest;
pub mod null;
pub mod region;
#[cfg(unix)]
pub mod sidecar;
pub mod time;

/// The version of this crate.
pub const ABAI_STUB_VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_the_package_version() {
        assert_eq!(ABAI_STUB_VERSION, "0.1.0");
    }
}
