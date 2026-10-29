// Every number the flight model and the senses depend on, in one place, so
// the game can be tuned from a hand check without touching the code.

/** Simulation ticks per second. */
export const TICK_HZ = 20;
/** A tick longer than this is split into substeps, so a stalled host cannot step the ship through a spire. */
export const MAX_STEP_S = 0.1;

export const WORLD = {
	/** Metres on a side, centred on the pad. */
	size: 6000,
	/** Heightmap samples per side. */
	grid: 256,
	/** Metres, the tallest dune crest. */
	duneMax: 90,
	/** Wide enough that a pilot acting every 10 to 20 s at 25 m/s can put the ship on it. */
	padRadius: 120,
	/** The sandstorm wall: crossing it is a crash. */
	boundaryRadius: 2800,
	spireCount: 24,
	/** Metres, a spire's radius. */
	spireRadius: [40, 120] as const,
	/** Metres above the ground at a spire's base; tops reach 450 m above sea level, above the altitude knob's ceiling. */
	spireHeight: [180, 360] as const,
	/** Clear ground between the pad and any spire's edge: a takeoff in any direction has time to look around. */
	spireMinFromPad: 1200,
	/** Clear ground between two spires' edges. */
	spireMinGap: 150,
	/** Clear ground between a spire's edge and the storm wall. */
	spireMinFromWall: 300,
} as const;

export const AUTOPILOT = {
	/** Degrees per second at or below turnRefSpeed. */
	turnRateMax: 20,
	turnRateMin: 8,
	turnRefSpeed: 50,
	/** Metres per second. */
	climbMax: 12,
	descentMax: 15,
	/** Metres per second squared. */
	accel: 5,
	/** Vertical speed asked per metre of altitude error, before the limits. */
	altitudeGain: 0.5,
} as const;

export const FLIGHT = {
	/** Speed the wings give at liftoff. */
	takeoffSpeed: 30,
	/** Seconds after liftoff during which the ship climbs at full rate whatever the altitude target. */
	liftoffSeconds: 3,
	/** Below this airspeed the wings no longer carry the ship. */
	stallSpeed: 22,
	stallSink: 10,
	/** Metres per second, with the power gone. */
	powerOutSink: 8,
	powerOutDecel: 2,
	/** Airspeed the ship slows to while landing: a hover. The wings carry it down; no stall while landing. */
	landingSpeed: 0,
	landingDescent: 3,
	/** A touchdown faster than this, or on steeper ground, is a crash. */
	safeTouchdownVspeed: 4,
	safeTouchdownSlopeDeg: 8,
	/** Display only. */
	pitchMax: 25,
	rollPerDegPerS: 2.5,
	rollMax: 60,
} as const;

export const POWER = {
	full: 100,
	/** Percent per second, level at sea level. */
	basePerS: 0.12,
	/** Percent per second per metre per second of climb. */
	climbPerMps: 0.06,
	/** Percent per second per metre of altitude: thin air costs more flapping. Twice the base rate at the ceiling. */
	altitudePerM: 0.0005,
	lowPct: 25,
} as const;

export const SENSORS = {
	/** A spire within this range and cone, standing above the ship, is the threat. The range grows with speed: threatSeconds of flight. */
	threatRange: 1500,
	threatSeconds: 20,
	threatConeDeg: 45,
	/** A spire whose top is within this many metres below the ship still counts. */
	threatClearanceMargin: 60,
	/** A warned spire is forgotten, so a new approach warns again, once it is this far outside the cone or past the range. */
	threatForgetConeDeg: 75,
	threatForgetRange: 1800,
	/** The nearest obstacles list reaches this far. */
	nearRange: 2500,
	nearCount: 6,
	/** Metres along the heading the terrain sense looks, or terrainSeconds of flight, whichever is farther. */
	terrainLookahead: 800,
	terrainSeconds: 12,
	terrainStep: 50,
	terrainWarnClearance: 40,
	/** The terrain warning re-arms once the clearance ahead is back above this. */
	terrainRearmClearance: 60,
	/** The ground ahead must stand at least this far above the ground below to be rising. */
	terrainRiseMin: 5,
	/** The wall warning fires this far out, or boundarySeconds of flight, whichever is farther. */
	boundaryWarn: 600,
	boundarySeconds: 25,
	/** A threat, terrain or wall warning repeats this often while its condition holds and worsens: an agent that
	 * attaches per call may have missed the first one. */
	warnRepeatS: 10,
} as const;

export const KNOBS = {
	heading: { default: 0, range: [0, 360] as const },
	/** The ceiling is below the tallest spires: some can only be turned away from, not flown over. */
	altitude: { default: 180, range: [40, 350] as const },
	/** The floor is below the stall speed: slowing down too much is a trap the pilot can walk into. */
	speed: { default: 50, range: [15, 90] as const },
} as const;

export const TRAFFIC = {
	/** Another ship this many seconds from closing on the ship is a warning. */
	warnSeconds: 25,
	/** Altitude difference within which another ship matters, metres. */
	altitudeBand: 60,
	/** The traffic list reaches this far, metres. */
	nearRange: 2500,
	nearCount: 6,
	/** Judged by the arena: two airborne ships closer than this, horizontally and vertically, have collided. */
	collisionRadius: 30,
	collisionAltitude: 15,
	/** Ships start on a ring of this radius around the pad's center, inside the flat pad and far enough apart that two
	 * taking off together do not meet (18 slots on it stand 40 m apart, more than collisionRadius). */
	spawnRadius: 115,
} as const;
