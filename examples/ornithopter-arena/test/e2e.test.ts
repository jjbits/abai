// The whole thing, for real: the arena with two real ships and two real
// harnesses, two agents over HTTP flying at each other, both lost, both
// wrecks on the stream, both sessions reaped.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorld } from "ornithopter/src/world.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configFrom } from "../src/config.ts";
import { type ArenaServer, startArenaServer } from "../src/server.ts";
import { Sessions } from "../src/sessions.ts";
import { processLauncher } from "../src/ship.ts";

const runRoot = mkdtempSync(join(tmpdir(), "arena-e2e-"));
const config = configFrom(
	// two slots: the two ships stand across the ring from each other, and pointed at each other they meet in the middle
	{ ARENA_RUN_ROOT: runRoot, ARENA_PORT: "0", ARENA_WRECK_MS: "1500", ARENA_MAX_SESSIONS: "2" },
	{
		shipEntry: fileURLToPath(import.meta.resolve("ornithopter/src/main.ts")),
		harnessBin: fileURLToPath(new URL("./bin.js", import.meta.resolve("abai-embedded-harness"))),
	},
);
const sessions = new Sessions(config, processLauncher({ shipEntry: config.shipEntry, harnessBin: config.harnessBin }));
let server: ArenaServer;

beforeAll(async () => {
	server = await startArenaServer(config, sessions, createWorld({ seed: config.seed }));
	config.publicUrl = server.url;
	sessions.start();
});
afterAll(async () => {
	sessions.stop();
	await server.close();
	rmSync(runRoot, { recursive: true, force: true });
});

let nextId = 1;
async function rpc(token: string, method: string, params?: unknown): Promise<unknown> {
	const res = await fetch(`${server.url}/mcp/${token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
	});
	const body = (await res.json()) as { result?: unknown; error?: unknown };
	if (res.status !== 200 || body.error)
		throw new Error(`${method}: ${res.status} ${JSON.stringify(body.error ?? body)}`);
	return body.result;
}
const text = (result: unknown): string => (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";

async function pilot(): Promise<{ token: string; callsign: string }> {
	const res = await fetch(`${server.url}/fly`, { method: "POST", headers: { "x-arena": "fly" } });
	if (res.status !== 200) throw new Error(`fly: ${res.status} ${await res.text()}`);
	const data = (await res.json()) as { callsign: string; mcpUrl: string };
	const token = data.mcpUrl.split("/").at(-1) as string;
	await rpc(token, "initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "e2e", version: "0" },
	});
	await fetch(`${server.url}/mcp/${token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
	});
	return { token, callsign: data.callsign };
}

const call = (token: string, capability: string, reason: string) =>
	rpc(token, "tools/call", { name: "abai_call", arguments: { capability, params: {}, reason } });
const set = (token: string, cell: string, value: number, reason: string) =>
	rpc(token, "tools/call", { name: "abai_set", arguments: { cell, value, reason } });
const cells = async (token: string, names: string[]) =>
	JSON.parse(text(await rpc(token, "tools/call", { name: "abai_cells", arguments: { names } }))) as Record<
		string,
		unknown
	>;

describe("two pilots in one sky", () => {
	it("see each other, meet, and are both lost; then their wrecks are cleared", async () => {
		const a = await pilot();
		const b = await pilot();
		expect(a.callsign).not.toBe(b.callsign);
		const prompt = text(await rpc(a.token, "tools/call", { name: "abai_prompt", arguments: {} }));
		expect(prompt).toContain("not alone in the sky");
		expect(prompt).not.toContain("flight.reset");
		const mine = await cells(a.token, ["ship.callsign"]);
		expect(mine["ship.callsign"]).toBe(a.callsign);
		expect(text(await call(a.token, "flight.takeoff", "up"))).toContain('"ok": true');
		expect(text(await call(b.token, "flight.takeoff", "up"))).toContain('"ok": true');
		// a pursuit: each pilot keeps pointing at the other, which converges whatever the slots and the turns
		const aim = async (from: string, to: string): Promise<Record<string, unknown>> => {
			const me = await cells(from, [
				"ship.east_m",
				"ship.north_m",
				"ship.heading_deg",
				"flight.phase",
				"flight.crash_cause",
				"traffic.near",
			]);
			const them = await cells(to, ["ship.east_m", "ship.north_m"]);
			const dx = Number(them["ship.east_m"]) - Number(me["ship.east_m"]);
			const dz = Number(them["ship.north_m"]) - Number(me["ship.north_m"]);
			const bearing = ((Math.atan2(dx, dz) * 180) / Math.PI + 360) % 360;
			if (me["flight.phase"] === "flying")
				await set(from, "target.heading_deg", Math.round(bearing), "at the other ship");
			return me;
		};
		let sawTraffic = false;
		const deadline = Date.now() + 40000;
		let phases: Record<string, unknown> = {};
		while (Date.now() < deadline) {
			phases = await aim(a.token, b.token);
			const near = phases["traffic.near"] as Array<{ callsign: string }>;
			if (near?.[0]?.callsign === b.callsign) sawTraffic = true;
			if (phases["flight.phase"] === "crashed") break;
			await aim(b.token, a.token);
			await new Promise((done) => setTimeout(done, 300));
		}
		expect(sawTraffic).toBe(true);
		expect(phases["flight.phase"]).toBe("crashed");
		expect(phases["flight.crash_cause"]).toBe("collision");
		const other = await cells(b.token, ["flight.phase", "flight.crash_cause"]);
		expect(other["flight.crash_cause"]).toBe("collision");
		// the frames the viewers see follow the cells by a tick or two
		const settled = Date.now() + 3000;
		while (sessions.summaries().some((s) => s.phase !== "crashed") && Date.now() < settled) {
			await new Promise((done) => setTimeout(done, 100));
		}
		expect(sessions.summaries().map((s) => s.phase)).toEqual(["crashed", "crashed"]);
		// the wrecks go, and with them the sessions
		const gone = Date.now() + 15000;
		while (sessions.live().length > 0 && Date.now() < gone) await new Promise((done) => setTimeout(done, 500));
		expect(sessions.live()).toHaveLength(0);
		const res = await fetch(`${server.url}/mcp/${a.token}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
		});
		expect(res.status).toBe(404);
	}, 90000);
});
