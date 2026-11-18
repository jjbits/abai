//! The aiap v1 envelope (agents-cowork, internal/envelope): the JSON object a
//! message travels in over an aiip mailbox. The harness speaks it so an
//! abaigram's agent and aiap's agents read each other. It carries no sender:
//! the sender is the overlay address the daemon reports, which the tunnel
//! authenticated; a name inside the payload would be anyone's to claim.
//!
//! What is here mirrors the Go package rule for rule: the id shape, the
//! caps, what makes an envelope invalid, and how an inbound payload sorts
//! into an envelope, a foreign aiap payload (another version, an unknown
//! type, an invalid one) or raw bytes shown as a plain message. Nothing is
//! dropped silently: every payload becomes one of the three. One known
//! difference from Go: its JSON decoder matches field names without regard
//! to case, this one does not, so `{"AIAP": 1, ...}` is raw here.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::Read;

use serde_json::{Map, Value};

pub const AIAP_VERSION: i64 = 1;
pub const MAX_ID_BYTES: usize = 64;
pub const MAX_BODY_BYTES: usize = 65_536;
pub const MAX_ENVELOPE_BYTES: usize = 262_144;
/// An id a receiving daemon mints for a payload with no envelope; no wire envelope may use the prefix.
pub const RESERVED_ID_PREFIX: &str = "raw-";

const PROFILE_FIELD_CAP: usize = 256;
const PROFILE_DOING_CAP: usize = 1024;
const PROFILE_DIR_CAP: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvelopeType {
    Msg,
    Profile,
    ProfileQuery,
    Receipt,
}

impl EnvelopeType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Msg => "msg",
            Self::Profile => "profile",
            Self::ProfileQuery => "profile-query",
            Self::Receipt => "receipt",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "msg" => Some(Self::Msg),
            "profile" => Some(Self::Profile),
            "profile-query" => Some(Self::ProfileQuery),
            "receipt" => Some(Self::Receipt),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AiapProfile {
    pub agent: Option<String>,
    pub project: Option<String>,
    pub owner: Option<String>,
    pub doing: Option<String>,
    pub host: Option<String>,
    pub dir: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AiapReceipt {
    pub of: String,
    pub status: String,
}

/// One aiap v1 wire unit, as decoded. `thread` and `re` matter on `msg` (`re` also on `profile`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    pub aiap: i64,
    pub kind: EnvelopeType,
    pub id: String,
    pub ts: String,
    pub thread: Option<String>,
    pub re: Option<String>,
    pub body: Option<String>,
    pub profile: Option<AiapProfile>,
    pub receipt: Option<AiapReceipt>,
}

/// How an inbound payload sorts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Classified {
    /// A valid v1 envelope; its kind is its type.
    Envelope(Box<Envelope>),
    Foreign {
        note: String,
        version: Option<i64>,
    },
    Raw {
        body: String,
    },
}

impl Classified {
    /// `msg`, `profile`, `profile-query`, `receipt`, `foreign` or `raw`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Envelope(envelope) => envelope.kind.as_str(),
            Self::Foreign { .. } => "foreign",
            Self::Raw { .. } => "raw",
        }
    }
}

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// `n` random bytes from the system, else from the standard library's hasher seeds.
pub(crate) fn random_bytes(n: usize) -> Vec<u8> {
    let mut out = vec![0u8; n];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut out))
        .is_ok()
    {
        return out;
    }
    for chunk in out.chunks_mut(8) {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_usize(chunk.len());
        let bytes = hasher.finish().to_be_bytes();
        chunk.copy_from_slice(&bytes[..chunk.len()]);
    }
    out
}

/// A ULID-style id as aiap mints them: 48 bits of Unix milliseconds then 80
/// random bits, 26 characters of Crockford base32, most significant first.
pub fn new_message_id(now_ms: u64) -> String {
    let time = u128::from(now_ms % (1u64 << 48));
    let random = random_bytes(10)
        .iter()
        .fold(0u128, |acc, &b| (acc << 8) | u128::from(b));
    let bits = (time << 80) | random;
    // 128 bits into 26 five-bit groups, the first group holding the top 3 bits
    (0..26)
        .rev()
        .map(|i| CROCKFORD[((bits >> (i * 5)) & 31) as usize] as char)
        .collect()
}

