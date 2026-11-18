//! The touchpoints and the safepoint, against a harness made for the test.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use abai_stub::app::{Abaigram, Answer};
use abai_stub::declare::{Capability, Cell, Decision, Declarations, Turn};
use abai_stub::link::{Embedded, Harness, Outcome, StubCore, Touch};
use abai_stub::manifest::{Field, Mode, Schema};
use abai_stub::region::calls::{self, Target};
use abai_stub::region::header;
use serde_json::{Value, json};

fn declarations() -> Declarations {
    Declarations::new("touch", [Mode::Turns])
        .cell(Cell::int("count", "A count."))
        .capability(
            Capability::new("double", "Twice a number.")
                .params(Schema::new().field("n", Field::int()))
                .result(Schema::new().field("twice", Field::int()))
                .handler(|params| {
                    let n = params.get::<Value>()?["n"]
                        .as_i64()
                        .ok_or("n is not a number")?;
                    Ok(json!({"twice": n * 2}))
                }),
        )
        .decision(Decision::options(
            "on_limit",
            ["wrap", "stop"],
            "stop",
            "5s",
            "At the limit.",
        ))
        .decision(Decision::options(
            "or_else",
            ["go"],
            "abort",
            "5s",
            "Go, or not at all.",
        ))
        .turn(Turn::new("each_lap", "30s", "After a lap."))
}

/// A harness that records the touchpoints and answers as it was told.
struct Scripted {
    core: Arc<StubCore>,
    seen: Arc<Mutex<Vec<Touch>>>,
    answers: Arc<Mutex<Vec<Outcome>>>,
}

impl Harness for Scripted {
    fn touch(&self, touch: Touch) -> Outcome {
        self.seen.lock().unwrap().push(touch);
        let outcome = self.answers.lock().unwrap().remove(0);
        if outcome == Outcome::Detached {
            self.core.region[header::ATTACHED].store(0, Ordering::SeqCst);
        }
        outcome
    }
}

#[derive(Default)]
struct Linked {
    seen: Arc<Mutex<Vec<Touch>>>,
    answers: Arc<Mutex<Vec<Outcome>>>,
    attaches: Arc<Mutex<u32>>,
    refuse: bool,
    entry_args: Arc<Mutex<Vec<String>>>,
}

impl Embedded for Linked {
    fn attach(&self, core: Arc<StubCore>) -> Result<Arc<dyn Harness>, String> {
        if self.refuse {
            return Err("no model is configured".to_string());
        }
        *self.attaches.lock().unwrap() += 1;
        core.region[header::ATTACHED].store(1, Ordering::SeqCst);
        Ok(Arc::new(Scripted {
            core,
            seen: self.seen.clone(),
            answers: self.answers.clone(),
        }))
    }

    fn entry(&self, _: Arc<StubCore>, verb: &str, args: &[String]) -> Option<i32> {
        *self.entry_args.lock().unwrap() = args.to_vec();
        (verb == "config").then_some(7)
    }

    fn doctor(&self, _: Arc<StubCore>) -> Option<Vec<abai_stub::doctor::DoctorCheck>> {
        Some(vec![abai_stub::doctor::DoctorCheck {
            name: "model".to_string(),
            status: abai_stub::doctor::CheckStatus::Fail,
            detail: "no model is configured".to_string(),
        }])
    }
}

fn none(_: &str) -> Option<String> {
    None
}

fn counter(app: &Abaigram, word: Option<usize>) -> u64 {
    app.region()[word.unwrap()].load(Ordering::Relaxed)
}

#[test]
fn with_no_harness_a_decision_is_its_default_and_is_counted() {
    let app = Abaigram::with_env(&declarations(), &none).unwrap();
    let on_limit = app.decision("on_limit").unwrap();
    let or_else = app.decision("or_else").unwrap();
    let lap = app.turn("each_lap").unwrap();

    let answer = on_limit.ask(&json!({"count": 9}));
    assert_eq!(answer, Answer::Default(&json!("stop")));
    assert_eq!(answer.as_str(), "stop");
    assert!(!answer.by_agent() && !answer.is_abort());
    assert!(or_else.ask(&()).is_abort());
    on_limit.ask(&());
    assert!(!lap.give());

    let layout = &app.region().layout;
    assert_eq!(counter(&app, layout.decision_counter("on_limit")), 2);
    assert_eq!(counter(&app, layout.decision_counter("or_else")), 1);
    assert_eq!(counter(&app, layout.turn_counter("each_lap")), 1);
    assert!(app.decision("nothing").is_err());
    assert!(app.turn("on_limit").is_err());
}

#[test]
fn a_decision_and_a_turn_never_attach() {
    let linked = Linked::default();
    let attaches = linked.attaches.clone();
    let app = Abaigram::with_env(&declarations(), &none)
        .unwrap()
        .with_harness(Box::new(linked));
    app.decision("on_limit").unwrap().ask(&());
    app.turn("each_lap").unwrap().give();
    assert_eq!(*attaches.lock().unwrap(), 0);
}

