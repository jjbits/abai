# learnabai: abai for a coding agent

abaigrammar {{abaigrammar}} · abai stub {{stub}} · abaikit-rs {{abaikit}} · Rust

You are reading this because someone wants a Rust program turned into an
abaigram, or a new one made, and you are the agent doing it. Read section
1 once. Follow section 5 step by step; every step ends in a command that
proves it. Keep sections 2 and 8 at hand while you edit. `abaikit-rs
learnabai --section <id>` prints one section; the ids are in the headings.

## 1. What an abaigram is (what)

An abaigram is an ordinary program that includes the abai library (the
"stub") and thereby carries an agent: the agent ships with the program,
can run at install and during use, and observes and steers the program
only through channels the program declares. The contract is
`spec/abaigrammar.md`; this guide is its Rust instantiation in practice.

Two halves, one boundary. The stub lives in the program (the crate
`abai-stub`). The harness is the agent's runtime: a model, a tool set, a
user channel (the crate `abai-harness`, a library and the binary
`abai-harness`). The boundary is memory the two share: inside one process
in turns and thread modes, a mapped file between two processes in sidecar
mode. It means the same thing either way. The Rust pair is made for each
other: a Rust program takes the Rust harness, never the TypeScript one.

Five channels, declared in code:

- `events`: the program tells the agent something happened (push).
- `cells`: shared state the agent reads; a writable cell is a `knob` the
  agent may set within its declared range.
- `capabilities`: functions the agent may call, each with a policy.
- `decisions`: the program stops and asks which way to go; every decision
  has a default and a timeout, so the program never waits forever.
- `turns`: the program hands the agent a bounded moment to act.

Plus `lifecycle` (pause, resume, stop, restart, status: what a supervising
harness may do to the process), `attention` (what wakes the agent, and a
budget on it), and `network`, optional: the agent may meet the agents of
other programs on an agent network. abai carries only the basic acts
there (an identity on a network, who is on it, who is reachable, a
message sent to a member, a message received as a wake); how agents find
each other and what they say is each program's own.

Three modes. `turns`: one process, one thread, the agent runs only inside
a touchpoint; the simplest, the natural first rung for a command-line
program. `thread`: one process, the agent on a thread of its own beside
the program once it is attached (`app.attach()` at startup, or any
touchpoint). `sidecar`: the harness is a separate process; the reference
mode, the one with the whole lifecycle channel. The declarations list the
modes the program supports; the first is the default; `ABAI_MODE`
overrides at startup.

Principles that bind everything you do:

1. The program owns `main()`. The library is included; it wraps nothing
   and replaces no entry point.
2. The agent is invited: it acts through declared channels at declared
   touchpoints and nowhere else.
3. The program runs without the agent. No harness, a failed harness, a
   missing model: the program is the plain program. Defaults everywhere.
4. Declared, not discovered: the agent learns the program from the
   manifest and its `doc` sentences.
5. Control has policy (`auto`, `confirm`, `forbid`) and leaves an audit
   trail.
6. It costs the program nothing it did not ask for: a detached channel
   operation is a load or two; attached, nothing on the program's thread
   allocates, locks or blocks except the touchpoints the program itself
   placed.

How a person meets the agent: `<prog> abai` opens a session on the
terminal; `<prog> abai run -- ARGS` starts the program under the harness
with the whole lifecycle channel; `<prog> abai mcp` serves the agent's
tools to an MCP client such as Claude Code, whose own agent then is the
program's. All of that comes from a few inserted lines at the top of
`main()` (section 3).

## 2. Declaring one in Rust (declare)

The dependencies, in the program's `Cargo.toml`. The crates are not on
crates.io; they come from the abai repository:

```toml
[dependencies]
abai-stub = { git = "https://github.com/jjbits/abai" }
abai-harness = { git = "https://github.com/jjbits/abai" }   # turns and thread modes
serde_json = "1"
```

