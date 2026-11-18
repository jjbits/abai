//! The null harness: `ABAI_HARNESS=null` and `ABAI_HARNESS=exercise`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use abai_stub::app::{Abaigram, Answer};
use abai_stub::declare::{Capability, Cell, Decision, Declarations, Event, Turn};
use abai_stub::manifest::{Field, Mode, Policy, Schema};
use serde_json::{Value, json};

/// What the program's handlers saw.
#[derive(Default)]
struct Seen {
    doubled: AtomicU64,
    pinged: AtomicU64,
    title: Mutex<String>,
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("abai-null-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn declarations(seen: &Arc<Seen>, audit: &Path) -> Declarations {
    let (double, ping, title) = (seen.clone(), seen.clone(), seen.clone());
    Declarations::new("nulled", [Mode::Turns, Mode::Thread, Mode::Sidecar])
        .audit_path(&audit.display().to_string())
        .cell(Cell::int("count", "A count."))
        .cell(Cell::int("step", "A step.").knob(3).confirm())
        .cell(
            Cell::string("title", "A title.")
                .knob("plain")
                .max(32)
                .on_change(move |value| {
                    *title.title.lock().unwrap() = value.get::<String>()?;
                    Ok(())
                }),
        )
        .event(Event::new("lap", "A lap ended.").payload(Schema::new().field("n", Field::int())))
        .event(Event::new("never", "Never emitted."))
        .capability(
            Capability::new("double", "Twice a number.")
                .params(Schema::new().field("n", Field::int()))
                .result(Schema::new().field("twice", Field::int()))
                .mutate()
                .example(json!({"n": 4}))
                .handler(move |params| {
                    let n = params.get::<Value>()?["n"].as_u64().ok_or("n")?;
                    double.doubled.store(n * 2, Ordering::SeqCst);
                    Ok(json!({"twice": n * 2}))
                }),
        )
        .capability(
            Capability::new("ping", "Answer at once.")
                .immediate()
                .example(json!({}))
                .handler(move |_| {
                    ping.pinged.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({}))
                }),
        )
        .capability(
            Capability::new("refuse", "Always fails.")
                .example(json!({}))
                .handler(|_| Err::<Value, String>("not today".to_string())),
        )
        .capability(Capability::new("bare", "No example.").handler(|_| Ok(json!({}))))
        .capability(
            Capability::new("locked", "Forbidden.")
                .policy(Policy::Forbid)
                .example(json!({}))
                .handler(|_| Ok(json!({}))),
        )
        .decision(Decision::options(
            "on_limit",
            ["wrap", "stop"],
            "stop",
            "5s",
            "At the limit.",
        ))
        .decision(Decision::options(
            "unreached",
            ["a", "b"],
            "a",
            "5s",
            "Never asked.",
        ))
        .turn(Turn::new("each_lap", "30s", "After a lap."))
        .turn(Turn::new("no_lap", "30s", "Never given."))
}

fn app(form: &'static str, mode: &'static str, seen: &Arc<Seen>, audit: &Path) -> Abaigram {
    let env = move |name: &str| match name {
        "ABAI_HARNESS" => Some(form.to_string()),
        "ABAI_MODE" => Some(mode.to_string()),
        _ => None,
    };
    Abaigram::with_env(&declarations(seen, audit), &env).unwrap()
}

fn audit_lines(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn names(report: &Value, key: &str) -> Vec<String> {
    report[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|name| name.as_str().unwrap().to_string())
        .collect()
}

fn unexercised(report: &Value) -> Vec<String> {
    report["unexercised"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            format!(
                "{} {}: {}",
                row["kind"].as_str().unwrap(),
                row["name"].as_str().unwrap(),
                row["why"].as_str().unwrap()
            )
        })
        .collect()
}

