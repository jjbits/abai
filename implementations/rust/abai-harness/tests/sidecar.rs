//! Sidecar mode with both halves in one test process: the program's stub
//! with its socket and its mapped region, and the harness's sidecar code
//! on a thread, connected through the socket like another process would
//! be. The agent is a script. No model.
#![cfg(unix)]

mod common;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use abai_harness::core::{Code, Launcher, Options, Program, Signal, UserChannel};
use abai_harness::embedded::{Linked, RunEnd, Wake};
use abai_harness::sidecar::{Ended, Then, serve};
use abai_stub::app::{Abaigram, Answer};
use abai_stub::declare::{Capability, Cell, Decision, Declarations, Event, Turn};
use abai_stub::manifest::{Field, Mode, Pause, Schema};
use abai_stub::sidecar::descriptors;
use common::{Script, Scripted, User, audit_lines, reasons};
use serde_json::{Value, json};

#[derive(Default)]
struct Seen {
    /// The name of the thread each handler ran on, by capability.
    handled: Mutex<Vec<(String, String)>>,
    /// How often the stop handler ran.
    stops: AtomicU32,
}

/// A launcher whose program is this test: it says the program runs, and
/// keeps the signals it is asked to send.
#[derive(Default, Clone)]
struct FakeLauncher {
    signals: Arc<Mutex<Vec<Signal>>>,
}

impl Launcher for FakeLauncher {
    fn running(&self) -> bool {
        true
    }

    fn state(&self) -> Value {
        json!({"running": true, "pid": 1, "starts": 1})
    }

    fn signal(&mut self, signal: Signal) -> Result<(), String> {
        self.signals.lock().unwrap().push(signal);
        Ok(())
    }

    fn wait_exit(&mut self, _limit: Duration) -> bool {
        // the program of these tests is the test: it "exits" at once
        true
    }

