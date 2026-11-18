//! The MCP front end (contract section 4.4, `<prog> abai mcp`): the
//! harness as an MCP server, so the agent inside an MCP client is the
//! program's agent. No model is configured here: the client brings its
//! own.
//!
//! The transport is MCP's stdio one: JSON-RPC 2.0, one message a line.
//! The output carries nothing else; what the harness has to say goes to
//! the log.
//!
//! Nothing can wake an MCP client, so its agent parks by calling
//! `abai_wait`, which returns the next wake. A decision or a turn the
//! program is waiting on stays open while the agent works, and is
//! settled when the agent parks again.
//!
//! Consent is the client's: a client that shows each tool call to the
//! person before it runs is the user channel, so the core runs with
//! `auto` and audits a `confirm` act so.

use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use abai_stub::content::Content;
use abai_stub::manifest::{Manifest, Mode};
use serde_json::{Map, Value, json};

use crate::agent::{news_since, wake_message};
use crate::core::{Core, UserChannel};
use crate::embedded::{Front, RunEnd, Wake};
use crate::model::ToolSpec;
use crate::prompt::{self, Form};
use crate::tools;

/// The name the server gives itself.
pub const SERVER_NAME: &str = "abai-harness";
/// The protocol revisions this server speaks; the client's is echoed
/// when it is one of them. `2025-03-26` is left out: it requires JSON-RPC
/// batches, which this server does not accept.
pub const PROTOCOL_VERSIONS: [&str; 2] = ["2025-06-18", "2024-11-05"];
/// The longest line read from the client.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
/// How long `abai_wait` parks when the agent does not say.
const DEFAULT_WAIT: f64 = 25.0;
/// The longest `abai_wait` parks.
const MAX_WAIT: f64 = 300.0;
/// How often a step in progress looks at its deadline.
const TICK: Duration = Duration::from_millis(50);

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

/// Attaches the harness to a program again, by a target the agent gives
/// or to the one running program. Returns what to tell the agent.
pub type Attach = Box<dyn FnMut(&mut Core, Option<&str>) -> Result<String, String> + Send>;

/// What the reading thread hands the loop.
enum Request {
    Call {
        id: Value,
        name: String,
        arguments: Value,
        /// The request's place in the order the client sent them.
        seq: u64,
    },
    /// The client gave up a request it had made.
    Cancel(Value),
}

/// A parked `abai_wait`.
struct Wait {
    id: Value,
    until: Instant,
    seconds: f64,
}

/// What the front and the channel share. They run on one thread, the
/// loop's; the lock is for the type system.
struct State {
    requests: Receiver<Request>,
    wait: Option<Wait>,
    /// Wakes that came with nobody parked, for the next `abai_wait`.
    held: Vec<String>,
    /// How many held wakes were let go of for want of room.
    dropped: u64,
    /// The transcript line the agent has been shown up to.
    shown: u64,
}

/// The output stream, shared with the reading thread.
#[derive(Clone)]
struct Out {
    stream: Arc<Mutex<Box<dyn Write + Send>>>,
    /// Raised when the output could not be written: the client has gone.
    broken: Arc<AtomicBool>,
}

impl Out {
    fn write(&self, message: &Value) {
        let mut out = self.stream.lock().unwrap_or_else(PoisonError::into_inner);
        // a client that no longer reads is a client that has gone: the
        // server does not go on acting for nobody
        if writeln!(out, "{message}")
            .and_then(|()| out.flush())
            .is_err()
        {
            self.broken.store(true, Ordering::SeqCst);
        }
    }

