//! A client of aiipd, the aiip daemon, over its Unix-socket HTTP/JSON API
//! (abaigrammar section 7, `network`; aiip's internal/daemon/api.go). The
//! harness uses the membership half of the API: who this run is on which
//! network, who else is enrolled, and who is reachable now; and the mail
//! half: send to a member and take the next message from the mailbox.
//!
//! One request is one connection: the request is written by hand, the
//! answer read to its `Content-Length`, to the end of a chunked body, or to
//! the end of the connection. A request waits in slices of a quarter
//! second, so a raised stop flag ends it within that time.

use std::io::{ErrorKind, Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The daemon's socket, under its state directory.
pub const AIIP_SOCKET_NAME: &str = "aiipd.sock";
/// The API version string this harness was written against (`GET /v1/status`).
pub const KNOWN_AIIP_API: &str = "aiip-m8";
/// The daemon refuses a longer socket path (macOS allows about 104 bytes; aiip stops at 100).
pub const AIIP_SOCKET_PATH_MAX: usize = 100;
/// The daemon caps request bodies at 2 MiB; answers are read to the same cap.
pub const AIIP_BODY_CAP: usize = 2 * 1024 * 1024;

pub const AIIP_REQUEST_TIMEOUT_MS: u64 = 10_000;
/// How long `status` waits by default.
pub const AIIP_STATUS_TIMEOUT_MS: u64 = 2_000;
/// A plain join returns after a hello round trip to the inviter; the aiip CLI allows a minute.
pub const AIIP_JOIN_TIMEOUT_MS: u64 = 60_000;
/// A member fetches the roster from the authority, bounded to 35 s on the daemon's side.
pub const AIIP_MEMBERS_TIMEOUT_MS: u64 = 40_000;
/// A send dials the member and waits for its daemon's ack, within the daemon's 30 s dial budget; the aiip CLI allows a minute.
pub const AIIP_SEND_TIMEOUT_MS: u64 = 60_000;
/// One long-poll of the mailbox; the daemon caps a wait at 60 s.
pub const AIIP_RECV_WAIT_MS: u64 = 45_000;
pub const AIIP_RECV_WAIT_MAX_MS: u64 = 60_000;
/// The daemon caps a mail payload at 1 MiB of decoded bytes.
pub const AIIP_PAYLOAD_CAP: usize = 1024 * 1024;

/// The longest a read or write waits before the stop flag and the deadline are checked again.
const SLICE: Duration = Duration::from_millis(250);
/// How soon a connect that the daemon did not take is tried again.
const CONNECT_RETRY: Duration = Duration::from_millis(10);
/// The longest answer head this client reads.
const HEAD_CAP: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiipStatus {
    pub version: String,
    pub pid: u32,
    pub state_dir: String,
    pub started_at: String,
    pub memberships: u32,
}

/// One membership of the daemon's state dir (aiip's MembershipInfo).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiipMembership {
    #[serde(rename = "networkID")]
    pub network_id: String,
    pub network_name: String,
    pub prefix: String,
    pub self_name: String,
    pub self_addr: String,
    pub underlay_port: u32,
    pub authority: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lighthouse: Option<bool>,
    pub peers: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_establish: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renewal_stopped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renewal_verdict: Option<String>,
}

/// What a join answers: the new membership, plus a pairing session for a punch token (not used here).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AiipJoinResult {
    #[serde(flatten)]
    pub membership: AiipMembership,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pairing: Option<Value>,
}

/// An invite. The token is a bearer secret carrying the invitee's private
/// key: keep it out of argv, logs and files. `Debug` does not show it.
#[derive(Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AiipInvite {
    pub token: String,
    pub name: String,
    pub addr: String,
}

impl std::fmt::Debug for AiipInvite {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AiipInvite")
            .field("token", &"(set)")
            .field("name", &self.name)
            .field("addr", &self.addr)
            .finish()
    }
}

/// A slot the authority issued; `enrolled` is the authority's fact, `self` marks the answering daemon.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AiipMember {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub addr: String,
    pub enrolled: bool,
    #[serde(rename = "self", skip_serializing_if = "Option::is_none")]
    pub self_: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AiipMembers {
    pub members: Vec<AiipMember>,
    /// `authority` when fetched fresh, `cached` when the authority was unreachable.
    pub source: String,
}

/// A peer as this daemon knows it; a `name_claimed` name was declared by the peer itself and does not route.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiipPeer {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub addr: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_claimed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoints: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enrolled: Option<bool>,
}

/// A peer with live tunnel evidence from this node.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiipPeerDetail {
    #[serde(flatten)]
    pub peer: AiipPeer,
    pub established: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relays_to_me: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_cert_fingerprint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AiipPeers {
    #[serde(rename = "self")]
    pub self_: AiipPeer,
    pub peers: Vec<AiipPeerDetail>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct CreateNetworkRequest {
    pub name: String,
    /// The member name the creator takes (`as` on the wire).
    pub as_: String,
    /// Serve the network as lighthouse and relay; needs an address other members can reach.
    pub lighthouse: bool,
}

/// `POST /v1/networks/{net}/send`: the member the message reached.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AiipSendResult {
    pub to: AiipPeer,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(default)]
struct WireFrom {
    name: Option<String>,
    addr: String,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AiipWireMessage {
    from: WireFrom,
    #[serde(rename = "payloadB64")]
    payload_b64: Option<String>,
    sent_at: String,
    received_at: String,
    broadcast: Option<bool>,
}

/// Who a message came from. `name` is only what the sender claimed; `addr` is authenticated.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AiipSender {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub addr: String,
}

