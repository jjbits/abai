//! The MCP front end: a client that speaks JSON-RPC lines to the harness,
//! with the harness linked into the program (thread mode) and with the
//! harness as another process's code path (sidecar mode, both halves in
//! this test process).
#![cfg(unix)]

mod common;

use std::io::{BufRead, BufReader, PipeWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use abai_harness::core::Options;
use abai_harness::embedded::Linked;
use abai_harness::mcp::McpIo;
use abai_stub::app::{Abaigram, Answer};
use abai_stub::declare::{Capability, Cell, Decision, Declarations, Event, Turn};
use abai_stub::manifest::{Field, Mode, Schema};
use common::audit_lines;
use serde_json::{Value, json};

/// An MCP client: it writes requests and reads the server's lines.
struct Client {
    to: Option<PipeWriter>,
    from: Receiver<Value>,
    next: u64,
}

impl Client {
    /// A client and the streams of the server it talks to.
    fn pair() -> (Self, McpIo) {
        let (server_in, to) = std::io::pipe().unwrap();
        let (from_server, server_out) = std::io::pipe().unwrap();
        let (send, from) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(from_server).lines().map_while(Result::ok) {
                // the output carries nothing but JSON-RPC
                let message: Value = serde_json::from_str(&line).expect("a JSON line");
                if send.send(message).is_err() {
                    break;
                }
            }
        });
        let io = McpIo {
            input: Box::new(BufReader::new(server_in)),
            output: Box::new(server_out),
            log: Box::new(std::io::sink()),
        };
        (
            Self {
                to: Some(to),
                from,
                next: 1,
            },
            io,
        )
    }

    fn write(&mut self, message: &Value) {
        writeln!(self.to.as_mut().unwrap(), "{message}").unwrap();
    }

    /// Send a request and return its id.
    fn send(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next;
        self.next += 1;
        self.write(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        id
    }

    fn recv(&mut self) -> Value {
        self.from
            .recv_timeout(Duration::from_secs(10))
            .expect("the server answers")
    }

    /// The answer to the request `id`.
    fn answer(&mut self, id: u64) -> Value {
        loop {
            let message = self.recv();
            if message["id"] == id {
                return message;
            }
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params);
        self.answer(id)
    }

    fn call(&mut self, name: &str, arguments: Value) -> u64 {
        self.send("tools/call", json!({"name": name, "arguments": arguments}))
    }

    /// The text of a tool result, and whether it is an error.
    fn result(&mut self, id: u64) -> (String, bool) {
        let answer = self.answer(id);
        let result = &answer["result"];
        assert!(result.is_object(), "{answer}");
        (
            result["content"][0]["text"].as_str().unwrap().to_string(),
            result["isError"] == true,
        )
    }

    fn tool(&mut self, name: &str, arguments: Value) -> (String, bool) {
        let id = self.call(name, arguments);
        self.result(id)
    }

    /// The client goes: its end of the input closes.
    fn close(&mut self) {
        self.to = None;
    }
}

fn dir(label: &str) -> PathBuf {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "abai-m{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("abai")).unwrap();
    std::fs::write(
        dir.join("abai/identity.md"),
        "# The counter's agent\n\nYou look after a counter.\n",
    )
    .unwrap();
    dir
}

fn declarations(name: &str, modes: &[Mode], root: &std::path::Path) -> Declarations {
    Declarations::new(name, modes.iter().copied())
        .root(root)
        .audit_path("audit.jsonl")
        .cell(Cell::int("count", "A count."))
        .cell(Cell::int("step", "The step.").knob(1))
        .event(
            Event::new("alarm", "Something is wrong.")
                .payload(Schema::new().field("level", Field::int()))
                .wakes_always(),
        )
        .capability(
            Capability::new("at_safepoint", "Runs at a safepoint.")
                .handler(|_| Ok(json!({"ran": "at a safepoint"}))),
        )
        .capability(
            Capability::new("change", "Changes the program.")
                .mutate()
                .handler(|_| Ok(json!({"changed": true}))),
        )
        .decision(Decision::options(
            "on_limit",
            ["wrap", "stop"],
            "stop",
            "5s",
            "At the limit.",
        ))
        .turn(Turn::new("each_lap", "5s", "After a lap."))
}

fn unused() -> Linked {
    Linked {
        front: Box::new(|_, _, _| Err("an MCP server needs no model".to_string())),
        channel: Box::new(|| None),
        options: Options::default(),
        home: None,
        env: None,
    }
}

struct Embedded {
    app: Abaigram,
    client: Client,
    server: Option<JoinHandle<Result<(), String>>>,
    dir: PathBuf,
}

