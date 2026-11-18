//! A run's network end to end: a program in thread mode whose harness
//! is a member of a network of two fake daemons. The test is the other
//! member. The agent is a script. No model.
#![cfg(unix)]

mod common;

use std::path::PathBuf;
use std::sync::Arc;

use abai_harness::core::{Code, Options, UserChannel};
use abai_harness::embedded::Linked;
use abai_harness::net::fake::{FakeAiipd, FakeOverlay, Scratch};
use abai_harness::net::{AiipClient, Classified, classify};
use abai_harness::network;
use abai_stub::app::Abaigram;
use abai_stub::declare::{Declarations, Turn};
use abai_stub::manifest::{Manifest, Mode};
use common::{Script, Scripted, User, audit_lines, reasons};
use serde_json::{Value, json};

struct Fixture {
    app: Abaigram,
    script: Script,
    manifest: Manifest,
    /// This run's daemon.
    alpha: FakeAiipd,
    /// The other member's daemon, which the test speaks through.
    bravo: FakeAiipd,
    network: String,
    /// What points a run at this run's daemon.
    net_dir: PathBuf,
    scratch: Scratch,
}

impl Fixture {
    /// The environment of a run that is the member `alpha`.
    fn env(&self) -> impl Fn(&str) -> Option<String> + use<> {
        let dir = self.net_dir.display().to_string();
        move |name: &str| match name {
            "ABAI_NET_DIR" => Some(dir.clone()),
            // a daemon answers in that directory already, so the binary
            // is named and never run
            "ABAI_AIIP_BIN" => Some("/usr/bin/true".to_string()),
            _ => None,
        }
    }

    /// A step in which the agent's harness takes the network up, as an
    /// attach does.
    fn join(&self) {
        let (env, manifest) = (self.env(), self.manifest.clone());
        self.script.then(move |core, _| {
            let connected = network::connect(&env, &manifest).unwrap();
            assert!(connected.on(), "{:?}", connected.absent);
            let thread = std::thread::current();
            core.set_network(connected, Arc::new(move || thread.unpark()));
        });
        assert!(self.app.turn("each_lap").unwrap().give());
    }

    fn bravo(&self) -> AiipClient {
        AiipClient::new(self.bravo.socket_path())
    }

    fn audit(&self) -> Vec<String> {
        audit_lines(&self.scratch.path().join("audit.jsonl"))
    }
}

fn fixture(name: &str) -> Fixture {
    let scratch = Scratch::new();
    let root = scratch.path().to_path_buf();
    std::fs::create_dir_all(root.join("abai")).unwrap();
    std::fs::write(root.join("abai/identity.md"), "You are the agent.\n").unwrap();
    let net_dir = root.join("a");
    std::fs::create_dir_all(&net_dir).unwrap();
    std::fs::create_dir_all(root.join("b")).unwrap();

    let overlay = FakeOverlay::with_ids("net-1", "world");
    let alpha = overlay
        .new_member("alpha", &net_dir.join("aiipd.sock"))
        .unwrap();
    let bravo = overlay
        .new_member("bravo", &root.join("b/aiipd.sock"))
        .unwrap();

    let declarations = Declarations::new(name, [Mode::Thread])
        .root(&root)
        .audit_path("audit.jsonl")
        .turn(Turn::new("each_lap", "5s", "After a lap."))
        .turn(Turn::new("quick", "400ms", "A turn with little time."));
    let manifest = declarations.manifest().unwrap();
    let script = Script::default();
    let front_script = script.clone();
    let linked = Linked {
        front: Box::new(move |_, _, _| Ok(Box::new(Scripted(front_script.clone())))),
        channel: Box::new(|| Some(Box::new(User::default()) as Box<dyn UserChannel>)),
        options: Options::default(),
        home: None,
        env: Some(Arc::new(|_| None)),
    };
    let none = |_: &str| None;
    let app = Abaigram::with_env(&declarations, &none)
        .unwrap()
        .with_harness(Box::new(linked));
    assert!(app.attach(), "{:?}", app.attach_error());
    Fixture {
        app,
        script,
        manifest,
        alpha,
        bravo,
        network: overlay.network_name(),
        net_dir,
        scratch,
    }
}

