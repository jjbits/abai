//! The agent: a model in a loop with the harness's tools.
//!
//! A step starts with something for the agent to look at (a wake from the
//! program, or a line from the user) and ends when the model stops asking
//! for tools. Nothing is put into a step in progress.

use std::time::Instant;

use abai_stub::content::Content;
use abai_stub::manifest::{Manifest, Mode};
use serde_json::Value;

use crate::core::Core;
use crate::embedded::{Front, RunEnd, Wake};
use crate::model::{Message, Model, ModelError, Request, Stop, ToolResult, ToolSpec};
use crate::prompt::{self, Form};
use crate::tools;

/// The most requests to the model in one step.
pub const MAX_ROUNDS: usize = 40;
/// The most transcript lines a wake shows.
const WAKE_LINES: usize = 40;
/// The most entries the conversation keeps. Past it the oldest whole
/// steps are forgotten: the cells and the transcript are the record, not
/// the conversation.
pub const MAX_MESSAGES: usize = 400;

/// The harness's own agent.
pub struct Agent {
    model: Box<dyn Model>,
    system: String,
    tools: Vec<ToolSpec>,
    conversation: Vec<Message>,
    /// Where each step still in the conversation begins.
    steps: Vec<usize>,
    /// Whether the model has answered at least once.
    reached: bool,
    /// The number of the first transcript line the agent has not been shown.
    shown: u64,
}

impl std::fmt::Debug for Agent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Agent")
            .field("model", &self.model.name())
            .field("messages", &self.conversation.len())
            .finish_non_exhaustive()
    }
}

impl Agent {
    /// An agent for a program, on a model.
    pub fn new(model: Box<dyn Model>, manifest: &Manifest, content: &Content, mode: Mode) -> Self {
        Self {
            model,
            system: prompt::compose(manifest, content, mode, Form::Session),
            tools: tools::offered(
                mode,
                tools::network_expected(manifest, &|name| std::env::var(name).ok()),
            ),
            conversation: Vec::new(),
            steps: Vec::new(),
            reached: false,
            shown: 0,
        }
    }

    /// The conversation so far.
    pub fn conversation(&self) -> &[Message] {
        &self.conversation
    }

    fn wake_text(&mut self, core: &Core, wake: &Wake) -> String {
        let mut text = wake_message(core, wake);
        text.push_str(&news_since(core, &mut self.shown));
        text
    }

    fn say(core: &mut Core, text: &str) {
        if text.trim().is_empty() {
            return;
        }
        core.transcript.push(format!("agent: {}", text.trim()));
        if let Some(channel) = core.channel() {
            channel.say(text);
        }
    }

    /// Forget the oldest steps, keeping the newest `keep` of them.
    fn forget_oldest(&mut self, keep: usize) {
        if self.steps.len() <= keep {
            return;
        }
        let cut = self.steps[self.steps.len() - keep];
        self.conversation.drain(..cut);
        self.steps = self.steps[self.steps.len() - keep..]
            .iter()
            .map(|start| start - cut)
            .collect();
    }

