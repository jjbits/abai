//! A fake aiipd on a Unix socket, for the network tests. Modelled on
//! agents-cowork's internal/aiipclient/fake.go: an in-memory overlay links
//! several fakes into one network, the first member is the authority, and
//! every route answers with the shapes and status codes of aiip's
//! internal/daemon/api.go. Membership routes, peers and leave, and mail:
//! send into another fake's mailbox and a long-polling recv, modelled on
//! handleSend, handleRecv and mailbox.go. Its wire shapes are written out by
//! hand on purpose, so a field name the client gets wrong fails here. Where
//! the fake simplifies: a send to a member that left answers 502 "mailbox
//! gone" (the real daemon, whose node is gone, most likely 503 or 504), the
//! recv wait accepts only `Nms`, `Ns` or `Nm`, and a member that left keeps
//! its endpoints in `peers`.
//!
//! Each fake listens on a thread of its own and answers each connection on
//! another; all fakes of one overlay share one lock.

use std::collections::{HashMap, VecDeque};
use std::io::{ErrorKind, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use super::client::{base64_decode, base64_encode, decode_uri_component};
use super::envelope::random_bytes;

/// aiip's per-membership mailbox cap.
pub const MAILBOX_CAP: usize = 1024;
/// aiip's maxPayload: decoded bytes.
const MAX_PAYLOAD: usize = 1024 * 1024;
/// aiip's maxRecvWait.
const MAX_RECV_WAIT_MS: u64 = 60_000;
/// How often a waiting recv looks at its reader and the clock.
const WAIT_SLICE: Duration = Duration::from_millis(20);
/// How often an idle listener looks for a stop.
const ACCEPT_POLL: Duration = Duration::from_millis(5);

/// A short scratch directory, removed when dropped. A Unix socket path must
/// stay under about 100 bytes, so the name is short.
#[derive(Debug)]
pub struct Scratch(PathBuf);

impl Scratch {
    pub fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("abai-n-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Default for Scratch {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Every request answers this status with a `{error, reason}` envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fault {
    pub status: u16,
    pub error: String,
    pub reason: Option<String>,
}

impl Fault {
    pub fn new(status: u16, error: &str) -> Self {
        Self {
            status,
            error: error.to_string(),
            reason: None,
        }
    }
}

/// A fake's membership.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FakeMember {
    pub name: String,
    pub addr: String,
    pub authority: bool,
    pub lighthouse: bool,
}

#[derive(Debug, Clone)]
struct Slot {
    name: String,
    addr: String,
    /// An authenticated frame reached the authority (the real roster's fact).
    enrolled: bool,
}

#[derive(Debug, Clone)]
struct Invite {
    name: String,
    addr: String,
}

/// One message in a fake's mailbox (aiip's mailbox.go Message).
#[derive(Debug, Clone)]
struct StoredMessage {
    from_name: String,
    from_addr: String,
    payload: Vec<u8>,
    sent_at: String,
    received_at: String,
    broadcast: bool,
}

#[derive(Debug)]
enum Handoff {
    Message(StoredMessage),
    Gone,
}

#[derive(Debug)]
struct Daemon {
    socket_path: PathBuf,
    port: u32,
    started_at: String,
    version: String,
    roster_source: String,
    fault: Option<Fault>,
    delay_ms: u64,
    member: Option<FakeMember>,
    running: bool,
    /// Bumped at each start and stop, so a listener of an earlier life ends.
    generation: u64,
    mailbox: VecDeque<StoredMessage>,
    unreachable: bool,
    chunked: bool,
    /// Pending long-poll recvs, in arrival order.
    waiters: VecDeque<u64>,
    handed: HashMap<u64, Handoff>,
    listener: Option<JoinHandle<()>>,
}

#[derive(Debug)]
struct State {
    network_id: String,
    network_name: String,
    prefix: String,
    slots: Vec<Slot>,
    by_addr: HashMap<String, usize>,
    authority: Option<usize>,
    invites: HashMap<String, Invite>,
    next_host: u32,
    next_port: u32,
    next_ticket: u64,
    daemons: Vec<Daemon>,
}

impl State {
    fn alloc_addr(&mut self) -> String {
        let n = self.next_host;
        self.next_host += 1;
        format!("100.107.{}.{}", n / 256, n % 256)
    }
}

#[derive(Debug)]
struct Shared {
    state: Mutex<State>,
    wake: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// An in-memory network that links fakes.
#[derive(Debug, Clone)]
pub struct FakeOverlay(Arc<Shared>);

impl Default for FakeOverlay {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeOverlay {
    pub fn new() -> Self {
        Self::with_ids("0123456789abcdef0123456789abcdef", "fake")
    }

    pub fn with_ids(network_id: &str, network_name: &str) -> Self {
        Self(Arc::new(Shared {
            state: Mutex::new(State {
                network_id: network_id.to_string(),
                network_name: network_name.to_string(),
                prefix: "100.107.0.0/16".to_string(),
                slots: Vec::new(),
                by_addr: HashMap::new(),
                authority: None,
                invites: HashMap::new(),
                next_host: 2,
                next_port: 4242,
                next_ticket: 1,
                daemons: Vec::new(),
            }),
            wake: Condvar::new(),
        }))
    }

    pub fn network_id(&self) -> String {
        self.0.lock().network_id.clone()
    }

    pub fn network_name(&self) -> String {
        self.0.lock().network_name.clone()
    }

    /// A fake on that socket, not started and not on the network.
    pub fn fake_at(&self, socket_path: &Path) -> FakeAiipd {
        let mut state = self.0.lock();
        let port = state.next_port;
        state.next_port += 1;
        state.daemons.push(Daemon {
            socket_path: socket_path.to_path_buf(),
            port,
            started_at: crate::time::rfc3339(crate::time::now_ms()),
            version: "aiip-m8".to_string(),
            roster_source: "authority".to_string(),
            fault: None,
            delay_ms: 0,
            member: None,
            running: false,
            generation: 0,
            mailbox: VecDeque::new(),
            unreachable: false,
            chunked: false,
            waiters: VecDeque::new(),
            handed: HashMap::new(),
            listener: None,
        });
        FakeAiipd {
            shared: self.0.clone(),
            index: state.daemons.len() - 1,
        }
    }

    /// A fake already enrolled as `name`, started; the first one is the network's authority.
    pub fn new_member(&self, name: &str, socket_path: &Path) -> std::io::Result<FakeAiipd> {
        let fake = self.fake_at(socket_path);
        {
            let mut state = self.0.lock();
            let addr = state.alloc_addr();
            state.slots.push(Slot {
                name: name.to_string(),
                addr: addr.clone(),
                enrolled: true,
            });
            state.by_addr.insert(addr.clone(), fake.index);
            let authority = state.authority.is_none();
            if authority {
                state.authority = Some(fake.index);
            }
            state.daemons[fake.index].member = Some(FakeMember {
                name: name.to_string(),
                addr,
                authority,
                lighthouse: false,
            });
        }
        fake.start()?;
        Ok(fake)
    }

    /// A fake that is not on the network yet, started.
    pub fn new_outsider(&self, socket_path: &Path) -> std::io::Result<FakeAiipd> {
        let fake = self.fake_at(socket_path);
        fake.start()?;
        Ok(fake)
    }
}

/// One fake daemon of an overlay.
#[derive(Clone)]
pub struct FakeAiipd {
    shared: Arc<Shared>,
    index: usize,
}

impl std::fmt::Debug for FakeAiipd {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeAiipd")
            .field("socket_path", &self.socket_path())
            .finish_non_exhaustive()
    }
}

impl FakeAiipd {
    fn with<T>(&self, read: impl FnOnce(&mut Daemon) -> T) -> T {
        let mut state = self.shared.lock();
        read(&mut state.daemons[self.index])
    }

    pub fn socket_path(&self) -> PathBuf {
        self.with(|d| d.socket_path.clone())
    }

    pub fn running(&self) -> bool {
        self.with(|d| d.running)
    }

    pub fn member(&self) -> Option<FakeMember> {
        self.with(|d| d.member.clone())
    }

    /// The member's address; empty when the fake is on no network.
    pub fn addr(&self) -> String {
        self.member().map(|m| m.addr).unwrap_or_default()
    }

    pub fn set_version(&self, version: &str) {
        self.with(|d| d.version = version.to_string());
    }

    pub fn set_roster_source(&self, source: &str) {
        self.with(|d| d.roster_source = source.to_string());
    }

    pub fn set_fault(&self, fault: Option<Fault>) {
        self.with(|d| d.fault = fault);
    }

    /// Every answer waits this long first (a slow daemon).
    pub fn set_delay_ms(&self, delay_ms: u64) {
        self.with(|d| d.delay_ms = delay_ms);
    }

    /// A send to this fake times its dial out (504).
    pub fn set_unreachable(&self, unreachable: bool) {
        self.with(|d| d.unreachable = unreachable);
    }

    /// Answer with chunked bodies instead of a `Content-Length`.
    pub fn set_chunked(&self, chunked: bool) {
        self.with(|d| d.chunked = chunked);
    }

    pub fn mailbox_len(&self) -> usize {
        self.with(|d| d.mailbox.len())
    }

    pub fn clear_mailbox(&self) {
        self.with(|d| d.mailbox.clear());
    }

    pub fn start(&self) -> std::io::Result<()> {
        let mut state = self.shared.lock();
        let daemon = &mut state.daemons[self.index];
        if daemon.running {
            return Ok(());
        }
        if daemon.socket_path.exists() {
            let _ = std::fs::remove_file(&daemon.socket_path);
        }
        let listener = UnixListener::bind(&daemon.socket_path)?;
        listener.set_nonblocking(true)?;
        daemon.running = true;
        daemon.generation += 1;
        let generation = daemon.generation;
        let (shared, index) = (self.shared.clone(), self.index);
        daemon.listener = Some(thread::spawn(move || {
            listen(&shared, index, generation, &listener)
        }));
        Ok(())
    }

    pub fn stop(&self) {
        let (listener, socket_path) = {
            let mut state = self.shared.lock();
            let daemon = &mut state.daemons[self.index];
            if !daemon.running {
                return;
            }
            daemon.running = false;
            daemon.generation += 1;
            daemon.waiters.clear();
            daemon.handed.clear();
            (daemon.listener.take(), daemon.socket_path.clone())
        };
        self.shared.wake.notify_all();
        if let Some(listener) = listener {
            let _ = listener.join();
        }
        let _ = std::fs::remove_file(socket_path);
    }

    /// A message arriving over the overlay, as if a peer sent it; wakes a waiting recv.
    pub fn inject(
        &self,
        from_name: Option<&str>,
        from_addr: &str,
        payload: &[u8],
        broadcast: bool,
    ) {
        let now = crate::time::rfc3339(crate::time::now_ms());
        {
            let mut state = self.shared.lock();
            deliver(
                &mut state.daemons[self.index],
                StoredMessage {
                    from_name: from_name.unwrap_or("").to_string(),
                    from_addr: from_addr.to_string(),
                    payload: payload.to_vec(),
                    sent_at: now.clone(),
                    received_at: now,
                    broadcast,
                },
            );
        }
        self.shared.wake.notify_all();
    }
}

/// Answer the oldest waiting recv with the message, or keep it in the mailbox.
fn deliver(daemon: &mut Daemon, message: StoredMessage) {
    match daemon.waiters.pop_front() {
        Some(ticket) => {
            daemon.handed.insert(ticket, Handoff::Message(message));
        }
        None => daemon.mailbox.push_back(message),
    }
}

fn live(shared: &Shared, index: usize, generation: u64) -> bool {
    let state = shared.lock();
    let daemon = &state.daemons[index];
    daemon.running && daemon.generation == generation
}

fn listen(shared: &Arc<Shared>, index: usize, generation: u64, listener: &UnixListener) {
    while live(shared, index, generation) {
        match listener.accept() {
            Ok((stream, _)) => {
                let shared = shared.clone();
                thread::spawn(move || serve(&shared, index, generation, stream));
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => thread::sleep(ACCEPT_POLL),
            Err(_) => thread::sleep(ACCEPT_POLL),
        }
    }
}

struct Request {
    method: String,
    path: String,
    query: String,
    body: Vec<u8>,
}

fn read_request(stream: &mut UnixStream) -> Option<Request> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    let end = loop {
        if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break end;
        }
        let n = stream.read(&mut buf).ok()?;
        if n == 0 {
            return None;
        }
        raw.extend_from_slice(&buf[..n]);
    };
    let head = String::from_utf8_lossy(&raw[..end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split_whitespace();
    let method = first.next()?.to_string();
    let target = first.next()?.to_string();
    let length = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = raw[end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut buf).ok()?;
        if n == 0 {
            return None;
        }
        body.extend_from_slice(&buf[..n]);
    }
    body.truncate(length);
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (target, String::new()),
    };
    Some(Request {
        method,
        path,
        query,
        body,
    })
}

enum Reply {
    Json(u16, Value),
    NoContent,
    Wait { ticket: u64, deadline: Instant },
}

fn serve(shared: &Shared, index: usize, generation: u64, mut stream: UnixStream) {
    let Some(request) = read_request(&mut stream) else {
        return;
    };
    let delay = shared.lock().daemons[index].delay_ms;
    if delay > 0 {
        thread::sleep(Duration::from_millis(delay));
    }
    let (reply, chunked) = {
        let mut state = shared.lock();
        let daemon = &state.daemons[index];
        if !daemon.running || daemon.generation != generation {
            return;
        }
        let chunked = daemon.chunked;
        (route(&mut state, index, &request), chunked)
    };
    shared.wake.notify_all();
    match reply {
        Reply::Json(status, value) => write_json(&mut stream, status, &value, chunked),
        Reply::NoContent => write_no_content(&mut stream),
        Reply::Wait { ticket, deadline } => {
            wait(
                shared,
                index,
                generation,
                &mut stream,
                ticket,
                deadline,
                chunked,
            );
        }
    }
}

/// A waiting recv: answered by a handed message, a leave, or the clock; a
/// reader that hangs up stops waiting, so a later message is not written to
/// a closed connection.
fn wait(
    shared: &Shared,
    index: usize,
    generation: u64,
    stream: &mut UnixStream,
    ticket: u64,
    deadline: Instant,
    chunked: bool,
) {
    let mut state = shared.lock();
    loop {
        let daemon = &mut state.daemons[index];
        if let Some(handoff) = daemon.handed.remove(&ticket) {
            drop(state);
            match handoff {
                Handoff::Message(message) => {
                    write_json(stream, 200, &message_json(&message), chunked);
                }
                Handoff::Gone => {
                    write_json(
                        stream,
                        410,
                        &json!({ "error": "membership removed" }),
                        chunked,
                    );
                }
            }
            return;
        }
        if !daemon.running || daemon.generation != generation {
            return;
        }
        if Instant::now() >= deadline {
            daemon.waiters.retain(|t| *t != ticket);
            drop(state);
            write_no_content(stream);
            return;
        }
        if hung_up(stream) {
            daemon.waiters.retain(|t| *t != ticket);
            return;
        }
        let slice = deadline
            .saturating_duration_since(Instant::now())
            .min(WAIT_SLICE);
        state = shared
            .wake
            .wait_timeout(state, slice)
            .map(|(guard, _)| guard)
            .unwrap_or_else(|poisoned| poisoned.into_inner().0);
    }
}

/// The reader closed its end: a peek without waiting reads the end of the stream, or fails.
fn hung_up(stream: &UnixStream) -> bool {
    let mut probe = [0u8; 1];
    // SAFETY: the descriptor is the stream's own, open for the call; the buffer is valid for one byte.
    let n = unsafe {
        libc::recv(
            stream.as_raw_fd(),
            probe.as_mut_ptr().cast(),
            1,
            libc::MSG_PEEK | libc::MSG_DONTWAIT,
        )
    };
    match n {
        0 => true,
        n if n > 0 => false,
        _ => std::io::Error::last_os_error().kind() != ErrorKind::WouldBlock,
    }
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        410 => "Gone",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Status",
    }
}

