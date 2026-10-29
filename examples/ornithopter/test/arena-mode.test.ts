import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

describe("the declaration in the arena", () => {
	it("has no reset and the shared-sky identity, and keeps both when alone", async () => {
		const alone = await run(process.execPath, ["src/main.ts", "abai", "manifest", "--json"], {
			cwd: root,
			env: { ...process.env, ABAI_HARNESS: "off" },
		});
		const shared = await run(process.execPath, ["src/main.ts", "abai", "manifest", "--json"], {
			cwd: root,
			env: { ...process.env, ABAI_HARNESS: "off", ORNITHOPTER_ARENA: "1" },
		});
		const names = (out: string) =>
			(JSON.parse(out) as { capabilities: Array<{ name: string }> }).capabilities.map((c) => c.name);
		expect(names(alone.stdout)).toContain("flight.reset");
		expect(names(shared.stdout)).not.toContain("flight.reset");
		const identity = (out: string) => (JSON.parse(out) as { content: { identity: string } }).content.identity;
		expect(identity(alone.stdout)).toBe("abai/identity.md");
		expect(identity(shared.stdout)).toBe("abai/identity-arena.md");
	});
});

describe("a ship as the arena's child", () => {
	const runDir = mkdtempSync(join(tmpdir(), "orni-arena-"));
	let child: ChildProcess | undefined;
	const inbox: Array<Record<string, unknown>> = [];
	const next = (type: string, timeoutMs = 10000): Promise<Record<string, unknown>> =>
		new Promise((resolve, reject) => {
			const found = inbox.find((m) => m.type === type);
			if (found) {
				inbox.splice(inbox.indexOf(found), 1);
				resolve(found);
				return;
			}
			const timer = setTimeout(() => reject(new Error(`no ${type} within ${timeoutMs} ms`)), timeoutMs);
			const listener = (m: unknown): void => {
				if (typeof m === "object" && m !== null && (m as { type?: string }).type === type) {
					clearTimeout(timer);
					child?.off("message", listener);
					inbox.splice(inbox.indexOf(m as Record<string, unknown>), 1);
					resolve(m as Record<string, unknown>);
				}
			};
			child?.on("message", listener);
		});

	afterAll(async () => {
		if (child && child.exitCode === null) {
			child.kill();
			await new Promise((done) => child?.once("exit", done));
		}
		rmSync(runDir, { recursive: true, force: true });
	});

	it("reports ready with its socket, streams frames, senses traffic, and dies by collision", async () => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			ABAI_RUN_DIR: runDir,
			ORNITHOPTER_ARENA: "1",
			ORNITHOPTER_AUDIT: join(runDir, "audit.jsonl"),
		};
		delete env.ABAI_HARNESS;
		child = spawn(process.execPath, ["src/main.ts", "--arena", "--spawn", "60,0", "--callsign", "test-one"], {
			cwd: root,
			env,
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		});
		child.on("message", (m) => inbox.push(m as Record<string, unknown>));
		const ready = await next("ready");
		expect(ready.callsign).toBe("test-one");
		expect(String(ready.socket)).toContain(".sock");
		const first = (await next("frame")).frame as { callsign: string; phase: string; x: number; traffic: unknown };
		expect(first.callsign).toBe("test-one");
		expect(first.phase).toBe("grounded");
		expect(first.x).toBe(60);
		expect(first.traffic).toBeNull();
		// another ship head-on and close shows in the traffic list within a few frames
		child.send({
			type: "traffic",
			ships: [{ callsign: "test-two", x: 60, z: 1500, altitude: 40, heading: 180, speed: 50, airborne: true }],
		});
		const until = Date.now() + 5000;
		let trafficNear: Array<{ callsign: string }> = [];
		while (trafficNear.length === 0 && Date.now() < until) {
			trafficNear = ((await next("frame")).frame as { trafficNear: Array<{ callsign: string }> }).trafficNear;
		}
		expect(trafficNear[0]?.callsign).toBe("test-two");
		// on the ground a collision does nothing
		child.send({ type: "collide", with: "test-two" });
		await new Promise((done) => setTimeout(done, 300));
		expect((await next("frame")).frame).toMatchObject({ phase: "grounded" });
		// in the air it is the end: the takeoff goes through the ship's own socket, as the arena's harness would
		const takeoff = await run(
			process.execPath,
			["supervise.mjs", "--target", String(ready.socket), "call", "flight.takeoff", "up"],
			{
				cwd: root,
				env,
			},
		);
		expect(takeoff.stdout).toContain('"ok": true');
		expect(await next("state")).toMatchObject({ phase: "flying" });
		child.send({ type: "collide", with: "test-two" });
		expect(await next("state")).toMatchObject({ phase: "crashed", cause: "collision", name: "test-two" });
		// the takeoff event came first; the crash is the one that matters
		let crash = await next("event");
		for (let i = 0; i < 10 && crash.name !== "flight.crash"; i++) crash = await next("event");
		expect(crash).toMatchObject({ name: "flight.crash", payload: { cause: "collision", name: "test-two" } });
		expect(existsSync(join(runDir, "audit.jsonl"))).toBe(true);
		child.send({ type: "stop" });
		const code = await new Promise<number | null>((done) => child?.once("exit", done));
		expect(code).toBe(0);
	});
});
