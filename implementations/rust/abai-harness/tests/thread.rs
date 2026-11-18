//! Thread mode end to end: the harness on a thread of its own inside the
//! program, and an agent that is a script. No model.

mod common;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::ThreadId;
use std::time::{Duration, Instant};

use abai_harness::attention::WatchOp;
use abai_harness::core::{Code, Options, UserChannel};
use abai_harness::embedded::{Linked, RunEnd, Wake};
use abai_stub::app::{Abaigram, Answer, DecisionPoint};
use abai_stub::declare::{Capability, Cell, Decision, Declarations, Event, Turn};
use abai_stub::manifest::{Field, Mode, Schema};
use common::{Script, Scripted, User, audit_lines, reasons};
use serde_json::{Value, json};

#[derive(Default)]
struct Seen {
    /// The thread each handler ran on, by capability.
    handled: Mutex<Vec<(String, ThreadId)>>,
    /// A decision the `asks_back` handler asks, set once the app exists,
    /// and what it was answered.
    inner: OnceLock<DecisionPoint>,
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

fn fixture_with(label: &str, budget: Option<u32>) -> Fixture {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "abai-thread-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("abai")).unwrap();
    std::fs::write(dir.join("abai/identity.md"), "You are the agent.\n").unwrap();

    let seen = Arc::new(Seen::default());
    let handler = |seen: &Arc<Seen>, name: &'static str| {
        let seen = seen.clone();
        move |_: abai_stub::region::calls::Params<'_>| {
            seen.handled
                .lock()
                .unwrap()
                .push((name.to_string(), std::thread::current().id()));
            Ok(json!({"ok": true}))
        }
    };
    let asks_back = seen.clone();
    let mut declarations = Declarations::new("live", [Mode::Thread, Mode::Turns])
        .root(&dir)
        .audit_path("audit.jsonl")
        .cell(Cell::int("count", "A count.").cadence(100))
        .cell(Cell::int("step", "The step.").knob(1))
        .event(
            Event::new("alarm", "Something is wrong.")
                .payload(Schema::new().field("level", Field::int()))
                .wakes_always(),
        )
        .event(
            Event::new("backlog", "Work is piling up.")
                .payload(Schema::new().field("depth", Field::int()))
                .wakes_when("depth gt 100"),
        )
        .event(Event::new("tick", "One pass of the loop."))
        .capability(
            Capability::new("at_safepoint", "Runs at a safepoint.")
                .timeout("500ms")
                .handler(handler(&seen, "at_safepoint")),
        )
        .capability(
            Capability::new("at_once", "Runs as soon as it is called.")
                .immediate()
                .handler(handler(&seen, "at_once")),
        )
        .capability(
            Capability::new("asks_back", "A handler that asks a decision itself.")
                .immediate()
                .handler(move |_| {
                    let decision = asks_back.inner.get().ok_or("no decision")?;
                    let answer = decision.ask(&json!({})).as_str().to_string();
                    asks_back.inner_answers.lock().unwrap().push(answer);
                    Ok(())
                }),
        )
        .decision(Decision::options(
            "on_limit",
            ["wrap", "stop"],
            "stop",
            "5s",
            "At the limit.",
        ))
        .turn(Turn::new("each_lap", "5s", "After a lap."));
    if let Some(wakes) = budget {
        declarations = declarations.budget(Some(wakes), None);
    }

    let script = Script::default();
    let user = User::default();
    let (front_script, channel_user) = (script.clone(), user.clone());
    let linked = Linked {
        front: Box::new(move |_, _, _| Ok(Box::new(Scripted(front_script.clone())))),
        channel: Box::new(move || Some(Box::new(channel_user.clone()) as Box<dyn UserChannel>)),
        options: Options::default(),
        home: None,
        env: None,
    };
    let none = |_: &str| None;
    let app = Abaigram::with_env(&declarations, &none)
        .unwrap()
        .with_harness(Box::new(linked));
    let _ = seen.inner.set(app.decision("on_limit").unwrap());
    Fixture {
        app,
        script,
        user,
        seen,
        dir,
    }
}

fn fixture(label: &str) -> Fixture {
    fixture_with(label, None)
}

