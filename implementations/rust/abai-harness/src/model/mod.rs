//! The model connection (contract section 9): one small client for two
//! API shapes, the Anthropic Messages API and the OpenAI-compatible chat
//! completions API. A request is sent whole and its reply read whole.

pub mod anthropic;
#[doc(hidden)]
pub mod fake;
pub mod openai;
pub mod resolve;

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, mpsc};
use std::time::{Duration, Instant};

use serde_json::Value;

/// A tool the model may call.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// The JSON Schema of the tool's input, an object schema.
    pub schema: Value,
}

/// The model asks for a tool to be run.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

/// What a tool call came to.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    /// The id of the call this answers.
    pub id: String,
    pub content: String,
    pub is_error: bool,
}

/// One entry of a conversation.
#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    User(String),
    Assistant {
        text: String,
        calls: Vec<ToolCall>,
        /// The provider's own form of this message. When present it is
        /// sent back unchanged, since a provider may put more in a
        /// message than text and calls.
        raw: Option<Value>,
    },
    Results(Vec<ToolResult>),
}

/// Why the model stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    /// It finished what it had to say.
    End,
    /// It asked for tools to be run.
    ToolUse,
    /// It ran into the output limit; a tool call in the reply may be cut
    /// short and must not be run.
    MaxTokens,
    /// The provider declined the request; nothing in the reply is run.
    Refusal,
    /// The provider paused a long turn; sending the conversation again
    /// continues it.
    Pause,
    Other(String),
}

/// Tokens a request used.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
}

/// The model's reply to one request.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub text: String,
    pub calls: Vec<ToolCall>,
    pub stop: Stop,
    pub raw: Option<Value>,
    pub usage: Usage,
}

impl Reply {
    /// The reply as the conversation's next entry.
    pub fn into_message(self) -> Message {
        Message::Assistant {
            text: self.text,
            calls: self.calls,
            raw: self.raw,
        }
    }
}

/// A request: the whole conversation each time.
#[derive(Debug, Clone, Copy)]
pub struct Request<'a> {
    pub system: &'a str,
    pub tools: &'a [ToolSpec],
    pub messages: &'a [Message],
    /// The time left for this request, retries included, when the step it
    /// belongs to has a deadline.
    pub limit: Option<Duration>,
}

/// What ends a request in flight: the harness is told to stop, or the
/// process is sent a signal to end. The default is never raised.
#[derive(Debug, Clone, Default)]
pub struct Cancel(Option<Arc<Flags>>);

#[derive(Debug, Default)]
struct Flags {
    stop: AtomicBool,
    /// A flag a signal handler raises.
    signal: OnceLock<&'static AtomicBool>,
}

impl Cancel {
    /// One that can be raised.
    pub fn new() -> Self {
        Self(Some(Arc::new(Flags::default())))
    }

    /// Raise it. It stays raised.
    pub fn raise(&self) {
        if let Some(flags) = &self.0 {
            flags.stop.store(true, Ordering::SeqCst);
        }
    }

    /// Also follow a flag a signal handler raises.
    pub fn watch(&self, signal: &'static AtomicBool) {
        if let Some(flags) = &self.0 {
            let _ = flags.signal.set(signal);
        }
    }

    /// Whether the watched signal has come.
    pub fn signalled(&self) -> bool {
        self.0.as_ref().is_some_and(|flags| {
            flags
                .signal
                .get()
                .is_some_and(|signal| signal.load(Ordering::SeqCst))
        })
    }

    pub fn raised(&self) -> bool {
        self.0
            .as_ref()
            .is_some_and(|flags| flags.stop.load(Ordering::SeqCst))
            || self.signalled()
    }

    fn can_be_raised(&self) -> bool {
        self.0.is_some()
    }
}

/// How often a request in flight looks at its `Cancel`.
const CANCEL_CHECK: Duration = Duration::from_millis(20);

/// A request that got no reply to use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelError {
    /// No connection, or no answer in time. The harness detaches.
    Unreachable(String),
    /// The provider answered with an error that trying again will not
    /// change: a bad key, an unknown model, a request it does not accept.
    Rejected { status: u16, message: String },
    /// The provider was busy or failing, and still was after the retries.
    Busy { status: u16, message: String },
    /// The provider's answer was not in the shape its API gives.
    Protocol(String),
    /// The request's own time limit passed before a reply came.
    TimedOut,
    /// The harness was told to stop while the request was in flight.
    Cancelled,
}

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable(why) => write!(f, "the model could not be reached: {why}"),
            Self::Rejected { status, message } => {
                write!(
                    f,
                    "the model's provider refused the request ({status}): {message}"
                )
            }
            Self::Busy { status, message } => {
                write!(f, "the model's provider is busy ({status}): {message}")
            }
            Self::Protocol(why) => write!(f, "the model's answer could not be read: {why}"),
            Self::TimedOut => write!(f, "the model did not answer in the time there was"),
            Self::Cancelled => write!(f, "the request was cut off: the harness is ending"),
        }
    }
}

