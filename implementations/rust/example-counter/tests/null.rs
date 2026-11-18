//! The example under the null harness: what a check reads at exit.

use std::path::PathBuf;
use std::process::{Command, Output};

use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_example-counter");

fn temp_home(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("example-counter-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn run(home: &PathBuf, harness: &str, mode: &str, args: &[&str]) -> Output {
    Command::new(BIN)
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env("HOME", home)
        .env_remove("ABAI_HOME")
        .env("ABAI_HARNESS", harness)
        .env("ABAI_MODE", mode)
        .output()
        .unwrap()
}

/// The last line of stderr, as the report it should be.
fn report(output: &Output) -> Value {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let last = stderr.lines().last().unwrap_or_default();
    serde_json::from_str(last).unwrap_or_else(|error| panic!("{error}: {stderr}"))
}

#[test]
fn the_exercise_run_reports_every_channel_in_each_mode() {
    for mode in ["turns", "thread", "sidecar"] {
        let home = temp_home(mode);
        let output = run(&home, "exercise", mode, &[]);
        assert!(output.status.success(), "{mode}: {output:?}");
        let report = report(&output);
        assert_eq!(report["form"], "exercise", "{mode}");
        assert_eq!(report["cellsWritten"], serde_json::json!(["count"]));
        assert_eq!(report["eventsEmitted"], serde_json::json!(["milestone"]));
        assert_eq!(report["knobsWritten"], serde_json::json!(["step", "label"]));
        assert_eq!(report["capabilitiesCalled"], serde_json::json!(["reset"]));
        assert_eq!(report["decisions"], 1, "{mode}");
        assert_eq!(report["turns"], 2, "{mode}");
        assert_eq!(report["dropped"], 0, "{mode}");
        assert_eq!(report["unexercised"], serde_json::json!([]), "{mode}");
        // the acts are on the record the manifest names
        let audit =
            std::fs::read_to_string(home.join(".abai/audit/example-counter.jsonl")).unwrap();
        assert!(
            audit.contains(r#""act":"call","name":"reset","outcome":"ok""#),
            "{audit}"
        );
        std::fs::remove_dir_all(&home).unwrap();
    }
}

#[test]
fn the_passive_run_prints_no_report() {
    let home = temp_home("passive");
    let output = run(&home, "null", "turns", &[]);
    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stderr), "");
    std::fs::remove_dir_all(&home).unwrap();
}

#[test]
fn an_entry_verb_under_the_exercise_reports_too() {
    let home = temp_home("entry");
    let output = run(&home, "exercise", "turns", &["abai", "manifest", "--json"]);
    assert!(output.status.success());
    let report = report(&output);
    assert_eq!(report["form"], "exercise");
    assert_eq!(report["knobsWritten"], serde_json::json!(["step"]));
    std::fs::remove_dir_all(&home).unwrap();
}

#[test]
fn a_verb_that_needs_the_real_harness_is_refused_under_the_null_one() {
    let home = temp_home("verbs");
    for verb in [
        &["abai", "mcp"][..],
        &["abai", "config"],
        &["abai", "run", "--"],
    ] {
        let output = run(&home, "null", "turns", verb);
        assert_eq!(output.status.code(), Some(1), "{verb:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("needs the real harness, and ABAI_HARNESS selects the null harness"),
            "{verb:?}: {stderr}"
        );
    }
    std::fs::remove_dir_all(&home).unwrap();
}
