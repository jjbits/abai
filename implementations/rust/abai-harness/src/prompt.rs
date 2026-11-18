//! The agent's system prompt (contract section 8), composed from the
//! identity content and the manifest. The same inputs give the same text.

use abai_stub::content::Content;
use abai_stub::manifest::{
    CapabilityDecl, CellDecl, DecisionDecl, EVENT_SLOT_BYTES, EventDecl, Field, Manifest, Mode,
    Policy, Schema, TurnDecl, ValueType,
};

/// Who drives the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Form {
    /// The harness's own agent loop.
    Session,
    /// An MCP client's agent, which calls the tools itself.
    Mcp,
}

/// A field's type as the prompt writes it.
fn type_of(field: &Field) -> String {
    let base = match (field.ty, &field.values, &field.fields, &field.items) {
        (ValueType::Enum, Some(values), _, _) => values.join("|"),
        (ValueType::Object, _, Some(fields), _) if !fields.is_empty() => {
            format!("object {{{}}}", fields_line(fields))
        }
        (ValueType::List, _, _, Some(items)) => format!("list of {}", type_of(items)),
        (ty, _, _, _) => ty.as_str().to_string(),
    };
    if field.nullable == Some(true) {
        format!("{base} or null")
    } else {
        base
    }
}

/// The fields of a schema as `name: type` pairs.
fn fields_line(schema: &Schema) -> String {
    schema
        .0
        .iter()
        .map(|(name, field)| format!("{name}: {}", type_of(field)))
        .collect::<Vec<_>>()
        .join(", ")
}

fn params_line(schema: &Schema) -> String {
    if schema.is_empty() {
        "none".to_string()
    } else {
        fields_line(schema)
    }
}

fn cell_line(cell: &CellDecl) -> String {
    let mut parts = vec![type_of(&cell.as_field())];
    if let Some([min, max]) = &cell.range {
        parts.push(format!("from {min} to {max}"));
    }
    if let Some(max) = cell.max {
        parts.push(format!("max {max} bytes"));
    }
    if cell.is_knob() {
        parts.push("knob".to_string());
        if let Some(default) = &cell.default {
            parts.push(format!("default {default}"));
        }
        if cell.policy == Some(Policy::Confirm) {
            parts.push("confirm".to_string());
        }
    } else {
        parts.push("read".to_string());
    }
    format!(
        "- {} ({}): {}",
        cell.name,
        parts.join(", "),
        cell.doc.trim()
    )
}

fn capability_line(capability: &CapabilityDecl) -> String {
    let mut marks = Vec::new();
    if capability.effect == abai_stub::manifest::Effect::Mutate {
        marks.push("mutate");
    }
    if capability.policy == Policy::Confirm {
        marks.push("confirm");
    }
    let params = format!("params: {}", params_line(&capability.params));
    let parts = if marks.is_empty() {
        params
    } else {
        format!("{}; {params}", marks.join(", "))
    };
    format!("- {} ({parts}): {}", capability.name, capability.doc.trim())
}

fn decision_line(decision: &DecisionDecl) -> String {
    let mut parts = Vec::new();
    match (&decision.options, &decision.answer) {
        (Some(options), _) => parts.push(format!("options: {}", options.join(", "))),
        (None, Some(answer)) => parts.push(format!("answer fields: {}", params_line(answer))),
        (None, None) => {}
    }
    parts.push(format!("default {}", decision.default));
    parts.push(format!("timeout {}", decision.timeout));
    if decision.policy == Policy::Confirm {
        parts.push("confirm".to_string());
    }
    let cost = if decision.context.slot_bytes() > EVENT_SLOT_BYTES {
        " Expensive: its context is large."
    } else {
        ""
    };
    format!(
        "- {} ({}): {}{cost}",
        decision.name,
        parts.join("; "),
        decision.doc.trim()
    )
}

fn event_line(event: &EventDecl) -> String {
    let mut parts = Vec::new();
    if let Some(condition) = event.wakes.as_deref().filter(|w| *w != "always") {
        parts.push(format!("when {condition}"));
    }
    parts.push(format!("payload: {}", params_line(&event.payload)));
    format!(
        "- {} ({}): {}",
        event.name,
        parts.join("; "),
        event.doc.trim()
    )
}

