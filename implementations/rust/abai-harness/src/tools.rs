//! The tools the agent is given: its end of the channels (contract
//! section 4.2). A tool reads its input, runs one act on the core, and
//! answers text.

use abai_stub::manifest::cut_utf8;
use serde_json::{Map, Value, json};

use crate::attention::WatchOp;
use crate::core::Core;
use crate::model::ToolSpec;

/// The most bytes a tool result carries.
pub const RESULT_CAP: usize = 16 * 1024;

/// What a tool call came to, as the model hears it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutcome {
    pub content: String,
    pub is_error: bool,
}

impl ToolOutcome {
    fn ok(content: String) -> Self {
        Self {
            content: capped(content),
            is_error: false,
        }
    }

    fn error(content: String) -> Self {
        Self {
            content: capped(content),
            is_error: true,
        }
    }
}

/// What a parameter takes.
#[derive(Debug, Clone, Copy)]
enum Kind {
    /// A whole number of at least `min`, and at most `max` when there is one.
    Whole {
        min: u64,
        max: Option<u64>,
        default: Option<u64>,
    },
    /// A number, a fraction allowed, above `above` and at most `max`.
    Number {
        above: f64,
        max: f64,
    },
    Flag,
    Text,
    /// A string from a fixed set.
    OneOf {
        values: &'static [&'static str],
        default: &'static str,
    },
    /// A list of strings.
    Names,
    Object,
    /// Any JSON value.
    Any,
}

#[derive(Debug, Clone, Copy)]
struct Param {
    name: &'static str,
    kind: Kind,
    required: bool,
    description: &'static str,
}

#[derive(Debug, Clone, Copy)]
struct Tool {
    name: &'static str,
    description: &'static str,
    params: &'static [Param],
}

/// The comparisons a watch can make.
const WATCH_OPS: &[&str] = &["changed", "eq", "ne", "gt", "lt", "crossed"];