#[test]
fn an_attached_harness_serves_the_touchpoints() {
    let linked = Linked::default();
    let (seen, answers, attaches) = (
        linked.seen.clone(),
        linked.answers.clone(),
        linked.attaches.clone(),
    );
    let app = Abaigram::with_env(&declarations(), &none)
        .unwrap()
        .with_harness(Box::new(linked));
    assert!(app.attach());
    assert!(app.attach());
    assert_eq!(*attaches.lock().unwrap(), 1);

    *answers.lock().unwrap() = vec![
        Outcome::Answer(json!("wrap")),
        Outcome::Default,
        Outcome::Done,
        Outcome::Done,
        Outcome::Done,
    ];
    let on_limit = app.decision("on_limit").unwrap();
    let answer = on_limit.ask(&json!({"count": 9}));
    assert_eq!(answer, Answer::Agent(json!("wrap")));
    assert!(answer.by_agent());
    assert_eq!(
        on_limit.ask(&json!({"count": 10})),
        Answer::Default(&json!("stop"))
    );
    assert!(app.turn("each_lap").unwrap().give());
    assert!(app.install());
    assert!(app.session());

    let seen = seen.lock().unwrap();
    assert_eq!(
        seen[0],
        Touch::Decide {
            name: "on_limit".to_string(),
            context: json!({"count": 9}),
            timeout: std::time::Duration::from_secs(5),
        }
    );
    assert!(matches!(&seen[2], Touch::Turn { name, .. } if name == "each_lap"));
    assert_eq!(seen[3..], [Touch::Install, Touch::Session]);
    // nothing was defaulted for want of a harness
    let layout = &app.region().layout;
    assert_eq!(counter(&app, layout.decision_counter("on_limit")), 0);
}

#[test]
fn a_harness_that_goes_is_forgotten_and_attached_again_when_asked() {
    let linked = Linked::default();
    let (answers, attaches) = (linked.answers.clone(), linked.attaches.clone());
    let app = Abaigram::with_env(&declarations(), &none)
        .unwrap()
        .with_harness(Box::new(linked));
    assert!(app.attach());
    *answers.lock().unwrap() = vec![Outcome::Detached, Outcome::Done];
    let lap = app.turn("each_lap").unwrap();
    assert!(!lap.give());
    // detached: the next turn costs a load and a count, and does not attach
    assert!(!lap.give());
    assert_eq!(*attaches.lock().unwrap(), 1);
    assert!(app.session());
    assert_eq!(*attaches.lock().unwrap(), 2);
}

#[test]
fn an_attach_that_fails_says_why() {
    let linked = Linked {
        refuse: true,
        ..Linked::default()
    };
    let app = Abaigram::with_env(&declarations(), &none)
        .unwrap()
        .with_harness(Box::new(linked));
    assert!(!app.attach());
    assert_eq!(
        app.attach_error().as_deref(),
        Some("no model is configured")
    );
    assert!(!app.session());

    let unlinked = Abaigram::with_env(&declarations(), &none).unwrap();
    assert!(!unlinked.install());
    assert!(
        unlinked
            .attach_error()
            .unwrap()
            .contains("no harness is linked")
    );
}

#[test]
fn harness_off_makes_every_attach_fail_at_once() {
    let linked = Linked::default();
    let attaches = linked.attaches.clone();
    let off = |name: &str| (name == "ABAI_HARNESS").then(|| "off".to_string());
    let app = Abaigram::with_env(&declarations(), &off)
        .unwrap()
        .with_harness(Box::new(linked));
    assert!(!app.attach());
    assert!(!app.session());
    assert_eq!(*attaches.lock().unwrap(), 0);
    assert_eq!(
        app.attach_error().as_deref(),
        Some("ABAI_HARNESS=off: nothing attaches")
    );
}

#[test]
fn a_flag_left_up_with_no_harness_still_counts_what_it_defaults() {
    let app = Abaigram::with_env(&declarations(), &none).unwrap();
    // a harness that died without lowering its flag
    app.region()[header::ATTACHED].store(1, Ordering::SeqCst);
    assert_eq!(
        app.decision("on_limit").unwrap().ask(&()),
        Answer::Default(&json!("stop"))
    );
    assert!(!app.turn("each_lap").unwrap().give());
    let layout = &app.region().layout;
    assert_eq!(counter(&app, layout.decision_counter("on_limit")), 1);
    assert_eq!(counter(&app, layout.turn_counter("each_lap")), 1);
}