#[test]
fn the_passive_form_is_attached_from_the_start_and_drives_nothing() {
    let dir = temp_dir("passive");
    let audit = dir.join("audit.jsonl");
    let seen = Arc::new(Seen::default());
    let app = app("null", "turns", &seen, &audit);
    assert!(app.attached());
    assert!(app.attach());
    assert_eq!(app.attach_error(), None);

    let count = app.cell::<i64>("count").unwrap();
    let step = app.knob::<i64>("step").unwrap();
    let lap = app.event("lap").unwrap();
    count.set(7);
    lap.emit(|payload| payload.int("n", 1));
    lap.emit(|payload| payload.int("n", 2));
    let on_limit = app.decision("on_limit").unwrap();
    assert_eq!(on_limit.ask(&json!({})), Answer::Default(&json!("stop")));
    assert!(app.turn("each_lap").unwrap().give());
    assert!(app.install());
    assert!(app.session());
    app.safepoint();

    // nothing was driven: the knob has its default, no handler ran
    assert_eq!(step.get(), 3);
    assert_eq!(seen.doubled.load(Ordering::SeqCst), 0);
    assert_eq!(seen.pinged.load(Ordering::SeqCst), 0);

    let report = app.null_report().unwrap();
    assert_eq!(report["form"], "null");
    assert_eq!(report["events"], 2);
    assert_eq!(report["dropped"], 0);
    assert_eq!(report["decisions"], 1);
    assert_eq!(report["turns"], 1);
    assert_eq!(report["touchpoints"], 2);
    assert_eq!(names(&report, "cellsWritten"), ["count"]);
    assert_eq!(names(&report, "eventsEmitted"), ["lap"]);
    assert!(names(&report, "knobsWritten").is_empty());
    assert!(names(&report, "capabilitiesCalled").is_empty());
    // the passive form claims nothing about what was not exercised
    assert!(unexercised(&report).is_empty());

    let lines = audit_lines(&audit);
    assert_eq!(lines.len(), 4, "{lines:?}");
    assert_eq!(lines[0]["act"], "decision");
    assert_eq!(lines[0]["outcome"], "default");
    assert_eq!(lines[0]["cause"], "answered");
    assert_eq!(lines[0]["value"], "stop");
    assert_eq!(lines[1]["act"], "turn");
    assert_eq!(lines[1]["outcome"], "ok");
    assert_eq!(lines[2]["act"], "touchpoint");
    assert_eq!(lines[2]["name"], "install");
    assert_eq!(lines[3]["name"], "session");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_exercise_writes_every_knob_and_calls_every_example() {
    let dir = temp_dir("exercise");
    let audit = dir.join("audit.jsonl");
    let seen = Arc::new(Seen::default());
    let app = app("exercise", "turns", &seen, &audit);

    // while the program is being built only the scalar knob is
    // written: no handler runs yet
    assert_eq!(seen.pinged.load(Ordering::SeqCst), 0);
    let built = app.null_report().unwrap();
    assert_eq!(names(&built, "knobsWritten"), ["step"]);
    assert!(names(&built, "capabilitiesCalled").is_empty());
    assert!(
        unexercised(&built).contains(&"capability ping: not attempted".to_string()),
        "{built}"
    );

    // the program says the agent may act: the immediate capability
    // runs; what needs a safepoint waits for one
    assert!(app.attach());
    assert_eq!(seen.pinged.load(Ordering::SeqCst), 1);
    assert_eq!(seen.doubled.load(Ordering::SeqCst), 0);
    assert_eq!(*seen.title.lock().unwrap(), "");
    let early = app.null_report().unwrap();
    assert_eq!(names(&early, "capabilitiesCalled"), ["ping"]);
    assert!(
        unexercised(&early).contains(&"knob title: still pending at exit".to_string()),
        "{early}"
    );
    assert!(
        unexercised(&early).contains(&"capability double: not attempted".to_string()),
        "{early}"
    );

    app.safepoint();
    assert_eq!(seen.doubled.load(Ordering::SeqCst), 8);
    assert_eq!(*seen.title.lock().unwrap(), "plain");
    assert_eq!(seen.pinged.load(Ordering::SeqCst), 1);

    let report = app.null_report().unwrap();
    assert_eq!(report["form"], "exercise");
    assert_eq!(names(&report, "knobsWritten"), ["step", "title"]);
    assert_eq!(names(&report, "capabilitiesCalled"), ["ping", "double"]);
    // the harness's own writes are not the program's
    assert!(names(&report, "cellsWritten").is_empty());
    assert_eq!(
        unexercised(&report),
        [
            "capability bare: no example declared",
            "capability locked: policy forbids it",
            "capability refuse: not today",
            "decision on_limit: not reached",
            "decision unreached: not reached",
            "turn each_lap: not reached",
            "turn no_lap: not reached",
        ]
    );

    let lines = audit_lines(&audit);
    let shown: Vec<String> = lines
        .iter()
        .map(|line| {
            format!(
                "{} {} {} consent={}",
                line["act"].as_str().unwrap(),
                line["name"].as_str().unwrap(),
                line["outcome"].as_str().unwrap(),
                line["consent"].as_str().unwrap_or("-")
            )
        })
        .collect();
    // `step` and `double` are confirm acts: the exercise stands in for
    // the person. Nothing is on the record for what policy forbids.
    assert_eq!(
        shown,
        [
            "knob step ok consent=auto",
            "call ping ok consent=-",
            "knob title ok consent=-",
            "call double ok consent=auto",
            "call refuse failed consent=-",
        ]
    );
    assert_eq!(lines[3]["params"], json!({"n": 4}));
    assert_eq!(lines[0]["value"], 3);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_touchpoint_runs_what_the_exercise_lined_up() {
    let dir = temp_dir("touch");
    let seen = Arc::new(Seen::default());
    let app = app("exercise", "turns", &seen, &dir.join("audit.jsonl"));
    assert_eq!(seen.doubled.load(Ordering::SeqCst), 0);
    assert!(app.turn("each_lap").unwrap().give());
    assert_eq!(seen.doubled.load(Ordering::SeqCst), 8);
    app.decision("on_limit").unwrap().ask(&json!({}));

    let report = app.null_report().unwrap();
    assert_eq!(report["turns"], 1);
    assert_eq!(report["decisions"], 1);
    assert_eq!(
        unexercised(&report),
        [
            "capability bare: no example declared",
            "capability locked: policy forbids it",
            "capability refuse: not today",
            "decision unreached: not reached",
            "turn no_lap: not reached",
        ]
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_null_harness_is_the_same_in_every_mode() {
    for mode in ["thread", "sidecar"] {
        let dir = temp_dir(mode);
        let seen = Arc::new(Seen::default());
        let app = app("exercise", mode, &seen, &dir.join("audit.jsonl"));
        assert_eq!(app.mode().mode.as_str(), mode);
        assert!(app.attached() && app.attach(), "{mode}");
        app.safepoint();
        assert_eq!(seen.doubled.load(Ordering::SeqCst), 8, "{mode}");
        let report = app.null_report().unwrap();
        assert_eq!(names(&report, "capabilitiesCalled"), ["ping", "double"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[test]
fn more_capabilities_than_call_slots_are_all_called() {
    let dir = temp_dir("many");
    let calls = Arc::new(AtomicU64::new(0));
    let mut declarations = Declarations::new("many", [Mode::Turns])
        .audit_path(&dir.join("a.jsonl").display().to_string());
    for n in 0..9 {
        let calls = calls.clone();
        declarations = declarations.capability(
            Capability::new(&format!("c{n}"), "One of many.")
                .example(json!({}))
                .handler(move |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({}))
                }),
        );
    }
    let exercise = |name: &str| (name == "ABAI_HARNESS").then(|| "exercise".to_string());
    let app = Abaigram::with_env(&declarations, &exercise).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    app.safepoint();
    assert_eq!(calls.load(Ordering::SeqCst), 9);
    let report = app.null_report().unwrap();
    assert_eq!(names(&report, "capabilitiesCalled").len(), 9);
    assert!(unexercised(&report).is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn an_audit_path_under_an_unknown_home_writes_nowhere() {
    let seen = Arc::new(Seen::default());
    let app = app(
        "exercise",
        "turns",
        &seen,
        Path::new("~/abai-null-no-home/audit.jsonl"),
    );
    app.safepoint();
    assert_eq!(seen.doubled.load(Ordering::SeqCst), 8);
    assert!(!Path::new("~").exists());
}

#[test]
fn any_other_value_attaches_nothing() {
    let dir = temp_dir("other");
    let seen = Arc::new(Seen::default());
    let app = app("real", "turns", &seen, &dir.join("audit.jsonl"));
    assert!(!app.attached());
    assert!(!app.attach());
    assert_eq!(
        app.attach_error().as_deref(),
        Some("ABAI_HARNESS must be unset, off, null or exercise (got real)")
    );
    assert_eq!(app.null_report(), None);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_decision_reached_inside_an_exercised_handler_counts_as_reached() {
    use abai_stub::app::DecisionPoint;
    use std::sync::OnceLock;

    let dir = temp_dir("inside");
    let audit = dir.join("audit.jsonl");
    let point: Arc<OnceLock<DecisionPoint>> = Arc::new(OnceLock::new());
    let asked = point.clone();
    let declarations = Declarations::new("inside", [Mode::Turns])
        .audit_path(&audit.display().to_string())
        .capability(
            Capability::new("advance", "Move on, asking the way.")
                .example(json!({}))
                .handler(move |_| {
                    // the agent is busy with this call: the default applies
                    let way = asked.get().ok_or("not ready")?.ask(&json!({}));
                    Ok(json!({"way": way.as_str()}))
                }),
        )
        .decision(Decision::options(
            "which_way",
            ["left", "right"],
            "left",
            "5s",
            "At the fork.",
        ));
    let exercise = |name: &str| (name == "ABAI_HARNESS").then(|| "exercise".to_string());
    let app = Abaigram::with_env(&declarations, &exercise).unwrap();
    point.set(app.decision("which_way").unwrap()).unwrap();
    app.safepoint();

    let report = app.null_report().unwrap();
    assert_eq!(names(&report, "capabilitiesCalled"), ["advance"]);
    assert_eq!(report["decisions"], 1);
    assert!(unexercised(&report).is_empty(), "{report}");
    let lines = audit_lines(&audit);
    assert!(
        lines.iter().any(|line| line["act"] == "counter"
            && line["name"] == "which_way"
            && line["of"] == "decision"
            && line["count"] == 1),
        "{lines:?}"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn events_that_lap_the_ring_between_touchpoints_are_counted_as_dropped() {
    let dir = temp_dir("lap");
    let seen = Arc::new(Seen::default());
    let app = app("null", "turns", &seen, &dir.join("audit.jsonl"));
    let lap = app.event("lap").unwrap();
    // more than the ring holds, with no touchpoint in between
    for n in 0..300 {
        lap.emit(|payload| payload.int("n", n));
    }
    let report = app.null_report().unwrap();
    assert_eq!(report["events"], 256);
    assert_eq!(report["dropped"], 44);
    assert_eq!(names(&report, "eventsEmitted"), ["lap"]);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn what_policy_forbids_is_neither_driven_nor_reached() {
    let dir = temp_dir("forbid");
    let audit = dir.join("audit.jsonl");
    let declarations = Declarations::new("forbidden", [Mode::Turns])
        .audit_path(&audit.display().to_string())
        .cell(Cell::int("limit", "A limit.").knob(5))
        .decision(
            Decision::options("never_ask", ["a", "b"], "a", "5s", "Not for the agent.")
                .policy(Policy::Forbid),
        );
    let exercise = |name: &str| (name == "ABAI_HARNESS").then(|| "exercise".to_string());
    let app = Abaigram::with_env(&declarations, &exercise).unwrap();
    let never_ask = app.decision("never_ask").unwrap();
    assert_eq!(never_ask.ask(&json!({})), Answer::Default(&json!("a")));

    let report = app.null_report().unwrap();
    assert_eq!(report["decisions"], 0);
    assert_eq!(unexercised(&report), ["decision never_ask: not reached"]);
    let lines = audit_lines(&audit);
    assert_eq!(lines[1]["act"], "decision");
    assert_eq!(lines[1]["cause"], "forbidden");
    std::fs::remove_dir_all(&dir).unwrap();
}
