//! The OpenAI-compatible chat completions API
//! (`POST <base>/chat/completions`), which FreeToken and many other
//! providers speak.

use std::fmt;

use serde_json::{Value, json};

use super::{
    Cancel, Http, Message, Model, ModelError, Reply, Request, Stop, Timing, ToolCall, Usage,
    text_of,
};

/// A model behind an OpenAI-compatible endpoint.
pub struct OpenAiCompatible {
    http: Http,
    provider: String,
    base_url: String,
    key: Option<String>,
    model: String,
}

impl fmt::Debug for OpenAiCompatible {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAiCompatible")
            .field("provider", &self.provider)
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("key", &self.key.as_ref().map(|_| "(set)"))
            .finish()
    }
}

impl OpenAiCompatible {
    /// `base_url` is the API's root, with its version: `https://host/v1`.
    /// `provider` names it for people. A server that asks for no key
    /// takes None.
    pub fn new(
        provider: &str,
        base_url: &str,
        key: Option<&str>,
        model: &str,
        timing: Timing,
    ) -> Self {
        Self {
            http: Http::new(timing),
            provider: provider.to_string(),
            base_url: base_url.trim_end_matches('/').to_string(),
            key: key.filter(|k| !k.is_empty()).map(str::to_string),
            model: model.to_string(),
        }
    }
}

fn messages(request: &Request<'_>) -> Vec<Value> {
    let mut out = Vec::new();
    if !request.system.is_empty() {
        out.push(json!({"role": "system", "content": request.system}));
    }
    for message in request.messages {
        match message {
            Message::User(text) if text.trim().is_empty() => {}
            Message::User(text) => out.push(json!({"role": "user", "content": text})),
            Message::Assistant { text, calls, .. }
                if text.trim().is_empty() && calls.is_empty() => {}
            Message::Assistant { text, calls, .. } => {
                let mut entry = json!({
                    "role": "assistant",
                    "content": if text.trim().is_empty() { Value::Null } else { json!(text) },
                });
                if !calls.is_empty() {
                    entry["tool_calls"] = calls
                        .iter()
                        .map(|call| {
                            json!({
                                "id": call.id,
                                "type": "function",
                                "function": {
                                    "name": call.name,
                                    "arguments": call.input.to_string(),
                                },
                            })
                        })
                        .collect();
                }
                out.push(entry);
            }
            Message::Results(results) => {
                for result in results {
                    out.push(json!({
                        "role": "tool",
                        "tool_call_id": result.id,
                        "content": result.content,
                    }));
                }
            }
        }
    }
    out
}

/// The provider's words out of an error body: `{"error":{"message":"..."}}`,
/// or `{"error":"..."}` from simpler servers.
fn error_message(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let error = value.get("error")?;
    error
        .as_str()
        .or_else(|| text_of(error, "message"))
        .map(str::to_string)
}

/// A tool call's input from its `arguments`: an object as it is, a JSON
/// string parsed, nothing at all an empty object.
fn arguments_of(arguments: Option<&Value>) -> Value {
    match arguments {
        Some(object @ Value::Object(_)) => object.clone(),
        None | Some(Value::Null) => json!({}),
        Some(Value::String(text)) if text.trim().is_empty() => json!({}),
        // arguments that are not JSON are kept as text: the tool refuses
        // them, and the model hears why
        Some(Value::String(text)) => {
            serde_json::from_str(text).unwrap_or_else(|_| json!({"invalid_arguments": text}))
        }
        Some(other) => json!({"invalid_arguments": other.to_string()}),
    }
}

/// The message's text: a string, or the text parts of a list.
fn content_of(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| text_of(part, "type") == Some("text"))
            .filter_map(|part| text_of(part, "text"))
            .collect(),
        _ => String::new(),
    }
}

fn reply(answer: Value) -> Result<Reply, ModelError> {
    if answer.get("choices").is_none()
        && let Some(message) = error_message(&answer.to_string())
    {
        return Err(ModelError::Protocol(format!(
            "the provider answered with an error: {message}"
        )));
    }
    let choice = answer
        .get("choices")
        .and_then(|choices| choices.get(0))
        .ok_or_else(|| ModelError::Protocol("the answer has no choices".to_string()))?;
    let message = choice
        .get("message")
        .ok_or_else(|| ModelError::Protocol("the choice has no message".to_string()))?;
    let mut calls = Vec::new();
    for call in message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
    {
        let function = call.get("function").unwrap_or(&Value::Null);
        let id = match text_of(call, "id") {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => format!("call_{}", calls.len()),
        };
        calls.push(ToolCall {
            id,
            name: text_of(function, "name").unwrap_or("").to_string(),
            input: arguments_of(function.get("arguments")),
        });
    }
    let stop = match text_of(choice, "finish_reason") {
        Some("stop") if !calls.is_empty() => Stop::ToolUse,
        Some("stop") => Stop::End,
        Some("tool_calls") | Some("function_call") => Stop::ToolUse,
        Some("length") => Stop::MaxTokens,
        Some("content_filter") => Stop::Refusal,
        // some servers leave the reason out when they return tool calls
        None if !calls.is_empty() => Stop::ToolUse,
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
        text: content_of(message),
        calls,
        stop,
        usage: Usage {
            input: tokens("prompt_tokens"),
            output: tokens("completion_tokens"),
        },
        raw: None,
    })
}

