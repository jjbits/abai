// The registry of pilots: a session is one visitor's ship and its harness,
// a token, a callsign and a spawn slot. The registry minds the caps, judges
// collisions, hands every ship the others' positions, and reaps what is
// idle, old or wrecked.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { TRAFFIC } from "ornithopter/src/tuning.ts";
import { McpBridge } from "./bridge.ts";
import { pickCallsign } from "./callsigns.ts";
import type { ArenaConfig } from "./config.ts";
import { judge, type Position, spawnSlots } from "./judge.ts";
import type { Launched, Launcher } from "./ship.ts";

export type ShipPhase = "grounded" | "flying" | "landing" | "landed" | "crashed";

export interface Session {
	token: string;
	callsign: string;
	slot: number;
	spawn: { x: number; z: number };
	address: string;
	createdAt: number;
	lastMcpAt: number;
	crashedAt: number | undefined;
	phase: ShipPhase;
	frame: Record<string, unknown> | undefined;
	runDir: string;
	auditPath: string;
	launched: Launched | undefined;
	bridge: McpBridge | undefined;
	ending: boolean;
}

/** What the spectator stream carries for every ship, five times a second. */
export interface ShipSummary {
	callsign: string;
	x: number;
	y: number;
	z: number;
	heading: number;
	pitch: number;
	roll: number;
	phase: ShipPhase;
	cause: string;
}

export class Refused extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "Refused";
		this.status = status;
	}
}