    /// One step: `input` goes to the model, and its tool calls are run
    /// until it stops asking for any.
    fn step(&mut self, core: &mut Core, input: String, deadline: Option<Instant>) -> RunEnd {
        while self.conversation.len() > MAX_MESSAGES && self.steps.len() > 1 {
            self.forget_oldest(self.steps.len() - 1);
        }
        // everything this step adds comes after `start`, so a step that
        // fails can be taken back whole
        let start = self.conversation.len();
        self.steps.push(start);
        self.conversation.push(Message::User(input));
        self.model.cancel_with(core.cancel());
        for _ in 0..MAX_ROUNDS {
            let left = deadline.map(|deadline| deadline.saturating_duration_since(Instant::now()));
            if left.is_some_and(|left| left.is_zero()) {
                core.transcript.push("# the step's time is up");
                Self::say(core, "(the time for this step is up)");
                return RunEnd::Done;
            }
            let request = Request {
                system: &self.system,
                tools: &self.tools,
                messages: &self.conversation,
                limit: left,
            };
            let reply = match self.model.complete(&request) {
                Ok(reply) => reply,
                // the harness is ending: the step is taken back, and the
                // loop that runs this front end sees the stop next
                Err(ModelError::Cancelled) => {
                    core.transcript
                        .push("# the model request was cut off: the harness is ending");
                    self.conversation.truncate(start);
                    self.steps.pop();
                    return RunEnd::Cut;
                }
                // a model that never answered, or cannot be reached, is a
                // harness without a model: it detaches
                Err(error) if !self.reached || matches!(error, ModelError::Unreachable(_)) => {
                    return RunEnd::Unreachable(error.to_string());
                }
                // a later failure ends this step alone, and the step is
                // taken back so the next one starts from a sound history
                Err(error) => {
                    core.transcript.push(format!("# model: {error}"));
                    Self::say(core, &format!("({error})"));
                    self.conversation.truncate(start);
                    self.steps.pop();
                    if matches!(error, ModelError::Rejected { .. }) {
                        // a request the provider will not take is most
                        // often a conversation grown past what it reads
                        let keep = self.steps.len() / 2;
                        self.forget_oldest(keep);
                        core.transcript
                            .push("# the agent forgot the older half of its conversation");
                    }
                    return RunEnd::Done;
                }
            };
            self.reached = true;
            core.spent(reply.usage.input + reply.usage.output);
            match reply.stop {
                Stop::Refusal => {
                    // nothing of a declined step is kept or sent again
                    self.conversation.truncate(start);
                    self.steps.pop();
                    core.transcript
                        .push("# model: the provider declined this request");
                    Self::say(core, "(the model's provider declined this request)");
                    return RunEnd::Done;
                }
                Stop::MaxTokens => {
                    // a tool call in a reply that hit the limit may be cut
                    // short: none of them is run
                    if !reply.text.trim().is_empty() {
                        self.conversation.push(Message::Assistant {
                            text: reply.text,
                            calls: Vec::new(),
                            raw: None,
                        });
                    }
                    self.conversation.push(Message::User(
                        "Your last reply reached the output limit and was cut off. No tool call in it was run. Go on in smaller steps.".to_string(),
                    ));
                }
                Stop::Pause => {
                    // the provider paused a long turn: the same
                    // conversation, sent again, continues it
                    self.conversation.push(reply.into_message());
                }
                Stop::End | Stop::ToolUse | Stop::Other(_) => {
                    let text = reply.text.clone();
                    let calls = reply.calls.clone();
                    if text.trim().is_empty() && calls.is_empty() {
                        // a reply with nothing in it is not kept
                        return RunEnd::Done;
                    }
                    self.conversation.push(reply.into_message());
                    Self::say(core, &text);
                    if calls.is_empty() {
                        return RunEnd::Done;
                    }
                    // every call gets its result, whatever the clock says:
                    // a call without one would break the conversation
                    let results = calls
                        .iter()
                        .map(|call| {
                            let outcome = tools::call(core, &call.name, &call.input);
                            ToolResult {
                                id: call.id.clone(),
                                content: outcome.content,
                                is_error: outcome.is_error,
                            }
                        })
                        .collect();
                    self.conversation.push(Message::Results(results));
                }
            }
        }
        core.transcript.push(format!(
            "# the step was ended after {MAX_ROUNDS} requests to the model"
        ));
        Self::say(core, "(the step was ended: too many requests to the model)");
        RunEnd::Done
    }
}

