// The scripted flight behind `--demo`, which `abaikit check` runs: headless
// and fast-forward, no timers. Leg one is a picture of what the agent is
// meant to do, in code: take off, head for the nearest spire, turn away
// when the threat sense says so, fly home, land on the pad. Leg two is what
// it must not do: take off again on a nearly drained ship, slow into a
// stall, fly at the storm wall until warned, then into the nearest spire;
// then reset. Between them every declared event and cell is exercised.
import type { Abaigram } from "abai";
import type { Channels } from "./channels.ts";
import { wrap360 } from "./math.ts";
import type { Sim, SimEvent } from "./sim.ts";
import { TICK_HZ } from "./tuning.ts";

/** Seconds of simulated flight after which the demo ends whatever the ship is doing. */
export const DEMO_CAP_S = 400;

const TURN_AT_M = 900;
const TURN_BY_DEG = 120;
const TURN_FOR_S = 20;
const HOME_AFTER_S = 60;
const DESCEND_WITHIN_M = 1200;
const LAND_WITHIN_M = 300;
/** Leg two starts with this much power: enough to reach a spire, little enough to warn. */
const DRAINED_PCT = 26;
const STALL_AT_S = 6;
const STALL_FOR_S = 8;
/** A phantom ship closes head-on during this window of leg two, so the traffic sense is exercised. */
const GHOST_FROM_S = 16;
const GHOST_FOR_S = 10;

export async function runDemo(app: Abaigram, sim: Sim, channels: Channels): Promise<string> {
	const dt = 1 / TICK_HZ;
	const heading = app.knob<number>("target.heading_deg");
	const altitude = app.knob<number>("target.altitude_m");
	const counts = new Map<string, number>();
	sim.onEvent((e: SimEvent) => counts.set(e.name, (counts.get(e.name) ?? 0) + 1));

	const speed = app.knob<number>("target.speed_mps");
	let t = 0;
	let turnUntil = -1;
	let tick = 0;
	let leg = 1;
	let legStart = 0;
	for (; t < DEMO_CAP_S; t += dt, tick++) {
		const s = sim.state;
		const sense = sim.senses;
		const flown = t - legStart;
		if (leg === 1 && s.phase === "landed") {
			// leg two: the ship has little power left, and the pilot does everything wrong
			leg = 2;
			legStart = t;
			s.power = DRAINED_PCT;
			sim.takeoff();
		} else if (leg === 2 && s.phase === "crashed") {
			sim.reset();
			break;
		} else if (leg === 2 && s.phase === "flying") {
			speed.set(flown > STALL_AT_S && flown < STALL_AT_S + STALL_FOR_S ? 15 : 50);
			if (flown > GHOST_FROM_S && flown < GHOST_FROM_S + GHOST_FOR_S) {
				// a ghost ahead at the ship's altitude, coming the other way, from 1500 m
				const ahead = 1500 - 100 * (flown - GHOST_FROM_S);
				const rad = (s.heading * Math.PI) / 180;
				sim.setTraffic([
					{
						callsign: "ghost",
						x: s.x + Math.sin(rad) * ahead,
						z: s.z + Math.cos(rad) * ahead,
						altitude: s.altitude,
						heading: wrap360(s.heading + 180),
						speed: 50,
						airborne: true,
					},
				]);
			} else sim.setTraffic([]);
			if (!counts.has("boundary.warning")) {
				// straight away from home, at the wall, until it warns
				heading.set(wrap360(s.heading + sense.homeBearing + 180));
			} else if (sense.near[0]) {
				heading.set(wrap360(s.heading + sense.near[0].bearing_deg));
				altitude.set(Math.max(40, sense.near[0].top_m - 60));
			}
		} else if (s.phase === "grounded") sim.takeoff();
		else if (s.phase === "flying") {
			if (flown < HOME_AFTER_S) {
				// out: at the nearest spire, until it is a threat close enough to turn away from
				const threat = sense.threat;
				if (t > turnUntil && threat && threat.distance_m < TURN_AT_M) {
					heading.set(wrap360(s.heading + TURN_BY_DEG));
					turnUntil = t + TURN_FOR_S;
				} else if (t > turnUntil && sense.near[0]) {
					heading.set(wrap360(s.heading + sense.near[0].bearing_deg));
				}
			} else {
				// home: toward the pad, down to a low approach, then a hover landing short of it
				heading.set(wrap360(s.heading + sense.homeBearing));
				if (sense.homeDistance < DESCEND_WITHIN_M) altitude.set(sim.world.pad.height + 100);
				if (sense.homeDistance < LAND_WITHIN_M) sim.land();
			}
		}
		channels.readKnobs();
		app.safepoint();
		sim.tick(dt);
		channels.publish();
		// a null harness in this process acts between macrotasks; give it the chance once a second
		if (tick % TICK_HZ === 0) await new Promise<void>((done) => setImmediate(done));
	}
	const s = sim.state;
	const where = s.phase === "crashed" ? `crashed (${s.crashCause}${s.crashName ? ` ${s.crashName}` : ""})` : s.phase;
	const events = [...counts.entries()].map(([name, n]) => `${name} x${n}`).join(", ") || "none";
	return `ornithopter demo: leg ${leg}, ${where} after ${t.toFixed(0)} s at (${s.x.toFixed(0)}, ${s.z.toFixed(0)}); events: ${events}`;
}
