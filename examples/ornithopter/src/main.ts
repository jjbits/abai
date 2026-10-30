// ornithopter: a flying game whose only pilot is the agent fused into it.
// Node 22.19 and later run this file as it is (node src/main.ts). The stub
// is handed the standard agent entry on every invocation; the program's own
// run follows when no abai verb was given.
//
// How the pilot arrives. A plain run (`node src/main.ts`) starts the game
// and, in sidecar mode, listens for a harness: `supervise.mjs`, the harness
// binary's `mcp` or `session` verb, or `abaikit run` reach it. The verbs
// that attach an agent in this process (`abai`, `abai mcp`, `abai install`)
// find the game already running, because it is started before the entry is
// handed those arguments. `--demo` is the scripted headless flight that
// `abaikit check` runs.
import { runEntry } from "@abaigram/abai-stub";
import { app, stop } from "./abai.ts";
import { type Channels, wireChannels } from "./channels.ts";
import { runDemo } from "./demo.ts";
import { frame } from "./frame.ts";
import type { TrafficShip } from "./sensors.ts";
import { type GameServer, startServer } from "./server.ts";
import { createSim, type Sim } from "./sim.ts";
import { TICK_HZ } from "./tuning.ts";
import { createWorld, DEFAULT_SEED } from "./world.ts";

const USAGE = `usage: node src/main.ts [--port N] [--seed N] [--demo]
       node src/main.ts abai [verb]       the standard agent entry; no verb opens a session

  --port N   the web page's port (default 8420, or $ORNITHOPTER_PORT; the abai verbs that start the game
             take $ORNITHOPTER_PORT or a free port, and say which on stderr)
  --seed N   the world's seed (default ${DEFAULT_SEED}, or $ORNITHOPTER_SEED)
  --demo     a scripted flight, headless and fast-forward; exits when it is done
  --arena    a child of the arena server: no page; frames and commands over the IPC channel
  --spawn x,z   where the ship starts (default the pad's center)
  --callsign N  the ship's name among others (default solo)`;

/** The entry verbs that attach an agent inside this process and so want the game live. */
const ATTACHING_VERBS = new Set(["", "mcp", "install"]);

interface Args {
	port: number;
	seed: number;
	demo: boolean;
	help: boolean;
	/** A child of the arena: no page, frames and commands over the IPC channel. */
	arena: boolean;
	spawn: { x: number; z: number } | undefined;
	callsign: string | undefined;
}

function integer(text: string | undefined, what: string): number {
	const v = Number(text);
	if (!Number.isInteger(v)) throw new Error(`${what} needs a whole number`);
	return v;
}

function defaults(env: NodeJS.ProcessEnv): Args {
	return {
		port: env.ORNITHOPTER_PORT ? integer(env.ORNITHOPTER_PORT, "ORNITHOPTER_PORT") : 8420,
		seed: env.ORNITHOPTER_SEED ? integer(env.ORNITHOPTER_SEED, "ORNITHOPTER_SEED") : DEFAULT_SEED,
		demo: false,
		help: false,
		arena: false,
		spawn: undefined,
		callsign: undefined,
	};
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
	const args = defaults(env);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--port") args.port = integer(argv[++i], a);
		else if (a === "--seed") args.seed = integer(argv[++i], a);
		else if (a === "--demo") args.demo = true;
		else if (a === "--arena") args.arena = true;
		else if (a === "--spawn") {
			const [x, z] = (argv[++i] ?? "").split(",").map(Number);
			if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error("--spawn needs x,z in metres");
			args.spawn = { x, z };
		} else if (a === "--callsign") {
			const name = argv[++i];
			if (!name || !/^[a-z0-9-]{1,32}$/.test(name)) throw new Error("--callsign needs 1 to 32 of a-z, 0-9 or -");
			args.callsign = name;
		} else if (a === "--help" || a === "-h") args.help = true;
		else throw new Error(`unknown argument ${a}`);
	}
	return args;
}

interface Game {
	sim: Sim;
	channels: Channels;
	server: GameServer | undefined;
	close(): Promise<void>;
}