impl std::error::Error for ModelError {}

/// A model to talk to.
pub trait Model: Send {
    /// The provider and model, for people: `anthropic claude-opus-5-5`.
    fn name(&self) -> String;

    /// Send the conversation and read the reply.
    fn complete(&mut self, request: &Request<'_>) -> Result<Reply, ModelError>;

    /// Ask the provider something small that costs nothing, to learn
    /// whether it can be reached and takes the key: its list of models.
    /// Returns a line for `doctor`.
    fn probe(&self) -> Result<String, ModelError>;

    /// What ends a request of this model while it is in flight.
    fn cancel_with(&mut self, _cancel: &Cancel) {}
}

/// How long to wait for a connection and for a whole reply, and how the
/// retries are paced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timing {
    /// The longest wait for a connection (the machine configuration's
    /// connect timeout).
    pub connect: Duration,
    /// The longest a whole request may take.
    pub total: Duration,
    /// The wait before the first retry; the second waits twice as long.
    pub retry: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(30),
            total: Duration::from_secs(600),
            retry: Duration::from_secs(1),
        }
    }
}

/// How many times a busy provider is asked again.
const RETRIES: u32 = 2;
/// The longest a provider's own retry-after is honoured.
const RETRY_AFTER_CAP: Duration = Duration::from_secs(20);

/// The HTTP side shared by both API shapes.
pub(crate) struct Http {
    agent: ureq::Agent,
    timing: Timing,
    pub(crate) cancel: Cancel,
}

/// One answer as it came: the status, the retry-after, the body.
type Raw = Result<(u16, Option<u64>, String), ureq::Error>;

/// Send one request and read its whole answer.
fn send(
    agent: &ureq::Agent,
    url: &str,
    headers: &[(String, String)],
    text: &str,
    left: Duration,
) -> Raw {
    let mut request = agent
        .post(url)
        .config()
        .timeout_global(Some(left))
        .build()
        .header("content-type", "application/json");
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let mut response = request.send(text)?;
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok());
    let answer = response.body_mut().read_to_string()?;
    Ok((status, retry_after, answer))
}

impl fmt::Debug for Http {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Http")
            .field("timing", &self.timing)
            .finish()
    }
}

/// A status that is worth asking again for.
fn retryable(status: u16) -> bool {
    matches!(status, 408 | 429) || (status >= 500 && status != 501 && status != 505)
}

/// The wait before the next attempt: the provider's own retry-after, up
/// to a cap, else the base doubled for each attempt made.
/// The longest a probe of the provider may take.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

fn pause(retry_after: Option<u64>, attempt: u32, base: Duration) -> Duration {
    match retry_after {
        Some(seconds) => Duration::from_secs(seconds).min(RETRY_AFTER_CAP),
        None => base * 2u32.pow(attempt),
    }
}

impl Http {
    pub(crate) fn new(timing: Timing) -> Self {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_resolve(Some(timing.connect))
            .timeout_connect(Some(timing.connect))
            .timeout_global(Some(timing.total))
            .build()
            .into();
        Self {
            agent,
            timing,
            cancel: Cancel::default(),
        }
    }

    /// One attempt. With a `Cancel` that can be raised the request runs
    /// on a thread of its own, so this one can leave it: the blocking
    /// call cannot be interrupted, and a request left behind ends by
    /// itself at its time limit with nobody to read it.
    fn attempt(
        &self,
        url: &str,
        headers: &[(String, String)],
        text: &Arc<str>,
        left: Duration,
    ) -> Result<Raw, ModelError> {
        if !self.cancel.can_be_raised() {
            return Ok(send(&self.agent, url, headers, text, left));
        }
        if self.cancel.raised() {
            return Err(ModelError::Cancelled);
        }
        let (done, answer) = mpsc::channel();
        let (agent, url, headers, text) = (
            self.agent.clone(),
            url.to_string(),
            headers.to_vec(),
            Arc::clone(text),
        );
        std::thread::Builder::new()
            .name("abai-model".to_string())
            .spawn(move || {
                let _ = done.send(send(&agent, &url, &headers, &text, left));
            })
            .map_err(|error| {
                ModelError::Unreachable(format!("no thread for the request: {error}"))
            })?;
        loop {
            match answer.recv_timeout(CANCEL_CHECK) {
                Ok(raw) => return Ok(raw),
                Err(mpsc::RecvTimeoutError::Timeout) if self.cancel.raised() => {
                    return Err(ModelError::Cancelled);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(ModelError::Unreachable(
                        "the request's thread ended without an answer".to_string(),
                    ));
                }
            }
        }
    }