fn write_json(stream: &mut UnixStream, status: u16, value: &Value, chunked: bool) {
    let text = value.to_string();
    let reason = reason_phrase(status);
    let out = if chunked {
        let mut out = format!(
            "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n"
        )
        .into_bytes();
        for piece in text.as_bytes().chunks(7) {
            out.extend_from_slice(format!("{:x}\r\n", piece.len()).as_bytes());
            out.extend_from_slice(piece);
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(b"0\r\n\r\n");
        out
    } else {
        let mut out = format!(
            "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            text.len()
        )
        .into_bytes();
        out.extend_from_slice(text.as_bytes());
        out
    };
    let _ = stream.write_all(&out);
}

fn write_no_content(stream: &mut UnixStream) {
    let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n");
}

fn message_json(m: &StoredMessage) -> Value {
    let mut out = json!({
        "from": { "name": m.from_name, "addr": m.from_addr },
        "payloadB64": base64_encode(&m.payload),
        "sentAt": m.sent_at,
        "receivedAt": m.received_at,
    });
    if m.broadcast {
        out["broadcast"] = Value::Bool(true);
    }
    out
}

fn error_json(status: u16, error: impl Into<String>) -> Reply {
    Reply::Json(status, json!({ "error": error.into() }))
}

fn quoted(text: &str) -> String {
    Value::from(text).to_string()
}

fn membership_json(state: &State, index: usize) -> Value {
    let daemon = &state.daemons[index];
    let Some(m) = &daemon.member else {
        return Value::Null;
    };
    let mut out = Map::new();
    out.insert("networkID".into(), Value::from(state.network_id.clone()));
    out.insert(
        "networkName".into(),
        Value::from(state.network_name.clone()),
    );
    out.insert("prefix".into(), Value::from(state.prefix.clone()));
    out.insert("selfName".into(), Value::from(m.name.clone()));
    out.insert("selfAddr".into(), Value::from(m.addr.clone()));
    out.insert("underlayPort".into(), Value::from(daemon.port));
    out.insert("authority".into(), Value::from(m.authority));
    if m.lighthouse {
        out.insert("lighthouse".into(), Value::from(true));
    }
    out.insert(
        "peers".into(),
        Value::from(state.slots.len().saturating_sub(1)),
    );
    Value::Object(out)
}

/// aiip's resolveNet: the id, a unique name, or an id prefix of 8 or more characters.
fn resolves_net(state: &State, index: usize, reference: &str) -> bool {
    if state.daemons[index].member.is_none() {
        return false;
    }
    reference == state.network_id
        || reference == state.network_name
        || (reference.len() >= 8 && state.network_id.starts_with(reference))
}

/// The request body as a JSON object; an empty body is `{}`.
fn parse_body(body: &[u8]) -> Result<Map<String, Value>, Reply> {
    let text = String::from_utf8_lossy(body);
    let text = if text.is_empty() { "{}" } else { &text };
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Ok(Map::new()),
        Err(error) => Err(error_json(400, format!("bad request body: {error}"))),
    }
}

