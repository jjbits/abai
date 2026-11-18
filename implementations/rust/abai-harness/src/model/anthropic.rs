//! The Anthropic Messages API (`POST /v1/messages`).

use std::fmt;

use serde_json::{Value, json};

use super::{
    Cancel, Http, Message, Model, ModelError, Reply, Request, Stop, Timing, ToolCall, Usage,
    text_of,
};

/// The API version this client speaks.
pub const API_VERSION: &str = "2026-10-21";
pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
/// The output limit of one reply. A request is read whole, so this stays
/// well under what would need streaming.
pub const DEFAULT_MAX_TOKENS: u64 = 16_000;

/// The beta under which a declined request is run again on another model.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// The models whose provider may decline a request by a safety
/// classifier, and for which the fallback is asked for.
const FALLBACK_MODELS: &[&str] = &[
    "claude-fable-5-2",
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5-5",
];

/// A model behind the Anthropic Messages API.
pub struct Anthropic {
    http: Http,
    base_url: String,
    key: String,
    model: String,
    max_tokens: u64,
    fallbacks: bool,
}

impl fmt::Debug for Anthropic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Anthropic")
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("fallbacks", &self.fallbacks)
            .field("key", &"(set)")
            .finish()
    }
}

impl Anthropic {
    /// `fallbacks` asks the provider to run a declined request again on
    /// another model; it is used only for the models that support it, and
    /// only at the provider's own address. `base_url` may end in `/v1`.
    pub fn new(base_url: &str, key: &str, model: &str, timing: Timing, fallbacks: bool) -> Self {
        let trimmed = base_url.trim().trim_end_matches('/');
        let base_url = trimmed.strip_suffix("/v1").unwrap_or(trimmed).to_string();
        let fallbacks =
            fallbacks && FALLBACK_MODELS.contains(&model) && base_url == DEFAULT_BASE_URL;
        Self {
            http: Http::new(timing),
            base_url,
            key: key.to_string(),
            model: model.to_string(),
            max_tokens: DEFAULT_MAX_TOKENS,
            fallbacks,
        }
    }

    fn body(&self, request: &Request<'_>) -> Value {
        let mut body = json!({
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": messages(request.messages),
        });
        if !request.system.is_empty() {
            body["system"] = json!(request.system);
        }
        if !request.tools.is_empty() {
            body["tools"] = request
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "input_schema": tool.schema,
                    })
                })
                .collect();
        }
        if self.fallbacks {
            body["fallbacks"] = json!("default");
        }
        body
    }
}

fn is_tool_result(block: &Value) -> bool {
    text_of(block, "type") == Some("tool_result")
}

/// The conversation in the API's form. Entries of the same role that
/// follow each other become one message, since the roles alternate; in a
/// user message the tool results come first. An entry with nothing to
/// send is left out.
fn messages(conversation: &[Message]) -> Value {
    let mut out: Vec<(&str, Vec<Value>)> = Vec::new();
    for message in conversation {
        let (role, blocks) = match message {
            Message::User(text) if text.trim().is_empty() => ("user", Vec::new()),
            Message::User(text) => ("user", vec![json!({"type": "text", "text": text})]),
            Message::Assistant {
                raw: Some(Value::Array(blocks)),
                ..
            } => ("assistant", blocks.clone()),
            Message::Assistant { text, calls, .. } => {
                let mut blocks = Vec::new();
                if !text.trim().is_empty() {
                    blocks.push(json!({"type": "text", "text": text}));
                }
                for call in calls {
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": call.input,
                    }));
                }
                ("assistant", blocks)
            }
            Message::Results(results) => (
                "user",
                results
                    .iter()
                    .map(|result| {
                        let mut block = json!({
                            "type": "tool_result",
                            "tool_use_id": result.id,
                            "content": result.content,
                        });
                        if result.is_error {
                            block["is_error"] = json!(true);
                        }
                        block
                    })
                    .collect(),
            ),
        };
        if blocks.is_empty() {
            continue;
        }
        match out.last_mut() {
            Some((last, content)) if *last == role => {
                let (results, others): (Vec<Value>, Vec<Value>) =
                    blocks.into_iter().partition(is_tool_result);
                let at = content
                    .iter()
                    .rposition(is_tool_result)
                    .map_or(0, |index| index + 1);
                content.splice(at..at, results);
                content.extend(others);
            }
            _ => out.push((role, blocks)),
        }
    }
    out.into_iter()
        .map(|(role, content)| json!({"role": role, "content": content}))
        .collect()
}

