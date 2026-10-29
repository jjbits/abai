// The dune world: a seeded heightmap, a flat pad at the origin, rock spires
// and the storm wall. One generator serves collision in the simulation and
// the terrain mesh in the browser, which fetches the same grid, so the two
// never disagree about where the ground is.
//
// Coordinates: x east, z north, y up, metres. Heading 0 is north, 90 east.
import { clamp, DEG, lerp, round1, smoothstep } from "./math.ts";
import { WORLD } from "./tuning.ts";

export interface Spire {
	name: string;
	x: number;
	z: number;
	radius: number;
	/** Ground height at the base, above sea level. */
	base: number;
	/** The top, above sea level. */
	top: number;
}

export interface Pad {
	x: number;
	z: number;
	radius: number;
	/** The pad's surface, above sea level. */
	height: number;
}

/** What `world.describe` gives the agent: enough to plan a route. */
export interface WorldDescription {
	seed: number;
	size: number;
	boundaryRadius: number;
	pad: Pad;
	spires: Array<{ name: string; x: number; z: number; radius: number; top: number }>;
}

export interface World {
	readonly seed: number;
	/** Metres on a side, centred on the origin. */
	readonly size: number;
	/** Samples per side of the heightmap. */
	readonly grid: number;
	/** Metres between samples. */
	readonly cell: number;
	/** Row-major: `heights[j * grid + i]` is the ground at x = -size/2 + i * cell, z = -size/2 + j * cell. */
	readonly heights: Float32Array;
	readonly pad: Pad;
	readonly spires: readonly Spire[];
	/** The storm wall's radius from the origin. */
	readonly boundaryRadius: number;
	/** Ground height above sea level, bilinear over the grid, clamped at the edges. */
	groundHeight(x: number, z: number): number;
	/** Steepest slope of the ground, in degrees. */
	slopeDeg(x: number, z: number): number;
	describe(): WorldDescription;
}

export interface WorldOptions {
	seed?: number;
	/** Overrides for tests: no spires, or flat ground. */
	spireCount?: number;
	duneMax?: number;
}

export const DEFAULT_SEED = 7;

/** A small, fast, seeded generator; the same seed gives the same world on every machine. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A lattice value in [0, 1) from integer coordinates and a seed. */
function hash2(i: number, j: number, seed: number): number {
	let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 1442695041)) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	h ^= h >>> 16;
	return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
	const i0 = Math.floor(x);
	const j0 = Math.floor(y);
	const fx = smoothstep(x - i0);
	const fy = smoothstep(y - j0);
	const a = hash2(i0, j0, seed);
	const b = hash2(i0 + 1, j0, seed);
	const c = hash2(i0, j0 + 1, seed);
	const d = hash2(i0 + 1, j0 + 1, seed);
	return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}

/** Layered value noise, normalized to [0, 1]. */
function fbm(x: number, y: number, seed: number, octaves: number): number {
	let sum = 0;
	let amp = 1;
	let norm = 0;
	let fx = x;
	let fy = y;
	for (let o = 0; o < octaves; o++) {
		sum += valueNoise(fx, fy, seed + o * 101) * amp;
		norm += amp;
		amp *= 0.5;
		fx *= 2;
		fy *= 2;
	}
	return sum / norm;
}

/** Raw dune height before the pad is flattened: broad swells and sharper crests, 0 to duneMax. */
function duneHeight(x: number, z: number, seed: number, duneMax: number): number {
	const swell = fbm(x / 1100, z / 1100, seed, 4);
	const crest = 1 - Math.abs(2 * fbm(x / 260 + (0.37 * z) / 900, z / 900, seed + 7, 2) - 1);
	return duneMax * clamp(0.55 * swell + 0.45 * crest * crest, 0, 1);
}

