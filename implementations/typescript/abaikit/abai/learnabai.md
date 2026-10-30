# learnabai: abai for a coding agent

abaigrammar {{abaigrammar}} · abai stub {{stub}} · abaikit {{abaikit}} · TypeScript

You are reading this because someone wants a program turned into an
abaigram, or a new one made, and you are the agent doing it. Read section
1 once. Follow section 5 step by step; every step ends in a command that
proves it. Keep sections 2 and 8 at hand while you edit. `abaikit
learnabai --section <id>` prints one section; the ids are in the headings.

## 1. What an abaigram is (what)

An abaigram is an ordinary program that includes the abai library (the
"stub") and thereby carries an agent: the agent ships with the program,
can run at install and during use, and observes and steers the program
only through channels the program declares. The contract is
`abaigrammar.md`; this guide is its TypeScript instantiation in practice.

Two halves, one boundary. The stub lives in the program. The harness is
the agent's runtime: a model, a tool set, a user channel. The boundary is
a function call inside the process (turns mode) or a local socket between
two processes (sidecar mode). It means the same thing either way.

Five channels, declared in a manifest the program builds in code:

- `events`: the program tells the agent something happened (push).
- `cells`: shared state the agent reads; a writable cell is a `knob` the
  agent may set within its declared range.
- `capabilities`: functions the agent may call, each with a policy.
- `decisions`: the program stops and asks which way to go; every decision
  has a default and a timeout, so the program never waits forever.
- `turns`: the program hands the agent a bounded moment to act.

Plus `lifecycle` (pause, resume, stop, restart, status: what a supervising
harness may do to the process) and `attention` (what wakes the agent, and
a budget on it).

Three modes. `turns`: one process, one thread, the agent runs only inside
a touchpoint; the simplest, the natural first rung for a command-line
program. `sidecar`: the harness is a separate process, attached through
a socket; the reference mode, the one with the whole lifecycle channel.
`thread` is in the contract but not in this instantiation yet. A manifest
declares the modes it supports; the first is the default; `ABAI_MODE`
overrides at startup.

Principles that bind everything you do:

1. The program owns `main()`. The library is included; it wraps nothing
   and replaces no entry point.
2. The agent is invited: it acts through declared channels at declared
   touchpoints and nowhere else.
3. The program runs without the agent. No harness, a failed harness, a
   missing model: the program is the plain program. Defaults everywhere.
4. Declared, not discovered: the agent learns the program from the
   manifest and its `doc` fields.
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

## 2. Declaring one in TypeScript (declare)

Install (section 5 has the exact command for this machine):

```
npm install {{abai_spec}} {{harness_spec}}
```

One module declares the abaigram and exports it. Everything below is
real API; copy what you need and delete the rest.

```ts
// src/abai.ts
import { fileURLToPath } from "node:url";
import { createAbaigram } from "@abaigram/stub";

export const app = createAbaigram(
	{
		name: "myprog",                       // the program's name; also the manifest's
		entry: "node dist/main.js abai",      // how the entry is reached: a runnable command line
		modes: ["turns", "sidecar"],          // supported; the first is the default
		content: { identity: "abai/identity.md" }, // the prompts; identity is required
		check: { run: "node dist/main.js --demo" }, // a short command that exercises the channels
		cells: {
			"queue.depth": { type: "int", access: "read", doc: "Jobs waiting." },
			"worker.count": {                     // a knob: readwrite with a default and a range
				type: "int", access: "readwrite", default: 4, range: [1, 64],
				doc: "Active workers. The pool resizes at the next batch.",
			},
		},
		events: {
			"job.failed": {
				payload: { job_id: { type: "string", max: 64 }, attempt: "int" },
				wakes: "attempt gt 2",            // "always", "never", or <field> eq|ne|gt|lt <json>
				doc: "A job failed; past two attempts the agent is woken.",
			},
		},
		capabilities: {
			"job.retry": {
				params: { job_id: "string" },
				result: { ok: "bool" },
				effect: "mutate",                 // "read" or "mutate"
				policy: "confirm",                // "auto" | "confirm" | "forbid"; mutate defaults to confirm
				dispatch: "immediate",            // run now. The default is "safepoint": the call waits for
				                                  // app.safepoint(), so a program that never calls safepoint()
				                                  // must declare "immediate", or the call stays pending and
				                                  // check never reaches L3
				timeout: "30s",
				example: { job_id: "job-0001" },  // check calls this; make it safe
				doc: "Requeue a failed job once.",
				handler: async ({ job_id }) => ({ ok: await retry(String(job_id)) }),
			},
		},
		decisions: {
			on_backlog: {
				context: { depth: "int", workers: "int" },
				options: ["scale_up", "shed_oldest", "wait"],
				default: "wait",
				timeout: "5s",
				doc: "Asked when the backlog crosses the high-water mark.",
			},
		},
		turns: {
			end_of_batch: { timeout: "30s", doc: "After each batch. The agent may tune worker.count." },
		},
		lifecycle: {
			pause: "cooperative",                 // "cooperative" | "os" | "none"
			stop: { graceful: "10s", handler: () => shutdown() },
		},
	},
	// the directory holding abaigram.yaml and abai/: one level up from src/abai.ts and from dist/abai.js;
	// count the levels from the built file if the build nests deeper (dist/src/abai.js is two)
	{ root: fileURLToPath(new URL("..", import.meta.url)) },
);
```

