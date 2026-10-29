import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/abai.ts";
import { type Channels, wireChannels } from "../src/channels.ts";
import { createSim, type Sim } from "../src/sim.ts";
import { KNOBS, SENSORS, TICK_HZ } from "../src/tuning.ts";
import { createWorld } from "../src/world.ts";

// One program per process: the declaration module is a singleton, and a
// binding attaches once. The harness side here is the direct binding the
// null harness uses, so the calls take the real path through the stub.
const world = createWorld();
let sim: Sim;
let channels: Channels;
let binding: ReturnType<typeof app.bind>;

async function ticks(n: number): Promise<void> {
	for (let i = 0; i < n; i++) {
		channels.readKnobs();
		app.safepoint();
		sim.tick(1 / TICK_HZ);
		channels.publish();
		await new Promise<void>((done) => setImmediate(done));
	}
}

const cell = (name: string): unknown => binding.readCells([name]).cells[name]?.value;

beforeAll(() => {
	sim = createSim(world);
	channels = wireChannels(app, sim);
	channels.publish();
	binding = app.bind("test");
});

describe("channels", () => {
	it("writes the senses into the cells", async () => {
		expect(cell("flight.phase")).toBe("grounded");
		expect(cell("ship.altitude_m")).toBe(world.pad.height);
		expect(cell("home.distance_m")).toBe(0);
		expect(cell("boundary.distance_m")).toBe(world.boundaryRadius);
		// on the pad, heading north, a spire already stands in the cone: the sense is honest from the start
		expect(cell("threat.name")).toMatch(/^spire-\d\d$/);
		expect(cell("threat.distance_m")).toBeGreaterThan(0);
		const near = cell("obstacles.near") as Array<{ name: string; distance_m: number }>;
		expect(near).toHaveLength(SENSORS.nearCount);
		expect(near[0]?.distance_m).toBeLessThan(near[1]?.distance_m ?? 0);
	});

	it("takes off through the capability and reports the flight", async () => {
		const result = binding.call("flight.takeoff", {}, "test", "approved");
		await ticks(TICK_HZ);
		expect(await result).toEqual({ ok: true, reason: "" });
		expect(cell("flight.phase")).toBe("flying");
		expect(cell("flight.time_s")).toBeCloseTo(1, 0);
		expect(cell("ship.speed_mps")).toBeGreaterThan(0);
		expect(cell("ship.vspeed_mps")).toBeGreaterThan(0);
		const events = binding.readEvents(0).events.map((e) => e.name);
		expect(events).toContain("flight.takeoff");
	});

	it("flies the knobs; the stub refuses a value out of range, and the program clamps its own", async () => {
		const done = await binding.writeKnob("target.heading_deg", 90, "test", "auto");
		expect(done.outcome).toBe("done");
		await ticks(1);
		expect(sim.targets.heading).toBe(90);
		// a harness's write outside the declared range never lands: the stub refuses it
		const high = await binding.writeKnob("target.altitude_m", 9999, "test", "auto");
		expect(high.outcome).toBe("failed");
		expect(high.error).toMatch(/within 40 and 350/);
		await ticks(1);
		expect(sim.targets.altitude).toBe(KNOBS.altitude.default);
		// the program's own store is unchecked, so the loop clamps what it reads
		app.knob<number>("target.altitude_m").set(9999);
		channels.readKnobs();
		expect(sim.targets.altitude).toBe(KNOBS.altitude.range[1]);
		app.knob<number>("target.altitude_m").set(180);
		await ticks(TICK_HZ * 10);
		expect(cell("ship.heading_deg")).toBeCloseTo(90, 0);
	});

	it("refuses an act that does not fit the phase, with the reason", async () => {
		const result = binding.call("flight.go_around", {}, "test", "approved");
		await ticks(2);
		expect(await result).toEqual({ ok: false, reason: "not landing (flying)" });
	});

	it("describes the world", async () => {
		const result = binding.call("world.describe", {}, "test", "auto");
		await ticks(2);
		const d = (await result) as {
			seed: number;
			spires: Array<{ east_m: number; north_m: number }>;
			boundary_radius_m: number;
		};
		expect(d.seed).toBe(world.seed);
		expect(d.spires).toHaveLength(world.spires.length);
		expect(d.spires[0]).toMatchObject({ east_m: world.spires[0]?.x, north_m: world.spires[0]?.z });
		expect(d.boundary_radius_m).toBe(world.boundaryRadius);
	});

	it("reports a crash through the cells and the event", async () => {
		// almost empty: the low warning fires at once, the wings stop within seconds, the ship falls
		sim.state.power = 0.5;
		await ticks(TICK_HZ * 40);
		expect(cell("flight.phase")).toBe("crashed");
		expect(cell("flight.crash_cause")).toBe("terrain");
		const events = binding.readEvents(0).events;
		const crash = events.find((e) => e.name === "flight.crash");
		expect(crash?.payload).toMatchObject({ cause: "terrain", name: "" });
		expect(events.some((e) => e.name === "power.low")).toBe(true);
	});

	it("resets and flies again", async () => {
		const result = binding.call("flight.reset", {}, "test", "approved");
		await ticks(2);
		expect(await result).toEqual({ ok: true, reason: "" });
		expect(cell("flight.phase")).toBe("grounded");
		expect(cell("flight.crash_cause")).toBe("");
		expect(cell("power.pct")).toBe(100);
	});
});
