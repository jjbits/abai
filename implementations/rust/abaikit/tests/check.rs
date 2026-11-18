//! `check` against a subject built from the `check_subject` example, in
//! a temporary directory per test: level 1 through the entry, levels 2
//! to 4 through `check.run` under the exercise harness in each mode, the
//! measurement, and the violations with their locations.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use abaikit::Io;
use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_abaikit-rs");

/// The subject program: an example of this package, which links only the
/// stub. Cargo builds a package's own binary for its tests, and not
/// always its examples, so the example is built here, once.
fn program() -> PathBuf {
    static BUILT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    BUILT
        .get_or_init(|| {
            let mut build = Command::new(env!("CARGO"));
            build
                .args(["build", "--quiet", "--offline", "-p", "abaikit"])
                .args(["--example", "check_subject"])
                .current_dir(env!("CARGO_MANIFEST_DIR"));
            // what cargo set for this test binary is not passed on: a
            // dependency's build script would see it as a change, and
            // every run would rebuild that dependency twice
            for (name, _) in std::env::vars_os() {
                let name = name.to_string_lossy().into_owned();
                let per_crate = [
                    "CARGO_MANIFEST_",
                    "CARGO_PKG_",
                    "CARGO_BIN_",
                    "CARGO_CRATE_",
                ];
                if per_crate.iter().any(|prefix| name.starts_with(prefix))
                    || name == "CARGO_PRIMARY_PACKAGE"
                    || name == "CARGO_TARGET_TMPDIR"
                {
                    build.env_remove(&name);
                }
            }
            let built = build.status().unwrap();
            assert!(built.success(), "the subject program did not build");
            let path = Path::new(BIN)
                .parent()
                .unwrap()
                .join("examples/check_subject");
            assert!(path.is_file(), "{} is missing", path.display());
            path
        })
        .clone()
}

/// A subject in a temporary directory: its identity, its manifest as the
/// program prints it, and the variables that configure it.
struct Subject {
    dir: PathBuf,
    vars: Vec<(String, String)>,
}

impl Subject {
    /// `vars` are the `SUBJECT_*` variables besides `SUBJECT_ENTRY`.
    fn new(tag: &str, vars: &[(&str, &str)]) -> Self {
        let dir = std::env::temp_dir().join(format!("abaikit-check-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("abai")).unwrap();
        let dir = dir.canonicalize().unwrap();
        std::fs::write(
            dir.join("abai/identity.md"),
            "A subject for check's tests.\n",
        )
        .unwrap();
        let entry = format!("{} abai", program().display());
        let mut all = vec![("SUBJECT_ENTRY".to_string(), entry)];
        all.extend(vars.iter().map(|(n, v)| (n.to_string(), v.to_string())));
        let subject = Self { dir, vars: all };
        let printed = Command::new(program())
            .args(["abai", "manifest"])
            .current_dir(&subject.dir)
            .env_remove("ABAI_HARNESS")
            .env_remove("ABAI_MODE")
            .envs(subject.vars.iter().map(|(n, v)| (n, v)))
            .output()
            .unwrap();
        assert!(printed.status.success(), "{printed:?}");
        std::fs::write(subject.dir.join("abaigram.yaml"), &printed.stdout).unwrap();
        subject
    }

    /// `abaikit-rs check <dir> <args>`, in process: the exit code, out and err.
    fn check(&self, args: &[&str]) -> (u8, String, String) {
        let dir = self.dir.display().to_string();
        let mut argv = vec!["check".to_string(), dir];
        argv.extend(args.iter().map(|a| a.to_string()));
        self.run(&argv)
    }

    /// `check` with `--json`: the exit code and the parsed report.
    fn check_json(&self, args: &[&str]) -> (u8, Value) {
        let mut args = args.to_vec();
        args.push("--json");
        let (code, out, err) = self.check(&args);
        let report = serde_json::from_str(&out).unwrap_or_else(|e| panic!("{e}: {out}{err}"));
        (code, report)
    }

    fn run(&self, argv: &[String]) -> (u8, String, String) {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let mut env: Vec<(String, String)> = std::env::vars().collect();
        env.extend(self.vars.iter().cloned());
        let mut io = Io {
            out: Box::new(&mut out),
            err: Box::new(&mut err),
            env,
            cwd: self.dir.clone(),
        };
        let code = abaikit::run(argv, &mut io);
        drop(io);
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }
}

impl Drop for Subject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn line_with<'a>(text: &'a str, prefix: &str) -> &'a str {
    text.lines()
        .find(|line| line.starts_with(prefix))
        .unwrap_or_else(|| panic!("no line starts with {prefix:?} in:\n{text}"))
}

