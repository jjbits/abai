import { describe, expect, it } from "vitest";
import { WORLD } from "../src/tuning.ts";
import { createWorld, DEFAULT_SEED } from "../src/world.ts";

describe("world", () => {
	const world = createWorld();

	it("is the same for a seed and different for another", () => {
		const again = createWorld({ seed: DEFAULT_SEED });
		expect(Array.from(again.heights.subarray(0, 2000))).toEqual(Array.from(world.heights.subarray(0, 2000)));
		expect(again.spires).toEqual(world.spires);
		const other = createWorld({ seed: 99 });
		expect(other.spires).not.toEqual(world.spires);
		expect(other.heights[12345]).not.toBe(world.heights[12345]);
	});

	it("keeps the dunes between sea level and the tallest crest", () => {
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		for (const h of world.heights) {
			if (h < min) min = h;
			if (h > max) max = h;
		}
		expect(min).toBeGreaterThanOrEqual(0);
		expect(max).toBeLessThanOrEqual(WORLD.duneMax + 1e-3);
		expect(max).toBeGreaterThan(WORLD.duneMax * 0.5);
	});

	it("flattens the pad", () => {
		for (const [x, z] of [
			[0, 0],
			[40, 0],
			[0, -40],
			[30, 30],
			[-55, 10],
		]) {
			expect(world.groundHeight(x, z)).toBeCloseTo(world.pad.height, 3);
		}
		expect(world.slopeDeg(0, 0)).toBeLessThan(0.1);
		expect(world.slopeDeg(30, -30)).toBeLessThan(0.1);
	});

	it("interpolates the grid it serves", () => {
		const i = 100;
		const j = 37;
		const x = -world.size / 2 + i * world.cell;
		const z = -world.size / 2 + j * world.cell;
		expect(world.groundHeight(x, z)).toBeCloseTo(world.heights[j * world.grid + i] as number, 4);
		const mid =
			((world.heights[j * world.grid + i] as number) + (world.heights[j * world.grid + i + 1] as number)) / 2;
		expect(world.groundHeight(x + world.cell / 2, z)).toBeCloseTo(mid, 4);
	});

	it("clamps outside the grid", () => {
		expect(world.groundHeight(1e6, -1e6)).toBeCloseTo(world.heights[world.grid - 1] as number, 4);
		expect(world.groundHeight(-1e6, 1e6)).toBeCloseTo(world.heights[(world.grid - 1) * world.grid] as number, 4);
	});

	it("places the spires clear of the pad, each other and the wall", () => {
		expect(world.spires).toHaveLength(WORLD.spireCount);
		for (const s of world.spires) {
			const r = Math.hypot(s.x, s.z);
			expect(r - s.radius).toBeGreaterThanOrEqual(WORLD.spireMinFromPad - 2);
			expect(r + s.radius).toBeLessThanOrEqual(WORLD.boundaryRadius - WORLD.spireMinFromWall + 2);
			expect(s.top - s.base).toBeGreaterThanOrEqual(WORLD.spireHeight[0] - 1);
			expect(s.top - s.base).toBeLessThanOrEqual(WORLD.spireHeight[1] + 1);
			expect(s.base).toBeCloseTo(world.groundHeight(s.x, s.z), 0);
		}
		for (let a = 0; a < world.spires.length; a++) {
			for (let b = a + 1; b < world.spires.length; b++) {
				const p = world.spires[a] as (typeof world.spires)[number];
				const q = world.spires[b] as (typeof world.spires)[number];
				expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeGreaterThanOrEqual(
					p.radius + q.radius + WORLD.spireMinGap - 2,
				);
			}
		}
	});

	it("pins the default world's numbers", () => {
		// golden values: a generator change that keeps the world self-consistent still shows here
		expect(world.pad.height).toBe(34.5);
		expect(world.spires[0]).toEqual({ name: "spire-01", x: 6, z: 2007, radius: 42, base: 50.7, top: 344 });
		expect(Math.min(...world.spires.map((s) => s.top))).toBe(222);
		expect(Math.max(...world.spires.map((s) => s.top))).toBe(402);
		let sum = 0;
		for (const h of world.heights) sum += h;
		expect(sum).toBeCloseTo(3058655.4, 0);
	});

	it("honours the test overrides", () => {
		const flat = createWorld({ seed: 1, spireCount: 0, duneMax: 0 });
		expect(flat.spires).toHaveLength(0);
		expect(flat.groundHeight(1234, -2000)).toBe(0);
		expect(flat.pad.height).toBe(0);
	});

	it("describes itself for the agent", () => {
		const d = world.describe();
		expect(d.spires).toHaveLength(WORLD.spireCount);
		expect(d.spires[0]).toEqual({
			name: "spire-01",
			x: expect.any(Number),
			z: expect.any(Number),
			radius: expect.any(Number),
			top: expect.any(Number),
		});
		expect(d.pad.radius).toBe(WORLD.padRadius);
		expect(d.boundaryRadius).toBe(WORLD.boundaryRadius);
	});
});
