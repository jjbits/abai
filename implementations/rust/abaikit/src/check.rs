//! `check`: a repository's conformance level (contract section 12), with
//! no model.
//!
//! Level 1 is reached through the subject's entry alone: what `manifest`
//! prints is byte for byte the checked-in file, what `manifest --json`
//! prints is a valid manifest, and `doctor --offline --json` finds no
//! failure. Levels 2 to 4 are reached through its `check.run` under the
//! exercise null harness, once per declared mode, read from the report
//! the stub prints at exit. The overhead of section 11.6 is measured by
//! the same command under `ABAI_HARNESS=off` and `ABAI_HARNESS=null`,
//! interleaved. The subject's environment is constructed, never
//! inherited: each run gets exactly the `ABAI_HARNESS` and `ABAI_MODE` it
//! means, and the entry runs get neither. A level is the one reached
//! under every checked mode, and passing means that level with no
//! violation.

use std::io::Write;
use std::time::Duration;

use abai_stub::doctor::{CheckStatus, DoctorCheck, first_differing_line};
use abai_stub::manifest::{Manifest, Mode, validate};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::args::CheckArgs;
use crate::command::{
    CommandOptions, CommandRun, MAX_OUTPUT_BYTES, json_document, last_json_line, last_plain_line,
    median, run_command, subject_env, tail_of,
};
use crate::subject::{Subject, entry_command, load_subject};
use crate::{Failure, Io};

/// Measurement runs of each kind, unless `--runs` says otherwise.
pub const DEFAULT_RUNS: u32 = 3;
/// The bound on one `check.run`, unless `--timeout` says otherwise.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
/// How long an entry verb (manifest, doctor) may take.
pub const ENTRY_TIMEOUT: Duration = Duration::from_secs(60);
/// Below this median for the off run, startup noise is most of the number.
pub const NOISE_FLOOR_MS: f64 = 500.0;
/// Characters of a run's output the JSON report carries.
const REPORT_TAIL_CHARS: usize = 4096;
/// The name of each level, by number.
pub const LEVEL_NAMES: [&str; 5] = [
    "none",
    "reachable",
    "observable",
    "steerable",
    "deliberative",
];

/// What the stub's exercise harness reports at exit, as JSON on stderr.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExerciseReport {
    pub form: String,
    #[serde(default)]
    pub events: u64,
    #[serde(default)]
    pub dropped: u64,
    #[serde(default)]
    pub decisions: u64,
    #[serde(default)]
    pub turns: u64,
    #[serde(default)]
    pub touchpoints: u64,
    #[serde(default)]
    pub cells_written: Vec<String>,
    /// The program's own events, by name; absent in a report from an older stub.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events_emitted: Option<Vec<String>>,
    #[serde(default)]
    pub knobs_written: Vec<String>,
    #[serde(default)]
    pub capabilities_called: Vec<String>,
    pub unexercised: Vec<Unexercised>,
}

/// One thing the exercise could not do, as the stub reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unexercised {
    pub kind: String,
    pub name: String,
    pub why: String,
}

/// One thing the exercise could not do, under a mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModeUnexercised {
    pub mode: Mode,
    pub kind: String,
    pub name: String,
    pub why: String,
}

/// The overhead of section 11.6 under one mode.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    pub runs: u32,
    /// The milliseconds of each `ABAI_HARNESS=off` run that finished.
    pub off: Vec<f64>,
    /// The milliseconds of each `ABAI_HARNESS=null` run that finished.
    pub null: Vec<f64>,
    pub off_median_ms: Option<f64>,
    pub null_median_ms: Option<f64>,
    /// null over off, minus one; None when either side has no run.
    pub slowdown: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
    /// The runs that did not exit 0 or timed out, by harness.
    pub failed: Vec<String>,
    /// The numbers are within startup noise or the two ranges overlap.
    pub within_noise: bool,
}

/// The exercise run under one mode and what it reported.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Exercise {
    pub run: CommandRun,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<ExerciseReport>,
}

/// What shows each level above 1, as a sentence; empty when not run.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct Evidence {
    pub l2: String,
    pub l3: String,
    pub l4: String,
}

/// Levels 2 to 4 and the measurement, under one mode.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModeResult {
    pub mode: Mode,
    /// The highest level this mode demonstrated, 1 to 4.
    pub level: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exercise: Option<Exercise>,
    pub evidence: Evidence,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measurement: Option<Measurement>,
}