The crates are edition 2024 and need Rust 1.88 or newer; a repository
pinned to an older toolchain cannot build them. With a checkout of abai
on the machine, a path works too:
`abai-stub = { path = "/path/to/abai/implementations/rust/abai-stub" }`.
A program that declares only `sidecar` leaves `abai-harness` out: it
links the stub alone and finds the `abai-harness` binary when it needs it.

One function builds the declarations. Everything below is real API; copy
what you need and delete the rest.

```rust
use abai_stub::app::Abaigram;
use abai_stub::declare::{Capability, Cell, Decision, Declarations, Event, Turn};
use abai_stub::manifest::{Field, Mode, Pause, Policy, Schema};
use serde_json::json;

fn declarations() -> Declarations {
    Declarations::new("myprog", [Mode::Turns, Mode::Thread, Mode::Sidecar]) // the first is the default
        .entry("./target/release/myprog abai")   // how the entry is reached: a runnable command line
        .check_run("./target/release/myprog --demo") // a short command that exercises the channels
        .audit_path("abai-audit.jsonl")           // relative to the directory of abaigram.yaml;
                                                  // the default is ~/.abai/audit/myprog.jsonl
        .cell(Cell::int("queue.depth", "Jobs waiting."))
        .cell(
            Cell::int("worker.count", "Active workers. The pool resizes at the next batch.")
                .knob(4)                          // a knob: the agent may write it; 4 is the default
                .range_int(1, 64),
        )
        .cell(
            Cell::string("banner", "The line printed above each report.")
                .knob("report")                   // a sized knob is delivered to a handler
                .max(64)
                .on_change(|value| {
                    let text = value.get::<String>()?;
                    if text.is_empty() {
                        return Err("the banner cannot be empty".to_string());
                    }
                    Ok(())                        // keep the value where the program reads it
                }),
        )
        .event(
            Event::new("job.failed", "A job failed; past two attempts the agent is woken.")
                .payload(
                    Schema::new()
                        .field("job_id", Field::string().max(64))
                        .field("attempt", Field::int()),
                )
                .wakes_when("attempt gt 2"),      // or .wakes_always(); <field> eq|ne|gt|lt <json>
        )
        .capability(
            Capability::new("job.retry", "Requeue a failed job once.")
                .params(Schema::new().field("job_id", Field::string().max(64)))
                .result(Schema::new().field("ok", Field::bool()))
                .mutate()                         // changes the program: policy becomes confirm
                .policy(Policy::Confirm)          // or say it outright: Auto, Confirm, Forbid
                .immediate()                      // run when called. The default waits for
                                                  // app.safepoint(): a program that never calls
                                                  // safepoint() must say .immediate()
                .example(json!({"job_id": "job-0001"})) // check calls this; make it safe
                .handler(|params| {
                    let job_id = params.get::<serde_json::Value>()?["job_id"]
                        .as_str()
                        .ok_or("job_id is not a string")?
                        .to_string();
                    Ok(json!({"ok": !job_id.is_empty()}))
                }),
        )
        .decision(
            Decision::options(
                "on_backlog",
                ["scale_up", "shed_oldest", "wait"],
                "wait",                           // the default: what the program does today
                "5s",                             // the timeout
                "Asked when the backlog crosses the high-water mark.",
            )
            .context(Schema::new().field("depth", Field::int())),
        )
        .turn(Turn::new("end_of_batch", "30s", "After each batch. The agent may tune worker.count."))
        .pause(Pause::Cooperative)
        .stop_graceful("10s")
        .on_stop(|| { /* ask the program's own loop to end */ })
}
```

Building the program's side and using it, wherever the facts already are.
Obtain the handles once, at startup; `set`, `get` and `emit` are the cheap
calls.

