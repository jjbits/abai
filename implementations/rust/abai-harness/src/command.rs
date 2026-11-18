//! The harness binary's own verbs: `abai-harness <verb> ...`.
//!
//! A program in sidecar mode runs this binary for an attach and for the
//! verbs of the standard entry it does not serve itself. A person runs
//! it to see which programs are running and to reach one.

use std::io::Write;
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};

use abai_stub::region::header;
use abai_stub::sidecar::{Descriptor, abai_home, descriptors, run_dir};
use serde_json::json;

use crate::cli;
use crate::embedded::linked;
use crate::sidecar::{SESSION_ENDED, Then, serve};

const USAGE: &str = "usage: abai-harness run [--auto] [--deny-mutate] -- PROGRAM ARGS
       abai-harness list [--json]
       abai-harness attach (PID | NAME | --socket PATH) [--auto] [--deny-mutate]
       abai-harness session (PID | NAME) [--auto] [--deny-mutate]
       abai-harness mcp (PID | NAME | --socket PATH) [--deny-mutate]
       abai-harness config ...
       abai-harness doctor [--json]
       abai-harness --version";

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// Run one invocation and return its exit code.
pub fn run(args: &[String]) -> i32 {
    let rest = args.get(1..).unwrap_or(&[]);
    match args.first().map(String::as_str) {
        Some("--version") | Some("-V") => {
            println!("{}", crate::version_line());
            0
        }
        Some("list") => list(rest),
        Some("run") => run_program(rest),
        Some("attach") => attach(rest, Then::Serve),
        Some("session") => attach(rest, Then::Session),
        Some("mcp") => mcp(rest),
        Some("config") => {
            // a program's entry says which program it is
            let (program, rest) = program_flag(rest);
            cli::config_stdio(rest, program)
        }
        Some("doctor") => doctor(rest),
        Some(verb) => {
            eprintln!("abai-harness: unknown verb {verb}\n{USAGE}");
            2
        }
        None => {
            eprintln!("{USAGE}");
            2
        }
    }
}

/// Whether the program's region says a harness is attached. The region
/// is a file: one word of it is read.
fn attached(descriptor: &Descriptor) -> bool {
    let mut word = [0u8; 8];
    std::fs::File::open(&descriptor.region)
        .and_then(|file| file.read_exact_at(&mut word, header::ATTACHED as u64 * 8))
        .is_ok_and(|()| u64::from_le_bytes(word) != 0)
}

fn running() -> Result<Vec<Descriptor>, String> {
    let home = abai_home(&process_env)
        .ok_or("neither ABAI_HOME nor HOME is set, so there is no run directory")?;
    Ok(descriptors(&run_dir(&home)))
}

fn list(args: &[String]) -> i32 {
    let as_json = match args {
        [] => false,
        [flag] if flag == "--json" => true,
        _ => {
            eprintln!("abai-harness: list takes only --json\n{USAGE}");
            return 2;
        }
    };
    let programs = match running() {
        Ok(programs) => programs,
        Err(reason) => {
            eprintln!("abai-harness: {reason}");
            return 1;
        }
    };
    let mut out = std::io::stdout();
    if as_json {
        let rows: Vec<_> = programs
            .iter()
            .map(|d| {
                json!({"pid": d.pid, "name": d.name, "entry": d.entry,
                    "attached": attached(d), "started": d.started, "socket": d.socket})
            })
            .collect();
        let _ = writeln!(out, "{}", serde_json::Value::Array(rows));
        return 0;
    }
    if programs.is_empty() {
        let _ = writeln!(out, "no Rust abaigram is running in sidecar mode");
        return 0;
    }
    let _ = writeln!(out, "{:<8} {:<24} HARNESS", "PID", "NAME");
    for d in &programs {
        let harness = if attached(d) { "attached" } else { "none" };
        let _ = writeln!(out, "{:<8} {:<24} {harness}", d.pid, d.name);
    }
    0
}

