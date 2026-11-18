//! Manifest validation.

use std::collections::HashSet;

use serde_json::Value;

use super::{
    ABAIGRAMMAR_VERSION, Access, CapabilityDecl, CellDecl, DecisionDecl, EVENT_SLOT_BYTES,
    EventDecl, Field, Manifest, Policy, Schema, TurnDecl, ValueType, duration_ms, is_valid_name,
    matches_type,
};

/// Validate a manifest. Returns the violations, each `<where>: <what>`; an
/// empty list means the manifest validates.
pub fn validate(manifest: &Manifest) -> Vec<String> {
    let mut out = Vec::new();
    validate_top(&mut out, manifest);

    let mut seen = HashSet::new();
    for (index, cell) in manifest.cells.iter().enumerate() {
        if let Some(at) = check_named(&mut out, "cells", index, &cell.name, &cell.doc, &mut seen) {
            validate_cell(&mut out, &at, cell);
        }
    }
    let mut seen = HashSet::new();
    for (index, event) in manifest.events.iter().enumerate() {
        if let Some(at) = check_named(
            &mut out,
            "events",
            index,
            &event.name,
            &event.doc,
            &mut seen,
        ) {
            validate_event(&mut out, &at, event);
        }
    }
    let mut seen = HashSet::new();
    for (index, cap) in manifest.capabilities.iter().enumerate() {
        if let Some(at) = check_named(
            &mut out,
            "capabilities",
            index,
            &cap.name,
            &cap.doc,
            &mut seen,
        ) {
            validate_capability(&mut out, &at, cap);
        }
    }
    let mut seen = HashSet::new();
    for (index, decision) in manifest.decisions.iter().enumerate() {
        if let Some(at) = check_named(
            &mut out,
            "decisions",
            index,
            &decision.name,
            &decision.doc,
            &mut seen,
        ) {
            validate_decision(&mut out, &at, decision);
        }
    }
    let mut seen = HashSet::new();
    for (index, turn) in manifest.turns.iter().enumerate() {
        if let Some(at) = check_named(&mut out, "turns", index, &turn.name, &turn.doc, &mut seen) {
            validate_turn(&mut out, &at, turn, manifest);
        }
    }
    out
}

fn add(out: &mut Vec<String>, at: &str, what: &str) {
    out.push(format!("{at}: {what}"));
}

fn is_blank(value: &str) -> bool {
    value.trim().is_empty()
}

fn is_duration(value: &str) -> bool {
    duration_ms(value).is_some()
}

/// Whether a program name matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`.
fn is_program_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// The encoded size in bytes of a sized value: a string's UTF-8 length, an
/// object's or a list's JSON length. None for any other value.
fn encoded_size(value: &Value) -> Option<usize> {
    match value {
        Value::String(s) => Some(s.len()),
        Value::Object(_) | Value::Array(_) => serde_json::to_string(value).ok().map(|s| s.len()),
        _ => None,
    }
}

/// Whether a list has no empty string and no repeat.
fn distinct_non_empty(values: &[String]) -> bool {
    let mut seen = HashSet::new();
    values.iter().all(|v| !v.is_empty() && seen.insert(v))
}