```rust
let app = Abaigram::new(&declarations())?            // reads ABAI_MODE and ABAI_HARNESS once
    .with_harness(abai_harness::embedded());         // one line links the harness, for turns and thread

let depth = app.cell::<i64>("queue.depth")?;
let workers = app.knob::<i64>("worker.count")?;
let failed = app.event("job.failed")?;
let on_backlog = app.decision("on_backlog")?;
let end_of_batch = app.turn("end_of_batch")?;

depth.set(queue_len);                                // one store, always cheap
let n = workers.get();                               // the agent's setting, or the default
failed.emit(|payload| {                              // nothing happens when no harness is attached
    payload.text("job_id", &job_id);
    payload.int("attempt", attempt);
});
let answer = on_backlog.ask(&json!({"depth": queue_len})); // the default when nobody answers
if answer.as_str() == "scale_up" { /* ... */ }
end_of_batch.give();                                 // returns at once when nobody is there
app.safepoint();                                     // where safepoint calls and a pause take effect
app.attach();                                        // ask for the agent now, for real use: a thread
                                                     // program that wants its agent live calls it
                                                     // once at startup. `check` does not need it.
```

Cell types, their constructors and their handles:

| Constructor | Handle |
|---|---|
| `Cell::bool(name, doc)`, `Cell::int(name, doc)`, `Cell::float(name, doc)` | `app.cell::<bool>(name)`, `::<i64>`, `::<f64>`; as a knob `app.knob::<T>(name)` |
| `Cell::enumeration(name, ["a", "b"], doc)` | `app.enum_cell(name)`, `app.enum_knob(name)` |
| `Cell::string(name, doc)` | `app.text_cell(name)` |
| `Cell::object(name, Schema, doc)`, `Cell::list(name, Field, doc)` | `app.json_cell(name)` |

On a cell: `.knob(default)` makes it a knob, `.range_int(min, max)` and
`.range_float(min, max)` bound a number, `.max(bytes)` sizes a string,
an object or a list, `.confirm()` asks the person before the agent's
write. A scalar knob lands in shared state and the program reads it with
`get()`; a sized knob is delivered to its `on_change` handler at a
safepoint, and a declaration with a sized knob and no handler is
refused. Payload fields are written with `payload.bool`, `int` (an
`i64`), `float`, `symbol` (an enum), `text` and `json`. A wake condition
compares a payload field with a constant; it cannot follow a knob.

A handler and the program's state. A handler is a closure given to the
declarations, before the program's state may exist, and it must be
`Send + Sync + 'static`. Share state with it through an `Arc`: make the
`Arc` at the top of `main()`, pass a clone to the function that builds
the declarations, and `move` it into the closure.

```rust
#[derive(Default)]
pub struct Stats { pub done: std::sync::atomic::AtomicU64 }

pub fn declarations(stats: std::sync::Arc<Stats>) -> Declarations {
    Declarations::new("myprog", [Mode::Turns])
        .capability(
            Capability::new("stats", "The count of jobs done.")
                .example(json!({}))               // no parameters: no .params(...)
                .handler(move |_params| {
                    Ok(json!({"done": stats.done.load(std::sync::atomic::Ordering::Relaxed)}))
                }),
        )
}
```

Which thread a handler runs on: a safepoint-dispatched capability and a
sized knob's `on_change` run on the program's own thread, inside
`app.safepoint()`, a turn or a decision. An immediate capability runs on
a thread that is not the program's in thread and sidecar modes, at any
time, so what it touches must be safe to share (atomics, a `Mutex`).

