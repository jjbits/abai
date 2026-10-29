import { TRAFFIC } from "ornithopter/src/tuning.ts";
import { describe, expect, it } from "vitest";
import { judge, spawnSlots } from "../src/judge.ts";

const ship = (callsign: string, x: number, z: number, altitude: number, airborne = true) => ({
	callsign,
	x,
	z,
	altitude,
	airborne,
});

describe("the collision judge", () => {
	it("finds two airborne ships close in every direction, and nothing else", () => {
		expect(judge([ship("a", 0, 0, 180), ship("b", 20, 10, 190)])).toEqual([
			{ a: "a", b: "b", distance: Math.hypot(20, 10) },
		]);
		expect(judge([ship("a", 0, 0, 180), ship("b", TRAFFIC.collisionRadius, 0, 180)])).toEqual([]);
		expect(judge([ship("a", 0, 0, 180), ship("b", 0, 0, 180 + TRAFFIC.collisionAltitude)])).toEqual([]);
		expect(judge([ship("a", 0, 0, 35, false), ship("b", 5, 0, 35, false)])).toEqual([]);
		expect(judge([ship("a", 0, 0, 100), ship("b", 5, 0, 35, false)])).toEqual([]);
	});

	it("reports each pair once among many", () => {
		const hits = judge([ship("a", 0, 0, 180), ship("b", 10, 0, 180), ship("c", 20, 0, 180), ship("d", 500, 0, 180)]);
		expect(hits.map((h) => `${h.a}-${h.b}`).sort()).toEqual(["a-b", "a-c", "b-c"]);
	});

	it("lays the spawn slots on the ring, farther apart than a collision", () => {
		const slots = spawnSlots(18, TRAFFIC.spawnRadius);
		expect(slots).toHaveLength(18);
		for (const s of slots) expect(Math.hypot(s.x, s.z)).toBeCloseTo(TRAFFIC.spawnRadius, -1);
		for (let i = 0; i < slots.length; i++) {
			const a = slots[i] as { x: number; z: number };
			const b = slots[(i + 1) % slots.length] as { x: number; z: number };
			expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(TRAFFIC.collisionRadius + 5);
		}
	});
});
