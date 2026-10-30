# abai

- **abai**: *ab*, Latin for "by", and *ai*, artificial intelligence. Together: "by AI".
- **program**: *pro*, Latin for "before", and *gram*, "written". Together: "written beforehand".
- **abaigram**: *abai* and *gram*. Together: "written by AI".

## Abaigram

An abaigram is a program with an AI agent fused in. The agent ships with
the program and stays active after shipping. At install and during use it
talks with the user, watches the program, and steers it. The program
declares what the agent may see and change, and the agent acts only
through those declared channels. The program owns main() and runs on its
own when the agent is absent.

## This repository

This repository holds the abaigram contract and some reference
implementations of it. The contract, the abaigrammar, was written by an
AI agent for AI agents: a coding agent reads it to make or retrofit an
abaigram.

- `spec/abaigrammar.md`: the contract, version 0.1, language-neutral.
- `implementations/typescript/`: the TypeScript implementation, an npm
  workspace of three packages.
  - `abai/`: the stub, the library a program includes.
  - `abai-embedded-harness/`: the harness, the agent runtime, based on the
    open source [pi](https://github.com/earendil-works/pi) harness.
  - `abaikit/`: the authoring tool, itself an abaigram. Its guide for
    coding agents is `abaikit/abai/learnabai.md`.
- `examples/ornithopter/`: the example game, an abaigram your coding
  agent can supervise.
- `examples/ornithopter-arena/`: the hosted arena: one world, a ship per
  visitor, the pilots' agents attached over MCP.
- `MANUAL.md`: the manual your coding agent reads. Start here.
- Further languages: planned, none yet.

## The contract in one page

<details>
<summary><strong>15 sections, click to open</strong></summary>

1. **Purpose.** A program is fixed when it ships. An abaigram ships with
   an AI agent fused in, active at install and during use. The contract
   defines the structure, not what any abaigram does.
2. **Vocabulary.** abai is the library, an abaigram is one program with
   an agent, an abaigrammer makes one. The stub is the program side, the
   harness the agent side, the region their shared memory. The null
   harness attaches without a model.
3. **Principles.** The program owns main(). The agent is invited and acts
   only through declared channels. The program runs without the agent
   through defaults and timeouts. Control has policy and leaves an audit
   trail. One contract, three modes, no language, no cost the program did
   not ask for.
4. **Structure.** The program gives declarations, touchpoints, and
   content with policy. The library gives the rest. Four touchpoints hand
   control over: install, session, turn, decide. The stub attaches at
   five fixed places and never from turn or decide. One standard entry,
   `<prog> abai`, with verbs for session, install, run, config, doctor,
   manifest, and mcp. The harness owns the user channel.
5. **Channels.** Events flow program to agent, pushed through a bounded
   ring, never blocking. Cells are shared memory: read cells the program
   writes, knobs the agent writes. Capabilities are calls from agent to
   program with a result, never required for the program's own work.
   Decisions block the program until an answer or the default. Lifecycle
   is status, start, pause, resume, stop, restart, sidecar only.
   Attention is what wakes the agent, with a budget. Under launch the
   harness also sees stdout, stderr, and exit with no declaration.
6. **Execution modes.** Turns: one thread, the agent runs only inside
   touchpoints and model calls block. Thread: the harness on its own
   thread, everything live but lifecycle. Sidecar: two processes over a
   local socket with a shared region, everything live, the reference
   mode. One harness serves every language.
7. **Manifest.** Declared in code at startup and checked in as
   `abaigram.yaml`. The two must agree. It lists entry, modes, content, a
   check command, every channel declaration with a doc, policy, audit,
   and deviations.
8. **Content.** The author's prompts. Identity is required; install, use,
   and per-turn files are optional. The harness composes the system
   prompt from identity and the manifest's docs. Good docs are most of
   the work.
9. **Model connection.** Provider-neutral, no bundled model. Configured
   once per machine under `~/.abai/`. Nothing in conformance requires a
   model.
10. **Policy and audit.** Every act of control is auto, confirm, or
    forbid. Reads are free. Mutations and stop default to confirm.
    Unanswered confirms are denied. Every act is audited with the agent's
    reason.
11. **Performance.** Unattached, each operation is one or two loads or
    stores. Attached, nothing on the program's thread allocates, locks,
    blocks, or calls the system beyond one wake. Three opt-in exceptions:
    touchpoints, cooperative pause, large events. Claims are measured by
    tests and by check, not asserted.
12. **Conformance.** Four levels, no model needed. L1 reachable: the
    entry and manifest work. L2 observable: a cell or event. L3
    steerable: a landed capability or knob write. L4 deliberative: a
    reached decision. Evidence is the program's own.
13. **abaikit.** The authoring tool and first abaigram. learnabai prints
    the guide, new makes an abaigram, abaify retrofits a repo unattended
    and additively, check verifies conformance, run launches under
    supervision.
14. **Deferred to instantiation.** Wire format, region layout, wake
    primitive, per-language API, providers, packaging, reference machine.
15. **Open questions.** Several agents or programs. Per-turn budgets.
    Knob expiry. Whether a level should require a path the program takes
    for its own work.

</details>

## How to use it

### Try it now, nothing to install: the arena

There is a desert at https://ornithopter.gearedagents.com where anyone
can fly an ornithopter. The pilot is your coding agent, not you, and
everyone else's ship is in the same sky. Ships can see each other, two
that collide are both lost, and a crashed ship is gone for good.

1. **Open the page** and press **Fly**. A panel shows your ship's callsign,
   its MCP address, and the command for your agent.
2. **Give the address to your agent.** For Claude Code:

   ```
   claude mcp add --transport http ornithopter <the address>
   claude
   > Read abai_prompt and fly.
   ```

   For Codex:

   ```
   codex mcp add ornithopter --url <the address>
   codex
   > Read abai_prompt and fly.
   ```

   Your agent reads its prompt, which tells it everything about the ship:
   what it can see, the three settings it can change, what will kill it,
   and how to fly. Then it takes off. You talk to it the way you would
   talk to a pilot: "head south", "come back and land", "why did you
   crash?"
3. **Watch.** The page follows your ship: the camera, and a panel with
   every cell your agent reads, its targets, the threats and traffic it
   sees, and its events. Press `v` to change the view; the menu at the
   top follows any other ship instead.

What to expect. The agent acts every few seconds, the ship flies on in
between, and that latency is the whole difficulty: the first flights
usually end in a spire, the storm wall, or another ship. When your ship
is lost, press Fly again for a new one. A ship whose pilot is silent for
ten minutes is removed. Three ships per visitor, eighteen in the sky.

### On your own machine

Use your favorite coding agent:

```
claude      # or: codex
> Clone https://github.com/jjbits/abai, read its MANUAL.md, and follow it.
```

The agent builds the workspace, which takes about twenty seconds, and
offers you two things.

**Try one: supervise the example game**, the same ornithopter alone in
the world, on your machine, watched in your browser:

```
> Run the example game and supervise it.
```

**Make one: a new abaigram, or your own program retrofitted.** The agent
reads the guide for coding agents and works step by step, each step
ending in a command that proves it:

```
> Make my program at <path> an abaigram.
> Make a new abaigram called <name>.
```

The library is on npm as `@abaigram/stub` and `@abaigram/embedded-harness`;
the tool as `@abaigram/abaikit`.

## ⚠️ A note on security

The contract does not cover security. An abaigram gives an agent real
ways to observe and control a running program, and the agent may be
driven by a model outside your machine. So before you release an abaigram
of your own, take a careful look at the security side: what the manifest
exposes, which acts run without asking, who can reach the harness and the
audit log, and what a capability could do in the wrong hands. The
contract leaves those choices to you.

## License

MIT. See `LICENSE`.