/// A non-empty string field.
fn field<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn route(state: &mut State, index: usize, request: &Request) -> Reply {
    if let Some(fault) = &state.daemons[index].fault {
        let mut out = json!({ "error": fault.error });
        if let Some(reason) = &fault.reason {
            out["reason"] = Value::from(reason.clone());
        }
        return Reply::Json(fault.status, out);
    }
    let method = request.method.as_str();
    let path = request.path.as_str();
    match (method, path) {
        ("GET", "/v1/status") => {
            let daemon = &state.daemons[index];
            return Reply::Json(
                200,
                json!({
                    "version": daemon.version,
                    "pid": std::process::id(),
                    "stateDir": "(fake)",
                    "startedAt": daemon.started_at,
                    "memberships": u32::from(daemon.member.is_some()),
                }),
            );
        }
        ("GET", "/v1/networks") => {
            let list = if state.daemons[index].member.is_some() {
                vec![membership_json(state, index)]
            } else {
                Vec::new()
            };
            return Reply::Json(200, Value::Array(list));
        }
        ("POST", "/v1/networks") => return create(state, index, &request.body),
        ("POST", "/v1/join") => return join(state, index, &request.body),
        _ => {}
    }
    if let Some(rest) = path.strip_prefix("/v1/networks/") {
        let (reference, sub) = match rest.split_once('/') {
            Some((reference, sub)) => (reference, Some(sub)),
            None => (rest, None),
        };
        let known = matches!(
            sub,
            None | Some("invites" | "members" | "peers" | "send" | "recv")
        );
        if !reference.is_empty() && known {
            let reference = decode_uri_component(reference);
            if !resolves_net(state, index, &reference) {
                return error_json(404, format!("no membership matches {}", quoted(&reference)));
            }
            match (sub, method) {
                (Some("invites"), "POST") => return invite(state, index, &request.body),
                (Some("members"), "GET") => return members(state, index),
                (Some("peers"), "GET") => return peers(state, index),
                (Some("send"), "POST") => return send(state, index, &request.body),
                (Some("recv"), "GET") => return recv(state, index, &request.query),
                (None, "DELETE") => {
                    // leave is local: the authority is not told, the slot stays as it was; the daemon stays at its
                    // address and refuses mail for the gone membership (502 mailbox gone)
                    let daemon = &mut state.daemons[index];
                    daemon.member = None;
                    daemon.mailbox.clear();
                    while let Some(ticket) = daemon.waiters.pop_front() {
                        daemon.handed.insert(ticket, Handoff::Gone);
                    }
                    return Reply::NoContent;
                }
                _ => {}
            }
        }
    }
    error_json(404, "404 page not found")
}