const TOOLS: &[Tool] = &[
    Tool {
        name: "abai_status",
        description: "What the harness is attached to: the program, its mode, whether it is attached, the audit log, the decisions waiting on you, and the number the next transcript line will have.",
        params: &[],
    },
    Tool {
        name: "abai_transcript",
        description: "The transcript: the program's events and the harness's notes, as numbered lines, oldest first. Each line is `<number>\\t<text>`. Gives the last `lines` lines numbered `since` or higher. When they are too long for one result, the oldest are left out and the first line says how many.",
        params: &[
            Param {
                name: "lines",
                kind: Kind::Whole {
                    min: 1,
                    max: Some(500),
                    default: Some(60),
                },
                required: false,
                description: "How many lines, the newest kept (default 60)",
            },
            Param {
                name: "since",
                kind: Kind::Whole {
                    min: 0,
                    max: None,
                    default: Some(0),
                },
                required: false,
                description: "Only lines numbered this or higher (default 0)",
            },
        ],
    },
    Tool {
        name: "abai_cells",
        description: "Read the program's cells (its declared state), all of them or the named ones. Knobs are the cells you may write; write them with abai_set.",
        params: &[Param {
            name: "names",
            kind: Kind::Names,
            required: false,
            description: "Cell names to read; all cells when omitted or empty",
        }],
    },
    Tool {
        name: "abai_set",
        description: "Write a knob with your reason. The reason is required and audited. A knob whose policy is confirm is put to the user first, who can refuse it. Answers the knob's name and the value written.",
        params: &[
            Param {
                name: "cell",
                kind: Kind::Text,
                required: true,
                description: "The knob to write",
            },
            Param {
                name: "value",
                kind: Kind::Any,
                required: true,
                description: "The value to write",
            },
            Param {
                name: "reason",
                kind: Kind::Text,
                required: true,
                description: "Why you write it (audited)",
            },
        ],
    },
    Tool {
        name: "abai_call",
        description: "Call one of the program's capabilities with its parameters and your reason. The reason is required and audited. A capability whose policy is confirm is put to the user first, who can refuse it. Answers the capability's result.",
        params: &[
            Param {
                name: "capability",
                kind: Kind::Text,
                required: true,
                description: "The capability's name",
            },
            Param {
                name: "params",
                kind: Kind::Object,
                required: false,
                description: "The capability's parameters (none when omitted)",
            },
            Param {
                name: "reason",
                kind: Kind::Text,
                required: true,
                description: "Why you call it (audited)",
            },
        ],
    },
    Tool {
        name: "abai_decide",
        description: "Answer a pending decision by its id, with one of its options (as a string) or the answer object its fields declare, and your reason; the reason is audited. The answer applies when you end this step; a decision whose policy is confirm is put to the user then. A decision whose time is up cannot be answered.",
        params: &[
            Param {
                name: "id",
                kind: Kind::Text,
                required: true,
                description: "The pending decision's id",
            },
            Param {
                name: "answer",
                kind: Kind::Any,
                required: true,
                description: "One of the decision's options, or its answer object",
            },
            Param {
                name: "reason",
                kind: Kind::Text,
                required: true,
                description: "Why you answer so (audited)",
            },
        ],
    },
    Tool {
        name: "abai_watch",
        description: "Watch a cell: the watch wakes you when it fires. changed: the cell was written. eq, ne, gt, lt: the comparison with value starts to hold. crossed: the cell's value passes the number value. The harness looks at the cell every cadence_ms (default: the cell's own cadence, else one second). A watch on the same cell and comparison replaces the old one; remove: true stops every watch on the cell. There are no watches in turns mode.",
        params: &[
            Param {
                name: "cell",
                kind: Kind::Text,
                required: true,
                description: "The cell to watch",
            },
            Param {
                name: "op",
                kind: Kind::OneOf {
                    values: WATCH_OPS,
                    default: "changed",
                },
                required: false,
                description: "When the watch fires (default changed)",
            },
            Param {
                name: "value",
                kind: Kind::Any,
                required: false,
                description: "The value to compare with; needed by every op but changed",
            },
            Param {
                name: "cadence_ms",
                kind: Kind::Whole {
                    min: 100,
                    max: Some(3_600_000),
                    default: None,
                },
                required: false,
                description: "How often the harness looks, in milliseconds (default: the cell's own cadence, else 1000)",
            },
            Param {
                name: "remove",
                kind: Kind::Flag,
                required: false,
                description: "true to stop every watch on the cell instead (default false)",
            },
        ],
    },
    Tool {
        name: "abai_timer",
        description: "Set a timer: it wakes you once, after that many seconds, with the note. There are no timers in turns mode.",
        params: &[
            Param {
                name: "seconds",
                kind: Kind::Number {
                    above: 0.0,
                    max: 86_400.0,
                },
                required: true,
                description: "How long until the wake, in seconds; a fraction is allowed",
            },
            Param {
                name: "note",
                kind: Kind::Text,
                required: false,
                description: "What the wake is for; it comes with the wake",
            },
        ],
    },
    Tool {
        name: "abai_lifecycle",
        description: "The program's lifecycle, with your reason, which is audited: status, pause, resume, stop, start, restart. Where this harness launched the program every operation is available. Attached to a program it did not launch, only status and a graceful stop are. stop and restart are put to the user first unless the program's policy says otherwise.",
        params: &[
            Param {
                name: "op",
                kind: Kind::OneOf {
                    values: &["status", "pause", "resume", "stop", "start", "restart"],
                    default: "status",
                },
                required: false,
                description: "The operation",
            },
            Param {
                name: "reason",
                kind: Kind::Text,
                required: true,
                description: "Why; it is written to the audit log",
            },
        ],
    },
    Tool {
        name: "abai_peers",
        description: "Who is on this run's agent network: for each membership, this run's member name and address, and every member the network's authority issued, with whether it is enrolled (an authenticated frame from it has been seen), reachable now (a tunnel from here exists), and self. A name is the one the authority issued; a name a member only claims about itself comes as claimed_name and does not route. The program's manifest says how members relate to its own names. Works when detached from the program; may take up to 40 s per network when its authority is unreachable; fails when this run has no network.",
        params: &[],
    },
    Tool {
        name: "abai_send",
        description: "Send a message to a member of this run's agent network, by the name the network's authority issued (abai_peers lists them) or by address. The message travels in an aiap v1 envelope, and the act is written to the program's audit log with your reason. thread continues a conversation (the first message's id); re names the message this answers. Fails in plain words when the member is unknown, unreachable or refuses; needs an attached program. The program's manifest says what members are to it and what to say to them.",
        params: &[
            Param {
                name: "to",
                kind: Kind::Text,
                required: true,
                description: "The member's issued name, or its address",
            },
            Param {
                name: "body",
                kind: Kind::Text,
                required: true,
                description: "What to say, up to 64 KiB",
            },
            Param {
                name: "reason",
                kind: Kind::Text,
                required: true,
                description: "Why; it is written to the audit log",
            },
            Param {
                name: "thread",
                kind: Kind::Text,
                required: false,
                description: "The conversation's id: the first message's id",
            },
            Param {
                name: "re",
                kind: Kind::Text,
                required: false,
                description: "The id of the message this answers",
            },
            Param {
                name: "network",
                kind: Kind::Text,
                required: false,
                description: "Which network, when this run is on several",
            },
        ],
    },
    Tool {
        name: "abai_messages",
        description: "The messages this run sent and received over its network since attach, oldest first (the last 200 are kept): direction, the counterpart's issued name and address, id, thread, kind and the whole body. A message's wake line shows a preview; this has the rest. Works when detached.",
        params: &[
            Param {
                name: "network",
                kind: Kind::Text,
                required: false,
                description: "Only this network's messages",
            },
            Param {
                name: "limit",
                kind: Kind::Whole {
                    min: 1,
                    max: Some(200),
                    default: None,
                },
                required: false,
                description: "Keep only the newest this many",
            },
        ],
    },
    Tool {
        name: "abai_audit",
        description: "Read the audit log back: its path, whether writing it has failed, and its last records, oldest first. When they are too long for one result, the oldest are left out and the field left_out says how many. Every act of control is there, yours included, with its reason.",
        params: &[Param {
            name: "limit",
            kind: Kind::Whole {
                min: 1,
                max: Some(1000),
                default: Some(50),
            },
            required: false,
            description: "How many records, the newest kept (default 50)",
        }],
    },
];

fn param_schema(param: &Param) -> Value {
    let mut schema = match param.kind {
        Kind::Whole { min, max, default } => {
            let mut schema = json!({"type": "integer", "minimum": min});
            if let Some(max) = max {
                schema["maximum"] = json!(max);
            }
            if let Some(default) = default {
                schema["default"] = json!(default);
            }
            schema
        }
        Kind::Number { above, max } => {
            json!({"type": "number", "exclusiveMinimum": above, "maximum": max})
        }
        Kind::Flag => json!({"type": "boolean", "default": false}),
        Kind::Text => json!({"type": "string"}),
        Kind::OneOf { values, default } => {
            json!({"type": "string", "enum": values, "default": default})
        }
        Kind::Names => json!({"type": "array", "items": {"type": "string"}}),
        Kind::Object => json!({"type": "object"}),
        Kind::Any => json!({}),
    };
    schema["description"] = json!(param.description);
    schema
}

/// Whether a run of this program may be on a network: the program
/// declares one, or the environment hands the run one.
pub fn network_expected(
    manifest: &abai_stub::manifest::Manifest,
    env: &dyn Fn(&str) -> Option<String>,
) -> bool {
    let given = |name: &str| env(name).is_some_and(|value| !value.trim().is_empty());
    manifest.network.is_some() || given("ABAI_NET_DIR") || given("ABAI_NET_TOKEN")
}