    fn respond(&self, id: &Value, result: Value) {
        self.write(&json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    fn fail(&self, id: &Value, code: i64, message: &str) {
        self.write(&json!({"jsonrpc": "2.0", "id": id,
            "error": {"code": code, "message": message}}));
    }

    fn text(&self, id: &Value, text: &str, is_error: bool) {
        let mut result = json!({"content": [{"type": "text", "text": text}]});
        if is_error {
            result["isError"] = json!(true);
        }
        self.respond(id, result);
    }
}

fn mcp_tools(attaches: bool) -> Vec<ToolSpec> {
    let object = |properties: Value| json!({"type": "object", "properties": properties});
    let mut tools = vec![
        ToolSpec {
            name: "abai_wait".to_string(),
            description: "Park until the next wake (an event declared to wake you, a watch, a timer, a decision or a turn from the program) and return it, or say that none came after wait_s seconds (default 25). A decision or a turn you were handed is settled when you call this. Call it again after acting.".to_string(),
            schema: object(json!({"wait_s": {"type": "number", "exclusiveMinimum": 0,
                "description": "Seconds to wait at most (default 25)"}})),
        },
        ToolSpec {
            name: "abai_prompt".to_string(),
            description: "Your full instructions: the program's identity and its manifest (cells, capabilities, decisions, the events that wake you) with the rules. Read it once at the start.".to_string(),
            schema: object(json!({})),
        },
    ];
    if attaches {
        tools.push(ToolSpec {
            name: "abai_attach".to_string(),
            description: "Attach to the program again after it has gone and come back: by pid, by name, or to the one running program of that name when no target is given.".to_string(),
            schema: object(json!({"target": {"type": "string",
                "description": "A pid or a program's name"}})),
        });
    }
    tools
}

/// The tools an MCP client is offered for a program in `mode`.
fn offered(manifest: &Manifest, mode: Mode, attaches: bool) -> Vec<ToolSpec> {
    let network = tools::network_expected(manifest, &|name| std::env::var(name).ok());
    let mut all = tools::offered(mode, network);
    all.extend(mcp_tools(attaches));
    all
}

/// The front end: what the loop runs for a wake and for a request.
pub struct McpFront {
    state: Arc<Mutex<State>>,
    out: Out,
    system: String,
    names: Vec<String>,
    attach: Option<Attach>,
    /// The client's input has ended.
    closed: Arc<AtomicBool>,
    /// How many requests the client has sent so far.
    sent: Arc<AtomicU64>,
}

/// The loop's "user": each line it gives is one request of the client.
pub struct McpChannel {
    state: Arc<Mutex<State>>,
    out: Out,
    log: Box<dyn Write + Send>,
}

impl std::fmt::Debug for McpFront {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpFront").finish_non_exhaustive()
    }
}

impl std::fmt::Debug for McpChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpChannel").finish_non_exhaustive()
    }
}

/// The streams an MCP server speaks on.
pub struct McpIo {
    pub input: Box<dyn BufRead + Send>,
    pub output: Box<dyn Write + Send>,
    /// Where the harness's own words go: never the output.
    pub log: Box<dyn Write + Send>,
}

impl std::fmt::Debug for McpIo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpIo").finish_non_exhaustive()
    }
}

impl McpIo {
    /// The process's own streams.
    pub fn stdio() -> Self {
        Self {
            input: Box::new(std::io::BufReader::new(std::io::stdin())),
            output: Box::new(std::io::stdout()),
            log: Box::new(std::io::stderr()),
        }
    }
}

/// Read one line of at most `MAX_LINE_BYTES`. None at the end of the
/// input, on an error, or when a line is longer.
fn read_line(input: &mut dyn BufRead) -> Option<String> {
    let mut line = Vec::new();
    loop {
        let buffered = input.fill_buf().ok()?;
        if buffered.is_empty() {
            // the end of the input; a last line with no newline counts
            return (!line.is_empty()).then(|| String::from_utf8_lossy(&line).into_owned());
        }
        let (taken, whole) = match buffered.iter().position(|byte| *byte == b'\n') {
            Some(at) => (at + 1, true),
            None => (buffered.len(), false),
        };
        line.extend_from_slice(&buffered[..taken]);
        input.consume(taken);
        if line.len() > MAX_LINE_BYTES {
            return None;
        }
        if whole {
            return Some(String::from_utf8_lossy(&line).into_owned());
        }
    }
}

