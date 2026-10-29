// One frame of the ship for a viewer: what the page draws and what the HUD
// shows. The web server streams it; in arena mode it goes to the arena.
import { round1 } from "./math.ts";
import type { Sim } from "./sim.ts";
import { SENSORS, TRAFFIC } from "./tuning.ts";

export function frame(sim: Sim): Record<string, unknown> {
	const s = sim.state;
	const sense = sim.senses;
	const threat = sense.threat;
	const other = sense.trafficThreat;
	return {
		callsign: sim.callsign,
		x: round1(s.x),
		z: round1(s.z),
		altitude: round1(s.altitude),
		heading: round1(s.heading),
		speed: round1(s.speed),
		vspeed: round1(s.vspeed),
		pitch: round1(s.pitch),
		roll: round1(s.roll),
		power: round1(s.power),
		phase: s.phase,
		time: round1(s.time),
		crashCause: s.crashCause,
		crashName: s.crashName,
		targets: {
			heading: round1(sim.targets.heading),
			altitude: round1(sim.targets.altitude),
			speed: round1(sim.targets.speed),
		},
		clearance: round1(sense.clearance),
		slope: round1(sense.groundSlopeDeg),
		threat: threat
			? {
					name: threat.name,
					distance: threat.distance_m,
					bearing: threat.bearing_deg,
					clearance: threat.clearance_m,
				}
			: null,
		terrainAhead: round1(sense.terrainAheadClearance),
		home: { distance: round1(sense.homeDistance), bearing: round1(sense.homeBearing) },
		boundary: round1(sense.boundaryDistance),
		near: sense.near.slice(0, SENSORS.nearCount),
		traffic: other
			? {
					callsign: other.callsign,
					distance: other.distance_m,
					bearing: other.bearing_deg,
					altitudeDiff: other.altitude_diff_m,
					seconds: other.seconds,
				}
			: null,
		trafficNear: sense.traffic.slice(0, TRAFFIC.nearCount),
	};
}
