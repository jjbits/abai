# abaigrammar

The contract every abaigram satisfies.

Version 0.1, draft. 2026-10-22.

## 1. Purpose

A program is "written beforehand": pro, before; gram, written. An abaigram
is "written by AI": ab, by; ai. The difference is when the writing stops. A
program is fixed before it ships. An abaigram ships with an AI agent fused
in, and that agent stays active at install and during use: it talks with
the user, observes the program, and steers it.

This document is the abaigrammar. It plays the role a language
specification plays for a program. It defines what an abaigram is,
structurally, in terms that depend on no programming language: the pieces,
the entry, how the agent and the program are coupled, how the two run, what
the program must declare, what conformance means, and what it may cost.

It does not define what any particular abaigram does. What the agent does
at install, what it does during use, what it may see and change, whether it
may change the program itself: all of that is the abaigrammer's choice, made
in the slots this document reserves. A language gives you main() and says
nothing about what goes in it. The abaigrammar does the same.

Language instantiations implement this contract. They do not reinterpret it.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| abai | The project, and the library a program includes to become an abaigram. |
| abaigram | One instance: a program with an agent fused in. |
| abaigrammar | This contract. |
| abaigrammer | Whoever creates an abaigram, human or agent. |
| abaikit | The authoring tool. Itself an abaigram. |
| abaify | Turning an existing repo into an abaigram. |
| learnabai | The guide a coding agent reads to make or retrofit an abaigram; `abaikit learnabai` prints it. |
| stub | The program-side half of the abai library: manifest registrations and the program end of every channel. |
| harness | The agent-side half: the agent loop, the model connection, the user channel, and the agent end of every channel. |
| null harness | A harness that attaches, drains every channel, answers every decision with its default, and calls no model. The passive form, selected by `ABAI_HARNESS=null`, exercises no control and is used to measure overhead. The active form, selected by `ABAI_HARNESS=exercise`, drives declared knobs and capabilities with declared values and is used to demonstrate conformance. An instantiation provides it in the stub, in the harness binary, or in both; section 13 says which the check uses. |
| region | The memory the two halves share: cells, the event ring, reply slots, the large-payload arena, the parked flag, and the counters. Ordinary memory in-process; a mapped shared segment in sidecar mode. |
| attached | The state in which a harness is connected to the stub. Defined per mode in section 5. |
| parked | The state of an attached harness that is blocked waiting for something to happen. |
| touchpoint | A call from the program into the library that hands control to the agent. |
| channel | One of five defined ways the program and the agent exchange observation and control. |
| mode | One of three defined ways the harness executes relative to the program. |
| manifest | The program's declaration of everything the agent may observe and control. |
| content | The abaigrammer's prompts. |
| policy | The abaigrammer's rules on what the agent may do without asking. |
| attention | What wakes the agent. |
| safepoint | A point where the program has agreed the stub may run queued work on its behalf. |

## 3. Principles

1. **The program owns main().** The abai library is included. It does not
   wrap the program and it does not replace the entry point.
2. **The agent is invited.** It acts through declared channels and at
   declared touchpoints, and nowhere else.
3. **The program runs without the agent.** Every decision has a default,
   every knob has a default, and every turn has a timeout. A missing,
   failed, or disconnected harness degrades the abaigram to the plain
   program. In sidecar mode this is guaranteed by the process boundary. In
   thread mode the stub isolates harness faults as far as the language
   allows, and the instantiation documents what it guarantees. In turns
   mode the harness runs on the program's thread inside a touchpoint, and a
   harness fault there is a program fault; the abaigrammer accepts that by
   choosing the mode.
4. **Declared, not discovered.** The agent learns the program from the
   manifest, not by guessing at it.
5. **Control has policy and leaves a trail.** Every act of control is
   subject to a declared policy and is written to an audit log.
6. **One contract, three modes.** A channel means one thing. Modes differ
   only in which channels are live, when, and on which thread a handler
   runs.
7. **Language neutral.** Anything that depends on a language is an
   instantiation detail, not part of this contract.
8. **Costs the program nothing it did not ask for.** With no harness
   attached, every channel operation is bounded by one or two loads, at
   most two stores with a bounded copy, or one atomic increment of a
   counter; section 11.1 lists each. With a harness attached, no channel operation on the program's
   thread allocates, takes a lock, or blocks, and the only system call any
   of them makes is a single wake of a parked harness, when an event
   declared to wake it is emitted or a capability result is ready. The
   program's own handlers, which the stub runs on its behalf, cost
   whatever the program wrote. There are exactly three exceptions, each
   opted into by the abaigrammer by placing the call or making the
   declaration: a touchpoint blocks, `install` and `session` until they
   end and `turn` and `decide` up to their timeouts; a `safepoint()` call
   blocks while a cooperative pause is in effect; and a `large` event
   payload allocates. Section 11 is the cost model.

## 4. Structure

### 4.1 Two halves, one boundary

The program side is the program plus the stub. The program registers its
manifest with the stub, writes cells, emits events, serves capabilities,
and calls touchpoints.

The agent side is the harness. It loads the manifest and the content,
connects to a model, runs the agent loop, talks with the user, and drives
the agent end of every channel. The null harness is the degenerate case: it
does all of that except talk to a model or a user, and in its passive form
it also touches no control.

The boundary between the stub and the harness is the coupling. In turns and
thread modes it is a function-call boundary inside one process. In sidecar
mode it is a process boundary. Every channel means the same thing on both
sides of that choice.

### 4.2 What the program gives and what the library gives

The program gives three things:

- **Declarations**: the manifest, listing every cell, event, capability,
  decision, and turn (section 7).
- **Touchpoints**: the places where it hands control to the agent
  (section 4.3).
- **Content and policy**: the abaigrammer's prompts and rules
  (sections 8 and 10).

The library gives everything else: the agent loop, the model connection,
the user channel, attention, audit, machine-level configuration, and the
standard entry.

### 4.3 Touchpoints

A touchpoint is a call from the program into the stub that hands control to
the agent. There are four.