fn validate_top(out: &mut Vec<String>, m: &Manifest) {
    if m.abaigrammar != ABAIGRAMMAR_VERSION {
        add(
            out,
            "abaigrammar",
            &format!("must be \"{ABAIGRAMMAR_VERSION}\""),
        );
    }
    if is_blank(&m.name) {
        add(out, "name", "is required");
    } else if !is_program_name(&m.name) {
        add(
            out,
            "name",
            "must be letters, digits, dots, underscores and hyphens",
        );
    }
    if is_blank(&m.entry) {
        add(out, "entry", "is required");
    } else if m.entry.chars().any(char::is_control) {
        add(out, "entry", "must not contain control characters");
    } else if m.entry.split_whitespace().last() != Some("abai") {
        add(out, "entry", "must end with the word abai");
    }
    if m.modes.is_empty() {
        add(out, "modes", "must list at least one mode");
    } else {
        let mut seen = HashSet::new();
        if !m.modes.iter().all(|mode| seen.insert(*mode)) {
            add(out, "modes", "must not repeat a mode");
        }
    }
    if is_blank(&m.content.identity) {
        add(out, "content.identity", "is required");
    }
    if is_blank(&m.audit.path) {
        add(out, "audit.path", "is required");
    }
    if let Some(stop) = m.lifecycle.as_ref().and_then(|l| l.stop.as_ref())
        && !is_duration(&stop.graceful)
    {
        add(
            out,
            "lifecycle.stop.graceful",
            "must be a duration such as 10s",
        );
    }
    if let Some(timeout) = m.policy.as_ref().and_then(|p| p.confirm_timeout.as_ref())
        && !is_duration(timeout)
    {
        add(
            out,
            "policy.confirm_timeout",
            "must be a duration such as 60s",
        );
    }
    if m.deviations.iter().any(|d| is_blank(d)) {
        add(out, "deviations", "must be a list of non-empty strings");
    }
    if let Some(check) = &m.check
        && is_blank(&check.run)
    {
        add(out, "check.run", "is required when check is declared");
    }
    if let Some(network) = &m.network
        && is_blank(&network.doc)
    {
        add(out, "network.doc", "is required when network is declared");
    }
}

/// The checks every declaration shares. Returns where its own checks report,
/// or None when the name is invalid and the item is not checked further.
fn check_named(
    out: &mut Vec<String>,
    list: &str,
    index: usize,
    name: &str,
    doc: &str,
    seen: &mut HashSet<String>,
) -> Option<String> {
    if !is_valid_name(name) {
        let quoted = Value::String(name.to_string()).to_string();
        add(
            out,
            &format!("{list}[{index}]"),
            &format!("invalid name {quoted}"),
        );
        return None;
    }
    let at = format!("{list}.{name}");
    if !seen.insert(name.to_string()) {
        add(out, &at, "duplicate name");
    }
    if name.starts_with("abai.") {
        add(out, &at, "the abai. prefix is reserved for the library");
    }
    if is_blank(doc) {
        add(out, &at, "doc is required");
    }
    Some(at)
}