Policy (section 10 of the contract): `auto` runs on the agent's say,
`confirm` asks the person first (under an MCP client, the client's own
permission prompt is the person's consent), `forbid` is declared but
never runnable. On a capability or a decision it is
`.policy(Policy::Confirm)` (`Policy` is in `abai_stub::manifest`); on a
knob, `.confirm()`. Every act is written to the audit log with the
agent's reason.

Cost: detached, every operation above is a load or a store. Keep your own
handlers cheap too. The agent's model calls never run on the program's
thread in thread and sidecar modes; in turns mode they run only inside
the touchpoints you placed.

## 3. The standard entry (entry)

Every abaigram answers `<prog> abai ...`. The stub provides it; the
program hands it the arguments first thing in `main()`:

```rust
mod abai;                        // the module with `declarations()`

use abai_stub::app::Abaigram;
use abai_stub::entry::run_entry;

fn main() {
    let app = match Abaigram::new(&abai::declarations()) {
        Ok(app) => app.with_harness(abai_harness::embedded()),
        Err(error) => {
            eprintln!("myprog: {error}");
            std::process::exit(2);
        }
    };
    let abai_args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(code) = run_entry(&app, &abai_args) {
        std::process::exit(code);   // an abai verb ran and said what it had to say
    }
    // None: no abai verb; the program's own argument handling follows, untouched
}
```

Added lines, nothing removed: the program's own argument parsing follows
untouched, and a plain invocation reaches it exactly as before.

The verbs the entry serves:

```
<prog> abai                  open a session (needs a configured model)
<prog> abai install          run the install touchpoint
<prog> abai run -- ARGS      sidecar launch: the harness starts "<prog> ARGS" as its child
<prog> abai config ...       machine-level model and network settings (~/.abai)
<prog> abai doctor           offline: manifest, entry, content, modes; online: the model
<prog> abai manifest         print the effective manifest
<prog> abai mcp              serve the agent's tools to an MCP client over stdio
```

The manifest exists twice and must agree: in code (the source of truth at
runtime) and as `abaigram.yaml` at the repository root, generated by the
program itself and checked in:

```
<entry> manifest > abaigram.yaml
<entry> doctor --offline
```

The `entry` is a command line that runs in the repository root; the tools
reach the program through it. `./target/release/myprog abai` and
`cargo run -q --release -- abai` are both fine; `myprog abai` only once
`myprog` is on the PATH. An entry through `cargo run` is slower to start
and needs a toolchain where it runs. The entry and `check.run` name a
built file, so build with the profile they name: `cargo build --release`
for `./target/release/...`, plain `cargo build` for `./target/debug/...`.

Content lives in `abai/` beside `abaigram.yaml` unless the declarations
say otherwise: `abai/identity.md` (required: who the agent is for this
program and how it should behave), `abai/install.md`, `abai/use.md`,
`abai/turns/<name>.md`. The stub finds that directory by walking up from
the working directory, then from the executable, to the `abaigram.yaml`
that names the program; `.root(dir)` on the declarations names it
outright. The harness composes the system prompt from `identity`, the
mode, and every declaration with its `doc`. Good `doc` sentences are most
of the work of good content.

## 4. Conformance levels and what check demands (levels)

No level needs a model. `abaikit-rs check <repo>` verifies them with the
null harness, which is part of the stub: a harness that attaches and
drives nothing (passive), or drives every declared knob and capability by
its declared default and `example` (active, the "exercise run").

| Level | Name | Requires |
|---|---|---|
| L1 | reachable | The stub is included; `<entry> manifest` works; `abaigram.yaml` exists and agrees with the code; `abai/identity.md` exists; the offline `doctor` passes. Checked without running the program beyond its entry. |
| L2 | observable | L1, plus `check.run`, plus at least one cell written or event emitted during the exercise run. |
| L3 | steerable | L2, plus one capability the exercise calls successfully with its `example`, or one knob whose write lands. |
| L4 | deliberative | L3, plus one decision the program reaches during the exercise run. |

L1 is what `<entry> doctor --offline` checks; `abaikit-rs check` repeats
it from outside and adds the levels above.

`check.run` is a command, run by the shell in the repository root, that
exercises the program's channels and exits: a demo mode, a short batch, a
dry run. `check` runs it with `ABAI_HARNESS=exercise` (the active null
harness, which also stands in for the person's consent on `confirm`
acts) under each declared mode (`ABAI_MODE`), and reads the report the
stub prints on stderr at exit. It then measures: the same command with
`ABAI_HARNESS=off` (nothing attaches) and `ABAI_HARNESS=null` (the
passive harness), side by side; a declared `check.overhead` (such as
`"5%"`) fails the check when the null run is slower than that. Every
declaration the exercise could not reach is named in the report,
capabilities without an `example` included.

`check` builds nothing: it runs the entry and `check.run` as they are
("built: no" in its output), so an old binary is what it judges. Build
before every `check`. Give `check.run` enough work to run for a second
or more if the overhead numbers matter; a run of a few milliseconds is
always "within noise", and `--runs N` takes more measurements. ("compiled
out: not offered" means this tool does not also measure a build without
the stub.)

What the exercise needs from the program:

- The report is printed when the process exits, by returning from `main`
  or by `std::process::exit`. A program that aborts or is killed prints
  none.
- The exercise works on the program's own thread, and only where the
  program lets an agent act: inside `app.attach()`, a turn, a decision,
  or `app.safepoint()`. An immediate capability runs at the first of
  those; a safepoint-dispatched capability and a sized knob at the first
  safepoint, turn or decision. A program that reaches none of them leaves
  every call "not attempted". A program with no main loop calls
  `app.safepoint()` from something periodic.
- A decision or a turn the program reaches from inside a handler the
  exercise called counts as reached, with its default. Do not rely on
  it: with a real agent such a touchpoint always gets its default
  (section 8).
- Events are read at those same moments and once more at exit. More
  than 256 events between two readings lap the ring: the report counts
  them as dropped, and an event name may be missing from it.
- The runs attach the null harness, so the audit log the manifest names
  receives their records. A relative `.audit_path(...)` is under the
  directory of `abaigram.yaml`: add that file to `.gitignore`, or leave
  the default, which is outside the checkout.

```
abaikit-rs check <repo>              # the level reached, modes, overhead, unexercised, violations
abaikit-rs check <repo> --level 3    # exit non-zero below level 3
abaikit-rs check <repo> --mode turns # one declared mode only
abaikit-rs check <repo> --runs 5     # more measurement runs (default 3)
abaikit-rs check <repo> --timeout 30 # the bound on one check.run, in seconds (default 120)
abaikit-rs check <repo> --json
```

A program is at the level `check` can demonstrate, not the level you
intended. If a channel is only reached by a path `check.run` does not
take, change `check.run`, not the claim.

## 5. The retrofit, step by step (retrofit)

Follow the repository's own guidelines and conventions first: its
`AGENTS.md` or `CONTRIBUTING.md`, its edition, its `rustfmt` and `clippy`
settings, its test command. Everything you add is additive: new files,
inserted lines, added dependencies. You never rewrite `main()`, never
delete a line, never reorder existing code. The one kind of line you
change is the place where the program reads a setting that becomes a
knob (step 7).

"Build" below means the build that makes the file the entry names
(`cargo build --release` for an entry under `target/release`). `check`
does not build; a step verified against an old binary proves nothing.

Step 0. Know the program. Find its `Cargo.toml`, the binary's `main.rs`,
how it is built and run, and where its state already lives (a queue, a
counter, a config). Verify: you can name the line where the program's own
argument handling starts, and the command that runs the program.

Step 1. Add the dependencies of section 2 to `Cargo.toml`. Verify:
`cargo build` succeeds.

Step 2. Declare the abaigram in a new module (`src/abai.rs`, with `mod
abai;` added in `main.rs`) as in section 2, with only the name, the
`entry` command line and the modes to begin with: `[Mode::Turns,
Mode::Sidecar]`, and `Mode::Thread` too when the program keeps running
between touchpoints and wants the agent live in its process. A program
built with `panic = "abort"` must not declare thread mode. Verify:
`cargo build` succeeds.

Step 3. Hook the entry. In `main()`, insert the lines of section 3 before
the program's own argument handling. From here on every change is: build,
then `<entry> manifest > abaigram.yaml`, then verify. Verify: `<entry>
manifest` prints YAML, and the program's own usage (`<prog> --help`, or
whatever it answered before) is unchanged.