#[test]
fn a_touchpoint_serves_what_was_queued_for_a_safepoint_before_it_returns() {
    let linked = Linked::default();
    let answers = linked.answers.clone();
    let app = Abaigram::with_env(&declarations(), &none)
        .unwrap()
        .with_harness(Box::new(linked));
    assert!(app.attach());
    *answers.lock().unwrap() = vec![Outcome::Done];
    let target = Target::Capability {
        index: 0,
        immediate: false,
    };
    let ticket = calls::post(app.region(), target, br#"{"n": 4}"#).unwrap();
    assert!(app.turn("each_lap").unwrap().give());
    assert!(calls::poll(app.region(), &ticket).unwrap().is_ok());
}

#[test]
fn the_entry_hands_a_verb_its_own_arguments_and_checks_the_mode() {
    use abai_stub::entry::{EntryIo, run_entry_with};
    let linked = Linked::default();
    let entry_args = linked.entry_args.clone();
    let app = Abaigram::with_env(&declarations(), &none)
        .unwrap()
        .with_harness(Box::new(linked));
    let args = |words: &[&str]| words.iter().map(|w| w.to_string()).collect::<Vec<_>>();
    let run = |words: &[&str], mode: Option<&str>| {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let mode = mode.map(str::to_string);
        let env = move |name: &str| (name == "ABAI_MODE").then(|| mode.clone()).flatten();
        let mut io = EntryIo {
            out: &mut out,
            err: &mut err,
            env: &env,
            cwd: std::env::temp_dir(),
        };
        let code = run_entry_with(&app, &args(words), &mut io);
        (code, String::from_utf8(err).unwrap())
    };

    assert_eq!(
        run(&["abai", "config", "set", "model", "m"], None).0,
        Some(7)
    );
    assert_eq!(*entry_args.lock().unwrap(), args(&["set", "model", "m"]));
    assert_eq!(run(&["abai", "mcp"], None).0, Some(1));

    let (code, err) = run(&["abai", "config"], Some("thread"));
    assert_eq!(code, Some(2));
    assert!(err.contains("ABAI_MODE=thread is not a declared mode"));
    assert_eq!(run(&["abai", "session"], Some("sidecar")).0, Some(2));
    assert_eq!(run(&["abai", "install", "now"], None).0, Some(2));
}

#[test]
fn a_safepoint_runs_what_is_queued_and_nothing_else() {
    let app = Abaigram::with_env(&declarations(), &none).unwrap();
    app.safepoint();
    let target = Target::Capability {
        index: 0,
        immediate: false,
    };
    let ticket = calls::post(app.region(), target, br#"{"n": 21}"#).unwrap();
    assert_eq!(calls::poll(app.region(), &ticket), None);
    app.safepoint();
    let result = calls::poll(app.region(), &ticket).unwrap().unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&result).unwrap(),
        json!({"twice": 42})
    );
    assert_eq!(app.region()[header::SAFEPOINT].load(Ordering::SeqCst), 0);

    // an immediate call is not a safepoint's to run
    let now = Target::Capability {
        index: 0,
        immediate: true,
    };
    let ticket = calls::post(app.region(), now, br#"{"n": 1}"#).unwrap();
    app.safepoint();
    assert_eq!(calls::poll(app.region(), &ticket), None);
}

#[test]
fn a_declaration_with_no_handler_is_refused() {
    let declarations = Declarations::new("bare", [Mode::Sidecar])
        .stop_graceful("5s")
        .cell(Cell::string("label", "A label.").knob("x"))
        .capability(Capability::new("peek", "Look."));
    let error = Abaigram::with_env(&declarations, &none).unwrap_err();
    assert_eq!(
        error.violations,
        [
            "cells.label: a sized knob needs a handler (on_change)",
            "capabilities.peek: no handler is registered (handler)",
            "lifecycle.stop: no stop handler is registered (on_stop)",
        ]
    );

    let idle = Declarations::new("idle", [Mode::Turns])
        .cell(Cell::int("count", "A count.").on_change(|_| Ok(())))
        .on_stop(|| {});
    let error = Abaigram::with_env(&idle, &none).unwrap_err();
    assert_eq!(
        error.violations,
        [
            "cells.count: on_change is for sized knobs; this handler would never run",
            "lifecycle.stop: on_stop needs stop_graceful; this handler would never run",
        ]
    );
}

#[test]
fn doctor_asks_the_linked_harness_about_the_model_unless_offline() {
    use abai_stub::doctor::{CheckStatus, DoctorOptions, run_doctor};
    let app = Abaigram::with_env(&declarations(), &none)
        .unwrap()
        .with_harness(Box::new(Linked::default()));
    let cwd = std::env::temp_dir();
    let run = |online| {
        run_doctor(
            &app,
            &DoctorOptions {
                root: None,
                cwd: &cwd,
                env: &none,
                online,
            },
        )
    };
    let online = run(true);
    let model = online.checks.last().unwrap();
    assert_eq!(
        (model.name.as_str(), model.status),
        ("model", CheckStatus::Fail)
    );
    assert!(!online.ok);
    let offline = run(false);
    let last = offline.checks.last().unwrap();
    assert_eq!(
        (last.name.as_str(), last.status),
        ("online", CheckStatus::Skip)
    );

    let unlinked = Abaigram::with_env(&declarations(), &none).unwrap();
    let report = run_doctor(
        &unlinked,
        &DoctorOptions {
            root: None,
            cwd: &cwd,
            env: &none,
            online: true,
        },
    );
    assert_eq!(report.checks.last().unwrap().status, CheckStatus::Skip);
}
