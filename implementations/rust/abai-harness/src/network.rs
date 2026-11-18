//! A run's network inside the harness (contract section 7, `network`):
//! the membership taken up at attach, the messages that come and go, and
//! what the agent's tools read.
//!
//! The mail loops run on threads of their own. They only put what they
//! took from a mailbox in a queue and wake the harness's loop; naming the
//! sender, the transcript, the wake and the audit line are the core's,
//! on its own thread.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use abai_stub::manifest::Manifest;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::net::{
    AiipError, Classified, EnvelopeType, MailDelivery, NetworkMembership, Note, RunNetwork,
    classify, connect_network,
};

/// The event a member's message arrives as.
pub const EVENT_MESSAGE: &str = "abai.net.message";
/// How many messages `abai_messages` can reach back to.
pub const MESSAGE_KEEP: usize = 200;
/// How many messages may wait for the harness's loop. Past this the
/// mailboxes are not read on, so what comes next waits in the daemon.
pub const INBOX_KEEP: usize = 200;
/// How often a mail thread that waits for room looks again.
const INBOX_WAIT: Duration = Duration::from_millis(20);
/// How much of a body the wake line shows, in characters.
pub const MESSAGE_PREVIEW: usize = 300;

/// A message this run sent or received.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HarnessMessage {
    /// `sent` or `received`.
    pub direction: &'static str,
    pub network: String,
    /// The counterpart: the name the authority issued, else its address.
    pub peer: String,
    pub addr: String,
    /// A name the sender gave itself, when it is not the issued one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub re: Option<String>,
    pub kind: String,
    /// Milliseconds since the epoch.
    pub ts: u64,
    pub body: String,
}

impl HarnessMessage {
    /// Whether the message is one an agent said to another: those wake,
    /// and are audited.
    pub fn speaks(&self) -> bool {
        self.kind == "msg" || self.kind == "raw"
    }

    /// The event's payload.
    pub fn payload(&self) -> Map<String, Value> {
        let mut payload = Map::new();
        payload.insert("from".to_string(), json!(self.peer));
        payload.insert("body".to_string(), json!(self.body));
        payload.insert("network".to_string(), json!(self.network));
        payload.insert("kind".to_string(), json!(self.kind));
        for (key, value) in [("id", &self.id), ("thread", &self.thread), ("re", &self.re)] {
            if let Some(value) = value {
                payload.insert(key.to_string(), json!(value));
            }
        }
        payload.insert("addr".to_string(), json!(self.addr));
        if let Some(claimed) = &self.claimed {
            payload.insert("claimed".to_string(), json!(claimed));
        }
        payload
    }

    /// The transcript and wake line: who, where, and the body up to the
    /// preview; the rest is behind `abai_messages`.
    pub fn line(&self) -> String {
        let shown: String = self.body.chars().take(MESSAGE_PREVIEW).collect();
        let more = self.body.chars().count().saturating_sub(MESSAGE_PREVIEW);
        let body = if more > 0 {
            format!("{shown}… ({more} more characters; abai_messages has the whole)")
        } else {
            shown
        };
        let who = match &self.claimed {
            Some(claimed) => format!("{} (claims {claimed})", self.peer),
            None => self.peer.clone(),
        };
        let kind = if self.kind == "msg" {
            String::new()
        } else {
            format!(" kind={}", self.kind)
        };
        let thread = match &self.thread {
            Some(thread) if self.id.as_ref() != Some(thread) => format!(" thread={thread}"),
            _ => String::new(),
        };
        format!(
            "{EVENT_MESSAGE} from={who} network={}{kind}{thread}: {body}",
            self.network
        )
    }
}