/// A rule the subject breaks, and where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Violation {
    #[serde(rename = "where")]
    pub at: String,
    pub what: String,
}

/// Level 1, through the entry.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelOne {
    pub ok: bool,
    pub manifest_agrees: bool,
    pub doctor: Vec<DoctorCheck>,
    pub ran: Vec<String>,
    pub detail: String,
}

/// Everything `check` found.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckReport {
    pub root: String,
    pub name: String,
    /// The contract version the entry's manifest names; None when no
    /// manifest was printed.
    pub abaigrammar: Option<String>,
    pub entry: String,
    pub declared_modes: Vec<Mode>,
    pub checked_modes: Vec<Mode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check_run: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overhead_limit: Option<String>,
    /// This tool offers no build with the stub compiled out, and builds
    /// nothing: the command runs as is.
    pub compiled_out: &'static str,
    pub built: &'static str,
    pub l1: LevelOne,
    pub per_mode: Vec<ModeResult>,
    pub level: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested: Option<u8>,
    pub passed: bool,
    pub unexercised: Vec<ModeUnexercised>,
    pub violations: Vec<Violation>,
    pub notes: Vec<String>,
}

/// What a report gathers as the check goes.
#[derive(Debug, Default)]
struct Found {
    violations: Vec<Violation>,
    unexercised: Vec<ModeUnexercised>,
    notes: Vec<String>,
}

impl Found {
    fn violation(&mut self, at: impl Into<String>, what: impl Into<String>) {
        self.violations.push(Violation {
            at: at.into(),
            what: what.into(),
        });
    }
}

/// A percentage such as `5%` or `2.5 %`, as a fraction.
fn parse_overhead(limit: &str) -> Option<f64> {
    let number = limit.trim().strip_suffix('%')?.trim_end();
    let (whole, fraction) = match number.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (number, None),
    };
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    if !digits(whole) || fraction.is_some_and(|f| !digits(f)) {
        return None;
    }
    number.parse::<f64>().ok().map(|n| n / 100.0)
}

/// Whether a command line ends in the word `abai`, after no letter,
/// digit or underscore.
fn ends_in_abai(entry: &str) -> bool {
    entry.trim().strip_suffix("abai").is_some_and(|before| {
        before
            .chars()
            .last()
            .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'))
    })
}

fn describe_run(run: &CommandRun) -> String {
    if run.timed_out {
        return "did not finish within the timeout and was ended".to_string();
    }
    match (run.code, run.signal) {
        (Some(0), _) => "exited 0".to_string(),
        (Some(code), _) => format!("exited {code}"),
        (None, Some(signal)) => format!("was ended by {}", crate::command::signal_name(signal)),
        (None, None) => "exited ?".to_string(),
    }
}

fn failed(run: &CommandRun) -> bool {
    run.timed_out || run.code != Some(0)
}

fn last_words(run: &CommandRun) -> String {
    let words = match last_plain_line(&run.stderr) {
        "" => last_plain_line(&run.stdout),
        words => words,
    };
    if words.is_empty() {
        "no output".to_string()
    } else {
        words.to_string()
    }
}

/// A run as the JSON report carries it: the newest part of each stream,
/// not a whole log.
fn trimmed(run: &CommandRun) -> CommandRun {
    CommandRun {
        stdout: tail_of(&run.stdout, REPORT_TAIL_CHARS),
        stderr: tail_of(&run.stderr, REPORT_TAIL_CHARS),
        ..run.clone()
    }
}

fn spread(values: &[f64]) -> (f64, f64) {
    let min = values.iter().copied().fold(f64::INFINITY, f64::min);
    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    (min, max)
}

/// Where and with what environment the subject's commands run.
#[derive(Debug)]
struct Runner<'a> {
    subject: &'a Subject,
    env: &'a [(String, String)],
}

impl Runner<'_> {
    fn run(&self, command: &str, set: &[(&str, &str)], timeout: Duration) -> CommandRun {
        let env = subject_env(self.env, set);
        run_command(
            command,
            &CommandOptions {
                cwd: &self.subject.root,
                env: &env,
                timeout,
                max_output_bytes: MAX_OUTPUT_BYTES,
            },
        )
    }
}