| Touchpoint | Meaning | Returns |
|---|---|---|
| `install` | Run once, when the abaigram is installed or first run. Uses the `install` content slot. | when the agent finishes, or the harness cannot be attached or disconnects |
| `session` | Open an interactive session between the agent and the user, in the program's context. This is what the standard entry calls. | when the user ends it, or the harness cannot be attached or disconnects |
| `turn(name)` | Give the agent a turn. The agent may read cells, write knobs, and call capabilities, then hands control back. Declared in the manifest with a timeout. Uses the content slot named `name` if one exists. | when the agent finishes its step, the timeout passes, or the harness disconnects |
| `decide(name, context)` | Ask the agent which way to go (section 5.4). | the chosen answer, or the default |

Attaching. The stub initiates an attach in exactly five places: at
startup, when a sidecar launch handed the process a connection or when
`ABAI_HARNESS` selects a null harness; at the standard entry; at
`install`; at `session`; and at an explicit `attach()` call the program
may make when it wants the agent present from the beginning. `turn` and
`decide` never connect, spawn, or reconnect. With no harness attached,
`turn` returns at once having done nothing, and `decide` returns its
default at once; the stub counts both (section 10). Separately, a harness
may itself connect to the stub's endpoint at any time and the stub
accepts it; that is how a lost connection is restored and how an outside
harness reaches a running program that never calls a touchpoint.

Attaching fails at once, without contacting any model, when the machine
configuration has no model configured. So a program that calls `attach()`
at startup on an unconfigured machine runs as the plain program from the
start, and on a machine whose configured model is unreachable it pays at
most one touchpoint's timeout to find out.

Detaching. A harness that cannot reach its model, or that fails, detaches.
Its attempt to reach the model is bounded by a connect timeout in the
machine configuration, default 30 seconds, so `install` and `session`,
which have no timeout of their own, still return within that bound when
the model is unreachable. The touchpoint that was in progress returns as
the table says, and every later touchpoint returns at once until the stub
next initiates an attach or a harness connects. This is how principle 3
holds when the model is unconfigured or unreachable.

In turns mode, touchpoints are the only time the agent runs. In thread and
sidecar modes they remain the synchronous points; everything else is live.
Every touchpoint is also a safepoint (section 5.3). A touchpoint reached
during a cooperative pause blocks at that safepoint until `resume`, and its
own timeout clock starts only then; the stub emits `abai.pause.blocked`
with the touchpoint's name, which wakes the agent, so the agent knows what
its pause is holding.

### 4.4 The standard agent entry

Every abaigram exposes one entry by which a person or another agent reaches
the agent without knowing the program:

```
<prog> abai                  open a session
<prog> abai install          run the install touchpoint
<prog> abai run -- ARGS      sidecar launch: the harness starts "<prog> ARGS"
                             as a supervised child
<prog> abai config           machine-level model and credential settings
<prog> abai doctor [--offline]
                             offline: manifest, entry, content, supported
                             modes; online, unless --offline: model
                             reachability and constraints
<prog> abai manifest         print the effective manifest
<prog> abai mcp              serve the agent's tools to an MCP client over
                             stdio; the client's agent is the program's
```

Overhead is measured by `abaikit check` (section 11.6), not by `doctor`,
because measuring needs builds and runs that an installed program cannot
make of itself.

The stub provides the entry. It implements `manifest` and the offline half
of `doctor` itself; everything else it delegates to the harness, in-process
under turns and thread modes and to the harness binary under sidecar mode.
The manifest's `entry` is this entry as a command line: run by the
system shell in the repository root, alone or with a verb appended, it
reaches the entry, so it ends with the word `abai`. Examples:
`./bin/myprog abai`, `node dist/main.js abai`; `myprog abai` only once
`myprog` is on the PATH. Tools such as `abaikit check` and `abaikit run`
reach a program only through it, and `check` reports an entry that does
not end in `abai`. A program that cannot accept a subcommand, such as a
GUI application or a library, provides a small command-line equivalent
and names that as its `entry`.

Mode selection. `run` is always sidecar launch. Any other invocation,
including a plain `<prog> ARGS` that later calls a touchpoint, uses the
first mode declared in the manifest's `modes`, and the `ABAI_MODE`
environment variable overrides that. Nothing else is consulted, so the
mode is known at startup without reading any file. A selected mode the
manifest does not declare is an error at the entry, and for a plain
invocation falls back to the manifest default and is counted like a
defaulted decision (section 10).

Harness selection is a separate variable, `ABAI_HARNESS`, read only by
`abaikit check` runs: unset means the real harness; `off` makes every
attach fail at once; `null` attaches the passive null harness at startup;
`exercise` attaches the active null harness at startup. It never changes
the execution mode. Under turns or thread
mode, `<prog> abai` runs the session in-process. Under sidecar mode it
connects to a running harness or spawns one, in attach form
(section 6.3).

### 4.5 The user channel

The harness owns interaction with the user. The default user channel is the
terminal. A program with its own interface may supply its own user channel
to the harness. In turns mode the user channel is used while the program is
paused inside a touchpoint. A harness may have no user channel at all, for
example under sidecar launch of a daemon; section 10 says what `confirm`
means then. An MCP client is a user channel: it puts each tool call to the
person before it runs, or runs it under an allowance the person gave
beforehand; a harness serving such a client treats the client's permission
decision as the person's consent.

## 5. Channels

Five channels connect the two halves. Each has one direction, one timing
rule, and one cost rule.

Common rules:

- Every cell, event, capability, decision, and turn is declared in the
  manifest with a `name` and a `doc`. Cells have a `type`; events,
  capabilities, and decisions have schemas; turns have a `timeout`.
- Names are lowercase identifiers. A dot groups segments, such as
  `queue.depth`; an underscore joins words inside a segment, such as
  `on_backlog`. Names beginning with `abai.` are reserved for the library.
- The `doc` is prose the agent reads. It is the primary way the program
  explains itself.
- Types are a small language-neutral set. Scalars, which fit one machine
  word: `bool`, `int`, `float`, `enum`. Sized values: `string` with a
  `max` byte length, default 256; `object` and `list` described by a
  JSON-shaped schema with a `max` encoded byte length, default 1024. A
  schema field may be written as a bare type name when the defaults
  suffice, such as `job_id: string`, or as an object with `type` and
  `max`, such as `error: { type: string, max: 512 }`.
