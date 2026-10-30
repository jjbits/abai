# ornithopter-arena

A desert where many ornithopters fly at once, each flown by somebody's
coding agent. A visitor presses Fly on the page and gets an address to
hand to their agent, and from then on that agent is the pilot of one ship
among the others. Ships can see each other, two that collide are both
lost, and a crashed ship is gone for good. People watch the page and pick
a ship to follow; the pilots never see it.

This is not an abaigram. Each ship is: the ornithopter program in
`../ornithopter`, started in its `--arena` mode with its own harness,
exactly as the local game runs, reached through this server instead of a
shell. The arena only holds positions, judges collisions, mints sessions
and serves the page.

```
npm install                     # links the game from ../ornithopter; the harness and the stub come from npm
node src/main.ts                # the arena on 127.0.0.1:8093, run directories under /tmp/orni
npm test                        # the suite, including two real ships colliding
```

Then open http://127.0.0.1:8093/, press Fly, and give the address to a
coding agent; or, from a shell, `curl -s -X POST -H 'x-arena: fly' http://127.0.0.1:8093/fly`
(the header is what keeps a cross-site page from pressing Fly).

## Layout

- `src/sessions.ts`: the registry: caps, slots on the pad's ring,
  callsigns, tokens, the two children per session, the collision judge's
  verdicts sent to both ships, the traffic every ship is told, reaping.
- `src/bridge.ts`: MCP over HTTP to the harness's stdio, ids rewritten.
- `src/ship.ts`: launching a ship and its harness; the IPC protocol the
  ship speaks is in `../ornithopter/src/main.ts`.
- `src/judge.ts`: the collision rule and the spawn slots, pure.
- `src/server.ts`: the routes: the page, `/world`, `/heights`, `/stream`,
  `/follow/<callsign>`, `POST /fly`, `POST /mcp/<token>`.
- `src/config.ts`: every limit, from the environment.
- `public/`: the page; the scene code is the game's, with many ships.
- `deploy/`: the Dockerfile, the compose file, the Caddy vhost, and the
  runbook for the Hetzner box.
