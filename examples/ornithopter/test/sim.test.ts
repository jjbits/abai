import { describe, expect, it } from "vitest";
import { wrap180 } from "../src/math.ts";
import { createSim, type Sim, type SimEvent, turnRateAt } from "../src/sim.ts";
import { AUTOPILOT, FLIGHT, POWER, SENSORS, TICK_HZ } from "../src/tuning.ts";
import { createWorld, type Spire, type World } from "../src/world.ts";

const flat = createWorld({ seed: 1, spireCount: 0, duneMax: 0 });

/** The flat world with these spires, or another ground. */
function withWorld(spires: Spire[], ground?: (x: number, z: number) => number): World {
	return {
		...flat,
		spires,
		groundHeight: ground ?? flat.groundHeight,
		slopeDeg: ground ? () => 0 : flat.slopeDeg,
	};
}

function run(sim: Sim, seconds: number): void {
	const dt = 1 / TICK_HZ;
	const ticks = Math.round(seconds * TICK_HZ);
	for (let i = 0; i < ticks; i++) sim.tick(dt);
}

function recorded(sim: Sim): SimEvent[] {
	const events: SimEvent[] = [];
	sim.onEvent((e) => events.push(e));
	return events;
}

const names = (events: SimEvent[], name: string) => events.filter((e) => e.name === name);