/// An event as turns mode lists it: no wake condition, as nothing wakes.
fn transcript_event_line(event: &EventDecl) -> String {
    format!(
        "- {} (payload: {}): {}",
        event.name,
        params_line(&event.payload),
        event.doc.trim()
    )
}

fn turn_line(turn: &TurnDecl) -> String {
    format!(
        "- {} (timeout {}): {}",
        turn.name,
        turn.timeout,
        turn.doc.trim()
    )
}

fn wakes(event: &EventDecl) -> bool {
    event.wakes.as_deref().is_some_and(|w| w != "never")
}

const MCP_ATTACHED: &str = "Nothing can wake you: you park by calling abai_wait, which returns the next wake (an event declared to wake you, a watch, a timer, a decision or a turn from the program) or says that none came, and you call it again. A decision or a turn the program is waiting on is settled when you park again, so answer a decision with abai_decide before you do. A wake is not a message from the person; act on it, then park again. Answer the person when they speak to you. A confirm act is shown to the person by your own client before it runs; that is their consent.";

fn attached_paragraph(name: &str, mode: Mode, form: Form) -> String {
    if form == Form::Mcp {
        let lifecycle = match mode {
            Mode::Sidecar => format!(" {LIFECYCLE}"),
            _ => String::new(),
        };
        return format!(
            "You are attached to the running program {name}, in {} mode, from an MCP client. {MCP_ATTACHED}{lifecycle}",
            mode.as_str()
        );
    }
    let how = match mode {
        Mode::Turns => {
            "You run only when the program gives you control: at a turn, a decision, install, or a session. The program is stopped while you work, and nothing wakes you in between. Act with tools when something needs doing, answer briefly, and stop; the program goes on when you end your step."
        }
        Mode::Thread => {
            "You run on a thread inside the program, which keeps running while you work: what you read can change before you act on it. Act with tools when something needs doing, answer briefly, and stop; the next wake comes on its own."
        }
        Mode::Sidecar => {
            "You run in a process of your own beside the program, which keeps running while you work: what you read can change before you act on it. Act with tools when something needs doing, answer briefly, and stop; the next wake comes on its own."
        }
    };
    let parked = match mode {
        Mode::Turns => String::new(),
        Mode::Thread => format!(" {PARKED}"),
        Mode::Sidecar => format!(" {PARKED} {LIFECYCLE}"),
    };
    let driver = "The harness runs you in its own agent loop.";
    format!(
        "You are attached to the running program {name}, in {} mode. {how}{parked} {driver} {PLAIN_TEXT}",
        mode.as_str()
    )
}

const NETWORK_MEMBERS: &str = "Whether this run is on it, and as which member, is in the transcript from attach (lines that begin with # network) and in abai_peers, which lists the members and who is reachable now. A member's name is the one the network's authority issued; a name a member only claims is shown apart and does not route.";

const NETWORK_SURE: &str = "abai_send answers a member by name, with a reason, and abai_messages lists this run's messages. A message is as sure as the daemons at both ends: one to a member whose daemon is down fails within about half a minute, and one that arrives while no program is attached waits in the daemon and is lost if that daemon stops.";

const LIFECYCLE: &str = "abai_lifecycle asks the program's status, and where this harness launched the program it can pause, resume, stop or restart it; stop and restart ask the user first. The output and the exit of a program this harness launched arrive as the events abai.io.stdout, abai.io.stderr and abai.lifecycle.exited.";

const PARKED: &str = "Between wakes you are parked. You are woken by an event declared to wake you, a watch you set on a cell (abai_watch), a timer you set (abai_timer), a decision or a turn from the program, or the user.";

/// The attention budget as a sentence, when the manifest declares one.
fn budget_sentence(manifest: &Manifest) -> Option<String> {
    let budget = manifest.attention.as_ref()?.budget.as_ref()?;
    let mut limits = Vec::new();
    if let Some(wakes) = budget.wakes_per_minute {
        limits.push(format!("{wakes} wakes a minute"));
    }
    if let Some(tokens) = budget.tokens_per_hour {
        limits.push(format!("{tokens} model tokens an hour"));
    }
    if limits.is_empty() {
        return None;
    }
    Some(format!(
        "The program limits your attention: at most {}.",
        limits.join(" and ")
    ))
}