/// One message taken from the mailbox.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AiipMessage {
    pub from: AiipSender,
    pub payload: Vec<u8>,
    pub sent_at: String,
    pub received_at: String,
    pub broadcast: bool,
}

/// A request the daemon refused or could not be made. `status` is the HTTP
/// status, 0 when no daemon answered at the socket; `reason` is the daemon's
/// stable code where it gives one (`no-known-endpoints`), or this client's
/// own: `unreachable`, `timeout`, `aborted`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiipError {
    pub status: u16,
    pub message: String,
    pub reason: Option<String>,
}

impl AiipError {
    pub fn new(status: u16, message: impl Into<String>, reason: Option<&str>) -> Self {
        Self {
            status,
            message: message.into(),
            reason: reason.map(str::to_string),
        }
    }

    /// No daemon answered at the socket (a timeout or a caller's abort is not this).
    pub fn unreachable(&self) -> bool {
        self.reason.as_deref() == Some("unreachable")
    }
}

impl std::fmt::Display for AiipError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AiipError {}

/// The daemon's 409 for an identity already enrolled: a join of a network this state dir is on, or an invite for a member's own name.
pub fn is_already_member(error: &AiipError) -> bool {
    error.status == 409 && error.message.to_lowercase().contains("already a member")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiipClient {
    pub socket_path: PathBuf,
}

impl AiipClient {
    pub fn new(socket_path: impl Into<PathBuf>) -> Self {
        Self {
            socket_path: socket_path.into(),
        }
    }

    pub fn status(&self) -> Result<AiipStatus, AiipError> {
        self.status_with(AIIP_STATUS_TIMEOUT_MS, None)
    }

    pub fn status_with(
        &self,
        timeout_ms: u64,
        stop: Option<&AtomicBool>,
    ) -> Result<AiipStatus, AiipError> {
        self.call_as("GET", "/v1/status", None, timeout_ms, stop)
    }

    pub fn networks(&self) -> Result<Vec<AiipMembership>, AiipError> {
        self.call_as("GET", "/v1/networks", None, AIIP_REQUEST_TIMEOUT_MS, None)
    }

    pub fn create(&self, req: &CreateNetworkRequest) -> Result<AiipMembership, AiipError> {
        let body = json!({ "name": req.name, "as": req.as_, "lighthouse": req.lighthouse });
        self.call_as(
            "POST",
            "/v1/networks",
            Some(&body),
            AIIP_REQUEST_TIMEOUT_MS,
            None,
        )
    }

    pub fn invite(&self, net: &str, for_name: &str) -> Result<AiipInvite, AiipError> {
        let path = format!("/v1/networks/{}/invites", encode_uri_component(net));
        let body = json!({ "for": for_name });
        self.call_as("POST", &path, Some(&body), AIIP_REQUEST_TIMEOUT_MS, None)
    }

    /// Join with an invite token. Synchronous on the daemon's side: it returns after the hello to the inviter.
    pub fn join(&self, token: &str) -> Result<AiipJoinResult, AiipError> {
        let body = json!({ "token": token });
        self.call_as("POST", "/v1/join", Some(&body), AIIP_JOIN_TIMEOUT_MS, None)
    }

    pub fn members(&self, net: &str) -> Result<AiipMembers, AiipError> {
        self.members_with(net, AIIP_MEMBERS_TIMEOUT_MS, None)
    }

    pub fn members_with(
        &self,
        net: &str,
        timeout_ms: u64,
        stop: Option<&AtomicBool>,
    ) -> Result<AiipMembers, AiipError> {
        let path = format!("/v1/networks/{}/members", encode_uri_component(net));
        self.call_as("GET", &path, None, timeout_ms, stop)
    }

    pub fn peers(&self, net: &str) -> Result<AiipPeers, AiipError> {
        let path = format!("/v1/networks/{}/peers", encode_uri_component(net));
        self.call_as("GET", &path, None, AIIP_REQUEST_TIMEOUT_MS, None)
    }

    /// Leave a network: local only, the authority is not told.
    pub fn leave(&self, net: &str) -> Result<(), AiipError> {
        let path = format!("/v1/networks/{}", encode_uri_component(net));
        self.call("DELETE", &path, None, AIIP_REQUEST_TIMEOUT_MS, None)?;
        Ok(())
    }

    /// Send a payload to a member, by the name the authority issued or by
    /// address. Synchronous on the daemon's side: a result means the member's
    /// daemon took the message into its mailbox and acked. Refusals come as
    /// `AiipError`: 404 no such member or network, 409 an ambiguous name, 502
    /// the member's daemon refused it (mailbox full or gone), 503 no route to
    /// the member, 504 the dial budget ran out.
    pub fn send(
        &self,
        net: &str,
        to: &str,
        payload: &[u8],
        stop: Option<&AtomicBool>,
    ) -> Result<AiipSendResult, AiipError> {
        if payload.len() > AIIP_PAYLOAD_CAP {
            return Err(AiipError::new(
                0,
                format!(
                    "payload of {} bytes exceeds the daemon's {AIIP_PAYLOAD_CAP} byte cap",
                    payload.len()
                ),
                None,
            ));
        }
        let path = format!("/v1/networks/{}/send", encode_uri_component(net));
        let body = json!({ "to": to, "payloadB64": base64_encode(payload) });
        self.call_as("POST", &path, Some(&body), AIIP_SEND_TIMEOUT_MS, stop)
    }

    /// Take the next message from the membership's mailbox, waiting up to
    /// `wait_ms` (default 45 s, capped at the daemon's 60 s) for one; `None`
    /// when none arrived. The read removes the message: whoever calls this
    /// owns it. 410 when the membership was removed meanwhile.
    pub fn recv(
        &self,
        net: &str,
        wait_ms: Option<u64>,
        stop: Option<&AtomicBool>,
    ) -> Result<Option<AiipMessage>, AiipError> {
        let wait_ms = wait_ms
            .unwrap_or(AIIP_RECV_WAIT_MS)
            .clamp(1, AIIP_RECV_WAIT_MAX_MS);
        let path = format!(
            "/v1/networks/{}/recv?wait={wait_ms}ms",
            encode_uri_component(net)
        );
        let (status, value) = self.call("GET", &path, None, wait_ms + 15_000, stop)?;
        let Some(value) = value else {
            return Ok(None);
        };
        let raw: AiipWireMessage = shaped(status, value)?;
        // the daemon leaves the name out when the sender claimed none; a fake may write it empty
        let name = raw.from.name.filter(|name| !name.is_empty());
        Ok(Some(AiipMessage {
            from: AiipSender {
                name,
                addr: raw.from.addr,
            },
            payload: base64_decode(raw.payload_b64.as_deref().unwrap_or("")),
            sent_at: raw.sent_at,
            received_at: raw.received_at,
            broadcast: raw.broadcast == Some(true),
        }))
    }

    fn call_as<T: DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        timeout_ms: u64,
        stop: Option<&AtomicBool>,
    ) -> Result<T, AiipError> {
        let (status, value) = self.call(method, path, body, timeout_ms, stop)?;
        shaped(status, value.unwrap_or(Value::Null))
    }

    /// One request: the status and the parsed body, `None` for 204 or an empty body.
    fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        timeout_ms: u64,
        stop: Option<&AtomicBool>,
    ) -> Result<(u16, Option<Value>), AiipError> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let aborted = || stop.is_some_and(|flag| flag.load(Ordering::SeqCst));
        if aborted() {
            return Err(self.aborted());
        }
        let mut stream = self.connect(deadline, &aborted)?;
        let payload = body.map(Value::to_string);
        let mut request = format!(
            "{method} {path} HTTP/1.1\r\nHost: aiipd\r\nAccept: application/json\r\nConnection: close\r\n"
        );
        if let Some(payload) = &payload {
            request.push_str(&format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                payload.len()
            ));
        }
        request.push_str("\r\n");
        let mut bytes = request.into_bytes();
        if let Some(payload) = payload {
            bytes.extend_from_slice(payload.as_bytes());
        }
        self.write_all(&mut stream, &bytes, deadline, &aborted)?;
        let (status, body) = self.read_answer(&mut stream, method, deadline, &aborted)?;
        let text = String::from_utf8_lossy(&body);
        if (200..300).contains(&status) {
            if status == 204 || text.is_empty() {
                return Ok((status, None));
            }
            return match serde_json::from_str::<Value>(&text) {
                Ok(value) => Ok((status, Some(value))),
                Err(_) => Err(AiipError::new(
                    status,
                    format!("the daemon answered {status} with a body that is not JSON"),
                    None,
                )),
            };
        }
        Err(error_from(status, &text))
    }

    /// Connect to the daemon's socket, within the request's time. The
    /// socket is made non-blocking for the connect: a daemon that is there
    /// but does not accept (its queue is full) would hold a plain connect
    /// for as long as it likes.
    fn connect(
        &self,
        deadline: Instant,
        aborted: &dyn Fn() -> bool,
    ) -> Result<UnixStream, AiipError> {
        let os_error = |this: &Self| {
            let error = std::io::Error::last_os_error();
            this.transport_error(&error, aborted(), deadline)
        };
        let path = self.socket_path.as_os_str().as_bytes();
        // SAFETY: an all-zero `sockaddr_un` is a valid value of the type.
        let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        if path.len() >= address.sun_path.len() || path.contains(&0) {
            return Err(self.unreachable_with("ENAMETOOLONG"));
        }
        address.sun_family = libc::AF_UNIX as libc::sa_family_t;
        for (to, from) in address.sun_path.iter_mut().zip(path) {
            *to = *from as libc::c_char;
        }
        // closed on exec from the start where the system can: a program
        // started on another thread meanwhile must not inherit it
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let kind = libc::SOCK_STREAM | libc::SOCK_CLOEXEC;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        let kind = libc::SOCK_STREAM;
        // SAFETY: a plain system call; the result is checked.
        let fd = unsafe { libc::socket(libc::AF_UNIX, kind, 0) };
        if fd < 0 {
            return Err(os_error(self));
        }
        // SAFETY: `fd` is a socket this call has just made and nothing else
        // holds; from here the stream owns and closes it.
        let stream = unsafe { UnixStream::from_raw_fd(fd) };
        // SAFETY: `fd` is open, owned by `stream`; `on` outlives the call.
        unsafe {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
            // as the standard library's sockets: a write to a daemon that
            // has closed is an error, never a signal
            #[cfg(target_vendor = "apple")]
            {
                let on: libc::c_int = 1;
                libc::setsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    libc::SO_NOSIGPIPE,
                    (&raw const on).cast(),
                    std::mem::size_of::<libc::c_int>() as libc::socklen_t,
                );
            }
        }
        stream
            .set_nonblocking(true)
            .map_err(|error| self.transport_error(&error, aborted(), deadline))?;
        let length = std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
        loop {
            if aborted() {
                return Err(self.aborted());
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(self.timed_out());
            }
            // SAFETY: `address` is a whole `sockaddr_un` and `length` its size.
            let done = unsafe { libc::connect(fd, (&raw const address).cast(), length) };
            if done == 0 {
                break;
            }
            match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::EISCONN) => break,
                Some(libc::EINTR) => {}
                // the daemon's queue is full, or the connect is under way:
                // look again shortly, until the request's time is up
                Some(libc::EAGAIN | libc::EINPROGRESS | libc::EALREADY) => {
                    std::thread::sleep(left.min(CONNECT_RETRY));
                }
                _ => return Err(os_error(self)),
            }
        }
        stream
            .set_nonblocking(false)
            .map_err(|error| self.transport_error(&error, aborted(), deadline))?;
        Ok(stream)
    }

    fn write_all(
        &self,
        stream: &mut UnixStream,
        mut bytes: &[u8],
        deadline: Instant,
        aborted: &dyn Fn() -> bool,
    ) -> Result<(), AiipError> {
        while !bytes.is_empty() {
            if aborted() {
                return Err(self.aborted());
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(self.timed_out());
            }
            let _ = stream.set_write_timeout(Some(left.min(SLICE)));
            match stream.write(bytes) {
                Ok(0) => {
                    return Err(self.unreachable_with("EPIPE"));
                }
                Ok(n) => bytes = &bytes[n..],
                Err(error)
                    if matches!(
                        error.kind(),
                        ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                    ) => {}
                Err(error) => return Err(self.transport_error(&error, aborted(), deadline)),
            }
        }
        Ok(())
    }

    /// Reads the answer: its status and its body, decoded when chunked.
    fn read_answer(
        &self,
        stream: &mut UnixStream,
        method: &str,
        deadline: Instant,
        aborted: &dyn Fn() -> bool,
    ) -> Result<(u16, Vec<u8>), AiipError> {
        let mut raw: Vec<u8> = Vec::new();
        let mut head: Option<Head> = None;
        let mut buf = vec![0u8; 16 * 1024];
        let mut ended = false;
        loop {
            if head.is_none()
                && let Some(end) = find_head_end(&raw)
            {
                let parsed = parse_head(&raw[..end])
                    .ok_or_else(|| self.unreachable_with("the answer is not HTTP"))?;
                raw.drain(..end + 4);
                if (100..200).contains(&parsed.status) && parsed.status != 101 {
                    continue;
                }
                head = Some(parsed);
            }
            if let Some(head) = &head {
                let status = head.status;
                let over = || {
                    AiipError::new(
                        status,
                        format!("the daemon's answer exceeded {AIIP_BODY_CAP} bytes"),
                        None,
                    )
                };
                let framing = if method == "HEAD" || status == 204 || status == 304 {
                    Framing::Length(0)
                } else {
                    head.framing
                };
                match framing {
                    Framing::Length(n) => {
                        if n > AIIP_BODY_CAP || raw.len() > AIIP_BODY_CAP {
                            return Err(over());
                        }
                        if raw.len() >= n {
                            raw.truncate(n);
                            return Ok((status, raw));
                        }
                        if ended {
                            return Err(self.unreachable_with("ECONNRESET"));
                        }
                    }
                    Framing::Chunked => match decode_chunked(&raw) {
                        Err(()) => return Err(self.unreachable_with("the answer is not HTTP")),
                        Ok((body, complete)) => {
                            if body.len() > AIIP_BODY_CAP || raw.len() > 2 * AIIP_BODY_CAP {
                                return Err(over());
                            }
                            if complete {
                                return Ok((status, body));
                            }
                            if ended {
                                return Err(self.unreachable_with("ECONNRESET"));
                            }
                        }
                    },
                    Framing::ToEnd => {
                        if raw.len() > AIIP_BODY_CAP {
                            return Err(over());
                        }
                        if ended {
                            return Ok((status, raw));
                        }
                    }
                }
            } else {
                if raw.len() > HEAD_CAP {
                    return Err(AiipError::new(
                        0,
                        format!("the daemon's answer exceeded {AIIP_BODY_CAP} bytes"),
                        None,
                    ));
                }
                if ended {
                    return Err(self.unreachable_with("ECONNRESET"));
                }
            }
            if aborted() {
                return Err(self.aborted());
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(self.timed_out());
            }
            let _ = stream.set_read_timeout(Some(left.min(SLICE)));
            match stream.read(&mut buf) {
                Ok(0) => ended = true,
                Ok(n) => raw.extend_from_slice(&buf[..n]),
                Err(error)
                    if matches!(
                        error.kind(),
                        ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                    ) => {}
                Err(error) => return Err(self.transport_error(&error, aborted(), deadline)),
            }
        }
    }

    fn aborted(&self) -> AiipError {
        AiipError::new(
            0,
            format!("the request to {} was aborted", self.socket_path.display()),
            Some("aborted"),
        )
    }

    fn timed_out(&self) -> AiipError {
        AiipError::new(
            0,
            format!(
                "the daemon at {} did not answer in time",
                self.socket_path.display()
            ),
            Some("timeout"),
        )
    }

    fn unreachable_with(&self, detail: &str) -> AiipError {
        AiipError::new(
            0,
            format!("no daemon at {}: {detail}", self.socket_path.display()),
            Some("unreachable"),
        )
    }

    /// The caller's stop and the deadline say an abort or a timeout; anything else is no daemon.
    fn transport_error(
        &self,
        error: &std::io::Error,
        aborted: bool,
        deadline: Instant,
    ) -> AiipError {
        if aborted {
            return self.aborted();
        }
        if Instant::now() >= deadline {
            return self.timed_out();
        }
        self.unreachable_with(&errno_name(error))
    }
}