/// What the transcript has gained since `shown`, less what the agent said
/// itself. Moves `shown` to the transcript's end.
pub(crate) fn news_since(core: &Core, shown: &mut u64) -> String {
    let fresh = core.transcript.next().saturating_sub(*shown) as usize;
    let lines: Vec<(u64, &str)> = core
        .transcript
        .read(WAKE_LINES, *shown)
        .into_iter()
        .filter(|(_, line)| !line.starts_with("agent: ") && !line.starts_with("# model: "))
        .collect();
    *shown = core.transcript.next();
    if lines.is_empty() {
        return String::new();
    }
    let mut text = String::from("\nSince you last looked:\n");
    if fresh > WAKE_LINES {
        text.push_str(&format!(
            "({} earlier lines are not shown; abai_transcript has them)\n",
            fresh - WAKE_LINES
        ));
    }
    for (number, line) in lines {
        text.push_str(&format!("{number}\t{line}\n"));
    }
    text
}

/// A wake as the agent reads it: what happened, what is expected, how
/// long there is, and the content slot that goes with it.
pub(crate) fn wake_message(core: &Core, wake: &Wake) -> String {
    let manifest = core.manifest();
    let mut text = match wake {
        Wake::Decision { id, name, context } => {
            let mut text = format!(
                "[abai wake] The program asks the decision {name} (id {id}) and waits for you.\nContext: {context}\n"
            );
            if let Some(decision) = manifest.decision(name) {
                if let Some(options) = &decision.options {
                    text.push_str(&format!("Options: {}\n", options.join(", ")));
                }
                text.push_str(&format!(
                    "Answer with abai_decide before you end this step. If you do not, the default applies: {}\n",
                    decision.default
                ));
            }
            text
        }
        Wake::Turn { name } => {
            let doc = manifest.turn(name).map_or("", |turn| turn.doc.as_str());
            format!(
                "[abai wake] The program gives you the turn {name}. {doc}\nDo what the turn calls for, then end your step: the program waits for you.\n"
            )
        }
        Wake::Install => {
            "[abai wake] The program is being installed. Do what its install content says, then end your step.\n".to_string()
        }
        Wake::Attention { reasons, held } => {
            let mut text = String::from("[abai wake] Something you watch for happened:\n");
            for reason in reasons {
                text.push_str(&format!("- {reason}\n"));
            }
            if *held > 0 {
                text.push_str(&format!(
                    "({held} earlier wakes were held back by the attention budget; the transcript has what happened.)\n"
                ));
            }
            text.push_str("Most wakes need nothing. Act only if this one does, then end your step.\n");
            text
        }
    };
    if let Some(left) = core.time_left() {
        text.push_str(&format!(
            "You have about {} seconds.\n",
            left.as_secs().max(1)
        ));
    }
    let slot = match wake {
        Wake::Install => core.content.install.as_deref(),
        other => other.slot().and_then(|name| core.content.turn(name)),
    };
    if let Some(slot) = slot {
        text.push_str(&format!("\n{}\n", slot.trim()));
    }
    text
}

impl Front for Agent {
    fn run(&mut self, core: &mut Core, wake: &Wake, deadline: Option<Instant>) -> RunEnd {
        let input = self.wake_text(core, wake);
        self.step(core, input, deadline)
    }

    fn user_line(&mut self, core: &mut Core, line: &str) -> RunEnd {
        let mut input = line.to_string();
        input.push_str(&news_since(core, &mut self.shown));
        self.step(core, input, None)
    }

    fn greeting(&self, core: &Core) -> String {
        format!(
            "{}: a session with the agent on {}. /quit ends it.",
            core.manifest().name,
            self.model.name()
        )
    }
}

/// The JSON a scripted provider answers with, for tests of the agent.
#[doc(hidden)]
pub fn anthropic_reply(text: &str, calls: &[(&str, &str, Value)], stop: &str) -> Value {
    let mut content = Vec::new();
    if !text.is_empty() {
        content.push(serde_json::json!({"type": "text", "text": text}));
    }
    for (id, name, input) in calls {
        content
            .push(serde_json::json!({"type": "tool_use", "id": id, "name": name, "input": input}));
    }
    serde_json::json!({
        "content": content,
        "stop_reason": stop,
        "usage": {"input_tokens": 1, "output_tokens": 1}
    })
}
