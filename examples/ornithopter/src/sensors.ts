// What the ship senses of the world around it: the ground below, the
// obstacles near, the one that threatens, the terrain ahead, home and the
// wall. Computed from the world and the ship's position each tick; the
// cells are written from this.
import { DEG, RAD, round1, wrap180, wrap360 } from "./math.ts";
import { KNOBS, SENSORS, TRAFFIC } from "./tuning.ts";
import type { World } from "./world.ts";

/** What sensing needs of the ship. */
export interface ShipPose {
	x: number;
	z: number;
	altitude: number;
	heading: number;
	speed: number;
}

export interface NearObstacle {
	name: string;
	/** Metres from the ship to the spire's surface, horizontally. */
	distance_m: number;
	/** Relative to the heading, -180 to 180, positive to the right. */
	bearing_deg: number;
	/** The top, above sea level. */
	top_m: number;
	radius_m: number;
	/** The ship's altitude minus the top: negative means the spire stands above the ship. */
	clearance_m: number;
}

/** Another ship, as the arena reports it. */
export interface TrafficShip {
	callsign: string;
	x: number;
	z: number;
	altitude: number;
	heading: number;
	speed: number;
	airborne: boolean;
}

/** Another ship as the ship senses it. */
export interface NearShip {
	callsign: string;
	/** Metres, horizontally. */
	distance_m: number;
	/** Relative to the heading, -180 to 180, positive to the right. */
	bearing_deg: number;
	/** The other ship's altitude minus this one's: positive means it is above. */
	altitude_diff_m: number;
	/** How fast the distance shrinks, metres per second; negative when it grows. */
	closing_mps: number;
	/** Seconds until the two would meet at the present closing speed; -1 when not closing. */
	seconds: number;
}

export interface Senses {
	/** Ground height below the ship. */
	ground: number;
	/** Altitude above the ground below. */
	clearance: number;
	groundSlopeDeg: number;
	/** Every obstacle within range, nearest first; the cell shows the first nearCount. */
	near: NearObstacle[];
	/** The nearest spire ahead that stands at or near the ship's altitude, or none. */
	threat: NearObstacle | undefined;
	/** How far the threat sense reached, metres: the range, or threatSeconds of flight at this speed. */
	threatRange: number;
	/** The highest ground along the heading within the lookahead. */
	terrainAheadHeight: number;
	terrainAheadClearance: number;
	homeDistance: number;
	/** Relative bearing to the pad. */
	homeBearing: number;
	/** Metres to the storm wall; negative past it. */
	boundaryDistance: number;
	/** Every other airborne ship within range, nearest first; the cell shows the first nearCount. */
	traffic: NearShip[];
	/** The other ship soonest to meet this one, within the altitude band and warnSeconds, or none. */
	trafficThreat: NearShip | undefined;
}

/** What another ship looks like from this one. */
export function senseShip(ship: ShipPose, other: TrafficShip): NearShip {
	const dx = other.x - ship.x;
	const dz = other.z - ship.z;
	const distance = Math.hypot(dx, dz);
	const mine = ship.heading * RAD;
	const theirs = other.heading * RAD;
	// the rate at which the distance shrinks: the relative velocity along the line between the ships
	const rvx = other.speed * Math.sin(theirs) - ship.speed * Math.sin(mine);
	const rvz = other.speed * Math.cos(theirs) - ship.speed * Math.cos(mine);
	const closing = distance > 1 ? -(dx * rvx + dz * rvz) / distance : 0;
	return {
		callsign: other.callsign,
		distance_m: round1(distance),
		bearing_deg: round1(relativeBearing(dx, dz, ship.heading)),
		altitude_diff_m: round1(other.altitude - ship.altitude),
		closing_mps: round1(closing),
		seconds: closing > 0.5 ? round1(distance / closing) : -1,
	};
}

/** The compass bearing from the ship to an offset: 0 north, 90 east. */
export function absoluteBearing(dx: number, dz: number): number {
	return wrap360(Math.atan2(dx, dz) * DEG);
}

/** The bearing relative to the heading: 0 ahead, positive right, (-180, 180]. */
export function relativeBearing(dx: number, dz: number, heading: number): number {
	return wrap180(absoluteBearing(dx, dz) - heading);
}

export function sense(world: World, ship: ShipPose, others: readonly TrafficShip[] = []): Senses {
	const ground = world.groundHeight(ship.x, ship.z);
	const near: NearObstacle[] = [];
	for (const spire of world.spires) {
		const dx = spire.x - ship.x;
		const dz = spire.z - ship.z;
		const distance = Math.max(0, Math.hypot(dx, dz) - spire.radius);
		if (distance > SENSORS.nearRange) continue;
		near.push({
			name: spire.name,
			distance_m: round1(distance),
			bearing_deg: round1(relativeBearing(dx, dz, ship.heading)),
			top_m: spire.top,
			radius_m: spire.radius,
			clearance_m: round1(ship.altitude - spire.top),
		});
	}
	near.sort((a, b) => a.distance_m - b.distance_m);
	// the senses reach farther when the ship is fast: the pilot needs seconds, not metres
	const threatRange = Math.max(SENSORS.threatRange, ship.speed * SENSORS.threatSeconds);
	const lookahead = Math.max(SENSORS.terrainLookahead, ship.speed * SENSORS.terrainSeconds);
	const threat = near.find(
		(o) =>
			o.distance_m <= threatRange &&
			Math.abs(o.bearing_deg) <= SENSORS.threatConeDeg &&
			o.clearance_m < SENSORS.threatClearanceMargin,
	);

	const rad = ship.heading * RAD;
	const sin = Math.sin(rad);
	const cos = Math.cos(rad);
	let terrainAheadHeight = ground;
	for (let d = SENSORS.terrainStep; d <= lookahead; d += SENSORS.terrainStep) {
		const h = world.groundHeight(ship.x + sin * d, ship.z + cos * d);
		if (h > terrainAheadHeight) terrainAheadHeight = h;
	}

	// the traffic list reaches as far as warnSeconds of the worst closing speed, so no ship can arrive unseen
	const trafficRange = Math.max(TRAFFIC.nearRange, TRAFFIC.warnSeconds * (ship.speed + KNOBS.speed.range[1]));
	const traffic: NearShip[] = [];
	for (const other of others) {
		if (!other.airborne) continue;
		const seen = senseShip(ship, other);
		if (seen.distance_m <= trafficRange) traffic.push(seen);
	}
	traffic.sort((a, b) => a.distance_m - b.distance_m);
	let trafficThreat: NearShip | undefined;
	for (const t of traffic) {
		if (t.seconds < 0 || t.seconds > TRAFFIC.warnSeconds || Math.abs(t.altitude_diff_m) > TRAFFIC.altitudeBand)
			continue;
		if (!trafficThreat || t.seconds < trafficThreat.seconds) trafficThreat = t;
	}

	const hx = world.pad.x - ship.x;
	const hz = world.pad.z - ship.z;
	return {
		ground,
		clearance: ship.altitude - ground,
		groundSlopeDeg: world.slopeDeg(ship.x, ship.z),
		near,
		threat,
		threatRange,
		terrainAheadHeight,
		terrainAheadClearance: ship.altitude - terrainAheadHeight,
		homeDistance: Math.hypot(hx, hz),
		homeBearing: relativeBearing(hx, hz, ship.heading),
		boundaryDistance: world.boundaryRadius - Math.hypot(ship.x, ship.z),
		traffic,
		trafficThreat,
	};
}
