//! The agent end to end: a program in turns mode, the linked harness, the
//! agent loop, and a model provider that is a local server with scripted
//! answers.

use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use abai_harness::agent::{Agent, anthropic_reply};
use abai_harness::core::{Options, UserChannel};
use abai_harness::embedded::Linked;
use abai_harness::model::Timing;
use abai_harness::model::anthropic::Anthropic;
use abai_harness::model::fake::{Answer, FakeProvider};
use abai_stub::app::{Abaigram, Answer as Decided};
use abai_stub::declare::{Capability, Cell, Decision, Declarations, Turn};
use abai_stub::manifest::{Field, Mode, Schema};
use serde_json::{Value, json};

/// A user whose lines and answers are given, and whose screen is kept.
#[derive(Default, Clone)]
struct User {
    lines: Arc<Mutex<Vec<String>>>,
    confirms: Arc<Mutex<Vec<bool>>>,
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

    fn confirm(&mut self, _question: &str, _timeout: Duration) -> bool {
        self.confirms.lock().unwrap().remove(0)
    }
}

struct Fixture {
    app: Abaigram,
    provider: FakeProvider,
    user: User,
    count: Arc<AtomicI64>,
    dir: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn timing() -> Timing {
    Timing {
        connect: Duration::from_secs(2),
        total: Duration::from_secs(5),
        retry: Duration::from_millis(5),
    }
}

fn fixture_at(label: &str, answers: Vec<Answer>, url: Option<String>) -> Fixture {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "abai-agent-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("abai/turns")).unwrap();
    std::fs::write(
        dir.join("abai/identity.md"),
        "You are the agent of the counter.\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("abai/turns/each_lap.md"),
        "Keep the step sensible.\n",
    )
    .unwrap();

    let count = Arc::new(AtomicI64::new(41));
    let on_reset = count.clone();
    let declarations = Declarations::new("counter", [Mode::Turns])
        .root(&dir)
        .audit_path("audit.jsonl")
        .cell(Cell::int("count", "How far the count has got."))
        .cell(
            Cell::int("step", "How much a tick adds.")
                .knob(1)
                .range_int(1, 100),
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
                    Ok(json!({"was": on_reset.swap(to, Ordering::SeqCst)}))
                }),
        )
        .decision(
            Decision::options("on_limit", ["wrap", "stop"], "stop", "5s", "At the limit.")
                .context(Schema::new().field("count", Field::int())),
        )
        .decision(Decision::options(
            "quick",
            ["a", "b"],
            "a",
            "600ms",
            "A decision with little time.",
        ))
        .turn(Turn::new("each_lap", "30s", "After a lap."));

    let provider = FakeProvider::start(answers);
    let base = url.unwrap_or_else(|| provider.url.clone());
    let user = User::default();
    let channel_user = user.clone();
    let linked = Linked {
        front: Box::new(move |manifest, content, mode| {
            let model = Anthropic::new(&base, "sk-test", "claude-haiku-5-5", timing(), false);
            Ok(Box::new(Agent::new(
                Box::new(model),
                manifest,
                content,
                mode,
            )))
        }),
        channel: Box::new(move || Some(Box::new(channel_user.clone()) as Box<dyn UserChannel>)),
        options: Options::default(),
        home: None,
        env: None,
    };
    let none = |_: &str| None;
    let app = Abaigram::with_env(&declarations, &none)
        .unwrap()
        .with_harness(Box::new(linked));
    app.cell::<i64>("count").unwrap().set(41);
    Fixture {
        app,
        provider,
        user,
        count,
        dir,
    }
}

fn fixture(label: &str, answers: Vec<Answer>) -> Fixture {
    fixture_at(label, answers, None)
}

fn say(text: &str) -> Answer {
    Answer::ok(anthropic_reply(text, &[], "end_turn"))
}

fn tool(id: &str, name: &str, input: Value) -> Answer {
    Answer::ok(anthropic_reply("", &[(id, name, input)], "tool_use"))
}

fn audit(fixture: &Fixture) -> Vec<String> {
    std::fs::read_to_string(fixture.dir.join("audit.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| {
            let line: Value = serde_json::from_str(line).unwrap();
            format!("{} {} {}", line["act"], line["name"], line["outcome"]).replace('"', "")
        })
        .collect()
}

