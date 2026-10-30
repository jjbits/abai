// ornithopter as an abaigram: what the agent may observe and steer, declared
// once. The manifest (abaigram.yaml) is generated from this: after a change,
//   node src/main.ts abai manifest > abaigram.yaml
// and check it with: abaikit check .
//
// The doc fields are the agent's manual for each channel: they are rendered
// into its prompt, so they say what a pilot needs to know.
import { fileURLToPath } from "node:url";
import { type CapabilityOptions, type CellOptions, createAbaigram } from "@abaigram/abai-stub";
import { PHASES } from "./sim.ts";
import { AUTOPILOT, FLIGHT, KNOBS, POWER, SENSORS, TRAFFIC, WORLD } from "./tuning.ts";

/** In the arena the sky is shared, a crash is final, and the identity says so. */
const arena = process.env.ORNITHOPTER_ARENA === "1";

/** What a graceful stop runs; main.ts sets it once the game is up. */
export const stop: { handler: () => void | Promise<void> } = { handler: () => {} };

function stopHandler(): void | Promise<void> {
	return stop.handler();
}

const read = (type: CellOptions["type"], doc: string, extra: Partial<CellOptions> = {}): CellOptions => ({
	type,
	access: "read",
	doc,
	...extra,
});

const knob = (dflt: number, range: readonly [number, number], doc: string): CellOptions => ({
	type: "float",
	access: "readwrite",
	default: dflt,
	range: [range[0], range[1]],
	doc,
});

const act = (doc: string): CapabilityOptions => ({
	params: {},
	result: { ok: "bool", reason: "string" },
	effect: "mutate",
	example: {},
	doc,
});