fn create(state: &mut State, index: usize, body: &[u8]) -> Reply {
    let req = match parse_body(body) {
        Ok(req) => req,
        Err(reply) => return reply,
    };
    let (Some(name), Some(as_name)) = (field(&req, "name"), field(&req, "as")) else {
        return error_json(400, "name and as are required");
    };
    if state.daemons[index].member.is_some() {
        return error_json(409, "already a member of this network");
    }
    if state.authority.is_some() {
        // a simplification of the fake, which carries one network: aiipd mints a fresh network id on every
        // create and holds the new membership beside the old ones; no test relies on this 409
        return error_json(409, "fake overlay already carries its one network");
    }
    let addr = state.alloc_addr();
    state.network_name = name.to_string();
    state.slots.push(Slot {
        name: as_name.to_string(),
        addr: addr.clone(),
        enrolled: true,
    });
    state.by_addr.insert(addr.clone(), index);
    state.authority = Some(index);
    state.daemons[index].member = Some(FakeMember {
        name: as_name.to_string(),
        addr,
        authority: true,
        lighthouse: req.get("lighthouse") == Some(&Value::Bool(true)),
    });
    Reply::Json(201, membership_json(state, index))
}

fn invite(state: &mut State, index: usize, body: &[u8]) -> Reply {
    let req = match parse_body(body) {
        Ok(req) => req,
        Err(reply) => return reply,
    };
    let Some(for_name) = field(&req, "for") else {
        return error_json(400, "for is required");
    };
    let Some(m) = state.daemons[index].member.clone() else {
        return error_json(404, "404 page not found");
    };
    if !m.authority {
        return error_json(403, "this daemon is not the network's authority");
    }
    if for_name == m.name {
        return error_json(
            409,
            format!(
                "{} is this member's own name: already a member of this network",
                quoted(for_name)
            ),
        );
    }
    let addr = match state.slots.iter().find(|s| s.name == for_name) {
        Some(slot) if slot.enrolled => {
            return error_json(
                409,
                format!(
                    "{} is already a member: already a member of this network",
                    quoted(for_name)
                ),
            );
        }
        Some(slot) => slot.addr.clone(),
        None => {
            let addr = state.alloc_addr();
            state.slots.push(Slot {
                name: for_name.to_string(),
                addr: addr.clone(),
                enrolled: false,
            });
            addr
        }
    };
    let hex: String = random_bytes(12)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let token = format!("fake-invite-{hex}");
    state.invites.insert(
        token.clone(),
        Invite {
            name: for_name.to_string(),
            addr: addr.clone(),
        },
    );
    Reply::Json(
        201,
        json!({ "token": token, "name": for_name, "addr": addr }),
    )
}