Step 4. Write `abai/identity.md`: who the agent is for this program, what
it is for, how it should behave, in a few sentences. Verify:
`<entry> doctor --offline` prints an `identity` line that begins with `ok`.

Step 5. Generate the manifest file and reach L1.

```
<entry> manifest > abaigram.yaml
abaikit-rs check .
```

Verify: the report says level 1. Commit `abaigram.yaml`, `abai/`, the new
module, the inserted lines, `Cargo.toml` and `Cargo.lock`; nothing else
changed.

Step 6. Observe: L2. Declare one or two cells and events where the
program already has the facts (a depth, a count, a failure), and set or
emit them in the existing code paths, one line each. Add
`.check_run("<a short command that exercises them>")` to the
declarations: a mode of the program that runs for seconds and exits (a
`--demo` flag you add, a small fixed input, a dry run). Make it reach
every channel for certain, by a fixed input and not by chance. Build,
regenerate `abaigram.yaml`, verify: `abaikit-rs check . --level 2`.

Step 7. Steer: L3. Declare one knob the program already reads as a
setting (with its current value as the default and a safe range), or one
capability with a handler and an `example` whose call is harmless. For a
knob, change the line that read the setting so it reads the knob
(`max_attempts.get()` where it said `MAX_ATTEMPTS`), and give the knob
the old constant as its default so the two cannot drift. Call
`app.safepoint()` once per pass of the program's main loop, where it is
safe for a handler to run. Build, regenerate, verify:
`abaikit-rs check . --level 3`; the report names the knob as landed or
the capability as called.

