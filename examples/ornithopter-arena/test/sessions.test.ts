import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configFrom } from "../src/config.ts";
import { Refused, Sessions } from "../src/sessions.ts";
import { fakeLauncher } from "./fake-launcher.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(env: Record<string, string> = {}) {
	const runRoot = mkdtempSync(join(tmpdir(), "arena-sessions-"));
	dirs.push(runRoot);
	const config = configFrom(
		{
			ARENA_RUN_ROOT: runRoot,
			ARENA_MAX_SESSIONS: "4",
			ARENA_PER_ADDRESS: "2",
			ARENA_CREATES_PER_MINUTE: "3",
			...env,
		},
		{ shipEntry: "ship", harnessBin: "harness" },
	);
	const { launcher, ships, failNext } = fakeLauncher();
	let clock = 1_000_000;
	const sessions = new Sessions(config, launcher, () => clock);
	const advance = (ms: number) => {
		clock += ms;
	};
	return { config, sessions, ships, failNext, advance, runRoot };
}

const flying = (x: number, z: number, altitude = 180, heading = 0) => ({
	x,
	z,
	altitude,
	heading,
	speed: 50,
	phase: "flying",
	pitch: 0,
	roll: 0,
	crashCause: "",
});

describe("sessions", () => {
	it("mints a session with a slot, a callsign, a token, a run directory, and two children", async () => {
		const { sessions, ships, runRoot } = setup();
		const s = await sessions.create("1.2.3.4");
		expect(s.token).toMatch(/^[0-9a-f]{32}$/);
		expect(s.callsign).toMatch(/^[a-z]+-[a-z]+$/);
		expect(s.slot).toBe(0);
		expect(s.spawn).toEqual(sessions.slots[0]);
		expect(ships[0]?.spec).toMatchObject({ callsign: s.callsign, runDir: join(runRoot, s.token.slice(0, 16)) });
		expect(existsSync(s.runDir)).toBe(true);
		expect(sessions.get(s.token)).toBe(s);
		expect(sessions.get("0".repeat(32))).toBeUndefined();
		const other = await sessions.create("1.2.3.5");
		// the second arrival takes the slot farthest from the first
		expect(other.slot).toBe(2);
		expect(other.callsign).not.toBe(s.callsign);
	});

	it("holds the caps: the sky, each address, and the pace of creation", async () => {
		const { sessions, advance } = setup();
		await sessions.create("a");
		await sessions.create("a");
		await expect(sessions.create("a")).rejects.toMatchObject({ status: 429 });
		await sessions.create("b");
		await sessions.create("c");
		await expect(sessions.create("d")).rejects.toMatchObject({ status: 503 });
		// b made one; two more within the minute are the pace, the fourth is refused even once the sky clears
		const b2 = await sessions.create("b").catch((e: Refused) => e);
		expect(b2).toBeInstanceOf(Refused); // the sky is still full
		advance(61_000);
		expect(((await sessions.create("b").catch((e: Refused) => e)) as Refused).status).toBe(503);
	});

	it("frees the slot and the name when a launch fails", async () => {
		const { sessions, failNext } = setup();
		failNext.error = "no ship";
		await expect(sessions.create("a")).rejects.toThrow("no ship");
		const s = await sessions.create("a");
		expect(s.slot).toBe(0);
	});

	it("tracks frames and phases, judges a collision, and tells every ship about the others", async () => {
		const { sessions, ships } = setup();
		const a = await sessions.create("a");
		const b = await sessions.create("b");
		const c = await sessions.create("c");
		const collisions: unknown[] = [];
		sessions.on("collision", (d) => collisions.push(d));
		ships[0]?.frame(flying(0, 0));
		ships[1]?.frame(flying(10, 0));
		ships[2]?.frame(flying(1000, 0));
		expect(sessions.summaries().map((s) => s.callsign)).toEqual([a.callsign, b.callsign, c.callsign]);
		expect(a.phase).toBe("flying");
		sessions.tick();
		expect(collisions).toEqual([{ a: a.callsign, b: b.callsign, distance: 10 }]);
		expect(ships[0]?.received.find((m) => m.type === "collide")).toEqual({ type: "collide", with: b.callsign });
		expect(ships[1]?.received.find((m) => m.type === "collide")).toEqual({ type: "collide", with: a.callsign });
		expect(ships[2]?.received.find((m) => m.type === "collide")).toBeUndefined();
		const traffic = ships[2]?.received.find((m) => m.type === "traffic") as { ships: Array<{ callsign: string }> };
		expect(traffic.ships.map((s) => s.callsign).sort()).toEqual([a.callsign, b.callsign].sort());
		// the same pair is not judged twice while the crash propagates, and the pair is forgotten with the session
		sessions.tick();
		expect(collisions).toHaveLength(1);
		sessions.end(a.token, "test");
		sessions.end(b.token, "test");
	});

	it("reaps the idle, the old and the wrecked, keeping the audit log for a while", async () => {
		const { sessions, ships, advance, runRoot } = setup({
			ARENA_IDLE_MS: "1000",
			ARENA_LIFETIME_MS: "5000",
			ARENA_WRECK_MS: "500",
			ARENA_AUDIT_KEEP_MS: "100",
		});
		const left: unknown[] = [];
		sessions.on("left", (d) => left.push(d));
		const idle = await sessions.create("a");
		const busy = await sessions.create("b");
		const wreck = await sessions.create("c");
		writeFileSync(wreck.auditPath, "{}\n");
		ships[2]?.state("crashed", "collision", busy.callsign);
		expect(wreck.crashedAt).toBeDefined();
		advance(700);
		sessions.touch(busy.token);
		sessions.reap();
		expect(
			sessions
				.live()
				.map((s) => s.callsign)
				.sort(),
		).toEqual([idle.callsign, busy.callsign].sort());
		expect(ships[2]?.killed).toBe(true);
		expect(existsSync(wreck.runDir)).toBe(false);
		const kept = readdirSync(join(runRoot, "done"));
		expect(kept).toHaveLength(1);
		expect(kept[0]).toContain(wreck.callsign);
		advance(500);
		sessions.touch(busy.token);
		sessions.reap();
		expect(sessions.live().map((s) => s.callsign)).toEqual([busy.callsign]);
		advance(5000);
		sessions.touch(busy.token);
		sessions.reap();
		expect(sessions.live()).toHaveLength(0);
		expect(left.map((d) => (d as { reason: string }).reason).sort()).toEqual(["idle", "lifetime", "wreck"]);
		expect(readdirSync(join(runRoot, "done"))).toHaveLength(0);
	});

	it("ends a session whose child exits", async () => {
		const { sessions, ships } = setup();
		const s = await sessions.create("a");
		ships[0]?.events.emit("exit", { who: "ship", code: 1 });
		await new Promise((done) => setImmediate(done));
		expect(sessions.get(s.token)).toBeUndefined();
		expect(sessions.live()).toHaveLength(0);
	});
});
