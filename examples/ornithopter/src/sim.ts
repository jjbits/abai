// The flight model: an ornithopter flown by a plain control loop toward
// three targets the agent sets, over a world that can kill it. The control
// loop holds heading, altitude and speed; it knows nothing of obstacles.
// Avoiding them is the agent's job. Nothing here knows about abai either;
// channels.ts wires this to the cells, knobs, capabilities and events.
import { clamp, DEG, RAD, round1, wrap180, wrap360 } from "./math.ts";
import { absoluteBearing, type Senses, sense, type TrafficShip } from "./sensors.ts";
import { AUTOPILOT, FLIGHT, KNOBS, MAX_STEP_S, POWER, SENSORS, TRAFFIC } from "./tuning.ts";
import type { World } from "./world.ts";

export type Phase = "grounded" | "flying" | "landing" | "landed" | "crashed";
export const PHASES: readonly Phase[] = ["grounded", "flying", "landing", "landed", "crashed"];
export type CrashCause = "terrain" | "obstacle" | "storm" | "hard_landing" | "collision";

/** What the agent's knobs set. */
export interface Targets {
	heading: number;
	altitude: number;
	speed: number;
}

export interface ShipState {
	x: number;
	z: number;
	/** Above sea level. */
	altitude: number;
	heading: number;
	speed: number;
	vspeed: number;
	/** Display only. */
	pitch: number;
	roll: number;
	/** 0 to 100. */
	power: number;
	phase: Phase;
	/** Seconds airborne this flight. */
	time: number;
	crashCause: CrashCause | "";
	/** The spire, for an obstacle crash. */
	crashName: string;
	/** Seconds since liftoff while the initial climb lasts; -1 otherwise. */
	liftoff: number;
}

export interface SimEvent {
	name: string;
	payload: Record<string, unknown>;
}

export interface ActResult {
	ok: boolean;
	reason: string;
}

/** Where a ship starts, and what it is called. */
export interface SimOptions {
	spawn?: { x: number; z: number };
	callsign?: string;
}

export interface Sim {
	readonly world: World;
	/** The ship's name among others; "solo" when it flies alone. */
	readonly callsign: string;
	/** Live; read it, and write it only in tests. */
	readonly state: ShipState;
	/** Live; the knobs write it. */
	readonly targets: Targets;
	/** As of the last tick. */
	readonly senses: Senses;
	tick(dt: number): void;
	takeoff(): ActResult;
	land(): ActResult;
	goAround(): ActResult;
	reset(): ActResult;
	/** Returns the unsubscribe. */
	onEvent(listener: (event: SimEvent) => void): () => void;
	/** The other ships, as the arena reports them; sensed at the next tick. */
	setTraffic(ships: readonly TrafficShip[]): void;
	/** The arena's judgement: this ship met another. Ends an airborne ship with cause `collision`. */
	collide(withCallsign: string): ActResult;
}

function freshState(world: World, spawn: { x: number; z: number }): ShipState {
	// a ship on the pad's ring faces outward, so a straight climb-out leads away from its neighbours
	const outward =
		spawn.x === world.pad.x && spawn.z === world.pad.z
			? 0
			: wrap360(Math.atan2(spawn.x - world.pad.x, spawn.z - world.pad.z) * DEG);
	return {
		x: spawn.x,
		z: spawn.z,
		altitude: world.groundHeight(spawn.x, spawn.z),
		heading: outward,
		speed: 0,
		vspeed: 0,
		pitch: 0,
		roll: 0,
		power: POWER.full,
		phase: "grounded",
		time: 0,
		crashCause: "",
		crashName: "",
		liftoff: -1,
	};
}

/** The turn rate the wings allow at a speed: full at the reference speed and below, less when fast. */
export function turnRateAt(speed: number): number {
	return clamp(
		(AUTOPILOT.turnRateMax * AUTOPILOT.turnRefSpeed) / Math.max(speed, 1),
		AUTOPILOT.turnRateMin,
		AUTOPILOT.turnRateMax,
	);
}