impl Model for OpenAiCompatible {
    fn name(&self) -> String {
        format!("{} {}", self.provider, self.model)
    }

    fn complete(&mut self, request: &Request<'_>) -> Result<Reply, ModelError> {
        let url = format!("{}/chat/completions", self.base_url);
        let mut body = json!({
            "model": self.model,
            "messages": messages(request),
        });
        if !request.tools.is_empty() {
            body["tools"] = request
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.schema,
                        },
                    })
                })
                .collect();
        }
        let bearer = self.key.as_ref().map(|key| format!("Bearer {key}"));
        let headers: Vec<(&str, &str)> = bearer
            .iter()
            .map(|value| ("authorization", value.as_str()))
            .collect();
        let answer = self
            .http
            .post(&url, &headers, &body, error_message, request.limit)?;
        reply(answer)
    }

    fn cancel_with(&mut self, cancel: &Cancel) {
        self.http.cancel = cancel.clone();
    }

    fn probe(&self) -> Result<String, ModelError> {
        let url = format!("{}/models", self.base_url);
        let bearer = self.key.as_ref().map(|key| format!("Bearer {key}"));
        let headers: Vec<(&str, &str)> = bearer
            .iter()
            .map(|value| ("authorization", value.as_str()))
            .collect();
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

    #[test]
    fn a_request_and_its_tool_call_round_trip() {
        let call = json!({
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "abai_set", "arguments": "{\"cell\":\"step\",\"value\":5}"}
                    }]
                }
            }],
            "usage": {"prompt_tokens": 90, "completion_tokens": 12}
        });
        let done = json!({
            "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "Done."}}]
        });
        let provider = FakeProvider::start(vec![Answer::ok(call), Answer::ok(done)]);
        let base = format!("{}/v1", provider.url);
        let mut model = OpenAiCompatible::new("freetoken", &base, Some("local"), "qwen", timing());
        assert_eq!(model.name(), "freetoken qwen");
        let tools = vec![ToolSpec {
            name: "abai_set".to_string(),
            description: "Write a knob.".to_string(),
            schema: json!({"type": "object"}),
        }];
        let mut conversation = vec![Message::User("Go faster.".to_string())];
        fn ask<'a>(tools: &'a [ToolSpec], messages: &'a [Message]) -> Request<'a> {
            Request {
                system: "You are the agent.",
                tools,
                messages,
                limit: None,
            }
        }

        let first = model.complete(&ask(&tools, &conversation)).unwrap();
        assert_eq!(first.stop, Stop::ToolUse);
        assert_eq!(
            first.usage,
            Usage {
                input: 90,
                output: 12
            }
        );
        assert_eq!(first.calls[0].input, json!({"cell": "step", "value": 5}));
        conversation.push(first.into_message());
        conversation.push(Message::Results(vec![ToolResult {
            id: "call_1".to_string(),
            content: "ok".to_string(),
            is_error: false,
        }]));
        let last = model.complete(&ask(&tools, &conversation)).unwrap();
        assert_eq!((last.text.as_str(), last.stop), ("Done.", Stop::End));

        let sent = provider.requests();
        assert_eq!(sent[0].path, "/v1/chat/completions");
        assert_eq!(sent[0].header("authorization"), Some("Bearer local"));
        assert_eq!(
            sent[0].body,
            json!({
                "model": "qwen",
                "messages": [
                    {"role": "system", "content": "You are the agent."},
                    {"role": "user", "content": "Go faster."}
                ],
                "tools": [{
                    "type": "function",
                    "function": {"name": "abai_set", "description": "Write a knob.", "parameters": {"type": "object"}}
                }]
            })
        );
        assert_eq!(
            sent[1].body["messages"].as_array().unwrap()[2..],
            [
                json!({"role": "assistant", "content": null, "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "abai_set", "arguments": "{\"cell\":\"step\",\"value\":5}"}
                }]}),
                json!({"role": "tool", "tool_call_id": "call_1", "content": "ok"}),
            ]
        );
    }

    #[test]
    fn no_key_sends_no_authorization() {
        let provider = FakeProvider::start(vec![Answer::ok(json!({
            "choices": [{"finish_reason": "stop", "message": {"content": "hi"}}]
        }))]);
        let mut model = OpenAiCompatible::new("local", &provider.url, Some(""), "m", timing());
        let messages = [Message::User("x".to_string())];
        model
            .complete(&Request {
                system: "",
                tools: &[],
                messages: &messages,
                limit: None,
            })
            .unwrap();
        let sent = &provider.requests()[0];
        assert_eq!(sent.header("authorization"), None);
        assert_eq!(
            sent.body["messages"],
            json!([{"role": "user", "content": "x"}])
        );
        assert!(sent.body.get("tools").is_none());
    }

    #[test]
    fn odd_answers_are_read_as_far_as_they_go() {
        let no_reason = json!({"choices": [{"message": {"tool_calls": [
            {"id": "c", "function": {"name": "t", "arguments": "not json"}}
        ]}}]});
        let read = reply(no_reason).unwrap();
        assert_eq!(read.stop, Stop::ToolUse);
        assert_eq!(
            read.calls[0].input,
            json!({"invalid_arguments": "not json"})
        );

        let cut = json!({"choices": [{"finish_reason": "length", "message": {"content": "so"}}]});
        assert_eq!(reply(cut).unwrap().stop, Stop::MaxTokens);
        assert!(matches!(
            reply(json!({"choices": []})),
            Err(ModelError::Protocol(_))
        ));
        assert_eq!(
            error_message(r#"{"error":{"message":"no such model"}}"#).as_deref(),
            Some("no such model")
        );
        assert_eq!(
            error_message(r#"{"error":"down"}"#).as_deref(),
            Some("down")
        );
        assert_eq!(error_message("<html>"), None);
    }

    #[test]
    fn tool_call_arguments_and_ids_are_read_leniently() {
        let answer = json!({"choices": [{"finish_reason": "stop", "message": {"tool_calls": [
            {"id": "", "function": {"name": "a", "arguments": {"x": 1}}},
            {"function": {"name": "b"}},
            {"id": "c3", "function": {"name": "c", "arguments": "  "}},
            {"id": "c4", "function": {"name": "d", "arguments": ""}},
            {"id": "c5", "function": {"name": "e", "arguments": "{oops"}}
        ]}}]});
        let read = reply(answer).unwrap();
        assert_eq!(read.stop, Stop::ToolUse);
        let ids: Vec<&str> = read.calls.iter().map(|call| call.id.as_str()).collect();
        assert_eq!(ids, ["call_0", "call_1", "c3", "c4", "c5"]);
        let inputs: Vec<&Value> = read.calls.iter().map(|call| &call.input).collect();
        assert_eq!(
            inputs,
            [
                &json!({"x": 1}),
                &json!({}),
                &json!({}),
                &json!({}),
                &json!({"invalid_arguments": "{oops"})
            ]
        );
    }

    #[test]
    fn content_parts_are_joined() {
        let answer = json!({"choices": [{"finish_reason": "stop", "message": {"content": [
            {"type": "text", "text": "It is "},
            {"type": "image_url", "image_url": {"url": "x"}},
            {"type": "text", "text": "at 41."}
        ]}}]});
        let read = reply(answer).unwrap();
        assert_eq!((read.text.as_str(), read.stop), ("It is at 41.", Stop::End));
    }

    #[test]
    fn an_error_in_a_200_body_is_a_protocol_error_with_its_message() {
        let error = reply(json!({"error": {"message": "model overloaded"}})).unwrap_err();
        match error {
            ModelError::Protocol(why) => assert!(why.contains("model overloaded"), "{why}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn blank_entries_are_left_out() {
        let conversation = [
            Message::User(" ".to_string()),
            Message::Assistant {
                text: " ".to_string(),
                calls: Vec::new(),
                raw: None,
            },
            Message::Assistant {
                text: " ".to_string(),
                calls: vec![ToolCall {
                    id: "c1".to_string(),
                    name: "t".to_string(),
                    input: json!({}),
                }],
                raw: None,
            },
            Message::User("go".to_string()),
        ];
        let sent = messages(&Request {
            system: "",
            tools: &[],
            messages: &conversation,
            limit: None,
        });
        assert_eq!(
            sent,
            [
                json!({"role": "assistant", "content": null, "tool_calls": [{
                    "id": "c1",
                    "type": "function",
                    "function": {"name": "t", "arguments": "{}"}
                }]}),
                json!({"role": "user", "content": "go"}),
            ]
        );
    }

    #[test]
    fn the_key_is_not_in_the_debug_form() {
        let model = OpenAiCompatible::new("p", "http://h/v1", Some("sk-secret"), "m", timing());
        let shown = format!("{model:?}");
        assert!(!shown.contains("sk-secret"), "{shown}");
        assert!(shown.contains("(set)"), "{shown}");
    }
}
