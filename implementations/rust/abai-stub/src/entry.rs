//! The standard entry: `<prog> abai <verb> ...` (contract section 7).

use std::fmt;
use std::io::Write;
use std::path::PathBuf;

use crate::app::Abaigram;
use crate::doctor::{DoctorOptions, DoctorReport, run_doctor};
use crate::env::{self, ENV_MODE, EnvFn};
use crate::manifest::{Mode, render_yaml};

/// Where the entry writes and what it reads.
pub struct EntryIo<'a> {
    pub out: &'a mut dyn Write,
    pub err: &'a mut dyn Write,
    pub env: EnvFn<'a>,
    pub cwd: PathBuf,
}

impl fmt::Debug for EntryIo<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EntryIo")
            .field("cwd", &self.cwd)
            .finish_non_exhaustive()
    }
}

/// The verbs that need the harness.
const HARNESS_VERBS: &[&str] = &["config", "mcp", "run"];

#[derive(Debug, Default)]
struct Flags {
    json: bool,
    root: Option<String>,
    offline: bool,
}

fn parse_flags(args: &[String], allowed: &[&str]) -> Result<Flags, String> {
    let mut flags = Flags::default();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (arg.as_str(), None),
        };
        if !allowed.contains(&name) {
            return Err(format!("unknown option {arg}"));
        }
        match name {
            "--json" | "--offline" if inline.is_some() => {
                return Err(format!("{name} takes no value"));
            }
            "--json" => flags.json = true,
            "--offline" => flags.offline = true,
            "--root" => {
                let value = match inline {
                    Some(value) => Some(value),
                    None => {
                        i += 1;
                        args.get(i).cloned()
                    }
                };
                match value {
                    Some(value) if !value.is_empty() && !value.starts_with("--") => {
                        flags.root = Some(value)
                    }
                    _ => return Err("--root needs a directory".to_string()),
                }
            }
            _ => return Err(format!("unknown option {arg}")),
        }
        i += 1;
    }
    Ok(flags)
}

fn usage_lines(entry: &str) -> Vec<String> {
    let pad = " ".repeat("usage: ".len());
    vec![
        format!("usage: {entry}                   open a session"),
        format!("{pad}{entry} install           run the install touchpoint"),
        format!("{pad}{entry} run -- ARGS       sidecar launch"),
        format!("{pad}{entry} config            machine-level model and credential settings"),
        format!("{pad}{entry} doctor [--offline] [--json] [--root DIR]"),
        format!("{pad}{entry} manifest [--json] print the effective manifest"),
        format!("{pad}{entry} mcp               serve the agent's tools to an MCP client"),
    ]
}

/// `<prog> abai <verb> ...`. `args` are the arguments after the program's own name.
/// Returns None when the first argument is not `abai` (the program goes on with its own work), else the exit code.
pub fn run_entry(app: &Abaigram, args: &[String]) -> Option<i32> {
    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut io = EntryIo {
        out: &mut stdout,
        err: &mut stderr,
        env: &env::process_env,
        cwd,
    };
    run_entry_with(app, args, &mut io)
}

/// [`run_entry`] with the given output, environment and working directory.
pub fn run_entry_with(app: &Abaigram, args: &[String], io: &mut EntryIo) -> Option<i32> {
    if args.first().map(String::as_str) != Some("abai") {
        return None;
    }
    let code = match run_verb(app, &args[1..], io) {
        Ok(code) => code,
        Err(error) => {
            let _ = writeln!(io.err, "{}: {error}", app.manifest().entry);
            1
        }
    };
    let _ = io.out.flush();
    let _ = io.err.flush();
    Some(code)
}

fn usage(app: &Abaigram, problem: &str, io: &mut EntryIo) -> std::io::Result<i32> {
    let entry = &app.manifest().entry;
    writeln!(io.err, "{entry}: {problem}")?;
    for line in usage_lines(entry) {
        writeln!(io.err, "{line}")?;
    }
    Ok(2)
}