    /// Wait before a retry, unless told to stop meanwhile.
    fn wait(&self, wait: Duration) -> Result<(), ModelError> {
        let until = Instant::now() + wait;
        loop {
            if self.cancel.raised() {
                return Err(ModelError::Cancelled);
            }
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(());
            }
            std::thread::sleep(left.min(CANCEL_CHECK));
        }
    }

    /// POST a JSON body and return the body of a 2xx answer. A busy
    /// provider is asked again; `error_message` reads the provider's
    /// error out of a failed answer's body.
    pub(crate) fn post(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: &Value,
        error_message: fn(&str) -> Option<String>,
        limit: Option<Duration>,
    ) -> Result<Value, ModelError> {
        let text: Arc<str> = Arc::from(body.to_string());
        let headers: Vec<(String, String)> = headers
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect();
        let deadline = limit.map(|limit| Instant::now() + limit);
        // an error after the request's own time is up is that, not a
        // provider that cannot be reached
        let failed = |error: ureq::Error| match deadline {
            Some(deadline) if Instant::now() >= deadline => ModelError::TimedOut,
            _ => ModelError::Unreachable(error.to_string()),
        };
        let mut attempt = 0;
        loop {
            let left = match deadline {
                None => self.timing.total,
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Err(ModelError::TimedOut);
                    }
                    left.min(self.timing.total)
                }
            };
            let (status, retry_after, answer) =
                self.attempt(url, &headers, &text, left)?.map_err(failed)?;
            if (200..300).contains(&status) {
                return serde_json::from_str(&answer)
                    .map_err(|error| ModelError::Protocol(format!("not JSON: {error}")));
            }
            let message = error_message(&answer)
                .unwrap_or_else(|| abai_stub::manifest::cut_utf8(answer.trim(), 300).to_string());
            if !retryable(status) {
                return Err(ModelError::Rejected { status, message });
            }
            if attempt == RETRIES {
                return Err(ModelError::Busy { status, message });
            }
            let wait = pause(retry_after, attempt, self.timing.retry);
            if deadline.is_some_and(|deadline| Instant::now() + wait >= deadline) {
                return Err(ModelError::TimedOut);
            }
            self.wait(wait)?;
            attempt += 1;
        }
    }
}

impl Http {
    /// GET a small resource and return its status and body.
    pub(crate) fn get(
        &self,
        url: &str,
        headers: &[(&str, &str)],
    ) -> Result<(u16, String), ModelError> {
        // a small question: it gets a short time of its own
        let mut request = self
            .agent
            .get(url)
            .config()
            .timeout_global(Some(PROBE_TIMEOUT.min(self.timing.total)))
            .build();
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let mut response = request
            .call()
            .map_err(|error| ModelError::Unreachable(error.to_string()))?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .read_to_string()
            .map_err(|error| ModelError::Unreachable(error.to_string()))?;
        Ok((status, body))
    }

    /// GET a provider's model list and say what came of it.
    pub(crate) fn probe(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        error_message: fn(&str) -> Option<String>,
    ) -> Result<String, ModelError> {
        let (status, body) = self.get(url, headers)?;
        if (200..300).contains(&status) {
            return Ok(format!("{url} answered"));
        }
        let message = error_message(&body)
            .unwrap_or_else(|| abai_stub::manifest::cut_utf8(body.trim(), 300).to_string());
        Err(ModelError::Rejected { status, message })
    }
}

