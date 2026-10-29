import { describe, expect, it } from "vitest";
import { sense, senseShip, type TrafficShip } from "../src/sensors.ts";
import { createSim, type Sim, type SimEvent } from "../src/sim.ts";
import { SENSORS, TICK_HZ, TRAFFIC } from "../src/tuning.ts";
import { createWorld } from "../src/world.ts";

const flat = createWorld({ seed: 1, spireCount: 0, duneMax: 0 });

const ship = (callsign: string, x: number, z: number, altitude: number, heading: number, speed = 50): TrafficShip => ({
	callsign,
	x,
	z,
	altitude,
	heading,
	speed,
	airborne: true,
});

function run(sim: Sim, seconds: number, each?: (t: number) => void): void {
	const dt = 1 / TICK_HZ;
	for (let i = 0; i < Math.round(seconds * TICK_HZ); i++) {
		each?.(i * dt);
		sim.tick(dt);
	}
}

function recorded(sim: Sim): SimEvent[] {
	const events: SimEvent[] = [];
	sim.onEvent((e) => events.push(e));
	return events;
}

describe("sensing another ship", () => {
	const me = { x: 0, z: 0, altitude: 180, heading: 0, speed: 50 };

	it("measures distance, bearing, altitude difference and closing", () => {
		const headOn = senseShip(me, ship("a", 0, 1000, 200, 180));
		expect(headOn.distance_m).toBe(1000);
		expect(headOn.bearing_deg).toBe(0);
		expect(headOn.altitude_diff_m).toBe(20);
		expect(headOn.closing_mps).toBe(100);
		expect(headOn.seconds).toBe(10);
		const sameWay = senseShip(me, ship("b", 0, 1000, 180, 0));
		expect(sameWay.closing_mps).toBe(0);
		expect(sameWay.seconds).toBe(-1);
		const fleeing = senseShip(me, ship("c", 0, 1000, 180, 0, 80));
		expect(fleeing.closing_mps).toBe(-30);
		expect(fleeing.seconds).toBe(-1);
		const abeam = senseShip(me, ship("d", 500, 0, 180, 0));
		expect(abeam.bearing_deg).toBe(90);
		expect(abeam.closing_mps).toBe(0);
	});

	it("lists airborne ships nearest first and names the soonest to meet", () => {
		const s = sense(flat, me, [
			ship("far", 0, 2000, 180, 180),
			ship("near-but-opening", 0, -300, 180, 180),
			ship("parked", 100, 100, 35, 0, 0),
			{ ...ship("parked", 100, 100, 35, 0, 0), airborne: false },
			ship("high", 0, 800, 400, 180),
			ship("soon", 0, 1200, 190, 180),
		]);
		expect(s.traffic.map((t) => t.callsign)).toEqual(["parked", "near-but-opening", "high", "soon", "far"]);
		// far would meet in 20 s, soon in 12; high is closing but 220 m above
		expect(s.trafficThreat?.callsign).toBe("soon");
		const none = sense(flat, me, [ship("off", 0, -300, 180, 180)]);
		expect(none.trafficThreat).toBeUndefined();
	});

	it("leaves out ships beyond range", () => {
		// the list reaches warnSeconds of the worst closing speed: at 50 m/s that is 3500 m, past the fixed 2500
		const reach = TRAFFIC.warnSeconds * (me.speed + 90);
		expect(sense(flat, me, [ship("x", 0, reach - 10, 180, 180)]).traffic).toHaveLength(1);
		expect(sense(flat, me, [ship("x", 0, reach + 10, 180, 180)]).traffic).toHaveLength(0);
	});
});

describe("flying among others", () => {
	it("ignores itself in the traffic, and warns of another once per approach, then again as it closes", () => {
		const sim = createSim(flat, { callsign: "me" });
		const events = recorded(sim);
		sim.takeoff();
		run(sim, 15);
		expect(sim.callsign).toBe("me");
		// a ship at my altitude coming the other way from 3 km: the warning is due at 25 s to meet
		const other = (z: number) => ship("other", 0, z, sim.state.altitude, 180);
		let z = sim.state.z + 3000;
		run(sim, 20, () => {
			z -= 50 / TICK_HZ;
			sim.setTraffic([other(z), { ...other(z), callsign: "me" }]);
		});
		// the other becomes the threat at 25 s to meet, then repeats once ten seconds on, closer: exactly two in 20 s
		const warnings = events.filter((e) => e.name === "traffic.warning");
		expect(warnings).toHaveLength(2);
		expect(warnings[0]?.payload).toMatchObject({ callsign: "other", bearing_deg: 0 });
		expect(Number(warnings[0]?.payload.seconds)).toBeLessThanOrEqual(TRAFFIC.warnSeconds);
		expect(sim.senses.traffic.every((t) => t.callsign !== "me")).toBe(true);
		// still closing ten seconds later: a repeat
		const before = warnings.length;
		run(sim, SENSORS.warnRepeatS + 1, () => {
			z -= 50 / TICK_HZ;
			sim.setTraffic([other(z)]);
		});
		expect(events.filter((e) => e.name === "traffic.warning")).toHaveLength(before + 1);
	});

	it("is ended by the arena's collision, in the air only", () => {
		const sim = createSim(flat, { callsign: "me" });
		const events = recorded(sim);
		expect(sim.collide("other")).toEqual({ ok: false, reason: "not airborne (grounded)" });
		sim.takeoff();
		run(sim, 5);
		expect(sim.collide("other")).toEqual({ ok: true, reason: "" });
		expect(sim.state.phase).toBe("crashed");
		expect(sim.state.crashCause).toBe("collision");
		expect(sim.state.crashName).toBe("other");
		expect(events.at(-1)?.name).toBe("flight.crash");
		expect(events.at(-1)?.payload).toMatchObject({ cause: "collision", name: "other" });
		expect(sim.collide("another")).toEqual({ ok: false, reason: "not airborne (crashed)" });
	});

	it("starts on its spawn slot, at the ground there", () => {
		const world = createWorld();
		const sim = createSim(world, { spawn: { x: 50, z: -40 }, callsign: "slot" });
		expect(sim.state.x).toBe(50);
		expect(sim.state.z).toBe(-40);
		expect(sim.state.altitude).toBeCloseTo(world.pad.height, 3);
		sim.takeoff();
		run(sim, 2);
		sim.reset();
		expect(sim.state.x).toBe(50);
	});
});