impl Drop for Embedded {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A program in thread mode whose linked harness serves MCP.
fn embedded(label: &str) -> Embedded {
    let dir = dir(label);
    let none = |_: &str| None;
    let app = Abaigram::with_env(&declarations("counter", &[Mode::Thread], &dir), &none).unwrap();
    let (client, io) = Client::pair();
    let core = app.core().clone();
    let server = std::thread::spawn(move || unused().serve_mcp(core, io));
    Embedded {
        app,
        client,
        server: Some(server),
        dir,
    }
}

#[test]
fn the_server_introduces_itself_and_lists_the_tools() {
    let mut f = embedded("hello");
    let hello = f.client.request(
        "initialize",
        json!({"protocolVersion": "2024-11-05", "capabilities": {}}),
    );
    let result = &hello["result"];
    assert_eq!(result["protocolVersion"], "2024-11-05");
    assert_eq!(result["serverInfo"]["name"], "abai-harness");
    assert_eq!(result["capabilities"], json!({"tools": {}}));
    let instructions = result["instructions"].as_str().unwrap();
    assert!(
        instructions.starts_with("counter abai harness (abaigrammar 0.1, thread).\n\nYou look after a counter.\n\nCall abai_prompt once"),
        "{instructions}"
    );
    // a revision the server does not speak gets the one it prefers
    let other = f
        .client
        .request("initialize", json!({"protocolVersion": "1999-01-01"}));
    assert_eq!(other["result"]["protocolVersion"], "2025-06-18");
    f.client
        .write(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
    assert_eq!(f.client.request("ping", json!({}))["result"], json!({}));

    let listed = f.client.request("tools/list", json!({}));
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "abai_status",
            "abai_transcript",
            "abai_cells",
            "abai_set",
            "abai_call",
            "abai_decide",
            "abai_watch",
            "abai_timer",
            "abai_audit",
            "abai_wait",
            "abai_prompt"
        ]
    );
    for tool in listed["result"]["tools"].as_array().unwrap() {
        assert_eq!(tool["inputSchema"]["type"], "object", "{tool}");
        assert!(tool["description"].as_str().is_some_and(|d| !d.is_empty()));
    }

    let (prompt, failed) = f.client.tool("abai_prompt", json!({}));
    assert!(!failed);
    assert!(prompt.contains(
        "in thread mode, from an MCP client. Nothing can wake you: you park by calling abai_wait"
    ));
    assert!(prompt.contains("You look after a counter."));

    f.client.close();
    assert_eq!(f.server.take().unwrap().join().unwrap(), Ok(()));
    // the harness went with its client
    assert!(!f.app.region().attached());
}

#[test]
fn what_is_not_a_request_is_answered_as_the_protocol_says() {
    let mut f = embedded("bad");
    f.client.write(&json!("not an object"));
    assert_eq!(f.client.recv()["error"]["code"], -32600);
    writeln!(f.client.to.as_mut().unwrap(), "{{not json").unwrap();
    assert_eq!(f.client.recv()["error"]["code"], -32700);
    assert_eq!(
        f.client.request("resources/list", json!({}))["error"]["code"],
        -32601
    );
    assert_eq!(
        f.client
            .request("tools/call", json!({"name": "abai_nope", "arguments": {}}))["error"]["code"],
        -32602
    );
    assert_eq!(
        f.client.request("tools/call", json!({}))["error"]["code"],
        -32602
    );
    // a tool that fails is a result the agent reads, not a protocol error
    let (text, failed) = f.client.tool(
        "abai_set",
        json!({"cell": "nope", "value": 1, "reason": "r"}),
    );
    assert!(failed);
    assert!(text.contains("nope is not a cell"), "{text}");
    // a notification is never answered, and the server goes on
    f.client
        .write(&json!({"jsonrpc": "2.0", "method": "notifications/whatever"}));
    assert_eq!(f.client.request("ping", json!({}))["result"], json!({}));
}