#[test]
fn a_members_message_wakes_the_agent_and_its_answer_reaches_the_member() {
    let f = fixture("talk");
    f.join();
    // the run's membership is in the transcript from the attach on
    f.script.then(|core, wake| {
        let lines = core.transcript.read(50, 0);
        assert!(
            lines
                .iter()
                .any(|(_, line)| line.starts_with("# network: alpha (") && line.contains(" on ")),
            "{lines:?}"
        );
        assert_eq!(
            reasons(wake),
            ["abai.net.message from=bravo network=world: are you there?"]
        );
        let listed = core.messages(None, None).unwrap();
        assert_eq!(listed[0]["direction"], "received");
        assert_eq!(listed[0]["peer"], "bravo");
        let first = listed[0]["id"].as_str().unwrap().to_string();
        let sent = core
            .send(
                "bravo",
                "here",
                "to answer",
                Some(&first),
                Some(&first),
                None,
            )
            .unwrap();
        assert_eq!(sent["to"]["name"], "bravo");
        assert_eq!(sent["thread"], first.as_str());
        assert_eq!(
            core.messages(None, None).unwrap().as_array().unwrap().len(),
            2
        );
        assert_eq!(
            core.messages(None, Some(1)).unwrap()[0]["direction"],
            "sent"
        );
    });
    assert_eq!(f.network, "world");
    let asked = abai_harness::net::encode_message(abai_harness::net::MessageInput {
        body: "are you there?".to_string(),
        ..Default::default()
    })
    .unwrap();
    f.bravo()
        .send(&f.network, "alpha", &asked.bytes, None)
        .unwrap();
    f.script.wait_for(2);

    // the answer is in bravo's mailbox, in an envelope that continues the thread
    let answer = f
        .bravo()
        .recv(&f.network, Some(5000), None)
        .unwrap()
        .expect("the answer arrives");
    assert_eq!(answer.from.name.as_deref(), Some("alpha"));
    let Classified::Envelope(envelope) = classify(&answer.payload) else {
        panic!("an envelope");
    };
    assert_eq!(envelope.body.as_deref(), Some("here"));
    assert_eq!(envelope.thread.as_deref(), Some(asked.id.as_str()));
    assert_eq!(envelope.re.as_deref(), Some(asked.id.as_str()));

    // one audit line per message, each way
    assert_eq!(
        f.audit(),
        ["turn each_lap ok", "message bravo ok", "message bravo ok"]
    );
    let audit = std::fs::read_to_string(f.scratch.path().join("audit.jsonl")).unwrap();
    let lines: Vec<Value> = audit
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines[1]["direction"], "received");
    assert_eq!(lines[1]["body"], "are you there?");
    assert_eq!(lines[1]["network"], "world");
    assert_eq!(lines[2]["direction"], "sent");
    assert_eq!(lines[2]["reason"], "to answer");
    assert_eq!(lines[2]["re"], asked.id.as_str());
}

#[test]
fn the_agent_sees_who_is_on_the_network_and_a_send_that_fails_says_why() {
    let f = fixture("peers");
    f.join();
    f.script.then(|core, _| {
        let peers = core.peers().unwrap();
        assert_eq!(peers[0]["network"], "world");
        assert_eq!(peers[0]["member"], "alpha");
        let names: Vec<&str> = peers[0]["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|member| member["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["alpha", "bravo"]);
        assert_eq!(peers[0]["members"][0]["self"], true);

        let unknown = core
            .send("zed", "hello", "to try", None, None, None)
            .unwrap_err();
        assert_eq!(unknown.code, Code::Error);
        assert!(
            unknown
                .message
                .starts_with("no member named zed on world; abai_peers lists them"),
            "{}",
            unknown.message
        );
        let elsewhere = core
            .send("bravo", "hello", "to try", None, None, Some("sea"))
            .unwrap_err();
        assert_eq!(
            elsewhere.message,
            "this run is not on a network named sea; it is on world"
        );
        assert_eq!(
            core.send("bravo", "hello", " ", None, None, None)
                .unwrap_err()
                .code,
            Code::Invalid
        );
    });
    assert!(f.app.turn("each_lap").unwrap().give());
    // the send that the daemon refused is on the record, with the reason
    assert_eq!(
        f.audit(),
        ["turn each_lap ok", "message zed error", "turn each_lap ok"]
    );
}

#[test]
fn a_run_with_no_network_says_so_to_the_agent() {
    let f = fixture("alone");
    f.script.then(|core, _| {
        for refused in [
            core.peers().unwrap_err(),
            core.messages(None, None).unwrap_err(),
        ] {
            assert_eq!(
                refused.message,
                "this run has no network: the program declares none and ABAI_NET_DIR is unset"
            );
        }
        assert!(
            core.send("bravo", "hi", "to try", None, None, None)
                .unwrap_err()
                .message
                .starts_with("this run has no network")
        );
    });
    assert!(f.app.turn("each_lap").unwrap().give());
}

