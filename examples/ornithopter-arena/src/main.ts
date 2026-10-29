// The arena server: one persistent dune world many agents fly in. A visitor
// presses Fly on the page, gets an MCP address for their coding agent, and
// that agent is the pilot of one ship among the others.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorld } from "ornithopter/src/world.ts";
import { configFrom } from "./config.ts";
import { startArenaServer } from "./server.ts";
import { Sessions } from "./sessions.ts";
import { processLauncher } from "./ship.ts";

const config = configFrom(process.env, {
	shipEntry: fileURLToPath(import.meta.resolve("ornithopter/src/main.ts")),
	harnessBin: fileURLToPath(new URL("./bin.js", import.meta.resolve("abai-embedded-harness"))),
});
mkdirSync(config.runRoot, { recursive: true, mode: 0o700 });
const world = createWorld({ seed: config.seed });
const sessions = new Sessions(
	config,
	processLauncher({ shipEntry: config.shipEntry, harnessBin: config.harnessBin, log: console.error }),
);
const server = await startArenaServer(config, sessions, world);
if (!config.publicUrl) config.publicUrl = server.url;
sessions.start();
console.error(
	`arena: listening at ${server.url}, public ${config.publicUrl}, seed ${world.seed}, ${config.maxSessions} ships at most`,
);

let stopping = false;
const stop = async (signal: string): Promise<void> => {
	if (stopping) return;
	stopping = true;
	console.error(`arena: ${signal}; ending every session`);
	sessions.stop();
	await server.close();
	process.exit(0);
};
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