/// The socket of the program a person named, by pid or by name.
pub(crate) fn find(target: &str) -> Result<PathBuf, String> {
    let programs = running()?;
    // a number is a pid first; a program may also be named with digits
    let by_pid: Vec<&Descriptor> = match target.parse::<u32>() {
        Ok(pid) => programs.iter().filter(|d| d.pid == pid).collect(),
        Err(_) => Vec::new(),
    };
    let matches = if by_pid.is_empty() {
        programs.iter().filter(|d| d.name == target).collect()
    } else {
        by_pid
    };
    match matches.as_slice() {
        [one] => Ok(one.socket.clone()),
        [] => Err(format!(
            "no running program is {target} (abai-harness list shows them)"
        )),
        several => Err(format!(
            "{} running programs are {target}: name one by pid ({})",
            several.len(),
            several
                .iter()
                .map(|d| d.pid.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

fn attach(args: &[String], then: Then) -> i32 {
    let mut harness = linked();
    let mut socket: Option<PathBuf> = None;
    let mut target: Option<&str> = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--auto" => harness.options.auto = true,
            "--deny-mutate" => harness.options.deny_mutate = true,
            "--socket" if then == Then::Serve => match rest.next() {
                Some(path) => socket = Some(PathBuf::from(path)),
                None => {
                    eprintln!("abai-harness: --socket needs a path\n{USAGE}");
                    return 2;
                }
            },
            name if !name.starts_with('-') && target.is_none() => target = Some(name),
            other => {
                eprintln!("abai-harness: unexpected {other}\n{USAGE}");
                return 2;
            }
        }
    }
    let socket = match (socket, target) {
        (Some(socket), None) => socket,
        (None, Some(target)) => match find(target) {
            Ok(socket) => socket,
            Err(reason) => {
                eprintln!("abai-harness: {reason}");
                return 1;
            }
        },
        _ => {
            eprintln!("abai-harness: name one program\n{USAGE}");
            return 2;
        }
    };
    match serve(Path::new(&socket), &harness, then) {
        // a session the user ended is the one quiet way out
        Ok(ended) if then == Then::Session && ended.reason == SESSION_ENDED => 0,
        Ok(ended) => {
            eprintln!("abai-harness: detached: {}", ended.reason);
            i32::from(then == Then::Session)
        }
        Err(reason) => {
            eprintln!("abai-harness: {reason}");
            1
        }
    }
}

/// `mcp (PID | NAME | --socket PATH) [--deny-mutate]`: serve the agent's
/// tools for a running program to an MCP client on stdio.
fn mcp(args: &[String]) -> i32 {
    let mut options = crate::core::Options::default();
    let mut socket: Option<PathBuf> = None;
    let mut target: Option<&str> = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--deny-mutate" => options.deny_mutate = true,
            "--socket" => match rest.next() {
                Some(path) => socket = Some(PathBuf::from(path)),
                None => {
                    eprintln!("abai-harness: --socket needs a path\n{USAGE}");
                    return 2;
                }
            },
            name if !name.starts_with('-') && target.is_none() => target = Some(name),
            other => {
                eprintln!("abai-harness: unexpected {other}\n{USAGE}");
                return 2;
            }
        }
    }
    let socket = match (socket, target) {
        (Some(socket), None) => Ok(socket),
        (None, Some(target)) => find(target),
        _ => {
            eprintln!("abai-harness: name one program\n{USAGE}");
            return 2;
        }
    };
    let served = socket.and_then(|socket| {
        crate::sidecar::serve_mcp(&socket, options, None, crate::mcp::McpIo::stdio())
    });
    match served {
        Ok(()) => 0,
        Err(reason) => {
            eprintln!("abai-harness: {reason}");
            1
        }
    }
}

/// `run [--auto] [--deny-mutate] -- PROGRAM ARGS`: sidecar launch.
fn run_program(args: &[String]) -> i32 {
    let mut harness = linked();
    let mut rest = args;
    let command = loop {
        match rest.split_first() {
            Some((flag, more)) if flag == "--auto" => {
                harness.options.auto = true;
                rest = more;
            }
            Some((flag, more)) if flag == "--deny-mutate" => {
                harness.options.deny_mutate = true;
                rest = more;
            }
            Some((dashes, command)) if dashes == "--" && !command.is_empty() => break command,
            _ => {
                eprintln!("abai-harness: run takes -- and the program's command\n{USAGE}");
                return 2;
            }
        }
    };
    match crate::launch::launch(command, &harness) {
        Ok(code) => code,
        Err(reason) => {
            eprintln!("abai-harness: {reason}");
            1
        }
    }
}

/// A leading `--program NAME`, which a program's entry passes so the
/// verb knows which program it serves.
fn program_flag(args: &[String]) -> (Option<&str>, &[String]) {
    match args {
        [flag, name, rest @ ..] if flag == "--program" => (Some(name.as_str()), rest),
        _ => (None, args),
    }
}

fn doctor(args: &[String]) -> i32 {
    let (program, args) = program_flag(args);
    // what the program declares about its network, as its entry says it
    let (declared, args) = match args {
        [flag, rest @ ..] if flag == "--network-required" => (Some(true), rest),
        [flag, rest @ ..] if flag == "--network-declared" => (Some(false), rest),
        _ => (None, args),
    };
    let declared = declared.map(|required| abai_stub::manifest::NetworkDecl {
        required: Some(required),
        doc: String::new(),
    });
    let as_json = match args {
        [] => false,
        [flag] if flag == "--json" => true,
        _ => {
            eprintln!("abai-harness: doctor takes only --json\n{USAGE}");
            return 2;
        }
    };
    let mut checks = cli::doctor_online(&process_env);
    checks.extend(cli::doctor_network(
        &process_env,
        program,
        declared.as_ref(),
    ));
    let failed = checks
        .iter()
        .any(|check| check.status == abai_stub::doctor::CheckStatus::Fail);
    let mut out = std::io::stdout();
    if as_json {
        let text = serde_json::to_string(&checks).expect("checks serialize");
        let _ = writeln!(out, "{text}");
    } else {
        for check in &checks {
            let _ = writeln!(
                out,
                "{:<4} {}: {}",
                check.status.as_str(),
                check.name,
                check.detail
            );
        }
    }
    i32::from(failed)
}
