//! Turns mode end to end: a program, the linked harness, and an agent
//! that is a script. No model.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use abai_harness::core::{Code, Core, Options, UserChannel};
use abai_harness::embedded::{Front, Linked, RunEnd, Wake};
use abai_stub::app::{Abaigram, Answer};
use abai_stub::declare::{Capability, Cell, Decision, Declarations, Event, Turn};
use abai_stub::manifest::{Field, Mode, Policy, Schema};
use abai_stub::region::header;
use serde_json::{Value, json};

/// One step of the scripted agent: what it does with the core when woken.
type Step = Box<dyn FnOnce(&mut Core, &Wake) -> RunEnd + Send>;

#[derive(Default, Clone)]
struct Script {
    steps: Arc<Mutex<Vec<Step>>>,
    wakes: Arc<Mutex<Vec<Wake>>>,
}

impl Script {
    fn then(&self, step: impl FnOnce(&mut Core, &Wake) + Send + 'static) {
        self.steps.lock().unwrap().push(Box::new(move |core, wake| {
            step(core, wake);
            RunEnd::Done
        }));
    }

    /// A step that also says how the run ended.
    fn then_end(&self, step: impl FnOnce(&mut Core, &Wake) -> RunEnd + Send + 'static) {
        self.steps.lock().unwrap().push(Box::new(step));
    }

    fn then_unreachable(&self) {
        self.steps.lock().unwrap().push(Box::new(|_, _| {
            RunEnd::Unreachable("the model did not answer".to_string())
        }));
    }
}

struct Scripted(Script);

impl Front for Scripted {
    fn run(&mut self, core: &mut Core, wake: &Wake, _deadline: Option<Instant>) -> RunEnd {
        self.0.wakes.lock().unwrap().push(wake.clone());
        let step = self.0.steps.lock().unwrap().remove(0);
        step(core, wake)
    }

    fn user_line(&mut self, core: &mut Core, line: &str) -> RunEnd {
        if let Some(channel) = core.channel() {
            channel.say(&format!("you said {line}"));
        }
        RunEnd::Done
    }

    fn greeting(&self, _core: &Core) -> String {
        "a session".to_string()
    }
}

/// A user who answers confirms from a list and is recorded.
#[derive(Default, Clone)]
struct User {
    lines: Arc<Mutex<Vec<String>>>,
    confirms: Arc<Mutex<Vec<bool>>>,
    asked: Arc<Mutex<Vec<String>>>,
    said: Arc<Mutex<Vec<String>>>,
}

impl UserChannel for User {
    fn say(&mut self, text: &str) {
        self.said.lock().unwrap().push(text.to_string());
    }

    fn ask(&mut self, _prompt: &str) -> Option<String> {
        let mut lines = self.lines.lock().unwrap();
        (!lines.is_empty()).then(|| lines.remove(0))
    }

    fn confirm(&mut self, question: &str, _timeout: Duration) -> bool {
        self.asked.lock().unwrap().push(question.to_string());
        self.confirms.lock().unwrap().remove(0)
    }
}

/// What the program's handlers saw.
#[derive(Default)]
struct Seen {
    count: AtomicI64,
    resets: AtomicU32,
    labels: Mutex<Vec<String>>,
    /// A decision a handler asks from inside a capability call, and what
    /// it was answered.
    inner_decision: std::sync::OnceLock<abai_stub::app::DecisionPoint>,
    inner_answers: Mutex<Vec<String>>,
}