fn wheres(report: &Value) -> Vec<String> {
    report["violations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["where"].as_str().unwrap().to_string())
        .collect()
}

fn whats(report: &Value) -> String {
    report["violations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["what"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn without_check_run_the_subject_is_level_1_and_fails_a_requested_4() {
    let subject = Subject::new("norun", &[]);
    let (code, report) = subject.check_json(&[]);
    assert_eq!(code, 0, "{report:#}");
    assert_eq!(report["level"], 1);
    assert_eq!(report["passed"], true);
    assert_eq!(report["name"], "check-subject");
    assert_eq!(report["l1"]["ok"], true);
    assert_eq!(report["l1"]["manifestAgrees"], true);
    assert!(report.get("checkRun").is_none());
    assert_eq!(report["perMode"], serde_json::json!([]));
    let notes = report["notes"].to_string();
    assert!(notes.contains("check.run is not declared"), "{notes}");

    let (code, out, _) = subject.check(&["--level", "4"]);
    assert_eq!(code, 1);
    assert_eq!(
        line_with(&out, "level: "),
        "level: 1 reachable (requested 4: not reached)"
    );
    assert_eq!(line_with(&out, "L2 "), "L2 observable: not shown");
    assert!(
        out.starts_with("abaikit-rs check: check-subject at "),
        "{out}"
    );
}

#[test]
fn a_full_subject_is_level_4_under_every_mode() {
    let example = program().display().to_string();
    let subject = Subject::new("full", &[("SUBJECT_RUN", &example)]);
    let (code, out, err) = subject.check(&["--runs", "1"]);
    assert_eq!(code, 0, "{out}{err}");
    assert_eq!(
        line_with(&out, "level: "),
        "level: 4 deliberative (no violations)"
    );
    assert_eq!(line_with(&out, "modes: "), "modes: turns, thread, sidecar");
    for n in ["L2 ", "L3 ", "L4 "] {
        let line = line_with(&out, n);
        for mode in ["turns: ok", "thread: ok", "sidecar: ok"] {
            assert!(line.contains(mode), "{line}");
        }
    }
    assert!(line_with(&out, "L2 ").contains("cells written: count; events: tick"));
    assert!(line_with(&out, "L3 ").contains("capabilities called: echo; knobs landed: step"));
    assert!(line_with(&out, "L4 ").contains("decisions reached: 1"));
    assert!(line_with(&out, "overhead (check.run: ").contains(&example));
    for mode in ["turns", "thread", "sidecar"] {
        let row = line_with(&out, &format!("  {mode} "));
        assert!(row.contains("none"), "{row}");
        assert!(
            out.contains(&format!(
                "\n  {mode}: capability bare: no example declared\n"
            )),
            "{out}"
        );
    }
    assert!(out.contains("note: the null harness stays in the program's process"));

    let (code, report) = subject.check_json(&["--runs", "1"]);
    assert_eq!(code, 0, "{report:#}");
    assert_eq!(report["level"], 4);
    assert_eq!(report["passed"], true);
    assert_eq!(report["abaigrammar"], "0.1");
    assert_eq!(report["compiledOut"], "not offered");
    let per_mode = report["perMode"].as_array().unwrap();
    assert_eq!(per_mode.len(), 3);
    for m in per_mode {
        assert_eq!(m["level"], 4);
        assert_eq!(m["exercise"]["report"]["form"], "exercise");
        assert_eq!(m["exercise"]["run"]["timedOut"], false);
        assert_eq!(m["measurement"]["off"].as_array().unwrap().len(), 1);
        assert_eq!(m["measurement"]["null"].as_array().unwrap().len(), 1);
        assert_eq!(m["measurement"]["failed"], serde_json::json!([]));
    }
}

#[test]
fn smaller_subjects_reach_their_own_levels() {
    let example = program().display().to_string();
    for (level, name) in [("2", "observable"), ("3", "steerable")] {
        let subject = Subject::new(
            &format!("level{level}"),
            &[("SUBJECT_RUN", &example), ("SUBJECT_LEVEL", level)],
        );
        let (code, out, err) = subject.check(&["--runs", "1"]);
        assert_eq!(code, 0, "{out}{err}");
        assert_eq!(
            line_with(&out, "level: "),
            format!("level: {level} {name} (no violations)")
        );
    }
}

#[test]
fn a_stale_manifest_keeps_the_level_at_0() {
    let subject = Subject::new("stale", &[]);
    let path = subject.dir.join("abaigram.yaml");
    let mut text = std::fs::read_to_string(&path).unwrap();
    text.push_str("# an edit by hand\n");
    std::fs::write(&path, text).unwrap();
    let (code, report) = subject.check_json(&[]);
    assert_eq!(code, 1);
    assert_eq!(report["level"], 0);
    assert_eq!(report["l1"]["manifestAgrees"], false);
    let what = whats(&report);
    assert!(
        what.contains("is stale: first difference at line")
            && what.contains(" abai manifest > abaigram.yaml"),
        "{what}"
    );
    assert!(wheres(&report).contains(&path.display().to_string()));
}

#[test]
fn a_missing_identity_keeps_the_level_at_0() {
    let subject = Subject::new("identity", &[]);
    std::fs::remove_file(subject.dir.join("abai/identity.md")).unwrap();
    let (code, report) = subject.check_json(&[]);
    assert_eq!(code, 1);
    assert_eq!(report["level"], 0);
    assert!(
        wheres(&report).contains(&"doctor: identity".to_string()),
        "{report:#}"
    );
    assert!(whats(&report).contains("identity.md is missing"));
}

#[test]
fn an_exceeded_overhead_is_a_violation() {
    let example = program().display().to_string();
    let run = format!(r#"if [ "$ABAI_HARNESS" = null ]; then sleep 0.3; fi; {example}"#);
    let subject = Subject::new(
        "overhead",
        &[("SUBJECT_RUN", &run), ("SUBJECT_OVERHEAD", "1%")],
    );
    let (code, report) = subject.check_json(&["--runs", "1", "--mode", "turns"]);
    assert_eq!(code, 1);
    assert_eq!(report["level"], 4);
    assert_eq!(report["overheadLimit"], "1%");
    assert_eq!(report["perMode"][0]["measurement"]["limit"], 0.01);
    let violations = report["violations"].as_array().unwrap();
    assert!(
        violations.iter().any(|v| {
            v["where"].as_str().unwrap().ends_with("ABAI_HARNESS=null")
                && v["what"]
                    .as_str()
                    .unwrap()
                    .contains("check.overhead allows 1%")
        }),
        "{report:#}"
    );
}

#[test]
fn a_mode_the_manifest_does_not_declare_is_a_violation() {
    let example = program().display().to_string();
    let subject = Subject::new(
        "mode",
        &[("SUBJECT_RUN", &example), ("SUBJECT_MODES", "turns")],
    );
    let (code, out, _) = subject.check(&["--mode", "thread"]);
    assert_eq!(code, 1);
    assert_eq!(line_with(&out, "modes: "), "modes: turns; checked: none");
    assert!(
        out.contains("\n  --mode: check-subject declares turns, not thread\n"),
        "{out}"
    );
    assert_eq!(
        line_with(&out, "level: "),
        "level: 1 reachable (with violations)"
    );
}

#[test]
fn a_check_run_that_hangs_is_ended_at_the_timeout() {
    let subject = Subject::new("hang", &[("SUBJECT_RUN", "sleep 30 & wait")]);
    let started = Instant::now();
    let (code, report) = subject.check_json(&["--timeout", "1", "--mode", "turns"]);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(code, 1);
    assert_eq!(report["level"], 1);
    assert_eq!(report["perMode"][0]["exercise"]["run"]["timedOut"], true);
    assert_eq!(
        report["violations"][0]["where"],
        "check.run under turns with ABAI_HARNESS=exercise"
    );
    assert!(whats(&report).contains("did not finish within the timeout and was ended"));
}

#[test]
fn a_check_run_without_the_report_is_a_violation() {
    let subject = Subject::new("noreport", &[("SUBJECT_RUN", "true")]);
    let (code, report) = subject.check_json(&["--mode", "turns"]);
    assert_eq!(code, 1);
    assert_eq!(report["level"], 1);
    assert!(
        whats(&report).contains("printed no exercise report at exit"),
        "{report:#}"
    );
}

#[test]
fn an_entry_that_fails_keeps_the_level_at_0() {
    let subject = Subject::new("entry", &[]);
    let (code, report) = subject.check_json(&["--entry", "false"]);
    assert_eq!(code, 1);
    assert_eq!(report["level"], 0);
    assert_eq!(report["entry"], "false");
    assert_eq!(report["abaigrammar"], Value::Null);
    let wheres = wheres(&report);
    for command in [
        "false manifest",
        "false manifest --json",
        "false doctor --offline --json",
    ] {
        assert!(wheres.contains(&command.to_string()), "{wheres:?}");
    }
    let (_, out, _) = subject.check(&["--entry", "false"]);
    assert!(out.contains("(abaigrammar ?, entry: false)"), "{out}");
    assert_eq!(line_with(&out, "modes: "), "modes: unknown");
    assert!(out.contains("does not end in the word abai"), "{out}");
}

#[test]
fn a_path_with_no_abaigram_is_a_usage_failure() {
    let dir = std::env::temp_dir().join(format!("abaikit-check-none-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut io = Io {
        out: Box::new(&mut out),
        err: Box::new(&mut err),
        env: std::env::vars().collect(),
        cwd: dir.clone(),
    };
    let code = abaikit::run(&["check".to_string(), ".".to_string()], &mut io);
    drop(io);
    let err = String::from_utf8(err).unwrap();
    assert_eq!(code, 2);
    assert!(err.contains("no abaigram.yaml here or above it"), "{err}");
    assert!(err.contains("usage: abaikit-rs"), "{err}");
    assert!(out.is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_report_is_read_from_a_program_that_exits_by_a_call() {
    let run = program().display().to_string();
    let subject = Subject::new(
        "exit-call",
        &[("SUBJECT_RUN", &run), ("SUBJECT_EXIT", "call")],
    );
    let (code, report) = subject.check_json(&["--runs", "1", "--mode", "turns"]);
    assert_eq!(code, 0, "{report}");
    assert_eq!(report["level"], 4);
    // the program's last words had no line break; the report is still
    // the last line, whole
    let stderr = report["perMode"][0]["exercise"]["run"]["stderr"]
        .as_str()
        .unwrap();
    assert!(stderr.starts_with("check-subject: leaving\n{"), "{stderr}");
}

#[test]
fn a_signal_to_the_tool_ends_its_run_and_the_tool() {
    let pid_file =
        std::env::temp_dir().join(format!("abaikit-check-signal-{}.pid", std::process::id()));
    let _ = std::fs::remove_file(&pid_file);
    let run = format!("sleep 30 & echo $! > {}; wait", pid_file.display());
    let subject = Subject::new("signal", &[("SUBJECT_RUN", &run)]);
    let started = Instant::now();
    let mut tool = Command::new(BIN)
        .args([
            "check",
            &subject.dir.display().to_string(),
            "--mode",
            "turns",
        ])
        .envs(subject.vars.iter().map(|(n, v)| (n, v)))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    // the exercise run has started when its child's pid is written
    while !std::fs::read_to_string(&pid_file).is_ok_and(|text| text.ends_with('\n')) {
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "check.run never started"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let child: libc::pid_t = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    // SAFETY: signals the process this test started, by the pid it was given.
    unsafe { libc::kill(tool.id() as libc::pid_t, libc::SIGTERM) };
    let status = tool.wait().unwrap();
    assert_eq!(status.code(), Some(128 + libc::SIGTERM), "{status:?}");
    assert!(
        started.elapsed() < Duration::from_secs(25),
        "{:?}",
        started.elapsed()
    );
    // the run's own child went with it
    let asked = Instant::now();
    // SAFETY: signal 0 only asks whether the process exists.
    while unsafe { libc::kill(child, 0) } == 0 {
        assert!(
            asked.elapsed() < Duration::from_secs(2),
            "the run's child outlived the tool"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let _ = std::fs::remove_file(&pid_file);
}

#[test]
fn an_overhead_that_is_no_percentage_is_a_violation() {
    let run = program().display().to_string();
    let subject = Subject::new(
        "overhead-word",
        &[("SUBJECT_RUN", &run), ("SUBJECT_OVERHEAD", "a little")],
    );
    let (code, report) = subject.check_json(&["--runs", "1", "--mode", "turns"]);
    assert_eq!(code, 1);
    assert_eq!(report["level"], 4);
    assert_eq!(wheres(&report), ["check.overhead"]);
}

#[test]
fn another_entry_can_stand_in_for_the_manifests() {
    let subject = Subject::new("entry", &[]);
    // the same program, reached through the shell
    let entry = format!("exec {} abai", program().display());
    let (code, report) = subject.check_json(&["--entry", &entry]);
    assert_eq!(code, 0, "{report}");
    assert_eq!(report["level"], 1);
    assert_eq!(report["entry"], entry);
}
