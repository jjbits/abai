import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { BridgeClosed, type HarnessIo, type JsonRpcMessage, McpBridge } from "../src/bridge.ts";

/** A harness that answers every request with its own id and params, after `delayMs` if the params say so. */
function fakeHarness(): { io: HarnessIo; emitter: EventEmitter; written: string[] } {
	const emitter = new EventEmitter();
	const written: string[] = [];
	const io: HarnessIo = {
		write(line) {
			written.push(line);
			const message = JSON.parse(line) as JsonRpcMessage & { params?: { delayMs?: number; fail?: boolean } };
			if (message.id === undefined) return; // a notification
			const reply = (): void =>
				void emitter.emit(
					"line",
					JSON.stringify(
						message.params?.fail
							? { jsonrpc: "2.0", id: message.id, error: { code: -1, message: "nope" } }
							: { jsonrpc: "2.0", id: message.id, result: { echo: message.method, params: message.params } },
					),
				);
			if (message.params?.delayMs) setTimeout(reply, message.params.delayMs);
			else reply();
		},
		lines: (onLine) => {
			emitter.on("line", onLine);
		},
		onExit: (cb) => {
			emitter.once("exit", cb);
		},
	};
	return { io, emitter, written };
}

describe("the MCP bridge", () => {
	it("forwards a request with its own id and gives the client's back", async () => {
		const { io, written } = fakeHarness();
		const bridge = new McpBridge(io);
		const answer = await bridge.request({ jsonrpc: "2.0", id: "client-7", method: "ping" }, 1000);
		expect(answer).toEqual({ jsonrpc: "2.0", id: "client-7", result: { echo: "ping" } });
		expect(JSON.parse(written[0] as string).id).toBe(1);
		const second = await bridge.request({ jsonrpc: "2.0", id: 1, method: "tools/list" }, 1000);
		expect(second.id).toBe(1);
		expect(JSON.parse(written[1] as string).id).toBe(2);
	});

	it("keeps concurrent requests apart, even with the same client id", async () => {
		const { io } = fakeHarness();
		const bridge = new McpBridge(io);
		const slow = bridge.request({ jsonrpc: "2.0", id: 5, method: "slow", params: { delayMs: 60 } }, 1000);
		const fast = bridge.request({ jsonrpc: "2.0", id: 5, method: "fast" }, 1000);
		expect((await fast).result).toMatchObject({ echo: "fast" });
		expect((await slow).result).toMatchObject({ echo: "slow" });
	});

	it("passes an error response through, sends notifications without an id, and ignores noise", async () => {
		const { io, emitter, written } = fakeHarness();
		const bridge = new McpBridge(io);
		emitter.emit("line", "not json at all");
		emitter.emit("line", JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }));
		const failed = await bridge.request({ jsonrpc: "2.0", id: 2, method: "x", params: { fail: true } }, 1000);
		expect(failed.error?.message).toBe("nope");
		bridge.notify({ jsonrpc: "2.0", method: "notifications/initialized" });
		expect(JSON.parse(written.at(-1) as string)).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
	});

	it("times out a request the harness never answers, and rejects everything when the harness goes", async () => {
		const { io, emitter } = fakeHarness();
		const bridge = new McpBridge(io);
		await expect(
			bridge.request({ jsonrpc: "2.0", id: 1, method: "slow", params: { delayMs: 500 } }, 50),
		).rejects.toThrow(/no answer/);
		const pending = bridge.request({ jsonrpc: "2.0", id: 2, method: "slow", params: { delayMs: 500 } }, 5000);
		emitter.emit("exit");
		await expect(pending).rejects.toBeInstanceOf(BridgeClosed);
		expect(bridge.open).toBe(false);
		await expect(bridge.request({ jsonrpc: "2.0", id: 3, method: "ping" }, 100)).rejects.toBeInstanceOf(BridgeClosed);
	});
});