/// The value in the shape the caller expects, or why not.
fn shaped<T: DeserializeOwned>(status: u16, value: Value) -> Result<T, AiipError> {
    serde_json::from_value(value).map_err(|error| {
        AiipError::new(
            status,
            format!("the daemon answered {status} with a body of another shape: {error}"),
            None,
        )
    })
}

/// The daemon's `{error, reason}` envelope, or the raw text when it is not one.
fn error_from(status: u16, text: &str) -> AiipError {
    if let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(text)
        && let Some(Value::String(error)) = parsed.get("error")
    {
        let reason = parsed.get("reason").and_then(Value::as_str);
        return AiipError::new(status, error.clone(), reason);
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        AiipError::new(status, format!("the daemon answered {status}"), None)
    } else {
        AiipError::new(status, trimmed, None)
    }
}

/// The error's code as Node names it (`ENOENT`), else its text.
fn errno_name(error: &std::io::Error) -> String {
    let name = match error.raw_os_error() {
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::ECONNREFUSED) => "ECONNREFUSED",
        Some(libc::ECONNRESET) => "ECONNRESET",
        Some(libc::EACCES) => "EACCES",
        Some(libc::EPERM) => "EPERM",
        Some(libc::ENOTSOCK) => "ENOTSOCK",
        Some(libc::ENOTDIR) => "ENOTDIR",
        Some(libc::ENAMETOOLONG) => "ENAMETOOLONG",
        Some(libc::EPIPE) => "EPIPE",
        Some(libc::EAGAIN) => "EAGAIN",
        Some(libc::ETIMEDOUT) => "ETIMEDOUT",
        _ => return error.to_string(),
    };
    name.to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Framing {
    Length(usize),
    Chunked,
    ToEnd,
}