- The region. The stub sets up the region at startup. In turns and thread
  modes it is ordinary process memory and costs nothing to set up. In
  sidecar mode it is a shared memory segment the stub maps at startup; the
  stub also creates its listening endpoint and one receiving thread, which
  blocks on that endpoint until a harness connects. The mapping, the
  endpoint, and the parked thread are the stub's only startup costs, and
  they are made only when the selected mode is sidecar. Cells always live
  in the region, attached or not, so a harness that attaches late sees
  every value the program has written.
- **Attached** means: in turns mode, the in-process harness has been
  initialized at one of the five places in section 4.3; in thread mode,
  the harness thread is running; in sidecar mode, a connection to a
  harness process is established. When it is false: a cell write still
  stores; an event emit and a `safepoint()` check do one load and nothing
  more; `decide` and `turn` do one load and one counter increment.
- Every channel may be used from any program thread, with one
  restriction: a sized `read` cell has one writer thread, which the
  program guarantees. Ordering guarantees are per thread. The cost bounds
  below hold per operation on the calling thread.

### 5.1 events

Program to agent. Push. Asynchronous.

Declaration: `name`, `payload` schema, `doc`, `wakes` (`always`, `never`,
or a condition on the payload; default `never`), `large` (default
`false`).

Semantics:

- The program emits an event with a payload. The call never blocks and
  always returns at once. When no harness is attached the emit does
  nothing.
- Events go through a bounded ring in the region. A slot holds a payload
  of 4096 bytes, counted as the sum of the payload's fields' declared
  `max` sizes with each scalar counted as 8 bytes; the slot header and
  any encoding overhead are the instantiation's and lie outside that
  count. A payload whose count exceeds 4096 must be declared `large`, and
  manifest validation enforces this without knowing the instantiation.
  The ring is multi-producer: an emitter claims a slot with one atomic
  increment, copies the payload by value into the slot, and publishes it
  with a sequence number. Sized fields are truncated to their `max`, and a
  flag in the slot header records that truncation happened.
- When the ring wraps, the oldest unread slot is overwritten. The harness
  detects the gap from the sequence numbers and synthesizes an
  `abai.events.dropped` event, carrying the count, at the gap's position
  in the stream. The program never emits that event itself, so a full ring
  cannot displace its own loss report. The harness never delivers a slot
  whose sequence is out of order. A producer lapped before it publishes
  is handled as the instantiation fixes, under one rule: the emitter
  never blocks or spins unboundedly, and dropping the lapped emit and
  counting it is acceptable.
- Delivery is at most once, and in emission order per emitting thread.
- Waking. If the event's `wakes` is not `never` and the harness is parked,
  the emitter makes one wake system call. A condition counts as `always`
  for this purpose; the harness evaluates the condition and goes back to
  sleep if it does not hold. If the harness is not parked, no system call
  is made.
- `large: true` marks an event whose payload cannot fit a slot. The stub
  copies it into the region's arena on the program's thread. That copy
  allocates from the arena, and is one of the three exceptions in
  principle 8. The slot carries a reference to the arena block, so the
  payload reaches the harness with no further system call. When the arena
  is exhausted the event is dropped and counted; the emitter never blocks
  on arena space.
- In turns mode the ring is written while attached and drained at the next
  touchpoint. The ring size bounds how much history that touchpoint sees.
  In thread and sidecar modes events are delivered live.

Cost: one load of the attached flag; then one atomic slot claim, a bounded
copy no longer than the payload's declared sizes, and two sequence stores;
plus at most one wake system call when the harness is parked and the event
wakes. No allocation and no lock, except for `large` events.

### 5.2 cells

Shared. Real time. Readable by the agent at any time; writable cells are
readable by both and writable by the agent, and the program may reset
them.

Declaration: `name`, `type`, `access` (`read` or `readwrite`), `doc`,
`default` (required for `readwrite`), optional `range` or `enum`, optional
`cadence` hint in milliseconds, and for `readwrite` cells a `policy`
(`auto` by default, or `confirm`) and, for sized knobs, a delivery
`timeout` (default 30 seconds).

Semantics:

- A `read` cell is written by the program and read by the agent. It is
  observation. Cells are written whether or not a harness is attached.
- A `readwrite` cell is a knob. The agent writes it; the program reads it
  at its own cadence and applies it. The program may reset a knob through
  the stub, for example back to its default. Last writer wins.
- Every cell carries a version counter that advances on every write. It is
  a change counter, not a transaction id. The harness records the time at
  which it observed each change; the program writes no timestamps.
- A scalar cell is one machine word in the region. A write is one atomic
  store of the value and one store to the version. A reader sees a value
  that was current at some instant during its read, and a version that
  may be one write ahead of or behind that value. Scalar knobs are written
  by the harness the same way, directly into the region.
- A sized `read` cell lives in a fixed slot of its `max` length in the
  region, under a per-cell sequence lock. It has one writer thread, which
  the program guarantees. The writer sets the version odd, copies the
  value, and sets the version even. The harness, the only reader, retries
  when it sees an odd version or a version that changed during its copy.
  That retry is on the harness side and costs the program nothing.
- A sized knob is delivered, not stored for the program to poll. The
  harness's write is handed, by value, to a handler the program registered
  for that knob, at the program's next safepoint, on the thread that
  reached it, the way a safepoint-dispatched capability call is delivered,
  and its outcome goes back through a reply slot the same way. The write
  waits up to the knob's delivery `timeout` for a safepoint; undelivered,
  it fails and is audited as failed rather than as done. The harness keeps
  a mirror of each sized knob's current value in the region, which it
  alone writes: on a delivered write, and on a program reset, which
  reaches it as the event `abai.knob.reset` carrying the value. So the
  harness can read and watch a sized knob like any other cell, every
  sized slot in the region has exactly one writer, and there is no lock
  anywhere on the program side.
- In thread and sidecar modes the harness reads cells without the
  program's cooperation at read time. In sidecar mode this means the
  mapped region. A snapshot read visits every cell once in one pass; each
  cell is individually consistent, and there is no cross-cell atomicity.
