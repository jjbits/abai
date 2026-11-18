# abai in Rust

A Rust stub and a Rust harness, made for each other. They follow the
contract in `spec/abaigrammar.md`. They do not talk to the TypeScript
pair: a Rust program takes the Rust harness, and nothing else.

## What is here

| Crate | What it is |
|---|---|
| `abai-stub` | The library a program includes to become an abaigram. No HTTP, no model code. |
| `abai-harness` | The agent's half: a library a program can link, and the binary `abai-harness`. |
| `example-counter` | A small abaigram that declares one of everything. |

## A program

```rust
use abai_stub::app::Abaigram;
use abai_stub::declare::{Cell, Decision, Declarations, Turn};
use abai_stub::entry::run_entry;
use abai_stub::manifest::Mode;

let declarations = Declarations::new("counter", [Mode::Turns, Mode::Thread, Mode::Sidecar])
    .cell(Cell::int("count", "How far the count has got."))
    .cell(Cell::int("step", "How much a tick adds.").knob(1))
    .decision(Decision::options("on_limit", ["wrap", "stop"], "stop", "5s", "At the limit."))
    .turn(Turn::new("each_lap", "30s", "After a lap."));

// one line links the harness, for turns and thread modes
let app = Abaigram::new(&declarations)?.with_harness(abai_harness::embedded());

// `<prog> abai ...` is served here; any other arguments are the program's own
let args: Vec<String> = std::env::args().skip(1).collect();
if let Some(code) = run_entry(&app, &args) {
    std::process::exit(code);
}

let count = app.cell::<i64>("count")?;
let step = app.knob::<i64>("step")?;
let on_limit = app.decision("on_limit")?;
```

A program that declares only sidecar mode leaves out `abai-harness` and
`with_harness`: it links the stub alone and finds the `abai-harness`
binary when it needs it.

The program's content is beside it: `abai/identity.md` (required),
`abai/install.md`, `abai/use.md`, and a file per turn or decision when
it has more to say (`abai/turns/<name>.md`).

## The three modes

The first mode in the declarations is the default. `ABAI_MODE` picks
another one the program declares.

| Mode | Where the agent runs | When it runs |
|---|---|---|
| `turns` | on the program's thread | only inside a touchpoint |
| `thread` | on a thread of its own in the program | live; the program wakes it |
| `sidecar` | in the `abai-harness` process | live; the two share the region as a mapped file |

In sidecar mode the program finds the binary in this order:
`ABAI_HARNESS_BIN`, the manifest's `harness.path`, `rust_harness.bin` in
`~/.abai/config.json`, then `abai-harness` on the PATH.

## The entry

```
<prog> abai                  open a session
<prog> abai install          run the install touchpoint
<prog> abai run -- ARGS      sidecar launch: the harness starts "<prog> ARGS" as its child
<prog> abai config ...       the machine's model and network settings
<prog> abai doctor [--offline] [--json] [--root DIR]
<prog> abai manifest [--json]
<prog> abai mcp              serve the agent's tools to an MCP client on stdio
```

The harness binary has verbs of its own for programs that are already
running in sidecar mode:

```
abai-harness list [--json]
abai-harness attach  (PID | NAME)     serve the program until it ends
abai-harness session (PID | NAME)     talk to its agent; leave with /quit
abai-harness mcp     (PID | NAME)     serve its agent's tools to an MCP client
abai-harness run [--auto] -- PROGRAM ARGS
```

## The model

The harness has a small client of its own for two API shapes: Anthropic
Messages, and OpenAI-compatible chat completions (which is what
FreeToken speaks). API keys only.

```
<prog> abai config set provider anthropic
<prog> abai config set model <model id>
<prog> abai config set key anthropic        # asks for the key
<prog> abai config show
```

The settings are in `~/.abai/config.json` and the keys in
`~/.abai/credentials.json`, the same files the TypeScript harness uses.
Fields this harness does not know are kept as they are.

With no model configured an attach fails at once and the program runs
as the plain program.

## What the agent can do

`abai_status`, `abai_transcript`, `abai_cells`, `abai_set`, `abai_call`,
`abai_decide`, `abai_audit` in every mode. `abai_watch` and `abai_timer`
in thread and sidecar modes. `abai_lifecycle` in sidecar mode.
`abai_peers`, `abai_send` and `abai_messages` when the run may be on a
network. Under MCP also `abai_wait`, `abai_prompt` and, from the harness
binary, `abai_attach`.

Every act of control is written to the program's audit log with the
agent's reason. The harness writes the log; the stub only counts
touchpoints nobody served.

## The network

A program that declares `network` can be a member of an aiip network.
The `aiip` daemon is found or started, a run joins with an invite from
`ABAI_NET_TOKEN`, and the state is kept in `~/.abai/net/<program>/` or
in `ABAI_NET_DIR`.

```
<prog> abai config net
<prog> abai config net join --token -
<prog> abai config net create <name> --as <member>
<prog> abai config net invite <net> --for <member>
<prog> abai config net leave <net>
```

A member's message wakes the agent as `abai.net.message`. Messages
travel in the aiap v1 envelope, and each one is an audit line.

## Where this differs

From the contract, on purpose:

- Under launch the program is attached while it registers its
  declarations, not before `main()`.
- A program built with `panic = "abort"` cannot survive a panic in the
  harness thread, so it must not declare thread mode.
- There is no null harness and no `check`, so no conformance level is
  reported for a Rust abaigram yet. `ABAI_HARNESS=off` works; `null` and
  `exercise` are refused.
- Keys are in a file, not the system credential store.
- `status` does not report the program's resource use.

From the TypeScript harness:

- No account logins, and two API shapes instead of every provider.
- The model's answer is taken whole, not streamed.
- There is no `abaikit` for Rust: no `new`, `abaify`, `check` or
  `learnabai`.
- The MCP server must be attached to a program when it starts.
- Running programs are listed in `~/.abai/run-rust/`.
- Sidecar mode needs a Unix system.

## Building and testing

```
cargo build --workspace
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

The suite needs no network and no model: the model is a local server
with scripted answers, and the aiip daemon is a fake. It takes about
20 seconds once built.

The cost rules of the contract's section 11 are tested by counting
allocations (`abai-stub/tests/cost.rs`).
