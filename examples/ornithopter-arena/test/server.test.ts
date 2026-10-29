import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorld } from "ornithopter/src/world.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configFrom } from "../src/config.ts";
import { type ArenaServer, startArenaServer } from "../src/server.ts";
import { Sessions } from "../src/sessions.ts";
import { fakeLauncher } from "./fake-launcher.ts";

const runRoot = mkdtempSync(join(tmpdir(), "arena-server-"));
const config = configFrom(
	{
		ARENA_RUN_ROOT: runRoot,
		ARENA_PORT: "0",
		ARENA_MAX_SESSIONS: "3",
		ARENA_PER_ADDRESS: "2",
		ARENA_REQUESTS_PER_SECOND: "20",
		ARENA_PUBLIC_URL: "https://arena.example",
	},
	{ shipEntry: "ship", harnessBin: "harness" },
);
const { launcher, ships } = fakeLauncher();
const sessions = new Sessions(config, launcher);
let server: ArenaServer;

beforeAll(async () => {
	server = await startArenaServer(config, sessions, createWorld({ seed: config.seed }));
});
afterAll(async () => {
	sessions.stop();
	await server.close();
	rmSync(runRoot, { recursive: true, force: true });
});

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
	fetch(`${server.url}/${path.replace(/^\//, "")}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
const fly = (headers: Record<string, string> = {}) => post("/fly", undefined, { "x-arena": "fly", ...headers });

async function readSse(path: string, until: (text: string) => boolean, timeoutMs = 3000): Promise<string> {
	const res = await fetch(`${server.url}/${path.replace(/^\//, "")}`);
	const reader = res.body?.getReader();
	if (!reader) throw new Error("no body");
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Date.now() + timeoutMs;
	while (!until(text) && Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		text += decoder.decode(value);
	}
	await reader.cancel();
	return text;
}

describe("the arena server", () => {
	it("serves the page with a policy, the world, and the heights", async () => {
		const page = await fetch(`${server.url}/`);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toMatch(/script-src 'self' 'sha256-/);
		expect(page.headers.get("x-frame-options")).toBe("DENY");
		expect(await page.text()).toContain("ornithopter arena");
		const world = (await (await fetch(`${server.url}/world`)).json()) as {
			slots: unknown[];
			limits: { maxSessions: number };
		};
		expect(world.slots).toHaveLength(3);
		expect(world.limits.maxSessions).toBe(3);
		expect((await (await fetch(`${server.url}/heights`)).arrayBuffer()).byteLength).toBe(256 * 256 * 4);
		expect((await fetch(`${server.url}/nope`)).status).toBe(404);
		expect((await fetch(`${server.url}/..%2Fpackage.json`)).status).toBe(404);
	});

	it("mints a pilot on Fly and bridges its agent's messages", async () => {
		const flown = await fly();
		expect(flown.status).toBe(200);
		const data = (await flown.json()) as {
			callsign: string;
			mcpUrl: string;
			pageUrl: string;
			commands: { claude: string; codex: string };
		};
		expect(data.mcpUrl).toMatch(/^https:\/\/arena\.example\/mcp\/[0-9a-f]{32}$/);
		expect(data.pageUrl).toBe(`https://arena.example/?follow=${data.callsign}`);
		expect(data.commands.claude).toContain("--transport http");
		const token = data.mcpUrl.split("/").at(-1) as string;
		const init = await post(`/mcp/${token}`, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18" },
		});
		expect(init.status).toBe(200);
		expect(init.headers.get("mcp-session-id")).toBe(token);
		expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("fake");
		const note = await post(`/mcp/${token}`, { jsonrpc: "2.0", method: "notifications/initialized" });
		expect(note.status).toBe(202);
		const call = await post(`/mcp/${token}`, {
			jsonrpc: "2.0",
			id: "c1",
			method: "tools/call",
			params: { name: "abai_cells", arguments: {} },
		});
		expect(
			((await call.json()) as { id: string; result: { content: Array<{ text: string }> } }).result.content[0]?.text,
		).toBe("called abai_cells");
		expect((await fetch(`${server.url}/mcp/${token}`)).status).toBe(405);
		expect((await fetch(`${server.url}/mcp/${token}`, { method: "DELETE" })).status).toBe(200);
		expect((await post(`/mcp/${"0".repeat(32)}`, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(404);
		expect((await post(`/mcp/${token}`, "{not json")).status).toBe(400);
		expect((await post(`/mcp/${token}`, [{ jsonrpc: "2.0", id: 1, method: "ping" }])).status).toBe(400);
		// a wait is held open as long as it takes
		const started = Date.now();
		const wait = await post(`/mcp/${token}`, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "abai_wait", arguments: { wait_s: 1 } },
		});
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
		expect(((await wait.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]?.text).toBe(
			"no wake in 1s",
		);
	});

	it("rations a session's requests", async () => {
		const data = (await (await fly()).json()) as { mcpUrl: string };
		const token = data.mcpUrl.split("/").at(-1) as string;
		const statuses: number[] = [];
		for (let i = 0; i < 50; i++)
			statuses.push((await post(`/mcp/${token}`, { jsonrpc: "2.0", id: i, method: "ping" })).status);
		expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(30);
		expect(statuses).toContain(429);
	});

	it("refuses past the caps with the reason, a cross-site Fly, and a forged address", async () => {
		// two sessions exist from this address already, and the cap per address is two
		const third = await fly();
		expect(third.status).toBe(429);
		expect(((await third.json()) as { error: string }).error).toContain("already have");
		// without the page's header, a plain POST is refused: no cross-site page can press Fly
		expect((await post("/fly")).status).toBe(403);
		// the proxy is not trusted here, so a forwarded address changes nothing
		expect((await fly({ "x-forwarded-for": "203.0.113.9" })).status).toBe(429);
	});

	it("refuses a message without a method, an oversized body, and too many requests in flight", async () => {
		const data = (await (await fetch(`${server.url}/world`)).json()) as unknown;
		expect(data).toBeDefined();
		const token = [...sessions.live()][0]?.token as string;
		expect((await post(`/mcp/${token}`, { jsonrpc: "2.0", id: 1 })).status).toBe(400);
		expect((await post(`/mcp/${token}`, { jsonrpc: "2.0", id: 1, method: 7 })).status).toBe(400);
		const big = await post(`/mcp/${token}`, {
			jsonrpc: "2.0",
			id: 1,
			method: "ping",
			params: { pad: "x".repeat(70_000) },
		});
		expect(big.status).toBe(413);
		// nine waits at once: the ninth is refused, the others are answered
		const waits = Array.from({ length: 9 }, (_, i) =>
			post(`/mcp/${token}`, {
				jsonrpc: "2.0",
				id: 100 + i,
				method: "tools/call",
				params: { name: "abai_wait", arguments: { wait_s: 1 } },
			}),
		);
		const statuses = (await Promise.all(waits)).map((r) => r.status).sort();
		expect(statuses.filter((st) => st === 429).length).toBeGreaterThanOrEqual(1);
		expect(statuses.filter((st) => st === 200).length).toBeGreaterThanOrEqual(5);
	});

	it("streams every ship to viewers and one ship to its followers", async () => {
		const callsign = ships[0]?.spec.callsign as string;
		ships[0]?.frame({
			x: 1,
			z: 2,
			altitude: 180,
			heading: 90,
			speed: 50,
			pitch: 0,
			roll: 0,
			phase: "flying",
			crashCause: "",
		});
		const stream = await readSse("stream", (t) => t.includes("event: ships"));
		expect(stream).toContain("event: hello");
		expect(stream).toContain(`"callsign":"${callsign}"`);
		expect(stream).toContain('"phase":"flying"');
		const follow = await readSse(`follow/${callsign}`, (t) => t.includes("event: state"));
		expect(follow).toContain('"heading":90');
		const gone = await readSse("follow/nobody-here", (t) => t.includes("event: gone"));
		expect(gone).toContain("event: gone");
		// a session ending reaches both streams
		const watching = readSse("stream", (t) => t.includes('"kind":"left"'), 4000);
		await new Promise((done) => setTimeout(done, 100));
		const token = [...sessions.live().map((s) => s.token)][0] as string;
		sessions.end(token, "test");
		expect(await watching).toContain('"kind":"left"');
	});
});