/// The tools an agent is offered for a program in `mode`: the ones that
/// set a later wake only where something runs between touchpoints, the
/// lifecycle only between two processes, the network's only when the run
/// may be on one.
pub fn offered(mode: abai_stub::manifest::Mode, network: bool) -> Vec<ToolSpec> {
    use abai_stub::manifest::Mode;
    specs()
        .into_iter()
        .filter(|tool| match tool.name.as_str() {
            "abai_watch" | "abai_timer" => mode != Mode::Turns,
            "abai_lifecycle" => mode == Mode::Sidecar,
            "abai_peers" | "abai_send" | "abai_messages" => network,
            _ => true,
        })
        .collect()
}

/// The tools the agent is given, with their JSON Schemas.
pub fn specs() -> Vec<ToolSpec> {
    TOOLS
        .iter()
        .map(|tool| {
            let mut properties = Map::new();
            for param in tool.params {
                properties.insert(param.name.to_string(), param_schema(param));
            }
            let required: Vec<&str> = tool
                .params
                .iter()
                .filter(|p| p.required)
                .map(|p| p.name)
                .collect();
            ToolSpec {
                name: tool.name.to_string(),
                description: tool.description.to_string(),
                schema: json!({
                    "type": "object",
                    "properties": properties,
                    "required": required,
                    "additionalProperties": false,
                }),
            }
        })
        .collect()
}

/// A whole number, from an integer or a float with no fraction.
fn whole(value: &Value) -> Option<u64> {
    if let Some(n) = value.as_u64() {
        return Some(n);
    }
    let f = value.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f >= 0.0 && f <= u64::MAX as f64).then_some(f as u64)
}

/// What is wrong with a present value of a parameter, if anything.
fn kind_problem(param: &Param, value: &Value) -> Option<String> {
    let name = param.name;
    let fits = match param.kind {
        Kind::Whole { min, max, .. } => {
            whole(value).is_some_and(|n| n >= min && max.is_none_or(|max| n <= max))
        }
        Kind::Number { above, max } => value.as_f64().is_some_and(|n| n > above && n <= max),
        Kind::Flag => value.is_boolean(),
        Kind::Text => value.is_string(),
        Kind::OneOf { values, .. } => value.as_str().is_some_and(|v| values.contains(&v)),
        Kind::Names => value
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_string)),
        Kind::Object => value.is_object(),
        Kind::Any => true,
    };
    if fits {
        return None;
    }
    let what = match param.kind {
        Kind::Whole {
            min,
            max: Some(max),
            ..
        } => format!("a whole number from {min} to {max}"),
        Kind::Whole { min, max: None, .. } => format!("a whole number of {min} or more"),
        Kind::Number { above, max } => format!("a number above {above} and at most {max}"),
        Kind::Flag => return Some(format!("{name} must be true or false")),
        Kind::Text => "a string".to_string(),
        Kind::OneOf { values, .. } => return Some(one_of(name, values)),
        Kind::Names => "a list of strings".to_string(),
        Kind::Object => "an object".to_string(),
        Kind::Any => unreachable!("any value fits"),
    };
    Some(format!("{name} must be {what}"))
}

fn one_of(name: &str, values: &[&str]) -> String {
    format!("{name} must be one of {}", values.join(", "))
}

/// Check an input against a tool's parameters. An optional parameter
/// given as null is taken as absent.
fn checked<'a>(tool: &Tool, input: &'a Value) -> Result<&'a Map<String, Value>, String> {
    let Some(object) = input.as_object() else {
        return Err("the input must be an object".to_string());
    };
    for key in object.keys() {
        if !tool.params.iter().any(|p| p.name == key) {
            return Err(format!("{key} is not a parameter of {}", tool.name));
        }
    }
    for param in tool.params {
        match object.get(param.name) {
            None if param.required => return Err(format!("{} is required", param.name)),
            None => {}
            Some(Value::Null) if !param.required => {}
            Some(value) => {
                if let Some(problem) = kind_problem(param, value) {
                    return Err(problem);
                }
            }
        }
    }
    Ok(object)
}

/// A whole-number parameter, or its default.
fn number(tool: &Tool, input: &Map<String, Value>, name: &str) -> u64 {
    let given = input.get(name).and_then(whole);
    let default = tool.params.iter().find(|p| p.name == name).map(|p| p.kind);
    match (given, default) {
        (Some(n), _) => n,
        (None, Some(Kind::Whole { default, .. })) => default.unwrap_or(0),
        (None, _) => 0,
    }
}

fn text<'a>(input: &'a Map<String, Value>, name: &str) -> &'a str {
    input.get(name).and_then(Value::as_str).unwrap_or("")
}

/// Cut a result at the cap, on a character boundary, and say how much
/// was cut.
fn capped(content: String) -> String {
    if content.len() <= RESULT_CAP {
        return content;
    }
    let kept = cut_utf8(&content, RESULT_CAP);
    let more = content.len() - kept.len();
    format!("{kept}\n[cut: {more} more bytes]")
}

/// Lines joined, with the oldest left out until the text fits the cap.
/// The newest line is always kept; the cap cuts it when it alone is over.
fn newest_lines(lines: &[String]) -> String {
    let header = |n: usize| {
        if n == 0 {
            0
        } else {
            format!("[{n} older lines left out]\n").len()
        }
    };
    let mut body = lines.iter().map(|l| l.len() + 1).sum::<usize>() - 1;
    let mut start = 0;
    while start + 1 < lines.len() && header(start) + body > RESULT_CAP {
        body -= lines[start].len() + 1;
        start += 1;
    }
    let kept = lines[start..].join("\n");
    if start == 0 {
        kept
    } else {
        format!("[{start} older lines left out]\n{kept}")
    }
}