const PLAIN_TEXT: &str = "What you say in plain text goes to the user when there is one; a wake that starts with [abai wake] comes from the program, not from a person.";

const POLICY: &str = "Every act of control has a policy. auto: the act runs when you ask for it. confirm: the act is put to the user first, who can deny it; when there is no one to ask, it is denied. Do not repeat a denied act. forbid: the act is refused, and what policy forbids is not listed here. Every act of control (abai_set, abai_call, abai_decide) needs a stated reason, and is written to the program's audit log with it.";

const DECISIONS_NOTE: &str = "Answer a decision put to you with abai_decide, by its id, with one of its options as a string or the full answer object its fields declare. A decision left unanswered, or whose time is up, takes its default.";

const RULES: &[&str] = &[
    "- Read the cells and the transcript before you act; the cells are the truth about the program. Most wakes need nothing.",
    "- State a reason with every act of control: abai_set, abai_call and abai_decide require one. It goes to the program's audit log, which the user reads.",
    "- When a decision is put to you, answer it with abai_decide by its id before you end the step.",
    "- When you are done, say what you did in one or two sentences, and stop.",
];

/// The rule added where the agent is woken between touchpoints.
const WAKE_RULE: &str = "- Most wakes need nothing: look, and if nothing needs doing, end your step. Do not set a watch that fires all the time; an attention budget may hold wakes back.";

fn section(heading: &str, body: &[String]) -> String {
    format!("## {heading}\n\n{}", body.join("\n"))
}

/// The agent's system prompt (contract section 8): the identity, how the
/// agent is attached, the policy, and every declaration with its doc.
/// The short form an MCP client receives as the server's instructions.
pub fn instructions(manifest: &Manifest, content: &Content, mode: Mode) -> String {
    // the identity's first paragraph after its heading, when it has one
    let first = content
        .identity
        .split("\n\n")
        .map(str::trim)
        .find(|part| !part.is_empty() && !part.starts_with('#'))
        .unwrap_or("");
    let mut parts = vec![format!(
        "{} abai harness (abaigrammar {}, {}).",
        manifest.name,
        manifest.abaigrammar,
        mode.as_str()
    )];
    if !first.is_empty() {
        parts.push(first.to_string());
    }
    parts.push("Call abai_prompt once for the full instructions, abai_status for the program's state, and abai_wait to park until the next wake; act on wakes with the abai_* tools, stating a reason for every act of control.".to_string());
    parts.join("\n\n")
}