/// Level 1 through the entry: the manifest as text and as JSON, and the
/// offline doctor. Returns the manifest the entry printed, when it is
/// valid.
fn check_level_one(
    runner: &Runner<'_>,
    entry: &str,
    found: &mut Found,
) -> (LevelOne, Option<Manifest>) {
    let subject = runner.subject;
    let manifest_path = subject.manifest_path.display().to_string();
    let mut details = Vec::new();
    let mut ran = Vec::new();

    // what the entry prints is the checked-in file, byte for byte (section 12)
    let mut manifest_agrees = false;
    let text_command = entry_command(entry, &["manifest"]);
    ran.push(text_command.clone());
    let shown = runner.run(&text_command, &[], ENTRY_TIMEOUT);
    if failed(&shown) {
        found.violation(
            &text_command,
            format!("{}: {}", describe_run(&shown), last_words(&shown)),
        );
    } else if shown.stdout == subject.manifest_text {
        manifest_agrees = true;
        details.push("abaigram.yaml is what the entry prints".to_string());
    } else {
        let line = first_differing_line(&subject.manifest_text, &shown.stdout).unwrap_or(0);
        found.violation(
            &manifest_path,
            format!(
                "is stale: first difference at line {line}; run: {entry} manifest > abaigram.yaml"
            ),
        );
    }

    // the whole manifest, from the program itself: this tool reads no YAML
    let json_command = entry_command(entry, &["manifest", "--json"]);
    ran.push(json_command.clone());
    let printed = runner.run(&json_command, &[], ENTRY_TIMEOUT);
    let parsed = if failed(&printed) {
        Err(format!(
            "{}: {}",
            describe_run(&printed),
            last_words(&printed)
        ))
    } else {
        serde_json::from_str::<Manifest>(&printed.stdout).map_err(|error| error.to_string())
    };
    let manifest = match parsed {
        Err(reason) => {
            found.violation(&json_command, format!("did not print a manifest: {reason}"));
            None
        }
        Ok(manifest) => {
            let problems = validate(&manifest);
            if problems.is_empty() {
                Some(manifest)
            } else {
                found.violation(
                    &json_command,
                    format!(
                        "the printed manifest does not validate: {}",
                        problems.join("; ")
                    ),
                );
                None
            }
        }
    };
    if let Some(manifest) = &manifest
        && manifest.name != subject.name
    {
        found.violation(
            &manifest_path,
            format!(
                "names {}, but the entry's program is {}",
                subject.name, manifest.name
            ),
        );
    }

    let mut doctor: Vec<DoctorCheck> = Vec::new();
    let doctor_command = entry_command(entry, &["doctor", "--offline", "--json"]);
    ran.push(doctor_command.clone());
    let examined = runner.run(&doctor_command, &[], ENTRY_TIMEOUT);
    let checks = json_document(&examined.stdout)
        .and_then(|mut document| document.remove("checks"))
        .and_then(|checks| serde_json::from_value::<Vec<DoctorCheck>>(checks).ok());
    match checks {
        Some(checks) => {
            doctor = checks;
            for check in &doctor {
                // the manifest file is judged above, with the hint for
                // this entry; the doctor's word on it would repeat it
                if check.status == CheckStatus::Fail && check.name != "abaigram.yaml" {
                    found.violation(format!("doctor: {}", check.name), &check.detail);
                }
            }
            let count = |status| doctor.iter().filter(|c| c.status == status).count();
            details.push(format!(
                "doctor: {} ok, {} failed",
                count(CheckStatus::Ok),
                count(CheckStatus::Fail)
            ));
        }
        None => found.violation(
            &doctor_command,
            format!(
                "{} and printed no report: {}",
                describe_run(&examined),
                last_words(&examined)
            ),
        ),
    }

    let ok = manifest_agrees
        && manifest.as_ref().is_some_and(|m| m.name == subject.name)
        && !doctor.is_empty()
        && doctor.iter().all(|c| c.status != CheckStatus::Fail);
    let l1 = LevelOne {
        ok,
        manifest_agrees,
        doctor,
        ran,
        detail: details.join("; "),
    };
    (l1, manifest)
}

/// How each mode is run and measured.
#[derive(Debug, Clone, Copy)]
struct ModeOptions<'a> {
    run: &'a str,
    overhead: Option<&'a str>,
    runs: u32,
    timeout: Duration,
}

