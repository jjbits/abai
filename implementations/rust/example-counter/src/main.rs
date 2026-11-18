//! A small abaigram that declares one of everything.

use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use abai_stub::app::Abaigram;
use abai_stub::declare::{Capability, Cell, Decision, Declarations, Event, Turn};
use abai_stub::entry::run_entry;
use abai_stub::manifest::{Field, Mode, Pause, Schema};
use abai_stub::region::cells::Cell as CountCell;
use serde_json::json;

/// What the program's handlers share with its loop.
struct State {
    count: AtomicI64,
    stop: AtomicBool,
    /// The `count` cell, once the app is made.
    count_cell: OnceLock<CountCell<i64>>,
    label: Mutex<String>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            count: AtomicI64::new(0),
            stop: AtomicBool::new(false),
            count_cell: OnceLock::new(),
            label: Mutex::new("count".to_string()),
        }
    }
}

fn declarations(state: &Arc<State>) -> Declarations {
    let (on_reset, on_stop, on_label) = (state.clone(), state.clone(), state.clone());
    Declarations::new(
        "example-counter",
        [Mode::Turns, Mode::Thread, Mode::Sidecar],
    )
    .entry("cargo run -q -p example-counter -- abai")
    .use_content("abai/use.md")
    .pause(Pause::Cooperative)
    .stop_graceful("5s")
    .on_stop(move || on_stop.stop.store(true, Ordering::SeqCst))
    .cell(Cell::int("count", "How far the counter has got."))
    .cell(
        Cell::int("step", "How much each tick adds.")
            .knob(1)
            .range_int(1, 100)
            .cadence(1000),
    )
    .cell(
        Cell::string("label", "The word printed beside the count.")
            .knob("count")
            .max(64)
            .on_change(move |value| {
                let label = value.get::<String>()?;
                if label.is_empty() {
                    return Err("the label cannot be empty".to_string());
                }
                *on_label.label.lock().map_err(|e| e.to_string())? = label;
                Ok(())
            }),
    )
    .event(
        Event::new("milestone", "The count passed a multiple of one hundred.")
            .payload(
                Schema::new()
                    .field("count", Field::int())
                    .field("label", Field::string().max(64)),
            )
            .wakes_always(),
    )
    .capability(
        Capability::new("reset", "Set the count back to a value.")
            .params(Schema::new().field("to", Field::int()))
            .result(Schema::new().field("was", Field::int()))
            .mutate()
            .example(json!({"to": 0}))
            .handler(move |params| {
                let to = params.get::<serde_json::Value>()?["to"]
                    .as_i64()
                    .ok_or("to is not a whole number")?;
                let was = on_reset.count.swap(to, Ordering::SeqCst);
                if let Some(cell) = on_reset.count_cell.get() {
                    cell.set(to);
                }
                Ok(json!({"was": was}))
            }),
    )
    .decision(
        Decision::options(
            "on_limit",
            ["wrap", "stop"],
            "stop",
            "5s",
            "Asked when the count reaches its limit.",
        )
        .context(Schema::new().field("count", Field::int())),
    )
    .turn(Turn::new(
        "every_thousand",
        "30s",
        "After each thousand ticks.",
    ))
}

/// The value after a flag such as `--ticks`, when it is a number.
fn flag(args: &[String], name: &str) -> Option<u64> {
    let at = args.iter().position(|arg| arg == name)?;
    args.get(at + 1)?.parse().ok()
}

fn main() -> ExitCode {
    let state = Arc::new(State::default());
    let registered = Abaigram::new(&declarations(&state));
    let app = match registered {
        Ok(app) => app.with_harness(abai_harness::embedded()),
        Err(error) => {
            eprintln!("example-counter: {error}");
            return ExitCode::from(2);
        }
    };
    if let Ok(cell) = app.cell::<i64>("count") {
        let _ = state.count_cell.set(cell);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(code) = run_entry(&app, &args) {
        return ExitCode::from(code.clamp(0, 255) as u8);
    }

    // the program's own work: count, and let the agent in where it is declared
    let ticks = flag(&args, "--ticks").unwrap_or(3000);
    let pause = std::time::Duration::from_millis(flag(&args, "--sleep-ms").unwrap_or(0));
    let limit = flag(&args, "--limit").unwrap_or(2500) as i64;
    if args.iter().any(|arg| arg == "--attach") && !app.attach() {
        eprintln!(
            "example-counter: no agent: {}",
            app.attach_error().unwrap_or_default()
        );
    }
    let handles = (|| {
        Ok::<_, abai_stub::region::cells::HandleError>((
            app.cell::<i64>("count")?,
            app.knob::<i64>("step")?,
            app.event("milestone")?,
            app.decision("on_limit")?,
            app.turn("every_thousand")?,
        ))
    })();
    let (count, step, milestone, on_limit, every_thousand) = match handles {
        Ok(handles) => handles,
        Err(error) => {
            eprintln!("example-counter: {error}");
            return ExitCode::from(2);
        }
    };

    for tick in 1..=ticks {
        if state.stop.load(Ordering::SeqCst) {
            println!("example-counter: stopped at tick {tick}");
            break;
        }
        let before = state.count.load(Ordering::SeqCst);
        let now = before + step.get();
        state.count.store(now, Ordering::SeqCst);
        count.set(now);
        if now / 100 != before / 100 {
            let label = state.label.lock().map(|l| l.clone()).unwrap_or_default();
            milestone.emit(|payload| {
                payload.int("count", now);
                payload.text("label", &label);
            });
        }
        if now >= limit {
            let answer = on_limit.ask(&json!({"count": now}));
            if answer.as_str() == "wrap" {
                state.count.store(0, Ordering::SeqCst);
                count.set(0);
            } else {
                println!("example-counter: the count reached {now} and stops");
                break;
            }
        }
        if tick % 1000 == 0 {
            every_thousand.give();
        }
        app.safepoint();
        if !pause.is_zero() {
            std::thread::sleep(pause);
        }
    }
    println!(
        "example-counter: count {}",
        state.count.load(Ordering::SeqCst)
    );
    ExitCode::SUCCESS
}