pub fn compose(manifest: &Manifest, content: &Content, mode: Mode, form: Form) -> String {
    let mut sections = vec![content.identity.trim().to_string()];
    sections.push(section(
        "How you are attached",
        &[attached_paragraph(&manifest.name, mode, form)],
    ));
    let policy = match budget_sentence(manifest) {
        Some(budget) => format!("{POLICY} {budget}"),
        None => POLICY.to_string(),
    };
    sections.push(section("Policy", &[policy]));
    if let Some(network) = &manifest.network {
        sections.push(section(
            "Network",
            &[format!(
                "The program declares a network. {}{NETWORK_MEMBERS} {} {NETWORK_SURE}",
                match network.doc.trim() {
                    "" => String::new(),
                    doc => format!("{doc} "),
                },
                match mode {
                    // nothing wakes the agent between touchpoints
                    Mode::Turns => {
                        "A message from a member is shown to you at the program's next touchpoint, as abai.net.message, with the sender's issued name and what it said;"
                    }
                    Mode::Thread | Mode::Sidecar => {
                        "A message from a member wakes you as abai.net.message, with the sender's issued name and what it said;"
                    }
                }
            )],
        ));
    }

    let modes: Vec<&str> = manifest.modes.iter().map(|m| m.as_str()).collect();
    let mut program = vec![format!(
        "abaigrammar {}. The modes it supports: {}.",
        manifest.abaigrammar,
        modes.join(", ")
    )];
    if !manifest.deviations.is_empty() {
        program.push(String::new());
        program.push("Where this program departs from the grammar:".to_string());
        program.extend(
            manifest
                .deviations
                .iter()
                .map(|d| format!("- {}", d.trim())),
        );
    }
    sections.push(section(
        &format!("The program: {}", manifest.name),
        &program,
    ));

    if !manifest.cells.is_empty() {
        let lines: Vec<String> = manifest.cells.iter().map(cell_line).collect();
        let heading = match mode {
            Mode::Turns => "Cells (read with abai_cells; knobs written with abai_set)",
            Mode::Thread | Mode::Sidecar => {
                "Cells (read with abai_cells; knobs written with abai_set; watched with abai_watch)"
            }
        };
        sections.push(section(heading, &lines));
    }

    let capabilities: Vec<String> = manifest
        .capabilities
        .iter()
        .filter(|c| c.policy != Policy::Forbid)
        .map(capability_line)
        .collect();
    if !capabilities.is_empty() {
        sections.push(section(
            "Capabilities (called with abai_call)",
            &capabilities,
        ));
    }

    let mut decisions: Vec<String> = manifest
        .decisions
        .iter()
        .filter(|d| d.policy != Policy::Forbid)
        .map(decision_line)
        .collect();
    if !decisions.is_empty() {
        decisions.push(String::new());
        decisions.push(DECISIONS_NOTE.to_string());
        sections.push(section("Decisions (answered with abai_decide)", &decisions));
    }

    if mode == Mode::Turns {
        let mut events: Vec<String> = manifest.events.iter().map(transcript_event_line).collect();
        if !events.is_empty() {
            events.push(String::new());
            events.push(
                "Read them with abai_transcript. In turns mode no event wakes you; events emitted while you were not running are read at the next touchpoint.".to_string(),
            );
            sections.push(section("Events (in the transcript)", &events));
        }
    } else {
        let mut events: Vec<String> = manifest
            .events
            .iter()
            .filter(|e| wakes(e))
            .map(event_line)
            .collect();
        if !events.is_empty() {
            events.push(String::new());
            events.push(
                "Every event, these and the rest, is in the transcript (abai_transcript)."
                    .to_string(),
            );
            sections.push(section("Events that wake you", &events));
        }
    }

    let turns: Vec<String> = manifest.turns.iter().map(turn_line).collect();
    if !turns.is_empty() {
        sections.push(section("Turns", &turns));
    }

    if let Some(use_) = content.use_.as_deref().map(str::trim)
        && !use_.is_empty()
    {
        sections.push(section("Use", &[use_.to_string()]));
    }

    let mut rules: Vec<String> = RULES.iter().map(|r| r.to_string()).collect();
    if mode != Mode::Turns {
        rules.insert(rules.len() - 1, WAKE_RULE.to_string());
    }
    sections.push(section("Rules", &rules));

    let text = sections.join("\n\n");
    text.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use abai_stub::declare::{Capability, Cell, Decision, Declarations, Event, Turn};
    use abai_stub::manifest::{AttentionDecl, BudgetDecl, Field, Schema};
    use serde_json::json;

    use super::*;

    fn everything() -> Manifest {
        let mut manifest = Declarations::new("counter", [Mode::Turns, Mode::Thread])
            .deviation("The count is kept in memory only.")
            .cell(Cell::int("count", "How far the count has got."))
            .cell(
                Cell::int("step", "How much a tick adds.")
                    .knob(1)
                    .range_int(1, 100),
            )
            .cell(
                Cell::int("limit", "Where the count stops.")
                    .knob(1000)
                    .confirm(),
            )
            .cell(
                Cell::string("label", "The word beside the count.")
                    .knob("count")
                    .max(16),
            )
            .cell(Cell::enumeration(
                "phase",
                ["warm", "run", "done"],
                "Where the program is.",
            ))
            .event(
                Event::new("milestone", "The count passed a hundred.")
                    .payload(Schema::new().field("count", Field::int()))
                    .wakes_always(),
            )
            .event(
                Event::new("backlog", "Work is piling up.")
                    .payload(Schema::new().field("depth", Field::int()))
                    .wakes_when("depth gt 100"),
            )
            .event(
                Event::new("tick", "The count moved.")
                    .payload(Schema::new().field("count", Field::int())),
            )
            .capability(
                Capability::new("reset", "Set the count back.")
                    .params(Schema::new().field("to", Field::int()))
                    .mutate()
                    .handler(|_| Ok(())),
            )
            .capability(Capability::new("peek", "The count, at once.").handler(|_| Ok(())))
            .capability(
                Capability::new("wipe", "Forget everything.")
                    .mutate()
                    .policy(Policy::Forbid)
                    .handler(|_| Ok(())),
            )
            .decision(
                Decision::options("on_limit", ["wrap", "stop"], "stop", "5s", "At the limit.")
                    .context(Schema::new().field("count", Field::int())),
            )
            .decision(
                Decision::answer(
                    "plan",
                    Schema::new()
                        .field("steps", Field::int())
                        .field("note", Field::string()),
                    json!({"steps": 0}),
                    "5s",
                    "A plan for the next lap.",
                )
                .context(Schema::new().field("history", Field::string().max(8000))),
            )
            .decision(
                Decision::options(
                    "never_asked",
                    ["a", "b"],
                    "a",
                    "5s",
                    "The agent is not asked.",
                )
                .policy(Policy::Forbid),
            )
            .turn(Turn::new("each_lap", "30s", "After a lap."))
            .budget(Some(30), Some(200_000))
            .manifest()
            .unwrap();
        // the stub adds deviations of its own; only the program's are kept,
        // so the whole text does not follow the stub's wording
        manifest
            .deviations
            .retain(|d| d == "The count is kept in memory only.");
        manifest
    }

    fn content() -> Content {
        Content {
            identity: "\nYou are the agent of counter.\n\n".to_string(),
            use_: Some("Keep the count moving.\n".to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn every_section_is_there_in_order() {
        let prompt = compose(&everything(), &content(), Mode::Turns, Form::Session);
        assert!(prompt.starts_with("You are the agent of counter.\n\n## How you are attached"));
        let headings = [
            "## How you are attached",
            "## Policy",
            "## The program: counter",
            "## Cells",
            "## Capabilities",
            "## Decisions",
            "## Events (in the transcript)",
            "## Turns",
            "## Use",
            "## Rules",
        ];
        let at: Vec<usize> = headings
            .iter()
            .map(|h| prompt.find(h).unwrap_or_else(|| panic!("{h} missing")))
            .collect();
        assert!(at.windows(2).all(|w| w[0] < w[1]), "{at:?}");

        for forbidden in ["wipe", "never_asked"] {
            assert!(!prompt.contains(forbidden), "{forbidden} is listed");
        }
        assert!(
            prompt.contains("- limit (int, knob, default 1000, confirm): Where the count stops.")
        );
        assert!(prompt.contains("- reset (mutate, confirm; params: to: int): Set the count back."));
        assert!(prompt.contains("- peek (params: none): The count, at once."));
        assert!(prompt.contains("- step (int, from 1 to 100, knob, default 1)"));
        assert!(prompt.contains("- label (string, max 16 bytes, knob, default \"count\")"));
        assert!(prompt.contains("- phase (warm|run|done, read)"));
        assert!(prompt.contains("- milestone (payload: count: int)"));
        assert!(prompt.contains("- backlog (payload: depth: int): Work is piling up."));
        assert!(prompt.contains("- tick (payload: count: int): The count moved."));
        assert!(!prompt.contains("Events that wake you"));
        assert!(prompt.contains("A plan for the next lap. Expensive"));
        assert!(!prompt.contains("At the limit. Expensive"));
        assert!(prompt.contains("- The count is kept in memory only."));
        assert!(prompt.contains("Keep the count moving."));
        assert!(prompt.contains("- each_lap (timeout 30s): After a lap."));
    }

    #[test]
    fn empty_sections_are_left_out() {
        let mut manifest = Declarations::new("plain", [Mode::Turns])
            .cell(Cell::int("count", "How far the count has got."))
            .manifest()
            .unwrap();
        // the stub declares its own deviations; this program has none
        manifest.deviations.clear();
        let content = Content {
            identity: "You are plain.".to_string(),
            ..Default::default()
        };
        let prompt = compose(&manifest, &content, Mode::Turns, Form::Session);
        assert!(prompt.contains("## Cells"));
        for absent in [
            "## Capabilities",
            "## Decisions",
            "## Events",
            "## Turns",
            "## Use",
            "departs from the grammar",
        ] {
            assert!(!prompt.contains(absent), "{absent} is there");
        }
    }

    #[test]
    fn the_mode_changes_the_text() {
        let turns = compose(&everything(), &content(), Mode::Turns, Form::Session);
        let thread = compose(&everything(), &content(), Mode::Thread, Form::Session);
        assert_ne!(turns, thread);
        assert!(turns.contains("in turns mode"));
        assert!(thread.contains("in thread mode"));
        assert!(turns.contains("nothing wakes you in between"));
        assert!(!thread.contains("nothing wakes you in between"));
    }

    #[test]
    fn thread_mode_lists_the_events_that_wake() {
        let thread = compose(&everything(), &content(), Mode::Thread, Form::Session);
        assert!(thread.contains("## Events that wake you"));
        assert!(!thread.contains("## Events (in the transcript)"));
        assert!(thread.contains("- milestone (payload: count: int): The count passed a hundred."));
        assert!(thread.contains("- backlog (when depth gt 100; payload: depth: int)"));
        assert!(!thread.contains("- tick"));
        assert!(thread.contains("Every event, these and the rest, is in the transcript"));
    }

    #[test]
    fn thread_and_sidecar_say_what_wakes_the_agent() {
        for mode in [Mode::Thread, Mode::Sidecar] {
            let prompt = compose(&everything(), &content(), mode, Form::Session);
            assert!(prompt.contains(
                "the next wake comes on its own. Between wakes you are parked. You are woken by an event declared to wake you, a watch you set on a cell (abai_watch), a timer you set (abai_timer), a decision or a turn from the program, or the user."
            ), "{mode:?}");
            // only a harness in another process has the lifecycle channel
            assert_eq!(
                prompt.contains("or the user. abai_lifecycle asks the program's status"),
                mode == Mode::Sidecar
            );
            assert_eq!(
                prompt.contains("or the user. The harness runs you"),
                mode == Mode::Thread
            );
            assert!(prompt.contains(
                "## Cells (read with abai_cells; knobs written with abai_set; watched with abai_watch)\n"
            ), "{mode:?}");
            assert!(prompt.contains(
                "\n- Most wakes need nothing: look, and if nothing needs doing, end your step. Do not set a watch that fires all the time; an attention budget may hold wakes back.\n- When you are done,"
            ), "{mode:?}");
        }
        let turns = compose(&everything(), &content(), Mode::Turns, Form::Session);
        for absent in ["parked", "abai_watch", "abai_timer", "attention budget"] {
            assert!(!turns.contains(absent), "{absent} is in turns mode");
        }
    }

    #[test]
    fn a_budget_is_said_at_the_end_of_the_policy() {
        let budgeted = |wakes, tokens| {
            let mut manifest = everything();
            manifest.attention = Some(AttentionDecl {
                budget: Some(BudgetDecl {
                    wakes_per_minute: wakes,
                    tokens_per_hour: tokens,
                }),
            });
            manifest
        };
        let policy = |manifest: &Manifest, mode| {
            let prompt = compose(manifest, &content(), mode, Form::Session);
            prompt
                .split("## Policy\n\n")
                .nth(1)
                .and_then(|rest| rest.split("\n\n").next())
                .unwrap()
                .to_string()
        };
        for mode in [Mode::Turns, Mode::Thread, Mode::Sidecar] {
            assert!(policy(&budgeted(Some(30), Some(200_000)), mode).ends_with(
                "written to the program's audit log with it. The program limits your attention: at most 30 wakes a minute and 200000 model tokens an hour."
            ), "{mode:?}");
            assert!(
                policy(&budgeted(Some(30), None), mode)
                    .ends_with(" The program limits your attention: at most 30 wakes a minute.")
            );
            assert!(policy(&budgeted(None, Some(5000)), mode).ends_with(
                " The program limits your attention: at most 5000 model tokens an hour."
            ));
            assert_eq!(policy(&budgeted(None, None), mode), POLICY);
            let mut unbudgeted = everything();
            unbudgeted.attention = None;
            assert_eq!(policy(&unbudgeted, mode), POLICY);
        }
    }

    #[test]
    fn every_mode_says_who_hears_plain_text() {
        for mode in [Mode::Turns, Mode::Thread, Mode::Sidecar] {
            let prompt = compose(&everything(), &content(), mode, Form::Session);
            let attached = prompt
                .split("## How you are attached\n\n")
                .nth(1)
                .and_then(|rest| rest.split("\n\n").next())
                .unwrap();
            assert!(
                attached.ends_with(" a wake that starts with [abai wake] comes from the program, not from a person."),
                "{mode:?}: {attached}"
            );
        }
    }

    #[test]
    fn the_text_is_clean() {
        let prompt = compose(&everything(), &content(), Mode::Turns, Form::Session);
        for line in prompt.lines() {
            assert_eq!(line, line.trim_end(), "trailing whitespace: {line:?}");
        }
        assert!(!prompt.ends_with('\n'));
        assert!(!prompt.contains("\n\n\n"));
        assert_eq!(
            prompt,
            compose(&everything(), &content(), Mode::Turns, Form::Session)
        );
    }

    #[test]
    fn the_whole_text() {
        let prompt = compose(&everything(), &content(), Mode::Turns, Form::Session);
        assert_eq!(prompt, WHOLE);
    }

    const WHOLE: &str = r#"You are the agent of counter.

## How you are attached

You are attached to the running program counter, in turns mode. You run only when the program gives you control: at a turn, a decision, install, or a session. The program is stopped while you work, and nothing wakes you in between. Act with tools when something needs doing, answer briefly, and stop; the program goes on when you end your step. The harness runs you in its own agent loop. What you say in plain text goes to the user when there is one; a wake that starts with [abai wake] comes from the program, not from a person.

## Policy

Every act of control has a policy. auto: the act runs when you ask for it. confirm: the act is put to the user first, who can deny it; when there is no one to ask, it is denied. Do not repeat a denied act. forbid: the act is refused, and what policy forbids is not listed here. Every act of control (abai_set, abai_call, abai_decide) needs a stated reason, and is written to the program's audit log with it. The program limits your attention: at most 30 wakes a minute and 200000 model tokens an hour.

## The program: counter

abaigrammar 0.1. The modes it supports: turns, thread.

Where this program departs from the grammar:
- The count is kept in memory only.

## Cells (read with abai_cells; knobs written with abai_set)

- count (int, read): How far the count has got.
- step (int, from 1 to 100, knob, default 1): How much a tick adds.
- limit (int, knob, default 1000, confirm): Where the count stops.
- label (string, max 16 bytes, knob, default "count"): The word beside the count.
- phase (warm|run|done, read): Where the program is.

## Capabilities (called with abai_call)

- reset (mutate, confirm; params: to: int): Set the count back.
- peek (params: none): The count, at once.

## Decisions (answered with abai_decide)

- on_limit (options: wrap, stop; default "stop"; timeout 5s): At the limit.
- plan (answer fields: steps: int, note: string; default {"steps":0}; timeout 5s): A plan for the next lap. Expensive: its context is large.

Answer a decision put to you with abai_decide, by its id, with one of its options as a string or the full answer object its fields declare. A decision left unanswered, or whose time is up, takes its default.

## Events (in the transcript)

- milestone (payload: count: int): The count passed a hundred.
- backlog (payload: depth: int): Work is piling up.
- tick (payload: count: int): The count moved.

Read them with abai_transcript. In turns mode no event wakes you; events emitted while you were not running are read at the next touchpoint.

## Turns

- each_lap (timeout 30s): After a lap.

## Use

Keep the count moving.

## Rules

- Read the cells and the transcript before you act; the cells are the truth about the program. Most wakes need nothing.
- State a reason with every act of control: abai_set, abai_call and abai_decide require one. It goes to the program's audit log, which the user reads.
- When a decision is put to you, answer it with abai_decide by its id before you end the step.
- When you are done, say what you did in one or two sentences, and stop."#;
}
