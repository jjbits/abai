// A session's two children: the ornithopter program in arena mode, and the
// harness binary's MCP server attached to it. The arena talks to the ship
// over the IPC channel and to the harness over stdio.
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { type HarnessIo, stdioOf } from "./bridge.ts";

export interface LaunchSpec {
	callsign: string;
	spawn: { x: number; z: number };
	seed: number;
	/** Short: the ship's socket lives in it and socket paths are bounded. */
	runDir: string;
	auditPath: string;
}

/** A launched session's children, as the sessions registry drives them. */
export interface Launched {
	readonly events: EventEmitter;
	readonly harness: HarnessIo;
	readonly pids: { ship: number | undefined; harness: number | undefined };
	/** Settles when either child exits, however early; a promise, so a listener that comes late still hears it. */
	readonly exit: Promise<{ who: string; code: number | null }>;
	/** `traffic`, `collide` and `stop` to the ship. */
	send(message: Record<string, unknown>): void;
	/** End both children, by their handles. */
	kill(): void;
}

export interface Launcher {
	launch(spec: LaunchSpec): Promise<Launched>;
}

export interface ProcessLauncherOptions {
	shipEntry: string;
	harnessBin: string;
	/** Milliseconds to wait for the ship's `ready` and for the harness to attach. */
	readyMs?: number;
	attachMs?: number;
	/** Where the children's stderr lines go. */
	log?: (line: string) => void;
}

/** The real launcher: two Node children per session. */
export function processLauncher(options: ProcessLauncherOptions): Launcher {
	const readyMs = options.readyMs ?? 15_000;
	const attachMs = options.attachMs ?? 8_000;
	const log = options.log ?? (() => {});
	return {
		async launch(spec) {
			const events = new EventEmitter();
			const env: NodeJS.ProcessEnv = {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				ABAI_RUN_DIR: spec.runDir,
				ABAI_MODE: "sidecar",
				ORNITHOPTER_ARENA: "1",
				ORNITHOPTER_AUDIT: spec.auditPath,
			};
			const ship = spawn(
				process.execPath,
				[
					options.shipEntry,
					"--arena",
					"--seed",
					String(spec.seed),
					"--spawn",
					`${spec.spawn.x},${spec.spawn.z}`,
					"--callsign",
					spec.callsign,
				],
				{ env, stdio: ["ignore", "ignore", "pipe", "ipc"] },
			);
			ship.on("error", () => {});
			ship.stderr?.on("error", () => {});
			if (ship.stderr)
				createInterface({ input: ship.stderr }).on("line", (line) => log(`[${spec.callsign} ship] ${line}`));
			ship.on("message", (m: unknown) => {
				if (typeof m !== "object" || m === null) return;
				events.emit("ship", m as Record<string, unknown>);
			});
			let settleExit: (what: { who: string; code: number | null }) => void = () => {};
			const exit = new Promise<{ who: string; code: number | null }>((resolve) => {
				settleExit = resolve;
			});
			ship.on("exit", (code) => settleExit({ who: "ship", code }));

			// the ship says ready once its endpoint listens; then the harness attaches to it
			const socket = await new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("the ship did not become ready")), readyMs);
				const onShip = (m: Record<string, unknown>): void => {
					if (m.type === "ready" && typeof m.socket === "string") {
						clearTimeout(timer);
						events.off("ship", onShip);
						resolve(m.socket);
					} else if (m.type === "error") {
						clearTimeout(timer);
						events.off("ship", onShip);
						reject(new Error(String(m.error)));
					}
				};
				events.on("ship", onShip);
				ship.once("exit", (code) => {
					clearTimeout(timer);
					reject(new Error(`the ship exited with ${code} before it was ready`));
				});
			}).catch((error) => {
				ship.kill();
				throw error;
			});

			const harness = spawn(
				process.execPath,
				[options.harnessBin, "mcp", "--target", socket, "--run-dir", spec.runDir],
				{
					env,
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			harness.on("error", () => {});
			harness.stdout?.on("error", () => {});
			harness.stderr?.on("error", () => {});
			harness.on("exit", (code) => settleExit({ who: "harness", code }));
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, attachMs); // not attached yet is a notice; abai_attach can attach later
				harness.once("exit", (code) => {
					clearTimeout(timer);
					reject(new Error(`the harness exited with ${code} before attaching`));
				});
				if (harness.stderr) {
					createInterface({ input: harness.stderr }).on("line", (line) => {
						log(`[${spec.callsign} harness] ${line}`);
						if (line.includes("attached to")) {
							clearTimeout(timer);
							resolve();
						}
					});
				}
			}).catch((error) => {
				ship.kill();
				harness.kill();
				throw error;
			});

			// a child that died during the waits above is not a session
			if (ship.exitCode !== null || harness.exitCode !== null) {
				ship.kill();
				harness.kill();
				throw new Error("a child exited during the launch");
			}
			return launched(events, ship, harness, exit);
		},
	};
}

function launched(
	events: EventEmitter,
	ship: ChildProcess,
	harness: ChildProcess,
	exit: Promise<{ who: string; code: number | null }>,
): Launched {
	return {
		events,
		harness: stdioOf(harness),
		pids: { ship: ship.pid, harness: harness.pid },
		exit,
		send(message) {
			if (ship.connected) ship.send(message);
		},
		kill() {
			if (harness.exitCode === null && harness.signalCode === null) harness.kill();
			if (ship.exitCode === null && ship.signalCode === null) {
				if (ship.connected) ship.send({ type: "stop" });
				setTimeout(() => {
					if (ship.exitCode === null && ship.signalCode === null) ship.kill();
				}, 2000).unref();
			}
		},
	};
}