export function createSim(world: World, options: SimOptions = {}): Sim {
	const spawn = options.spawn ?? { x: world.pad.x, z: world.pad.z };
	const callsign = options.callsign ?? "solo";
	let traffic: readonly TrafficShip[] = [];
	const listeners = new Set<(event: SimEvent) => void>();
	const emit = (name: string, payload: Record<string, unknown> = {}): void => {
		for (const listener of listeners) listener({ name, payload });
	};
	const state = freshState(world, spawn);
	const targets: Targets = {
		heading: freshState(world, spawn).heading,
		altitude: KNOBS.altitude.default,
		speed: KNOBS.speed.default,
	};
	let senses = sense(world, state, traffic);
	// each warning fires once, until its condition has clearly cleared
	const warned = { stall: false, power: false, boundary: false, terrain: false };
	/** When the standing warnings last fired, in flight time, and how close the threat was then. */
	const lastWarn = { boundary: -1, terrain: -1 };
	const warnedSpires = new Map<string, { at: number; distance: number }>();
	const warnedShips = new Map<string, { at: number; distance: number }>();

	const ok = (): ActResult => ({ ok: true, reason: "" });
	const no = (reason: string): ActResult => ({ ok: false, reason });

	function crash(cause: CrashCause, name: string): void {
		// a wreck lies on the ground where the ship was lost
		state.altitude = world.groundHeight(state.x, state.z);
		state.speed = 0;
		state.vspeed = 0;
		state.pitch = 0;
		state.roll = 0;
		state.phase = "crashed";
		state.crashCause = cause;
		state.crashName = name;
		state.liftoff = -1;
		emit("flight.crash", { cause, name, time_s: round1(state.time) });
	}

	function airborneTick(dt: number): void {
		const s = state;
		const landing = s.phase === "landing";
		const powered = s.power > 0;

		// heading: the short way round, at the rate the speed allows
		const turnRate = turnRateAt(s.speed);
		const turn = clamp(wrap180(targets.heading - s.heading), -turnRate * dt, turnRate * dt);
		s.heading = wrap360(s.heading + turn);
		s.roll = clamp((turn / dt) * FLIGHT.rollPerDegPerS, -FLIGHT.rollMax, FLIGHT.rollMax);

		// speed
		if (!powered) s.speed = Math.max(0, s.speed - FLIGHT.powerOutDecel * dt);
		else {
			const want = landing ? FLIGHT.landingSpeed : targets.speed;
			s.speed += clamp(want - s.speed, -AUTOPILOT.accel * dt, AUTOPILOT.accel * dt);
		}

		// vertical
		let v: number;
		if (!powered) v = -FLIGHT.powerOutSink;
		else if (!landing && s.speed < FLIGHT.stallSpeed) {
			v = -FLIGHT.stallSink;
			if (!warned.stall) {
				warned.stall = true;
				emit("stall.warning", { speed_mps: round1(s.speed) });
			}
		} else if (s.liftoff >= 0) {
			v = AUTOPILOT.climbMax;
			s.liftoff += dt;
			if (s.liftoff >= FLIGHT.liftoffSeconds) s.liftoff = -1;
		} else if (landing) v = -FLIGHT.landingDescent;
		else
			v = clamp((targets.altitude - s.altitude) * AUTOPILOT.altitudeGain, -AUTOPILOT.descentMax, AUTOPILOT.climbMax);
		if (s.speed >= FLIGHT.stallSpeed + 5) warned.stall = false;
		s.vspeed = v;
		s.altitude += v * dt;
		s.pitch = clamp(Math.atan2(v, Math.max(s.speed, 1)) * DEG, -FLIGHT.pitchMax, FLIGHT.pitchMax);

		// position and time
		const rad = s.heading * RAD;
		s.x += Math.sin(rad) * s.speed * dt;
		s.z += Math.cos(rad) * s.speed * dt;
		s.time += dt;

		// power: level flight costs a little, climbing and thin air cost more
		if (powered) {
			const drain =
				POWER.basePerS + Math.max(0, v) * POWER.climbPerMps + Math.max(0, s.altitude) * POWER.altitudePerM;
			s.power = Math.max(0, s.power - drain * dt);
			if (s.power <= POWER.lowPct && !warned.power) {
				warned.power = true;
				emit("power.low", { pct: round1(s.power) });
			}
		}

		// what kills: the wall, a spire, the ground
		if (Math.hypot(s.x, s.z) > world.boundaryRadius) {
			crash("storm", "");
			return;
		}
		for (const spire of world.spires) {
			if (s.altitude < spire.top && Math.hypot(s.x - spire.x, s.z - spire.z) < spire.radius) {
				crash("obstacle", spire.name);
				return;
			}
		}
		const ground = world.groundHeight(s.x, s.z);
		if (s.altitude <= ground) {
			if (!landing) {
				crash("terrain", "");
				return;
			}
			const slope = world.slopeDeg(s.x, s.z);
			const hard = -s.vspeed > FLIGHT.safeTouchdownVspeed || slope > FLIGHT.safeTouchdownSlopeDeg;
			emit("flight.touchdown", { vspeed_mps: round1(s.vspeed), slope_deg: round1(slope), hard });
			if (hard) {
				crash("hard_landing", "");
				return;
			}
			s.altitude = ground;
			s.speed = 0;
			s.vspeed = 0;
			s.pitch = 0;
			s.roll = 0;
			s.phase = "landed";
		}
	}

	function warnings(): void {
		const now = state.time;
		// a threat is announced once per approach, then again every warnRepeatS while it is still the threat and
		// closer than it was: an agent that attaches per call may have missed the first one. A warned spire is
		// forgotten once the ship has clearly turned away from it or left it behind, so pointing at it again is
		// a new approach
		const byName = new Map(senses.near.map((o) => [o.name, o]));
		for (const [name] of warnedSpires) {
			const o = byName.get(name);
			if (!o || o.distance_m > SENSORS.threatForgetRange || Math.abs(o.bearing_deg) > SENSORS.threatForgetConeDeg) {
				warnedSpires.delete(name);
			}
		}
		const threat = senses.threat;
		if (threat) {
			const last = warnedSpires.get(threat.name);
			const due = last === undefined || (now - last.at >= SENSORS.warnRepeatS && threat.distance_m < last.distance);
			if (due) {
				warnedSpires.set(threat.name, { at: now, distance: threat.distance_m });
				emit("threat.warning", {
					name: threat.name,
					distance_m: threat.distance_m,
					bearing_deg: threat.bearing_deg,
					clearance_m: threat.clearance_m,
				});
			}
		}
		// another ship closing: once per approach, again every warnRepeatS while it keeps closing; forgotten once it
		// is gone from the list, no longer closing, or far from meeting
		const seen = new Map(senses.traffic.map((t) => [t.callsign, t]));
		for (const [name] of warnedShips) {
			const t = seen.get(name);
			if (!t || t.seconds < 0 || t.seconds > 2 * TRAFFIC.warnSeconds) warnedShips.delete(name);
		}
		const ship = senses.trafficThreat;
		if (ship) {
			const last = warnedShips.get(ship.callsign);
			const due = last === undefined || (now - last.at >= SENSORS.warnRepeatS && ship.distance_m < last.distance);
			if (due) {
				warnedShips.set(ship.callsign, { at: now, distance: ship.distance_m });
				emit("traffic.warning", {
					callsign: ship.callsign,
					distance_m: ship.distance_m,
					bearing_deg: ship.bearing_deg,
					altitude_diff_m: ship.altitude_diff_m,
					seconds: ship.seconds,
				});
			}
		}
		// ground that will be met: rising ahead, or flat ground the ship is descending into; not merely flying low
		const rising = senses.terrainAheadHeight > senses.ground + SENSORS.terrainRiseMin;
		const descending = state.vspeed < -0.5;
		// no warning while the ship already climbs as hard as it can: there is nothing more to ask of the pilot
		const climbingHard = state.vspeed >= AUTOPILOT.climbMax - 0.5;
		if ((rising || descending) && !climbingHard && senses.terrainAheadClearance < SENSORS.terrainWarnClearance) {
			if (!warned.terrain || now - lastWarn.terrain >= SENSORS.warnRepeatS) {
				warned.terrain = true;
				lastWarn.terrain = now;
				emit("terrain.warning", { clearance_m: round1(senses.terrainAheadClearance) });
			}
		} else if (senses.terrainAheadClearance > SENSORS.terrainRearmClearance) warned.terrain = false;
		const wallWarnAt = Math.max(SENSORS.boundaryWarn, state.speed * SENSORS.boundarySeconds);
		if (senses.boundaryDistance < wallWarnAt) {
			// still moving outward: the heading is within 90 degrees of the radial from the pad
			const closing = Math.cos((state.heading - absoluteBearing(state.x, state.z)) * RAD) > 0;
			if (!warned.boundary || (now - lastWarn.boundary >= SENSORS.warnRepeatS && closing)) {
				warned.boundary = true;
				lastWarn.boundary = now;
				emit("boundary.warning", { distance_m: round1(senses.boundaryDistance) });
			}
		} else if (senses.boundaryDistance > wallWarnAt + 300) warned.boundary = false;
	}

	const airborne = (): boolean => state.phase === "flying" || state.phase === "landing";

	return {
		world,
		callsign,
		state,
		targets,
		get senses() {
			return senses;
		},
		tick(dt: number): void {
			if (!(dt > 0)) return;
			// a long tick in substeps: the crash checks sample positions, and a step must stay shorter than a spire
			const steps = Math.max(1, Math.ceil(dt / MAX_STEP_S));
			const sub = dt / steps;
			for (let i = 0; i < steps && airborne(); i++) airborneTick(sub);
			senses = sense(world, state, traffic);
			if (airborne()) warnings();
		},
		takeoff(): ActResult {
			if (state.phase !== "grounded" && state.phase !== "landed") return no(`cannot take off while ${state.phase}`);
			if (state.power <= 0) return no("no power left");
			state.phase = "flying";
			state.speed = FLIGHT.takeoffSpeed;
			state.liftoff = 0;
			state.time = 0;
			// a new flight, a new clock: the old warnings would otherwise sit on the old one
			warnedSpires.clear();
			warnedShips.clear();
			emit("flight.takeoff", { altitude_m: round1(state.altitude) });
			return ok();
		},
		land(): ActResult {
			if (state.phase !== "flying") return no(`cannot land while ${state.phase}`);
			state.phase = "landing";
			state.liftoff = -1;
			return ok();
		},
		goAround(): ActResult {
			if (state.phase !== "landing") return no(`not landing (${state.phase})`);
			state.phase = "flying";
			return ok();
		},
		reset(): ActResult {
			Object.assign(state, freshState(world, spawn));
			warned.stall = false;
			warned.power = false;
			warned.boundary = false;
			warned.terrain = false;
			lastWarn.boundary = -1;
			lastWarn.terrain = -1;
			warnedSpires.clear();
			warnedShips.clear();
			senses = sense(world, state, traffic);
			return ok();
		},
		setTraffic(ships): void {
			traffic = ships.filter((other) => other.callsign !== callsign);
		},
		collide(withCallsign): ActResult {
			if (!airborne()) return no(`not airborne (${state.phase})`);
			crash("collision", withCallsign);
			return ok();
		},
		onEvent(listener): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