/// The text of the blocks of a request's last message.
fn last_message(request: &Value) -> String {
    let messages = request["messages"].as_array().unwrap();
    messages.last().unwrap()["content"]
        .as_array()
        .unwrap()
        .iter()
        .map(|block| {
            block
                .get("text")
                .or_else(|| block.get("content"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn in_a_turn_the_agent_reads_acts_and_says_what_it_did() {
    let f = fixture(
        "turn",
        vec![
            tool("t1", "abai_cells", json!({})),
            tool(
                "t2",
                "abai_set",
                json!({"cell": "step", "value": 5, "reason": "41 after a lap is slow"}),
            ),
            say("I raised the step to 5."),
        ],
    );
    assert!(f.app.attach());
    assert!(f.app.turn("each_lap").unwrap().give());

    assert_eq!(f.app.knob::<i64>("step").unwrap().get(), 5);
    assert_eq!(*f.user.said.lock().unwrap(), ["I raised the step to 5."]);
    assert_eq!(audit(&f), ["knob step ok", "turn each_lap ok"]);

    let sent = f.provider.requests();
    assert_eq!(sent.len(), 3);
    let first = &sent[0].body;
    let system = first["system"].as_str().unwrap();
    assert!(system.starts_with("You are the agent of the counter."));
    assert!(
        system.contains("in turns mode") && system.contains("- step (int, from 1 to 100, knob")
    );
    let tools: Vec<&str> = first["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        tools,
        [
            "abai_status",
            "abai_transcript",
            "abai_cells",
            "abai_set",
            "abai_call",
            "abai_decide",
            "abai_audit"
        ]
    );
    let wake = last_message(first);
    assert!(
        wake.starts_with("[abai wake] The program gives you the turn each_lap. After a lap."),
        "{wake}"
    );
    // the turn's own content slot rides with the wake
    assert!(wake.contains("Keep the step sensible."));

    // each tool's result went back to the model
    let cells: Value = serde_json::from_str(&last_message(&sent[1].body)).unwrap();
    assert_eq!(cells, json!({"count": 41, "step": 1}));
    assert_eq!(last_message(&sent[2].body), r#"{"name":"step","value":5}"#);
    // and the conversation grew by a call and a result each time
    assert_eq!(sent[2].body["messages"].as_array().unwrap().len(), 5);
}

#[test]
fn a_decision_is_answered_through_the_tool_and_a_confirm_is_put_to_the_user() {
    let f = fixture("decide", vec![]);
    assert!(f.app.attach());
    let on_limit = f.app.decision("on_limit").unwrap();

    f.provider.then(vec![
        tool(
            "t1",
            "abai_decide",
            json!({"id": "d1", "answer": "wrap", "reason": "there is room"}),
        ),
        say("Wrapping."),
    ]);
    assert_eq!(
        on_limit.ask(&json!({"count": 1000})),
        Decided::Agent(json!("wrap"))
    );
    let wake = last_message(&f.provider.requests()[0].body);
    assert!(
        wake.contains("asks the decision on_limit (id d1)"),
        "{wake}"
    );
    assert!(wake.contains(r#"Context: {"count":1000}"#) && wake.contains("Options: wrap, stop"));

    // a model that talks and does not decide leaves the default
    f.provider.then(vec![say("I would rather not say.")]);
    assert_eq!(
        on_limit.ask(&json!({"count": 2000})),
        Decided::Default(&json!("stop"))
    );

    // a mutating capability is the user's to allow
    *f.user.confirms.lock().unwrap() = vec![false, true];
    f.provider.then(vec![
        tool(
            "t2",
            "abai_call",
            json!({"capability": "reset", "params": {"to": 0}, "reason": "start over"}),
        ),
        tool(
            "t3",
            "abai_call",
            json!({"capability": "reset", "params": {"to": 0}, "reason": "start over, please"}),
        ),
        say("Reset."),
    ]);
    assert!(f.app.turn("each_lap").unwrap().give());
    assert_eq!(f.count.load(Ordering::SeqCst), 0);
    let denied = last_message(&f.provider.requests()[4].body);
    assert_eq!(denied, "denied: the user did not consent");
    assert_eq!(
        f.provider.requests()[4].body["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["content"][0]["is_error"],
        true
    );

    assert_eq!(
        audit(&f),
        [
            "decision on_limit ok",
            "decision on_limit default",
            "call reset denied",
            "call reset ok",
            "turn each_lap ok",
        ]
    );
}

#[test]
fn a_model_that_cannot_be_reached_at_first_contact_detaches_the_harness() {
    let closed = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let f = fixture_at("closed", vec![], Some(format!("http://{closed}")));
    assert!(f.app.attach());
    let on_limit = f.app.decision("on_limit").unwrap();
    assert_eq!(
        on_limit.ask(&json!({"count": 1})),
        Decided::Default(&json!("stop"))
    );
    assert!(!f.app.region().attached());
    assert_eq!(audit(&f), ["decision on_limit default"]);
    assert!(!f.app.turn("each_lap").unwrap().give());
}

#[test]
fn a_provider_that_refuses_the_key_at_first_contact_detaches_too() {
    let f = fixture(
        "badkey",
        vec![Answer::status(
            401,
            json!({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}),
        )],
    );
    assert!(f.app.attach());
    assert!(!f.app.turn("each_lap").unwrap().give());
    assert!(!f.app.region().attached());
}

#[test]
fn a_failure_after_the_model_has_answered_ends_that_step_alone() {
    let busy = || {
        Answer::status(
            529,
            json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
        )
    };
    let f = fixture(
        "later",
        vec![
            say("All is well."),
            busy(),
            busy(),
            busy(),
            say("Back again."),
        ],
    );
    assert!(f.app.attach());
    let lap = f.app.turn("each_lap").unwrap();
    assert!(lap.give());
    // the second turn's requests all fail: the turn ends, the harness stays
    assert!(lap.give());
    assert!(f.app.region().attached());
    assert!(lap.give());
    let said = f.user.said.lock().unwrap().clone();
    assert_eq!(said[0], "All is well.");
    assert!(said[1].contains("busy (529)"), "{said:?}");
    assert_eq!(said[2], "Back again.");
    assert_eq!(
        audit(&f),
        ["turn each_lap ok", "turn each_lap ok", "turn each_lap ok"]
    );
}

#[test]
fn a_request_declined_mid_step_takes_the_whole_step_back() {
    let refusal = Answer::ok(json!({"content": [], "stop_reason": "refusal"}));
    let f = fixture(
        "refusal",
        vec![
            tool("t1", "abai_cells", json!({})),
            refusal,
            say("Nothing to do."),
        ],
    );
    assert!(f.app.attach());
    let lap = f.app.turn("each_lap").unwrap();
    assert!(lap.give());
    assert_eq!(
        *f.user.said.lock().unwrap(),
        ["(the model's provider declined this request)"]
    );
    // the next step starts from a conversation with nothing dangling in it
    assert!(lap.give());
    let sent = f.provider.requests();
    assert_eq!(sent[2].body["messages"].as_array().unwrap().len(), 1);
    assert_eq!(f.user.said.lock().unwrap()[1], "Nothing to do.");
}

#[test]
fn a_reply_cut_at_the_output_limit_runs_no_tool() {
    let cut = Answer::ok(anthropic_reply(
        "Let me set",
        &[(
            "t1",
            "abai_set",
            json!({"cell": "step", "value": 9, "reason": "faster"}),
        )],
        "max_tokens",
    ));
    let f = fixture("cut", vec![cut, say("Nothing to do.")]);
    assert!(f.app.attach());
    assert!(f.app.turn("each_lap").unwrap().give());
    // the call was whole and valid, and still did not run
    assert_eq!(f.app.knob::<i64>("step").unwrap().get(), 1);
    let sent = f.provider.requests();
    let after_cut = sent[1].body["messages"].as_array().unwrap();
    assert_eq!(
        after_cut[1],
        json!({"role": "assistant", "content": [{"type": "text", "text": "Let me set"}]})
    );
    assert!(last_message(&sent[1].body).starts_with("Your last reply reached the output limit"));
    assert_eq!(audit(&f), ["turn each_lap ok"]);
}

#[test]
fn a_slow_model_does_not_hold_the_program_past_the_decisions_timeout() {
    let f = fixture(
        "slow",
        vec![say("Ready."), say("too late"), say("Here again.")],
    );
    assert!(f.app.attach());
    let lap = f.app.turn("each_lap").unwrap();
    assert!(lap.give());

    f.provider.set_delay(Duration::from_secs(3));
    let started = std::time::Instant::now();
    let quick = f.app.decision("quick").unwrap();
    assert_eq!(quick.ask(&()), Decided::Default(&json!("a")));
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "{:?}",
        started.elapsed()
    );
    // a model that is slow once is not a model that is gone
    assert!(f.app.region().attached());
    assert_eq!(audit(&f), ["turn each_lap ok", "decision quick default"]);

    // the step that ran out of time left nothing behind in the conversation
    f.provider.set_delay(Duration::ZERO);
    std::thread::sleep(Duration::from_millis(100));
    assert!(lap.give());
    let sent = f.provider.requests();
    assert_eq!(
        sent.last().unwrap().body["messages"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn a_request_the_provider_will_not_take_drops_old_history_and_goes_on() {
    let too_long = Answer::status(
        400,
        json!({"type": "error", "error": {"type": "invalid_request_error", "message": "prompt is too long"}}),
    );
    let f = fixture(
        "toolong",
        vec![
            say("One."),
            say("Two."),
            say("Three."),
            say("Four."),
            too_long,
            say("Five."),
        ],
    );
    assert!(f.app.attach());
    let lap = f.app.turn("each_lap").unwrap();
    for _ in 0..6 {
        assert!(lap.give());
    }
    assert!(f.app.region().attached());
    let sent = f.provider.requests();
    // four steps of two messages, then the fifth's wake: nine
    assert_eq!(sent[4].body["messages"].as_array().unwrap().len(), 9);
    // the rejected step is taken back and the older half forgotten: two
    // steps and the new wake
    assert_eq!(sent[5].body["messages"].as_array().unwrap().len(), 5);
    assert!(f.user.said.lock().unwrap()[4].contains("prompt is too long"));
}

#[test]
fn a_session_is_the_persons_loop_until_they_end_it() {
    let f = fixture(
        "session",
        vec![
            tool("t1", "abai_cells", json!({"names": ["count"]})),
            say("It is at 41."),
        ],
    );
    // an empty line is not the end; /quit is
    *f.user.lines.lock().unwrap() = ["", "How far has it got?", "/quit", "not read"]
        .map(str::to_string)
        .to_vec();
    assert!(f.app.session());
    let said = f.user.said.lock().unwrap().clone();
    assert!(
        said[0].starts_with("counter: a session with the agent on anthropic claude-haiku-5-5.")
    );
    assert_eq!(said[1], "It is at 41.");
    assert_eq!(
        last_message(&f.provider.requests()[0].body),
        "How far has it got?"
    );
    assert_eq!(audit(&f), ["touchpoint session ok"]);
    assert!(f.app.region().attached());
    assert_eq!(*f.user.lines.lock().unwrap(), ["not read"]);
}

#[test]
fn a_session_with_nobody_to_talk_to_fails_and_says_why() {
    let f = fixture("nobody", vec![]);
    let alone = Linked {
        front: Box::new(|manifest, content, mode| {
            let model = Anthropic::new("http://127.0.0.1:1", "k", "m", timing(), false);
            Ok(Box::new(Agent::new(
                Box::new(model),
                manifest,
                content,
                mode,
            )))
        }),
        channel: Box::new(|| None),
        options: Options::default(),
        home: None,
        env: None,
    };
    let none = |_: &str| None;
    let declarations = Declarations::new("alone", [Mode::Turns])
        .root(&f.dir)
        .audit_path("alone.jsonl");
    let app = Abaigram::with_env(&declarations, &none)
        .unwrap()
        .with_harness(Box::new(alone));
    assert!(!app.session());
    assert!(
        app.attach_error()
            .unwrap()
            .starts_with("there is nobody to talk to")
    );
    // the harness is still there for the program's turns and decisions
    assert!(app.region().attached());
    let line = std::fs::read_to_string(f.dir.join("alone.jsonl")).unwrap();
    assert!(
        line.contains(r#""act":"touchpoint","name":"session","outcome":"failed""#),
        "{line}"
    );
}
