import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The game as a child in its own run directory, and the one-shot client
// against it: the whole path a coding agent takes from a shell.
const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const runDir = mkdtempSync(join(tmpdir(), "ornithopter-run-"));
// the game child selects the real harness, whatever the suite's own environment says
const env: NodeJS.ProcessEnv = { ...process.env, ABAI_RUN_DIR: runDir };
delete env.ABAI_HARNESS;
let game: ChildProcess;

const supervise = async (...args: string[]): Promise<{ stdout: string; code: number }> => {
	try {
		const { stdout } = await run(process.execPath, ["supervise.mjs", "--target", String(game.pid), ...args], {
			cwd: root,
			env,
			timeout: 30000,
		});
		return { stdout, code: 0 };
	} catch (error) {
		const e = error as { stdout?: string; code?: number };
		return { stdout: e.stdout ?? "", code: typeof e.code === "number" ? e.code : 2 };
	}
};

beforeAll(async () => {
	game = spawn(process.execPath, ["src/main.ts", "--port", "0"], {
		cwd: root,
		env,
		stdio: ["ignore", "inherit", "pipe"],
	});
	await new Promise<void>((resolve, reject) => {
		let out = "";
		game.stderr?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
			if (out.includes("waiting for its pilot")) resolve();
		});
		game.once("exit", (code) => reject(new Error(`the game exited early with ${code}`)));
		setTimeout(() => reject(new Error(`the game did not start: ${out}`)), 15000);
	});
}, 20000);

afterAll(async () => {
	// our own child, by its handle
	game.kill();
	await new Promise((done) => game.once("exit", done));
	rmSync(runDir, { recursive: true, force: true });
});

describe("the one-shot client", () => {
	it("reads the prompt and the cells", async () => {
		const prompt = await supervise("prompt");
		expect(prompt.code).toBe(0);
		expect(prompt.stdout).toContain("You are the pilot");
		expect(prompt.stdout).toContain("target.heading_deg");
		const cells = await supervise("cells", "flight.phase", "ship.altitude_m");
		expect(cells.code).toBe(0);
		expect(cells.stdout).toContain("grounded");
	});

	it("sets a knob, calls a capability, and sees the flight begin", async () => {
		const set = await supervise("set", "target.heading_deg", "45", "the north-east is clear");
		expect(set.code).toBe(0);
		expect(set.stdout).toContain("45");
		const takeoff = await supervise("call", "flight.takeoff", "let us fly");
		expect(takeoff.code).toBe(0);
		expect(takeoff.stdout).toContain('"ok": true');
		await new Promise((done) => setTimeout(done, 1500));
		const cells = await supervise("cells", "flight.phase", "ship.speed_mps", "flight.time_s");
		expect(cells.stdout).toContain("flying");
	});

	it("answers a refused act as a result, a failed tool as 1, and nonsense as 2", async () => {
		// the program refusing an act is an answer, not a failure: the capability returned { ok: false }
		const again = await supervise("call", "flight.takeoff", "once more");
		expect(again.code).toBe(0);
		expect(again.stdout).toContain('"ok": false');
		// the tool itself failing (a write to a read cell) is exit 1
		const bad = await supervise("set", "ship.altitude_m", "10", "not a knob");
		expect(bad.code).toBe(1);
		const usage = await supervise("fly");
		expect(usage.code).toBe(2);
		expect((await supervise("wait", "soon")).code).toBe(2);
	});

	it("parks on wait and comes back with no wake when nothing happens", async () => {
		const started = Date.now();
		const waited = await supervise("wait", "1");
		expect(waited.code).toBe(0);
		expect(waited.stdout).toContain("no wake in 1s");
		expect(Date.now() - started).toBeLessThan(10000);
	});

	it("says so when the target is not there", async () => {
		const gone = await run(process.execPath, ["supervise.mjs", "--target", "999999999", "prompt"], {
			cwd: root,
			env,
		}).then(
			(r) => ({ stdout: r.stdout, code: 0 }),
			(e: { stdout?: string; code?: number }) => ({ stdout: e.stdout ?? "", code: e.code ?? 2 }),
		);
		expect(gone.code).toBe(1);
		expect(gone.stdout).toContain("attach first");
	});

	it("resets the ship through the client", async () => {
		const reset = await supervise("call", "flight.reset", "back to the pad");
		expect(reset.code).toBe(0);
		await new Promise((done) => setTimeout(done, 300));
		const cells = await supervise("cells", "flight.phase");
		expect(cells.stdout).toContain("grounded");
	});
});