struct Fixture {
    app: Abaigram,
    script: Script,
    user: User,
    seen: Arc<Seen>,
    dir: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn declarations(root: &Path, seen: &Arc<Seen>) -> Declarations {
    let (on_reset, on_label, on_peek) = (seen.clone(), seen.clone(), seen.clone());
    let on_nested = seen.clone();
    Declarations::new("turns", [Mode::Turns])
        .root(root)
        .audit_path("audit.jsonl")
        .confirm_timeout("2s")
        .cell(Cell::int("count", "How far the count has got."))
        .cell(
            Cell::int("step", "How much a tick adds.")
                .knob(1)
                .range_int(1, 100),
        )
        .cell(
            Cell::int("limit", "Where the count stops.")
                .knob(1000)
                .confirm(),
        )
        .cell(
            Cell::string("label", "The word beside the count.")
                .knob("count")
                .max(16)
                .on_change(move |value| {
                    let label: String = value.get()?;
                    if label == "refuse" {
                        return Err("the program will not be called that".to_string());
                    }
                    on_label.labels.lock().unwrap().push(label);
                    Ok(())
                }),
        )
        .event(
            Event::new("milestone", "The count passed a hundred.")
                .payload(Schema::new().field("count", Field::int()))
                .wakes_always(),
        )
        .capability(
            Capability::new("reset", "Set the count back.")
                .params(Schema::new().field("to", Field::int()))
                .result(Schema::new().field("was", Field::int()))
                .mutate()
                .handler(move |params| {
                    let to = params.get::<Value>()?["to"]
                        .as_i64()
                        .ok_or("to is not a number")?;
                    on_reset.resets.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({"was": on_reset.count.swap(to, Ordering::SeqCst)}))
                }),
        )
        .capability(
            Capability::new("peek", "The count, at once.")
                .result(Schema::new().field("count", Field::int()))
                .immediate()
                .handler(move |_| Ok(json!({"count": on_peek.count.load(Ordering::SeqCst)}))),
        )
        .capability(
            Capability::new("wipe", "Forget everything.")
                .mutate()
                .policy(Policy::Forbid)
                .handler(|_| Ok(())),
        )
        .capability(
            Capability::new("nested", "A handler that asks a decision itself.").handler(
                move |_| {
                    let decision = on_nested.inner_decision.get().ok_or("no decision")?;
                    let answer = decision.ask(&json!({"count": 7})).as_str().to_string();
                    on_nested.inner_answers.lock().unwrap().push(answer);
                    Ok(())
                },
            ),
        )
        .capability(
            Capability::new("fail", "A capability that fails.")
                .handler(|_| Err::<(), _>("the program could not".to_string())),
        )
        .decision(
            Decision::options("on_limit", ["wrap", "stop"], "stop", "5s", "At the limit.")
                .context(Schema::new().field("count", Field::int())),
        )
        .decision(
            Decision::options(
                "careful",
                ["yes", "no"],
                "no",
                "5s",
                "Asked with the user's eye on it.",
            )
            .policy(Policy::Confirm),
        )
        .decision(
            Decision::options("never", ["a", "b"], "a", "5s", "The agent is not asked.")
                .policy(Policy::Forbid),
        )
        .decision(Decision::answer(
            "plan",
            Schema::new()
                .field("steps", Field::int())
                .field("note", Field::string()),
            json!({"steps": 0}),
            "5s",
            "A plan for the next lap.",
        ))
        .turn(Turn::new("each_lap", "30s", "After a lap."))
}

fn fixture_with(label: &str, options: Options, with_user: bool) -> Fixture {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "abai-turns-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("abai/turns")).unwrap();
    std::fs::write(
        dir.join("abai/identity.md"),
        "You are the agent of turns.\n",
    )
    .unwrap();
    std::fs::write(dir.join("abai/install.md"), "Set the program up.\n").unwrap();

    let seen = Arc::new(Seen::default());
    let script = Script::default();
    let user = User::default();
    let (front_script, channel_user) = (script.clone(), user.clone());
    let linked = Linked {
        front: Box::new(move |_, _, _| Ok(Box::new(Scripted(front_script.clone())))),
        channel: Box::new(move || {
            with_user.then(|| Box::new(channel_user.clone()) as Box<dyn UserChannel>)
        }),
        options,
        home: None,
        env: None,
    };
    let none = |_: &str| None;
    let app = Abaigram::with_env(&declarations(&dir, &seen), &none)
        .unwrap()
        .with_harness(Box::new(linked));
    let _ = seen.inner_decision.set(app.decision("on_limit").unwrap());
    Fixture {
        app,
        script,
        user,
        seen,
        dir,
    }
}

fn fixture(label: &str) -> Fixture {
    fixture_with(label, Options::default(), true)
}