/// The audit tail as compact JSON, with the oldest records left out
/// until it fits the cap, and `left_out` saying how many.
fn newest_records(mut audit: Value) -> String {
    let Some(records) = audit
        .get_mut("records")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
    else {
        return audit.to_string();
    };
    let frame = |n: usize| {
        let mut frame = audit.clone();
        if n > 0 {
            frame["left_out"] = json!(n);
        }
        frame.to_string().len()
    };
    let sizes: Vec<usize> = records.iter().map(|r| r.to_string().len()).collect();
    let mut body = sizes.iter().sum::<usize>() + sizes.len().saturating_sub(1);
    let mut start = 0;
    while start < records.len() && frame(start) + body > RESULT_CAP {
        body -= sizes[start] + usize::from(start + 1 < records.len());
        start += 1;
    }
    audit["records"] = Value::Array(records[start..].to_vec());
    if start > 0 {
        audit["left_out"] = json!(start);
    }
    audit.to_string()
}

/// Run one tool call against the core.
pub fn call(core: &mut Core, name: &str, input: &Value) -> ToolOutcome {
    let Some(tool) = TOOLS.iter().find(|t| t.name == name) else {
        return ToolOutcome::error(format!("unknown tool {name}"));
    };
    let input = match checked(tool, input) {
        Ok(input) => input,
        Err(problem) => return ToolOutcome::error(problem),
    };
    let null = Value::Null;
    let result = match tool.name {
        "abai_status" => Ok(core.status().to_string()),
        "abai_transcript" => {
            let lines = number(tool, input, "lines") as usize;
            let since = number(tool, input, "since");
            core.drain();
            let read = core.transcript.read(lines, since);
            if read.is_empty() {
                Ok("(nothing yet)".to_string())
            } else {
                let lines: Vec<String> = read
                    .iter()
                    .map(|(number, text)| format!("{number}\t{text}"))
                    .collect();
                Ok(newest_lines(&lines))
            }
        }
        "abai_cells" => {
            let names: Option<Vec<String>> = input.get("names").and_then(|names| {
                let names: Vec<String> = names
                    .as_array()?
                    .iter()
                    .filter_map(|n| n.as_str().map(str::to_string))
                    .collect();
                (!names.is_empty()).then_some(names)
            });
            core.cells(names.as_deref()).map(|v| v.to_string())
        }
        "abai_set" => {
            let value = input.get("value").unwrap_or(&null);
            core.set(text(input, "cell"), value, text(input, "reason"))
                .map(|v| v.to_string())
        }
        "abai_call" => {
            let params = input.get("params").unwrap_or(&null);
            core.call(text(input, "capability"), params, text(input, "reason"))
                .map(|v| v.to_string())
        }
        "abai_decide" => {
            let answer = input.get("answer").unwrap_or(&null);
            core.decide(text(input, "id"), answer, text(input, "reason"))
                .map(|()| "recorded: it applies when you end this step".to_string())
        }
        "abai_watch" => {
            let cell = text(input, "cell");
            if input.get("remove").and_then(Value::as_bool) == Some(true) {
                let removed = core.remove_watch(cell);
                let watches = if removed == 1 { "watch" } else { "watches" };
                Ok(format!("removed {removed} {watches} on {cell}"))
            } else {
                let op = input.get("op").and_then(Value::as_str).unwrap_or("changed");
                let Some(op) = WatchOp::parse(op) else {
                    return ToolOutcome::error(one_of("op", WATCH_OPS));
                };
                let value = input.get("value").cloned().unwrap_or(Value::Null);
                let cadence_ms = input.get("cadence_ms").and_then(whole);
                core.add_watch(cell, op, value, cadence_ms)
                    .map(|v| v.to_string())
            }
        }
        "abai_timer" => {
            let seconds = input.get("seconds").and_then(Value::as_f64).unwrap_or(0.0);
            core.add_timer(seconds, text(input, "note"))
                .map(|v| v.to_string())
        }
        "abai_lifecycle" => {
            let op = match text(input, "op") {
                "" => "status",
                op => op,
            };
            core.lifecycle(op, text(input, "reason"))
                .map(|v| v.to_string())
        }
        "abai_peers" => core.peers().map(|v| v.to_string()),
        "abai_send" => {
            let given = |name: &str| Some(text(input, name)).filter(|value| !value.is_empty());
            core.send(
                text(input, "to"),
                text(input, "body"),
                text(input, "reason"),
                given("thread"),
                given("re"),
                given("network"),
            )
            .map(|v| v.to_string())
        }
        "abai_messages" => {
            let network = Some(text(input, "network")).filter(|value| !value.is_empty());
            let limit = input
                .get("limit")
                .and_then(Value::as_u64)
                .map(|limit| limit as usize);
            core.messages(network, limit).map(|v| v.to_string())
        }
        "abai_audit" => {
            let limit = number(tool, input, "limit") as usize;
            Ok(newest_records(core.audit_tail(limit)))
        }
        other => unreachable!("{other} is in the table but not run"),
    };
    match result {
        Ok(content) => ToolOutcome::ok(content),
        Err(error) => ToolOutcome::error(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;

    use abai_stub::app::Abaigram;
    use abai_stub::content::Content;
    use abai_stub::declare::{Capability, Cell, Decision, Declarations, Event};
    use abai_stub::link::StubCore;
    use abai_stub::manifest::{Field, Manifest, Mode, Schema};
    use abai_stub::region::Region;
    use abai_stub::region::calls::{Target, Which};

    use super::*;
    use crate::audit::AuditLog;
    use crate::core::{Options, Program};

    struct Local {
        stub: Arc<StubCore>,
    }

    impl Program for Local {
        fn region(&self) -> &Arc<Region> {
            &self.stub.region
        }

        fn manifest(&self) -> &Manifest {
            &self.stub.manifest
        }

        fn mode(&self) -> Mode {
            self.stub.mode
        }

        fn drive(&self, _target: Target, limit: Duration, _finished: &dyn Fn() -> bool) {
            if self.stub.serve(Which::All) == 0 {
                std::thread::sleep(limit.min(Duration::from_millis(1)));
            }
        }
    }

    struct Fixture {
        core: Core,
        app: Abaigram,
        dir: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn fixture() -> Fixture {
        let declarations = Declarations::new("tooled", [Mode::Turns])
            .cell(Cell::int("count", "How far the count has got."))
            .cell(
                Cell::int("step", "How much a tick adds.")
                    .knob(1)
                    .range_int(1, 100),
            )
            .capability(
                Capability::new("echo", "Answer the parameters back.")
                    .params(Schema::new().field("word", Field::string()))
                    .handler(|params| params.get::<Value>()),
            )
            .capability(
                Capability::new("big", "A result over the cap.")
                    .handler(|_| Ok("x".repeat(16_000))),
            )
            .event(
                Event::new("ticked", "The count moved.")
                    .payload(Schema::new().field("count", Field::int())),
            )
            .decision(Decision::options(
                "pick",
                ["a", "b"],
                "a",
                "30s",
                "Pick one.",
            ));
        attach(&declarations)
    }

    /// A small program run in thread mode, for watches and timers.
    fn thread_fixture() -> Fixture {
        let declarations = Declarations::new("threaded", [Mode::Thread])
            .cell(Cell::int("count", "How far the count has got."))
            .cell(
                Cell::int("step", "How much a tick adds.")
                    .knob(1)
                    .range_int(1, 100),
            );
        attach(&declarations)
    }

    fn attach(declarations: &Declarations) -> Fixture {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "abai-tools-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let none = |_: &str| None;
        let app = Abaigram::with_env(declarations, &none).unwrap();
        let program = Arc::new(Local {
            stub: app.core().clone(),
        });
        let core = Core::attach(
            program,
            Content {
                identity: "x".into(),
                ..Default::default()
            },
            AuditLog::open(dir.join("audit.jsonl")),
            Options::default(),
            None,
        );
        Fixture { core, app, dir }
    }

    fn ok(core: &mut Core, name: &str, input: Value) -> String {
        let outcome = call(core, name, &input);
        assert!(!outcome.is_error, "{name}: {}", outcome.content);
        outcome.content
    }

    fn error(core: &mut Core, name: &str, input: Value) -> String {
        let outcome = call(core, name, &input);
        assert!(outcome.is_error, "{name}: {}", outcome.content);
        outcome.content
    }

    #[test]
    fn status_names_the_program() {
        let mut f = fixture();
        let status: Value =
            serde_json::from_str(&ok(&mut f.core, "abai_status", json!({}))).unwrap();
        assert_eq!(status["program"], "tooled");
        assert_eq!(status["mode"], "turns");
        assert_eq!(status["attached"], true);
    }

    #[test]
    fn a_knob_is_set_and_read_back() {
        let mut f = fixture();
        let set = ok(
            &mut f.core,
            "abai_set",
            json!({"cell": "step", "value": 5, "reason": "faster"}),
        );
        assert_eq!(set, r#"{"name":"step","value":5}"#);
        let cells = ok(&mut f.core, "abai_cells", json!({"names": ["step"]}));
        assert_eq!(cells, r#"{"step":5}"#);
        let all: Value = serde_json::from_str(&ok(&mut f.core, "abai_cells", json!({}))).unwrap();
        assert_eq!(all["step"], 5);
        assert!(all.get("count").is_some());
        let empty = ok(&mut f.core, "abai_cells", json!({"names": []}));
        assert_eq!(empty, all.to_string());

        let audit: Value =
            serde_json::from_str(&ok(&mut f.core, "abai_audit", json!({"limit": 5}))).unwrap();
        let records = audit["records"].as_array().unwrap();
        let line = records.last().unwrap();
        assert_eq!(line["act"], "knob");
        assert_eq!(line["name"], "step");
        assert_eq!(line["reason"], "faster");
        assert!(ok(&mut f.core, "abai_audit", json!({})).contains(r#""act":"knob""#));
    }

    #[test]
    fn a_capability_is_called() {
        let mut f = fixture();
        let result = ok(
            &mut f.core,
            "abai_call",
            json!({"capability": "echo", "params": {"word": "hi"}, "reason": "to see"}),
        );
        assert_eq!(result, r#"{"word":"hi"}"#);
        // absent params are none
        let result = ok(
            &mut f.core,
            "abai_call",
            json!({"capability": "echo", "reason": "to see"}),
        );
        assert_eq!(result, "{}");
    }

    #[test]
    fn a_decision_is_answered() {
        let mut f = fixture();
        let id = f
            .core
            .open_decision("pick", json!({}), Duration::from_secs(30))
            .unwrap();
        let said = ok(
            &mut f.core,
            "abai_decide",
            json!({"id": id, "answer": "b", "reason": "b is better"}),
        );
        assert_eq!(said, "recorded: it applies when you end this step");
        let wrong = error(
            &mut f.core,
            "abai_decide",
            json!({"id": id, "answer": "c", "reason": "c"}),
        );
        assert_eq!(wrong, "invalid: answer with one of: a, b");
    }

    #[test]
    fn the_transcript_reads_numbered_lines() {
        let mut f = fixture();
        assert_eq!(
            ok(&mut f.core, "abai_transcript", json!({})),
            "(nothing yet)"
        );
        f.core.transcript.push("first");
        f.core.transcript.push("second");
        f.core.transcript.push("third");
        assert_eq!(
            ok(&mut f.core, "abai_transcript", json!({})),
            "0\tfirst\n1\tsecond\n2\tthird"
        );
        assert_eq!(
            ok(&mut f.core, "abai_transcript", json!({"lines": 1})),
            "2\tthird"
        );
        assert_eq!(
            ok(
                &mut f.core,
                "abai_transcript",
                json!({"since": 1, "lines": 60.0})
            ),
            "1\tsecond\n2\tthird"
        );
        assert_eq!(
            ok(&mut f.core, "abai_transcript", json!({"since": 9})),
            "(nothing yet)"
        );
    }

    #[test]
    fn bad_input_is_refused_in_plain_words() {
        let mut f = fixture();
        let cases = [
            ("abai_nothing", json!({}), "unknown tool abai_nothing"),
            ("abai_status", json!([]), "the input must be an object"),
            ("abai_status", json!(null), "the input must be an object"),
            (
                "abai_status",
                json!({"verbose": true}),
                "verbose is not a parameter of abai_status",
            ),
            (
                "abai_set",
                json!({"value": 1, "reason": "r"}),
                "cell is required",
            ),
            (
                "abai_set",
                json!({"cell": "step", "reason": "r"}),
                "value is required",
            ),
            (
                "abai_set",
                json!({"cell": "step", "value": 1}),
                "reason is required",
            ),
            (
                "abai_set",
                json!({"cell": "step", "value": 1, "reason": 7}),
                "reason must be a string",
            ),
            (
                "abai_set",
                json!({"cell": 3, "value": 1, "reason": "r"}),
                "cell must be a string",
            ),
            (
                "abai_transcript",
                json!({"lines": 0}),
                "lines must be a whole number from 1 to 500",
            ),
            (
                "abai_transcript",
                json!({"lines": 501}),
                "lines must be a whole number from 1 to 500",
            ),
            (
                "abai_transcript",
                json!({"lines": 2.5}),
                "lines must be a whole number from 1 to 500",
            ),
            (
                "abai_transcript",
                json!({"since": -1}),
                "since must be a whole number of 0 or more",
            ),
            (
                "abai_audit",
                json!({"limit": "ten"}),
                "limit must be a whole number from 1 to 1000",
            ),
            (
                "abai_cells",
                json!({"names": "step"}),
                "names must be a list of strings",
            ),
            (
                "abai_cells",
                json!({"names": ["step", 2]}),
                "names must be a list of strings",
            ),
            (
                "abai_call",
                json!({"capability": "echo", "params": [1], "reason": "r"}),
                "params must be an object",
            ),
            (
                "abai_decide",
                json!({"id": "d1", "answer": "a", "reason": "r", "why": "x"}),
                "why is not a parameter of abai_decide",
            ),
        ];
        for (tool, input, expected) in cases {
            assert_eq!(
                error(&mut f.core, tool, input.clone()),
                expected,
                "{tool} {input}"
            );
        }
    }

    #[test]
    fn the_core_refuses_in_its_own_words() {
        let mut f = fixture();
        let unknown = error(
            &mut f.core,
            "abai_set",
            json!({"cell": "nothing", "value": 1, "reason": "r"}),
        );
        assert_eq!(unknown, "unknown: nothing is not a cell");
        let unknown = error(&mut f.core, "abai_cells", json!({"names": ["nothing"]}));
        assert!(unknown.starts_with("unknown: "), "{unknown}");
        // an empty reason reaches the core, which refuses it
        let empty = error(
            &mut f.core,
            "abai_set",
            json!({"cell": "step", "value": 1, "reason": ""}),
        );
        assert!(empty.starts_with("invalid: state your reason"), "{empty}");
        let range = error(
            &mut f.core,
            "abai_set",
            json!({"cell": "step", "value": 500, "reason": "r"}),
        );
        assert!(range.starts_with("invalid: "), "{range}");
    }

    #[test]
    fn a_long_result_is_cut_at_the_cap() {
        let mut f = fixture();
        // a capability's reply is itself capped at 16 KiB by the call
        // area, so the transcript carries the long text here
        f.core.transcript.push("y".repeat(20_000));
        let content = ok(&mut f.core, "abai_transcript", json!({}));
        assert!(
            content.ends_with("more bytes]"),
            "{}",
            &content[content.len() - 40..]
        );
        let (kept, cut) = content.rsplit_once('\n').unwrap();
        assert_eq!(kept.len(), RESULT_CAP);
        assert_eq!(cut, format!("[cut: {} more bytes]", 20_002 - RESULT_CAP));

        // a capability result that fits the call area is not cut
        let big = ok(
            &mut f.core,
            "abai_call",
            json!({"capability": "big", "reason": "r"}),
        );
        assert_eq!(big.len(), 16_002);
    }

    #[test]
    fn the_cut_keeps_whole_characters() {
        let text = "é".repeat(RESULT_CAP);
        let content = capped(text);
        let (kept, cut) = content.rsplit_once('\n').unwrap();
        assert_eq!(kept.len(), RESULT_CAP);
        assert_eq!(cut, format!("[cut: {} more bytes]", RESULT_CAP));
        let odd = format!("a{}", "é".repeat(RESULT_CAP / 2));
        let content = capped(odd);
        let (kept, _) = content.rsplit_once('\n').unwrap();
        assert_eq!(kept.len(), RESULT_CAP - 1);
        assert_eq!(capped("short".to_string()), "short");
    }

    #[test]
    fn an_optional_null_is_absent() {
        let mut f = fixture();
        f.core.transcript.push("first");
        assert_eq!(
            ok(
                &mut f.core,
                "abai_transcript",
                json!({"lines": null, "since": null})
            ),
            "0\tfirst"
        );
        let all = ok(&mut f.core, "abai_cells", json!({}));
        assert_eq!(ok(&mut f.core, "abai_cells", json!({"names": null})), all);
        assert!(ok(&mut f.core, "abai_audit", json!({"limit": null})).contains("\"records\""));
        let result = ok(
            &mut f.core,
            "abai_call",
            json!({"capability": "echo", "params": null, "reason": "to see"}),
        );
        assert_eq!(result, "{}");
        // a required null is still refused, except a value or an answer
        assert_eq!(
            error(
                &mut f.core,
                "abai_set",
                json!({"cell": null, "value": 1, "reason": "r"})
            ),
            "cell must be a string"
        );
        assert_eq!(
            error(
                &mut f.core,
                "abai_call",
                json!({"capability": "echo", "reason": null})
            ),
            "reason must be a string"
        );
        let null_value = call(
            &mut f.core,
            "abai_set",
            &json!({"cell": "step", "value": null, "reason": "r"}),
        );
        assert!(!null_value.content.starts_with("value "), "{null_value:?}");
        let null_answer = call(
            &mut f.core,
            "abai_decide",
            &json!({"id": "d1", "answer": null, "reason": "r"}),
        );
        assert!(
            !null_answer.content.starts_with("answer "),
            "{null_answer:?}"
        );
    }

    #[test]
    fn a_long_transcript_keeps_the_newest_lines() {
        let mut f = fixture();
        for n in 0..400 {
            f.core.transcript.push(format!("{n:03} {}", "z".repeat(96)));
        }
        let content = ok(&mut f.core, "abai_transcript", json!({"lines": 500}));
        assert!(content.len() <= RESULT_CAP, "{}", content.len());
        let lines: Vec<&str> = content.lines().collect();
        let left_out: usize = lines[0]
            .strip_prefix('[')
            .and_then(|l| l.strip_suffix(" older lines left out]"))
            .unwrap()
            .parse()
            .unwrap();
        assert!(left_out > 0);
        assert_eq!(left_out + lines.len() - 1, 400);
        assert!(lines[1].starts_with(&format!("{left_out}\t{left_out:03} ")));
        assert!(lines.last().unwrap().starts_with("399\t399 "));
        assert!(!content.contains("[cut:"));
    }

    #[test]
    fn a_long_audit_keeps_the_newest_whole_records() {
        let mut f = fixture();
        let short: Value = serde_json::from_str(&ok(&mut f.core, "abai_audit", json!({}))).unwrap();
        assert!(short.get("left_out").is_none());
        for n in 0..40 {
            ok(
                &mut f.core,
                "abai_set",
                json!({"cell": "step", "value": n % 100 + 1, "reason": format!("{n:04}{}", "r".repeat(1000))}),
            );
        }
        let content = ok(&mut f.core, "abai_audit", json!({}));
        assert!(content.len() <= RESULT_CAP, "{}", content.len());
        let audit: Value = serde_json::from_str(&content).unwrap();
        let left_out = audit["left_out"].as_u64().unwrap();
        assert!(left_out > 0);
        let records = audit["records"].as_array().unwrap();
        assert!(!records.is_empty());
        let reason = records.last().unwrap()["reason"].as_str().unwrap();
        assert!(reason.starts_with("0039"), "{}", &reason[..8]);
        assert!(audit["path"].is_string());
        assert_eq!(audit["failed"], Value::Null);
    }

    #[test]
    fn the_transcript_drains_the_program_first() {
        let mut f = fixture();
        f.app
            .event("ticked")
            .unwrap()
            .emit(|payload| payload.int("count", 7));
        let content = ok(&mut f.core, "abai_transcript", json!({}));
        assert!(content.contains(r#"event ticked {"count":7}"#), "{content}");
    }

    #[test]
    fn the_specs_are_object_schemas() {
        let specs = specs();
        let names: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
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
                "abai_lifecycle",
                "abai_peers",
                "abai_send",
                "abai_messages",
                "abai_audit"
            ]
        );
        for spec in &specs {
            let schema = &spec.schema;
            assert_eq!(schema["type"], "object", "{}", spec.name);
            assert_eq!(schema["additionalProperties"], false, "{}", spec.name);
            let properties = schema["properties"].as_object().unwrap();
            for name in schema["required"].as_array().unwrap() {
                assert!(
                    properties.contains_key(name.as_str().unwrap()),
                    "{} requires {name}",
                    spec.name
                );
            }
            for (name, property) in properties {
                assert!(
                    property["description"].is_string(),
                    "{}.{name} has no description",
                    spec.name
                );
            }
            assert!(!spec.description.is_empty());
        }
        let set = specs.iter().find(|s| s.name == "abai_set").unwrap();
        assert!(set.description.contains("required and audited"));
        assert!(set.description.contains("confirm"));
        let call = specs.iter().find(|s| s.name == "abai_call").unwrap();
        assert!(call.description.contains("required and audited"));
        assert!(call.description.contains("confirm"));
        let watch = specs.iter().find(|s| s.name == "abai_watch").unwrap();
        assert_eq!(
            watch.schema["properties"]["op"]["enum"],
            json!(["changed", "eq", "ne", "gt", "lt", "crossed"])
        );
        assert_eq!(watch.schema["properties"]["remove"]["type"], "boolean");
        assert!(
            watch.schema["properties"]["cadence_ms"]
                .get("default")
                .is_none()
        );
        assert_eq!(watch.schema["required"], json!(["cell"]));
        let timer = specs.iter().find(|s| s.name == "abai_timer").unwrap();
        assert_eq!(timer.schema["properties"]["seconds"]["type"], "number");
        assert_eq!(
            timer.schema["properties"]["seconds"]["exclusiveMinimum"],
            0.0
        );
        assert_eq!(timer.schema["required"], json!(["seconds"]));
    }

    fn watches(core: &mut Core) -> Vec<Value> {
        let status: Value = serde_json::from_str(&ok(core, "abai_status", json!({}))).unwrap();
        status["watches"].as_array().unwrap().clone()
    }

    #[test]
    fn a_watch_is_set_and_seen_in_the_status() {
        let mut f = thread_fixture();
        let set = ok(&mut f.core, "abai_watch", json!({"cell": "count"}));
        assert_eq!(set, r#"{"cell":"count","op":"changed","cadence_ms":1000}"#);
        let watches = watches(&mut f.core);
        assert_eq!(watches.len(), 1);
        assert_eq!(watches[0]["cell"], "count");
        assert_eq!(watches[0]["op"], "changed");
    }

    #[test]
    fn a_watch_on_the_same_cell_and_op_replaces_the_old_one() {
        let mut f = thread_fixture();
        ok(
            &mut f.core,
            "abai_watch",
            json!({"cell": "count", "op": "gt", "value": 10}),
        );
        let set = ok(
            &mut f.core,
            "abai_watch",
            json!({"cell": "count", "op": "gt", "value": 20, "cadence_ms": 250}),
        );
        assert_eq!(set, r#"{"cell":"count","op":"gt","cadence_ms":250}"#);
        let watches = watches(&mut f.core);
        assert_eq!(watches.len(), 1);
        assert_eq!(watches[0]["value"], 20);
        // nulls are absent: the op is changed and there is no value
        ok(
            &mut f.core,
            "abai_watch",
            json!({"cell": "count", "op": null, "value": null, "cadence_ms": null, "remove": null}),
        );
        assert_eq!(watches_len(&mut f.core), 2);
    }

    fn watches_len(core: &mut Core) -> usize {
        watches(core).len()
    }

    #[test]
    fn a_watch_is_removed() {
        let mut f = thread_fixture();
        ok(&mut f.core, "abai_watch", json!({"cell": "count"}));
        ok(
            &mut f.core,
            "abai_watch",
            json!({"cell": "count", "op": "crossed", "value": 50}),
        );
        ok(&mut f.core, "abai_watch", json!({"cell": "step"}));
        // remove false sets a watch as usual
        ok(
            &mut f.core,
            "abai_watch",
            json!({"cell": "step", "remove": false}),
        );
        assert_eq!(watches_len(&mut f.core), 3);
        assert_eq!(
            ok(
                &mut f.core,
                "abai_watch",
                json!({"cell": "count", "remove": true})
            ),
            "removed 2 watches on count"
        );
        assert_eq!(
            ok(
                &mut f.core,
                "abai_watch",
                json!({"cell": "step", "remove": true})
            ),
            "removed 1 watch on step"
        );
        assert_eq!(
            ok(
                &mut f.core,
                "abai_watch",
                json!({"cell": "step", "remove": true})
            ),
            "removed 0 watches on step"
        );
        assert_eq!(watches_len(&mut f.core), 0);
    }

    #[test]
    fn a_bad_watch_is_refused() {
        let mut f = thread_fixture();
        assert_eq!(
            error(&mut f.core, "abai_watch", json!({"cell": "nothing"})),
            "unknown: nothing is not a cell"
        );
        let ops = "op must be one of changed, eq, ne, gt, lt, crossed";
        assert_eq!(
            error(
                &mut f.core,
                "abai_watch",
                json!({"cell": "count", "op": "above", "value": 1})
            ),
            ops
        );
        assert_eq!(
            error(&mut f.core, "abai_watch", json!({"cell": "count", "op": 3})),
            ops
        );
        assert_eq!(
            error(
                &mut f.core,
                "abai_watch",
                json!({"cell": "count", "remove": "yes"})
            ),
            "remove must be true or false"
        );
        assert_eq!(
            error(
                &mut f.core,
                "abai_watch",
                json!({"cell": "count", "cadence_ms": 50})
            ),
            "cadence_ms must be a whole number from 100 to 3600000"
        );
        let no_value = error(
            &mut f.core,
            "abai_watch",
            json!({"cell": "count", "op": "gt"}),
        );
        assert!(no_value.starts_with("invalid: "), "{no_value}");
        assert_eq!(watches_len(&mut f.core), 0);
    }

    #[test]
    fn there_are_no_watches_or_timers_in_turns_mode() {
        let mut f = fixture();
        let watch = error(&mut f.core, "abai_watch", json!({"cell": "count"}));
        assert!(
            watch.starts_with("invalid: there are no watches in turns mode"),
            "{watch}"
        );
        let timer = error(&mut f.core, "abai_timer", json!({"seconds": 5}));
        assert!(
            timer.starts_with("invalid: there are no timers in turns mode"),
            "{timer}"
        );
    }

    #[test]
    fn a_timer_is_set() {
        let mut f = thread_fixture();
        assert_eq!(
            ok(
                &mut f.core,
                "abai_timer",
                json!({"seconds": 1.5, "note": "look again"})
            ),
            r#"{"seconds":1.5,"note":"look again"}"#
        );
        assert_eq!(
            ok(
                &mut f.core,
                "abai_timer",
                json!({"seconds": 86400, "note": null})
            ),
            r#"{"seconds":86400.0,"note":""}"#
        );
        let status: Value =
            serde_json::from_str(&ok(&mut f.core, "abai_status", json!({}))).unwrap();
        assert_eq!(status["timers"], 2);
    }

    #[test]
    fn a_bad_timer_is_refused() {
        let mut f = thread_fixture();
        let expected = "seconds must be a number above 0 and at most 86400";
        for seconds in [
            json!(0),
            json!(-1),
            json!(-0.5),
            json!(90000),
            json!("5"),
            json!(null),
        ] {
            assert_eq!(
                error(&mut f.core, "abai_timer", json!({"seconds": seconds})),
                expected,
                "{seconds}"
            );
        }
        assert_eq!(
            error(&mut f.core, "abai_timer", json!({})),
            "seconds is required"
        );
        assert_eq!(
            error(&mut f.core, "abai_timer", json!({"seconds": 5, "note": 1})),
            "note must be a string"
        );
    }
}