describe("flight", () => {
	it("takes off and settles on the targets", () => {
		const sim = createSim(flat);
		const events = recorded(sim);
		expect(sim.state.phase).toBe("grounded");
		expect(sim.takeoff()).toEqual({ ok: true, reason: "" });
		expect(sim.state.phase).toBe("flying");
		expect(names(events, "flight.takeoff")).toHaveLength(1);
		run(sim, 40);
		expect(sim.state.altitude).toBeCloseTo(sim.targets.altitude, 0);
		expect(sim.state.speed).toBeCloseTo(sim.targets.speed, 1);
		expect(sim.state.heading).toBeCloseTo(0, 5);
		expect(sim.state.z).toBeGreaterThan(1000);
		expect(Math.abs(sim.state.x)).toBeLessThan(1);
		expect(sim.state.time).toBeCloseTo(40, 3);
		expect(sim.state.phase).toBe("flying");
	});

	it("refuses to take off twice and to land on the ground", () => {
		const sim = createSim(flat);
		expect(sim.land().ok).toBe(false);
		sim.takeoff();
		expect(sim.takeoff()).toEqual({ ok: false, reason: "cannot take off while flying" });
		expect(sim.goAround().ok).toBe(false);
	});

	it("turns the short way at the rate the speed allows", () => {
		const sim = createSim(flat);
		sim.takeoff();
		run(sim, 10);
		sim.state.heading = 350;
		sim.targets.heading = 10;
		run(sim, 0.5);
		const turned = wrap180(sim.state.heading - 350);
		expect(turned).toBeGreaterThan(5);
		expect(turned).toBeLessThanOrEqual(AUTOPILOT.turnRateMax * 0.5 + 1e-6);
		run(sim, 5);
		expect(sim.state.heading).toBeCloseTo(10, 5);
		expect(turnRateAt(90)).toBeCloseTo((AUTOPILOT.turnRateMax * AUTOPILOT.turnRefSpeed) / 90, 5);
		expect(turnRateAt(10)).toBe(AUTOPILOT.turnRateMax);
	});

	it("stalls below the stall speed and warns once", () => {
		const sim = createSim(flat);
		const events = recorded(sim);
		sim.takeoff();
		run(sim, 10);
		sim.state.speed = 10;
		sim.tick(1 / TICK_HZ);
		expect(sim.state.vspeed).toBe(-FLIGHT.stallSink);
		run(sim, 1);
		expect(names(events, "stall.warning")).toHaveLength(1);
		run(sim, 10);
		expect(sim.state.speed).toBeGreaterThan(FLIGHT.stallSpeed);
		expect(sim.state.phase).toBe("flying");
	});

	it("drains power in flight, warns once when low, and falls when it is gone", () => {
		const sim = createSim(flat);
		const events = recorded(sim);
		sim.takeoff();
		run(sim, 40);
		expect(sim.state.power).toBeLessThan(POWER.full);
		expect(sim.state.power).toBeGreaterThan(POWER.full - 25);
		// back toward the pad, so the long runs below stay inside the wall
		sim.targets.heading = 180;
		sim.state.power = POWER.lowPct + 0.5;
		run(sim, 10);
		expect(names(events, "power.low")).toHaveLength(1);
		sim.state.power = 0;
		run(sim, 60);
		expect(names(events, "power.low")).toHaveLength(1);
		expect(sim.state.phase).toBe("crashed");
		expect(sim.state.crashCause).toBe("terrain");
		expect(names(events, "flight.crash")[0]?.payload).toMatchObject({ cause: "terrain", name: "" });
	});

	it("flies into a spire it was pointed at, and says which", () => {
		const sim = createSim(withWorld([{ name: "spike", x: 0, z: 600, radius: 50, base: 0, top: 400 }]));
		const events = recorded(sim);
		sim.takeoff();
		run(sim, 30);
		expect(sim.state.phase).toBe("crashed");
		expect(sim.state.crashCause).toBe("obstacle");
		expect(sim.state.crashName).toBe("spike");
		expect(names(events, "flight.crash")[0]?.payload).toMatchObject({ cause: "obstacle", name: "spike" });
		expect(names(events, "threat.warning").length).toBeGreaterThanOrEqual(1);
		expect(names(events, "threat.warning")[0]?.payload).toMatchObject({ name: "spike", bearing_deg: 0 });
	});

	it("flies over a spire it is above", () => {
		const sim = createSim(withWorld([{ name: "stump", x: 0, z: 2200, radius: 50, base: 0, top: 100 }]));
		const events = recorded(sim);
		sim.takeoff();
		run(sim, 50);
		expect(sim.state.z).toBeGreaterThan(2300);
		expect(sim.state.phase).toBe("flying");
		expect(names(events, "threat.warning")).toHaveLength(0);
	});

	it("warns of a threat once per approach, again every ten seconds while it closes", () => {
		const sim = createSim(withWorld([{ name: "tower", x: 0, z: 2200, radius: 50, base: 0, top: 400 }]));
		const events = recorded(sim);
		sim.takeoff();
		run(sim, 15);
		expect(names(events, "threat.warning")).toHaveLength(1);
		run(sim, 5);
		expect(names(events, "threat.warning")).toHaveLength(1);
		run(sim, SENSORS.warnRepeatS);
		expect(names(events, "threat.warning")).toHaveLength(2);
		expect(sim.state.phase).toBe("flying");
		// turn well away, then back at it: a new approach, a new warning
		sim.targets.heading = 90;
		run(sim, 10);
		expect(names(events, "threat.warning")).toHaveLength(2);
		// back at the tower, which now lies to the north-west
		sim.targets.heading = 310;
		run(sim, 10);
		expect(names(events, "threat.warning")).toHaveLength(3);
	});

	it("is lost in the storm past the wall", () => {
		const sim = createSim(flat);
		const events = recorded(sim);
		sim.takeoff();
		run(sim, 5);
		sim.state.x = flat.boundaryRadius - 400;
		sim.state.z = 0;
		sim.state.heading = 90;
		sim.targets.heading = 90;
		run(sim, 2);
		expect(names(events, "boundary.warning")).toHaveLength(1);
		run(sim, 20);
		expect(sim.state.phase).toBe("crashed");
		expect(sim.state.crashCause).toBe("storm");
		// at 50 m/s the wall came 8 s after the first warning: no repeat was due; a slower ship hears it again
		expect(names(events, "boundary.warning")).toHaveLength(1);
	});

	it("warns of rising terrain ahead and crashes into it when nothing is done", () => {
		const cliff = withWorld([], (_x, z) => (z > 2500 ? 300 : 0));
		const sim = createSim(cliff);
		const events = recorded(sim);
		sim.takeoff();
		run(sim, 30);
		expect(names(events, "terrain.warning")).toHaveLength(0);
		run(sim, 40);
		// the first warning, and a repeat ten seconds later while the cliff kept coming
		expect(names(events, "terrain.warning").length).toBeGreaterThanOrEqual(1);
		expect(names(events, "terrain.warning").length).toBeLessThanOrEqual(3);
		expect(sim.state.phase).toBe("crashed");
		expect(sim.state.crashCause).toBe("terrain");
	});

	it("lands softly on flat ground", () => {
		const sim = createSim(flat);
		const events = recorded(sim);
		sim.takeoff();
		run(sim, 5);
		expect(sim.land()).toEqual({ ok: true, reason: "" });
		expect(sim.state.phase).toBe("landing");
		run(sim, 40);
		expect(sim.state.phase).toBe("landed");
		expect(sim.state.altitude).toBe(0);
		expect(sim.state.speed).toBe(0);
		expect(names(events, "flight.touchdown")[0]?.payload).toMatchObject({
			hard: false,
			vspeed_mps: -FLIGHT.landingDescent,
		});
		expect(sim.takeoff().ok).toBe(true);
	});

	it("breaks on a hard touchdown", () => {
		const sim = createSim(flat);
		const events = recorded(sim);
		sim.takeoff();
		run(sim, 10);
		sim.land();
		sim.state.power = 0;
		run(sim, 30);
		expect(sim.state.phase).toBe("crashed");
		expect(sim.state.crashCause).toBe("hard_landing");
		expect(names(events, "flight.touchdown")[0]?.payload).toMatchObject({ hard: true });
	});

	it("breaks on steep ground", () => {
		const slope = withWorld([]);
		slope.slopeDeg = () => FLIGHT.safeTouchdownSlopeDeg + 5;
		const sim = createSim(slope);
		sim.takeoff();
		run(sim, 5);
		sim.land();
		run(sim, 40);
		expect(sim.state.crashCause).toBe("hard_landing");
	});

	it("goes around from a landing", () => {
		const sim = createSim(flat);
		sim.takeoff();
		run(sim, 20);
		sim.land();
		run(sim, 5);
		expect(sim.state.vspeed).toBe(-FLIGHT.landingDescent);
		expect(sim.goAround()).toEqual({ ok: true, reason: "" });
		run(sim, 30);
		expect(sim.state.phase).toBe("flying");
		expect(sim.state.altitude).toBeCloseTo(sim.targets.altitude, 0);
	});

	it("resets to the pad after a crash", () => {
		const sim = createSim(flat);
		sim.takeoff();
		sim.state.power = 0;
		run(sim, 60);
		expect(sim.state.phase).toBe("crashed");
		expect(sim.reset().ok).toBe(true);
		expect(sim.state).toMatchObject({ phase: "grounded", x: 0, z: 0, power: POWER.full, crashCause: "", time: 0 });
		expect(sim.takeoff().ok).toBe(true);
	});

	it("takes off from the real pad and climbs clear of the dunes", () => {
		const sim = createSim(createWorld());
		const events = recorded(sim);
		sim.takeoff();
		run(sim, 30);
		expect(sim.state.phase).toBe("flying");
		expect(sim.state.altitude).toBeCloseTo(sim.targets.altitude, 0);
		expect(names(events, "flight.crash")).toHaveLength(0);
	});

	it("flies the same path whatever the tick rate", () => {
		const fly = (hz: number) => {
			const sim = createSim(flat);
			sim.takeoff();
			const dt = 1 / hz;
			for (let t = 0; t < 60; t += dt) {
				if (t >= 20) sim.targets.heading = 120;
				sim.tick(dt);
			}
			return sim.state;
		};
		const slow = fly(10);
		const fast = fly(50);
		expect(Math.hypot(slow.x - fast.x, slow.z - fast.z)).toBeLessThan(20);
		expect(Math.abs(slow.altitude - fast.altitude)).toBeLessThan(2);
		expect(Math.abs(slow.power - fast.power)).toBeLessThan(0.5);
	});

	it("cannot step through a spire in one long tick", () => {
		const sim = createSim(withWorld([{ name: "needle", x: 0, z: 45, radius: 35, base: 0, top: 400 }]));
		sim.takeoff();
		sim.state.altitude = 100;
		sim.state.speed = 90;
		sim.state.liftoff = -1;
		sim.targets.speed = 90;
		sim.tick(1);
		expect(sim.state.crashCause).toBe("obstacle");
		expect(sim.state.crashName).toBe("needle");
	});

	it("stalls when asked to fly too slowly, and recovers when asked to speed up", () => {
		const sim = createSim(flat);
		const events = recorded(sim);
		sim.takeoff();
		run(sim, 20);
		sim.targets.speed = 15;
		run(sim, 8);
		expect(sim.state.vspeed).toBe(-FLIGHT.stallSink);
		expect(names(events, "stall.warning")).toHaveLength(1);
		sim.targets.speed = 50;
		run(sim, 10);
		expect(sim.state.vspeed).toBeGreaterThan(0);
		expect(sim.state.phase).toBe("flying");
	});

	it("repeats the wall warning while the ship keeps closing, and not once it turns away", () => {
		const sim = createSim(flat);
		const events = recorded(sim);
		sim.takeoff();
		run(sim, 5);
		// at 25 m/s the wall warns 625 m out
		sim.state.x = flat.boundaryRadius - 600;
		sim.state.heading = 90;
		sim.targets.heading = 90;
		sim.targets.speed = 25;
		sim.state.speed = 25;
		run(sim, 1);
		expect(names(events, "boundary.warning")).toHaveLength(1);
		run(sim, SENSORS.warnRepeatS + 1);
		expect(names(events, "boundary.warning")).toHaveLength(2);
		sim.targets.heading = 270;
		run(sim, 10);
		run(sim, SENSORS.warnRepeatS + 1);
		expect(names(events, "boundary.warning")).toHaveLength(2);
		expect(sim.state.phase).toBe("flying");
	});

	it("warns of the wall and of a threat in time at speed", () => {
		const sim = createSim(flat);
		const events = recorded(sim);
		sim.takeoff();
		run(sim, 5);
		sim.targets.speed = 90;
		sim.state.speed = 90;
		sim.state.x = flat.boundaryRadius - 2500;
		sim.state.heading = 90;
		sim.targets.heading = 90;
		run(sim, 15);
		expect(names(events, "boundary.warning").length).toBeGreaterThanOrEqual(1);
		const warnedAt = Number(names(events, "boundary.warning")[0]?.payload.distance_m);
		expect(warnedAt).toBeGreaterThan(90 * SENSORS.boundarySeconds - 100);
	});

	it("keeps the senses current", () => {
		const sim = createSim(withWorld([{ name: "mark", x: 0, z: 1000, radius: 50, base: 0, top: 400 }]));
		expect(sim.senses.near[0]?.distance_m).toBe(950);
		// on the pad the spire ahead already stands above the ship: an honest sense
		expect(sim.senses.threat?.name).toBe("mark");
		sim.takeoff();
		run(sim, 1);
		expect(sim.senses.threat?.name).toBe("mark");
		expect(sim.senses.threat?.distance_m).toBeLessThan(950);
		expect(sim.senses.clearance).toBeGreaterThan(0);
		expect(sim.senses.boundaryDistance).toBeLessThan(flat.boundaryRadius);
		expect(SENSORS.threatRange).toBeGreaterThan(sim.senses.threat?.distance_m ?? 0);
	});
});