fn audit(fixture: &Fixture) -> Vec<Value> {
    std::fs::read_to_string(fixture.dir.join("audit.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

/// The fields of an audit line that a test compares.
fn brief(line: &Value) -> String {
    let mut text = format!("{} {} {}", line["act"], line["name"], line["outcome"]);
    for key in ["source", "cause", "value", "consent", "count"] {
        if let Some(value) = line.get(key) {
            text.push_str(&format!(" {key}={value}"));
        }
    }
    text.replace('"', "")
}

fn briefs(fixture: &Fixture) -> Vec<String> {
    audit(fixture).iter().map(brief).collect()
}

#[test]
fn an_attach_writes_what_was_counted_while_nothing_was_attached() {
    let f = fixture("counters");
    let on_limit = f.app.decision("on_limit").unwrap();
    let lap = f.app.turn("each_lap").unwrap();
    on_limit.ask(&json!({"count": 1}));
    on_limit.ask(&json!({"count": 2}));
    lap.give();
    assert!(briefs(&f).is_empty());

    assert!(f.app.attach());
    assert!(f.app.region().attached());
    assert_eq!(
        briefs(&f),
        [
            "counter on_limit default cause=no_harness count=2",
            "counter each_lap default cause=no_harness count=1",
        ]
    );
    // the counters start again
    let word = f.app.region().layout.decision_counter("on_limit").unwrap();
    assert_eq!(f.app.region()[word].load(Ordering::Relaxed), 0);
}

#[test]
fn in_a_turn_the_agent_reads_cells_sets_a_knob_and_calls_a_capability() {
    let f = fixture("turn");
    let count = f.app.cell::<i64>("count").unwrap();
    let step = f.app.knob::<i64>("step").unwrap();
    count.set(41);
    f.seen.count.store(41, Ordering::SeqCst);
    assert!(f.app.attach());
    *f.user.confirms.lock().unwrap() = vec![true];

    f.script.then(|core, wake| {
        assert_eq!(
            wake,
            &Wake::Turn {
                name: "each_lap".to_string()
            }
        );
        let cells = core.cells(None).unwrap();
        assert_eq!(cells["count"], 41);
        assert_eq!(cells["step"], 1);
        assert_eq!(cells["label"], "count");
        assert_eq!(
            core.cells(Some(&["step".to_string()])).unwrap(),
            json!({"step": 1})
        );

        core.set("step", &json!(5), "the count is slow").unwrap();
        // an immediate capability and a safepoint one both run inside the touchpoint
        assert_eq!(
            core.call("peek", &Value::Null, "to see").unwrap(),
            json!({"count": 41})
        );
        let was = core.call("reset", &json!({"to": 0}), "start over").unwrap();
        assert_eq!(was, json!({"was": 41}));
    });
    assert!(f.app.turn("each_lap").unwrap().give());

    assert_eq!(step.get(), 5);
    assert_eq!(f.seen.count.load(Ordering::SeqCst), 0);
    assert_eq!(
        *f.user.asked.lock().unwrap(),
        [r#"Call reset with {"to":0}? Reason: start over"#]
    );
    assert_eq!(
        briefs(&f),
        [
            "knob step ok value=5",
            "call peek ok",
            "call reset ok consent=approved",
            "turn each_lap ok",
        ]
    );
    let lines = audit(&f);
    assert_eq!(lines[0]["reason"], "the count is slow");
    assert_eq!(lines[2]["params"], json!({"to": 0}));
    assert!(lines[2]["ms"].is_u64());
}

#[test]
fn a_confirm_act_needs_the_users_yes() {
    let f = fixture("confirm");
    assert!(f.app.attach());
    *f.user.confirms.lock().unwrap() = vec![false, false, true];
    f.script.then(|core, _| {
        let refused = core
            .call("reset", &json!({"to": 0}), "start over")
            .unwrap_err();
        assert_eq!(refused.code, Code::Denied);
        assert_eq!(
            core.set("limit", &json!(10), "sooner").unwrap_err().code,
            Code::Denied
        );
        core.set("limit", &json!(20), "sooner").unwrap();
    });
    f.app.turn("each_lap").unwrap().give();
    assert_eq!(f.seen.resets.load(Ordering::SeqCst), 0);
    assert_eq!(f.app.knob::<i64>("limit").unwrap().get(), 20);
    assert_eq!(
        briefs(&f)[..3],
        [
            "call reset denied consent=denied",
            "knob limit denied value=10 consent=denied",
            "knob limit ok value=20 consent=approved",
        ]
    );
}

#[test]
fn with_no_user_a_confirm_act_is_denied_and_auto_stands_for_consent() {
    let alone = fixture_with("alone", Options::default(), false);
    assert!(alone.app.attach());
    alone.script.then(|core, _| {
        assert_eq!(
            core.call("reset", &json!({"to": 0}), "why")
                .unwrap_err()
                .code,
            Code::Denied
        );
        // an auto act needs nobody
        core.set("step", &json!(2), "why").unwrap();
    });
    alone.app.turn("each_lap").unwrap().give();
    assert_eq!(alone.seen.resets.load(Ordering::SeqCst), 0);

    let auto = Options {
        auto: true,
        ..Options::default()
    };
    let trusted = fixture_with("auto", auto, false);
    assert!(trusted.app.attach());
    trusted.script.then(|core, _| {
        core.call("reset", &json!({"to": 0}), "why").unwrap();
    });
    trusted.app.turn("each_lap").unwrap().give();
    assert_eq!(trusted.seen.resets.load(Ordering::SeqCst), 1);
    assert_eq!(briefs(&trusted)[0], "call reset ok consent=auto");
}

#[test]
fn policy_and_the_declarations_bound_what_the_agent_may_do() {
    let deny = Options {
        deny_mutate: true,
        ..Options::default()
    };
    let f = fixture_with("bounds", deny, true);
    assert!(f.app.attach());
    f.script.then(|core, _| {
        let code = |result: Result<Value, abai_harness::core::ActError>| result.unwrap_err().code;
        assert_eq!(
            code(core.call("wipe", &Value::Null, "why")),
            Code::Forbidden
        );
        assert_eq!(
            code(core.call("reset", &json!({"to": 0}), "why")),
            Code::Denied
        );
        assert_eq!(
            code(core.call("nothing", &Value::Null, "why")),
            Code::Unknown
        );
        assert_eq!(
            code(core.call("peek", &json!({"x": 1}), "why")),
            Code::Invalid
        );
        assert_eq!(code(core.call("peek", &json!([1]), "why")), Code::Invalid);
        assert_eq!(code(core.call("peek", &Value::Null, " ")), Code::Invalid);
        let failed = core.call("fail", &Value::Null, "why").unwrap_err();
        assert_eq!(
            (failed.code, failed.message.as_str()),
            (Code::Error, "the program could not")
        );

        assert_eq!(code(core.set("step", &json!(101), "why")), Code::Invalid);
        assert_eq!(code(core.set("step", &json!("fast"), "why")), Code::Invalid);
        assert_eq!(code(core.set("count", &json!(1), "why")), Code::Invalid);
        assert_eq!(code(core.set("nothing", &json!(1), "why")), Code::Unknown);
        assert_eq!(code(core.set("step", &json!(2), "")), Code::Invalid);
        assert_eq!(
            code(core.cells(Some(&["nothing".to_string()]))),
            Code::Unknown
        );
    });
    f.app.turn("each_lap").unwrap().give();
    assert_eq!(f.app.knob::<i64>("step").unwrap().get(), 1);
    // what policy stopped and what the program failed is on the record;
    // what was never a valid act is not
    assert_eq!(
        briefs(&f),
        [
            "call wipe forbidden",
            "call reset denied",
            "call fail failed",
            "turn each_lap ok",
        ]
    );
}

#[test]
fn a_sized_knob_is_delivered_to_the_programs_handler() {
    let f = fixture("sized");
    assert!(f.app.attach());
    f.script.then(|core, _| {
        core.set("label", &json!("tally"), "a better word").unwrap();
        assert_eq!(core.cells(None).unwrap()["label"], "tally");
        let refused = core.set("label", &json!("refuse"), "to see").unwrap_err();
        assert_eq!(
            (refused.code, refused.message.as_str()),
            (Code::Error, "the program will not be called that")
        );
        let long = core
            .set("label", &json!("seventeen letters"), "too long")
            .unwrap_err();
        assert_eq!(long.code, Code::Invalid);
        // the mirror keeps the last value that landed
        assert_eq!(core.cells(None).unwrap()["label"], "tally");
    });
    f.app.turn("each_lap").unwrap().give();
    assert_eq!(*f.seen.labels.lock().unwrap(), ["tally"]);
    assert_eq!(
        briefs(&f)[..2],
        [
            "knob label ok value=tally",
            "knob label failed value=refuse"
        ]
    );
}

#[test]
fn a_decision_is_the_agents_answer_or_the_default_with_its_cause() {
    let f = fixture("decide");
    assert!(f.app.attach());
    let on_limit = f.app.decision("on_limit").unwrap();

    f.script.then(|core, wake| {
        let Wake::Decision { id, name, context } = wake else {
            panic!("a decision");
        };
        assert_eq!(
            (name.as_str(), context),
            ("on_limit", &json!({"count": 1000}))
        );
        assert_eq!(core.status()["decisions"][0]["id"], id.as_str());
        assert_eq!(
            core.decide(id, &json!("sideways"), "why").unwrap_err().code,
            Code::Invalid
        );
        assert_eq!(
            core.decide("d99", &json!("wrap"), "why").unwrap_err().code,
            Code::Unknown
        );
        assert_eq!(
            core.decide(id, &json!("wrap"), "").unwrap_err().code,
            Code::Invalid
        );
        core.decide(id, &json!("wrap"), "there is room").unwrap();
    });
    assert_eq!(
        on_limit.ask(&json!({"count": 1000})),
        Answer::Agent(json!("wrap"))
    );

    // the agent ends its step without answering
    f.script.then(|_, _| {});
    assert_eq!(
        on_limit.ask(&json!({"count": 2000})),
        Answer::Default(&json!("stop"))
    );

    // policy forbid: the agent is not woken
    assert_eq!(f.app.decision("never").unwrap().ask(&()).as_str(), "a");
    assert_eq!(f.script.wakes.lock().unwrap().len(), 2);

    // policy confirm: the user's no leaves the default
    *f.user.confirms.lock().unwrap() = vec![false, true];
    for _ in 0..2 {
        f.script.then(|core, wake| {
            let Wake::Decision { id, .. } = wake else {
                panic!("a decision");
            };
            core.decide(id, &json!("yes"), "it is safe").unwrap();
        });
    }
    let careful = f.app.decision("careful").unwrap();
    assert_eq!(careful.ask(&()), Answer::Default(&json!("no")));
    assert_eq!(careful.ask(&()), Answer::Agent(json!("yes")));

    // an answer by schema
    f.script.then(|core, wake| {
        let Wake::Decision { id, .. } = wake else {
            panic!("a decision");
        };
        let bad = core
            .decide(id, &json!({"steps": "many"}), "why")
            .unwrap_err();
        assert_eq!(bad.code, Code::Invalid);
        core.decide(id, &json!({"steps": 3}), "three will do")
            .unwrap();
    });
    assert_eq!(
        f.app.decision("plan").unwrap().ask(&()),
        Answer::Agent(json!({"steps": 3}))
    );

    assert_eq!(
        briefs(&f),
        [
            "decision on_limit ok source=agent value=wrap",
            "decision on_limit default source=default cause=answered value=stop",
            "decision never default source=default cause=forbidden value=a",
            "decision careful default source=default cause=denied value=no consent=denied",
            "decision careful ok source=agent value=yes consent=approved",
            "decision plan ok source=agent value={steps:3}",
        ]
    );
    assert_eq!(audit(&f)[0]["reason"], "there is room");
    assert_eq!(
        audit(&f)[1]["reason"],
        "the agent's turn ended without deciding"
    );
}

#[test]
fn events_emitted_while_attached_are_read_at_the_next_touchpoint() {
    let f = fixture("events");
    let milestone = f.app.event("milestone").unwrap();
    milestone.emit(|p| p.int("count", 100));
    assert!(f.app.attach());
    milestone.emit(|p| p.int("count", 200));
    milestone.emit(|p| p.int("count", 300));
    f.script.then(|core, _| {
        let lines = core.transcript.read(10, 0);
        let texts: Vec<&str> = lines.iter().map(|(_, text)| *text).collect();
        assert_eq!(
            texts,
            [
                r#"event milestone {"count":200}"#,
                r#"event milestone {"count":300}"#
            ]
        );
    });
    assert!(f.app.turn("each_lap").unwrap().give());
}

#[test]
fn install_and_session_run_to_their_end() {
    let f = fixture("install");
    f.script.then(|core, wake| {
        assert_eq!(wake, &Wake::Install);
        assert_eq!(
            core.content.install.as_deref(),
            Some("Set the program up.\n")
        );
        assert_eq!(core.content.identity, "You are the agent of turns.\n");
    });
    // install attaches by itself
    assert!(f.app.install());
    *f.user.lines.lock().unwrap() = vec!["hello".to_string()];
    assert!(f.app.session());
    assert_eq!(
        *f.user.said.lock().unwrap(),
        ["a session", "you said hello"]
    );
    assert_eq!(
        briefs(&f),
        ["touchpoint install ok", "touchpoint session ok"]
    );
}

#[test]
fn a_model_that_cannot_be_reached_detaches_the_harness() {
    let f = fixture("unreachable");
    assert!(f.app.attach());
    let on_limit = f.app.decision("on_limit").unwrap();
    f.script.then_unreachable();
    assert_eq!(
        on_limit.ask(&json!({"count": 1})),
        Answer::Default(&json!("stop"))
    );
    assert!(!f.app.region().attached());
    assert_eq!(
        briefs(&f),
        ["decision on_limit default source=default cause=detached value=stop"]
    );

    // from here on the program is the plain program
    assert_eq!(
        on_limit.ask(&json!({"count": 2})),
        Answer::Default(&json!("stop"))
    );
    let word = f.app.region().layout.decision_counter("on_limit").unwrap();
    assert_eq!(f.app.region()[word].load(Ordering::Relaxed), 1);
    assert_eq!(f.app.region()[header::ATTACHED].load(Ordering::SeqCst), 0);
}

#[test]
fn an_attach_fails_at_once_when_the_front_cannot_be_made() {
    let dir = std::env::temp_dir().join(format!("abai-turns-nofront-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("abai")).unwrap();
    std::fs::write(dir.join("abai/identity.md"), "You are.\n").unwrap();
    let seen = Arc::new(Seen::default());
    let linked = Linked {
        front: Box::new(|_, _, _| Err("no model is configured".to_string())),
        channel: Box::new(|| None),
        options: Options::default(),
        home: None,
        env: None,
    };
    let none = |_: &str| None;
    let app = Abaigram::with_env(&declarations(&dir, &seen), &none)
        .unwrap()
        .with_harness(Box::new(linked));
    assert!(!app.attach());
    assert_eq!(
        app.attach_error().as_deref(),
        Some("no model is configured")
    );
    assert!(!app.region().attached());
    assert!(!dir.join("audit.jsonl").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_answer_on_file_does_not_apply_when_the_harness_detaches() {
    let f = fixture("answered-then-gone");
    assert!(f.app.attach());
    f.script.then_end(|core, wake| {
        let Wake::Decision { id, .. } = wake else {
            panic!("a decision");
        };
        core.decide(id, &json!("wrap"), "there is room").unwrap();
        RunEnd::Unreachable("the model went away".to_string())
    });
    let on_limit = f.app.decision("on_limit").unwrap();
    assert_eq!(
        on_limit.ask(&json!({"count": 1})),
        Answer::Default(&json!("stop"))
    );
    assert_eq!(
        briefs(&f),
        ["decision on_limit default source=default cause=detached value=stop"]
    );
    // nobody was asked to confirm anything on the way out
    assert!(f.user.asked.lock().unwrap().is_empty());
}

#[test]
fn a_turn_that_loses_its_model_is_on_the_record_as_detached() {
    let f = fixture("turn-gone");
    assert!(f.app.attach());
    f.script.then_unreachable();
    assert!(!f.app.turn("each_lap").unwrap().give());
    assert!(!f.app.region().attached());
    assert_eq!(briefs(&f), ["turn each_lap default cause=detached"]);
}

#[test]
fn a_confirm_decision_with_nobody_to_ask_is_its_default_at_once() {
    let f = fixture_with("confirm-alone", Options::default(), false);
    assert!(f.app.attach());
    assert_eq!(
        f.app.decision("careful").unwrap().ask(&()),
        Answer::Default(&json!("no"))
    );
    // the agent was not woken for an answer that could not apply
    assert!(f.script.wakes.lock().unwrap().is_empty());
    assert_eq!(
        briefs(&f),
        ["decision careful default source=default cause=denied value=no consent=denied"]
    );
}

#[test]
fn an_agent_that_offers_only_invalid_answers_leaves_the_cause_invalid() {
    let f = fixture("invalid");
    assert!(f.app.attach());
    f.script.then(|core, wake| {
        let Wake::Decision { id, .. } = wake else {
            panic!("a decision");
        };
        assert!(core.decide(id, &json!("sideways"), "why").is_err());
    });
    assert_eq!(
        f.app
            .decision("on_limit")
            .unwrap()
            .ask(&json!({"count": 1})),
        Answer::Default(&json!("stop"))
    );
    assert_eq!(
        briefs(&f),
        ["decision on_limit default source=default cause=invalid value=stop"]
    );
}

#[test]
fn a_handler_that_reaches_a_touchpoint_gets_the_default_and_no_deadlock() {
    let f = fixture("nested");
    assert!(f.app.attach());
    f.script.then(|core, _| {
        core.call("nested", &Value::Null, "to see").unwrap();
    });
    assert!(f.app.turn("each_lap").unwrap().give());
    assert_eq!(*f.seen.inner_answers.lock().unwrap(), ["stop"]);
    // nobody audited the inner decision, so it was counted
    let word = f.app.region().layout.decision_counter("on_limit").unwrap();
    assert_eq!(f.app.region()[word].load(Ordering::Relaxed), 1);
    assert_eq!(briefs(&f), ["call nested ok", "turn each_lap ok"]);
}

#[test]
fn a_front_that_panics_detaches_the_harness() {
    let f = fixture("panic");
    assert!(f.app.attach());
    f.script.then(|_, _| panic!("a bug in the harness"));
    let on_limit = f.app.decision("on_limit").unwrap();
    assert_eq!(
        on_limit.ask(&json!({"count": 1})),
        Answer::Default(&json!("stop"))
    );
    assert!(!f.app.region().attached());
    assert_eq!(
        briefs(&f),
        ["decision on_limit default source=default cause=detached value=stop"]
    );
    // and a new attach starts a new harness
    f.script.then(|_, _| {});
    assert!(f.app.attach());
    assert!(f.app.turn("each_lap").unwrap().give());
}

#[test]
fn counts_are_kept_when_the_audit_log_cannot_be_written() {
    let f = fixture("no-audit");
    // the audit path is a directory, so the log cannot be opened
    std::fs::create_dir_all(f.dir.join("audit.jsonl")).unwrap();
    let on_limit = f.app.decision("on_limit").unwrap();
    on_limit.ask(&json!({"count": 1}));
    on_limit.ask(&json!({"count": 2}));
    assert!(f.app.attach());
    let word = f.app.region().layout.decision_counter("on_limit").unwrap();
    assert_eq!(f.app.region()[word].load(Ordering::Relaxed), 2);
    f.script.then(|core, _| {
        let lines = core.transcript.read(10, 0);
        assert!(lines[0].1.starts_with("# audit: "), "{lines:?}");
        assert!(lines[0].1.ends_with("acts are not being recorded"));
        assert!(core.status()["audit"]["failed"].is_string());
        // the act still happens
        core.set("step", &json!(3), "why").unwrap();
    });
    assert!(f.app.turn("each_lap").unwrap().give());
    assert_eq!(f.app.knob::<i64>("step").unwrap().get(), 3);
}

#[test]
fn a_run_that_fell_back_to_the_default_mode_is_on_the_record() {
    let f = {
        let mut f = fixture("fallback");
        // the same program, started with a mode it does not declare
        let seen = Arc::new(Seen::default());
        let script = f.script.clone();
        let linked = Linked {
            front: Box::new(move |_, _, _| Ok(Box::new(Scripted(script.clone())))),
            channel: Box::new(|| None),
            options: Options::default(),
            home: None,
            env: None,
        };
        let sidecar = |name: &str| (name == "ABAI_MODE").then(|| "sidecar".to_string());
        f.app = Abaigram::with_env(&declarations(&f.dir, &seen), &sidecar)
            .unwrap()
            .with_harness(Box::new(linked));
        f
    };
    assert!(f.app.attach());
    assert_eq!(
        briefs(&f),
        ["counter fallback default cause=undeclared_mode count=1"]
    );
}