/// Levels 2 to 4 and the measurement, under one mode.
fn check_mode(
    runner: &Runner<'_>,
    manifest: &Manifest,
    mode: Mode,
    options: ModeOptions<'_>,
    found: &mut Found,
) -> ModeResult {
    let name = mode.as_str();
    let mut result = ModeResult {
        mode,
        level: 1,
        exercise: None,
        evidence: Evidence::default(),
        measurement: None,
    };
    let at = |harness: &str| format!("check.run under {name} with ABAI_HARNESS={harness}");
    let run = runner.run(
        options.run,
        &[("ABAI_HARNESS", "exercise"), ("ABAI_MODE", name)],
        options.timeout,
    );
    // the report is the stub's exit hook: it is there even when the
    // program failed, and says what was reached
    let report = last_json_line(&run.stderr, |v| {
        v.get("form") == Some(&Value::from("exercise"))
    })
    .filter(|v| v.get("unexercised").is_some_and(Value::is_array))
    .and_then(|v| serde_json::from_value::<ExerciseReport>(Value::Object(v)).ok());
    if let Some(report) = &report {
        for u in &report.unexercised {
            found.unexercised.push(ModeUnexercised {
                mode,
                kind: u.kind.clone(),
                name: u.name.clone(),
                why: u.why.clone(),
            });
        }
        for cell in manifest.cells.iter().filter(|c| !c.is_knob()) {
            if !report.cells_written.contains(&cell.name) {
                found.unexercised.push(ModeUnexercised {
                    mode,
                    kind: "cell".to_string(),
                    name: cell.name.clone(),
                    why: "not written during the exercise run".to_string(),
                });
            }
        }
        if let Some(emitted) = &report.events_emitted {
            for event in &manifest.events {
                if !emitted.contains(&event.name) {
                    found.unexercised.push(ModeUnexercised {
                        mode,
                        kind: "event".to_string(),
                        name: event.name.clone(),
                        why: "not emitted during the exercise run".to_string(),
                    });
                }
            }
        }
        if report.dropped > 0 {
            found.notes.push(format!(
                "{name}: {} events were dropped before the null harness read them, so an event may be missing from the report",
                report.dropped
            ));
        }
    }
    result.exercise = Some(Exercise {
        run: trimmed(&run),
        report: report.clone(),
    });
    if failed(&run) {
        found.violation(
            at("exercise"),
            format!("{}: {}", describe_run(&run), last_words(&run)),
        );
        return result;
    }
    let Some(report) = report else {
        let kept = if run.dropped.stderr > 0 {
            format!(" in the {} newest bytes of stderr kept", run.stderr.len())
        } else {
            String::new()
        };
        found.violation(
            at("exercise"),
            format!(
                "printed no exercise report at exit{kept}: the stub did not attach its null harness (is the entry hook in main, and the program built?)"
            ),
        );
        return result;
    };

    // the program's own events, by name; a report that names none (an
    // older stub) shows none: the library's do not count
    let emitted = report.events_emitted.clone().unwrap_or_default();
    let listed = |names: &[String]| {
        if names.is_empty() {
            "none".to_string()
        } else {
            names.join(", ")
        }
    };
    let l2 = !report.cells_written.is_empty() || !emitted.is_empty();
    result.evidence.l2 = if l2 {
        format!(
            "cells written: {}; events: {}",
            listed(&report.cells_written),
            listed(&emitted)
        )
    } else {
        "no cell written and no event emitted during the exercise run".to_string()
    };
    let l3 = !report.capabilities_called.is_empty() || !report.knobs_written.is_empty();
    result.evidence.l3 = if l3 {
        format!(
            "capabilities called: {}; knobs landed: {}",
            listed(&report.capabilities_called),
            listed(&report.knobs_written)
        )
    } else {
        "no capability called and no knob landed".to_string()
    };
    let l4 = report.decisions > 0;
    result.evidence.l4 = if l4 {
        format!("decisions reached: {}", report.decisions)
    } else {
        "no decision reached".to_string()
    };
    result.level = match (l2, l3, l4) {
        (false, _, _) => 1,
        (true, false, _) => 2,
        (true, true, false) => 3,
        (true, true, true) => 4,
    };

    // the measurement (11.6): off and null, interleaved so drift lands on
    // both, K runs each, the medians side by side
    let mut measurement = Measurement {
        runs: options.runs,
        off: Vec::new(),
        null: Vec::new(),
        off_median_ms: None,
        null_median_ms: None,
        slowdown: None,
        limit: None,
        failed: Vec::new(),
        within_noise: false,
    };
    for _ in 0..options.runs {
        for harness in ["off", "null"] {
            let timed = runner.run(
                options.run,
                &[("ABAI_HARNESS", harness), ("ABAI_MODE", name)],
                options.timeout,
            );
            if failed(&timed) {
                measurement
                    .failed
                    .push(format!("{harness}: {}", describe_run(&timed)));
            } else if harness == "off" {
                measurement.off.push(timed.ms);
            } else {
                measurement.null.push(timed.ms);
            }
        }
    }
    if !measurement.failed.is_empty() {
        found.violation(
            format!("check.run under {name} with ABAI_HARNESS=off and null"),
            format!("measurement runs failed: {}", measurement.failed.join("; ")),
        );
    }
    if !measurement.off.is_empty() && !measurement.null.is_empty() {
        let off_median = median(&measurement.off);
        let null_median = median(&measurement.null);
        measurement.off_median_ms = Some(off_median);
        measurement.null_median_ms = Some(null_median);
        measurement.slowdown = (off_median > 0.0).then(|| null_median / off_median - 1.0);
        let (off_min, off_max) = spread(&measurement.off);
        let (null_min, null_max) = spread(&measurement.null);
        measurement.within_noise =
            off_median < NOISE_FLOOR_MS || (null_min <= off_max && off_min <= null_max);
        if measurement.within_noise {
            found.notes.push(format!(
                "under {name} the overhead numbers are within noise (off {off_min:.0}..{off_max:.0} ms, null {null_min:.0}..{null_max:.0} ms, {} runs each): raise --runs or give check.run more work before reading the slowdown",
                options.runs
            ));
        }
        if let Some(overhead) = options.overhead {
            match parse_overhead(overhead) {
                None => found.violation(
                    "check.overhead",
                    format!(
                        "{} is not a percentage such as \"5%\"",
                        serde_json::to_string(overhead).unwrap_or_default()
                    ),
                ),
                Some(limit) => {
                    measurement.limit = Some(limit);
                    if let Some(slowdown) = measurement.slowdown
                        && slowdown > limit
                    {
                        let noise = if measurement.within_noise {
                            ", within noise"
                        } else {
                            ""
                        };
                        found.violation(
                            at("null"),
                            format!(
                                "the null-harness run is {:.1}% slower than the off run (medians of {}{noise}); check.overhead allows {overhead}",
                                slowdown * 100.0,
                                options.runs
                            ),
                        );
                    }
                }
            }
        }
    }
    result.measurement = Some(measurement);
    result
}