fn join(state: &mut State, index: usize, body: &[u8]) -> Reply {
    let req = match parse_body(body) {
        Ok(req) => req,
        Err(reply) => return reply,
    };
    let Some(token) = field(&req, "token") else {
        return error_json(400, "token is required");
    };
    let Some(invite) = state.invites.get(token).cloned() else {
        return error_json(400, "token: unrecognized invite token");
    };
    if state.daemons[index].member.is_some() {
        return error_json(409, "already a member of this network");
    }
    // aiipd refuses a join only when this daemon already holds that network; a slot another daemon enrolled
    // is not checked here (the real check is the tunnel's certificate), so the fake does not refuse it either
    if let Some(authority) = state.authority {
        let inviter = &state.daemons[authority];
        if !(inviter.running && inviter.member.is_some()) {
            let name = inviter
                .member
                .as_ref()
                .map_or("?".to_string(), |m| m.name.clone());
            return error_json(
                502,
                format!("could not reach inviter {name} at [fake]: context deadline exceeded"),
            );
        }
    }
    if let Some(slot) = state.slots.iter_mut().find(|s| s.name == invite.name) {
        slot.enrolled = true;
    }
    state.by_addr.insert(invite.addr.clone(), index);
    state.daemons[index].member = Some(FakeMember {
        name: invite.name,
        addr: invite.addr,
        authority: false,
        lighthouse: false,
    });
    Reply::Json(201, membership_json(state, index))
}