export const app = createAbaigram(
	{
		name: "ornithopter",
		// a runnable entry: the tools reach the program through it, in this directory
		entry: "node src/main.ts abai",
		modes: ["sidecar", "turns"],
		content: { identity: arena ? "abai/identity-arena.md" : "abai/identity.md", use: "abai/use.md" },
		audit: { path: "./abai-audit.log" },
		// a headless scripted flight, fast-forward: what abaikit check runs
		check: { run: "node src/main.ts --demo" },
		cells: {
			"ship.east_m": read("float", "Position east of the pad, metres."),
			"ship.north_m": read("float", "Position north of the pad, metres."),
			"ship.altitude_m": read(
				"float",
				`Altitude above sea level, metres. Dunes rise to ${WORLD.duneMax} m, spire tops to about 450 m.`,
			),
			"ship.heading_deg": read("float", "Compass heading: 0 north, 90 east, 180 south, 270 west."),
			"ship.speed_mps": read(
				"float",
				`Airspeed, metres per second. Below ${FLIGHT.stallSpeed} the wings stall and the ship sinks.`,
			),
			"ship.vspeed_mps": read("float", "Vertical speed, metres per second; negative is down."),
			"ship.clearance_m": read("float", "Height above the ground directly below, metres."),
			"ship.pitch_deg": read("float", "Nose up positive. Display only."),
			"ship.roll_deg": read("float", "Right wing down positive. Display only."),
			"ground.slope_deg": read(
				"float",
				`Slope of the ground below. A landing on more than ${FLIGHT.safeTouchdownSlopeDeg} degrees breaks the ship; the pad is flat.`,
			),
			"power.pct": read(
				"float",
				"Wing power left, 0 to 100. Level flight costs a little; climbing and height cost more. At 0 the wings stop and the ship falls.",
			),
			"flight.phase": read("enum", "grounded, flying, landing, landed or crashed.", { enum: [...PHASES] }),
			"flight.time_s": read("float", "Seconds airborne this flight."),
			"flight.crash_cause": read(
				"string",
				"After a crash: terrain, obstacle, storm, hard_landing or collision. Empty otherwise.",
				{ max: 32 },
			),
			"threat.name": read(
				"string",
				`The nearest spire within ${SENSORS.threatRange} m (or ${SENSORS.threatSeconds} s of flight at your speed, if farther) and ${SENSORS.threatConeDeg} degrees of the heading that stands at your height. Empty when none.`,
				{ max: 32 },
			),
			"threat.distance_m": read("float", "Metres to the threat's surface; -1 when there is none."),
			"threat.bearing_deg": read(
				"float",
				"Where the threat is relative to the heading: 0 dead ahead, positive to the right, negative to the left. 0 while there is no threat.",
			),
			"threat.clearance_m": read(
				"float",
				"Your altitude minus the threat's top: negative means it stands above you. Turn away from it or climb past it. 0 while there is no threat (threat.distance_m is -1).",
			),
			"threat.radius_m": read("float", "The threat's radius, metres; 0 while there is no threat."),
			"terrain.ahead_clearance_m": read(
				"float",
				`Your altitude minus the highest ground within ${SENSORS.terrainLookahead} m along the heading (farther when fast). Below ${SENSORS.terrainWarnClearance} the ground ahead is a danger: climb.`,
			),
			"home.distance_m": read("float", "Metres to the landing pad's centre; the pad's edge is 120 m from it."),
			"home.bearing_deg": read(
				"float",
				"Where the pad is relative to the heading, -180 to 180, positive to the right.",
			),
			"boundary.distance_m": read(
				"float",
				`Metres to the storm wall, ${WORLD.boundaryRadius} m from the pad. Past it the ship is lost.`,
			),
			"obstacles.near": read(
				"list",
				`The nearest spires within ${SENSORS.nearRange} m, nearest first: name, distance to the surface, relative bearing, top altitude, radius, and your clearance above the top.`,
				{
					max: 2048,
					items: {
						type: "object",
						fields: {
							name: "string",
							distance_m: "float",
							bearing_deg: "float",
							top_m: "float",
							radius_m: "float",
							clearance_m: "float",
						},
					},
				},
			),
			"ship.callsign": read("string", "This ship's name among the others; solo when it flies alone.", { max: 32 }),
			"traffic.callsign": read(
				"string",
				`The other ship soonest to meet you, within ${TRAFFIC.warnSeconds} s at the present closing speed and ${TRAFFIC.altitudeBand} m of altitude. Empty when none.`,
				{ max: 32 },
			),
			"traffic.distance_m": read("float", "Metres to that ship, horizontally; -1 when there is none."),
			"traffic.bearing_deg": read(
				"float",
				"Where that ship is relative to the heading, positive to the right. 0 while there is none.",
			),
			"traffic.altitude_diff_m": read(
				"float",
				"That ship's altitude minus yours: positive means it is above you. 0 while there is none.",
			),
			"traffic.closing_mps": read("float", "How fast the distance to that ship shrinks. 0 while there is none."),
			"traffic.seconds": read(
				"float",
				"Seconds until you would meet at the present closing speed; -1 when there is none.",
			),
			"traffic.near": read(
				"list",
				`The airborne ships within ${TRAFFIC.nearRange} m, or ${TRAFFIC.warnSeconds} s of the worst closing speed if farther, nearest first: callsign, distance, relative bearing, altitude difference, closing speed, and seconds to meet (-1 when not closing).`,
				{
					max: 2048,
					items: {
						type: "object",
						fields: {
							callsign: "string",
							distance_m: "float",
							bearing_deg: "float",
							altitude_diff_m: "float",
							closing_mps: "float",
							seconds: "float",
						},
					},
				},
			),
			"target.heading_deg": knob(
				KNOBS.heading.default,
				KNOBS.heading.range,
				`The heading the autopilot holds. It turns the short way at up to ${AUTOPILOT.turnRateMax} degrees per second, slower when fast.`,
			),
			"target.altitude_m": knob(
				KNOBS.altitude.default,
				KNOBS.altitude.range,
				`The altitude above sea level the autopilot holds: it climbs at up to ${AUTOPILOT.climbMax} m/s and descends at up to ${AUTOPILOT.descentMax}. Height costs power, and the ceiling of ${KNOBS.altitude.range[1]} m is below the tallest spires: those you must turn away from.`,
			),
			"target.speed_mps": knob(
				KNOBS.speed.default,
				KNOBS.speed.range,
				`The airspeed the autopilot holds. Faster means wider turns and less time to react; below ${FLIGHT.stallSpeed} the wings stall and the ship sinks.`,
			),
		},
		events: {
			"flight.takeoff": { payload: { altitude_m: "float" }, wakes: "never", doc: "The ship lifted off." },
			"flight.touchdown": {
				payload: { vspeed_mps: "float", slope_deg: "float", hard: "bool" },
				wakes: "always",
				doc: "The ship touched the ground while landing. hard means it broke.",
			},
			"flight.crash": {
				payload: { cause: { type: "string", max: 32 }, name: { type: "string", max: 32 }, time_s: "float" },
				wakes: "always",
				doc: `The flight ended: terrain, obstacle (name says which spire), storm, hard_landing, or collision (name says which ship).${arena ? " A crash is final." : " flight.reset puts the ship back on the pad."}`,
			},
			"threat.warning": {
				payload: {
					name: { type: "string", max: 32 },
					distance_m: "float",
					bearing_deg: "float",
					clearance_m: "float",
				},
				wakes: "always",
				doc: `A spire ahead stands at your height within ${SENSORS.threatRange} m or ${SENSORS.threatSeconds} s of flight. Turn away from its bearing, or climb above its top if the ceiling allows, soon.`,
			},
			"terrain.warning": {
				payload: { clearance_m: "float" },
				wakes: "always",
				doc: `The ground ahead, rising or being descended into, leaves less than ${SENSORS.terrainWarnClearance} m under you. Climb.`,
			},
			"stall.warning": {
				payload: { speed_mps: "float" },
				wakes: "always",
				doc: `Airspeed fell below ${FLIGHT.stallSpeed} m/s; the ship sinks until it is faster.`,
			},
			"power.low": {
				payload: { pct: "float" },
				wakes: "always",
				doc: `Power is down to ${POWER.lowPct} percent. Head home and land.`,
			},
			"boundary.warning": {
				payload: { distance_m: "float" },
				wakes: "always",
				doc: `The storm wall is within ${SENSORS.boundaryWarn} m or ${SENSORS.boundarySeconds} s of flight. Turn back.`,
			},
			"traffic.warning": {
				payload: {
					callsign: { type: "string", max: 32 },
					distance_m: "float",
					bearing_deg: "float",
					altitude_diff_m: "float",
					seconds: "float",
				},
				wakes: "always",
				doc: `Another ship is within ${TRAFFIC.warnSeconds} s of meeting you at the present closing speed and near your altitude. Change altitude or turn away from its bearing.`,
			},
		},
		capabilities: {
			"flight.takeoff": act(
				`Lift off from the pad, or from wherever the ship landed. It climbs for ${FLIGHT.liftoffSeconds} seconds, then holds the targets.`,
			),
			"flight.land": act(
				`Descend where you are at ${FLIGHT.landingDescent} m/s, slowing to a hover. A touchdown faster than ${FLIGHT.safeTouchdownVspeed} m/s or on ground steeper than ${FLIGHT.safeTouchdownSlopeDeg} degrees breaks the ship; the pad is flat.`,
			),
			"flight.go_around": act(
				`Abandon the landing and climb back to the altitude target. Do it early: from a slow hover the ship sinks for a few seconds while it regains ${FLIGHT.stallSpeed} m/s, so a go-around low over the ground is a crash.`,
			),
			// in the arena a crash is final: no reset is declared, so the agent never sees one
			...(arena
				? {}
				: { "flight.reset": act("Put the ship back on the pad with full power, after a crash or at any time.") }),
			"world.describe": {
				params: {},
				result: {
					seed: "int",
					size_m: "int",
					boundary_radius_m: "int",
					pad: { type: "object", max: 128 },
					spires: { type: "list", max: 4096 },
				},
				effect: "read",
				example: {},
				doc: "The map, in the cells' own coordinates: the pad (east, north, radius, height), every spire (east, north, radius, top) and the wall's radius. Read it before you plan a route.",
			},
		},
		lifecycle: { pause: "none", stop: { graceful: "5s", handler: stopHandler } },
	},
	// the directory holding abaigram.yaml and abai/: one level up from this file
	{
		root: fileURLToPath(new URL("..", import.meta.url)),
		// the arena gives each ship its own audit log
		...(process.env.ORNITHOPTER_AUDIT ? { auditPath: process.env.ORNITHOPTER_AUDIT } : {}),
	},
);