#[derive(Debug, Clone, Copy)]
struct Head {
    status: u16,
    framing: Framing,
}

fn find_head_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|window| window == b"\r\n\r\n")
}

/// The status line and the headers that frame the body.
fn parse_head(head: &[u8]) -> Option<Head> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let status_line = lines.next()?;
    if !status_line.starts_with("HTTP/") {
        return None;
    }
    let status = status_line.split_whitespace().nth(1)?.parse::<u16>().ok()?;
    let mut length = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "content-length" {
            length = Some(value.parse::<usize>().ok()?);
        } else if name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
            chunked = true;
        }
    }
    let framing = if chunked {
        Framing::Chunked
    } else if let Some(length) = length {
        Framing::Length(length)
    } else {
        Framing::ToEnd
    };
    Some(Head { status, framing })
}

/// A chunked body read so far: the bytes decoded and whether the last chunk was seen.
fn decode_chunked(raw: &[u8]) -> Result<(Vec<u8>, bool), ()> {
    let mut body = Vec::new();
    let mut at = 0;
    loop {
        let Some(line_end) = raw[at..].windows(2).position(|w| w == b"\r\n") else {
            return Ok((body, false));
        };
        let line = std::str::from_utf8(&raw[at..at + line_end]).map_err(|_| ())?;
        let size_text = line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| ())?;
        at += line_end + 2;
        if size == 0 {
            // trailers, then an empty line
            loop {
                let Some(end) = raw[at..].windows(2).position(|w| w == b"\r\n") else {
                    return Ok((body, false));
                };
                at += end + 2;
                if end == 0 {
                    return Ok((body, true));
                }
            }
        }
        // a size no body can have is not a chunk
        let Some(end) = at.checked_add(size).and_then(|end| end.checked_add(2)) else {
            return Err(());
        };
        if raw.len() < end {
            let have = raw.len().saturating_sub(at).min(size);
            body.extend_from_slice(&raw[at..at + have]);
            return Ok((body, false));
        }
        body.extend_from_slice(&raw[at..at + size]);
        if &raw[at + size..at + size + 2] != b"\r\n" {
            return Err(());
        }
        at += size + 2;
    }
}

