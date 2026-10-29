// The wiring between the flight model and the agent's channels: the senses
// into cells, the knobs into the autopilot's targets, the capabilities onto
// the ship's acts, the ship's events onto the declared events.
import type { Abaigram } from "abai";
import { clamp, round1 } from "./math.ts";
import type { Sim } from "./sim.ts";
import { KNOBS, SENSORS, TRAFFIC } from "./tuning.ts";

export interface Channels {
	/** Copy the knobs into the autopilot's targets. Before a tick. */
	readKnobs(): void;
	/** Write every cell from the ship's state and senses. After a tick. */
	publish(): void;
}

export function wireChannels(app: Abaigram, sim: Sim): Channels {
	const num = (name: string) => app.cell<number>(name);
	const cells = {
		east: num("ship.east_m"),
		north: num("ship.north_m"),
		altitude: num("ship.altitude_m"),
		heading: num("ship.heading_deg"),
		speed: num("ship.speed_mps"),
		vspeed: num("ship.vspeed_mps"),
		clearance: num("ship.clearance_m"),
		pitch: num("ship.pitch_deg"),
		roll: num("ship.roll_deg"),
		slope: num("ground.slope_deg"),
		power: num("power.pct"),
		phase: app.cell<string>("flight.phase"),
		time: num("flight.time_s"),
		crashCause: app.cell<string>("flight.crash_cause"),
		threatName: app.cell<string>("threat.name"),
		threatDistance: num("threat.distance_m"),
		threatBearing: num("threat.bearing_deg"),
		threatClearance: num("threat.clearance_m"),
		threatRadius: num("threat.radius_m"),
		terrainAhead: num("terrain.ahead_clearance_m"),
		homeDistance: num("home.distance_m"),
		homeBearing: num("home.bearing_deg"),
		boundary: num("boundary.distance_m"),
		near: app.cell<unknown[]>("obstacles.near"),
		callsign: app.cell<string>("ship.callsign"),
		trafficCallsign: app.cell<string>("traffic.callsign"),
		trafficDistance: num("traffic.distance_m"),
		trafficBearing: num("traffic.bearing_deg"),
		trafficAltDiff: num("traffic.altitude_diff_m"),
		trafficClosing: num("traffic.closing_mps"),
		trafficSeconds: num("traffic.seconds"),
		trafficNear: app.cell<unknown[]>("traffic.near"),
	};
	const knobs = {
		heading: app.knob<number>("target.heading_deg"),
		altitude: app.knob<number>("target.altitude_m"),
		speed: app.knob<number>("target.speed_mps"),
	};
	// sized cells allocate on write, so they are written only when they change; the trackers start at a
	// value no state equals, so the first publish writes every one of them
	let lastPhase: string | undefined;
	let lastCrash: string | undefined;
	let lastThreat: string | undefined;
	let lastNear: string | undefined;
	let lastCallsign: string | undefined;
	let lastTrafficCallsign: string | undefined;
	let lastTrafficNear: string | undefined;

	for (const name of app.manifest.events.map((e) => e.name)) app.event(name);
	sim.onEvent(({ name, payload }) => app.event(name).emit(payload));

	app.capability("flight.takeoff", () => sim.takeoff());
	app.capability("flight.land", () => sim.land());
	app.capability("flight.go_around", () => sim.goAround());
	// not declared in the arena, where a crash is final
	if (app.manifest.capabilities.some((c) => c.name === "flight.reset"))
		app.capability("flight.reset", () => sim.reset());
	app.capability("world.describe", () => {
		// the map in the cells' own words: east and north, as the ship reports its position
		const d = sim.world.describe();
		return {
			seed: d.seed,
			size_m: d.size,
			boundary_radius_m: d.boundaryRadius,
			pad: { east_m: d.pad.x, north_m: d.pad.z, radius_m: d.pad.radius, height_m: d.pad.height },
			spires: d.spires.map((s) => ({ name: s.name, east_m: s.x, north_m: s.z, radius_m: s.radius, top_m: s.top })),
		};
	});

	return {
		readKnobs(): void {
			const t = sim.targets;
			t.heading = clamp(Number(knobs.heading.get()), KNOBS.heading.range[0], KNOBS.heading.range[1]);
			t.altitude = clamp(Number(knobs.altitude.get()), KNOBS.altitude.range[0], KNOBS.altitude.range[1]);
			t.speed = clamp(Number(knobs.speed.get()), KNOBS.speed.range[0], KNOBS.speed.range[1]);
		},
		publish(): void {
			const s = sim.state;
			const sense = sim.senses;
			cells.east.set(round1(s.x));
			cells.north.set(round1(s.z));
			cells.altitude.set(round1(s.altitude));
			cells.heading.set(round1(s.heading));
			cells.speed.set(round1(s.speed));
			cells.vspeed.set(round1(s.vspeed));
			cells.clearance.set(round1(sense.clearance));
			cells.pitch.set(round1(s.pitch));
			cells.roll.set(round1(s.roll));
			cells.slope.set(round1(sense.groundSlopeDeg));
			cells.power.set(round1(s.power));
			cells.time.set(round1(s.time));
			const threat = sense.threat;
			cells.threatDistance.set(threat ? threat.distance_m : -1);
			cells.threatBearing.set(threat ? threat.bearing_deg : 0);
			cells.threatClearance.set(threat ? threat.clearance_m : 0);
			cells.threatRadius.set(threat ? threat.radius_m : 0);
			cells.terrainAhead.set(round1(sense.terrainAheadClearance));
			cells.homeDistance.set(round1(sense.homeDistance));
			cells.homeBearing.set(round1(sense.homeBearing));
			cells.boundary.set(round1(sense.boundaryDistance));
			const other = sense.trafficThreat;
			cells.trafficDistance.set(other ? other.distance_m : -1);
			cells.trafficBearing.set(other ? other.bearing_deg : 0);
			cells.trafficAltDiff.set(other ? other.altitude_diff_m : 0);
			cells.trafficClosing.set(other ? other.closing_mps : 0);
			cells.trafficSeconds.set(other ? other.seconds : -1);
			if (sim.callsign !== lastCallsign) {
				lastCallsign = sim.callsign;
				cells.callsign.set(sim.callsign);
			}
			const otherName = other?.callsign ?? "";
			if (otherName !== lastTrafficCallsign) {
				lastTrafficCallsign = otherName;
				cells.trafficCallsign.set(otherName);
			}
			const ships = sense.traffic.slice(0, TRAFFIC.nearCount);
			const shipsKey = ships
				.map(
					(t) =>
						`${t.callsign}:${Math.round(t.distance_m / 10)}:${Math.round(t.bearing_deg)}:${Math.round(t.seconds)}:${Math.round(t.altitude_diff_m / 10)}:${Math.round(t.closing_mps)}`,
				)
				.join(",");
			if (shipsKey !== lastTrafficNear) {
				lastTrafficNear = shipsKey;
				cells.trafficNear.set(ships.map((t) => ({ ...t })));
			}
			if (s.phase !== lastPhase) {
				lastPhase = s.phase;
				cells.phase.set(s.phase);
			}
			if (s.crashCause !== lastCrash) {
				lastCrash = s.crashCause;
				cells.crashCause.set(s.crashCause);
			}
			const threatName = threat?.name ?? "";
			if (threatName !== lastThreat) {
				lastThreat = threatName;
				cells.threatName.set(threatName);
			}
			const listed = sense.near.slice(0, SENSORS.nearCount);
			// the key folds in the altitude too, so a hover that moves only vertically still refreshes the clearances
			const nearKey = `${Math.round(s.altitude / 10)}|${listed.map((o) => `${o.name}:${Math.round(o.distance_m / 10)}:${Math.round(o.bearing_deg)}`).join(",")}`;
			if (nearKey !== lastNear) {
				lastNear = nearKey;
				cells.near.set(listed.map((o) => ({ ...o })));
			}
		},
	};
}