- In turns mode cells are read by the agent only at touchpoints.
- In thread and sidecar modes the agent may register a **watch** on a
  cell: `changed`, `eq`, `ne`, `gt`, `lt`, `crossed`. The harness
  evaluates watches by polling the cell at a bounded interval, by default
  the cell's `cadence` hint or the harness's own default. A watch firing
  is attention. Watches cost the program nothing. In turns mode there is
  no harness between touchpoints to poll, so there are no watches.

Cost, scalar cell write: one store to the value, one store to the version.
Cost, sized cell write: one store to the version, a bounded copy, one
store to the version. Cost, scalar knob read: one load. Cost, sized knob
delivery: the handler's own cost at a safepoint the program chose, one
reply slot write, and at most one wake. Cost, knob reset: a scalar store
for a scalar knob, or one event emit for a sized knob. No allocation and
no lock, in any mode, attached or not; no system call except the wakes
named.

### 5.3 capabilities

Agent to program. Call. Returns a result.

Declaration: `name`, `params` schema, `result` schema, `doc`, `effect`
(`read` or `mutate`), `dispatch` (`immediate` or `safepoint`), `timeout`
(default 30 seconds), `policy` (`auto`, `confirm`, `forbid`), and an
optional `example` of valid parameters, which is what the active null
harness calls it with during `check`; a capability without one is
reported unexercised. Defaults: `effect: read` gives `policy: auto`;
`effect: mutate` gives `policy: confirm`; `dispatch` is `safepoint`.

Semantics:

- The agent calls a capability with parameters. The program's handler runs
  and returns a result or an error. The agent sees one or the other, or a
  timeout. Parameters arrive through the region; the result is written to
  a reply slot in the region, and if the harness is parked waiting for it
  the stub makes one wake system call. The encoding is the wire format the
  instantiation fixes (section 14).
- `dispatch: immediate` runs the handler as soon as the call arrives: in
  turns mode on the program's thread inside the touchpoint, in thread mode
  on the harness thread, in sidecar mode on the stub's receiving thread.
  The program is responsible for the handler being safe to run there.
- `dispatch: safepoint` queues the call until the program next reaches a
  safepoint: a touchpoint, or an explicit `safepoint()` call the program
  makes in its own loop. The handler runs on whichever thread reached the
  safepoint, and the program is responsible for the handler being safe on
  any thread that calls `safepoint()`.
- Inside a touchpoint the safepoint queue is drained whenever the agent
  issues a safepoint-dispatched call, and again before the touchpoint
  returns. In turns mode such a call therefore runs at once, and the agent
  sees its result within the same step.
- In thread and sidecar modes, a safepoint-dispatched call waits up to its
  `timeout` for the program to reach a safepoint. If none is reached the
  agent receives a timeout error and the call is discarded.
- A capability is never required for the program's own operation. It is a
  door the program opens for the agent.

Cost: nothing until the agent calls. A `safepoint()` check is one load of
a flag when nothing is queued and no pause is in effect. A queued call is
handled only where the program chose to handle it, and delivering its
result costs at most one wake system call.

### 5.4 decisions

Program to agent. Synchronous. The program blocks.

Declaration: `name`, `context` schema, either `options` (an enum of
choices) or `answer` (a schema), `default` (required), `timeout`
(required), `doc`, `policy`. A manifest with a decision or a turn that
lacks a timeout does not validate.

Semantics:

- The program calls `decide(name, context)` and blocks until it has an
  answer.
- With a harness attached, the harness wakes the agent with the context.
  The agent answers with one of the options, or with a value matching the
  answer schema. The timeout clock starts at the call, or at `resume` if
  the call arrived during a cooperative pause.
- If no harness is attached, `decide` returns the `default` at once and
  increments the decision's counter. It never connects or spawns.
- If the timeout passes, the harness detaches, or the answer is invalid,
  the `default` applies. The default may be the special value `abort`,
  meaning the program should stop rather than proceed without the agent.
- Policy. `auto`: the agent's answer applies. `confirm`: the agent's
  answer is shown to the user and applies only if approved within the
  decision's timeout; with no user channel connected the default applies
  at once. `forbid`: the agent is never asked and the default applies.
- The answer, its source (`agent`, `default`), and the reason for a
  default (`no_harness`, `timeout`, `invalid`, `detached`, `denied`,
  `forbidden`) are written to the audit log.

Cost: the program waits, by design, for as long as the agent takes, up to
`timeout`. A decision belongs at a branch point where waiting is
acceptable, never inside a loop the program depends on for throughput.
Section 11.5 asks the abaigrammer to budget them.

### 5.5 lifecycle

Agent to program. Out of band.

Operations: `status`, `start`, `pause`, `resume`, `stop`, `restart`.

Declaration, in the manifest's `lifecycle` block: `pause` (`cooperative`,
`os`, or `none`), `stop` with a `graceful` timeout and the name of a stop
handler the program registers with the stub, and a `policy` per operation.
Defaults: `pause` and `resume` are `auto`; `stop` and `restart` are
`confirm`.

Semantics:

- Under sidecar launch, where the harness is the program's parent, every
  operation is available. Under sidecar attach, only `status` and graceful
  `stop` are. In turns and thread modes there is no lifecycle channel.
- `cooperative` pause sets a flag the program observes at safepoints and
  touchpoints. While the flag is set, `safepoint()` blocks on an operating
  system wait primitive until `resume`. This is one of the three exceptions
  in principle 8, and the abaigrammer opts into it by declaring
  `pause: cooperative`. `os` pause uses the platform's stop and continue
  signals. `none` means the program cannot be paused.
- Graceful `stop` runs the program's stop handler at its next safepoint,
  on the thread that reached it, and expects the program to exit. Under
  launch, the harness forces the program to stop after the `graceful`
  timeout. Under attach, it reports that the program did not stop.
- `restart` is `stop` followed by `start`. Nothing carries over unless the
  program itself persists it.
- The program's exit, normal or by crash, is reported as the event
  `abai.lifecycle.exited` with its status.