/** The live game: the simulation at a fixed rate on the real clock, the channels, and the page. */
async function startGame(args: Args, serve: boolean): Promise<Game> {
	const sim = createSim(createWorld({ seed: args.seed }), { spawn: args.spawn, callsign: args.callsign });
	const channels = wireChannels(app, sim);
	channels.publish();
	const server = serve ? await startServer(sim, args.port) : undefined;
	// the real elapsed time, capped so a suspended laptop does not teleport the ship
	let last = performance.now();
	const step = (): void => {
		const now = performance.now();
		const dt = Math.min((now - last) / 1000, 0.25);
		last = now;
		channels.readKnobs();
		app.safepoint();
		sim.tick(dt);
		channels.publish();
	};
	const timer = setInterval(step, 1000 / TICK_HZ);
	const close = async (): Promise<void> => {
		clearInterval(timer);
		await server?.close();
	};
	stop.handler = async () => {
		await close();
		// a child of the arena has an IPC channel holding it open: a graceful stop is an exit
		if (args.arena) process.exit(0);
	};
	return { sim, channels, server, close };
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const verb = argv[0] === "abai" ? (argv[1] ?? "") : undefined;
	let args: Args;
	try {
		args = verb === undefined ? parseArgs(argv, process.env) : defaults(process.env);
		// an agent attaching here may arrive while a plain game holds 8420: a free port, unless the person chose one
		if (verb !== undefined && !process.env.ORNITHOPTER_PORT) args.port = 0;
	} catch (error) {
		console.error(`ornithopter: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
		return 2;
	}
	if (args.help) {
		console.log(USAGE);
		return 0;
	}

	// the game is live for a plain run and for the verbs that attach an agent here; the other verbs
	// (manifest, doctor, config, run) need no game, and the demo makes its own
	const live = verb === undefined ? !args.demo : ATTACHING_VERBS.has(verb);
	if (args.arena && (!process.send || app.mode !== "sidecar")) {
		console.error("ornithopter: --arena needs an IPC channel from the arena server and sidecar mode");
		return 2;
	}
	let game: Game | undefined;
	try {
		game = live ? await startGame(args, !args.arena) : undefined;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		console.error(
			code === "EADDRINUSE"
				? `ornithopter: port ${args.port} is in use; start with --port <another>, or set ORNITHOPTER_PORT`
				: `ornithopter: could not start: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	}
	if (game && !args.arena) {
		console.error(
			`ornithopter: pid ${process.pid}, seed ${args.seed}, mode ${app.mode}. Watch at ${game.server?.url}. The ship is on the pad, waiting for its pilot.`,
		);
	}

	const code = await runEntry(app, argv);
	if (code >= 0) {
		// an abai verb ran and said what it had to say; a session or an MCP client that was here has gone
		await game?.close();
		return code;
	}
	if (args.demo) {
		const sim = createSim(createWorld({ seed: args.seed }));
		console.log(await runDemo(app, sim, wireChannels(app, sim)));
		return 0;
	}
	if (game && args.arena) runArena(game);
	return 0; // the game runs on until it is stopped
}

/**
 * Arena mode: the parent gets `ready` with the endpoint's socket once it
 * listens, a `frame` ten times a second, `state` at every phase change, and
 * `event` for every event the ship emits; it sends `traffic` with the other
 * ships, `collide` when this ship met one, and `stop`. The parent going away
 * ends the ship, and so does a graceful stop from a harness.
 */
function runArena(game: Game): void {
	const send = (message: Record<string, unknown>): void => {
		// with a callback, a parent that has just gone makes an error the callback swallows, not an uncaught one
		if (process.connected) process.send?.(message, undefined, undefined, () => {});
	};
	process.on("message", (message: unknown) => {
		if (typeof message !== "object" || message === null) return;
		const m = message as { type?: string; ships?: unknown; with?: unknown };
		if (m.type === "traffic" && Array.isArray(m.ships)) game.sim.setTraffic(m.ships as TrafficShip[]);
		else if (m.type === "collide" && typeof m.with === "string") game.sim.collide(m.with);
		else if (m.type === "stop") {
			void game.close().then(() => process.exit(0));
		}
	});
	process.on("disconnect", () => {
		void game.close().then(() => process.exit(0));
	});
	// the ship's own events, for the viewer's log beside the frames
	game.sim.onEvent((e) => send({ type: "event", name: e.name, payload: e.payload }));
	let lastPhase = game.sim.state.phase;
	const frames = setInterval(() => {
		const s = game.sim.state;
		if (s.phase !== lastPhase) {
			lastPhase = s.phase;
			send({ type: "state", phase: s.phase, cause: s.crashCause, name: s.crashName });
		}
		send({ type: "frame", frame: frame(game.sim) });
	}, 100);
	frames.unref();
	const endpoint = app.endpoint;
	if (!endpoint) {
		send({ type: "error", error: "no sidecar endpoint" });
		return;
	}
	endpoint.ready.then(
		() => send({ type: "ready", socket: endpoint.socketPath, pid: process.pid, callsign: game.sim.callsign }),
		(error: unknown) => send({ type: "error", error: error instanceof Error ? error.message : String(error) }),
	);
}

process.exitCode = await main();