fn members(state: &State, index: usize) -> Reply {
    let me = state.daemons[index]
        .member
        .as_ref()
        .map(|m| m.addr.clone())
        .unwrap_or_default();
    let members: Vec<Value> = state
        .slots
        .iter()
        .map(|s| {
            let mut out = json!({ "name": s.name, "addr": s.addr, "enrolled": s.enrolled });
            if s.addr == me {
                out["self"] = Value::Bool(true);
            }
            out
        })
        .collect();
    let source = state.daemons[index].roster_source.clone();
    Reply::Json(200, json!({ "members": members, "source": source }))
}

fn peers(state: &State, index: usize) -> Reply {
    let Some(m) = state.daemons[index].member.clone() else {
        return error_json(404, "404 page not found");
    };
    let peers: Vec<Value> = state
        .slots
        .iter()
        .filter(|s| s.addr != m.addr)
        .map(|s| {
            let other = state.by_addr.get(&s.addr).map(|&i| &state.daemons[i]);
            let alive = other.is_some_and(|o| o.running && o.member.is_some());
            let mut out = Map::new();
            out.insert("name".into(), Value::from(s.name.clone()));
            out.insert("addr".into(), Value::from(s.addr.clone()));
            if let Some(other) = other {
                out.insert(
                    "endpoints".into(),
                    json!([format!("127.0.0.1:{}", other.port)]),
                );
            }
            if s.enrolled {
                out.insert("enrolled".into(), Value::Bool(true));
            }
            out.insert("established".into(), Value::Bool(alive));
            if let (true, Some(other)) = (alive, other) {
                out.insert(
                    "currentRemote".into(),
                    Value::from(format!("127.0.0.1:{}", other.port)),
                );
            }
            Value::Object(out)
        })
        .collect();
    let port = state.daemons[index].port;
    Reply::Json(
        200,
        json!({
            "self": { "name": m.name, "addr": m.addr, "endpoints": [format!("127.0.0.1:{port}")] },
            "peers": peers,
        }),
    )
}