Cost: nothing on the program's thread except the cooperative pause flag,
which is one load at safepoints, the wait itself while paused, and the stop
handler's own cost when a stop is requested.

### 5.6 attention

Attention is not a channel. It is what wakes the agent. A model call takes
seconds, so the agent observes continuously but reacts only when woken.
Between wakes the harness is parked: it blocks on its wake primitive, and
polls cells for watches at a bounded interval. Parked, it costs the
program nothing.

Sources:

- an event declared with `wakes`, delivered edge-triggered as in 5.1;
- a watch on a cell, found by the harness's bounded polling;
- a decision, which always wakes;
- input from the user;
- a timer the agent set for itself;
- a lifecycle event: the program exited or crashed;
- a touchpoint: `install`, `session`, or `turn`.

Rules:

- Wakes that arrive while the agent is mid-step are coalesced and delivered
  together at the next step.
- The manifest may declare an attention `budget`: maximum wakes per period
  and maximum model tokens per period. Beyond the budget, event and watch
  wakes are folded into a summary and logged, a `turn` returns at once
  with nothing done and is audited with reason `budget`, and decisions
  still wake.

### 5.7 Outside observation

When the harness launched the program, it also observes the program from
outside, with no declaration needed: standard output, standard error, exit
status, and resource use. These arrive as `abai.io.stdout` and
`abai.io.stderr` line events and `abai.lifecycle.exited`. This is the
observation floor. It exists even for a program with an empty manifest,
which is what makes abaify's first rung cheap.

Cost: the program writes to a pipe instead of a terminal. The kernel pipe
buffer is the only backpressure, and a reader that stops would block the
program on it. So the harness reads each pipe on a dedicated thread that
never stops, and under load it discards lines and reports the count,
rather than fall behind.

## 6. Execution modes

An abaigram declares which modes it supports. Section 4.4 says how one is
selected per run.

### 6.1 turns

One process, one thread. The in-process harness is linked into the
program but attached only once one of the five places in section 4.3
initializes it; a program that wants the agent from the start calls
`attach()` at startup. Initialization loads the machine configuration and
the content, and fails at once if no model is configured; a configured
model is first contacted at the first touchpoint that needs it, and a
failure there detaches the harness as section 4.3 says.

Once attached, the harness runs only inside a touchpoint, on the program's
thread, until the agent finishes its step or, for a turn or a decision,
its timeout passes. Model calls block the program.

Live: capabilities and decisions, at touchpoints. Events are recorded while
attached and read at touchpoints; cells are always written and read at
touchpoints. No lifecycle. Attention sources are touchpoints and user
input only.

This is the simplest mode to build and test, and the natural first rung of
abaify for a command-line program. It requires an in-process harness in the
program's language. A harness fault inside a touchpoint is a program fault.

### 6.2 thread

One process. The harness runs on its own thread inside the program's
process, started at one of the five places. Attached means that thread is
running.

Live: everything except lifecycle. Cells are live; the region is ordinary
memory. Events are delivered live. Capabilities follow their `dispatch`.
Decisions and turns block only the calling thread.

The stub must isolate harness faults so that the program keeps running as
a plain program, as far as the language allows, and the instantiation
documents what it guarantees. A language whose instantiation cannot
isolate them must not declare thread mode. This mode also requires an
in-process harness in the program's language.

### 6.3 sidecar

Two processes. The program includes only the stub. The harness is a
separate process. They connect over a local transport, a Unix domain socket
or a named pipe, never a network socket by default. Attached means that
connection is established. The region is a shared memory segment the stub
maps at startup and the harness maps at attach, so the agent reads cells
and events without the program's involvement, capability results come
back through it, and the program wakes a parked harness with at most one
system call.

Live: everything. Lifecycle is available under launch.

Two ways to start:

- **launch**: `<prog> abai run -- ARGS`, or `abaikit run`. The harness
  starts, then starts the program as its supervised child and hands it a
  connection, which the child's stub takes up at startup; the child is
  attached before its main() runs. Full lifecycle and outside
  observation.
- **attach**: the program is already running. At the standard entry,
  `install`, `session`, or an explicit `attach()`, the stub connects to a
  running harness or spawns one. Lifecycle is limited to `status` and
  graceful `stop`.

The harness binary is found on `PATH`, at a path recorded in the manifest,
or from the machine configuration. A harness crash leaves the program
running as a plain program. The connection is restored when a harness
connects to the stub's endpoint, where the receiving thread has been
waiting since startup, or when the stub next initiates an attach at one
of the five places.

This is the reference mode. It delivers the whole contract, isolates the
agent's cost from the program, and needs only a stub per language, so one
harness serves every language.

### 6.4 Mode table

| | turns | thread | sidecar |
|---|---|---|---|
| processes | 1 | 1 | 2 |
| attached means | in-process harness initialized | harness thread running | connection established |
| region | process memory | process memory | shared segment |
| events | recorded while attached, read at touchpoints | live | live |
| cells | always written, read at touchpoints | live | live |
| capabilities | at touchpoints | per dispatch | per dispatch |
| immediate handler runs on | program thread | harness thread | stub's receiving thread |
| decisions and turns | yes | yes | yes |
| lifecycle | no | no | launch: full; attach: status, graceful stop |
| outside observation | no | no | under launch |
| agent cost on program | blocks at touchpoints | shares CPU and memory | isolated |
| needs harness in program's language | yes | yes | no |

## 7. Manifest

The manifest is the program's declaration of everything the agent may
observe and control, plus where the content lives and which modes are
supported.

It exists in two forms that must agree:

- **In code.** The program registers its cells, events, capabilities,
  decisions, and turns with the stub at startup. This is the source of
  truth at runtime.
- **In the repo.** A file, `abaigram.yaml` at the repository root,
  generated by `<prog> abai manifest` and checked in. This is what tools
  and agents read without running the program, and what `abaikit check`
  verifies against the code.

Top-level fields:

