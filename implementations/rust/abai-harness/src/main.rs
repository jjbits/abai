use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(unix)]
    let code = abai_harness::command::run(&args);
    #[cfg(not(unix))]
    let code = match args.first().map(String::as_str) {
        Some("--version") | Some("-V") => {
            println!("{}", abai_harness::version_line());
            0
        }
        _ => {
            eprintln!("abai-harness: this build's verbs need a Unix system");
            2
        }
    };
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