/// Start an MCP server for a program: a thread reads the client's
/// messages and answers what needs no program; the front and the channel
/// returned serve the rest on the harness's loop.
pub fn serve(
    io: McpIo,
    manifest: &Manifest,
    content: &Content,
    mode: Mode,
    attach: Option<Attach>,
) -> (McpFront, McpChannel) {
    let McpIo {
        mut input,
        output,
        log,
    } = io;
    let closed = Arc::new(AtomicBool::new(false));
    let out = Out {
        stream: Arc::new(Mutex::new(output)),
        broken: Arc::new(AtomicBool::new(false)),
    };
    let sent = Arc::new(AtomicU64::new(0));
    let offered = offered(manifest, mode, attach.is_some());
    let names: Vec<String> = offered.iter().map(|tool| tool.name.clone()).collect();
    let listed: Vec<Value> = offered
        .iter()
        .map(|tool| {
            json!({"name": tool.name, "description": tool.description,
                "inputSchema": tool.schema})
        })
        .collect();
    let instructions = prompt::instructions(manifest, content, mode);
    let (send, requests): (Sender<Request>, Receiver<Request>) = channel();
    let (reader_out, reader_names, reader_closed) = (out.clone(), names.clone(), closed.clone());
    let reader_sent = sent.clone();
    let spawned = std::thread::Builder::new()
        .name("abai-mcp".to_string())
        .spawn(move || {
            let out = reader_out;
            while let Some(line) = read_line(input.as_mut()) {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    out.fail(&Value::Null, PARSE_ERROR, "parse error");
                    continue;
                };
                let Some(message) = message.as_object() else {
                    // batches are not accepted: the advertised revisions
                    // do not require them
                    out.fail(&Value::Null, INVALID_REQUEST, "invalid request");
                    continue;
                };
                let Some(method) = message.get("method").and_then(Value::as_str) else {
                    // an id and no method is the client's answer to
                    // something: not ours to answer
                    continue;
                };
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                let Some(id) = message.get("id") else {
                    // a notification; the one acted on cuts a parked
                    // wait short
                    if method == "notifications/cancelled"
                        && let Some(request) = params.get("requestId")
                        && send.send(Request::Cancel(request.clone())).is_err()
                    {
                        break;
                    }
                    continue;
                };
                if !(id.is_string() || id.is_number() || id.is_null()) {
                    out.fail(
                        &Value::Null,
                        INVALID_REQUEST,
                        "a request id must be a string, a number or null",
                    );
                    continue;
                }
                match method {
                    "initialize" => {
                        let asked = params.get("protocolVersion").and_then(Value::as_str);
                        let version = asked
                            .filter(|asked| PROTOCOL_VERSIONS.contains(asked))
                            .unwrap_or(PROTOCOL_VERSIONS[0]);
                        out.respond(
                            id,
                            json!({
                                "protocolVersion": version,
                                "capabilities": {"tools": {}},
                                "serverInfo": {"name": SERVER_NAME,
                                    "version": crate::ABAI_HARNESS_VERSION},
                                "instructions": instructions,
                            }),
                        );
                    }
                    "ping" => out.respond(id, json!({})),
                    "tools/list" => out.respond(id, json!({"tools": listed})),
                    "tools/call" => {
                        let name = params.get("name").and_then(Value::as_str);
                        match name {
                            None => out.fail(id, INVALID_PARAMS, "tools/call needs a tool name"),
                            Some(name) if !reader_names.iter().any(|known| known == name) => {
                                out.fail(id, INVALID_PARAMS, &format!("unknown tool {name}"));
                            }
                            Some(name) => {
                                let arguments = match params.get("arguments") {
                                    Some(Value::Object(arguments)) => {
                                        Value::Object(arguments.clone())
                                    }
                                    _ => Value::Object(Map::new()),
                                };
                                let call = Request::Call {
                                    id: id.clone(),
                                    name: name.to_string(),
                                    arguments,
                                    seq: reader_sent.fetch_add(1, Ordering::SeqCst) + 1,
                                };
                                if send.send(call).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    other => {
                        out.fail(id, METHOD_NOT_FOUND, &format!("method not found: {other}"));
                    }
                }
            }
            reader_closed.store(true, Ordering::SeqCst);
        });
    if spawned.is_err() {
        // with nobody reading, the client is as good as gone
        closed.store(true, Ordering::SeqCst);
    }

    let state = Arc::new(Mutex::new(State {
        requests,
        wait: None,
        held: Vec::new(),
        dropped: 0,
        shown: 0,
    }));
    let front = McpFront {
        state: state.clone(),
        out: out.clone(),
        system: prompt::compose(manifest, content, mode, Form::Mcp),
        names,
        attach,
        closed,
        sent,
    };
    let channel = McpChannel { state, out, log };
    (front, channel)
}

/// The most wakes held for an agent that is not parked; older ones are
/// counted.
const HELD_WAKES: usize = 20;

/// How long the agent asked to park for.
fn wait_seconds(arguments: &Value) -> Result<f64, String> {
    match arguments.get("wait_s") {
        None | Some(Value::Null) => Ok(DEFAULT_WAIT),
        Some(given) => match given.as_f64() {
            Some(seconds) if seconds > 0.0 => Ok(seconds.min(MAX_WAIT)),
            _ => Err("invalid arguments: wait_s must be a number above 0".to_string()),
        },
    }
}

fn same_id(a: &Value, b: &Value) -> bool {
    a == b
}

impl State {
    /// Answer a parked wait whose time is up.
    fn expire(&mut self, out: &Out) {
        if self
            .wait
            .as_ref()
            .is_some_and(|wait| Instant::now() >= wait.until)
            && let Some(wait) = self.wait.take()
        {
            out.text(&wait.id, &format!("no wake in {} s", wait.seconds), false);
        }
    }

    /// The client gave a request up: a parked wait is answered at once.
    fn cancel(&mut self, out: &Out, request: &Value) {
        if self
            .wait
            .as_ref()
            .is_some_and(|wait| same_id(&wait.id, request))
            && let Some(wait) = self.wait.take()
        {
            out.text(&wait.id, "cancelled", false);
        }
    }

    /// The agent parks. A wait already parked is answered first: one
    /// agent parks once.
    /// False when the arguments are not a wait's: the request has been
    /// answered so, and nothing is parked.
    fn park(&mut self, out: &Out, id: Value, arguments: &Value) -> bool {
        let seconds = match wait_seconds(arguments) {
            Ok(seconds) => seconds,
            Err(problem) => {
                out.text(&id, &problem, true);
                return false;
            }
        };
        if let Some(earlier) = self.wait.take() {
            out.text(
                &earlier.id,
                "another abai_wait took this one's place",
                false,
            );
        }
        self.wait = Some(Wait {
            id,
            until: Instant::now() + Duration::from_secs_f64(seconds),
            seconds,
        });
        true
    }

    /// Keep a wake for an agent that is not parked.
    fn hold(&mut self, text: String) {
        self.held.push(text);
        if self.held.len() > HELD_WAKES {
            let over = self.held.len() - HELD_WAKES;
            self.held.drain(..over);
            self.dropped += over as u64;
        }
    }

    /// What was held, as one text, with a word on what was not kept.
    fn take_held(&mut self) -> Vec<String> {
        let mut all = std::mem::take(&mut self.held);
        if self.dropped > 0 {
            all.insert(
                0,
                format!(
                    "({} earlier wakes are not shown; the transcript has what happened.)",
                    self.dropped
                ),
            );
            self.dropped = 0;
        }
        all
    }

    /// Hand a wake to the parked agent. False when nobody is parked.
    fn deliver(&mut self, out: &Out, text: &str) -> bool {
        match self.wait.take() {
            Some(wait) => {
                out.text(&wait.id, text, false);
                true
            }
            None => false,
        }
    }
}

impl McpFront {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn gone(&self) -> bool {
        self.closed.load(Ordering::SeqCst) || self.out.broken.load(Ordering::SeqCst)
    }

    /// Run one tool call and answer it. `abai_wait` is not one of these.
    fn call(&mut self, core: &mut Core, id: &Value, name: &str, arguments: &Value) {
        match name {
            "abai_prompt" => self.out.text(id, &self.system, false),
            "abai_attach" => {
                // a pid may come as a number
                let target = match arguments.get("target") {
                    Some(Value::String(target)) => Some(target.clone()),
                    Some(Value::Number(pid)) => Some(pid.to_string()),
                    _ => None,
                };
                let attached = match &mut self.attach {
                    Some(attach) => attach(core, target.as_deref()),
                    None => Err(
                        "this harness runs inside the program; there is nothing else to attach to"
                            .to_string(),
                    ),
                };
                match attached {
                    Ok(text) => self.out.text(id, &text, false),
                    Err(text) => self.out.text(id, &text, true),
                }
            }
            name => {
                // a tool failure is a result the agent can read, not a
                // protocol error
                let outcome = tools::call(core, name, arguments);
                self.out.text(id, &outcome.content, outcome.is_error);
            }
        }
    }

    /// The agent parks: what was held for it is handed over at once.
    fn park(&mut self, core: &Core, id: Value, arguments: &Value) {
        let mut state = self.state();
        if state.park(&self.out, id, arguments) && !state.held.is_empty() {
            let mut text = state.take_held().join("\n");
            text.push_str(&news_since(core, &mut state.shown));
            state.deliver(&self.out, &text);
        }
    }

    /// The next request, waiting at most `wait` for it.
    fn next(&self, wait: Duration) -> Option<Request> {
        let state = self.state();
        state.requests.recv_timeout(wait).ok()
    }
}

impl Front for McpFront {
    fn undecided(&self) -> &'static str {
        "the agent parked without deciding"
    }

    fn run(&mut self, core: &mut Core, wake: &Wake, deadline: Option<Instant>) -> RunEnd {
        let mut text = wake_message(core, wake);
        if matches!(wake, Wake::Attention { .. }) {
            // nothing waits on the agent: the wake is handed to it when
            // it is parked, now or at its next abai_wait
            let mut state = self.state();
            if state.wait.is_some() {
                text.push_str(&news_since(core, &mut state.shown));
                state.deliver(&self.out, &text);
            } else {
                state.hold(text);
            }
            return RunEnd::Done;
        }

        // the program waits: the wake goes to the agent as soon as it is
        // parked, and the step lasts until it parks again
        // the requests the client had sent when the wake was handed over:
        // a wait among them was sent before the agent saw the wake, and
        // does not end the step
        let mut delivered: Option<u64> = None;
        loop {
            if delivered.is_none() {
                let mut state = self.state();
                if state.wait.is_some() {
                    let mut all = state.take_held();
                    all.push(text.clone());
                    let mut whole = all.join("\n");
                    whole.push_str(&news_since(core, &mut state.shown));
                    state.deliver(&self.out, &whole);
                    delivered = Some(self.sent.load(Ordering::SeqCst));
                }
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return RunEnd::Done;
            }
            // the program has gone: nothing waits on this step any more
            if !core.program_alive() {
                return RunEnd::Done;
            }
            self.state().expire(&self.out);
            match self.next(TICK) {
                // what the client sent before it went is still answered
                None if self.gone() => {
                    return RunEnd::Unreachable("the MCP client has gone".to_string());
                }
                None => {}
                Some(Request::Cancel(request)) => self.state().cancel(&self.out, &request),
                Some(Request::Call {
                    id,
                    name,
                    arguments,
                    seq,
                }) if name == "abai_wait" => {
                    let parked = self.state().park(&self.out, id, &arguments);
                    if parked && delivered.is_some_and(|mark| seq > mark) {
                        // the agent has parked again: its step is over
                        return RunEnd::Done;
                    }
                }
                Some(Request::Call {
                    id,
                    name,
                    arguments,
                    ..
                }) => self.call(core, &id, &name, &arguments),
            }
        }
    }

    fn user_line(&mut self, core: &mut Core, line: &str) -> RunEnd {
        // a request the channel handed the loop, as it came
        let Ok(request) = serde_json::from_str::<Value>(line) else {
            return RunEnd::Done;
        };
        let (id, arguments) = (&request["id"], &request["arguments"]);
        match request["name"].as_str() {
            Some("abai_wait") => self.park(core, id.clone(), arguments),
            Some(name) if self.names.iter().any(|known| known == name) => {
                self.call(core, id, name, arguments);
            }
            _ => {}
        }
        RunEnd::Done
    }

    fn greeting(&self, core: &Core) -> String {
        format!("serving {} to an MCP client", core.manifest().name)
    }
}

impl UserChannel for McpChannel {
    fn say(&mut self, text: &str) {
        let _ = writeln!(self.log, "abai mcp: {text}");
    }

    fn ask(&mut self, _prompt: &str) -> Option<String> {
        None
    }

    fn confirm(&mut self, _question: &str, _timeout: Duration) -> bool {
        // the client asks the person; the core runs with `auto`
        false
    }

    fn try_line(&mut self, wait: Duration) -> Option<Option<String>> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        // the output could not be written: the client has gone, and
        // nothing more is done for it
        if self.out.broken.load(Ordering::SeqCst) {
            return Some(None);
        }
        state.expire(&self.out);
        let wait = match &state.wait {
            Some(parked) => wait.min(parked.until.saturating_duration_since(Instant::now())),
            None => wait,
        };
        match state.requests.recv_timeout(wait) {
            Ok(Request::Cancel(request)) => {
                state.cancel(&self.out, &request);
                None
            }
            Ok(Request::Call {
                id,
                name,
                arguments,
                ..
            }) => Some(Some(
                json!({"id": id, "name": name, "arguments": arguments}).to_string(),
            )),
            Err(RecvTimeoutError::Timeout) => None,
            // the reading thread has ended: the client has gone. A wait
            // it left parked is answered, like every request.
            Err(RecvTimeoutError::Disconnected) => {
                if let Some(wait) = state.wait.take() {
                    self.out.text(&wait.id, "cancelled", false);
                }
                Some(None)
            }
        }
    }
}