fn audit(fixture: &Fixture) -> Vec<String> {
    audit_lines(&fixture.dir.join("audit.jsonl"))
}

#[test]
fn an_event_declared_to_wake_wakes_the_agent_on_its_own_thread() {
    let f = fixture("events");
    assert!(f.app.attach());
    assert!(f.app.region().attached());
    let alarm = f.app.event("alarm").unwrap();
    let backlog = f.app.event("backlog").unwrap();
    let tick = f.app.event("tick").unwrap();

    tick.emit(|_| {});
    backlog.emit(|p| p.int("depth", 50));
    std::thread::sleep(Duration::from_millis(60));
    assert!(f.script.wakes().is_empty());

    alarm.emit(|p| p.int("level", 3));
    let wakes = f.script.wait_for(1);
    assert_eq!(reasons(&wakes[0]), [r#"event alarm {"level":3}"#]);

    // a condition wakes only when it holds
    backlog.emit(|p| p.int("depth", 150));
    let wakes = f.script.wait_for(2);
    assert_eq!(reasons(&wakes[1]), [r#"event backlog {"depth":150}"#]);

    // the agent ran on a thread that is not the program's
    let threads = f.script.threads.lock().unwrap().clone();
    assert!(threads.iter().all(|id| *id != std::thread::current().id()));
    assert_eq!(threads[0], threads[1]);
}

#[test]
fn a_decision_blocks_only_the_thread_that_asks_and_is_answered_live() {
    let f = fixture("decide");
    assert!(f.app.attach());
    f.script.then(|core, wake| {
        let Wake::Decision { id, .. } = wake else {
            panic!("a decision");
        };
        // every event is in the transcript, whether it wakes or not
        let lines = core.transcript.read(10, 0);
        assert!(
            lines.iter().any(|(_, line)| line.starts_with("event tick")),
            "{lines:?}"
        );
        core.decide(id, &json!("wrap"), "there is room").unwrap();
    });
    f.app.event("tick").unwrap().emit(|_| {});
    let on_limit = f.app.decision("on_limit").unwrap();
    assert_eq!(on_limit.ask(&json!({})), Answer::Agent(json!("wrap")));
    assert!(f.app.turn("each_lap").unwrap().give());
    assert_eq!(audit(&f), ["decision on_limit ok", "turn each_lap ok"]);
}

#[test]
fn a_capability_runs_where_its_dispatch_says() {
    let f = fixture("dispatch");
    assert!(f.app.attach());
    let program = std::thread::current().id();

    // inside a decision the asking thread is at a safepoint: a call for a
    // safepoint runs on it, and an immediate one on the harness thread
    f.script.then(|core, _| {
        core.call("at_safepoint", &Value::Null, "to see").unwrap();
        core.call("at_once", &Value::Null, "to see").unwrap();
    });
    f.app.decision("on_limit").unwrap().ask(&json!({}));
    let handled = f.seen.handled.lock().unwrap().clone();
    assert_eq!(handled[0], ("at_safepoint".to_string(), program));
    assert_eq!(handled[1].0, "at_once");
    assert_ne!(handled[1].1, program);

    // woken by an event, the agent's call waits for the program's own
    // safepoint; one that never comes is a timeout, and the call is discarded
    f.script.then(|core, _| {
        let error = core
            .call("at_safepoint", &Value::Null, "nobody will serve this")
            .unwrap_err();
        assert_eq!(error.code, Code::Timeout);
        assert!(error.message.contains("no safepoint"), "{}", error.message);
    });
    f.app.event("alarm").unwrap().emit(|p| p.int("level", 1));
    f.script.wait_for(2);
    f.app.safepoint();
    assert_eq!(f.seen.handled.lock().unwrap().len(), 2);

    // and one that does come serves it, on the program's thread
    f.script.then(|core, _| {
        core.call("at_safepoint", &Value::Null, "the loop will serve this")
            .unwrap();
    });
    f.app.event("alarm").unwrap().emit(|p| p.int("level", 2));
    let started = Instant::now();
    while f.script.wakes().len() < 3 {
        f.app.safepoint();
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(
        f.seen.handled.lock().unwrap()[2],
        ("at_safepoint".to_string(), program)
    );
}

#[test]
fn a_watch_and_a_timer_wake_the_agent() {
    let f = fixture("watch");
    assert!(f.app.attach());
    f.script.then(|core, _| {
        core.add_watch("count", WatchOp::Gt, json!(5), None)
            .unwrap();
        core.add_timer(0.15, "look again").unwrap();
        assert_eq!(core.status()["watches"][0]["cell"], "count");
    });
    assert!(f.app.turn("each_lap").unwrap().give());

    let count = f.app.cell::<i64>("count").unwrap();
    count.set(3);
    std::thread::sleep(Duration::from_millis(250));
    // the timer has fired by now; the watch has not: 3 is not above 5
    let wakes = f.script.wait_for(2);
    assert_eq!(reasons(&wakes[1]), ["timer: look again"]);

    count.set(9);
    let wakes = f.script.wait_for(3);
    assert_eq!(reasons(&wakes[2]), ["watch count gt 5: now 9"]);
    // it fires on the edge, not while the count stays above
    count.set(10);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(f.script.wakes().len(), 3);
}

#[test]
fn beyond_the_budget_wakes_are_held_a_turn_is_skipped_and_a_decision_still_wakes() {
    let f = fixture_with("budget", Some(2));
    assert!(f.app.attach());
    let alarm = f.app.event("alarm").unwrap();
    for level in 1..=2 {
        alarm.emit(|p| p.int("level", level));
        f.script.wait_for(level as usize);
    }
    // the budget of two wakes a minute is spent
    alarm.emit(|p| p.int("level", 3));
    alarm.emit(|p| p.int("level", 4));
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(f.script.wakes().len(), 2);
    assert!(!f.app.turn("each_lap").unwrap().give());
    assert_eq!(f.script.wakes().len(), 2);

    f.script.then(|core, wake| {
        let Wake::Decision { id, .. } = wake else {
            panic!("a decision");
        };
        // what was held is in the transcript all the same
        let lines = core.transcript.read(20, 0);
        assert!(lines.iter().any(|(_, l)| l.contains(r#"{"level":4}"#)));
        assert!(lines.iter().any(|(_, l)| l.starts_with("# attention:")));
        core.decide(id, &json!("wrap"), "still asked").unwrap();
    });
    assert_eq!(
        f.app.decision("on_limit").unwrap().ask(&json!({})),
        Answer::Agent(json!("wrap"))
    );
    // the decision was the third wake, beyond the budget of two
    let wakes = f.script.wakes();
    assert_eq!(wakes.len(), 3);
    assert!(matches!(wakes[2], Wake::Decision { .. }), "{:?}", wakes[2]);
    assert_eq!(
        audit(&f),
        ["turn each_lap default cause=budget", "decision on_limit ok"]
    );
}

#[test]
fn a_handler_on_the_harness_thread_that_reaches_a_touchpoint_does_not_wait_for_itself() {
    let f = fixture("asks-back");
    assert!(f.app.attach());
    f.script.then(|core, _| {
        core.call("asks_back", &Value::Null, "to see").unwrap();
    });
    let started = Instant::now();
    f.app.event("alarm").unwrap().emit(|p| p.int("level", 1));
    f.script.wait_for(1);
    // the inner decision did not wait out its five seconds
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(*f.seen.inner_answers.lock().unwrap(), ["stop"]);
    // nobody audited it, so it was counted
    let word = f.app.region().layout.decision_counter("on_limit").unwrap();
    assert_eq!(f.app.region()[word].load(Ordering::Relaxed), 1);
    assert_eq!(audit(&f), ["call asks_back ok"]);
}

#[test]
fn a_harness_that_fails_leaves_the_program_running_as_itself() {
    let f = fixture("panic");
    assert!(f.app.attach());
    f.script.then(|_, _| panic!("a bug in the harness"));
    f.app.event("alarm").unwrap().emit(|p| p.int("level", 1));
    let started = Instant::now();
    while f.app.region().attached() {
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(5));
    }
    // the program goes on: its channels cost what they cost detached
    f.app.cell::<i64>("count").unwrap().set(1);
    let on_limit = f.app.decision("on_limit").unwrap();
    assert_eq!(on_limit.ask(&json!({})), Answer::Default(&json!("stop")));
    let word = f.app.region().layout.decision_counter("on_limit").unwrap();
    assert_eq!(f.app.region()[word].load(Ordering::Relaxed), 1);
}

#[test]
fn a_model_that_goes_away_detaches_and_a_new_attach_starts_again() {
    let f = fixture("gone");
    assert!(f.app.attach());
    f.script
        .then_end(|_, _| RunEnd::Unreachable("the model went away".to_string()));
    assert!(!f.app.turn("each_lap").unwrap().give());
    assert!(!f.app.region().attached());
    assert!(f.user.said.lock().unwrap()[0].contains("the model went away"));

    assert!(f.app.attach());
    assert!(f.app.turn("each_lap").unwrap().give());
    assert_eq!(
        audit(&f),
        ["turn each_lap default cause=detached", "turn each_lap ok"]
    );
}

#[test]
fn a_session_stays_open_while_the_program_goes_on_and_is_served() {
    let f = fixture("session");
    let app = f.app.clone();
    let session = std::thread::spawn(move || app.session());

    // the session's own attach is under way: wait for the greeting
    let started = Instant::now();
    while f.user.said.lock().unwrap().is_empty() {
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(5));
    }
    f.user.lines.lock().unwrap().push("hello".to_string());

    // with the session open, the program's decisions and events are served
    f.script.then(|core, wake| {
        let Wake::Decision { id, .. } = wake else {
            panic!("a decision");
        };
        core.decide(id, &json!("wrap"), "asked mid-session")
            .unwrap();
    });
    assert_eq!(
        f.app.decision("on_limit").unwrap().ask(&json!({})),
        Answer::Agent(json!("wrap"))
    );
    f.app.event("alarm").unwrap().emit(|p| p.int("level", 7));
    f.script.wait_for(2);

    f.user.lines.lock().unwrap().push("/quit".to_string());
    assert!(session.join().unwrap());
    let said = f.user.said.lock().unwrap().clone();
    assert_eq!(said, ["a session", "you said hello"]);
    assert_eq!(audit(&f), ["decision on_limit ok", "touchpoint session ok"]);
    // the harness stays after the session
    assert!(f.app.region().attached());
}

#[test]
fn a_second_session_is_refused_while_one_is_open() {
    let f = fixture("two-sessions");
    let app = f.app.clone();
    let session = std::thread::spawn(move || app.session());
    let started = Instant::now();
    while f.user.said.lock().unwrap().is_empty() {
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(5));
    }

    assert!(!f.app.session());
    // the first one is still open, and ends as usual
    f.user.lines.lock().unwrap().push("/quit".to_string());
    assert!(session.join().unwrap());
    assert_eq!(
        audit(&f),
        [
            "touchpoint session failed cause=a session is open already",
            "touchpoint session ok"
        ]
    );
}

#[test]
fn there_are_no_watches_in_turns_mode() {
    let f = fixture("turns");
    // the same program, run in turns mode
    let turns = |name: &str| (name == "ABAI_MODE").then(|| "turns".to_string());
    let script = f.script.clone();
    let linked = Linked {
        front: Box::new(move |_, _, _| Ok(Box::new(Scripted(script.clone())))),
        channel: Box::new(|| None),
        options: Options::default(),
        home: None,
        env: None,
    };
    let declarations = Declarations::new("quiet", [Mode::Thread, Mode::Turns])
        .root(&f.dir)
        .audit_path("quiet.jsonl")
        .cell(Cell::int("count", "A count."))
        .turn(Turn::new("each_lap", "5s", "After a lap."));
    let app = Abaigram::with_env(&declarations, &turns)
        .unwrap()
        .with_harness(Box::new(linked));
    assert!(app.attach());
    f.script.then(|core, _| {
        let refused = core
            .add_watch("count", WatchOp::Changed, Value::Null, None)
            .unwrap_err();
        assert_eq!(refused.code, Code::Invalid);
        assert_eq!(core.add_timer(1.0, "x").unwrap_err().code, Code::Invalid);
    });
    assert!(app.turn("each_lap").unwrap().give());
}
