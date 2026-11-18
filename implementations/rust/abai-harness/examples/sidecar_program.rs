//! A small abaigram in sidecar mode, for the two-process tests: it links
//! only the stub, and is told what to do by its argument and its stdin.

use std::io::BufRead;

use abai_stub::app::Abaigram;
use abai_stub::declare::{Capability, Cell, Decision, Declarations, Event};
use abai_stub::entry::run_entry;
use abai_stub::manifest::{Field, Mode, Schema};
use serde_json::json;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = std::env::var("ABAI_TEST_ROOT").unwrap_or_else(|_| ".".to_string());
    let declarations = Declarations::new("sideprog", [Mode::Sidecar])
        .root(&root)
        .audit_path("audit.jsonl")
        .cell(Cell::int("count", "How far the count has got."))
        .cell(Cell::int("step", "How much a tick adds.").knob(1))
        .event(Event::new("ready", "The program has started its loop.").wakes_always())
        .stop_graceful("2s")
        .on_stop(|| {
            println!("stopping");
            std::process::exit(0);
        })
        .capability(
            Capability::new("peek", "Say which thread serves an immediate call.")
                .immediate()
                .handler(|_| Ok(json!({"thread": std::thread::current().name().unwrap_or("")}))),
        )
        .decision(
            Decision::options("on_limit", ["wrap", "stop"], "stop", "5s", "At the limit.")
                .context(Schema::new().field("count", Field::int())),
        );
    let app = match Abaigram::new(&declarations) {
        Ok(app) => app,
        Err(error) => {
            eprintln!("{error:?}");
            std::process::exit(3);
        }
    };
    if let Some(code) = run_entry(&app, &args) {
        std::process::exit(code);
    }
    let count = app.cell::<i64>("count").expect("a declared cell");
    let step = app.knob::<i64>("step").expect("a declared knob");
    let on_limit = app.decision("on_limit").expect("a declared decision");
    let decide = || {
        let answer = on_limit.ask(&json!({"count": 7}));
        println!(
            "answer {} agent={} step {}",
            answer.as_str(),
            answer.by_agent(),
            step.get()
        );
    };
    match args.first().map(String::as_str) {
        // the program asks for its agent itself
        Some("decide") => {
            if !app.attach() {
                println!("no harness: {}", app.attach_error().unwrap_or_default());
            }
            count.set(7);
            decide();
        }
        // the program runs as itself until a harness comes from outside
        Some("wait") => {
            count.set(7);
            println!("ready {}", std::process::id());
            for line in std::io::stdin().lock().lines() {
                match line.as_deref() {
                    Ok("decide") => decide(),
                    Ok("attached") => println!("attached {}", app.attached()),
                    _ => break,
                }
            }
        }
        // a short run with output on both streams and an exit code of
        // its own, as a launcher sees it
        Some("lines") => {
            println!("line one");
            eprintln!("a warning");
            count.set(7);
            decide();
            println!("line two");
            std::process::exit(7);
        }
        // a program that asks on its terminal, with no newline
        Some("prompt") => {
            use std::io::Write;
            print!("ready? ");
            std::io::stdout().flush().expect("stdout");
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).expect("stdin");
            println!("got {}", line.trim());
        }
        // a program that runs until it is stopped
        Some("loop") => {
            println!("started {}", std::process::id());
            app.event("ready").expect("a declared event").emit(|_| {});
            loop {
                app.safepoint();
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        _ => std::process::exit(2),
    }
}