```yaml
abaigrammar: "0.1"         # version of this contract
name: <prog>
entry: "./bin/<prog> abai"  # the standard entry as a command line run in the repository root, ending in abai
modes: [sidecar, turns]    # supported; the first is the default
harness:                   # optional: where to find it
  path: null
model:                     # optional constraints on the model
  tools: true
check:                     # optional; required for conformance above L1
  run: "make bench"        # command that exercises the program's channels
  overhead: "5%"           # optional: max slowdown with the null harness attached
content:
  identity: abai/identity.md
  install:  abai/install.md
  use:      abai/use.md
  turns:    abai/turns/    # one file per named turn or decision
cells: []
events: []
capabilities: []
decisions: []
turns: []
lifecycle:
  pause: cooperative
  stop: { graceful: 10s, handler: shutdown }
attention:
  budget: { wakes_per_minute: 30, tokens_per_hour: 200000 }
policy:
  confirm_timeout: 60s     # a confirm unanswered this long is denied
audit:
  path: ./abai-audit.log
deviations: []             # optional: where the instantiation departs from this contract, one sentence each
```

An example with one of each declaration:

```yaml
cells:
  - name: queue.depth
    type: int
    access: read
    doc: Number of jobs waiting. Rises when producers outpace workers.
  - name: worker.count
    type: int
    access: readwrite
    default: 4
    range: [1, 64]
    cadence: 1000
    doc: Active worker threads. The pool resizes within a second of a change.
events:
  - name: job.failed
    payload: { job_id: { type: string, max: 64 }, error: { type: string, max: 512 } }
    wakes: always
    doc: A job exhausted its retries.
capabilities:
  - name: job.retry
    params: { job_id: string }
    result: { ok: bool }
    effect: mutate
    dispatch: safepoint
    timeout: 5s
    policy: confirm
    example: { job_id: "job-0001" }
    doc: Requeue a failed job once.
decisions:
  - name: on_backlog
    context: { depth: int, workers: int }
    options: [scale_up, shed_oldest, wait]
    default: wait
    timeout: 5s
    doc: Asked when the queue depth crosses the high-water mark.
turns:
  - name: end_of_batch
    timeout: 30s
    doc: After each batch completes. The agent may tune worker.count.
```

A program may also register declarations dynamically at runtime, for
example from plugins. The checked-in manifest marks such entries
`dynamic: true`, and `check` verifies only that the static ones agree.

An instantiation that departs from this contract declares each departure
in `deviations`, one sentence naming the section, in every manifest it
writes; a program may add its own. A tool or an agent reading the manifest
then knows what it is dealing with, and `abaikit learnabai` prints the
instantiation's.

## 8. Content

Content is the abaigrammer's prompts. The abaigrammar reserves the slots and
says nothing about what goes in them.

| Slot | Required | Used when |
|---|---|---|
| `identity` | yes | Always. Who the agent is for this program, what it is for, how it should behave. |
| `install` | no | The `install` touchpoint. |
| `use` | no | Sessions and live operation. |
| `turns/<name>` | no | The `turn` or `decide` touchpoint of that name. |

The default location is an `abai/` directory at the repository root. The
manifest may point elsewhere.

The harness composes the agent's system prompt from `identity`, the mode in
use, and the manifest's declarations rendered with their docs. The
abaigrammer never describes the channels by hand. Describing the program
well in the manifest's `doc` fields is most of the work of writing good
content.

## 9. Model connection

The harness connects to a model the way any agent harness does: through a
configured provider and credentials. The abaigrammar is provider-neutral
and bundles no model. An instantiation may bundle or default to one.

Configuration is machine-level and shared by every abaigram on the machine,
including abaikit. It lives under a per-user directory, `~/.abai/`, with
credentials in the operating system's credential store where one exists,
or in a permission-restricted file otherwise. `<prog> abai config` edits it
and the online half of `<prog> abai doctor` verifies it.

The manifest may state constraints the model must meet, such as tool use.
`doctor` checks them online. Nothing in conformance (section 12) requires
a model.

## 10. Policy and audit

Every act of control is subject to a policy: `auto`, `confirm`, or
`forbid`.

| Act | Default policy |
|---|---|
| read a cell, receive an event | not subject to policy |
| write a knob | `auto` |
| call a capability with `effect: read` | `auto` |
| call a capability with `effect: mutate` | `confirm` |
| answer a decision | `auto` |
| lifecycle `pause`, `resume` | `auto` |
| lifecycle `stop`, `restart` | `confirm` |

`confirm` asks the user through the user channel and proceeds only on
consent. If no user channel is connected, or the user does not answer
within the manifest's `confirm_timeout`, the act is denied and audited as
such. For a decision, `confirm` and `forbid` mean what section 5.4 says.
`forbid` removes the act from what the agent is offered.

During the exercise run of `abaikit check` (section 12), the active null
harness, selected by `ABAI_HARNESS=exercise`, stands in for the
abaigrammer's own consent: `confirm` acts are treated as approved, and
`forbid` acts are not exercised. It writes each knob's `default` and calls
each capability with its `example`. It never issues lifecycle operations.
That run drives every declared knob and capability live, so `check` must
be pointed only at a program whose `check.run` is safe to drive that way.
The measurement runs of section 11.6 use the passive null harness,
selected by `ABAI_HARNESS=null`, which exercises no control.

Under `abaikit abaify` (section 13) the person's invocation is the consent
for the agent's `confirm` acts in that run, and abaify says so when it
starts and in its report. Under an MCP client, section 4.5 says what
consent is.

The audit log records every knob write with its outcome, capability call,
decision answer with its source and reason, turn with its outcome, and
lifecycle operation, with timestamps and the agent's stated reason. Its
location is declared in the manifest. While no harness is attached the
stub keeps only counters: one per decision and per turn, incremented once
per defaulted decision or skipped turn, and one for mode fallback at
startup. The next harness to attach reads the counters, resets them, and
writes one audit line per counter with the count. The harness can read
the log back, so the agent can account for what it has done.

Whether the agent may change the program's own code at use time is not a
question the abaigrammar answers. An abaigrammer who wants it declares a
capability for it and sets its policy. Nothing happens otherwise.

## 11. Performance

The abai library must not degrade the program it joins. Where the cost
cannot be zero, it must be the minimum the operation admits. This section
is the cost model every instantiation must meet and every `check` must
measure.

### 11.1 Cost when no harness is attached