fn run_verb(app: &Abaigram, args: &[String], io: &mut EntryIo) -> std::io::Result<i32> {
    let manifest = app.manifest();
    let entry = &manifest.entry;
    let verb = args.first().map(String::as_str);
    let rest = args.get(1..).unwrap_or(&[]);
    match verb {
        Some("manifest") => {
            let flags = match parse_flags(rest, &["--json"]) {
                Ok(flags) => flags,
                Err(problem) => return usage(app, &problem, io),
            };
            if let Some(problem) = undeclared_mode(app, io) {
                writeln!(io.err, "{entry}: {problem}")?;
                return Ok(2);
            }
            let text = if flags.json {
                manifest.to_json()
            } else {
                render_yaml(manifest)
            };
            io.out.write_all(text.as_bytes())?;
            Ok(0)
        }
        Some("doctor") => {
            let flags = match parse_flags(rest, &["--json", "--root", "--offline"]) {
                Ok(flags) => flags,
                Err(problem) => return usage(app, &problem, io),
            };
            let report = run_doctor(
                app,
                &DoctorOptions {
                    root: flags.root.as_deref(),
                    cwd: &io.cwd,
                    env: io.env,
                    online: !flags.offline,
                },
            );
            if flags.json {
                let text =
                    serde_json::to_string_pretty(&report).expect("a doctor report serializes");
                writeln!(io.out, "{text}")?;
            } else {
                print_report(&report, io)?;
            }
            Ok(if report.ok { 0 } else { 1 })
        }
        None | Some("session") | Some("install") => {
            let verb = verb.unwrap_or("session");
            if let Some(extra) = rest.first() {
                return usage(app, &format!("{verb} takes no argument ({extra})"), io);
            }
            if let Some(problem) = undeclared_mode(app, io) {
                writeln!(io.err, "{entry}: {problem}")?;
                return Ok(2);
            }
            let ran = if verb == "install" {
                app.install()
            } else {
                app.session()
            };
            if !ran {
                let reason = app
                    .attach_error()
                    .unwrap_or_else(|| "the harness went away".to_string());
                writeln!(io.err, "{entry}: {verb}: {reason}")?;
            }
            Ok(if ran { 0 } else { 1 })
        }
        Some("run") => {
            // `run -- ARGS`: everything after the dashes is the program's
            let args = match rest.first().map(String::as_str) {
                Some("--") => &rest[1..],
                Some(other) => {
                    return usage(
                        app,
                        &format!("run takes -- and the program's arguments ({other})"),
                        io,
                    );
                }
                None => rest,
            };
            match app.run_launch(args) {
                Ok(code) => Ok(code),
                Err(reason) => {
                    writeln!(io.err, "{entry}: run: {reason}")?;
                    Ok(1)
                }
            }
        }
        Some(verb) if HARNESS_VERBS.contains(&verb) => {
            if let Some(problem) = undeclared_mode(app, io) {
                writeln!(io.err, "{entry}: {problem}")?;
                return Ok(2);
            }
            // under sidecar mode the harness binary serves the verb
            if let Some(ran) = app.binary_entry(verb, rest) {
                return match ran {
                    Ok(code) => Ok(code),
                    Err(reason) => {
                        writeln!(io.err, "{entry}: {verb}: {reason}")?;
                        Ok(1)
                    }
                };
            }
            match app.embedded_entry(verb, rest) {
                Some(code) => Ok(code),
                None => {
                    writeln!(
                        io.err,
                        "{entry}: {verb} needs the harness, and none serves it"
                    )?;
                    Ok(1)
                }
            }
        }
        Some(verb) => usage(app, &format!("unknown verb {verb}"), io),
    }
}

