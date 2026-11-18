//! The subject of `check`'s tests: a small abaigram that links only the
//! stub, configured by environment variables read at startup, so one
//! binary serves every test.
//!
//! - `SUBJECT_NAME`: the program's name, default `check-subject`.
//! - `SUBJECT_ENTRY`: the manifest's `entry`.
//! - `SUBJECT_MODES`: the declared modes, a comma list, default
//!   `turns,thread,sidecar`.
//! - `SUBJECT_RUN`: the manifest's `check.run`; unset declares no `check`.
//! - `SUBJECT_OVERHEAD`: the manifest's `check.overhead`.
//! - `SUBJECT_LEVEL`: 1 to 4, default 4: how much it declares and does.

use std::process::ExitCode;

use abai_stub::app::Abaigram;
use abai_stub::declare::{Capability, Cell, Decision, Declarations, Event};
use abai_stub::entry::run_entry;
use abai_stub::manifest::{Field, Mode, Schema};
use serde_json::json;

/// An environment variable, when it is set and not empty.
fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn declarations(level: u8) -> Declarations {
    let name = var("SUBJECT_NAME").unwrap_or_else(|| "check-subject".to_string());
    let modes: Vec<Mode> = var("SUBJECT_MODES")
        .unwrap_or_else(|| "turns,thread,sidecar".to_string())
        .split(',')
        .filter_map(|mode| Mode::parse(mode.trim()))
        .collect();
    let mut declared = Declarations::new(&name, modes).audit_path("audit.jsonl");
    if let Some(entry) = var("SUBJECT_ENTRY") {
        declared = declared.entry(&entry);
    }
    if let Some(run) = var("SUBJECT_RUN") {
        declared = declared.check_run(&run);
        if let Some(overhead) = var("SUBJECT_OVERHEAD") {
            declared = declared.check_overhead(&overhead);
        }
    }
    if level >= 2 {
        declared = declared
            .cell(Cell::int("count", "How many ticks have run."))
            .event(
                Event::new("tick", "One tick ran.").payload(Schema::new().field("n", Field::int())),
            );
    }
    if level >= 3 {
        declared = declared
            .cell(Cell::int("step", "How much each tick adds.").knob(1))
            .capability(
                Capability::new("echo", "Say the text back.")
                    .params(Schema::new().field("text", Field::string()))
                    .result(Schema::new().field("text", Field::string()))
                    .example(json!({"text": "hello"}))
                    .handler(|params| {
                        let text = params.get::<serde_json::Value>()?["text"]
                            .as_str()
                            .ok_or("text is not a string")?
                            .to_string();
                        Ok(json!({ "text": text }))
                    }),
            )
            .capability(
                Capability::new("bare", "Does nothing; it has no example.")
                    .handler(|_| Ok(json!({}))),
            );
    }
    if level >= 4 {
        declared = declared.decision(Decision::options(
            "go_on",
            ["yes", "no"],
            "no",
            "5s",
            "Asked once, after the ticks.",
        ));
    }
    declared
}

fn main() -> ExitCode {
    let level = var("SUBJECT_LEVEL")
        .and_then(|level| level.parse::<u8>().ok())
        .unwrap_or(4)
        .clamp(1, 4);
    let app = match Abaigram::new(&declarations(level)) {
        Ok(app) => app,
        Err(error) => {
            eprintln!("check-subject: {error}");
            return ExitCode::from(2);
        }
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(code) = run_entry(&app, &args) {
        return ExitCode::from(code.clamp(0, 255) as u8);
    }

    let count = if level >= 2 {
        app.cell::<i64>("count").ok()
    } else {
        None
    };
    let tick = if level >= 2 {
        app.event("tick").ok()
    } else {
        None
    };
    let step = if level >= 3 {
        app.knob::<i64>("step").ok()
    } else {
        None
    };
    let mut total = 0;
    for n in 1..=3 {
        total += step.as_ref().map_or(1, |step| step.get());
        if let Some(count) = &count {
            count.set(total);
        }
        if let Some(tick) = &tick {
            tick.emit(|payload| payload.int("n", n));
        }
        app.safepoint();
    }
    let answer = if level >= 4 {
        match app.decision("go_on") {
            Ok(go_on) => go_on.ask(&json!({})).as_str().to_string(),
            Err(error) => {
                eprintln!("check-subject: {error}");
                return ExitCode::from(2);
            }
        }
    } else {
        "not asked".to_string()
    };
    println!("check-subject: count {total}, go on: {answer}");
    if std::env::var("SUBJECT_EXIT").as_deref() == Ok("call") {
        // last words with no line break, then an exit by a call: the
        // exercise report must still come out, on a line of its own
        eprint!("check-subject: leaving");
        std::process::exit(0);
    }
    ExitCode::SUCCESS
}