    fn start(&mut self) -> Result<Arc<dyn Program>, String> {
        Err("this launcher starts nothing".to_string())
    }
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

type Running = JoinHandle<Result<Ended, String>>;

fn wait_until(what: &str, done: impl Fn() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < Duration::from_secs(5), "{what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

impl Fixture {
    fn linked(&self, with_user: bool) -> Linked {
        let (script, user) = (self.script.clone(), self.user.clone());
        Linked {
            front: Box::new(move |_, _, _| Ok(Box::new(Scripted(script.clone())))),
            channel: Box::new(move || {
                with_user.then(|| Box::new(user.clone()) as Box<dyn UserChannel>)
            }),
            options: Options::default(),
            home: None,
            env: None,
        }
    }

    /// Start a harness against the program's socket, as another process
    /// would, without waiting for it.
    fn start(&self, then: Then) -> Running {
        let socket = self.app.sidecar_socket().unwrap().to_path_buf();
        let linked = self.linked(true);
        std::thread::spawn(move || serve(&socket, &linked, then))
    }

    /// Start a harness and wait until it is attached.
    fn harness(&self) -> Running {
        let running = self.start(Then::Serve);
        let started = Instant::now();
        while !self.app.attached() {
            if running.is_finished() {
                panic!("the harness ended instead: {:?}", running.join().unwrap());
            }
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "the harness attaches"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        running
    }

    fn audit(&self) -> Vec<String> {
        audit_lines(&self.dir.join("audit.jsonl"))
    }

    fn run_dir(&self) -> PathBuf {
        self.dir.join("h/run-rust")
    }
}

fn fixture(label: &str) -> Fixture {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    // short: a socket's path has a small limit
    let dir = std::env::temp_dir().join(format!(
        "abai-sc-{}-{}",
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
            let thread = std::thread::current().name().unwrap_or("").to_string();
            seen.handled
                .lock()
                .unwrap()
                .push((name.to_string(), thread));
            Ok(json!({"ok": true}))
        }
    };
    let on_stop = seen.clone();
    let declarations = Declarations::new(label, [Mode::Sidecar])
        .root(&dir)
        .audit_path("audit.jsonl")
        .pause(Pause::Cooperative)
        .stop_graceful("1s")
        .on_stop(move || {
            on_stop.stops.fetch_add(1, Ordering::SeqCst);
        })
        .cell(Cell::int("count", "A count."))
        .cell(Cell::int("step", "The step.").knob(1))
        .cell(Cell::string("label", "A label."))
        .event(
            Event::new("alarm", "Something is wrong.")
                .payload(Schema::new().field("level", Field::int()))
                .wakes_always(),
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
        .decision(Decision::options(
            "on_limit",
            ["wrap", "stop"],
            "stop",
            "5s",
            "At the limit.",
        ))
        .turn(Turn::new("each_lap", "5s", "After a lap."))
        .turn(Turn::new("short", "200ms", "A turn with little time."));

    let home = dir.join("h").display().to_string();
    let env = move |name: &str| (name == "ABAI_HOME").then(|| home.clone());
    let app = Abaigram::with_env(&declarations, &env).unwrap();
    assert_eq!(app.sidecar_error(), None);
    Fixture {
        app,
        script: Script::default(),
        user: User::default(),
        seen,
        dir,
    }
}

#[test]
fn the_program_lists_itself_and_takes_its_files_with_it() {
    let f = fixture("listed");
    let run_dir = f.run_dir();
    let listed = descriptors(&run_dir);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "listed");
    assert_eq!(listed[0].pid, std::process::id());
    assert_eq!(Some(listed[0].socket.as_path()), f.app.sidecar_socket());
    assert!(listed[0].region.exists());
    // with no harness the program is the plain program
    assert!(!f.app.attached());
    assert!(!f.app.turn("each_lap").unwrap().give());

    // a second program on the machine is listed beside it, and takes
    // its files with it when it goes
    let home = f.dir.join("h").display().to_string();
    let env = move |name: &str| (name == "ABAI_HOME").then(|| home.clone());
    let other = Abaigram::with_env(
        &Declarations::new("other", [Mode::Sidecar]).root(&f.dir),
        &env,
    )
    .unwrap();
    let names: Vec<String> = descriptors(&run_dir).into_iter().map(|d| d.name).collect();
    assert_eq!(names.len(), 2);
    assert!(names.contains(&"other".to_string()));
    let socket = other.sidecar_socket().unwrap().to_path_buf();
    assert!(socket.exists());
    drop(other);
    assert!(!socket.exists());
    assert!(!socket.with_extension("region").exists());
    assert!(!socket.with_extension("json").exists());
    assert_eq!(descriptors(&run_dir).len(), 1);
}

#[test]
fn a_harness_reads_the_region_and_answers_across_the_socket() {
    let f = fixture("serve");
    f.app.cell::<i64>("count").unwrap().set(4);
    f.app.text_cell("label").unwrap().set("before the attach");
    let _harness = f.harness();
    f.app.event("tick").unwrap().emit(|_| {});

    f.script.then(|core, wake| {
        let Wake::Decision { id, context, .. } = wake else {
            panic!("a decision");
        };
        assert_eq!(context, &json!({"count": 4}));
        // what the program wrote before the attach is in the region
        let cells = core.cells(None).unwrap();
        assert_eq!(cells["count"], 4);
        assert_eq!(cells["label"], "before the attach");
        let lines = core.transcript.read(10, 0);
        assert!(
            lines.iter().any(|(_, line)| line.starts_with("event tick")),
            "{lines:?}"
        );
        core.set("step", &json!(5), "bigger steps").unwrap();
        core.decide(id, &json!("wrap"), "there is room").unwrap();
    });
    let on_limit = f.app.decision("on_limit").unwrap();
    assert_eq!(
        on_limit.ask(&json!({"count": 4})),
        Answer::Agent(json!("wrap"))
    );
    // the knob the agent wrote is the program's next read
    assert_eq!(f.app.knob::<i64>("step").unwrap().get(), 5);
    assert!(f.app.turn("each_lap").unwrap().give());
    assert_eq!(
        f.audit(),
        ["knob step ok", "decision on_limit ok", "turn each_lap ok"]
    );
}

#[test]
fn an_event_wakes_the_harness_through_the_wake_connection() {
    let f = fixture("wake");
    let _harness = f.harness();
    let wakes_before = f.app.region()[abai_stub::region::header::WAKES].load(Ordering::SeqCst);
    // A harness that is not woken still looks around every 250 ms, so one
    // quick wake proves little. Six in a row, sent at different points of
    // that cycle, each seen well inside it, do: without the wake
    // connection all six would be quick about once in 250 runs.
    let alarm = f.app.event("alarm").unwrap();
    for round in 1..=6usize {
        std::thread::sleep(Duration::from_millis(40 + 37 * round as u64));
        let started = Instant::now();
        alarm.emit(|p| p.int("level", round as i64));
        let wakes = f.script.wait_for(round);
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "wake {round} took {:?}",
            started.elapsed()
        );
        assert_eq!(
            reasons(&wakes[round - 1]),
            [format!(r#"event alarm {{"level":{round}}}"#)]
        );
    }
    let wakes_after = f.app.region()[abai_stub::region::header::WAKES].load(Ordering::SeqCst);
    assert!(wakes_after >= wakes_before + 6);
}

#[test]
fn a_capability_runs_where_its_dispatch_says() {
    let f = fixture("dispatch");
    let _harness = f.harness();
    f.script.then(|core, _| {
        core.call("at_safepoint", &Value::Null, "to see").unwrap();
        // the reply wakes the harness; it is not found by a poll every
        // 20 ms. The quickest of a few calls says so, whatever the load.
        let quickest = (0..5)
            .map(|_| {
                let started = Instant::now();
                core.call("at_once", &Value::Null, "to see").unwrap();
                started.elapsed()
            })
            .min()
            .unwrap();
        assert!(quickest < Duration::from_millis(10), "{quickest:?}");
    });
    let program = std::thread::current().name().unwrap_or("").to_string();
    f.app.decision("on_limit").unwrap().ask(&json!({}));
    let handled = f.seen.handled.lock().unwrap().clone();
    // inside the decision the asking thread is at a safepoint
    assert_eq!(handled[0], ("at_safepoint".to_string(), program));
    // an immediate call runs on the stub's receiving thread
    assert_eq!(handled.len(), 6);
    assert_eq!(
        handled[1],
        ("at_once".to_string(), "abai-receive".to_string())
    );

    // with no program thread at a safepoint the call is discarded in time
    f.script.then(|core, _| {
        let error = core
            .call("at_safepoint", &Value::Null, "nobody will serve this")
            .unwrap_err();
        assert_eq!(error.code, Code::Timeout);
    });
    f.app.event("alarm").unwrap().emit(|p| p.int("level", 1));
    f.script.wait_for(2);
    f.app.safepoint();
    assert_eq!(f.seen.handled.lock().unwrap().len(), 6);
}

#[test]
fn a_connection_that_says_nothing_does_not_keep_a_harness_out() {
    let f = fixture("stray");
    let socket = f.app.sidecar_socket().unwrap().to_path_buf();
    // it connects first, and is silent for as long as the test runs
    let _silent = std::os::unix::net::UnixStream::connect(&socket).unwrap();
    let started = Instant::now();
    let _harness = f.harness();
    // the stub gave the silent one a moment and no more
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(f.app.turn("each_lap").unwrap().give());

    // one that connects and stays silent while a harness is attached
    // does not stop the attached harness being served
    let _later = std::os::unix::net::UnixStream::connect(&socket).unwrap();
    assert!(f.app.turn("each_lap").unwrap().give());
}

#[test]
fn a_turn_the_program_stopped_waiting_for_is_not_recorded_as_had() {
    let f = fixture("late");
    let _harness = f.harness();
    f.script
        .then(|_, _| std::thread::sleep(Duration::from_millis(1500)));
    let started = Instant::now();
    // the turn has 200 ms; the program waits a little longer, then goes on
    assert!(!f.app.turn("short").unwrap().give());
    assert!(started.elapsed() < Duration::from_millis(1300));
    f.script.wait_for(1);
    wait_until("the turn is on the record", || !f.audit().is_empty());
    assert_eq!(f.audit(), ["turn short timeout"]);
}

#[test]
fn a_harness_that_goes_leaves_the_program_running_and_another_can_attach() {
    let f = fixture("gone");
    let first = f.harness();

    // a second harness is refused while the first is attached
    let refused = f.start(Then::Serve).join().unwrap().unwrap_err();
    assert!(
        refused.contains("a harness is attached already"),
        "{refused}"
    );

    f.script
        .then_end(|_, _| RunEnd::Unreachable("the model went away".to_string()));
    assert!(!f.app.turn("each_lap").unwrap().give());
    let ended = first.join().unwrap().unwrap();
    assert_eq!(ended.reason, "the model went away");
    wait_until("the program sees it go", || !f.app.attached());
    assert!(!f.app.region().attached());

    // the program is the plain program again
    let on_limit = f.app.decision("on_limit").unwrap();
    assert_eq!(on_limit.ask(&json!({})), Answer::Default(&json!("stop")));

    // and a harness that connects later is taken
    let _second = f.harness();
    assert!(f.app.turn("each_lap").unwrap().give());
    assert_eq!(
        f.audit(),
        [
            "turn each_lap default cause=detached",
            "counter on_limit default cause=no_harness",
            "turn each_lap ok"
        ]
    );
}

#[test]
fn a_harness_that_fails_lowers_the_flag() {
    let f = fixture("panic");
    let harness = f.harness();
    f.script.then(|_, _| panic!("a bug in the harness"));
    f.app.event("alarm").unwrap().emit(|p| p.int("level", 1));
    let ended = harness.join().unwrap().unwrap();
    assert_eq!(ended.reason, "the harness failed");
    wait_until("the program sees it go", || !f.app.attached());
    assert!(!f.app.turn("each_lap").unwrap().give());
}

#[test]
fn a_session_started_from_outside_ends_the_harness_when_the_user_leaves() {
    let f = fixture("session");
    let harness = f.start(Then::Session);
    wait_until("the greeting", || !f.user.said.lock().unwrap().is_empty());
    wait_until("the program knows it is attached", || f.app.attached());
    f.user.lines.lock().unwrap().push("hello".to_string());

    // the program is served while the session is open
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

    f.user.lines.lock().unwrap().push("/quit".to_string());
    let ended = harness.join().unwrap().unwrap();
    assert_eq!(ended.reason, "the session ended");
    assert_eq!(
        *f.user.said.lock().unwrap(),
        ["a session", "you said hello"]
    );
    wait_until("the program sees it go", || !f.app.attached());
    assert_eq!(f.audit(), ["decision on_limit ok", "touchpoint session ok"]);
}

#[test]
fn a_session_the_program_opens_is_held_on_the_harness_side() {
    let f = fixture("opened");
    let _harness = f.harness();
    let app = f.app.clone();
    // an attached harness is used as it is: nothing is started
    let session = std::thread::spawn(move || app.session());
    wait_until("the greeting", || !f.user.said.lock().unwrap().is_empty());
    f.user.lines.lock().unwrap().push("/quit".to_string());
    assert!(session.join().unwrap());
    // the harness stays after the session
    assert!(f.app.attached());
    assert_eq!(f.audit(), ["touchpoint session ok"]);
}

#[test]
fn what_listens_but_is_no_program_is_an_error_that_says_so() {
    let f = fixture("nobody");
    let nowhere = f.dir.join("nobody.sock");
    let error = serve(&nowhere, &f.linked(false), Then::Serve).unwrap_err();
    assert!(error.contains("no program is listening"), "{error}");
}

#[test]
fn a_harness_with_no_model_tells_the_program_why_it_did_not_attach() {
    let f = fixture("unconfigured");
    let socket = f.app.sidecar_socket().unwrap().to_path_buf();
    let linked = Linked {
        front: Box::new(|_, _, _| Err("no model is configured".to_string())),
        channel: Box::new(|| None),
        options: Options::default(),
        home: None,
        env: None,
    };
    let error = serve(&socket, &linked, Then::Serve).unwrap_err();
    assert_eq!(error, "no model is configured");
    assert!(!f.app.attached());
    // and the program takes the next harness
    let _harness = f.harness();
    assert!(f.app.turn("each_lap").unwrap().give());
}

#[test]
fn a_cooperative_pause_holds_safepoints_and_touchpoints_until_the_resume() {
    let f = fixture("pause");
    let _harness = f.harness();
    f.script.then(|core, _| {
        core.set_launcher(Box::new(FakeLauncher::default()));
        assert_eq!(
            core.lifecycle("status", "to see").unwrap()["paused"],
            Value::Null
        );
        core.lifecycle("pause", "to look around").unwrap();
        assert_eq!(
            core.lifecycle("pause", "again").unwrap_err().code,
            Code::Invalid
        );
        assert_eq!(
            core.lifecycle("status", "to see").unwrap()["paused"],
            "cooperative"
        );
    });
    assert!(f.app.turn("each_lap").unwrap().give());

    // a program thread that reaches a safepoint stays there
    let app = f.app.clone();
    let held = std::thread::spawn(move || {
        let started = Instant::now();
        app.safepoint();
        started.elapsed()
    });
    std::thread::sleep(Duration::from_millis(150));
    assert!(!held.is_finished());

    // a touchpoint reached during the pause is held too, and the agent
    // is told what its pause is holding
    f.script.then(|core, wake| {
        assert_eq!(
            reasons(wake),
            [r#"event abai.pause.blocked {"touchpoint":"turn each_lap"}"#]
        );
        // a call for a safepoint is still served by the thread held there
        core.call("at_safepoint", &Value::Null, "the pause holds it at one")
            .unwrap();
        core.lifecycle("resume", "seen enough").unwrap();
    });
    assert!(f.app.turn("each_lap").unwrap().give());
    assert!(held.join().unwrap() >= Duration::from_millis(150));
    f.app.safepoint();
    assert_eq!(
        f.audit(),
        [
            "lifecycle pause ok",
            "lifecycle pause failed",
            "turn each_lap ok",
            "call at_safepoint ok",
            "lifecycle resume ok",
            "turn each_lap ok"
        ]
    );
}

#[test]
fn a_pause_ends_with_the_harness_that_asked_for_it() {
    let f = fixture("pause-gone");
    let harness = f.harness();
    f.script.then_end(|core, _| {
        core.set_launcher(Box::new(FakeLauncher::default()));
        core.lifecycle("pause", "and then I go").unwrap();
        RunEnd::Unreachable("the model went away".to_string())
    });
    f.app.event("alarm").unwrap().emit(|p| p.int("level", 1));
    f.script.wait_for(1);
    // the agent is gone: the program is not left held at a safepoint
    wait_until("the flag goes down", || !f.app.region().attached());
    let app = f.app.clone();
    let passed = std::thread::spawn(move || app.safepoint());
    wait_until("the safepoint lets the program through", || {
        passed.is_finished()
    });
    drop(harness);
}

#[test]
fn an_attached_harness_can_ask_for_a_graceful_stop_and_nothing_more() {
    let f = fixture("stop");
    let _harness = f.harness();
    f.script.then(|core, wake| {
        let Wake::Decision { id, .. } = wake else {
            panic!("a decision");
        };
        let status = core.lifecycle("status", "to see").unwrap();
        assert_eq!(status["launch"], Value::Null);
        for op in ["pause", "resume", "start", "restart"] {
            let refused = core.lifecycle(op, "to try").unwrap_err();
            assert_eq!(refused.code, Code::Invalid, "{op}");
            assert!(refused.message.contains("only a harness that launched"));
        }
        assert_eq!(
            core.lifecycle("nap", "to try").unwrap_err().code,
            Code::Invalid
        );
        // the thread asking the decision is at a safepoint: the stop
        // handler runs on it
        let stopped = core.lifecycle("stop", "the work is done").unwrap();
        assert_eq!(
            stopped["result"],
            "the stop handler ran; the program is expected to exit"
        );
        core.decide(id, &json!("wrap"), "and the answer").unwrap();
    });
    assert_eq!(
        f.app.decision("on_limit").unwrap().ask(&json!({})),
        Answer::Agent(json!("wrap"))
    );
    assert_eq!(f.seen.stops.load(Ordering::SeqCst), 1);
    // stop is a confirm act by default: the user was asked, and said yes
    assert_eq!(f.audit(), ["lifecycle stop ok", "decision on_limit ok"]);

    // with no program thread at a safepoint the stop is not served, and
    // the harness says the program did not stop
    f.script.then(|core, _| {
        let error = core.lifecycle("stop", "again").unwrap_err();
        assert_eq!(error.code, Code::Timeout);
        assert!(error.message.contains("the program did not stop"));
    });
    f.app.event("alarm").unwrap().emit(|p| p.int("level", 1));
    f.script.wait_for(2);
    f.app.safepoint();
    assert_eq!(f.seen.stops.load(Ordering::SeqCst), 1);
}

#[test]
fn a_stop_during_a_pause_runs_the_handler_and_lets_the_program_go() {
    let f = fixture("pause-stop");
    let _harness = f.harness();
    f.script.then(|core, _| {
        core.set_launcher(Box::new(FakeLauncher::default()));
        core.lifecycle("pause", "to look around").unwrap();
    });
    assert!(f.app.turn("each_lap").unwrap().give());
    let app = f.app.clone();
    let held = std::thread::spawn(move || app.safepoint());
    std::thread::sleep(Duration::from_millis(50));
    assert!(!held.is_finished());

    // the stop handler runs on the thread the pause holds, and the pause
    // is lifted so the program can end
    f.script.then(|core, _| {
        let stopped = core.lifecycle("stop", "done here").unwrap();
        assert_eq!(
            stopped["result"],
            "the stop handler ran; the program exited"
        );
        assert_eq!(
            core.lifecycle("status", "to see").unwrap()["paused"],
            Value::Null
        );
    });
    f.app.event("alarm").unwrap().emit(|p| p.int("level", 1));
    f.script.wait_for(2);
    wait_until("the held thread goes on", || held.is_finished());
    assert_eq!(f.seen.stops.load(Ordering::SeqCst), 1);
}

#[test]
fn a_launcher_whose_agent_is_lost_lets_the_program_go_and_stays() {
    let f = fixture("lost");
    let first = f.harness();
    f.script.then(|core, _| {
        core.set_launcher(Box::new(FakeLauncher::default()));
        core.lifecycle("pause", "and then the model goes").unwrap();
    });
    assert!(f.app.turn("each_lap").unwrap().give());

    // the model goes away while a program thread is at a touchpoint, and
    // another has just reached one
    f.script.then_end(|_, _| {
        std::thread::sleep(Duration::from_millis(100));
        RunEnd::Unreachable("the model went away".to_string())
    });
    f.app.event("alarm").unwrap().emit(|p| p.int("level", 1));
    std::thread::sleep(Duration::from_millis(30));
    let started = Instant::now();
    // held by the pause, then let go when the harness lets the program go:
    // not left waiting for its five seconds
    assert!(!f.app.turn("each_lap").unwrap().give());
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    wait_until("the program is let go", || !f.app.attached());
    // the pause went with the agent
    f.app.safepoint();

    // and the program can take another harness
    drop(first);
    let _second = f.harness();
    f.script.then(|_, _| {});
    assert!(f.app.turn("each_lap").unwrap().give());
}