/// A selected mode the manifest does not declare is an error at the
/// entry (contract section 4.4). `doctor` reports it as a check instead.
fn undeclared_mode(app: &Abaigram, io: &EntryIo) -> Option<String> {
    let manifest = app.manifest();
    let selected = (io.env)(ENV_MODE)?;
    let value = selected.trim();
    if value.is_empty() || Mode::parse(value).is_some_and(|m| manifest.modes.contains(&m)) {
        return None;
    }
    Some(format!(
        "{ENV_MODE}={value} is not a declared mode (declared: {})",
        declared(&manifest.modes)
    ))
}

fn declared(modes: &[Mode]) -> String {
    modes
        .iter()
        .map(|m| m.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn print_report(report: &DoctorReport, io: &mut EntryIo) -> std::io::Result<()> {
    for check in &report.checks {
        writeln!(
            io.out,
            "{:<4} {}: {}",
            check.status.as_str(),
            check.name,
            check.detail
        )?;
    }
    writeln!(
        io.out,
        "{}",
        if report.ok {
            "doctor: ok"
        } else {
            "doctor: failed"
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doctor::tests::{app_with, good_checkout, temp_dir, vars};
    use crate::manifest::Manifest;
    use std::path::Path;

    struct Run {
        code: Option<i32>,
        out: String,
        err: String,
    }

    fn call(app: &Abaigram, args: &[&str], cwd: &Path, pairs: &[(&str, &str)]) -> Run {
        let vars = vars(pairs);
        let env = |name: &str| vars.get(name).cloned();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        let code = run_entry_with(
            app,
            &args,
            &mut EntryIo {
                out: &mut out,
                err: &mut err,
                env: &env,
                cwd: cwd.to_path_buf(),
            },
        );
        Run {
            code,
            out: String::from_utf8(out).unwrap(),
            err: String::from_utf8(err).unwrap(),
        }
    }

    #[test]
    fn not_an_abai_call() {
        let app = app_with(&[]);
        let here = std::env::temp_dir();
        assert_eq!(call(&app, &[], &here, &[]).code, None);
        assert_eq!(call(&app, &["serve", "abai"], &here, &[]).code, None);
    }

    #[test]
    fn manifest_prints_the_render() {
        let app = app_with(&[]);
        let run = call(&app, &["abai", "manifest"], &std::env::temp_dir(), &[]);
        assert_eq!(run.code, Some(0));
        assert_eq!(run.out, render_yaml(app.manifest()));
        assert_eq!(run.err, "");
    }

    #[test]
    fn manifest_json_parses_back() {
        let app = app_with(&[]);
        let run = call(
            &app,
            &["abai", "manifest", "--json"],
            &std::env::temp_dir(),
            &[],
        );
        assert_eq!(run.code, Some(0));
        let parsed: Manifest = serde_json::from_str(&run.out).unwrap();
        assert_eq!(&parsed, app.manifest());
    }

    #[test]
    fn manifest_refuses_an_undeclared_mode() {
        let pairs = [("ABAI_MODE", "thread")];
        let app = app_with(&pairs);
        let run = call(&app, &["abai", "manifest"], &std::env::temp_dir(), &pairs);
        assert_eq!(run.code, Some(2));
        assert_eq!(run.out, "");
        assert_eq!(
            run.err,
            "demo abai: ABAI_MODE=thread is not a declared mode (declared: turns, sidecar)\n"
        );
    }

    #[test]
    fn doctor_on_a_good_checkout() {
        let dir = good_checkout("entry-doctor");
        let root = dir.to_string_lossy().to_string();
        let app = app_with(&[]);
        let run = call(
            &app,
            &["abai", "doctor", "--offline", "--root", &root],
            &std::env::temp_dir(),
            &[("HOME", &root)],
        );
        assert_eq!(run.code, Some(0), "{}", run.out);
        assert_eq!(run.out.lines().last(), Some("doctor: ok"));
        assert!(run.out.starts_with("ok   entry: demo abai reached"));
        assert!(run.out.contains("\nskip online: not asked (--offline)\n"));
        fs_remove(&dir);
    }

    #[test]
    fn doctor_json() {
        let dir = temp_dir("entry-doctor-json");
        let app = app_with(&[]);
        let run = call(&app, &["abai", "doctor", "--json"], &dir, &[]);
        let value: serde_json::Value = serde_json::from_str(&run.out).unwrap();
        assert!(value["ok"].is_boolean());
        assert!(value["checks"].is_array());
        assert_eq!(value["checks"][0]["status"], "ok");
        assert!(run.out.ends_with("}\n"));
        fs_remove(&dir);
    }

    #[test]
    fn an_unknown_verb_prints_the_usage() {
        let app = app_with(&[]);
        let run = call(&app, &["abai", "frob"], &std::env::temp_dir(), &[]);
        assert_eq!(run.code, Some(2));
        let lines: Vec<&str> = run.err.lines().collect();
        assert_eq!(lines[0], "demo abai: unknown verb frob");
        assert_eq!(
            lines[1],
            "usage: demo abai                   open a session"
        );
        assert_eq!(
            lines[6],
            "       demo abai manifest [--json] print the effective manifest"
        );
        assert_eq!(lines.len(), 8);
    }

    #[test]
    fn root_needs_a_value() {
        let app = app_with(&[]);
        let run = call(
            &app,
            &["abai", "doctor", "--root"],
            &std::env::temp_dir(),
            &[],
        );
        assert_eq!(run.code, Some(2));
        assert!(
            run.err
                .starts_with("demo abai: --root needs a directory\nusage: ")
        );

        let run = call(
            &app,
            &["abai", "manifest", "--root", "x"],
            &std::env::temp_dir(),
            &[],
        );
        assert_eq!(run.code, Some(2));
        assert!(run.err.starts_with("demo abai: unknown option --root\n"));
    }

    #[test]
    fn flags_without_values_refuse_one() {
        assert_eq!(
            parse_flags(&["--json=yes".to_string()], &["--json"]).unwrap_err(),
            "--json takes no value"
        );
        assert_eq!(
            parse_flags(&["--offline=".to_string()], &["--offline"]).unwrap_err(),
            "--offline takes no value"
        );
        let app = app_with(&[]);
        let run = call(
            &app,
            &["abai", "doctor", "--json=1"],
            &std::env::temp_dir(),
            &[],
        );
        assert_eq!(run.code, Some(2));
        assert!(
            run.err
                .starts_with("demo abai: --json takes no value\nusage: ")
        );
    }

    #[test]
    fn root_refuses_a_flag_as_its_value() {
        let all = ["--json", "--root", "--offline"];
        for args in [&["--root", "--json"][..], &["--root=--offline"][..]] {
            let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
            assert_eq!(
                parse_flags(&args, &all).unwrap_err(),
                "--root needs a directory"
            );
        }
        let args: Vec<String> = ["--root", "-x"].iter().map(|a| a.to_string()).collect();
        assert_eq!(
            parse_flags(&args, &all).unwrap().root.as_deref(),
            Some("-x")
        );
    }

    #[test]
    fn harness_verbs_need_the_harness() {
        let app = app_with(&[]);
        let run = call(&app, &["abai", "install"], &std::env::temp_dir(), &[]);
        assert_eq!(run.code, Some(1));
        assert_eq!(
            run.err,
            "demo abai: install: no harness is linked into this program\n"
        );
        let run = call(&app, &["abai"], &std::env::temp_dir(), &[]);
        assert_eq!(run.code, Some(1));
        assert_eq!(
            run.err,
            "demo abai: session: no harness is linked into this program\n"
        );
        let run = call(&app, &["abai", "config"], &std::env::temp_dir(), &[]);
        assert_eq!(run.code, Some(1));
        assert_eq!(
            run.err,
            "demo abai: config needs the harness, and none serves it\n"
        );
    }

    fn fs_remove(dir: &Path) {
        std::fs::remove_dir_all(dir).unwrap();
    }
}