Using it from the program's own code, wherever the facts already are.
Obtain the handles once, at startup; `set`, `get` and `emit` are the cheap
calls. The import is in the repository's own style: `./abai.js` under
NodeNext (tsc resolves it to `abai.ts`), `./abai.ts` only where the project
runs or rewrites `.ts` imports.

```ts
import { app } from "./abai.js";

const depth = app.cell<number>("queue.depth");
const workers = app.knob<number>("worker.count");
const failed = app.event("job.failed");

depth.set(queue.length);                               // one store, always cheap
const n = workers.get();                               // the agent's setting, or the default
failed.emit({ job_id, attempt });                      // nothing happens when no harness is attached
const choice = await app.decide<string>("on_backlog", { depth: queue.length, workers: n }); // "wait" when nobody answers
await app.turn("end_of_batch");                        // returns at once when nobody is there
app.safepoint();                                       // where "safepoint" calls and a pause take effect
await app.attach();                                    // optional: ask for the agent now
```

abai is ESM-only. In a CommonJS repository load it inside the async main:
`const { createAbaigram, runEntry } = await import("@abaigram/stub");` (Node 22.12 and
later can also `require("@abaigram/stub")`). Under `verbatimModuleSyntax` the imports
above are all value imports and need no change; a type you import, such as
`Abaigram`, needs `import type`.

Types: `int`, `float`, `bool`, `enum` (with `enum: [...]`), `string`,
`object` (with `fields`), `list` (with `items`); sized types carry `max`.
A schema field is a bare type name or `{ type, max, enum, fields, items,
nullable, doc }`. A knob is `access: "readwrite"` with a `default`; a
scalar knob lands in shared state, a sized one is delivered to
`app.knob(name).onChange(handler)` at a safepoint. Capabilities may also
be bound late: `app.capability("job.retry", handler)`.

