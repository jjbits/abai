//! `abaikit-rs`: the authoring tool for Rust abaigrams.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut io = abaikit::Io::process();
    let code = abaikit::run(&args, &mut io);
    ExitCode::from(code)
}
