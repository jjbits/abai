# The manual for the agent

You are a coding agent, and a person pointed you at this repository. They
will ask you for one of two things: to **try** the example game by
becoming its pilot, or to **make** an abaigram out of a program of
theirs. Do the setup in section 1 first, then the section they asked
for. Every step ends with the command that proves it. Commands run from
the root of this checkout unless the step says otherwise.

## 0. What this is

A program that includes the abai library becomes an abaigram: a program
with an agent fused in. The program declares what the agent may observe
(cells and events) and control (knobs and capabilities), and the agent
acts only through those. The contract is `spec/abaigrammar.md`; you do
not need to read it for either task.

The example, `examples/ornithopter`, is a flying game: an ornithopter
over desert dunes with rock spires in the way. Its only pilot is the
agent attached to it. When the person says "supervise", that pilot is
you.

## 1. Setup

1. Node 22.19 or newer.
   Verify: `node --version`.
2. Build the TypeScript workspace: the stub, the harness and abaikit.
   ```
   cd implementations/typescript && npm install && npm run build && cd ../..
   ```
   Verify: `node implementations/typescript/abaikit/dist/bin.js learnabai --section what`
   prints the guide's first section and exits 0.
3. Install the example (it links the packages you just built).
   ```
   cd examples/ornithopter && npm install && cd ../..
   ```
   Verify, in `examples/ornithopter`: `node src/main.ts abai doctor --offline`
   ends with `doctor: ok`.

## 2. Try: supervise the ornithopter

Work in `examples/ornithopter`. Every command below runs there.

### Start the game

Start it in the background, redirecting its output to a file, and keep
its pid. With a plain shell:

```
node src/main.ts > ornithopter.log 2>&1 &
echo $!
sleep 2; cat ornithopter.log
```

If your tool runs commands in the background for you, use that instead
and read the log the same way. Verify: the log shows one line with
`pid <N>` and `Watch at http://127.0.0.1:8420/`. That pid is `<pid>`
below. If the log says `EADDRINUSE`, the port is taken: start again with
`--port 8421` and give the person that URL instead. The log file is
ignored by git.

Tell the person the URL. Their browser shows the dunes, the ship, the
spires, and the cells that matter, live. They watch; you fly.

### Attach and look

The game is reached through the abai harness's MCP server. From a shell,
the one-shot client `supervise.mjs` attaches, makes one call, prints the
answer and exits:

```
node supervise.mjs --target <pid> prompt
node supervise.mjs --target <pid> cells
node supervise.mjs --target <pid> call world.describe "to plan a route"
```

Read the prompt once, fully: it is your identity as the pilot and the
manual of every cell, knob, capability and event, with the numbers that
matter. The cells are the ship's senses. The map from `world.describe`
has every spire's position, radius and top; the pad is at the origin,
120 m in radius, and no spire stands within 1200 m of it.

### Fly

The ship flies on between your acts, so the loop is: read, decide, act,
every 5 to 15 seconds of real time, until you have landed.

```
node supervise.mjs --target <pid> set target.heading_deg 225 "the south-west is clear of spires for 2 km"
node supervise.mjs --target <pid> call flight.takeoff "lifting off"
node supervise.mjs --target <pid> cells flight.phase ship.altitude_m ship.clearance_m ship.heading_deg ship.speed_mps threat.name threat.distance_m threat.bearing_deg threat.clearance_m terrain.ahead_clearance_m boundary.distance_m power.pct home.distance_m home.bearing_deg
node supervise.mjs --target <pid> set target.heading_deg 150 "spire-12 ahead at bearing +30, top 402 is above my ceiling: turning left"
node supervise.mjs --target <pid> set target.altitude_m 280 "spire-06 next, top 222: climbing over it"
node supervise.mjs --target <pid> wait 20
```

`set` takes the knob, the value and your reason; `call` takes the
capability, optional `{json}` parameters, and your reason. Every act is
audited with that reason. `wait N` parks for up to N seconds (55 at
most) and returns the next warning event (a threat, rising terrain, the wall, low power, a
stall, a crash), or "no wake"; use it between reads when nothing is
near.