fn check_id(id: Option<&Value>, what: &str) -> Option<String> {
    let id = match id {
        Some(Value::String(id)) if !id.is_empty() => id,
        _ => return Some(format!("{what} is required")),
    };
    if id.len() > MAX_ID_BYTES {
        return Some(format!("{what} exceeds {MAX_ID_BYTES} bytes"));
    }
    if id.starts_with(RESERVED_ID_PREFIX) {
        return Some(format!(
            "{what} uses the reserved prefix {RESERVED_ID_PREFIX}"
        ));
    }
    None
}

fn check_ref(value: Option<&Value>, what: &str) -> Option<String> {
    // Go decodes a JSON null into an empty string, which is "not given"
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.len() > MAX_ID_BYTES => {
            Some(format!("{what} exceeds {MAX_ID_BYTES} bytes"))
        }
        Some(Value::String(_)) => None,
        Some(_) => Some(format!("{what} must be a string")),
    }
}

fn digits(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(bytes).ok()?.parse().ok()
}

fn leap(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

/// RFC 3339 as Go's time.Parse(time.RFC3339) accepts it: the fields in range, a day the month has.
fn is_rfc3339(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return false;
    }
    let (Some(y), Some(mo), Some(d), Some(h), Some(mi), Some(s)) = (
        digits(&b[0..4]),
        digits(&b[5..7]),
        digits(&b[8..10]),
        digits(&b[11..13]),
        digits(&b[14..16]),
        digits(&b[17..19]),
    ) else {
        return false;
    };
    let mut i = 19;
    if b[i] == b'.' {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    let zone = &b[i..];
    let offset = match zone {
        b"Z" => None,
        [sign, h1, h2, b':', m1, m2] if *sign == b'+' || *sign == b'-' => {
            match (digits(&[*h1, *h2]), digits(&[*m1, *m2])) {
                (Some(oh), Some(om)) => Some((oh, om)),
                _ => return false,
            }
        }
        _ => return false,
    };
    if !(1..=12).contains(&mo) || d < 1 || h > 23 || mi > 59 || s > 59 {
        return false;
    }
    if let Some((oh, om)) = offset
        && (oh > 23 || om > 59)
    {
        return false;
    }
    // JavaScript's Date.UTC reads a year of 0 to 99 as 1900 to 1999
    let calendar_year = if y <= 99 { 1900 + y } else { y };
    let month_days = match mo {
        2 if leap(calendar_year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    d <= month_days
}

fn check_time(value: Option<&Value>, what: &str) -> Option<String> {
    match value {
        Some(Value::String(value)) if is_rfc3339(value) => None,
        _ => Some(format!("{what} is not an RFC 3339 time")),
    }
}

fn agent_name(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A JSON number as JavaScript writes it.
fn js_number(number: &serde_json::Number) -> String {
    if let Some(i) = number.as_i64() {
        return i.to_string();
    }
    if let Some(u) = number.as_u64() {
        return u.to_string();
    }
    match number.as_f64() {
        Some(f) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{f:.0}"),
        Some(f) => f.to_string(),
        None => number.to_string(),
    }
}

/// `String(value)` in JavaScript, `undefined` for a field not given.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => js_number(n),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// `JSON.stringify(value)`, `undefined` for a field not given.
fn json_text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(value) => value.to_string(),
    }
}

/// The value as an integer when it is a whole JSON number.
fn as_integer(value: Option<&Value>) -> Option<i64> {
    let Some(Value::Number(n)) = value else {
        return None;
    };
    if let Some(i) = n.as_i64() {
        return Some(i);
    }
    if let Some(u) = n.as_u64() {
        return Some(i64::try_from(u).unwrap_or(i64::MAX));
    }
    match n.as_f64() {
        Some(f) if f.is_finite() && f.fract() == 0.0 => Some(f as i64),
        _ => None,
    }
}

/// Why a decoded envelope is not a valid v1 envelope, or `None` when it is. The Go package's rules.
pub fn validate(e: &Map<String, Value>) -> Option<String> {
    let aiap = e.get("aiap");
    let is_v1 = matches!(aiap, Some(Value::Number(n)) if n.as_f64() == Some(AIAP_VERSION as f64));
    if !is_v1 {
        return Some(format!(
            "aiap version {} is not {AIAP_VERSION}",
            js_string(aiap)
        ));
    }
    let kind = match e.get("type") {
        Some(Value::String(t)) => EnvelopeType::parse(t),
        _ => None,
    };
    let Some(kind) = kind else {
        return Some(format!("unknown type {}", json_text(e.get("type"))));
    };
    if let Some(error) = check_id(e.get("id"), "id") {
        return Some(error);
    }
    if let Some(error) = check_time(e.get("ts"), "ts") {
        return Some(error);
    }
    if let Some(error) =
        check_ref(e.get("thread"), "thread").or_else(|| check_ref(e.get("re"), "re"))
    {
        return Some(error);
    }
    match kind {
        EnvelopeType::Msg => match e.get("body") {
            Some(Value::String(body)) if !body.is_empty() => {
                if body.len() > MAX_BODY_BYTES {
                    Some(format!("body exceeds {MAX_BODY_BYTES} bytes"))
                } else {
                    None
                }
            }
            _ => Some("a msg needs a body".to_string()),
        },
        EnvelopeType::Profile => {
            let Some(Value::Object(prof)) = e.get("profile") else {
                return Some("a profile needs its profile section".to_string());
            };
            for (field, cap) in [
                ("agent", PROFILE_FIELD_CAP),
                ("project", PROFILE_FIELD_CAP),
                ("owner", PROFILE_FIELD_CAP),
                ("host", PROFILE_FIELD_CAP),
                ("doing", PROFILE_DOING_CAP),
                ("dir", PROFILE_DIR_CAP),
            ] {
                match prof.get(field) {
                    None | Some(Value::Null) => {}
                    Some(Value::String(v)) if v.len() > cap => {
                        return Some(format!("profile.{field} exceeds {cap} bytes"));
                    }
                    Some(Value::String(_)) => {}
                    Some(_) => return Some(format!("profile.{field} must be a string")),
                }
            }
            if let Some(Value::String(agent)) = prof.get("agent")
                && !agent.is_empty()
                && !agent_name(agent)
            {
                return Some("profile.agent is not an agent name".to_string());
            }
            match prof.get("updatedAt") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) if s.is_empty() => None,
                other => check_time(other, "profile.updatedAt"),
            }
        }
        EnvelopeType::Receipt => {
            let Some(Value::Object(rec)) = e.get("receipt") else {
                return Some("a receipt needs its receipt section".to_string());
            };
            match rec.get("of") {
                Some(Value::String(of)) if !of.is_empty() => {
                    if of.len() > MAX_ID_BYTES {
                        return Some(format!("receipt.of exceeds {MAX_ID_BYTES} bytes"));
                    }
                }
                _ => return Some("receipt.of is required".to_string()),
            }
            match rec.get("status") {
                Some(Value::String(status)) if status == "delivered" => None,
                other => Some(format!(
                    "receipt.status {} is not delivered",
                    json_text(other)
                )),
            }
        }
        EnvelopeType::ProfileQuery => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MessageInput {
    pub body: String,
    pub thread: Option<String>,
    pub re: Option<String>,
    pub id: Option<String>,
    /// Milliseconds since the Unix epoch; default now.
    pub now_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedMessage {
    pub id: String,
    pub ts: String,
    pub bytes: Vec<u8>,
}

/// A `msg` envelope's bytes for the wire. An error when the message breaks
/// aiap's caps: an empty body, a body over 64 KiB, a thread or reply
/// reference over 64 bytes, or an encoded envelope over 256 KiB.
pub fn encode_message(input: MessageInput) -> Result<EncodedMessage, String> {
    let now = input.now_ms.unwrap_or_else(crate::time::now_ms);
    let id = input.id.unwrap_or_else(|| new_message_id(now));
    let full = crate::time::rfc3339(now);
    // the time to the second: `.mmmZ` becomes `Z`
    let ts = match full.rfind('.') {
        Some(dot) => format!("{}Z", &full[..dot]),
        None => full,
    };
    let mut envelope = Map::new();
    envelope.insert("aiap".to_string(), Value::from(AIAP_VERSION));
    envelope.insert("type".to_string(), Value::from("msg"));
    envelope.insert("id".to_string(), Value::from(id.clone()));
    envelope.insert("ts".to_string(), Value::from(ts.clone()));
    if let Some(thread) = input.thread {
        envelope.insert("thread".to_string(), Value::from(thread));
    }
    if let Some(re) = input.re {
        envelope.insert("re".to_string(), Value::from(re));
    }
    envelope.insert("body".to_string(), Value::from(input.body));
    if let Some(problem) = validate(&envelope) {
        return Err(format!("the message cannot be sent: {problem}"));
    }
    let bytes = Value::Object(envelope).to_string().into_bytes();
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(format!(
            "the message cannot be sent: the envelope exceeds {MAX_ENVELOPE_BYTES} bytes"
        ));
    }
    Ok(EncodedMessage { id, ts, bytes })
}

/// JavaScript's `\s`.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// The `aiap` field written as an integer literal somewhere in the text, as
/// Go's decoder requires of an int: `"aiap"\s*:\s*-?\d+\s*[,}]`.
fn aiap_int_literal(text: &str) -> bool {
    let mut from = 0;
    while let Some(found) = text[from..].find("\"aiap\"") {
        let start = from + found;
        from = start + 1;
        let mut rest = text[start + 6..].chars().peekable();
        while rest.next_if(|c| js_space(*c)).is_some() {}
        if rest.next() != Some(':') {
            continue;
        }
        while rest.next_if(|c| js_space(*c)).is_some() {}
        rest.next_if_eq(&'-');
        let mut any = false;
        while rest.next_if(char::is_ascii_digit).is_some() {
            any = true;
        }
        if !any {
            continue;
        }
        while rest.next_if(|c| js_space(*c)).is_some() {}
        if matches!(rest.next(), Some(',' | '}')) {
            return true;
        }
    }
    false
}

/// Sort an inbound payload as aiap's daemon does. Raw: over the envelope cap,
/// or not a JSON object with an integer `aiap` field (its body is the text,
/// or a note for a payload too large or not UTF-8). Foreign: JSON with an
/// `aiap` field that is not a valid v1 envelope. Otherwise the envelope, by
/// its type.
pub fn classify(payload: &[u8]) -> Classified {
    if payload.len() > MAX_ENVELOPE_BYTES {
        return Classified::Raw {
            body: format!("payload too large: {} bytes", payload.len()),
        };
    }
    // Go decodes the JSON before it looks at the bytes: an envelope with a bad byte inside is still an envelope
    // (the byte becomes U+FFFD), and a leading byte order mark is not JSON to it
    let text = String::from_utf8_lossy(payload);
    let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&text) else {
        return Classified::Raw {
            body: raw_body(payload),
        };
    };
    // an integer in the JSON text itself: Go's decoder refuses 1.0 and 1e0 for an int field
    let Some(aiap) = as_integer(record.get("aiap")).filter(|_| aiap_int_literal(&text)) else {
        return Classified::Raw {
            body: raw_body(payload),
        };
    };
    if aiap != AIAP_VERSION {
        let shown = match record.get("aiap") {
            Some(Value::Number(n)) => js_number(n),
            _ => aiap.to_string(),
        };
        return Classified::Foreign {
            note: format!("aiap v{shown} envelope"),
            version: Some(aiap),
        };
    }
    if let Some(problem) = validate(&record) {
        return Classified::Foreign {
            note: problem,
            version: Some(AIAP_VERSION),
        };
    }
    Classified::Envelope(Box::new(envelope_of(&record, aiap)))
}

fn text_of(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(str::to_string)
}

/// A validated record as an envelope; the fields it does not know are left out.
fn envelope_of(record: &Map<String, Value>, aiap: i64) -> Envelope {
    let kind = record
        .get("type")
        .and_then(Value::as_str)
        .and_then(EnvelopeType::parse)
        .unwrap_or(EnvelopeType::Msg);
    let profile = match record.get("profile") {
        Some(Value::Object(p)) => Some(AiapProfile {
            agent: text_of(p, "agent"),
            project: text_of(p, "project"),
            owner: text_of(p, "owner"),
            doing: text_of(p, "doing"),
            host: text_of(p, "host"),
            dir: text_of(p, "dir"),
            updated_at: text_of(p, "updatedAt"),
        }),
        _ => None,
    };
    let receipt = match record.get("receipt") {
        Some(Value::Object(r)) => Some(AiapReceipt {
            of: text_of(r, "of").unwrap_or_default(),
            status: text_of(r, "status").unwrap_or_default(),
        }),
        _ => None,
    };
    Envelope {
        aiap,
        kind,
        id: text_of(record, "id").unwrap_or_default(),
        ts: text_of(record, "ts").unwrap_or_default(),
        thread: text_of(record, "thread"),
        re: text_of(record, "re"),
        body: text_of(record, "body"),
        profile,
        receipt,
    }
}

/// A raw payload's body as the Go daemon shows it: the size first (over the
/// body cap it is a note, not the text), then whether it is UTF-8, then the
/// text itself.
fn raw_body(payload: &[u8]) -> String {
    if payload.len() > MAX_BODY_BYTES {
        return format!("payload too large: {} bytes", payload.len());
    }
    match std::str::from_utf8(payload) {
        Ok(text) => text.to_string(),
        Err(_) => format!("binary payload, {} bytes", payload.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TS: &str = "2026-01-01T00:00:00Z";

    fn enc(value: Value) -> Vec<u8> {
        value.to_string().into_bytes()
    }

    fn raw(text: &str) -> Classified {
        Classified::Raw {
            body: text.to_string(),
        }
    }

    fn foreign_note(classified: Classified) -> String {
        match classified {
            Classified::Foreign { note, .. } => note,
            other => panic!("not foreign: {other:?}"),
        }
    }

    fn valid() -> Value {
        json!({ "aiap": 1, "type": "msg", "id": "A", "ts": TS, "body": "x" })
    }

    fn with(mut base: Value, key: &str, value: Value) -> Value {
        base[key] = value;
        base
    }

    #[test]
    fn ids_are_26_crockford_characters_with_the_time_in_front() {
        let a = new_message_id(crate::time::now_ms());
        assert_eq!(a.len(), 26);
        assert!(a.bytes().all(|b| CROCKFORD.contains(&b)), "{a}");
        assert_ne!(new_message_id(crate::time::now_ms()), a);
        assert_eq!(&new_message_id(0)[..10], "0000000000");
        assert_eq!(&new_message_id(1)[..10], "0000000001");
        assert_eq!(&new_message_id(32)[..10], "0000000010");
    }

    #[test]
    fn a_message_encodes_to_a_v1_envelope_that_classifies_back() {
        let encoded = encode_message(MessageInput {
            body: "hi there".to_string(),
            thread: Some("T1".to_string()),
            re: Some("R1".to_string()),
            now_ms: Some(1_793_880_000_000), // 2026-11-05T12:00:00Z
            ..MessageInput::default()
        })
        .unwrap();
        assert_eq!(encoded.ts, "2026-11-05T12:00:00Z");
        assert_eq!(encoded.id.len(), 26);
        assert_eq!(
            String::from_utf8(encoded.bytes.clone()).unwrap(),
            json!({
                "aiap": 1, "type": "msg", "id": encoded.id, "ts": encoded.ts,
                "thread": "T1", "re": "R1", "body": "hi there"
            })
            .to_string()
        );
        let Classified::Envelope(envelope) = classify(&encoded.bytes) else {
            panic!("not an envelope");
        };
        assert_eq!(envelope.kind, EnvelopeType::Msg);
        assert_eq!(envelope.id, encoded.id);
        assert_eq!(envelope.body.as_deref(), Some("hi there"));
        assert_eq!(envelope.thread.as_deref(), Some("T1"));
        assert_eq!(envelope.re.as_deref(), Some("R1"));
    }

    #[test]
    fn the_caps_refuse_what_aiap_refuses() {
        let body = |b: &str| MessageInput {
            body: b.to_string(),
            ..MessageInput::default()
        };
        assert!(
            encode_message(body(""))
                .unwrap_err()
                .contains("a msg needs a body")
        );
        assert!(
            encode_message(body(&"x".repeat(65537)))
                .unwrap_err()
                .contains("body exceeds 65536 bytes")
        );
        let long_thread = MessageInput {
            thread: Some("t".repeat(65)),
            ..body("x")
        };
        assert!(
            encode_message(long_thread)
                .unwrap_err()
                .contains("thread exceeds 64 bytes")
        );
        let reserved = MessageInput {
            id: Some("raw-1".to_string()),
            ..body("x")
        };
        assert!(
            encode_message(reserved)
                .unwrap_err()
                .contains("reserved prefix raw-")
        );
        assert!(encode_message(body(&"x".repeat(65536))).is_ok());
    }

    #[test]
    fn raw_payloads() {
        assert_eq!(classify(b"hello"), raw("hello"));
        assert_eq!(classify(b"[1,2]"), raw("[1,2]"));
        assert_eq!(classify(br#"{"x":1}"#), raw(r#"{"x":1}"#));
        assert_eq!(classify(br#"{"aiap":"1","type":"msg"}"#).kind(), "raw");
        assert_eq!(classify(&[0xff, 0xfe]), raw("binary payload, 2 bytes"));
        assert_eq!(
            classify("y".repeat(70000).as_bytes()),
            raw("payload too large: 70000 bytes")
        );
        assert_eq!(
            classify(&vec![0u8; 262_145]),
            raw("payload too large: 262145 bytes")
        );
    }

    #[test]
    fn foreign_payloads() {
        assert_eq!(
            classify(&enc(
                json!({ "aiap": 2, "type": "msg", "id": "A", "ts": TS, "body": "x" })
            )),
            Classified::Foreign {
                note: "aiap v2 envelope".to_string(),
                version: Some(2)
            }
        );
        let unknown = classify(&enc(
            json!({ "aiap": 1, "type": "nope", "id": "A", "ts": TS }),
        ));
        assert!(matches!(
            unknown,
            Classified::Foreign {
                version: Some(1),
                ..
            }
        ));
        assert!(foreign_note(unknown).contains("unknown type"));
        assert!(
            foreign_note(classify(&enc(
                json!({ "aiap": 1, "type": "msg", "id": "A", "ts": TS })
            )))
            .contains("needs a body")
        );
        assert!(
            foreign_note(classify(&enc(with(valid(), "id", json!("raw-7")))))
                .contains("reserved prefix")
        );
        assert!(
            foreign_note(classify(&enc(with(valid(), "ts", json!("yesterday")))))
                .contains("RFC 3339")
        );
        assert!(
            foreign_note(classify(&enc(json!({
                "aiap": 1, "type": "receipt", "id": "A", "ts": TS,
                "receipt": { "of": "B", "status": "read" }
            }))))
            .contains("not delivered")
        );
    }

    #[test]
    fn the_other_envelope_types_classify_by_type() {
        assert_eq!(
            classify(&enc(
                json!({ "aiap": 1, "type": "profile-query", "id": "Q", "ts": TS })
            ))
            .kind(),
            "profile-query"
        );
        assert_eq!(
            classify(&enc(json!({
                "aiap": 1, "type": "profile", "id": "P", "ts": TS,
                "profile": { "agent": "beta", "project": "abai" }
            })))
            .kind(),
            "profile"
        );
        assert!(
            foreign_note(classify(&enc(json!({
                "aiap": 1, "type": "profile", "id": "P", "ts": TS, "profile": { "agent": "Beta!" }
            }))))
            .contains("not an agent name")
        );
        assert_eq!(
            classify(&enc(json!({
                "aiap": 1, "type": "receipt", "id": "R", "ts": TS,
                "receipt": { "of": "B", "status": "delivered" }
            })))
            .kind(),
            "receipt"
        );
    }

    #[test]
    fn validate_names_the_first_problem() {
        let object = |v: Value| v.as_object().unwrap().clone();
        assert_eq!(
            validate(&object(with(valid(), "id", json!("")))),
            Some("id is required".to_string())
        );
        assert_eq!(validate(&object(valid())), None);
        assert_eq!(
            validate(&object(json!({ "type": "msg" }))),
            Some("aiap version undefined is not 1".to_string())
        );
        assert_eq!(
            validate(&object(json!({ "aiap": 1 }))),
            Some("unknown type undefined".to_string())
        );
    }

    #[test]
    fn aiap_must_be_an_integer_literal() {
        let text = |s: &str| classify(s.as_bytes()).kind();
        assert_eq!(
            text(r#"{"aiap":1.0,"type":"msg","id":"A","ts":"2026-01-01T00:00:00Z","body":"x"}"#),
            "raw"
        );
        assert_eq!(
            text(r#"{"aiap":1e0,"type":"msg","id":"A","ts":"2026-01-01T00:00:00Z","body":"x"}"#),
            "raw"
        );
        assert_eq!(text(r#"{"aiap":true,"type":"msg"}"#), "raw");
        assert_eq!(classify(&enc(valid())).kind(), "msg");
        assert_eq!(
            text(r#"{ "aiap" : 1 , "type":"msg","id":"A","ts":"2026-01-01T00:00:00Z","body":"x"}"#),
            "msg"
        );
    }

    #[test]
    fn a_null_field_is_a_field_not_given() {
        let mut nulls = valid();
        nulls["thread"] = Value::Null;
        nulls["re"] = Value::Null;
        assert_eq!(classify(&enc(nulls)).kind(), "msg");
        assert_eq!(
            classify(&enc(json!({
                "aiap": 1, "type": "profile", "id": "P", "ts": TS,
                "profile": { "agent": null, "project": "abai" }
            })))
            .kind(),
            "profile"
        );
        assert_eq!(
            classify(&enc(
                json!({ "aiap": 1, "type": "profile", "id": "P", "ts": TS, "profile": [] })
            ))
            .kind(),
            "foreign"
        );
        assert_eq!(
            foreign_note(classify(&enc(with(valid(), "body", Value::Null)))),
            "a msg needs a body"
        );
    }

    #[test]
    fn the_json_is_read_before_the_bytes_are_judged() {
        let mut bytes = enc(with(valid(), "body", json!("aQ")));
        let q = bytes.iter().position(|&b| b == b'Q').unwrap();
        bytes[q] = 0xff; // the Q becomes a byte no UTF-8 text has
        let Classified::Envelope(envelope) = classify(&bytes) else {
            panic!("not an envelope");
        };
        assert_eq!(envelope.body.as_deref(), Some("a\u{FFFD}"));
        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend(enc(valid()));
        let Classified::Raw { body } = classify(&bom) else {
            panic!("not raw");
        };
        assert!(body.starts_with("\u{FEFF}{"));
        assert_eq!(
            classify(&vec![0xff; 70000]),
            raw("payload too large: 70000 bytes")
        );
    }

    #[test]
    fn a_time_out_of_range_is_not_rfc_3339() {
        assert!(
            foreign_note(classify(&enc(with(
                valid(),
                "ts",
                json!("2026-02-30T00:00:00Z")
            ))))
            .contains("RFC 3339")
        );
        assert_eq!(
            classify(&enc(with(valid(), "ts", json!("2026-01-01T24:00:00Z")))).kind(),
            "foreign"
        );
        assert_eq!(
            classify(&enc(with(
                valid(),
                "ts",
                json!("2026-01-01T00:00:00+05:30")
            )))
            .kind(),
            "msg"
        );
        assert_eq!(
            classify(&enc(with(valid(), "ts", json!("2026-12-31T23:59:59.123Z")))).kind(),
            "msg"
        );
        assert!(is_rfc3339("2024-02-29T00:00:00Z"));
        assert!(!is_rfc3339("2023-02-29T00:00:00Z"));
        assert!(!is_rfc3339("2026-01-01T00:00:00"));
        assert!(!is_rfc3339("2026-01-01T00:00:00.Z"));
    }
}