/// A string field of a JSON object.
pub(crate) fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::fake::{Answer, FakeProvider};
    use serde_json::json;

    fn http() -> Http {
        Http::new(Timing {
            connect: Duration::from_secs(2),
            total: Duration::from_secs(5),
            retry: Duration::from_millis(5),
        })
    }

    #[test]
    fn a_redirect_is_not_followed() {
        let provider = FakeProvider::start(vec![Answer {
            status: 302,
            headers: vec![("location".into(), "http://127.0.0.1:1/".into())],
            body: String::new(),
        }]);
        let error = http()
            .post(
                &format!("{}/x", provider.url),
                &[],
                &json!({}),
                |_| None,
                None,
            )
            .unwrap_err();
        assert!(
            matches!(error, ModelError::Rejected { status: 302, .. }),
            "{error:?}"
        );
        assert_eq!(provider.requests().len(), 1);
    }

    #[test]
    fn retryable_statuses() {
        for status in [408, 429, 500, 502, 503, 504, 529] {
            assert!(retryable(status), "{status}");
        }
        for status in [400, 401, 404, 409, 501, 505] {
            assert!(!retryable(status), "{status}");
        }
    }

    #[test]
    fn a_retry_after_of_zero_is_honoured() {
        let provider = FakeProvider::start(vec![
            Answer {
                status: 429,
                headers: vec![("retry-after".into(), "0".into())],
                body: String::new(),
            },
            Answer::ok(json!({"ok": true})),
        ]);
        let answer = http()
            .post(
                &format!("{}/x", provider.url),
                &[],
                &json!({}),
                |_| None,
                None,
            )
            .unwrap();
        assert_eq!(answer, json!({"ok": true}));
        assert_eq!(provider.requests().len(), 2);
    }

    #[test]
    fn pauses_are_capped_or_doubled() {
        let base = Duration::from_millis(100);
        assert_eq!(pause(Some(100), 0, base), Duration::from_secs(20));
        assert_eq!(pause(Some(0), 1, base), Duration::ZERO);
        assert_eq!(pause(None, 0, base), base);
        assert_eq!(pause(None, 1, base), 2 * base);
    }

    #[test]
    fn a_request_in_flight_is_left_when_it_is_cancelled() {
        let provider = FakeProvider::start(vec![Answer::ok(json!({}))]);
        provider.set_delay(Duration::from_secs(3));
        let mut http = Http::new(Timing::default());
        http.cancel = Cancel::new();
        let (cancel, started) = (http.cancel.clone(), Instant::now());
        let raiser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancel.raise();
        });
        let url = format!("{}/x", provider.url);
        let error = http
            .post(&url, &[], &json!({}), |_| None, None)
            .unwrap_err();
        assert_eq!(error, ModelError::Cancelled);
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
        raiser.join().unwrap();
        // once raised, nothing more is sent
        let error = http
            .post(&url, &[], &json!({}), |_| None, None)
            .unwrap_err();
        assert_eq!(error, ModelError::Cancelled);
        assert_eq!(provider.requests().len(), 1);

        // the wait before a retry is left too: a provider of its own,
        // which answers "busy" at once
        let provider = FakeProvider::start(vec![Answer::status(503, json!("busy"))]);
        let url = format!("{}/x", provider.url);
        let mut http = Http::new(Timing {
            retry: Duration::from_secs(30),
            ..Timing::default()
        });
        http.cancel = Cancel::new();
        let (cancel, started) = (http.cancel.clone(), Instant::now());
        let raiser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            cancel.raise();
        });
        let error = http
            .post(&url, &[], &json!({}), |_| None, None)
            .unwrap_err();
        assert_eq!(error, ModelError::Cancelled);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        raiser.join().unwrap();
        // it was asked once, and the wait for the second try was left
        assert_eq!(provider.requests().len(), 1);
    }

    #[test]
    fn a_request_with_a_limit_times_out_and_is_not_called_unreachable() {
        let provider = FakeProvider::start(vec![Answer::ok(json!({}))]);
        provider.set_delay(Duration::from_millis(400));
        let http = Http::new(Timing::default());
        let started = Instant::now();
        let error = http
            .post(
                &format!("{}/x", provider.url),
                &[],
                &json!({}),
                |_| None,
                Some(Duration::from_millis(100)),
            )
            .unwrap_err();
        assert_eq!(error, ModelError::TimedOut);
        assert!(started.elapsed() < Duration::from_millis(350));

        // with no time left at all, nothing is sent
        let before = provider.requests().len();
        let error = http
            .post(
                &format!("{}/x", provider.url),
                &[],
                &json!({}),
                |_| None,
                Some(Duration::ZERO),
            )
            .unwrap_err();
        assert_eq!(error, ModelError::TimedOut);
        assert_eq!(provider.requests().len(), before);
    }
}