/// The wake line of a message, from its event payload.
pub fn line_of(payload: &Map<String, Value>) -> String {
    let text = |key: &str| payload.get(key).and_then(Value::as_str).map(str::to_string);
    HarnessMessage {
        direction: "received",
        network: text("network").unwrap_or_default(),
        peer: text("from").unwrap_or_default(),
        addr: text("addr").unwrap_or_default(),
        claimed: text("claimed"),
        id: text("id"),
        thread: text("thread"),
        re: text("re"),
        kind: text("kind").unwrap_or_default(),
        ts: 0,
        body: text("body").unwrap_or_default(),
    }
    .line()
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// What a received payload says, as one string: the body of a message or
/// a raw payload, a note for the rest.
fn summarize(sorted: &Classified) -> String {
    match sorted {
        Classified::Raw { body } => body.clone(),
        Classified::Foreign { note, .. } => format!("({note})"),
        Classified::Envelope(envelope) => match envelope.kind {
            EnvelopeType::Msg => envelope.body.clone().unwrap_or_default(),
            EnvelopeType::Profile => {
                let mut said = Map::new();
                if let Some(profile) = &envelope.profile {
                    for (key, value) in [
                        ("agent", &profile.agent),
                        ("project", &profile.project),
                        ("owner", &profile.owner),
                        ("doing", &profile.doing),
                        ("host", &profile.host),
                        ("dir", &profile.dir),
                        ("updated_at", &profile.updated_at),
                    ] {
                        if let Some(value) = value {
                            said.insert(key.to_string(), json!(value));
                        }
                    }
                }
                format!("(profile {})", Value::Object(said))
            }
            EnvelopeType::ProfileQuery => "(profile query)".to_string(),
            EnvelopeType::Receipt => match &envelope.receipt {
                Some(receipt) => format!("(receipt: {} {})", receipt.of, receipt.status),
                None => "(receipt: ? )".to_string(),
            },
        },
    }
}

/// The membership a send goes out on.
pub fn pick_membership<'a>(
    memberships: &'a [NetworkMembership],
    named: Option<&str>,
) -> Result<&'a NetworkMembership, String> {
    if memberships.is_empty() {
        return Err("this run holds no membership on its network".to_string());
    }
    let names = memberships
        .iter()
        .map(|m| m.network.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    match named {
        None if memberships.len() == 1 => Ok(&memberships[0]),
        None => Err(format!(
            "this run is on several networks ({names}); say which with network"
        )),
        Some(named) => memberships
            .iter()
            .find(|m| m.network == named || m.id == named)
            .ok_or_else(|| format!("this run is not on a network named {named}; it is on {names}")),
    }
}

/// The daemon's refusal of a send, in the agent's words.
pub fn send_failure(error: &AiipError, to: &str, network: &str) -> String {
    let message = &error.message;
    let lower = message.to_lowercase();
    match error.status {
        404 if lower.contains("no known peer") || lower.contains("not confirmed") => {
            format!("no member named {to} on {network}; abai_peers lists them ({message})")
        }
        409 => format!("the name {to} is ambiguous on {network}: {message}"),
        502 => format!(
            "{to} refused the message: {}",
            message
                .strip_prefix("peer refused message: ")
                .unwrap_or(message)
        ),
        503 | 504 => format!(
            "{to} could not be reached: its daemon is not running or has no route ({message})"
        ),
        0 => format!("the network daemon did not answer: {message}"),
        _ => message.clone(),
    }
}

/// What connecting gave, before there is a core to hold it.
pub struct Connected {
    network: Option<Arc<RunNetwork>>,
    /// Why the run has no network, when one was declared or asked for.
    pub absent: Option<String>,
    pub declared: bool,
    notes: Arc<Mutex<Vec<String>>>,
}

impl std::fmt::Debug for Connected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connected")
            .field("on", &self.network.is_some())
            .field("absent", &self.absent)
            .finish_non_exhaustive()
    }
}

impl Connected {
    /// Whether the run is on a network.
    pub fn on(&self) -> bool {
        self.network.is_some()
    }
}

/// Take up the run's network, as every attach does before anything else:
/// the daemon found or started, an invite from the environment used, the
/// memberships listed. An error is the refusal of a program that
/// requires a network and has none: nothing is attached then.
pub fn connect(
    env: &dyn Fn(&str) -> Option<String>,
    manifest: &Manifest,
) -> Result<Connected, String> {
    let notes: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = notes.clone();
    let note: Note = Arc::new(move |text: &str| {
        sink.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(text.to_string());
    });
    let outcome = connect_network(crate::net::ConnectNetworkInput {
        env,
        daemon_env: None,
        program: &manifest.name,
        declared: manifest.network.as_ref(),
        current: None,
        spawn: None,
        note,
    })?;
    Ok(Connected {
        network: outcome.network.map(Arc::new),
        absent: outcome.absent,
        declared: outcome.declared,
        notes,
    })
}