| Operation | Cost |
|---|---|
| write a scalar cell | one store to the value, one store to the version |
| write a sized cell | one store to the version, a bounded copy, one store to the version |
| read a scalar knob | one load |
| reset a knob | a scalar store, or one load of the attached flag for a sized knob |
| emit an event | one load of the attached flag |
| `safepoint()` | one load of a flag |
| `decide`, `turn` | one load of the attached flag, one atomic increment |

Nothing else runs. Registration at startup is static data. Setting up the
region at startup is the only startup cost: nothing in-process; in sidecar
mode one mapping of a small shared segment, one listening endpoint, and
one receiving thread that blocks until a harness connects. The stub
initiates an attach only at the five places of section 4.3.
`ABAI_HARNESS=off` makes every attach fail at once, which is how the
unattached state is forced for measurement. An instantiation may
additionally offer a build-time switch that compiles the stub out
entirely, leaving cells as plain variables.

### 11.2 Cost on the program's thread when attached

| Operation | Bound |
|---|---|
| write a scalar cell | one store to the value, one store to the version |
| write a sized cell | one store to the version, a bounded copy, one store to the version |
| read a scalar knob | one load |
| receive a sized knob | the handler's own cost, at a safepoint the program chose; plus one reply slot write and at most one wake system call |
| reset a knob | a scalar store, or for a sized knob one event emit |
| emit an event | one atomic slot claim, a bounded copy, two sequence stores; plus at most one wake system call when the harness is parked and the event wakes |
| `safepoint()` | one load of a flag; handlers run only if one is queued |
| serve a capability | the handler's own cost, only when the agent calls, only where dispatch allows; plus at most one wake system call to deliver the result |

No operation in this table allocates, takes a lock, blocks, or makes a
system call, apart from the single wakes named in the table and whatever
the program's own handlers do in the two handler rows. This holds in every
mode.

The three opt-in exceptions:

| Operation | Cost | Opted into by |
|---|---|---|
| a touchpoint | `install` and `session` block until they end; `decide` and `turn` block up to their `timeout`, after any cooperative pause holding them | placing the call |
| `safepoint()` during a cooperative pause | blocks until `resume` | declaring `pause: cooperative` |
| emit a `large` event | allocates from the arena and copies on the program's thread | declaring `large: true` |

### 11.3 Where the agent's cost goes

- **sidecar** isolates it. The harness's CPU, memory, model client, and
  serialization run in another process. Cells, events, and results cross
  through the shared region, so the only system call per operation is the
  occasional wake of a parked harness. This is the main reason sidecar is
  the reference mode.
- **thread** shares the process. The harness thread competes for CPU and
  adds its memory footprint. Between wakes it must block, not spin; its
  only periodic work is polling cells for watches at a bounded interval;
  and it must never hold a lock the program's thread can contend on.
- **turns** puts model latency directly into the program's critical path at
  every touchpoint. That is the mode's nature, and it is acceptable only
  where the abaigrammer has decided that waiting is fine.

### 11.4 Footprint

In sidecar mode the stub carries no model client and no HTTP stack. It
contains: the registry of declarations; the region, with its cells, event
ring, reply slots, arena, parked flag, and counters; a transport client
and a minimal encoder for the wire format of section 14; harness discovery
and spawning, which reads the machine configuration; the standard entry's
`manifest` and offline `doctor`; and the safepoint queue. In turns and
thread modes the harness is in-process, and its footprint is the price of
the mode.

### 11.5 Budgets

Touchpoints and cooperative pauses are the only channel operations that
stop the program. The abaigrammer places them and should budget them.
The manifest's attention budget bounds how often the agent acts. A
decision or turn without a timeout fails manifest validation; capabilities
have a default timeout.

### 11.6 Measurement

Cost claims are measured, not asserted. An instantiation meets section 11
when two things hold. Its test suite instruments every row of the table
in 11.1 and of the first table in 11.2, with the program's own handlers
replaced by empty ones, and proves, pass or fail, that the row performs
no allocation, takes no lock, does not block, and makes no system call
beyond the wake the row names. And it publishes the measured cost of every
row on a reference machine, so the abaigrammer can see what each
operation costs in absolute terms. The exceptions table in 11.2 is
outside this test; its rows block or allocate by definition.

For an abaigram, `abaikit check` measures overhead without a model, when
the manifest declares a `check.run` command. It runs that command,
building first where the instantiation builds, three ways: with the stub compiled out, where the instantiation
offers that; with `ABAI_HARNESS=off`, so nothing attaches; and with
`ABAI_HARNESS=null`, so the passive null harness attaches at startup,
drains events, polls cells, answers decisions with their defaults, and
exercises no control. It does this under each mode the manifest declares,
set through `ABAI_MODE`, and reports the results side by side. If the manifest declares `check.overhead`, the
null-harness run must not exceed that slowdown over the `off` run, and
`check` fails otherwise. With no `check.overhead`, the numbers are
reported and nothing fails. With no `check.run`, nothing is measured and
`check` says so.

`check` reports the measurement with its spread: the medians of a number
of runs of each kind, stated in the report, the kinds interleaved so
drift lands on both, with their minimum and maximum, and it says when the
numbers are within noise (a short `check.run`, or overlapping ranges) so
that no slowdown is read from them; a declared `check.overhead` still
fails the check when the median slowdown exceeds it. An instantiation that
keeps the null harness inside the program's process under sidecar mode
declares that deviation (section 7); its measured overhead then leaves
out what observation costs across the transport, and the report says so.

## 12. Conformance

Conformance has two axes: a level, and the set of supported modes. No
level requires a model; every check runs against the null harness.

| Level | Name | Requires |
|---|---|---|
| L1 | reachable | The library is included. The standard entry works. `abaigram.yaml` exists, validates, and agrees with the code. `identity` content exists. The offline half of `doctor` passes. Checked without running the program's own code beyond the entry. |
| L2 | observable | L1, plus a `check.run` command, plus at least one cell or event the program writes or emits during the exercise run. |
| L3 | steerable | L2, plus at least one capability the active null harness calls successfully with its `example`, or one knob whose write by the active null harness lands, a scalar store or a delivered sized value, during the exercise run. |
| L4 | deliberative | L3, plus at least one decision the program reaches during the exercise run. |