/// Strict standard base64 with padding, as Go's decoder takes it.
fn strict_base64(text: &str) -> bool {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return false;
    }
    let letter = |b: u8| b.is_ascii_alphanumeric() || b == b'+' || b == b'/';
    let pad = if bytes.ends_with(b"==") {
        2
    } else if bytes.ends_with(b"=") {
        1
    } else {
        0
    };
    bytes[..bytes.len() - pad].iter().all(|&b| letter(b))
}

fn send(state: &mut State, index: usize, body: &[u8]) -> Reply {
    let req = match parse_body(body) {
        Ok(req) => req,
        Err(reply) => return reply,
    };
    let Some(to) = field(&req, "to") else {
        return error_json(400, "to is required");
    };
    let b64 = req.get("payloadB64").and_then(Value::as_str).unwrap_or("");
    if !strict_base64(b64) {
        return error_json(400, "bad payloadB64: illegal base64 data");
    }
    let payload = base64_decode(b64);
    if payload.len() > MAX_PAYLOAD {
        return error_json(
            400,
            format!(
                "payload of {} bytes exceeds the {MAX_PAYLOAD} byte cap",
                payload.len()
            ),
        );
    }
    let Some(slot) = state
        .slots
        .iter()
        .find(|s| s.name == to || s.addr == to)
        .cloned()
    else {
        return error_json(404, format!("no known peer named {}", quoted(to)));
    };
    let Some(&target) = state.by_addr.get(&slot.addr) else {
        return Reply::Json(
            503,
            json!({ "error": format!("no known endpoints for {}", slot.name), "reason": "no-known-endpoints" }),
        );
    };
    let target_daemon = &state.daemons[target];
    if target_daemon.unreachable || !target_daemon.running {
        return error_json(
            504,
            format!("dial {}:4747: context deadline exceeded", slot.addr),
        );
    }
    if target_daemon.member.is_none() {
        return error_json(502, "peer refused message: mailbox gone");
    }
    if target_daemon.mailbox.len() >= MAILBOX_CAP {
        return error_json(502, "peer refused message: mailbox full");
    }
    let Some(m) = state.daemons[index].member.clone() else {
        return error_json(404, "404 page not found");
    };
    let now = crate::time::rfc3339(crate::time::now_ms());
    let port = state.daemons[target].port;
    deliver(
        &mut state.daemons[target],
        StoredMessage {
            from_name: m.name,
            from_addr: m.addr,
            payload,
            sent_at: now.clone(),
            received_at: now,
            broadcast: false,
        },
    );
    Reply::Json(
        200,
        json!({
            "to": { "name": slot.name, "addr": slot.addr, "enrolled": true, "endpoints": [format!("127.0.0.1:{port}")] },
        }),
    )
}