fn is_identifier(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn validate_schema(out: &mut Vec<String>, at_schema: &str, schema: &Schema) {
    let mut seen = HashSet::new();
    for (key, field) in &schema.0 {
        let at = format!("{at_schema}.{key}");
        if !is_identifier(key) {
            add(out, &at, "field names are identifiers");
        }
        if !seen.insert(key.as_str()) {
            add(out, &at, "duplicate field");
        }
        validate_field(out, &at, field);
    }
}

fn validate_field(out: &mut Vec<String>, at: &str, field: &Field) {
    if field.max == Some(0) {
        add(out, at, "max must be a positive integer");
    }
    if field.max.is_some() && !field.ty.is_sized() {
        add(out, at, "max applies to sized types only");
    }
    if field.ty == ValueType::Enum {
        match &field.values {
            Some(values) if !values.is_empty() => {
                if !distinct_non_empty(values) {
                    add(out, at, "enum values must be distinct and non-empty");
                }
            }
            _ => add(
                out,
                at,
                "enum fields need a non-empty list of string values",
            ),
        }
    } else if field.values.is_some() {
        add(out, at, "enum values belong to enum fields only");
    }
    if let Some(fields) = &field.fields {
        if field.ty != ValueType::Object {
            add(out, at, "fields belong to object fields only");
        } else {
            validate_schema(out, at, fields);
        }
    }
    if let Some(items) = &field.items {
        if field.ty != ValueType::List {
            add(out, at, "items belong to list fields only");
        } else {
            validate_field(out, &format!("{at}.item"), items);
        }
    }
}

fn validate_cell(out: &mut Vec<String>, at: &str, cell: &CellDecl) {
    if cell.max == Some(0) {
        add(out, at, "max must be a positive integer");
    }
    if cell.max.is_some() && !cell.ty.is_sized() {
        add(out, at, "max applies to sized types only");
    }
    if cell.nullable == Some(true) && !cell.ty.is_sized() {
        add(out, at, "nullable applies to sized cells only");
    }
    if cell.ty == ValueType::Enum {
        match &cell.values {
            Some(values) if !values.is_empty() => {
                if !distinct_non_empty(values) {
                    add(out, at, "enum values must be distinct and non-empty");
                }
            }
            _ => add(out, at, "enum cells need a non-empty list of string values"),
        }
    } else if cell.values.is_some() {
        add(out, at, "enum values belong to enum cells only");
    }
    let mut valid_range = None;
    if let Some(range) = &cell.range {
        match (range[0].as_f64(), range[1].as_f64()) {
            (Some(lo), Some(hi)) if lo <= hi => valid_range = Some((lo, hi)),
            _ => add(out, at, "range must be [min, max]"),
        }
        if !matches!(cell.ty, ValueType::Int | ValueType::Float) {
            add(out, at, "range applies to int and float cells only");
        }
        if cell.ty == ValueType::Int && (range[0].as_i64().is_none() || range[1].as_i64().is_none())
        {
            add(out, at, "an int cell's range is whole numbers");
        }
    }
    if cell.cadence == Some(0) {
        add(out, at, "cadence must be a positive integer");
    }
    if let Some(fields) = &cell.fields {
        if cell.ty != ValueType::Object {
            add(out, at, "fields belong to object cells only");
        } else {
            validate_schema(out, at, fields);
        }
    }
    if let Some(items) = &cell.items {
        if cell.ty != ValueType::List {
            add(out, at, "items belong to list cells only");
        } else {
            validate_field(out, &format!("{at}.item"), items);
        }
    }
    match cell.access {
        Access::Readwrite => {
            match &cell.default {
                None => add(out, at, "a readwrite cell needs a default"),
                Some(default) => {
                    if !matches_type(default, &cell.as_field()) {
                        add(out, at, "default is not of the cell's type");
                    } else {
                        if let (Some((lo, hi)), Some(value)) = (valid_range, default.as_f64())
                            && (value < lo || value > hi)
                        {
                            add(out, at, "default is outside the range");
                        }
                        let max = cell.slot_bytes();
                        if cell.ty.is_sized()
                            && let Some(n) = encoded_size(default)
                            && n > max as usize
                        {
                            add(
                                out,
                                at,
                                &format!("default is larger than max ({n} bytes over {max})"),
                            );
                        }
                    }
                }
            }
            if cell.policy == Some(Policy::Forbid) {
                add(out, at, "a knob's policy is auto or confirm");
            }
            if let Some(timeout) = &cell.timeout {
                if !is_duration(timeout) {
                    add(out, at, "timeout must be a duration such as 30s");
                }
                if !cell.ty.is_sized() {
                    add(out, at, "a delivery timeout applies to sized knobs only");
                }
            }
        }
        Access::Read => {
            if cell.policy.is_some() {
                add(out, at, "policy applies to readwrite cells only");
            }
            if cell.timeout.is_some() {
                add(out, at, "timeout applies to readwrite cells only");
            }
            if cell.default.is_some() {
                add(out, at, "default applies to readwrite cells only");
            }
        }
    }
}

fn validate_event(out: &mut Vec<String>, at: &str, event: &EventDecl) {
    validate_schema(out, &format!("{at}.payload"), &event.payload);
    if let Some(wakes) = &event.wakes
        && is_blank(wakes)
    {
        add(out, at, "wakes must be always, never or a condition");
    }
    let bytes = event.payload.slot_bytes();
    if bytes > EVENT_SLOT_BYTES && event.large != Some(true) {
        add(
            out,
            at,
            &format!("payload counts {bytes} bytes, over {EVENT_SLOT_BYTES}: declare large: true"),
        );
    }
}

fn validate_capability(out: &mut Vec<String>, at: &str, cap: &CapabilityDecl) {
    validate_schema(out, &format!("{at}.params"), &cap.params);
    validate_schema(out, &format!("{at}.result"), &cap.result);
    if let Some(timeout) = &cap.timeout
        && !is_duration(timeout)
    {
        add(out, at, "timeout must be a duration such as 30s");
    }
    if let Some(example) = &cap.example {
        match example.as_object() {
            None => add(out, at, "example must be an object of parameters"),
            Some(object) => {
                for key in object.keys() {
                    if cap.params.get(key).is_none() {
                        add(
                            out,
                            at,
                            &format!("example has an undeclared parameter {key}"),
                        );
                    }
                }
                for (key, value) in object {
                    if let Some(field) = cap.params.get(key)
                        && !matches_type(value, field)
                    {
                        add(
                            out,
                            at,
                            &format!("example parameter {key} is not of its declared type"),
                        );
                    }
                }
            }
        }
    }
}

fn validate_decision(out: &mut Vec<String>, at: &str, decision: &DecisionDecl) {
    validate_schema(out, &format!("{at}.context"), &decision.context);
    if decision.options.is_some() == decision.answer.is_some() {
        add(out, at, "declare either options or answer");
    }
    if let Some(options) = &decision.options {
        if options.is_empty() {
            add(out, at, "options must be a non-empty list of strings");
        } else {
            if !distinct_non_empty(options) {
                add(out, at, "options must be distinct and non-empty");
            }
            let ok = match decision.default.as_str() {
                Some(s) => s == "abort" || options.iter().any(|o| o == s),
                None => false,
            };
            if !ok {
                add(out, at, "default must be one of the options or abort");
            }
        }
    }
    if let Some(answer) = &decision.answer {
        validate_schema(out, &format!("{at}.answer"), answer);
        let ok = decision.default.as_str() == Some("abort")
            || decision.default.as_object().is_some_and(|object| {
                object.iter().all(|(key, value)| {
                    answer
                        .get(key)
                        .is_some_and(|field| matches_type(value, field))
                })
            });
        if !ok {
            add(out, at, "default must match the answer schema or be abort");
        }
    }
    if !is_duration(&decision.timeout) {
        add(out, at, "timeout is required (a duration such as 30s)");
    }
}

fn validate_turn(out: &mut Vec<String>, at: &str, turn: &TurnDecl, manifest: &Manifest) {
    if !is_duration(&turn.timeout) {
        add(out, at, "timeout is required (a duration such as 30s)");
    }
    if manifest.decision(&turn.name).is_some() {
        add(out, at, "is also a decision");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::testdata::sample;
    use crate::manifest::{CheckDecl, Mode, NetworkDecl};
    use serde_json::json;

    fn has(manifest: &Manifest, violation: &str) {
        let found = validate(manifest);
        assert!(
            found.iter().any(|v| v == violation),
            "missing {violation:?} in {found:?}"
        );
    }

    #[test]
    fn the_sample_validates() {
        assert_eq!(validate(&sample()), Vec::<String>::new());
    }

    #[test]
    fn top_level() {
        let mut m = sample();
        m.abaigrammar = "0.2".into();
        m.name = "  ".into();
        m.entry = String::new();
        m.modes = vec![];
        m.content.identity = String::new();
        m.audit.path = String::new();
        m.lifecycle
            .as_mut()
            .unwrap()
            .stop
            .as_mut()
            .unwrap()
            .graceful = "10".into();
        m.policy.as_mut().unwrap().confirm_timeout = Some("soon".into());
        m.deviations = vec!["ok".into(), " ".into(), "".into()];
        m.check = Some(CheckDecl {
            run: " ".into(),
            overhead: None,
        });
        m.network = Some(NetworkDecl {
            required: None,
            doc: String::new(),
        });
        assert_eq!(
            validate(&m),
            vec![
                "abaigrammar: must be \"0.1\"",
                "name: is required",
                "entry: is required",
                "modes: must list at least one mode",
                "content.identity: is required",
                "audit.path: is required",
                "lifecycle.stop.graceful: must be a duration such as 10s",
                "policy.confirm_timeout: must be a duration such as 60s",
                "deviations: must be a list of non-empty strings",
                "check.run: is required when check is declared",
                "network.doc: is required when network is declared",
            ]
        );
    }

    #[test]
    fn entry_and_modes() {
        let mut m = sample();
        m.entry = "./bin/jobs abaix".into();
        m.modes = vec![Mode::Turns, Mode::Sidecar, Mode::Turns, Mode::Sidecar];
        assert_eq!(
            validate(&m),
            vec![
                "entry: must end with the word abai",
                "modes: must not repeat a mode",
            ]
        );
    }

    #[test]
    fn names() {
        let mut m = sample();
        m.cells[0].name = "Queue".into();
        m.cells[0].doc = String::new();
        m.cells[1].name = "abai.knob".into();
        m.events.push(m.events[0].clone());
        m.events[1].doc = " ".into();
        assert_eq!(
            validate(&m),
            vec![
                "cells[0]: invalid name \"Queue\"",
                "cells.abai.knob: the abai. prefix is reserved for the library",
                "events.job.failed: duplicate name",
                "events.job.failed: doc is required",
            ]
        );
    }

    #[test]
    fn a_name_may_repeat_across_lists() {
        let mut m = sample();
        m.turns[0].name = "job.failed".into();
        assert_eq!(validate(&m), Vec::<String>::new());
    }

    #[test]
    fn schemas() {
        let mut m = sample();
        let params: Schema = serde_json::from_value(json!({
            "job_id": "string",
            "1bad": "int",
            "n": {"type": "int", "max": 0},
            "s": {"type": "string", "max": 0},
            "e": "enum",
            "f": {"type": "int", "enum": ["a"]},
            "o": {"type": "int", "fields": {"x": "int"}},
            "p": {"type": "object", "fields": {"bad-key": "int"}},
            "l": {"type": "int", "items": "int"},
            "m": {"type": "list", "items": {"type": "enum", "enum": []}}
        }))
        .unwrap();
        m.capabilities[0].params = params;
        m.capabilities[0]
            .params
            .0
            .push(("job_id".into(), Field::string()));
        let at = "capabilities.job.retry.params";
        assert_eq!(
            validate(&m),
            vec![
                format!("{at}.1bad: field names are identifiers"),
                format!("{at}.n: max must be a positive integer"),
                format!("{at}.n: max applies to sized types only"),
                format!("{at}.s: max must be a positive integer"),
                format!("{at}.e: enum fields need a non-empty list of string values"),
                format!("{at}.f: enum values belong to enum fields only"),
                format!("{at}.o: fields belong to object fields only"),
                format!("{at}.p.bad-key: field names are identifiers"),
                format!("{at}.l: items belong to list fields only"),
                format!("{at}.m.item: enum fields need a non-empty list of string values"),
                format!("{at}.job_id: duplicate field"),
            ]
        );
    }

    #[test]
    fn cell_shapes() {
        let mut m = sample();
        let c = &mut m.cells[0];
        c.max = Some(0);
        c.values = Some(vec!["a".into()]);
        c.range = Some([serde_json::Number::from(5), serde_json::Number::from(1)]);
        c.cadence = Some(0);
        c.fields = Some(Schema::new().field("x", Field::int()));
        c.items = Some(Box::new(Field::int()));
        let at = "cells.queue.depth";
        assert_eq!(
            validate(&m),
            vec![
                format!("{at}: max must be a positive integer"),
                format!("{at}: max applies to sized types only"),
                format!("{at}: enum values belong to enum cells only"),
                format!("{at}: range must be [min, max]"),
                format!("{at}: cadence must be a positive integer"),
                format!("{at}: fields belong to object cells only"),
                format!("{at}: items belong to list cells only"),
            ]
        );
    }

    #[test]
    fn cell_types() {
        let mut m = sample();
        m.cells[0].ty = ValueType::Enum;
        m.cells[1].ty = ValueType::String;
        m.cells[1].default = Some(json!("four"));
        has(
            &m,
            "cells.queue.depth: enum cells need a non-empty list of string values",
        );
        has(
            &m,
            "cells.worker.count: range applies to int and float cells only",
        );

        let mut m = sample();
        m.cells[0].ty = ValueType::Object;
        m.cells[0].fields = Some(Schema::new().field("x", Field::int().max(3)));
        m.cells[1].ty = ValueType::List;
        m.cells[1].range = None;
        m.cells[1].default = Some(json!([]));
        m.cells[1].items = Some(Box::new(Field::int().max(3)));
        assert_eq!(
            validate(&m),
            vec![
                "cells.queue.depth.x: max applies to sized types only",
                "cells.worker.count.item: max applies to sized types only",
            ]
        );
    }

    #[test]
    fn knobs() {
        let mut m = sample();
        m.cells[1].default = None;
        has(&m, "cells.worker.count: a readwrite cell needs a default");

        let mut m = sample();
        m.cells[1].default = Some(json!("four"));
        has(&m, "cells.worker.count: default is not of the cell's type");

        let mut m = sample();
        m.cells[1].default = Some(json!(65));
        m.cells[1].policy = Some(Policy::Forbid);
        m.cells[1].timeout = Some("later".into());
        assert_eq!(
            validate(&m),
            vec![
                "cells.worker.count: default is outside the range",
                "cells.worker.count: a knob's policy is auto or confirm",
                "cells.worker.count: timeout must be a duration such as 30s",
                "cells.worker.count: a delivery timeout applies to sized knobs only",
            ]
        );

        let mut m = sample();
        m.cells[1].ty = ValueType::String;
        m.cells[1].range = None;
        m.cells[1].default = Some(json!("x"));
        m.cells[1].timeout = Some("5s".into());
        assert_eq!(validate(&m), Vec::<String>::new());
    }

    #[test]
    fn read_cells() {
        let mut m = sample();
        m.cells[0].policy = Some(Policy::Auto);
        m.cells[0].timeout = Some("5s".into());
        m.cells[0].default = Some(json!(0));
        assert_eq!(
            validate(&m),
            vec![
                "cells.queue.depth: policy applies to readwrite cells only",
                "cells.queue.depth: timeout applies to readwrite cells only",
                "cells.queue.depth: default applies to readwrite cells only",
            ]
        );
    }

    #[test]
    fn events() {
        let mut m = sample();
        m.events[0].wakes = Some(" ".into());
        m.events[0]
            .payload
            .0
            .push(("blob".into(), Field::object(Schema::new()).max(4000)));
        m.events[0]
            .payload
            .0
            .push(("bad-key".into(), Field::string()));
        assert_eq!(
            validate(&m),
            vec![
                "events.job.failed.payload.bad-key: field names are identifiers",
                "events.job.failed: wakes must be always, never or a condition",
                "events.job.failed: payload counts 4832 bytes, over 4096: declare large: true",
            ]
        );
        m.events[0].large = Some(true);
        m.events[0].wakes = None;
        m.events[0].payload.0.pop();
        assert_eq!(validate(&m), Vec::<String>::new());
    }

    #[test]
    fn capabilities() {
        let mut m = sample();
        m.capabilities[0].timeout = Some("5".into());
        m.capabilities[0].example = Some(json!({"job_id": "j", "force": true}));
        m.capabilities[0].result.0.push(("2".into(), Field::bool()));
        assert_eq!(
            validate(&m),
            vec![
                "capabilities.job.retry.result.2: field names are identifiers",
                "capabilities.job.retry: timeout must be a duration such as 30s",
                "capabilities.job.retry: example has an undeclared parameter force",
            ]
        );
        m.capabilities[0].timeout = None;
        m.capabilities[0].example = Some(json!(["j"]));
        assert_eq!(
            validate(&m),
            vec![
                "capabilities.job.retry.result.2: field names are identifiers",
                "capabilities.job.retry: example must be an object of parameters",
            ]
        );
    }

    #[test]
    fn decisions() {
        let mut m = sample();
        m.decisions[0].answer = Some(Schema::new().field("bad-key", Field::int()));
        m.decisions[0].default = json!("never");
        m.decisions[0].timeout = "".into();
        m.decisions[0]
            .context
            .0
            .push(("depth".into(), Field::int()));
        let at = "decisions.on_backlog";
        assert_eq!(
            validate(&m),
            vec![
                format!("{at}.context.depth: duplicate field"),
                format!("{at}: declare either options or answer"),
                format!("{at}: default must be one of the options or abort"),
                format!("{at}.answer.bad-key: field names are identifiers"),
                format!("{at}: default must match the answer schema or be abort"),
                format!("{at}: timeout is required (a duration such as 30s)"),
            ]
        );

        let mut m = sample();
        m.decisions[0].options = None;
        has(&m, "decisions.on_backlog: declare either options or answer");

        let mut m = sample();
        m.decisions[0].options = Some(vec![]);
        has(
            &m,
            "decisions.on_backlog: options must be a non-empty list of strings",
        );

        let mut m = sample();
        m.decisions[0].default = json!("abort");
        assert_eq!(validate(&m), Vec::<String>::new());
        m.decisions[0].default = json!(1);
        has(
            &m,
            "decisions.on_backlog: default must be one of the options or abort",
        );
    }

    #[test]
    fn turns() {
        let mut m = sample();
        m.turns[0].timeout = "30 s".into();
        m.turns[0].name = "on_backlog".into();
        assert_eq!(
            validate(&m),
            vec![
                "turns.on_backlog: timeout is required (a duration such as 30s)",
                "turns.on_backlog: is also a decision",
            ]
        );
    }

    #[test]
    fn program_names_entries_and_blank_paths() {
        let mut m = sample();
        m.name = "-jobs".into();
        m.entry = "./bin/jobs\u{7}abai".into();
        m.content.identity = "  ".into();
        m.audit.path = " ".into();
        assert_eq!(
            validate(&m),
            vec![
                "name: must be letters, digits, dots, underscores and hyphens",
                "entry: must not contain control characters",
                "content.identity: is required",
                "audit.path: is required",
            ]
        );
        for good in ["jobs", "Jobs-2", "a.b_c", "9x"] {
            m = sample();
            m.name = good.into();
            assert_eq!(validate(&m), Vec::<String>::new(), "{good}");
        }
        for bad in ["a b", "a/b", ".a", "_a", "é"] {
            m = sample();
            m.name = bad.into();
            has(
                &m,
                "name: must be letters, digits, dots, underscores and hyphens",
            );
        }
    }

    #[test]
    fn scalar_cells_are_not_nullable() {
        let mut m = sample();
        m.cells[0].nullable = Some(true);
        assert_eq!(
            validate(&m),
            vec!["cells.queue.depth: nullable applies to sized cells only"]
        );
        m.cells[0].ty = ValueType::String;
        assert_eq!(validate(&m), Vec::<String>::new());
    }

    #[test]
    fn enum_values_are_distinct_and_non_empty() {
        let mut m = sample();
        m.cells[0].ty = ValueType::Enum;
        m.cells[0].values = Some(vec!["a".into(), "a".into()]);
        m.cells[1] = m.cells[0].clone();
        m.cells[1].name = "other".into();
        m.cells[1].values = Some(vec!["a".into(), String::new()]);
        m.capabilities[0].params = Schema::new()
            .field("job_id", Field::string())
            .field("e", Field::enumeration(["x", "x"]));
        assert_eq!(
            validate(&m),
            vec![
                "cells.queue.depth: enum values must be distinct and non-empty",
                "cells.other: enum values must be distinct and non-empty",
                "capabilities.job.retry.params.e: enum values must be distinct and non-empty",
            ]
        );
    }

    #[test]
    fn an_int_range_is_whole_numbers() {
        let mut m = sample();
        m.cells[1].range = Some([
            serde_json::Number::from_f64(1.5).unwrap(),
            serde_json::Number::from(64),
        ]);
        assert_eq!(
            validate(&m),
            vec!["cells.worker.count: an int cell's range is whole numbers"]
        );
        m.cells[1].ty = ValueType::Float;
        m.cells[1].default = Some(json!(4.0));
        assert_eq!(validate(&m), Vec::<String>::new());
    }

    #[test]
    fn a_sized_default_fits_its_max() {
        let mut m = sample();
        m.cells[1].ty = ValueType::String;
        m.cells[1].range = None;
        m.cells[1].max = Some(3);
        m.cells[1].default = Some(json!("héllo"));
        assert_eq!(
            validate(&m),
            vec!["cells.worker.count: default is larger than max (6 bytes over 3)"]
        );
        m.cells[1].default = Some(json!("abc"));
        assert_eq!(validate(&m), Vec::<String>::new());

        m.cells[1].ty = ValueType::List;
        m.cells[1].max = Some(4);
        m.cells[1].default = Some(json!([1, 2]));
        assert_eq!(
            validate(&m),
            vec!["cells.worker.count: default is larger than max (5 bytes over 4)"]
        );
        m.cells[1].max = None;
        m.cells[1].ty = ValueType::String;
        m.cells[1].default = Some(json!("x".repeat(257)));
        has(
            &m,
            "cells.worker.count: default is larger than max (257 bytes over 256)",
        );
    }

    #[test]
    fn example_parameters_have_their_types() {
        let mut m = sample();
        m.capabilities[0].example = Some(json!({"job_id": 7}));
        assert_eq!(
            validate(&m),
            vec!["capabilities.job.retry: example parameter job_id is not of its declared type"]
        );
    }

    #[test]
    fn options_are_distinct_and_non_empty() {
        let mut m = sample();
        m.decisions[0].options = Some(vec!["wait".into(), "wait".into()]);
        assert_eq!(
            validate(&m),
            vec!["decisions.on_backlog: options must be distinct and non-empty"]
        );
        m.decisions[0].options = Some(vec!["wait".into(), String::new()]);
        has(
            &m,
            "decisions.on_backlog: options must be distinct and non-empty",
        );
    }

    #[test]
    fn an_answer_default_matches_the_schema() {
        let mut m = sample();
        m.decisions[0].options = None;
        m.decisions[0].answer = Some(
            Schema::new()
                .field("workers", Field::int())
                .field("note", Field::string()),
        );
        let bad = "decisions.on_backlog: default must match the answer schema or be abort";
        for good in [json!("abort"), json!({}), json!({"workers": 3})] {
            m.decisions[0].default = good.clone();
            assert_eq!(validate(&m), Vec::<String>::new(), "{good}");
        }
        for wrong in [
            json!("wait"),
            json!(3),
            json!({"workers": "3"}),
            json!({"other": 1}),
        ] {
            m.decisions[0].default = wrong.clone();
            assert_eq!(validate(&m), vec![bad], "{wrong}");
        }
    }
}
