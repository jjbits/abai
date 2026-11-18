//! The cost of each channel operation on the program's thread (contract
//! sections 11.1, 11.2 and 11.6).
//!
//! `no_channel_operation_allocates` proves, pass or fail, that no row
//! allocates, attached or not. `timing` measures every row and writes the
//! table to `.design/cost-11.md`; it is run on its own, in release:
//!
//! `cargo test --release -p abai-stub --test cost -- --ignored timing`
//!
//! That no row locks, blocks or makes a system call beyond the one wake is
//! shown by the code (every step is a load, a store or a compare-and-swap
//! on the region's words) and by review, not by this file.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell as Counter;
use std::hint::black_box;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use abai_stub::app::Abaigram;
use abai_stub::declare::{Cell, Declarations, Event};
use abai_stub::manifest::{Field, Mode, Schema};
use abai_stub::region::ring::Reader;
use abai_stub::region::{Wake, header};

thread_local! {
    static ALLOCATIONS: Counter<u64> = const { Counter::new(0) };
}

/// Counts the allocations each thread makes.
struct Counting;

// SAFETY: every call goes straight to the system allocator; the count
// beside it is a thread-local with no destructor.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.with(|count| count.set(count.get() + 1));
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        ALLOCATIONS.with(|count| count.set(count.get() + 1));
        unsafe { System.realloc(pointer, layout, size) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn allocations() -> u64 {
    ALLOCATIONS.with(Counter::get)
}

#[derive(serde::Serialize)]
struct Point {
    x: i64,
    y: f64,
    tag: &'static str,
}

fn app() -> Abaigram {
    let declarations = Declarations::new("cost", [Mode::Thread])
        .cell(Cell::int("count", "A count."))
        .cell(Cell::float("ratio", "A ratio."))
        .cell(Cell::bool("busy", "Busy or not."))
        .cell(Cell::enumeration(
            "phase",
            ["idle", "running"],
            "The phase.",
        ))
        .cell(Cell::string("label", "A label.").max(64))
        .cell(Cell::object(
            "point",
            Schema::new()
                .field("x", Field::int())
                .field("y", Field::float())
                .field("tag", Field::string()),
            "A point.",
        ))
        .cell(Cell::int("step", "The step.").knob(1))
        .cell(Cell::enumeration("speed", ["slow", "fast"], "The speed.").knob("slow"))
        .event(
            Event::new("quiet", "An event that does not wake.").payload(
                Schema::new()
                    .field("n", Field::int())
                    .field("text", Field::string().max(64))
                    .field("point", Field::object(Schema::new()).max(128)),
            ),
        )
        .event(
            Event::new("loud", "An event that wakes.")
                .payload(Schema::new().field("n", Field::int()))
                .wakes_always(),
        );
    let none = |_: &str| None;
    Abaigram::with_env(&declarations, &none).unwrap()
}

struct Count(Arc<AtomicU64>);

impl Wake for Count {
    fn wake(&self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}

/// One named row of the cost tables, as a closure to call over and over.
type Row<'a> = (&'static str, Box<dyn FnMut() + 'a>);

fn rows(app: &Abaigram) -> Vec<Row<'_>> {
    let count = app.cell::<i64>("count").unwrap();
    let ratio = app.cell::<f64>("ratio").unwrap();
    let busy = app.cell::<bool>("busy").unwrap();
    let phase = app.enum_cell("phase").unwrap();
    let label = app.text_cell("label").unwrap();
    let point = app.json_cell("point").unwrap();
    let step = app.knob::<i64>("step").unwrap();
    let step_reset = step.clone();
    let speed = app.enum_knob("speed").unwrap();
    let quiet = app.event("quiet").unwrap();
    let quiet_full = quiet.clone();
    let quiet_over = quiet.clone();
    let point_over = point.clone();
    let loud = app.event("loud").unwrap();
    let region = app.region().clone();
    let mut n = 0i64;
    vec![
        (
            "write a scalar cell (int)",
            Box::new(move || {
                n += 1;
                count.set(black_box(n));
            }),
        ),
        (
            "write a scalar cell (float)",
            Box::new(move || ratio.set(black_box(0.5))),
        ),
        (
            "write a scalar cell (bool)",
            Box::new(move || busy.set(black_box(true))),
        ),
        (
            "write a scalar cell (enum)",
            Box::new(move || {
                black_box(phase.set(black_box("running")));
            }),
        ),
        (
            "write a sized cell (string, 24 bytes)",
            Box::new(move || label.set(black_box("twenty-four bytes of text"))),
        ),
        (
            "write a sized cell (object too large for it)",
            Box::new(move || {
                black_box(point_over.set(black_box(&[7i64; 600][..])));
            }),
        ),
        (
            "emit an event (object too large for its field)",
            Box::new(move || quiet_over.emit(|p| p.json("point", black_box(&[7i64; 600][..])))),
        ),
        (
            "write a sized cell (object)",
            Box::new(move || {
                black_box(point.set(&Point {
                    x: 3,
                    y: 0.25,
                    tag: "here",
                }));
            }),
        ),
        (
            "read a scalar knob",
            Box::new(move || {
                black_box(step.get());
            }),
        ),
        (
            "read a scalar knob (enum)",
            Box::new(move || {
                black_box(speed.get());
            }),
        ),
        (
            "reset a scalar knob",
            Box::new(move || step_reset.reset(black_box(1))),
        ),
        (
            "emit an event (one int)",
            Box::new(move || quiet.emit(|p| p.int("n", black_box(7)))),
        ),
        (
            "emit an event (int, string, object)",
            Box::new(move || {
                quiet_full.emit(|p| {
                    p.int("n", 7);
                    p.text("text", black_box("twenty-four bytes of text"));
                    p.json(
                        "point",
                        &Point {
                            x: 3,
                            y: 0.25,
                            tag: "here",
                        },
                    );
                })
            }),
        ),
        (
            "emit an event that wakes a parked harness",
            Box::new(move || {
                region[header::PARKED].store(1, Ordering::Relaxed);
                loud.emit(|p| p.int("n", 7));
            }),
        ),
    ]
}

#[test]
fn no_channel_operation_allocates() {
    let app = app();
    let wakes = Arc::new(AtomicU64::new(0));
    app.region().set_waker(Box::new(Count(wakes.clone())));

    // the counter itself works
    let before = allocations();
    black_box(Box::new(black_box(1u64)));
    assert_eq!(allocations() - before, 1);

    for attached in [false, true] {
        app.region()[header::ATTACHED].store(u64::from(attached), Ordering::SeqCst);
        for (name, mut row) in rows(&app) {
            let before = allocations();
            for _ in 0..1000 {
                row();
            }
            let made = allocations() - before;
            assert_eq!(made, 0, "{name} allocated (attached: {attached})");
        }
    }
    // only the attached pass emitted, and each waking emit woke once
    assert_eq!(wakes.load(Ordering::Relaxed), 1000);
    assert_eq!(app.region()[header::MISUSE].load(Ordering::Relaxed), 0);
}

#[test]
fn what_was_written_is_what_the_harness_reads() {
    // the rows above are only worth measuring if they do their work
    let app = app();
    app.region()[header::ATTACHED].store(1, Ordering::SeqCst);
    let mut reader = Reader::new(app.region());
    for (_, mut row) in rows(&app) {
        row();
    }
    let mut events = 0;
    while let Some(item) = reader.next(Instant::now()) {
        assert!(matches!(item, abai_stub::region::ring::Item::Event { .. }));
        events += 1;
    }
    assert_eq!(events, 4);
    let layout = &app.region().layout;
    let read = |name: &str| {
        let (index, _) = layout.cell(name).unwrap();
        abai_stub::region::cells::read(app.region(), index)
            .unwrap()
            .value
    };
    assert_eq!(read("count"), 1);
    assert_eq!(read("phase"), "running");
    assert_eq!(read("label"), "twenty-four bytes of text");
    assert_eq!(read("point")["tag"], "here");
}

#[test]
#[ignore = "a measurement; run in release, see the top of this file"]
fn timing() {
    const ROUNDS: u32 = 2_000_000;
    let app = app();
    app.region()
        .set_waker(Box::new(Count(Arc::new(AtomicU64::new(0)))));

    let mut table = String::from(
        "# Cost of the channel operations on the program's thread\n\n\
         Written by `abai-stub/tests/cost.rs` (`timing`), release build, one thread,\n\
         the mean of two million calls of each row. The wake is a counter, not a\n\
         system call. Sections 11.1 and 11.2 of the contract name the rows.\n\n\
         | Operation | Detached | Attached |\n|---|---|---|\n",
    );
    let mut measured: Vec<(&str, [f64; 2])> = Vec::new();
    for (pass, attached) in [false, true].into_iter().enumerate() {
        app.region()[header::ATTACHED].store(u64::from(attached), Ordering::SeqCst);
        for (index, (name, mut row)) in rows(&app).into_iter().enumerate() {
            for _ in 0..10_000 {
                row();
            }
            let start = Instant::now();
            for _ in 0..ROUNDS {
                row();
            }
            let each = start.elapsed().as_nanos() as f64 / f64::from(ROUNDS);
            if pass == 0 {
                measured.push((name, [each, 0.0]));
            } else {
                measured[index].1[1] = each;
            }
        }
    }
    for (name, [detached, attached]) in &measured {
        table.push_str(&format!(
            "| {name} | {detached:.1} ns | {attached:.1} ns |\n"
        ));
    }
    table.push_str(&format!(
        "\nMachine: {} {}, {} logical cores.\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::thread::available_parallelism().map_or(0, usize::from),
    ));
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../.design/cost-11.md");
    std::fs::create_dir_all(concat!(env!("CARGO_MANIFEST_DIR"), "/../.design")).unwrap();
    std::fs::write(path, &table).unwrap();
    print!("{table}");
}

#[test]
fn touchpoints_and_safepoints_do_not_allocate_where_the_contract_says() {
    use abai_stub::declare::{Capability, Decision, Turn};
    use abai_stub::region::calls::{self, Target};

    let declarations = Declarations::new("cost", [Mode::Thread])
        .capability(Capability::new("nothing", "An empty handler.").handler(|_| Ok(())))
        .decision(Decision::options("pick", ["a", "b"], "a", "5s", "Pick."))
        .turn(Turn::new("lap", "5s", "A lap."));
    let none = |_: &str| None;
    let app = Abaigram::with_env(&declarations, &none).unwrap();
    let pick = app.decision("pick").unwrap();
    let lap = app.turn("lap").unwrap();

    // section 11.1: with no harness, a safepoint is one load, a decision
    // and a turn one load and one increment
    let before = allocations();
    for _ in 0..1000 {
        app.safepoint();
        black_box(pick.ask(black_box(&7)).as_str());
        black_box(lap.give());
    }
    assert_eq!(allocations() - before, 0);

    // section 11.2: serving a capability costs the handler's own cost
    let target = Target::Capability {
        index: 0,
        immediate: false,
    };
    let mut at_safepoints = 0;
    for _ in 0..100 {
        let ticket = calls::post(app.region(), target, b"{}").unwrap();
        let before = allocations();
        app.safepoint();
        at_safepoints += allocations() - before;
        assert!(calls::poll(app.region(), &ticket).unwrap().is_ok());
    }
    assert_eq!(at_safepoints, 0);
}