Step 8. Deliberate: L4. At a real fork in the program (retry or give up,
scale or wait), declare a decision with its options, a default that is
what the program does today, and a short timeout; insert `let answer =
on_retry.ask(&json!({ ... }));` above the fork and add a branch on
`answer.as_str()`, the existing path staying as the branch the default
chooses. When the fork depends on state, ask only in the case that has a
real choice, and keep the rest as it is:

```rust
// today: retry while attempts remain, else give up
if attempt >= max && on_exhausted.ask(&json!({"job": job})).as_str() == "retry_once_more" {
    requeue(job);        // the agent's choice; bound it, so "retry" cannot loop forever
    continue;
}
// the existing code follows, unchanged: it is what the default chooses
```

Make sure `check.run` reaches the fork for certain. Build, regenerate,
verify: `abaikit-rs check . --level 4`.

Step 9. Meet the agent. With a model configured (`<entry> config set
provider ...`, `<entry> config set model ...`, `<entry> config set key
...`, then `<entry> doctor`), open `<entry>` and ask what it sees; or run
`<entry> run -- ARGS` and watch it supervise; or serve `<entry> mcp` to
Claude Code (section 6). Say what you added and why in the commit
message and, if the repository keeps one, its changelog.

If `abaikit-rs check` reports a violation, read its location and message:
they name the file or the declaration and what the contract wanted.

## 6. Running an abaigram (use)

Session on the terminal, the person talking to the agent while the
program runs (turns and thread modes in-process; sidecar starts the
harness binary):

```
<entry>
```

Launch under supervision, the harness as the parent with the whole
lifecycle channel (pause, resume, stop, restart, status) and the
program's output observed from outside:

```
<entry> run -- ARGS
```

The harness binary reaches programs already running in sidecar mode:

```
abai-harness list
abai-harness session (PID | NAME)
abai-harness mcp     (PID | NAME)
```

An MCP client as the agent, no model configured anywhere: the client's
own agent uses the program's tools, and the client's permission prompt is
the person's consent.

```json
{ "mcpServers": { "myprog": { "command": "/abs/path/to/myprog", "args": ["abai", "mcp"] } } }
```

The machine-level model configuration, shared by every abaigram on the
machine, lives under `~/.abai/`. The Rust harness has a client of its own
for two API shapes, Anthropic Messages and OpenAI-compatible chat
completions, with API keys only:

```
<entry> config show
<entry> config set provider <id>
<entry> config set model <id>
<entry> config set key <provider>          # a key, read without echo
<entry> config set url <provider> <base url>
<entry> doctor                             # offline checks, then the model
```