impl Drop for Connected {
    fn drop(&mut self) {
        // a network that was connected and then not taken up (the attach
        // failed after it) is let go: a daemon this run started in a
        // directory of its own does not stay behind
        if let Some(run) = self.network.take() {
            run.stop();
        }
    }
}

/// A message taken from a mailbox, with the name the authority issued
/// its sender, looked up on the mail thread.
type Arrived = (MailDelivery, Option<String>);

/// Put a message taken from a mailbox where the harness's loop finds
/// it. While `cap` of them wait and the mailboxes are being read, the
/// mail thread waits here for room: it reads no further, and nothing is
/// lost. The daemon has forgotten a message it handed over, so once the
/// reading is stopped the message goes in whatever the count.
fn admit<T>(inbox: &Mutex<VecDeque<T>>, reading: &AtomicBool, item: T, cap: usize) {
    loop {
        {
            let mut inbox = inbox.lock().unwrap_or_else(PoisonError::into_inner);
            if inbox.len() < cap || !reading.load(Ordering::SeqCst) {
                inbox.push_back(item);
                return;
            }
        }
        std::thread::sleep(INBOX_WAIT);
    }
}

/// A run's network as the core holds it.
pub struct Network {
    run: Arc<RunNetwork>,
    notes: Arc<Mutex<Vec<String>>>,
    inbox: Arc<Mutex<VecDeque<Arrived>>>,
    handler: crate::net::MailHandler,
    /// Whether the mailboxes are being read.
    reading: Arc<AtomicBool>,
    log: VecDeque<HarnessMessage>,
}

impl std::fmt::Debug for Network {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Network")
            .field("messages", &self.log.len())
            .finish_non_exhaustive()
    }
}

/// Why a run has no network, as the tools say it.
pub fn no_network(absent: Option<&str>) -> String {
    match absent {
        Some(reason) => format!("this run has no network: {reason}"),
        None => "this run has no network: the program declares none and ABAI_NET_DIR is unset"
            .to_string(),
    }
}

impl Network {
    /// Take the connected network up: its mailboxes are read from now
    /// on, and `wake` is called when a message has come.
    ///
    /// Returns the network when the run is on one, and the lines the
    /// connecting left for the transcript.
    pub fn start(
        mut connected: Connected,
        wake: Arc<dyn Fn() + Send + Sync>,
    ) -> (Option<Self>, Vec<String>) {
        let lines = std::mem::take(
            &mut *connected
                .notes
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        );
        let Some(run) = connected.network.take() else {
            return (None, lines);
        };
        let inbox: Arc<Mutex<VecDeque<Arrived>>> = Arc::default();
        let arriving = inbox.clone();
        let reading = Arc::new(AtomicBool::new(true));
        let open = reading.clone();
        // the sender is named here, on the mail thread: a roster read can
        // take seconds, and the harness's loop must not wait on it
        let naming = Arc::downgrade(&run);
        let handler: crate::net::MailHandler = Arc::new(move |delivery: MailDelivery| {
            let issued = naming
                .upgrade()
                .and_then(|run| run.name_for(&delivery.membership.id, &delivery.message.from.addr));
            admit(&arriving, &open, (delivery, issued), INBOX_KEEP);
            wake();
            Ok(())
        });
        run.start_mail(handler.clone());
        let network = Self {
            run,
            notes: connected.notes.clone(),
            inbox,
            handler,
            reading,
            log: VecDeque::new(),
        };
        (Some(network), lines)
    }

    /// Whether a message waits to be read.
    pub fn pending(&self) -> bool {
        !self
            .inbox
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_empty()
    }

    /// What the network layer has to say since the last look, for the
    /// transcript.
    pub fn take_notes(&self) -> Vec<String> {
        std::mem::take(&mut *self.notes.lock().unwrap_or_else(PoisonError::into_inner))
    }