#[test]
fn the_clients_agent_reads_and_steers_the_program() {
    let mut f = embedded("steer");
    f.app.cell::<i64>("count").unwrap().set(12);
    let (cells, _) = f.client.tool("abai_cells", json!({}));
    assert_eq!(
        serde_json::from_str::<Value>(&cells).unwrap(),
        json!({"count": 12, "step": 1})
    );
    let (set, failed) = f.client.tool(
        "abai_set",
        json!({"cell": "step", "value": 4, "reason": "bigger steps"}),
    );
    assert!(!failed, "{set}");
    assert_eq!(f.app.knob::<i64>("step").unwrap().get(), 4);

    // this process is the entry's: a call for a safepoint runs at once
    let (called, failed) = f.client.tool(
        "abai_call",
        json!({"capability": "at_safepoint", "reason": "to see"}),
    );
    assert!(!failed, "{called}");
    assert!(called.contains("at a safepoint"), "{called}");

    // a confirm act is the client's to put to the person: it runs, and
    // the audit says who consented
    let (changed, failed) = f.client.tool(
        "abai_call",
        json!({"capability": "change", "reason": "asked to"}),
    );
    assert!(!failed, "{changed}");
    let (status, _) = f.client.tool("abai_status", json!({}));
    assert!(status.contains(r#""attached":true"#), "{status}");
    assert_eq!(
        audit_lines(&f.dir.join("audit.jsonl")),
        ["knob step ok", "call at_safepoint ok", "call change ok"]
    );
    let audit = std::fs::read_to_string(f.dir.join("audit.jsonl")).unwrap();
    assert!(audit.contains(r#""consent":"auto""#), "{audit}");
}

#[test]
fn the_agent_parks_in_abai_wait_and_is_handed_the_next_wake() {
    let mut f = embedded("wait");
    // nothing happens: the wait says so when its time is up
    let started = Instant::now();
    let (none, failed) = f.client.tool("abai_wait", json!({"wait_s": 0.2}));
    assert_eq!((none.as_str(), failed), ("no wake in 0.2 s", false));
    assert!(started.elapsed() >= Duration::from_millis(190));

    // parked, then an event that wakes
    let parked = f.client.call("abai_wait", json!({"wait_s": 20}));
    std::thread::sleep(Duration::from_millis(100));
    f.app.event("alarm").unwrap().emit(|p| p.int("level", 3));
    let (wake, _) = f.client.result(parked);
    assert!(
        wake.starts_with(
            "[abai wake] Something you watch for happened:\n- event alarm {\"level\":3}\n"
        ),
        "{wake}"
    );
    assert!(wake.contains("Since you last looked:"), "{wake}");

    // an event with nobody parked is held for the next wait
    f.app.event("alarm").unwrap().emit(|p| p.int("level", 4));
    std::thread::sleep(Duration::from_millis(400));
    let started = Instant::now();
    let (held, _) = f.client.tool("abai_wait", json!({"wait_s": 20}));
    assert!(held.contains(r#"event alarm {"level":4}"#), "{held}");
    assert!(started.elapsed() < Duration::from_secs(2));

    // a client that gives a parked wait up gets it back at once
    let parked = f.client.call("abai_wait", json!({"wait_s": 20}));
    std::thread::sleep(Duration::from_millis(100));
    f.client.write(
        &json!({"jsonrpc": "2.0", "method": "notifications/cancelled",
        "params": {"requestId": parked}}),
    );
    assert_eq!(f.client.result(parked).0, "cancelled");

    // other tools are served while the agent is parked
    let parked = f.client.call("abai_wait", json!({"wait_s": 20}));
    let (cells, _) = f.client.tool("abai_cells", json!({}));
    assert!(cells.contains("count"), "{cells}");
    // and a second wait takes the first one's place
    let second = f.client.call("abai_wait", json!({"wait_s": 0.1}));
    assert_eq!(
        f.client.result(parked).0,
        "another abai_wait took this one's place"
    );
    assert_eq!(f.client.result(second).0, "no wake in 0.1 s");
}

struct Sidecar {
    app: Abaigram,
    client: Client,
    server: Option<JoinHandle<Result<(), String>>>,
    dir: PathBuf,
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A program in sidecar mode, and an MCP server attached to its socket.
fn sidecar(label: &str) -> Sidecar {
    let dir = dir(label);
    let home = dir.join("h").display().to_string();
    let env = move |name: &str| (name == "ABAI_HOME").then(|| home.clone());
    let app = Abaigram::with_env(&declarations("counter", &[Mode::Sidecar], &dir), &env).unwrap();
    assert_eq!(app.sidecar_error(), None);
    let socket = app.sidecar_socket().unwrap().to_path_buf();
    let (client, io) = Client::pair();
    let server = std::thread::spawn(move || {
        abai_harness::sidecar::serve_mcp(&socket, Options::default(), None, io)
    });
    let started = Instant::now();
    while !app.attached() {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the server attaches"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    Sidecar {
        app,
        client,
        server: Some(server),
        dir,
    }
}

#[test]
fn a_decision_is_handed_to_the_parked_agent_and_settled_when_it_parks_again() {
    let mut f = sidecar("decide");
    let listed = f.client.request("tools/list", json!({}));
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    // another process has the lifecycle channel, and can attach again
    assert!(names.contains(&"abai_lifecycle") && names.contains(&"abai_attach"));

    let parked = f.client.call("abai_wait", json!({"wait_s": 20}));
    std::thread::sleep(Duration::from_millis(50));
    let app = f.app.clone();
    let asking = std::thread::spawn(move || {
        let started = Instant::now();
        let on_limit = app.decision("on_limit").unwrap();
        let by_agent = on_limit.ask(&json!({})) == Answer::Agent(json!("wrap"));
        (by_agent, started.elapsed())
    });
    let (wake, _) = f.client.result(parked);
    assert!(
        wake.starts_with(
            "[abai wake] The program asks the decision on_limit (id d1) and waits for you."
        ),
        "{wake}"
    );
    // the program waits while the agent works
    let (cells, _) = f.client.tool("abai_cells", json!({}));
    assert!(cells.contains("count"));
    let (decided, failed) = f.client.tool(
        "abai_decide",
        json!({"id": "d1", "answer": "wrap", "reason": "there is room"}),
    );
    assert!(!failed, "{decided}");
    std::thread::sleep(Duration::from_millis(100));
    assert!(!asking.is_finished());
    // the agent parks again: the decision is settled
    let parked = f.client.call("abai_wait", json!({"wait_s": 20}));
    let (by_agent, took) = asking.join().unwrap();
    assert!(by_agent);
    assert!(took < Duration::from_secs(4), "{took:?}");

    // a turn, with the agent already parked
    let app = f.app.clone();
    let turn = std::thread::spawn(move || app.turn("each_lap").unwrap().give());
    let (wake, _) = f.client.result(parked);
    assert!(
        wake.starts_with("[abai wake] The program gives you the turn each_lap."),
        "{wake}"
    );
    f.client.call("abai_wait", json!({"wait_s": 0.1}));
    assert!(turn.join().unwrap());
    assert_eq!(
        audit_lines(&f.dir.join("audit.jsonl")),
        ["decision on_limit ok", "turn each_lap ok"]
    );

    // the client goes: the server ends, and the program is the plain program
    f.client.close();
    assert_eq!(f.server.take().unwrap().join().unwrap(), Ok(()));
    let started = Instant::now();
    while f.app.attached() {
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn a_decision_the_agent_parks_on_without_answering_takes_its_default() {
    let mut f = sidecar("undecided");
    let parked = f.client.call("abai_wait", json!({"wait_s": 20}));
    std::thread::sleep(Duration::from_millis(50));
    let app = f.app.clone();
    let asking = std::thread::spawn(move || {
        let on_limit = app.decision("on_limit").unwrap();
        matches!(on_limit.ask(&json!({})), Answer::Default(_))
    });
    let (wake, _) = f.client.result(parked);
    assert!(wake.contains("the decision on_limit (id d1)"), "{wake}");
    // the agent parks again with the decision open
    f.client.call("abai_wait", json!({"wait_s": 20}));
    assert!(asking.join().unwrap());

    // the word and the reason the TypeScript pair writes
    let text = std::fs::read_to_string(f.dir.join("audit.jsonl")).unwrap();
    let line: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    assert_eq!(line["cause"], "answered", "{line}");
    assert_eq!(line["reason"], "the agent parked without deciding");
    f.client.close();
}

#[test]
fn a_decision_nobody_is_parked_for_takes_its_default_in_time() {
    let dir = dir("idle");
    let home = dir.join("h").display().to_string();
    let env = move |name: &str| (name == "ABAI_HOME").then(|| home.clone());
    let quick = declarations("counter", &[Mode::Sidecar], &dir).decision(Decision::options(
        "quick",
        ["a", "b"],
        "a",
        "300ms",
        "A decision with little time.",
    ));
    let app = Abaigram::with_env(&quick, &env).unwrap();
    let socket = app.sidecar_socket().unwrap().to_path_buf();
    let (mut client, io) = Client::pair();
    let _server = std::thread::spawn(move || {
        abai_harness::sidecar::serve_mcp(&socket, Options::default(), None, io)
    });
    let started = Instant::now();
    while !app.attached() {
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(2));
    }
    // the agent is busy elsewhere: not parked
    let started = Instant::now();
    let quick = app.decision("quick").unwrap();
    assert_eq!(quick.ask(&json!({})), Answer::Default(&json!("a")));
    // the harness ended the step at the decision's own time: before the
    // program would have given up by itself, half a second later
    assert!(
        started.elapsed() < Duration::from_millis(700),
        "{:?}",
        started.elapsed()
    );
    // the server's loop is still serving
    let (cells, failed) = client.tool("abai_cells", json!({}));
    assert!(!failed && cells.contains("count"), "{cells}");
    let audit = audit_lines(&dir.join("audit.jsonl"));
    assert_eq!(audit.len(), 1, "{audit:?}");
    assert!(audit[0].starts_with("decision quick default"), "{audit:?}");

    // a wait that is not one is said to be wrong, not parked for 25 s
    for bad in [json!(0), json!(-1), json!("soon")] {
        let (text, failed) = client.tool("abai_wait", json!({"wait_s": bad}));
        assert!(failed, "{text}");
        assert_eq!(text, "invalid arguments: wait_s must be a number above 0");
    }
    let _ = std::fs::remove_dir_all(&dir);
}
