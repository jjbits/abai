import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GameServer, startServer } from "../src/server.ts";
import { createSim, type Sim } from "../src/sim.ts";
import { createWorld } from "../src/world.ts";

let sim: Sim;
let server: GameServer;

beforeAll(async () => {
	sim = createSim(createWorld());
	server = await startServer(sim, 0);
});

afterAll(async () => {
	await server.close();
});

describe("the web server", () => {
	it("serves the page and the renderer", async () => {
		const page = await fetch(server.url);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("ornithopter");
		const script = await fetch(`${server.url}app.js`);
		expect(script.headers.get("content-type")).toContain("javascript");
		const three = await fetch(`${server.url}vendor/three.module.js`);
		expect(three.status).toBe(200);
		expect((await three.text()).length).toBeGreaterThan(100000);
	});

	it("serves the world once, the heights as floats", async () => {
		const world = (await (await fetch(`${server.url}world`)).json()) as {
			seed: number;
			grid: number;
			pid: number;
			spires: Array<{ base: number }>;
			pad: { height: number };
		};
		expect(world.seed).toBe(sim.world.seed);
		expect(world.pid).toBe(process.pid);
		expect(world.spires).toHaveLength(sim.world.spires.length);
		expect(world.spires[0]?.base).toBe(sim.world.spires[0]?.base);
		const heights = new Float32Array(await (await fetch(`${server.url}heights`)).arrayBuffer());
		expect(heights).toHaveLength(world.grid * world.grid);
		expect(heights[0]).toBe(sim.world.heights[0]);
	});

	it("streams the state and the events", async () => {
		const res = await fetch(`${server.url}stream`);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const reader = res.body?.getReader();
		if (!reader) throw new Error("no body");
		const decoder = new TextDecoder();
		let text = "";
		while (!text.includes("event: state")) text += decoder.decode((await reader.read()).value);
		expect(text).toContain('"phase":"grounded"');
		sim.takeoff();
		while (!text.includes("event: game")) text += decoder.decode((await reader.read()).value);
		expect(text).toContain('"name":"flight.takeoff"');
		await reader.cancel();
	});

	it("answers nothing else", async () => {
		expect((await fetch(`${server.url}nope`)).status).toBe(404);
		expect((await fetch(`${server.url}..%2Fpackage.json`)).status).toBe(404);
		expect((await fetch(server.url, { method: "POST" })).status).toBe(405);
	});
});