L1 is judged from the entry alone (`<entry>` is the manifest's `entry`):
what `<entry> manifest` prints is byte for byte the checked-in
`abaigram.yaml`, and `<entry> doctor --offline` reports no failed check.

The levels above L1 are judged from one run of `check.run` per declared
mode under `ABAI_HARNESS=exercise`, which attaches the active null
harness at startup and drives every declared knob and capability as
section 10 says; the judgment reads the report the null harness gives at
exit. That run is separate from the measurement runs of 11.6, whose null
harness is passive, so control activity never pollutes the overhead
numbers. The evidence is the program's own: a cell counts when the
program wrote it (a knob the harness wrote does not), an event when the
program emitted it (the library's own `abai.*` events do not), a
capability when its `example` call succeeded, a knob when its write
landed, a decision when the program asked it, whatever answered it. A
program's level is the lowest reached under every mode it declares, or
under the one mode `check` was pointed at, and the report shows each
mode.

`check` passes at a level only with no violation: a stale manifest, a
failed `doctor` check, an exceeded `check.overhead`, a `check.run` that
fails or does not finish in the time `check` allows it, which the report
states, are violations even when the level is reached. A program whose channels are reached only by paths
`check.run` does not take is at the level `check` can demonstrate, not
the level the abaigrammer intended, and the report names every
declaration that went unexercised: capabilities without an `example`,
knobs whose write did not land, cells never written, events never
emitted, decisions and turns never reached.

The levels are ordered so that observation, which is safe, comes before
control, which is not. At every level the abaigram's instantiation must
meet section 11, and when `check.overhead` is declared the abaigram itself
must meet it.

`abaikit check` reports the level reached and the level under each mode,
the supported modes, the measured overhead with its spread, the
unexercised declarations, and every violation with its location.

## 13. abaikit

abaikit is the authoring tool and the first abaigram. Its main() hands
control to the harness at once. Its manifest declares its operations as
capabilities, which are also its subcommands; `abaify` and `run`, which
an agent drives from outside, are subcommands only.

- `abaikit learnabai [--section S] [--json] [--skill [--skill-dir D]]` prints the guide a
  coding agent reads before it creates or retrofits an abaigram: what an
  abaigram is, the instantiation's declaration API with one example of
  each declaration, the standard entry, the conformance levels and what
  `check` demands, the retrofit procedure with every step ending in the
  command that verifies it, how an abaigram is run, the instantiation's
  deviations, and what never to do. The same text is the `learnabai`
  capability, so an agent on an MCP client reads it, and `--skill`
  installs it as a skill file for the person's coding agent, in Claude
  Code's skills directory or the one given. This is the primary path: an
  abaigrammer sits with their own agent, which reads the guide and does
  the retrofit while the abaigrammer watches, verifying each step.
- `abaikit new <name> --lang <L> [--level N]` creates a fresh abaigram in
  language L, at level 1 by default, with every kind of declaration
  present once, live at the levels that need it and commented out below
  them, a `check.run` from level 2, and `identity` and `use` content;
  `check` reports the requested level on it as made.
- `abaikit abaify <repo> [--level N] [--mode M]` retrofits an existing
  repository unattended: abaikit's own agent, with the configured model,
  works through abaikit's own capabilities and nothing else, with no
  shell, so what it does to the repository is additive by construction.
  `repo.write` makes a new file, or rewrites one the run itself made;
  `repo.insert` adds text before or after one unique anchor line of an
  existing file and checks that the original bytes are still there, in
  order. Apart from what the language's package tools rewrite in place,
  named as such in the report (the dependency file by
  `repo.add_dependency`; `abaigram.yaml` by `repo.manifest`, which writes
  what the entry's own `manifest` prints; the lock file and the installed
  packages by `repo.install`), no line the repository had is removed or
  reordered. `repo.manifest` and `repo.install` exist because the agent
  has no shell. Each round the agent works until it stops, then abaikit
  runs `check` itself; the requested level with no violation ends the
  loop, anything short of it is the next prompt, up to a declared number
  of rounds, and a model that cannot be reached ends the run at once. The
  person's invocation is the consent for the agent's `confirm` acts
  (section 10). It never rewrites main(), and once the agent has started
  work it leaves a report in the repository, whatever happens after:
  every change with the agent's reason for it, the rounds, and the last
  `check` report.
- `abaikit check <repo> [--level N]` verifies conformance as section 12
  defines it, through the repository's `entry` and its `check.run`. The
  null harness runs in the program's process under turns and thread, and
  under sidecar is the harness binary in its null form unless the
  instantiation declares the deviation that keeps it in-process there
  too; `ABAI_HARNESS` selects its passive or active form.
- `abaikit run <repo> -- ARGS` launches the abaigram in sidecar mode under
  supervision, through the repository's `entry`.

## 14. Deferred to instantiation

- The wire format for capability parameters, results, and large payloads,
  and the protocol between stub and harness.
- The region layout: cell slots and sized-knob mirrors, the event ring's
  slot header and encoding, reply slots, the arena and its size, the
  parked flag, the counters.
- How the launch connection is handed to the child, and the form of the
  stub's listening endpoint.
- How a producer lapped before it publishes to the ring is handled.
- The wake primitive per platform.
- The shape of the per-language stub API, including knob and stop
  handlers.
- Whether a language's stub is native or a binding over a shared core.
- Which model providers the harness supports, and whether one is bundled.
- The terminal interface of `session`.
- Packaging and distribution of the harness binary.
- The reference machine for 11.6.
- The form of the report the null harness gives at exit, and how `check`
  reads it; a checker judges programs of its own instantiation.

## 15. Open questions

- Several agents on one program, or one agent across several programs. Out
  of scope for 0.1.
- Whether `turn` content slots should carry their own attention budget.
- Whether a knob write should carry an expiry, after which the program
  reverts the knob to its default.
- The levels show that a channel can be reached, not that the program
  uses it: a `check.run` written only for the check reaches L2. Whether a
  level should also require a path the program takes for its own work is
  open.