Policy (section 10 of the contract): `auto` runs on the agent's say,
`confirm` asks the person first (under an MCP client, the client's own
permission prompt is the person's consent), `forbid` is declared but never
runnable. Every act is written to the audit log with the agent's reason.

Cost: detached, every operation above is a load or a store. Keep your own
handlers cheap too; the agent's model calls never run on the program's
thread in sidecar mode, and in turns mode they run only inside the
touchpoints you placed.

## 3. The standard entry (entry)

Every abaigram answers `<prog> abai ...`. The stub provides it; the
program hands it the arguments first thing in `main()`:

```ts
import { runEntry } from "@abaigram/stub";
import { app } from "./abai.js";

async function main(): Promise<void> {
	const code = await runEntry(app, process.argv.slice(2));
	if (code >= 0) {
		process.exitCode = code; // an abai verb ran and said what it had to say
		return;
	}
	// -1: no abai verb; the program's own argument handling follows, untouched
}
```

In a module that already runs at top level, the same two statements stand
on their own: `const code = await runEntry(app, process.argv.slice(2)); if
(code >= 0) process.exit(code);`. Prefer `process.exitCode` where you can:
`process.exit` can cut a large `manifest --json` short on a pipe, and
`abaikit check` reads the entry through one.

Added lines, nothing removed: the program's own argument parsing follows
untouched, and a plain invocation reaches it exactly as before.

The verbs the entry serves:

```
<prog> abai                  open a session (needs a configured model)
<prog> abai install          run the install touchpoint
<prog> abai run -- ARGS      sidecar launch: the harness starts "<prog> ARGS" as its child
<prog> abai config           machine-level model and credential settings (~/.abai)
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

The `entry` field is a command line that runs in the repository root; the
tools reach the program through it. `node dist/main.js abai`, `npx myprog
abai`, `./bin/myprog abai` are all fine; `myprog abai` only once `myprog`
is on the PATH.

Content lives in `abai/` at the root unless the manifest says otherwise:
`abai/identity.md` (required: who the agent is for this program and how
it should behave), `abai/install.md`, `abai/use.md`, `abai/turns/<name>.md`.
The harness composes the system prompt from `identity`, the mode, and
every declaration rendered with its `doc`. Good `doc` fields are most of
the work of good content.

## 4. Conformance levels and what check demands (levels)

No level needs a model. `abaikit check <repo>` verifies them with the
null harness, a harness that attaches and drives nothing (passive) or
drives every declared knob and capability by its declared default and
`example` (active, the "exercise run").

| Level | Name | Requires |
|---|---|---|
| L1 | reachable | The stub is included; `<entry> manifest` works; `abaigram.yaml` exists, validates and agrees with the code; `abai/identity.md` exists; the offline `doctor` passes. Checked without running the program beyond its entry. |
| L2 | observable | L1, plus `check.run`, plus at least one cell written or event emitted during the exercise run. |
| L3 | steerable | L2, plus one capability the exercise calls successfully with its `example`, or one knob whose write lands. |
| L4 | deliberative | L3, plus one decision the program reaches during the exercise run. |

L1 is what `<entry> doctor --offline` checks; `abaikit check` repeats it
from outside and adds the levels above.

`check.run` is a command, run by the shell in the repository root, that
exercises the program's channels and exits: a demo mode, a short batch, a
dry run. `check` runs it with `ABAI_HARNESS=exercise` (the active null
harness, which also stands in for the person's consent on `confirm`
acts) under each declared mode (`ABAI_MODE`), and reads the report the
stub prints at exit. It then measures: the same command with
`ABAI_HARNESS=off` (nothing attaches) and `ABAI_HARNESS=null` (the
passive harness), side by side; a declared `check.overhead` (such as
`"5%"`) fails the check when the null run is slower than that. Every
declaration the exercise could not reach is named in the report,
capabilities without an `example` included. The exercise and measurement
runs attach the null harness, so the audit log the manifest names
receives their records: keep that file out of version control, or point
`audit.path` outside the checkout.

```
abaikit check <repo>              # the level reached, modes, overhead, unexercised, violations
abaikit check <repo> --level 3    # exit non-zero below level 3
abaikit check <repo> --json
```

A program is at the level `check` can demonstrate, not the level you
intended. If a channel is only reached by a path `check.run` does not
take, change `check.run`, not the claim.

## 5. The retrofit, step by step (retrofit)

Follow the repository's own guidelines and conventions first: its
`AGENTS.md` or `CONTRIBUTING.md`, its module system (ESM or CommonJS,
TypeScript or JavaScript), its linter and formatter, its test command.
Everything you add is additive: new files, inserted lines, two added
dependencies. You never rewrite `main()`, never delete a line, never
reorder existing code.

Step 0. Know the program. Find the package manifest, the entry file the
`bin` or `main` points at, how it is built and run, and where its state
already lives (a queue, a counter, a config). Verify: you can name the
file where the program's own argument handling starts, and the command
that runs the program.

Step 1. Add the dependencies, in the repository root.

```
npm install {{abai_spec}} {{harness_spec}}
```
{{workspace_note}}
Verify, in the repository root:
`node -e "import('@abaigram/stub').then(m => console.log(m.ABAI_STUB_VERSION))"`
prints `{{stub}}`.

Step 2. Declare the abaigram in a new module (`src/abai.ts`, or
`src/abai.js` in a JavaScript repository) as in section 2, with only
`name`, a runnable `entry`, `modes: ["turns", "sidecar"]`, `content` and
`root` to begin with. When the program's real entry is a plain launcher
that runs without the build (a `bin/x.mjs` that imports `dist/`), put the
declaration beside it as a `.mjs` module the launcher can import, so the
entry answers `manifest` and `doctor` before anything is built. Verify: build as the repository does, then
`node -e "import('./dist/abai.js')"` (the built path) runs without error.

Step 3. Hook the entry. In the file where `main()` starts, insert the
lines of section 3 before the program's own argument handling. The entry
runs the built program, so from here on every change is: build (the
repository's build script), then `<entry> manifest > abaigram.yaml`, then
verify. Verify: `<entry> manifest` prints YAML, and the program's own
usage (`<prog> --help`, or whatever it answered before) is unchanged.

Step 4. Write `abai/identity.md`: who the agent is for this program, what
it is for, how it should behave, in a few sentences. Verify:
`<entry> doctor --offline` prints an `identity` line that begins with `ok`.

Step 5. Generate the manifest file and reach L1.

```
<entry> manifest > abaigram.yaml
abaikit check .
```

Verify: the report says level 1. Commit `abaigram.yaml`, `abai/`, the new
module, the inserted lines, `package.json` and its lock file; nothing else
changed.

Step 6. Observe: L2. Declare one or two cells and events where the program
already has the facts (a depth, a count, a failure), and set or emit them
in the existing code paths, one line each. Add `check: { run: "<a short
command that exercises them>" }` to the declaration, a mode of the
program that runs for seconds and exits (a `--demo` flag you add, a small
fixed input, a dry run). Build, regenerate `abaigram.yaml`, verify: `abaikit check .
--level 2`.

Step 7. Steer: L3. Declare one knob the program already reads as a
setting (with its current value as the `default` and a safe `range`), or
one capability with a handler and an `example` whose call is harmless.
Build, regenerate, verify: `abaikit check . --level 3`; the report names
the knob as landed or the capability as called.

Step 8. Deliberate: L4. At a real fork in the program (retry or give up,
scale or wait), declare a decision with `options`, a `default` that is
what the program does today, and a short `timeout`; insert `const choice
= await app.decide("on_retry", { ... })` above the fork and add a branch
on `choice`, the existing path staying as the branch the default chooses.
Make sure `check.run` reaches the fork. Build, regenerate, verify:
`abaikit check . --level 4`.

Step 9. Meet the agent. With a model configured (`<entry> config set
provider ...`, `<entry> config set model ...`, `<entry> config set key
...`, then `<entry> doctor`), open `<entry>` and ask what it sees; or run
`<entry> run -- ARGS` and watch it supervise; or serve `<entry> mcp` to
Claude Code (section 6). Say what you added and why in the commit
message and, if the repository keeps one, its changelog.

If `abaikit check` reports a violation, read its location and message:
they name the file or the declaration and what the contract wanted.

## 6. Running an abaigram (use)

Session on the terminal, the person talking to the agent while the
program runs (turns mode in-process; sidecar attaches to or starts the
harness binary):

```
<entry>
```

Launch under supervision, the harness as the parent with the whole
lifecycle channel (pause, resume, stop, restart, status) and the
program's output observed from outside:

```
<entry> run -- ARGS
abaikit run <repo> -- ARGS        # the same, from outside the repository
```

An MCP client as the agent, no model configured anywhere: the client's
own agent uses the program's tools, and the client's permission prompt is
the person's consent.

```json
{ "mcpServers": { "myprog": { "command": "node", "args": ["/abs/path/to/dist/main.js", "abai", "mcp"] } } }
```

(An absolute path, or run `claude` from the repository root: the client
starts the command from wherever it is.)

```
claude -p "what is the program doing?" --mcp-config mcp.json --strict-mcp-config --allowedTools "mcp__myprog__*"
```

The machine-level model configuration, shared by every abaigram on the
machine, lives under `~/.abai/`:

```
<entry> config set provider anthropic|freetoken
<entry> config set model <id>
<entry> config set key <provider>          # read without echo
<entry> config set url <provider> <base url>
<entry> doctor                             # offline checks, then the model
```

Environment variables, all optional: `ABAI_MODE` (`turns` or `sidecar`,
overriding the manifest's first mode), `ABAI_HARNESS` (`off`, `null`,
`exercise`: check runs only; never set it for real use), `ABAI_HOME` (the
configuration directory, default `~/.abai`), `ABAI_RUN_DIR` (descriptors
of running programs, default `~/.abai/run`), `ABAI_HARNESS_BIN` (the
sidecar harness binary to spawn), `ABAI_HARNESS_MODULE` (the in-process
harness module to import), `ABAI_CHANNEL` (`terminal` or `none`),
`ABAI_ATTACH_WAIT_MS` (how long a touchpoint waits for a harness).

The audit log (`audit.path` in the manifest; default
`~/.abai/audit/<name>.jsonl`) records every act of control with its
reason, consent and outcome. Read it when you wonder what the agent did.

## 7. Where this instantiation departs from the contract (deviations)

The first four are in every manifest this stub writes, the last when
`sidecar` is declared, so an agent reading the manifest sees them too:

{{deviations}}

## 8. What never to do (never)

- Never rewrite, wrap or replace `main()`. The entry hook is a few
  inserted lines at its top; the program's own flow follows them.
- Never delete or reorder existing lines. A retrofit is additive; a
  reviewer should see only added lines and new files.
- Never put the stub behind a condition. The entry must be reachable on
  every invocation, or `check` cannot reach L1.
- Never leave a capability on the default `safepoint` dispatch in a
  program that never calls `app.safepoint()`: the call stays pending and
  `check` never reaches L3.
- Never block in a handler or a `set`. Long work belongs behind an
  `immediate`-dispatched async capability, or in a job the handler
  enqueues.
- Never declare an `example` whose call changes real state. The exercise
  run calls it; so will a curious agent.
- Never declare a knob without a safe `default` and `range`, a decision
  without the `default` the program chooses today, or a turn without a
  `timeout`.
- Never put secrets or credentials in content or `doc` fields; they are
  the prompt.
- Never claim a level `check` did not report, and never change a level by
  editing `abaigram.yaml` by hand: it is generated, and `check` compares
  it with the code.
- Never make `check.run` depend on the network, credentials, or state it
  does not create itself.
- Never touch `node_modules`, build output, or files `.gitignore` names.
