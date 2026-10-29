// A launcher whose children are in-process fakes: a ship that obeys the IPC
// protocol as the registry sees it, and a harness that answers JSON-RPC.
import { EventEmitter } from "node:events";
import type { HarnessIo, JsonRpcMessage } from "../src/bridge.ts";
import type { Launched, Launcher, LaunchSpec } from "../src/ship.ts";

export interface FakeShip extends Launched {
	spec: LaunchSpec;
	/** What the registry sent the ship. */
	received: Array<Record<string, unknown>>;
	/** Pretend the ship reported a frame. */
	frame(frame: Record<string, unknown>): void;
	/** Pretend the ship changed phase. */
	state(phase: string, cause?: string, name?: string): void;
	killed: boolean;
}

export function fakeLauncher(): { launcher: Launcher; ships: FakeShip[]; failNext: { error: string | undefined } } {
	const ships: FakeShip[] = [];
	const failNext = { error: undefined as string | undefined };
	const launcher: Launcher = {
		async launch(spec) {
			if (failNext.error) {
				const error = failNext.error;
				failNext.error = undefined;
				throw new Error(error);
			}
			const events = new EventEmitter();
			const lines = new EventEmitter();
			const harness: HarnessIo = {
				write(line) {
					const m = JSON.parse(line) as JsonRpcMessage & {
						params?: { name?: string; arguments?: { wait_s?: number } };
					};
					if (m.id === undefined) return;
					const result =
						m.method === "initialize"
							? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake" } }
							: m.method === "tools/call" && m.params?.name === "abai_wait"
								? { content: [{ type: "text", text: `no wake in ${m.params.arguments?.wait_s ?? 25}s` }] }
								: { content: [{ type: "text", text: `called ${m.params?.name ?? m.method}` }] };
					const delay =
						m.method === "tools/call" && m.params?.name === "abai_wait"
							? (m.params.arguments?.wait_s ?? 0) * 1000
							: 0;
					setTimeout(() => lines.emit("line", JSON.stringify({ jsonrpc: "2.0", id: m.id, result })), delay);
				},
				lines: (onLine) => lines.on("line", onLine),
				onExit: (cb) => events.once("harness-exit", cb),
			};
			let settleExit: (what: { who: string; code: number | null }) => void = () => {};
			const exit = new Promise<{ who: string; code: number | null }>((resolve) => {
				settleExit = resolve;
			});
			events.on("exit", (what: { who: string; code: number | null }) => settleExit(what));
			const ship: FakeShip = {
				spec,
				events,
				harness,
				pids: { ship: 1, harness: 2 },
				exit,
				received: [],
				killed: false,
				send(message) {
					ship.received.push(message);
				},
				kill() {
					ship.killed = true;
					events.emit("harness-exit");
				},
				frame(frame) {
					events.emit("ship", { type: "frame", frame: { callsign: spec.callsign, ...frame } });
				},
				state(phase, cause = "", name = "") {
					events.emit("ship", { type: "state", phase, cause, name });
				},
			};
			ships.push(ship);
			return ship;
		},
	};
	return { launcher, ships, failNext };
}
