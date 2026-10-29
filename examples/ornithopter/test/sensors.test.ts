import { describe, expect, it } from "vitest";
import { relativeBearing, sense } from "../src/sensors.ts";
import { SENSORS } from "../src/tuning.ts";
import type { Spire, World } from "../src/world.ts";

/** A world of a given ground function and spires, enough for sensing. */
function stubWorld(spires: Spire[], ground: (x: number, z: number) => number = () => 0): World {
	return {
		seed: 0,
		size: 6000,
		grid: 2,
		cell: 6000,
		heights: new Float32Array(4),
		pad: { x: 0, z: 0, radius: 60, height: 0 },
		spires,
		boundaryRadius: 2800,
		groundHeight: ground,
		slopeDeg: () => 0,
		describe: () => ({
			seed: 0,
			size: 6000,
			boundaryRadius: 2800,
			pad: { x: 0, z: 0, radius: 60, height: 0 },
			spires: [],
		}),
	};
}

const spire = (name: string, x: number, z: number, top: number, radius = 50): Spire => ({
	name,
	x,
	z,
	radius,
	base: 0,
	top,
});

describe("bearings", () => {
	it("are relative to the heading, positive to the right", () => {
		expect(relativeBearing(0, 100, 0)).toBe(0);
		expect(relativeBearing(100, 0, 0)).toBe(90);
		expect(relativeBearing(-100, 0, 0)).toBe(-90);
		expect(relativeBearing(0, -100, 0)).toBe(180);
		expect(relativeBearing(0, 100, 90)).toBe(-90);
		expect(relativeBearing(100, 0, 350)).toBe(100);
	});
});

describe("sense", () => {
	it("names the nearest spire ahead at the ship's height as the threat", () => {
		const ahead = spire("ahead", 0, 1000, 300);
		const behind = spire("behind", 0, -800, 300);
		const below = spire("below", 300, 1200, 100);
		const far = spire("far", 0, 4000, 500);
		const s = sense(stubWorld([far, ahead, below, behind]), { x: 0, z: 0, altitude: 200, heading: 0, speed: 50 });
		expect(s.near.map((o) => o.name)).toEqual(["behind", "ahead", "below"]);
		expect(s.threat?.name).toBe("ahead");
		expect(s.threat?.distance_m).toBe(950);
		expect(s.threat?.bearing_deg).toBe(0);
		expect(s.threat?.clearance_m).toBe(-100);
	});

	it("ignores a spire outside the cone or out of range", () => {
		const side = spire("side", 1000, 400, 300);
		const far = spire("far", 0, SENSORS.threatRange + 200, 300);
		const s = sense(stubWorld([side, far]), { x: 0, z: 0, altitude: 200, heading: 0, speed: 50 });
		expect(s.near).toHaveLength(2);
		expect(s.threat).toBeUndefined();
	});

	it("counts a spire just below the ship as a threat, and one well below not", () => {
		const close = spire("close", 0, 800, 200 - SENSORS.threatClearanceMargin + 1);
		expect(sense(stubWorld([close]), { x: 0, z: 0, altitude: 200, heading: 0, speed: 50 }).threat?.name).toBe(
			"close",
		);
		const low = spire("low", 0, 800, 200 - SENSORS.threatClearanceMargin - 1);
		expect(sense(stubWorld([low]), { x: 0, z: 0, altitude: 200, heading: 0, speed: 50 }).threat).toBeUndefined();
	});

	it("lists every spire in range, nearest first", () => {
		const many = Array.from({ length: 10 }, (_, i) => spire(`s${i}`, 0, 300 + i * 100, 300));
		const s = sense(stubWorld(many), { x: 0, z: 0, altitude: 200, heading: 180, speed: 50 });
		expect(s.near).toHaveLength(10);
		expect(s.near.map((o) => o.name)).toEqual(many.map((o) => o.name));
		expect(s.threat).toBeUndefined();
	});

	it("finds the threat even behind many nearer spires", () => {
		const crowd = Array.from({ length: 8 }, (_, i) => spire(`behind${i}`, 0, -300 - i * 50, 300));
		const tall = spire("tall", 0, 1400, 400);
		const s = sense(stubWorld([...crowd, tall]), { x: 0, z: 0, altitude: 200, heading: 0, speed: 50 });
		expect(s.near).toHaveLength(9);
		expect(s.near.at(-1)?.name).toBe("tall");
		expect(s.threat?.name).toBe("tall");
	});

	it("reaches farther when the ship is fast", () => {
		const far = spire("far", 0, SENSORS.threatRange + 100, 400);
		const slow = sense(stubWorld([far]), { x: 0, z: 0, altitude: 200, heading: 0, speed: 50 });
		expect(slow.threat).toBeUndefined();
		expect(slow.threatRange).toBe(SENSORS.threatRange);
		const fast = sense(stubWorld([far]), { x: 0, z: 0, altitude: 200, heading: 0, speed: 90 });
		expect(fast.threatRange).toBe(90 * SENSORS.threatSeconds);
		expect(fast.threat?.name).toBe("far");
		const ramp = stubWorld([], (_x, z) => Math.max(0, z) * 0.2);
		const fastAhead = sense(ramp, { x: 0, z: 0, altitude: 100, heading: 0, speed: 90 });
		// sampled every terrainStep metres, up to the lookahead
		const reach = Math.floor((90 * SENSORS.terrainSeconds) / SENSORS.terrainStep) * SENSORS.terrainStep;
		expect(fastAhead.terrainAheadHeight).toBeCloseTo(reach * 0.2, 1);
	});

	it("looks ahead at the terrain along the heading", () => {
		const ramp = stubWorld([], (_x, z) => Math.max(0, z) * 0.2);
		const north = sense(ramp, { x: 0, z: 0, altitude: 100, heading: 0, speed: 50 });
		expect(north.terrainAheadHeight).toBeCloseTo(SENSORS.terrainLookahead * 0.2, 5);
		expect(north.terrainAheadClearance).toBeCloseTo(100 - SENSORS.terrainLookahead * 0.2, 5);
		const south = sense(ramp, { x: 0, z: 0, altitude: 100, heading: 180, speed: 50 });
		expect(south.terrainAheadHeight).toBe(0);
		expect(south.terrainAheadClearance).toBe(100);
	});

	it("measures home, the ground and the wall", () => {
		const s = sense(
			stubWorld([], () => 30),
			{ x: 1000, z: 0, altitude: 130, heading: 0, speed: 50 },
		);
		expect(s.ground).toBe(30);
		expect(s.clearance).toBe(100);
		expect(s.homeDistance).toBe(1000);
		expect(s.homeBearing).toBe(-90);
		expect(s.boundaryDistance).toBe(1800);
	});
});