export function createWorld(options: WorldOptions = {}): World {
	const seed = options.seed ?? DEFAULT_SEED;
	const spireCount = options.spireCount ?? WORLD.spireCount;
	const duneMax = options.duneMax ?? WORLD.duneMax;
	const { size, grid } = WORLD;
	const cell = size / (grid - 1);
	const half = size / 2;

	// the pad: flat at the raw height of the origin, blended into the dunes past its edge
	const padHeight = round1(duneHeight(0, 0, seed, duneMax));
	const pad: Pad = { x: 0, z: 0, radius: WORLD.padRadius, height: padHeight };
	const flatTo = pad.radius + cell;
	const blendTo = 2 * pad.radius + cell;
	const heights = new Float32Array(grid * grid);
	for (let j = 0; j < grid; j++) {
		const z = -half + j * cell;
		for (let i = 0; i < grid; i++) {
			const x = -half + i * cell;
			let h = duneHeight(x, z, seed, duneMax);
			const r = Math.hypot(x, z);
			if (r < flatTo) h = padHeight;
			else if (r < blendTo) h = lerp(padHeight, h, smoothstep((r - flatTo) / (blendTo - flatTo)));
			heights[j * grid + i] = h;
		}
	}

	const groundHeight = (x: number, z: number): number => {
		const gx = clamp((x + half) / cell, 0, grid - 1);
		const gz = clamp((z + half) / cell, 0, grid - 1);
		const i0 = Math.min(Math.floor(gx), grid - 2);
		const j0 = Math.min(Math.floor(gz), grid - 2);
		const fx = gx - i0;
		const fz = gz - j0;
		const row0 = j0 * grid;
		const row1 = row0 + grid;
		const h0 = lerp(heights[row0 + i0] as number, heights[row0 + i0 + 1] as number, fx);
		const h1 = lerp(heights[row1 + i0] as number, heights[row1 + i0 + 1] as number, fx);
		return lerp(h0, h1, fz);
	};

	const slopeDeg = (x: number, z: number): number => {
		const d = cell / 2;
		const dx = (groundHeight(x + d, z) - groundHeight(x - d, z)) / (2 * d);
		const dz = (groundHeight(x, z + d) - groundHeight(x, z - d)) / (2 * d);
		return Math.atan(Math.hypot(dx, dz)) * DEG;
	};

	// the spires: placed by the seed, clear of the pad, of each other and of the wall
	const rng = mulberry32(seed * 7919 + 13);
	const spires: Spire[] = [];
	const outer = WORLD.boundaryRadius - WORLD.spireMinFromWall;
	for (let n = 0; n < spireCount; n++) {
		let placed = false;
		for (let attempt = 0; attempt < 500 && !placed; attempt++) {
			const radius = Math.round(lerp(WORLD.spireRadius[0], WORLD.spireRadius[1], rng()));
			const angle = rng() * 2 * Math.PI;
			const dist = lerp(WORLD.spireMinFromPad + radius, outer - radius, rng());
			const x = Math.round(Math.sin(angle) * dist);
			const z = Math.round(Math.cos(angle) * dist);
			const height = lerp(WORLD.spireHeight[0], WORLD.spireHeight[1], rng());
			if (spires.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + radius + WORLD.spireMinGap)) continue;
			const base = round1(groundHeight(x, z));
			spires.push({
				name: `spire-${String(n + 1).padStart(2, "0")}`,
				x,
				z,
				radius,
				base,
				top: Math.round(base + height),
			});
			placed = true;
		}
		if (!placed) throw new Error(`could not place spire ${n + 1} of ${spireCount} with seed ${seed}`);
	}

	return {
		seed,
		size,
		grid,
		cell,
		heights,
		pad,
		spires,
		boundaryRadius: WORLD.boundaryRadius,
		groundHeight,
		slopeDeg,
		describe: () => ({
			seed,
			size,
			boundaryRadius: WORLD.boundaryRadius,
			pad: { ...pad },
			spires: spires.map(({ name, x, z, radius, top }) => ({ name, x, z, radius, top })),
		}),
	};
}