#[test]
fn a_message_that_is_not_an_agents_is_shown_and_does_not_wake() {
    let f = fixture("kinds");
    f.join();
    let receipt = json!({"aiap": 1, "type": "receipt", "id": "r-1",
        "ts": "2026-11-12T00:00:00Z", "receipt": {"of": "m-1", "status": "delivered"}});
    f.bravo()
        .send(&f.network, "alpha", receipt.to_string().as_bytes(), None)
        .unwrap();
    // a payload that is no envelope is a raw message, and wakes
    f.bravo()
        .send(&f.network, "alpha", b"plain words", None)
        .unwrap();
    let wakes = f.script.wait_for(2);
    assert_eq!(
        reasons(&wakes[1]),
        ["abai.net.message from=bravo network=world kind=raw: plain words"]
    );
    f.script.then(|core, _| {
        let listed = core.messages(None, None).unwrap();
        let kinds: Vec<&str> = listed
            .as_array()
            .unwrap()
            .iter()
            .map(|message| message["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["receipt", "raw"]);
        assert_eq!(listed[0]["body"], "(receipt: m-1 delivered)");
    });
    assert!(f.app.turn("each_lap").unwrap().give());
    // only what an agent said is audited
    assert_eq!(
        f.audit(),
        ["turn each_lap ok", "message bravo ok", "turn each_lap ok"]
    );
}

#[test]
fn a_program_that_requires_a_network_attaches_no_agent_without_one() {
    let scratch = Scratch::new();
    let root = scratch.path().to_path_buf();
    std::fs::create_dir_all(root.join("abai")).unwrap();
    std::fs::write(root.join("abai/identity.md"), "You are the agent.\n").unwrap();
    // a name no other program has, so its place under abai's home is empty
    let name = format!("abai-test-needs-net-{}", std::process::id());
    let linked = || Linked {
        front: Box::new(|_, _, _| Ok(Box::new(Scripted(Script::default())))),
        channel: Box::new(|| None),
        options: Options::default(),
        home: None,
        env: Some(Arc::new(|_| None)),
    };
    let none = |_: &str| None;
    let required = Declarations::new(&name, [Mode::Thread])
        .root(&root)
        .audit_path("audit.jsonl")
        .network("A member is another counter.", true);
    let app = Abaigram::with_env(&required, &none)
        .unwrap()
        .with_harness(Box::new(linked()));
    assert!(!app.attach());
    let why = app.attach_error().unwrap();
    assert!(why.starts_with("the program requires a network: "), "{why}");
    assert!(!app.region().attached());

    // declared and not required: the agent attaches, and is told why it
    // has no network
    let optional = Declarations::new(&name, [Mode::Thread])
        .root(&root)
        .audit_path("audit.jsonl")
        .network("A member is another counter.", false)
        .turn(Turn::new("each_lap", "5s", "After a lap."));
    let script = Script::default();
    let front_script = script.clone();
    let app = Abaigram::with_env(&optional, &none)
        .unwrap()
        .with_harness(Box::new(Linked {
            front: Box::new(move |_, _, _| Ok(Box::new(Scripted(front_script.clone())))),
            ..linked()
        }));
    assert!(app.attach(), "{:?}", app.attach_error());
    script.then(|core, _| {
        let lines = core.transcript.read(50, 0);
        assert!(
            lines
                .iter()
                .any(|(_, line)| line.starts_with("# network: none (")),
            "{lines:?}"
        );
        let refused = core.peers().unwrap_err();
        assert!(
            refused
                .message
                .starts_with("this run has no network: there is no home directory"),
            "{}",
            refused.message
        );
    });
    assert!(app.turn("each_lap").unwrap().give());
}

#[test]
fn a_send_waits_no_longer_than_the_step_has() {
    let f = fixture("slow");
    f.join();
    // the daemon takes its time over everything from here on
    f.alpha.set_delay_ms(3000);
    f.script.then(|core, _| {
        let started = std::time::Instant::now();
        let late = core
            .send("bravo", "hello", "to try", None, None, None)
            .unwrap_err();
        assert!(
            late.message
                .starts_with("the time for this step ran out before bravo answered"),
            "{}",
            late.message
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    });
    // the turn has 400 ms; the program is not held for the daemon's three seconds
    let started = std::time::Instant::now();
    f.app.turn("quick").unwrap().give();
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    f.script.wait_for(2);
    f.alpha.set_delay_ms(0);
}

#[test]
fn with_no_program_attached_a_message_waits_in_the_daemon() {
    use abai_harness::embedded::RunEnd;
    let f = fixture("waits");
    f.join();
    // the agent goes
    f.script
        .then_end(|_, _| RunEnd::Unreachable("the model went away".to_string()));
    assert!(!f.app.turn("each_lap").unwrap().give());
    let started = std::time::Instant::now();
    while f.app.region().attached() {
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    // give the mail loops the moment they need to stop
    std::thread::sleep(std::time::Duration::from_millis(1500));
    f.alpha.clear_mailbox();
    f.bravo()
        .send(&f.network, "alpha", b"anyone?", None)
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(600));
    // nobody took it: it is there for the next harness
    assert_eq!(f.alpha.mailbox_len(), 1);
}