/// Check the repository the arguments name.
pub fn check_repository(args: &CheckArgs, io: &Io<'_>) -> Result<CheckReport, Failure> {
    let mut found = Found::default();
    let subject = load_subject(&args.repo, &io.cwd)?;
    let entry = args.entry.clone().unwrap_or_else(|| subject.entry.clone());
    let runs = args.runs.unwrap_or(DEFAULT_RUNS);
    let timeout = args.timeout_s.map_or(DEFAULT_TIMEOUT, Duration::from_secs);
    let runner = Runner {
        subject: &subject,
        env: &io.env,
    };

    let (l1, manifest) = check_level_one(&runner, &entry, &mut found);

    let declared_modes = manifest
        .as_ref()
        .map(|m| m.modes.clone())
        .unwrap_or_default();
    let mut checked_modes = declared_modes.clone();
    if let Some(manifest) = &manifest
        && let Some(mode) = args.mode
    {
        if manifest.modes.contains(&mode) {
            checked_modes = vec![mode];
        } else {
            let declared: Vec<&str> = manifest.modes.iter().map(|m| m.as_str()).collect();
            found.violation(
                "--mode",
                format!(
                    "{} declares {}, not {}",
                    manifest.name,
                    declared.join(", "),
                    mode.as_str()
                ),
            );
            checked_modes = Vec::new();
        }
    }
    if !ends_in_abai(&entry) {
        found.notes.push(format!(
            "the entry \"{entry}\" does not end in the word abai: the stub's run_entry answers only \"abai ...\", so the verbs reach the program only if it translates them itself"
        ));
    }
    let check = manifest
        .as_ref()
        .and_then(|m| m.check.as_ref())
        .filter(|c| !c.run.is_empty());
    if check.is_some()
        && checked_modes
            .iter()
            .any(|m| matches!(m, Mode::Sidecar | Mode::Thread))
    {
        found.notes.push(
            "the null harness stays in the program's process, so under sidecar and thread modes the measurement leaves out the socket and the harness thread"
                .to_string(),
        );
    }

    let mut per_mode = Vec::new();
    if let (true, Some(manifest), Some(check)) = (l1.ok, &manifest, check) {
        let options = ModeOptions {
            run: &check.run,
            overhead: check.overhead.as_deref(),
            runs,
            timeout,
        };
        for &mode in &checked_modes {
            per_mode.push(check_mode(&runner, manifest, mode, options, &mut found));
        }
    } else if l1.ok {
        found.notes.push(
            "check.run is not declared, so nothing above level 1 can be shown and nothing is measured (section 12)"
                .to_string(),
        );
    }

    // a signal told the tool to end: the runs after it were not made,
    // so there is no finding to report
    if let Some(signal) = crate::command::interrupted() {
        return Err(Failure::Interrupted(signal));
    }

    let level = if !l1.ok {
        0
    } else {
        per_mode.iter().map(|m| m.level).min().unwrap_or(1)
    };
    let passed = level >= args.level.unwrap_or(1) && found.violations.is_empty();
    Ok(CheckReport {
        root: subject.root.display().to_string(),
        name: subject.name.clone(),
        abaigrammar: manifest.as_ref().map(|m| m.abaigrammar.clone()),
        entry,
        declared_modes,
        checked_modes,
        check_run: manifest
            .as_ref()
            .and_then(|m| m.check.as_ref())
            .map(|c| c.run.clone()),
        overhead_limit: manifest
            .as_ref()
            .and_then(|m| m.check.as_ref())
            .and_then(|c| c.overhead.clone()),
        compiled_out: "not offered",
        built: "no",
        l1,
        per_mode,
        level,
        requested: args.level,
        passed,
        unexercised: found.unexercised,
        violations: found.violations,
        notes: found.notes,
    })
}