fn recv(state: &mut State, index: usize, query: &str) -> Reply {
    let raw = query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == "wait")
        .map(|(_, value)| decode_uri_component(value));
    let mut wait_ms = 1;
    if let Some(raw) = raw.filter(|r| !r.is_empty()) {
        let split = raw.find(|c: char| !c.is_ascii_digit()).unwrap_or(raw.len());
        let (number, unit) = raw.split_at(split);
        let scale = match unit {
            "ms" => Some(1),
            "s" => Some(1_000),
            "m" => Some(60_000),
            _ => None,
        };
        match (number.parse::<u64>(), scale) {
            (Ok(n), Some(scale)) if !number.is_empty() => {
                wait_ms = n.saturating_mul(scale).min(MAX_RECV_WAIT_MS);
            }
            _ => return error_json(400, format!("bad wait duration {}", quoted(&raw))),
        }
    }
    let daemon = &mut state.daemons[index];
    if let Some(next) = daemon.mailbox.pop_front() {
        return Reply::Json(200, message_json(&next));
    }
    let ticket = state.next_ticket;
    state.next_ticket += 1;
    state.daemons[index].waiters.push_back(ticket);
    Reply::Wait {
        ticket,
        deadline: Instant::now() + Duration::from_millis(wait_ms),
    }
}