/// `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` is percent-encoded as UTF-8.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `decodeURIComponent`, lenient: a `%` not followed by two hex digits stays as it is.
pub(crate) fn decode_uri_component(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Some(byte) = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding.
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let b = [
            group[0],
            group.get(1).copied().unwrap_or(0),
            group.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(BASE64[(n >> 18) as usize & 63] as char);
        out.push(BASE64[(n >> 12) as usize & 63] as char);
        out.push(if group.len() > 1 {
            BASE64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if group.len() > 2 {
            BASE64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Base64 read as Node's `Buffer.from(text, "base64")` reads it: the URL-safe
/// letters count too, other characters are skipped, the first `=` ends it,
/// and a last group too short for a byte is dropped.
pub(crate) fn base64_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut count = 0;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(value);
        count += 1;
        if count == 4 {
            out.extend_from_slice(&[(acc >> 16) as u8, (acc >> 8) as u8, acc as u8]);
            acc = 0;
            count = 0;
        }
    }
    match count {
        2 => out.push((acc >> 4) as u8),
        3 => out.extend_from_slice(&[(acc >> 10) as u8, (acc >> 2) as u8]),
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::fake::{FakeAiipd, FakeOverlay, Fault, MAILBOX_CAP, Scratch};
    use std::sync::Arc;
    use std::thread;

    /// Fakes stopped and the scratch removed at the end of a test.
    struct Fakes {
        scratch: Scratch,
        fakes: Vec<FakeAiipd>,
    }

    impl Fakes {
        fn new() -> Self {
            Self {
                scratch: Scratch::new(),
                fakes: Vec::new(),
            }
        }

        fn outsider(&mut self, overlay: &FakeOverlay, name: &str) -> FakeAiipd {
            let fake = overlay
                .new_outsider(&self.scratch.path().join(format!("{name}.sock")))
                .unwrap();
            self.fakes.push(fake.clone());
            fake
        }

        fn member(&mut self, overlay: &FakeOverlay, name: &str) -> FakeAiipd {
            let fake = overlay
                .new_member(name, &self.scratch.path().join(format!("{name}.sock")))
                .unwrap();
            self.fakes.push(fake.clone());
            fake
        }
    }

    impl Drop for Fakes {
        fn drop(&mut self) {
            for fake in &self.fakes {
                fake.stop();
            }
        }
    }

    fn create(client: &AiipClient, name: &str, as_: &str) -> AiipMembership {
        client
            .create(&CreateNetworkRequest {
                name: name.to_string(),
                as_: as_.to_string(),
                lighthouse: false,
            })
            .unwrap()
    }

    fn slots(members: &AiipMembers) -> Vec<(Option<&str>, bool, bool)> {
        members
            .members
            .iter()
            .map(|m| (m.name.as_deref(), m.enrolled, m.self_ == Some(true)))
            .collect()
    }

    #[test]
    fn create_invite_join_members_peers_and_leave_round_trip() {
        let mut fakes = Fakes::new();
        let overlay = FakeOverlay::new();
        let a = fakes.outsider(&overlay, "a");
        let b = fakes.outsider(&overlay, "b");
        let ca = AiipClient::new(a.socket_path());
        let cb = AiipClient::new(b.socket_path());

        assert_eq!(ca.status().unwrap().version, "aiip-m8");
        assert_eq!(ca.networks().unwrap(), vec![]);

        let created = create(&ca, "demo", "alpha");
        assert_eq!(created.network_name, "demo");
        assert_eq!(created.self_name, "alpha");
        assert!(created.authority);
        assert_eq!(created.peers, 0);
        assert!(created.self_addr.starts_with("100.107."));

        let invite = ca.invite("demo", "beta").unwrap();
        assert!(invite.token.starts_with("fake-invite-"));
        assert_eq!(invite.name, "beta");

        let before = ca.members("demo").unwrap();
        assert_eq!(before.source, "authority");
        assert_eq!(
            slots(&before),
            vec![(Some("alpha"), true, true), (Some("beta"), false, false)]
        );
        // an invitee that never joined is a slot, not a peer with a tunnel
        let peers = ca.peers("demo").unwrap().peers;
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].peer.name.as_deref(), Some("beta"));
        assert!(!peers[0].established);

        let joined = cb.join(&invite.token).unwrap();
        assert_eq!(joined.membership.network_name, "demo");
        assert_eq!(joined.membership.self_name, "beta");
        assert!(!joined.membership.authority);
        assert_eq!(joined.membership.self_addr, invite.addr);
        // the same token again: the daemon says this state dir is already a member
        assert!(is_already_member(&cb.join(&invite.token).unwrap_err()));

        let after = cb.members(&created.network_id).unwrap();
        assert_eq!(
            slots(&after),
            vec![(Some("alpha"), true, false), (Some("beta"), true, true)]
        );
        let peers = ca.peers(&created.network_id[..8]).unwrap();
        assert_eq!(peers.self_.name.as_deref(), Some("alpha"));
        assert_eq!(peers.self_.addr, created.self_addr);
        assert_eq!(peers.peers.len(), 1);
        assert_eq!(peers.peers[0].peer.name.as_deref(), Some("beta"));
        assert_eq!(peers.peers[0].peer.addr, invite.addr);
        assert_eq!(peers.peers[0].peer.enrolled, Some(true));
        assert!(peers.peers[0].established);

        cb.leave("demo").unwrap();
        assert_eq!(cb.networks().unwrap(), vec![]);
        // leaving is local: the authority still lists the slot
        assert_eq!(ca.members("demo").unwrap().members.len(), 2);
    }

    #[test]
    fn the_daemons_error_envelope_becomes_an_aiip_error_with_its_status_and_reason() {
        let mut fakes = Fakes::new();
        let overlay = FakeOverlay::new();
        let a = fakes.outsider(&overlay, "a");
        let b = fakes.outsider(&overlay, "b");
        let ca = AiipClient::new(a.socket_path());
        let cb = AiipClient::new(b.socket_path());
        create(&ca, "demo", "alpha");
        cb.join(&ca.invite("demo", "beta").unwrap().token).unwrap();

        let not_authority = cb.invite("demo", "gamma").unwrap_err();
        assert_eq!(
            not_authority,
            AiipError::new(403, "this daemon is not the network's authority", None)
        );

        let unknown = ca.members("nope").unwrap_err();
        assert_eq!(unknown.status, 404);
        assert!(
            unknown
                .message
                .starts_with("no membership matches \"nope\"")
        );

        // the network reference is escaped: a slash reaches the handler as part of the name, not as a route
        let slashed = ca.members("x/y").unwrap_err();
        assert_eq!(slashed.status, 404);
        assert!(slashed.message.starts_with("no membership matches \"x/y\""));

        let own_name = ca.invite("demo", "alpha").unwrap_err();
        assert_eq!(own_name.status, 409);
        assert!(is_already_member(&own_name));

        a.set_fault(Some(Fault {
            status: 503,
            error: "no known endpoints for beta".to_string(),
            reason: Some("no-known-endpoints".to_string()),
        }));
        let fault = ca.peers("demo").unwrap_err();
        assert_eq!(fault.status, 503);
        assert_eq!(fault.reason.as_deref(), Some("no-known-endpoints"));
        assert!(!fault.unreachable());
        assert_eq!(fault.to_string(), "no known endpoints for beta");
    }

    #[test]
    fn a_daemon_that_does_not_accept_holds_a_request_no_longer_than_its_time() {
        use std::os::fd::AsRawFd;
        let dir = std::env::temp_dir().join(format!("abai-na-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("s");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        // a queue of the smallest size, and one connection waiting in it:
        // where the system makes the next one wait, it waits
        // SAFETY: the descriptor is the listener's own, open for this test.
        unsafe {
            libc::listen(listener.as_raw_fd(), 0);
        }
        let _waiting = UnixStream::connect(&socket).unwrap();
        let client = AiipClient::new(socket);
        for _ in 0..3 {
            let started = Instant::now();
            let error = client.status_with(150, None).unwrap_err();
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "{:?}",
                started.elapsed()
            );
            // in time on every system. Linux makes a connect wait for
            // room in the queue, so only there is the waiting tried;
            // others refuse a full queue at once.
            #[cfg(target_os = "linux")]
            assert_eq!(error.reason.as_deref(), Some("timeout"), "{error:?}");
            assert!(
                matches!(error.reason.as_deref(), Some("timeout" | "unreachable")),
                "{error:?}"
            );
        }
        drop(listener);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_slow_daemon_is_a_timeout_and_a_callers_abort_is_an_abort_neither_an_unreachable_daemon() {
        let mut fakes = Fakes::new();
        let overlay = FakeOverlay::new();
        let a = fakes.outsider(&overlay, "a");
        a.set_delay_ms(300);
        let client = AiipClient::new(a.socket_path());
        let slow = client.status_with(50, None).unwrap_err();
        assert_eq!((slow.status, slow.reason.as_deref()), (0, Some("timeout")));
        assert!(!slow.unreachable());
        let stop = Arc::new(AtomicBool::new(false));
        let raiser = stop.clone();
        let later = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            raiser.store(true, Ordering::SeqCst);
        });
        let aborted = client.status_with(5_000, Some(&stop)).unwrap_err();
        later.join().unwrap();
        assert_eq!(
            (aborted.status, aborted.reason.as_deref()),
            (0, Some("aborted"))
        );
        assert!(!aborted.unreachable());
    }

    #[test]
    fn no_daemon_at_the_socket_is_an_unreachable_error() {
        let scratch = Scratch::new();
        let client = AiipClient::new(scratch.path().join("nobody.sock"));
        let error = client.status().unwrap_err();
        assert_eq!(error.status, 0);
        assert!(error.unreachable());
        assert!(error.message.starts_with("no daemon at "), "{error}");
        assert!(error.message.ends_with("nobody.sock: ENOENT"), "{error}");
    }

    #[test]
    fn a_join_is_refused_for_a_bad_token_and_for_an_inviter_that_cannot_be_reached() {
        let mut fakes = Fakes::new();
        let overlay = FakeOverlay::new();
        let a = fakes.outsider(&overlay, "a");
        let b = fakes.outsider(&overlay, "b");
        let ca = AiipClient::new(a.socket_path());
        let cb = AiipClient::new(b.socket_path());
        create(&ca, "demo", "alpha");
        let invite = ca.invite("demo", "beta").unwrap();

        let bad = cb.join("aiip-invite.nonsense").unwrap_err();
        assert_eq!(bad.status, 400);
        assert!(bad.message.starts_with("token: "));
        assert!(!is_already_member(&bad));

        a.stop();
        let unreachable = cb.join(&invite.token).unwrap_err();
        assert_eq!(unreachable.status, 502);
        assert!(
            unreachable
                .message
                .contains("could not reach inviter alpha")
        );
        assert_eq!(cb.networks().unwrap(), vec![]);
    }

    #[test]
    fn a_chunked_answer_reads_as_a_whole_one() {
        let mut fakes = Fakes::new();
        let overlay = FakeOverlay::new();
        let a = fakes.outsider(&overlay, "a");
        a.set_chunked(true);
        let client = AiipClient::new(a.socket_path());
        assert_eq!(client.status().unwrap().version, "aiip-m8");
        let created = create(&client, "demo", "alpha");
        assert_eq!(created.self_name, "alpha");
        let missing = client.members("nope").unwrap_err();
        assert_eq!(missing.status, 404);
        assert!(missing.message.starts_with("no membership matches"));
    }

    /// Two members on one overlay: alpha the authority and beta.
    fn two_members(fakes: &mut Fakes) -> (String, FakeAiipd, FakeAiipd, AiipClient, AiipClient) {
        let overlay = FakeOverlay::new();
        let alpha = fakes.member(&overlay, "alpha");
        let beta = fakes.member(&overlay, "beta");
        let (ca, cb) = (
            AiipClient::new(alpha.socket_path()),
            AiipClient::new(beta.socket_path()),
        );
        (overlay.network_name(), alpha, beta, ca, cb)
    }

    const PAYLOAD: &[u8] = b"hello beta";

    #[test]
    fn a_send_lands_in_the_members_mailbox_and_recv_takes_it_once() {
        let mut fakes = Fakes::new();
        let (net, alpha, beta, ca, cb) = two_members(&mut fakes);
        let sent = ca.send(&net, "beta", PAYLOAD, None).unwrap();
        assert_eq!(sent.to.name.as_deref(), Some("beta"));
        assert_eq!(sent.to.addr, beta.addr());
        let got = cb.recv(&net, Some(1000), None).unwrap().unwrap();
        assert_eq!(got.from.addr, alpha.addr());
        assert_eq!(got.from.name.as_deref(), Some("alpha"));
        assert_eq!(got.payload, PAYLOAD);
        assert!(!got.broadcast);
        assert!(!got.sent_at.is_empty());
        assert_eq!(cb.recv(&net, Some(100), None).unwrap(), None);
    }

    #[test]
    fn a_long_poll_wakes_when_a_message_arrives() {
        let mut fakes = Fakes::new();
        let (net, _, _, ca, cb) = two_members(&mut fakes);
        let sender = {
            let net = net.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(50));
                ca.send(&net, "beta", PAYLOAD, None).unwrap();
            })
        };
        let started = Instant::now();
        let got = cb.recv(&net, Some(5000), None).unwrap().unwrap();
        sender.join().unwrap();
        assert_eq!(got.payload, PAYLOAD);
        assert!(started.elapsed() < Duration::from_millis(2000));
    }

    #[test]
    fn a_send_to_a_name_the_authority_never_issued_is_refused() {
        let mut fakes = Fakes::new();
        let (net, _, _, ca, _) = two_members(&mut fakes);
        let error = ca.send(&net, "nobody", PAYLOAD, None).unwrap_err();
        assert_eq!(error.status, 404);
        assert!(error.message.contains("no known peer named"));
    }

    #[test]
    fn a_payload_over_the_daemons_cap_is_refused_before_the_request() {
        let mut fakes = Fakes::new();
        let (net, _, _, ca, _) = two_members(&mut fakes);
        let error = ca
            .send(&net, "beta", &vec![0u8; 1024 * 1024 + 1], None)
            .unwrap_err();
        assert_eq!(error.status, 0);
        assert!(
            error
                .message
                .contains("exceeds the daemon's 1048576 byte cap")
        );
    }

    #[test]
    fn an_unreachable_member_times_the_dial_out() {
        let mut fakes = Fakes::new();
        let (net, _, beta, ca, _) = two_members(&mut fakes);
        beta.set_unreachable(true);
        assert_eq!(
            ca.send(&net, "beta", PAYLOAD, None).unwrap_err().status,
            504
        );
        beta.set_unreachable(false);
    }

    #[test]
    fn a_full_mailbox_refuses_the_sender() {
        let mut fakes = Fakes::new();
        let (net, alpha, beta, ca, cb) = two_members(&mut fakes);
        for _ in 0..MAILBOX_CAP {
            beta.inject(None, &alpha.addr(), PAYLOAD, false);
        }
        let error = ca.send(&net, "beta", PAYLOAD, None).unwrap_err();
        assert_eq!(error.status, 502);
        assert!(error.message.contains("mailbox full"));
        let got = cb.recv(&net, Some(100), None).unwrap().unwrap();
        assert_eq!(got.from.addr, alpha.addr());
        // a sender that claimed no name has none
        assert_eq!(got.from.name, None);
        beta.clear_mailbox();
    }

    #[test]
    fn an_aborted_recv_ends_at_once_with_the_callers_reason() {
        let mut fakes = Fakes::new();
        let (net, _, _, ca, _) = two_members(&mut fakes);
        let stop = Arc::new(AtomicBool::new(false));
        let raiser = stop.clone();
        let later = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            raiser.store(true, Ordering::SeqCst);
        });
        let started = Instant::now();
        let error = ca.recv(&net, Some(5000), Some(&stop)).unwrap_err();
        later.join().unwrap();
        assert_eq!(
            (error.status, error.reason.as_deref()),
            (0, Some("aborted"))
        );
        assert!(started.elapsed() < Duration::from_millis(1000));
    }

    #[test]
    fn a_member_that_left_refuses_the_sender_and_its_waiting_reader_hears_it() {
        let mut fakes = Fakes::new();
        let (net, _, _, ca, cb) = two_members(&mut fakes);
        let reader = {
            let (net, cb) = (net.clone(), cb.clone());
            thread::spawn(move || cb.recv(&net, Some(5000), None))
        };
        thread::sleep(Duration::from_millis(50));
        cb.leave(&net).unwrap();
        assert_eq!(reader.join().unwrap().unwrap_err().status, 410);
        let error = ca.send(&net, "beta", PAYLOAD, None).unwrap_err();
        assert_eq!(error.status, 502);
        assert!(error.message.contains("mailbox gone"));
        assert_eq!(cb.recv(&net, Some(10), None).unwrap_err().status, 404);
    }

    #[test]
    fn base64_round_trips_and_reads_leniently_as_node_does() {
        for bytes in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar"] {
            assert_eq!(base64_decode(&base64_encode(bytes)), bytes);
        }
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_decode("Zm9v\nYmFy"), b"foobar");
        assert_eq!(base64_decode("Zm8"), b"fo");
        assert_eq!(base64_decode("_-8="), vec![0xff, 0xef]);
        let all: Vec<u8> = (0..=255).collect();
        assert_eq!(base64_decode(&base64_encode(&all)), all);
    }

    #[test]
    fn a_network_reference_is_encoded_as_encode_uri_component_does() {
        assert_eq!(encode_uri_component("x/y z"), "x%2Fy%20z");
        assert_eq!(encode_uri_component("a-b_c.d!~*'()"), "a-b_c.d!~*'()");
        assert_eq!(encode_uri_component("é"), "%C3%A9");
        assert_eq!(decode_uri_component("x%2Fy%20z%C3%A9%zz"), "x/y zé%zz");
    }

    #[test]
    fn a_chunked_body_decodes_whole_or_says_it_is_not_complete() {
        let raw = b"3\r\nabc\r\n2;ext=1\r\nde\r\n0\r\n\r\n";
        assert_eq!(decode_chunked(raw), Ok((b"abcde".to_vec(), true)));
        assert_eq!(decode_chunked(&raw[..9]), Ok((b"abc".to_vec(), false)));
        assert_eq!(decode_chunked(b"zz\r\n"), Err(()));
    }

    #[test]
    fn the_error_envelope_or_the_raw_text_names_a_refusal() {
        assert_eq!(
            error_from(500, r#"{"error":"boom","reason":"r"}"#),
            AiipError::new(500, "boom", Some("r"))
        );
        assert_eq!(
            error_from(502, "  bad gateway \n"),
            AiipError::new(502, "bad gateway", None)
        );
        assert_eq!(
            error_from(500, ""),
            AiipError::new(500, "the daemon answered 500", None)
        );
    }
}