/// The provider's words out of an error body:
/// `{"type":"error","error":{"type":"...","message":"..."}}`.
fn error_message(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let error = value.get("error")?;
    let message = text_of(error, "message")?;
    Some(match text_of(error, "type") {
        Some(kind) => format!("{kind}: {message}"),
        None => message.to_string(),
    })
}

fn reply(answer: Value) -> Result<Reply, ModelError> {
    let Some(blocks) = answer.get("content").and_then(Value::as_array) else {
        return Err(ModelError::Protocol(
            "the answer has no content".to_string(),
        ));
    };
    let mut text = String::new();
    let mut calls = Vec::new();
    for block in blocks {
        match text_of(block, "type") {
            Some("text") => text.push_str(text_of(block, "text").unwrap_or("")),
            Some("tool_use") => calls.push(ToolCall {
                id: text_of(block, "id").unwrap_or("").to_string(),
                name: text_of(block, "name").unwrap_or("").to_string(),
                input: block.get("input").cloned().unwrap_or(Value::Null),
            }),
            // thinking and any other block stays in `raw`, to go back as it came
            _ => {}
        }
    }
    let stop = match text_of(&answer, "stop_reason") {
        Some("end_turn") | Some("stop_sequence") => Stop::End,
        Some("tool_use") => Stop::ToolUse,
        Some("max_tokens") => Stop::MaxTokens,
        Some("refusal") => Stop::Refusal,
        Some("pause_turn") => Stop::Pause,
        other => Stop::Other(other.unwrap_or("none").to_string()),
    };
    let tokens = |key: &str| {
        answer
            .get("usage")
            .and_then(|usage| usage.get(key))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    Ok(Reply {
        text,
        calls,
        stop,
        usage: Usage {
            input: tokens("input_tokens"),
            output: tokens("output_tokens"),
        },
        raw: Some(Value::Array(blocks.clone())),
    })
}

impl Model for Anthropic {
    fn name(&self) -> String {
        format!("anthropic {}", self.model)
    }

    fn complete(&mut self, request: &Request<'_>) -> Result<Reply, ModelError> {
        let url = format!("{}/v1/messages", self.base_url);
        let mut headers = vec![
            ("x-api-key", self.key.as_str()),
            ("anthropic-version", API_VERSION),
        ];
        if self.fallbacks {
            headers.push(("anthropic-beta", FALLBACK_BETA));
        }
        let answer = self.http.post(
            &url,
            &headers,
            &self.body(request),
            error_message,
            request.limit,
        )?;
        reply(answer)
    }

    fn cancel_with(&mut self, cancel: &Cancel) {
        self.http.cancel = cancel.clone();
    }

    fn probe(&self) -> Result<String, ModelError> {
        let url = format!("{}/v1/models?limit=1", self.base_url);
        let headers = [
            ("x-api-key", self.key.as_str()),
            ("anthropic-version", API_VERSION),
        ];
        self.http.probe(&url, &headers, error_message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::fake::{Answer, FakeProvider};
    use crate::model::{ToolResult, ToolSpec};
    use std::time::Duration;

    fn timing() -> Timing {
        Timing {
            connect: Duration::from_secs(2),
            total: Duration::from_secs(5),
            retry: Duration::from_millis(5),
        }
    }

    fn tools() -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "abai_cells".to_string(),
            description: "Read cells.".to_string(),
            schema: json!({"type": "object", "properties": {}}),
        }]
    }

    fn tool_use_answer() -> Value {
        json!({
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "", "signature": "sig"},
                {"type": "text", "text": "Let me look."},
                {"type": "tool_use", "id": "toolu_1", "name": "abai_cells", "input": {"names": ["count"]}}
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 120, "output_tokens": 30}
        })
    }

    #[test]
    fn a_request_carries_the_headers_the_tools_and_the_conversation() {
        let provider = FakeProvider::start(vec![Answer::ok(tool_use_answer())]);
        let mut model =
            Anthropic::new(&provider.url, "sk-test", "claude-haiku-5-5", timing(), true);
        assert_eq!(model.name(), "anthropic claude-haiku-5-5");
        let messages = [Message::User("How far has it got?".to_string())];
        let reply = model
            .complete(&Request {
                system: "You are the agent.",
                tools: &tools(),
                messages: &messages,
                limit: None,
            })
            .unwrap();

        assert_eq!(reply.text, "Let me look.");
        assert_eq!(reply.stop, Stop::ToolUse);
        assert_eq!(
            reply.usage,
            Usage {
                input: 120,
                output: 30
            }
        );
        assert_eq!(
            reply.calls,
            [ToolCall {
                id: "toolu_1".to_string(),
                name: "abai_cells".to_string(),
                input: json!({"names": ["count"]}),
            }]
        );

        let sent = &provider.requests()[0];
        assert_eq!(sent.path, "/v1/messages");
        assert_eq!(sent.header("x-api-key"), Some("sk-test"));
        assert_eq!(sent.header("anthropic-version"), Some("2026-10-21"));
        assert_eq!(sent.header("content-type"), Some("application/json"));
        // this model takes no fallback, so none is asked for
        assert_eq!(sent.header("anthropic-beta"), None);
        assert_eq!(
            sent.body,
            json!({
                "model": "claude-haiku-5-5",
                "max_tokens": 16000,
                "messages": [
                    {"role": "user", "content": [{"type": "text", "text": "How far has it got?"}]}
                ],
                "system": "You are the agent.",
                "tools": [{
                    "name": "abai_cells",
                    "description": "Read cells.",
                    "input_schema": {"type": "object", "properties": {}}
                }]
            })
        );
    }

    #[test]
    fn the_assistants_own_blocks_go_back_as_they_came() {
        let done = json!({
            "content": [{"type": "text", "text": "It is at 41."}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 200, "output_tokens": 8}
        });
        let provider = FakeProvider::start(vec![Answer::ok(tool_use_answer()), Answer::ok(done)]);
        let mut model = Anthropic::new(&provider.url, "k", "claude-haiku-5-5", timing(), false);
        let mut messages = vec![Message::User("How far?".to_string())];
        fn request(messages: &[Message]) -> Request<'_> {
            Request {
                system: "",
                tools: &[],
                messages,
                limit: None,
            }
        }
        let first = model.complete(&request(&messages)).unwrap();
        messages.push(first.into_message());
        messages.push(Message::Results(vec![ToolResult {
            id: "toolu_1".to_string(),
            content: r#"{"count":41}"#.to_string(),
            is_error: false,
        }]));
        // a wake that follows the results joins them in one user message
        messages.push(Message::User("[abai wake] a turn".to_string()));
        let last = model.complete(&request(&messages)).unwrap();
        assert_eq!((last.text.as_str(), last.stop), ("It is at 41.", Stop::End));

        let sent = &provider.requests()[1].body;
        assert!(sent.get("system").is_none() && sent.get("tools").is_none());
        assert_eq!(
            sent["messages"],
            json!([
                {"role": "user", "content": [{"type": "text", "text": "How far?"}]},
                {"role": "assistant", "content": tool_use_answer()["content"]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_1", "content": "{\"count\":41}"},
                    {"type": "text", "text": "[abai wake] a turn"}
                ]}
            ])
        );
    }

    #[test]
    fn a_message_with_no_raw_form_is_built_from_its_parts() {
        let conversation = [
            Message::Assistant {
                text: "Calling.".to_string(),
                calls: vec![ToolCall {
                    id: "t1".to_string(),
                    name: "abai_call".to_string(),
                    input: json!({"capability": "reset"}),
                }],
                raw: None,
            },
            Message::Results(vec![ToolResult {
                id: "t1".to_string(),
                content: "denied".to_string(),
                is_error: true,
            }]),
        ];
        assert_eq!(
            messages(&conversation),
            json!([
                {"role": "assistant", "content": [
                    {"type": "text", "text": "Calling."},
                    {"type": "tool_use", "id": "t1", "name": "abai_call", "input": {"capability": "reset"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "denied", "is_error": true}
                ]}
            ])
        );
    }

    #[test]
    fn the_fallback_is_asked_for_only_where_it_exists_and_is_wanted() {
        let answer = || Answer::ok(json!({"content": [], "stop_reason": "refusal"}));
        let provider = FakeProvider::start(vec![answer(), answer()]);
        let messages = [Message::User("x".to_string())];
        let request = Request {
            system: "",
            tools: &[],
            messages: &messages,
            limit: None,
        };
        let mut wanted = Anthropic::new(DEFAULT_BASE_URL, "k", "claude-opus-5-5", timing(), true);
        // sent to the fake, as it would be to the provider's own address
        wanted.base_url = provider.url.clone();
        assert_eq!(wanted.complete(&request).unwrap().stop, Stop::Refusal);
        let mut unwanted = Anthropic::new(&provider.url, "k", "claude-opus-5-5", timing(), false);
        unwanted.complete(&request).unwrap();

        let sent = provider.requests();
        assert_eq!(
            sent[0].header("anthropic-beta"),
            Some("server-side-fallback-2026-07-01")
        );
        assert_eq!(sent[0].body["fallbacks"], "default");
        assert_eq!(sent[1].header("anthropic-beta"), None);
        assert!(sent[1].body.get("fallbacks").is_none());
    }

    #[test]
    fn the_fallback_is_asked_for_only_at_the_providers_own_address() {
        let at =
            |base: &str| Anthropic::new(base, "k", "claude-opus-5-5", timing(), true).fallbacks;
        assert!(at(DEFAULT_BASE_URL));
        assert!(at("https://api.anthropic.com/"));
        assert!(at("https://api.anthropic.com/v1"));
        assert!(!at("http://127.0.0.1:9"));
        assert!(!at("https://proxy.example/v1"));
    }

    #[test]
    fn a_base_url_ending_in_v1_is_not_doubled() {
        let done = || Answer::ok(json!({"content": [], "stop_reason": "end_turn"}));
        let provider = FakeProvider::start(vec![done(), done()]);
        let messages = [Message::User("x".to_string())];
        let request = Request {
            system: "",
            tools: &[],
            messages: &messages,
            limit: None,
        };
        for base in [format!("{}/v1/", provider.url), provider.url.clone()] {
            let mut model = Anthropic::new(&base, "k", "m", timing(), false);
            model.complete(&request).unwrap();
        }
        let sent = provider.requests();
        assert_eq!(sent[0].path, "/v1/messages");
        assert_eq!(sent[1].path, "/v1/messages");
    }

    #[test]
    fn the_key_is_not_in_the_debug_form() {
        let model = Anthropic::new(DEFAULT_BASE_URL, "sk-secret", "m", timing(), false);
        let shown = format!("{model:?}");
        assert!(!shown.contains("sk-secret"), "{shown}");
        assert!(
            shown.contains("(set)") && shown.contains("api.anthropic.com"),
            "{shown}"
        );
    }

    #[test]
    fn entries_with_nothing_to_send_are_left_out() {
        let conversation = [
            Message::User("Hi".to_string()),
            Message::Assistant {
                text: String::new(),
                calls: Vec::new(),
                raw: Some(json!([])),
            },
            Message::Assistant {
                text: "  ".to_string(),
                calls: Vec::new(),
                raw: None,
            },
            Message::User(" \n".to_string()),
            Message::User("Again".to_string()),
        ];
        assert_eq!(
            messages(&conversation),
            json!([
                {"role": "user", "content": [
                    {"type": "text", "text": "Hi"},
                    {"type": "text", "text": "Again"}
                ]}
            ])
        );
    }

    #[test]
    fn blank_text_beside_calls_is_not_a_block() {
        let conversation = [Message::Assistant {
            text: " ".to_string(),
            calls: vec![ToolCall {
                id: "t1".to_string(),
                name: "abai_cells".to_string(),
                input: json!({}),
            }],
            raw: None,
        }];
        assert_eq!(
            messages(&conversation),
            json!([
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t1", "name": "abai_cells", "input": {}}
                ]}
            ])
        );
    }

    #[test]
    fn tool_results_go_before_text_in_a_user_message() {
        let result = |id: &str| ToolResult {
            id: id.to_string(),
            content: "ok".to_string(),
            is_error: false,
        };
        let conversation = [
            Message::Assistant {
                text: String::new(),
                calls: vec![ToolCall {
                    id: "t1".to_string(),
                    name: "abai_cells".to_string(),
                    input: json!({}),
                }],
                raw: None,
            },
            Message::Results(vec![result("t1")]),
            Message::User("[abai wake] a turn".to_string()),
            Message::Results(vec![result("t2")]),
        ];
        assert_eq!(
            messages(&conversation)[1],
            json!({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "ok"},
                {"type": "tool_result", "tool_use_id": "t2", "content": "ok"},
                {"type": "text", "text": "[abai wake] a turn"}
            ]})
        );
        let text_first = [
            conversation[0].clone(),
            Message::User("[abai wake] a turn".to_string()),
            Message::Results(vec![result("t1")]),
        ];
        assert_eq!(
            messages(&text_first)[1],
            json!({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "ok"},
                {"type": "text", "text": "[abai wake] a turn"}
            ]})
        );
    }

    #[test]
    fn stop_reasons_are_told_apart() {
        for (reason, stop) in [
            ("end_turn", Stop::End),
            ("max_tokens", Stop::MaxTokens),
            ("pause_turn", Stop::Pause),
            ("refusal", Stop::Refusal),
            ("something_new", Stop::Other("something_new".to_string())),
        ] {
            let answer = json!({"content": [], "stop_reason": reason});
            assert_eq!(reply(answer).unwrap().stop, stop);
        }
        assert!(matches!(reply(json!({})), Err(ModelError::Protocol(_))));
    }

    #[test]
    fn a_rejected_request_is_not_tried_again() {
        let provider = FakeProvider::start(vec![Answer::status(
            401,
            json!({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}),
        )]);
        let mut model = Anthropic::new(&provider.url, "bad", "m", timing(), false);
        let messages = [Message::User("x".to_string())];
        let error = model
            .complete(&Request {
                system: "",
                tools: &[],
                messages: &messages,
                limit: None,
            })
            .unwrap_err();
        assert_eq!(
            error,
            ModelError::Rejected {
                status: 401,
                message: "authentication_error: invalid x-api-key".to_string()
            }
        );
        assert_eq!(provider.requests().len(), 1);
    }

    #[test]
    fn a_busy_provider_is_asked_again_twice() {
        let busy = || {
            Answer::status(
                529,
                json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
            )
        };
        let ok = Answer::ok(
            json!({"content": [{"type": "text", "text": "hi"}], "stop_reason": "end_turn"}),
        );
        let provider = FakeProvider::start(vec![busy(), busy(), ok]);
        let mut model = Anthropic::new(&provider.url, "k", "m", timing(), false);
        let messages = [Message::User("x".to_string())];
        let request = Request {
            system: "",
            tools: &[],
            messages: &messages,
            limit: None,
        };
        assert_eq!(model.complete(&request).unwrap().text, "hi");
        assert_eq!(provider.requests().len(), 3);

        provider.then(vec![busy(), busy(), busy()]);
        assert_eq!(
            model.complete(&request).unwrap_err(),
            ModelError::Busy {
                status: 529,
                message: "overloaded_error: Overloaded".to_string()
            }
        );
        assert_eq!(provider.requests().len(), 6);
    }

    #[test]
    fn a_provider_that_is_not_there_is_unreachable() {
        // a port nothing listens on
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let mut model = Anthropic::new(
            &format!("http://127.0.0.1:{port}"),
            "k",
            "m",
            timing(),
            false,
        );
        let messages = [Message::User("x".to_string())];
        let error = model
            .complete(&Request {
                system: "",
                tools: &[],
                messages: &messages,
                limit: None,
            })
            .unwrap_err();
        assert!(matches!(error, ModelError::Unreachable(_)), "{error:?}");
    }
}