const TOKEN_BYTES = 16;
export const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export class Sessions extends EventEmitter {
	readonly slots: Array<{ x: number; z: number }>;
	private readonly byToken = new Map<string, Session>();
	private readonly creations = new Map<string, number[]>();
	private timers: NodeJS.Timeout[] = [];
	private readonly crashedPairs = new Set<string>();

	private readonly config: ArenaConfig;
	private readonly launcher: Launcher;
	private readonly now: () => number;

	constructor(config: ArenaConfig, launcher: Launcher, now: () => number = Date.now) {
		super();
		this.config = config;
		this.launcher = launcher;
		this.now = now;
		// the spawn ring sits at the pad's edge, where the ground is still flat and ships stand far enough apart
		this.slots = spawnSlots(config.maxSessions, TRAFFIC.spawnRadius);
	}

	live(): Session[] {
		return [...this.byToken.values()].filter((s) => !s.ending);
	}

	get(token: string): Session | undefined {
		const s = this.byToken.get(token);
		return s && !s.ending && s.bridge ? s : undefined;
	}

	/** A visitor presses Fly: the caps, a slot, a callsign, a token, two children. */
	async create(address: string): Promise<Session> {
		const now = this.now();
		const live = this.live();
		if (live.length >= this.config.maxSessions) throw new Refused(503, "the sky is full; try again in a few minutes");
		if (live.filter((s) => s.address === address).length >= this.config.perAddress) {
			throw new Refused(429, `you already have ${this.config.perAddress} ships up`);
		}
		const recent = (this.creations.get(address) ?? []).filter((t) => now - t < 60_000);
		if (recent.length >= this.config.createsPerMinute) throw new Refused(429, "too many new ships in a minute; wait");
		recent.push(now);
		this.creations.set(address, recent);

		// the free slot farthest from every occupied one, so arrivals spread around the ring
		const taken = live.map((s) => this.slots[s.slot] as { x: number; z: number });
		let slot = -1;
		let best = -1;
		this.slots.forEach((candidate, i) => {
			if (live.some((s) => s.slot === i)) return;
			const nearest = taken.length
				? Math.min(...taken.map((t) => Math.hypot(t.x - candidate.x, t.z - candidate.z)))
				: Number.POSITIVE_INFINITY;
			if (nearest > best) {
				best = nearest;
				slot = i;
			}
		});
		if (slot < 0) throw new Refused(503, "no free slot on the pad");
		const callsign = pickCallsign(new Set(live.map((s) => s.callsign)));
		const token = randomBytes(TOKEN_BYTES).toString("hex");
		// 64 bits of the token name the run directory: another session's socket path is not guessable
		const runDir = join(this.config.runRoot, token.slice(0, 16));
		mkdirSync(runDir, { recursive: true, mode: 0o700 });
		const session: Session = {
			token,
			callsign,
			slot,
			spawn: this.slots[slot] as { x: number; z: number },
			address,
			createdAt: now,
			lastMcpAt: now,
			crashedAt: undefined,
			phase: "grounded",
			frame: undefined,
			runDir,
			auditPath: join(runDir, "audit.jsonl"),
			launched: undefined,
			bridge: undefined,
			ending: false,
		};
		// reserved before the launch, so two visitors pressing Fly together get different slots and names
		this.byToken.set(token, session);
		try {
			session.launched = await this.launcher.launch({
				callsign,
				spawn: session.spawn,
				seed: this.config.seed,
				runDir,
				auditPath: session.auditPath,
			});
		} catch (error) {
			this.byToken.delete(token);
			rmSync(runDir, { recursive: true, force: true });
			throw error;
		}
		if (session.ending) {
			// ended while it launched (a shutdown): the children it just got are not kept
			session.launched.kill();
			rmSync(runDir, { recursive: true, force: true });
			throw new Refused(503, "the arena is shutting down");
		}
		session.bridge = new McpBridge(session.launched.harness);
		this.wire(session);
		this.emit("joined", { callsign, slot });
		return session;
	}

	/** An MCP request came for the session: it is not idle. */
	touch(token: string): void {
		const s = this.byToken.get(token);
		if (s) s.lastMcpAt = this.now();
	}

	end(token: string, reason: string): void {
		const s = this.byToken.get(token);
		if (!s || s.ending) return;
		s.ending = true;
		s.bridge?.close();
		s.launched?.kill();
		this.byToken.delete(token);
		// the audit log outlives the session for a while, by callsign; the run directory does not
		try {
			if (existsSync(s.auditPath)) {
				const done = join(this.config.runRoot, "done");
				mkdirSync(done, { recursive: true, mode: 0o700 });
				const kept = join(done, `${s.callsign}-${token.slice(0, 8)}.jsonl`);
				renameSync(s.auditPath, kept);
				// stamped with the registry's own clock, which is what the pruning reads it against
				const stamp = this.now() / 1000;
				utimesSync(kept, stamp, stamp);
			}
			rmSync(s.runDir, { recursive: true, force: true });
		} catch {
			// a missing file is nothing to report
		}
		for (const key of this.crashedPairs) if (key.includes(token)) this.crashedPairs.delete(key);
		this.emit("left", { callsign: s.callsign, reason, token });
	}

	summaries(): ShipSummary[] {
		return this.live()
			.filter((s) => s.frame)
			.map((s) => {
				const f = s.frame as Record<string, number | string>;
				return {
					callsign: s.callsign,
					x: Number(f.x),
					y: Number(f.altitude),
					z: Number(f.z),
					heading: Number(f.heading),
					pitch: Number(f.pitch),
					roll: Number(f.roll),
					phase: s.phase,
					cause: String(f.crashCause ?? ""),
				};
			});
	}

	/** Ten times a second: the collision judgement, then every ship told where the others are. */
	tick(): void {
		const positions: Array<Position & { heading: number; speed: number; session: Session }> = [];
		for (const s of this.live()) {
			const f = s.frame as Record<string, number> | undefined;
			if (!f) continue;
			positions.push({
				callsign: s.callsign,
				x: f.x,
				z: f.z,
				altitude: f.altitude,
				heading: f.heading,
				speed: f.speed,
				airborne: s.phase === "flying" || s.phase === "landing",
				session: s,
			});
		}
		for (const hit of judge(positions)) {
			// the pair by token, not callsign: callsigns come back once a session ends
			const tokenOf = (callsign: string) =>
				positions.find((q) => q.callsign === callsign)?.session.token ?? callsign;
			const key = [tokenOf(hit.a), tokenOf(hit.b)].sort().join("|");
			if (this.crashedPairs.has(key)) continue;
			this.crashedPairs.add(key);
			for (const [mine, other] of [
				[hit.a, hit.b],
				[hit.b, hit.a],
			]) {
				const p = positions.find((q) => q.callsign === mine);
				p?.session.launched?.send({ type: "collide", with: other });
			}
			this.emit("collision", { a: hit.a, b: hit.b, distance: Math.round(hit.distance) });
		}
		for (const p of positions) {
			const ships = positions
				.filter((q) => q !== p)
				.map((q) => ({
					callsign: q.callsign,
					x: q.x,
					z: q.z,
					altitude: q.altitude,
					heading: q.heading,
					speed: q.speed,
					airborne: q.airborne,
				}));
			p.session.launched?.send({ type: "traffic", ships });
		}
	}

	/** Every few seconds: what is idle, too old, or long wrecked goes; old audit logs go too. */
	reap(): void {
		const now = this.now();
		for (const s of this.live()) {
			if (now - s.lastMcpAt > this.config.idleMs) this.end(s.token, "idle");
			else if (now - s.createdAt > this.config.lifetimeMs) this.end(s.token, "lifetime");
			else if (s.crashedAt !== undefined && now - s.crashedAt > this.config.wreckMs) this.end(s.token, "wreck");
		}
		for (const [address, times] of this.creations) {
			const recent = times.filter((t) => now - t < 60_000);
			if (recent.length === 0) this.creations.delete(address);
			else this.creations.set(address, recent);
		}
		const done = join(this.config.runRoot, "done");
		if (!existsSync(done)) return;
		for (const name of readdirSync(done)) {
			const path = join(done, name);
			try {
				if (now - statSync(path).mtimeMs > this.config.auditKeepMs) unlinkSync(path);
			} catch {
				// gone already
			}
		}
	}

	start(): void {
		this.timers = [setInterval(() => this.tick(), 100), setInterval(() => this.reap(), 5_000)];
	}

	stop(): void {
		for (const t of this.timers) clearInterval(t);
		this.timers = [];
		for (const s of [...this.byToken.values()]) this.end(s.token, "shutdown");
	}

	private wire(session: Session): void {
		const launched = session.launched as Launched;
		launched.events.on("ship", (m: Record<string, unknown>) => {
			if (session.ending) return;
			if (m.type === "frame" && typeof m.frame === "object" && m.frame !== null) {
				session.frame = m.frame as Record<string, unknown>;
				const phase = (m.frame as { phase?: string }).phase;
				if (phase) session.phase = phase as ShipPhase;
				this.emit("frame", { callsign: session.callsign, frame: session.frame });
			} else if (m.type === "state") {
				session.phase = m.phase as ShipPhase;
				if (m.phase === "crashed" && session.crashedAt === undefined) {
					session.crashedAt = this.now();
					this.emit("crashed", { callsign: session.callsign, cause: m.cause, name: m.name });
				}
			} else if (m.type === "event") {
				this.emit("event", { callsign: session.callsign, name: m.name, payload: m.payload });
			}
		});
		void launched.exit.then((what) => {
			if (!session.ending) this.end(session.token, `${what.who} exited (${what.code})`);
		});
	}
}