Environment variables, all optional: `ABAI_MODE` (`turns`, `thread` or
`sidecar`, overriding the first declared mode), `ABAI_HARNESS` (`off`,
`null`, `exercise`: check runs only; never set it for real use),
`ABAI_HOME` (the configuration directory, default `~/.abai`),
`ABAI_HARNESS_BIN` (the sidecar harness binary), `ABAI_CHANNEL`
(`terminal` or `none`: whether stdin is the person; unset, it is when
stdin is a terminal), and for the network
below `ABAI_NET_DIR`, `ABAI_NET_TOKEN` and `ABAI_AIIP_BIN`. In sidecar
mode the program finds the harness binary in this order:
`ABAI_HARNESS_BIN`, the declarations' `.harness_path(...)`,
`rust_harness.bin` in `~/.abai/config.json`, then `abai-harness` on the
PATH. Running Rust programs are listed in `~/.abai/run-rust/`.

A program that declares `.network(doc, required)` puts its agent on an
aiip network. The harness talks to aiip's daemon over its socket; the
`aiip` binary must be on the machine (on the PATH, or named by
`ABAI_AIIP_BIN` or `<entry> config set aiip-bin <path>`), and `doctor`
says when it is not. A run's identity lives in a state directory:
`ABAI_NET_DIR`, else `~/.abai/net/<name>/`, so two runs of one program on
one machine are one member unless the run is given a directory of its
own. At attach the harness finds or starts the daemon for that
directory, joins with the invite in `ABAI_NET_TOKEN` when the run is not
yet a member, and tells the agent where it is; `abai_peers` lists who
else is there and who is reachable now. A message from a member wakes the
agent as the event `abai.net.message`; `abai_send` answers a member by
name, with a reason, and `abai_messages` lists the run's messages. Every
message sent or received is one line in the audit log.

```
<entry> config net                                 # the state dir, the daemon, the memberships
<entry> config net create <network> --as <member>  # a new network, this run as its authority
<entry> config net invite <network> --for <member> # an invite token for a new member (authority only)
<entry> config net join --token -                  # join with an invite read from stdin
<entry> config net leave <network>
```

An invite token carries the member's private key: hand it to that
member's run as `ABAI_NET_TOKEN` or on stdin, never in a command line, a
file or a log. Who creates the network, who mints the invites, how
members find each other and what they say to one another is the
program's to decide, in its code and its content, not abai's.

The audit log (`.audit_path(...)` in the declarations; default
`~/.abai/audit/<name>.jsonl`) records every act of control with its
reason, consent and outcome. Read it when you wonder what the agent did.

## 7. Where this instantiation departs from the contract (deviations)

The first is in every manifest this stub writes, the second when
`thread` is declared and the last when `sidecar` is, so an agent reading
the manifest sees them too:

{{deviations}}

Besides those: keys are in a file, not the system credential store; the
model's answer is taken whole, not streamed; there are no account
logins; the MCP server must be attached to a program when it starts; and
sidecar mode needs a Unix system.

## 8. What never to do (never)

- Never rewrite, wrap or replace `main()`. The entry hook is a few
  inserted lines at its top; the program's own flow follows them.
- Never delete or reorder existing lines. A retrofit is additive; a
  reviewer should see only added lines and new files, and the one line
  changed where a setting became a knob.
- Never put the stub behind a condition or a cargo feature. The entry
  must be reachable on every invocation, or `check` cannot reach L1.
- Never leave a capability on the default safepoint dispatch in a program
  that never calls `app.safepoint()` and reaches no turn or decision: the
  call is never made and `check` never reaches L3 by it.
- Never block in a handler or around a `set`. Long work belongs in a job
  the handler enqueues.
- Never reach a decision or a turn from inside a handler the agent
  called: the agent is busy with the call, and the touchpoint goes
  unserved.
- Never declare an `example` whose call changes real state. The exercise
  run calls it; so will a curious agent.
- Never declare a knob without a safe default and range, a decision
  without the default the program chooses today, or a turn without a
  timeout.
- Never declare thread mode in a program built with `panic = "abort"`.
- Never put secrets or credentials in content or `doc` sentences; they
  are the prompt.
- Never claim a level `check` did not report, and never change a level by
  editing `abaigram.yaml` by hand: it is generated, and `check` compares
  it with the code.
- Never make `check.run` depend on the network, credentials, or state it
  does not create itself.
- Never touch `target/` or files `.gitignore` names.
