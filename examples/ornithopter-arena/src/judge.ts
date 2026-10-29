// The arena's one rule the ships cannot apply themselves: two airborne
// ships close enough, horizontally and vertically, have collided, and both
// are lost. Pure, so it is tested as a function.
import { TRAFFIC } from "ornithopter/src/tuning.ts";

export interface Position {
	callsign: string;
	x: number;
	z: number;
	altitude: number;
	airborne: boolean;
}

export interface Collision {
	a: string;
	b: string;
	distance: number;
}

/** Every colliding pair among the positions, each pair once. */
export function judge(positions: readonly Position[]): Collision[] {
	const hits: Collision[] = [];
	const flying = positions.filter((p) => p.airborne);
	for (let i = 0; i < flying.length; i++) {
		for (let j = i + 1; j < flying.length; j++) {
			const a = flying[i] as Position;
			const b = flying[j] as Position;
			if (Math.abs(a.altitude - b.altitude) >= TRAFFIC.collisionAltitude) continue;
			const distance = Math.hypot(a.x - b.x, a.z - b.z);
			if (distance < TRAFFIC.collisionRadius) hits.push({ a: a.callsign, b: b.callsign, distance });
		}
	}
	return hits;
}

/** The spawn slots: evenly around a ring on the pad, far enough apart that two ships taking off together do not meet. */
export function spawnSlots(count: number, radius: number): Array<{ x: number; z: number }> {
	const slots: Array<{ x: number; z: number }> = [];
	for (let i = 0; i < count; i++) {
		const angle = (i / count) * 2 * Math.PI;
		slots.push({ x: Math.round(Math.sin(angle) * radius), z: Math.round(Math.cos(angle) * radius) });
	}
	return slots;
}