    /// The messages that have come since the last look, each named by
    /// the roster and sorted by its envelope, and remembered.
    pub fn take_received(&mut self) -> Vec<HarnessMessage> {
        let arrived: Vec<Arrived> = self
            .inbox
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .drain(..)
            .collect();
        let mut received = Vec::with_capacity(arrived.len());
        for (
            MailDelivery {
                message,
                membership,
            },
            issued,
        ) in arrived
        {
            let sorted = classify(&message.payload);
            let claimed = message.from.name.clone().filter(|name| !name.is_empty());
            let envelope = match &sorted {
                Classified::Envelope(envelope) => Some(envelope),
                _ => None,
            };
            let entry = HarnessMessage {
                direction: "received",
                network: membership.network.clone(),
                peer: issued.clone().unwrap_or_else(|| message.from.addr.clone()),
                addr: message.from.addr.clone(),
                claimed: claimed.filter(|claimed| Some(claimed) != issued.as_ref()),
                id: envelope.map(|e| e.id.clone()),
                thread: envelope.map(|e| e.thread.clone().unwrap_or_else(|| e.id.clone())),
                re: envelope.and_then(|e| e.re.clone()),
                kind: sorted.kind().to_string(),
                ts: now_ms(),
                body: summarize(&sorted),
            };
            self.remember(entry.clone());
            received.push(entry);
        }
        received
    }

    /// Keep a message for `abai_messages`.
    pub fn remember(&mut self, entry: HarnessMessage) {
        self.log.push_back(entry);
        while self.log.len() > MESSAGE_KEEP {
            self.log.pop_front();
        }
    }

    /// Stop reading the mailboxes: what arrives from now on waits in
    /// the daemon, for a harness that can act on it.
    pub fn pause(&mut self) {
        // the flag goes down first: a mail thread waiting for room stops
        // waiting, so the stop does not wait for it
        if self.reading.swap(false, Ordering::SeqCst) {
            self.run.stop_mail();
        }
    }

    /// Read the mailboxes again.
    pub fn resume(&mut self) {
        if !self.reading.swap(true, Ordering::SeqCst) {
            self.run.start_mail(self.handler.clone());
        }
    }

    /// The run's network, for the tools.
    pub fn run(&self) -> &RunNetwork {
        &self.run
    }

    /// What this run sent and received since attach, oldest first;
    /// `limit` keeps the newest.
    pub fn messages(&self, network: Option<&str>, limit: Option<usize>) -> Vec<&HarnessMessage> {
        let list: Vec<&HarnessMessage> = self
            .log
            .iter()
            .filter(|m| network.is_none_or(|network| m.network == network))
            .collect();
        let keep = limit.filter(|limit| *limit > 0).unwrap_or(list.len());
        list[list.len().saturating_sub(keep)..].to_vec()
    }
}