Rules of thumb, from the prompt: pick the takeoff heading from the map;
never let 20 seconds pass without reading the threat cells; when a threat
is within 1200 m and `threat.clearance_m` is under 60, turn 60 to 90
degrees away from its bearing (positive is on your right) or climb above
its top plus 50 if the ceiling of 350 m allows; read
`boundary.distance_m` every cycle and turn for home the moment it is
under 1000 m; watch the power; land on the pad: fly home by
`home.bearing_deg`, slow to 25 m/s while still 500 m out, keep the
bearing near 0, and start `flight.land` about 150 m out: the ship
hovers down, drifting about 60 m as it slows. At 50 m/s the pad goes
by between two of your reads. The speed of 50 m/s is a good cruise;
faster turns wider.

Two things about time. The ship flies on while you think: at 50 m/s,
ten seconds of deliberation is 500 m, so decide from the cells you have
and act in the same breath. And the one-shot client attaches only for
the length of a call, so a warning event that fires between two calls
is gone; `wait` catches the ones that fire while it is parked, and the
game repeats a standing warning every ten seconds, but the cells are the
truth at every read. Read them every cycle, and never sleep instead of
reading.

Report to the person what you see and do, briefly, as you go. After a
crash, the page shows a banner and `flight.crash_cause` says why; explain
it, and offer `flight.reset`. After a landing, say so. When the person is
done, stop the game by its pid: `kill <pid>`. Never stop it by name.

What you did is in the audit: `node supervise.mjs --target <pid> audit`.

### If the person wants you attached through MCP instead

Register the harness as an MCP server for your client, then have the
person restart you in `examples/ornithopter`:

- Claude Code: `claude mcp add abai -- node <checkout>/implementations/typescript/abai-embedded-harness/dist/bin.js mcp`
- Codex, in `~/.codex/config.toml`:
  ```
  [mcp_servers.abai]
  command = "node"
  args = ["<checkout>/implementations/typescript/abai-embedded-harness/dist/bin.js", "mcp"]
  ```

After the restart, with the game running: `abai_attach` (no target when
the game is the one program running, else its pid), then `abai_prompt`,
`abai_cells`, `abai_set`, `abai_call`, `abai_wait`. Your client's
permission prompt is the consent for each act, and warning events wake
you from `abai_wait`.

## 2b. Try: the hosted arena

If the person gives you an MCP address of the form
`https://ornithopter.gearedagents.com/mcp/<token>`, or asks you to fly
"in the arena", there is nothing to set up. Add the address to your own
client, Claude Code with `claude mcp add --transport http ornithopter
<address>` and a restart, Codex with `codex mcp add ornithopter --url
<address>`. Then `abai_attach` is not needed: call `abai_prompt` and
read it fully. It is the same ship as the local game, with two
differences the prompt explains: other agents fly their own ships in the
same sky and show in `traffic.near`, and a crash is final. There is no
`flight.reset`; a new session, which the person gets by pressing Fly on
the page again, is a new ship. Fly with the same loop as section 2, with
`abai_cells`, `abai_set`, `abai_call` and `abai_wait`, and tell the
person your callsign from `ship.callsign` so they can follow you on the
page.

## 3. Make: an abaigram of the person's program

The guide `learnabai` is written for you. Print it and follow it, step by
step, for the program at the path the person gave:

```
node implementations/typescript/abaikit/dist/bin.js learnabai
node implementations/typescript/abaikit/dist/bin.js learnabai --section retrofit
```

Its install command uses `file:` paths into this checkout; keep them.
Every step in the guide ends in a command that verifies it, and the
conformance check is
`node implementations/typescript/abaikit/dist/bin.js check <path> --level N`.
For a new program instead of a retrofit:
`node implementations/typescript/abaikit/dist/bin.js new <name> --lang ts`.

When it is done, supervise the person's program the way you supervised
the game: start it, then
`node <checkout>/examples/ornithopter/supervise.mjs --target <pid> prompt`,
and go from there.

An unattended retrofit by abaikit's own agent,
`node implementations/typescript/abaikit/dist/bin.js abaify <path> --level N`,
needs a model configured on this machine; in `examples/ornithopter`,
`node src/main.ts abai config` says how. Tell the person before you use
it.

## 4. Never

- Never modify anything under `implementations/` or `spec/`. This
  checkout is the library, not the person's project.
- Never commit or push in this checkout.
- Never end a process by name or pattern. Only by the pid you started.
- Never open a network tunnel, or change the person's shell, git or
  model configuration without being asked.
- Never claim the ship is safe without having read the cells.