fn pct(value: Option<f64>) -> String {
    match value {
        Some(v) if !v.is_nan() => {
            let sign = if v >= 0.0 { "+" } else { "" };
            format!("{sign}{:.1}%", v * 100.0)
        }
        _ => "n/a".to_string(),
    }
}

fn range(values: &[f64]) -> String {
    if values.is_empty() {
        return "failed".to_string();
    }
    let (min, max) = spread(values);
    format!("{:.0} ({min:.0}..{max:.0})", median(values))
}

fn joined(modes: &[Mode]) -> String {
    modes
        .iter()
        .map(|m| m.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// The report as text, for a person.
pub fn render_report(report: &CheckReport) -> String {
    let mut lines = Vec::new();
    lines.push(format!(
        "abaikit-rs check: {} at {} (abaigrammar {}, entry: {})",
        report.name,
        report.root,
        report.abaigrammar.as_deref().unwrap_or("?"),
        report.entry
    ));
    let clean = report.violations.is_empty();
    let verdict = match report.requested {
        None if clean => "no violations".to_string(),
        None => "with violations".to_string(),
        Some(requested) if report.level < requested => {
            format!("requested {requested}: not reached")
        }
        Some(requested) if clean => format!("requested {requested}: passed"),
        Some(requested) => format!("requested {requested}: reached, with violations"),
    };
    lines.push(if report.level == 0 {
        format!("level: 0 (L1 not reached; {verdict})")
    } else {
        format!(
            "level: {} {} ({verdict})",
            report.level,
            LEVEL_NAMES[usize::from(report.level)]
        )
    });
    if report.abaigrammar.is_none() {
        lines.push("modes: unknown".to_string());
    } else if report.checked_modes.len() == report.declared_modes.len() {
        lines.push(format!("modes: {}", joined(&report.declared_modes)));
    } else {
        let checked = if report.checked_modes.is_empty() {
            "none".to_string()
        } else {
            joined(&report.checked_modes)
        };
        lines.push(format!(
            "modes: {}; checked: {checked}",
            joined(&report.declared_modes)
        ));
    }
    let detail = if report.l1.detail.is_empty() {
        String::new()
    } else {
        format!(" ({})", report.l1.detail)
    };
    lines.push(format!(
        "L1 reachable: {}{detail}; ran: {}",
        if report.l1.ok { "ok" } else { "not reached" },
        report.l1.ran.join("; ")
    ));
    for n in 2..=4u8 {
        let parts: Vec<String> = report
            .per_mode
            .iter()
            .map(|m| {
                let evidence = match n {
                    2 => &m.evidence.l2,
                    3 => &m.evidence.l3,
                    _ => &m.evidence.l4,
                };
                let mode = m.mode.as_str();
                if m.exercise.as_ref().is_some_and(|e| e.report.is_none()) {
                    format!("{mode}: exercise run failed")
                } else if evidence.is_empty() {
                    format!("{mode}: not run")
                } else {
                    let ok = if m.level >= n { "ok" } else { "no" };
                    format!("{mode}: {ok}, {evidence}")
                }
            })
            .collect();
        let shown = if parts.is_empty() {
            "not shown".to_string()
        } else {
            parts.join("; ")
        };
        lines.push(format!("L{n} {}: {shown}", LEVEL_NAMES[usize::from(n)]));
    }
    if let Some(check_run) = &report.check_run
        && report.per_mode.iter().any(|m| m.measurement.is_some())
    {
        lines.push(format!(
            "overhead (check.run: {check_run}; built: {}, the command runs as is; compiled out: {}; median ms (min..max) of each run set):",
            report.built, report.compiled_out
        ));
        lines.push(
            "  mode      runs  off                null               slowdown   limit".to_string(),
        );
        for m in &report.per_mode {
            let Some(x) = &m.measurement else { continue };
            let limit = x
                .limit
                .map_or("none".to_string(), |l| format!("{:.1}%", l * 100.0));
            let noise = if x.within_noise {
                "  (within noise)"
            } else {
                ""
            };
            lines.push(format!(
                "  {:<9} {:<5} {:<18} {:<18} {:<10} {limit}{noise}",
                m.mode.as_str(),
                x.runs,
                range(&x.off),
                range(&x.null),
                pct(x.slowdown)
            ));
        }
    }
    if report.unexercised.is_empty() {
        lines.push("unexercised: none".to_string());
    } else {
        lines.push("unexercised:".to_string());
        for u in &report.unexercised {
            lines.push(format!(
                "  {}: {} {}: {}",
                u.mode.as_str(),
                u.kind,
                u.name,
                u.why
            ));
        }
    }
    if report.violations.is_empty() {
        lines.push("violations: none".to_string());
    } else {
        lines.push("violations:".to_string());
        for v in &report.violations {
            lines.push(format!("  {}: {}", v.at, v.what));
        }
    }
    for note in &report.notes {
        lines.push(format!("note: {note}"));
    }
    let mut text = lines.join("\n");
    text.push('\n');
    text
}

/// Run `check` and return its exit code: 0 when the subject passed, 1
/// when not.
pub fn run_check(args: &CheckArgs, io: &mut Io<'_>) -> Result<u8, Failure> {
    let report = check_repository(args, io)?;
    if args.json {
        let text = serde_json::to_string_pretty(&report)
            .map_err(|error| Failure::Other(error.to_string()))?;
        writeln!(io.out, "{text}")?;
    } else {
        write!(io.out, "{}", render_report(&report))?;
    }
    Ok(if report.passed { 0 } else { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overheads_are_percentages() {
        assert_eq!(parse_overhead("5%"), Some(0.05));
        assert_eq!(parse_overhead(" 2.5 % "), Some(0.025));
        assert_eq!(parse_overhead("5"), None);
        assert_eq!(parse_overhead("-1%"), None);
        assert_eq!(parse_overhead("1.%"), None);
        assert_eq!(parse_overhead("%"), None);
    }

    #[test]
    fn an_entry_ends_in_the_word_abai() {
        assert!(ends_in_abai("./prog abai"));
        assert!(ends_in_abai("bin/abai "));
        assert!(ends_in_abai("abai"));
        assert!(!ends_in_abai("./prog"));
        assert!(!ends_in_abai("./grabai"));
    }

    #[test]
    fn slowdowns_and_ranges_are_written_as_the_table_shows_them() {
        assert_eq!(pct(Some(0.0123)), "+1.2%");
        assert_eq!(pct(Some(-0.05)), "-5.0%");
        assert_eq!(pct(None), "n/a");
        assert_eq!(range(&[]), "failed");
        assert_eq!(range(&[3.0, 1.0, 2.0]), "2 (1..3)");
    }
}