impl Drop for Network {
    fn drop(&mut self) {
        // the mailboxes are not read any more; a daemon this run started
        // in a directory of its own goes with the run
        self.reading.store(false, Ordering::SeqCst);
        self.run.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(body: &str) -> HarnessMessage {
        HarnessMessage {
            direction: "received",
            network: "fleet".to_string(),
            peer: "bravo".to_string(),
            addr: "fd00::2".to_string(),
            claimed: None,
            id: Some("m1".to_string()),
            thread: Some("m1".to_string()),
            re: None,
            kind: "msg".to_string(),
            ts: 1,
            body: body.to_string(),
        }
    }

    #[test]
    fn the_wake_line_names_the_sender_and_previews_a_long_body() {
        assert_eq!(
            message("hello").line(),
            "abai.net.message from=bravo network=fleet: hello"
        );
        let long = message(&"é".repeat(MESSAGE_PREVIEW + 5));
        let line = long.line();
        assert!(line.ends_with("… (5 more characters; abai_messages has the whole)"));
        assert_eq!(line.matches('é').count(), MESSAGE_PREVIEW);

        let mut other = message("x");
        other.claimed = Some("admiral".to_string());
        other.kind = "raw".to_string();
        other.thread = Some("m0".to_string());
        assert_eq!(
            other.line(),
            "abai.net.message from=bravo (claims admiral) network=fleet kind=raw thread=m0: x"
        );
        assert!(other.speaks());
        other.kind = "receipt".to_string();
        assert!(!other.speaks());
    }

    #[test]
    fn the_payload_has_what_the_agent_reads() {
        let mut m = message("hi");
        m.re = Some("m0".to_string());
        assert_eq!(
            Value::Object(m.payload()),
            json!({"from": "bravo", "body": "hi", "network": "fleet", "kind": "msg",
                "id": "m1", "thread": "m1", "re": "m0", "addr": "fd00::2"})
        );
    }

    #[test]
    fn a_send_goes_out_on_the_one_membership_or_the_named_one() {
        let membership = |network: &str, id: &str| NetworkMembership {
            network: network.to_string(),
            id: id.to_string(),
            member: "alpha".to_string(),
            addr: "fd00::1".to_string(),
            authority: false,
            peers: 1,
        };
        assert_eq!(
            pick_membership(&[], None).unwrap_err(),
            "this run holds no membership on its network"
        );
        let one = [membership("fleet", "n1")];
        assert_eq!(pick_membership(&one, None).unwrap().id, "n1");
        let two = [membership("fleet", "n1"), membership("port", "n2")];
        assert_eq!(
            pick_membership(&two, None).unwrap_err(),
            "this run is on several networks (fleet, port); say which with network"
        );
        assert_eq!(pick_membership(&two, Some("port")).unwrap().id, "n2");
        assert_eq!(pick_membership(&two, Some("n1")).unwrap().network, "fleet");
        assert_eq!(
            pick_membership(&two, Some("sea")).unwrap_err(),
            "this run is not on a network named sea; it is on fleet, port"
        );
    }

    #[test]
    fn a_refused_send_is_said_in_the_agents_words() {
        let error = |status: u16, message: &str| AiipError::new(status, message, None);
        assert_eq!(
            send_failure(&error(404, "no known peer named zed"), "zed", "fleet"),
            "no member named zed on fleet; abai_peers lists them (no known peer named zed)"
        );
        assert_eq!(
            send_failure(&error(404, "no such network"), "zed", "fleet"),
            "no such network"
        );
        assert_eq!(
            send_failure(&error(409, "two members"), "zed", "fleet"),
            "the name zed is ambiguous on fleet: two members"
        );
        assert_eq!(
            send_failure(
                &error(502, "peer refused message: mailbox full"),
                "zed",
                "fleet"
            ),
            "zed refused the message: mailbox full"
        );
        assert_eq!(
            send_failure(&error(504, "dial timed out"), "zed", "fleet"),
            "zed could not be reached: its daemon is not running or has no route (dial timed out)"
        );
        assert_eq!(
            send_failure(&error(0, "ENOENT"), "zed", "fleet"),
            "the network daemon did not answer: ENOENT"
        );
    }

    #[test]
    fn a_full_inbox_holds_the_mail_thread_until_there_is_room_or_the_reading_stops() {
        let inbox: Arc<Mutex<VecDeque<u32>>> = Arc::new(Mutex::new((0..3).collect()));
        let reading = Arc::new(AtomicBool::new(true));
        let count = |inbox: &Mutex<VecDeque<u32>>| inbox.lock().unwrap().len();

        // room: at once
        admit(&inbox, &reading, 3, 5);
        admit(&inbox, &reading, 4, 5);
        assert_eq!(count(&inbox), 5);

        // full: the thread waits, and goes on when one is taken
        let (theirs, open) = (inbox.clone(), reading.clone());
        let waiting = std::thread::spawn(move || admit(&theirs, &open, 5, 5));
        std::thread::sleep(Duration::from_millis(100));
        assert!(!waiting.is_finished());
        assert_eq!(count(&inbox), 5);
        assert_eq!(inbox.lock().unwrap().pop_front(), Some(0));
        waiting.join().unwrap();
        assert_eq!(*inbox.lock().unwrap(), [1, 2, 3, 4, 5]);

        // full, and the reading stops: the message in hand is kept
        let (theirs, open) = (inbox.clone(), reading.clone());
        let waiting = std::thread::spawn(move || admit(&theirs, &open, 6, 5));
        std::thread::sleep(Duration::from_millis(60));
        assert!(!waiting.is_finished());
        reading.store(false, Ordering::SeqCst);
        waiting.join().unwrap();
        assert_eq!(*inbox.lock().unwrap(), [1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn no_network_says_why() {
        assert_eq!(
            no_network(Some("no aiip binary found")),
            "this run has no network: no aiip binary found"
        );
        assert!(no_network(None).ends_with("the program declares none and ABAI_NET_DIR is unset"));
    }
}
