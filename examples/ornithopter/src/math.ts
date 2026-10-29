export function clamp(value: number, low: number, high: number): number {
	return value < low ? low : value > high ? high : value;
}

export function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

export function smoothstep(t: number): number {
	const x = clamp(t, 0, 1);
	return x * x * (3 - 2 * x);
}

/** An angle folded into [0, 360). */
export function wrap360(deg: number): number {
	const r = deg % 360;
	return r < 0 ? r + 360 : r;
}

/** An angle folded into (-180, 180]. */
export function wrap180(deg: number): number {
	const r = wrap360(deg);
	return r > 180 ? r - 360 : r;
}

export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;

/** Rounded for a cell or a payload: one decimal. */
export function round1(value: number): number {
	const r = Math.round(value * 10) / 10;
	return r === 0 ? 0 : r; // never -0, which JSON and tests both tell apart
}
