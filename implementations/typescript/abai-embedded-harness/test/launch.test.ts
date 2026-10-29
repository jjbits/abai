// Sidecar launch (abaigrammar 6.3), outside observation (5.7) and the
// lifecycle channel in its launch form (5.5): the harness starts a program
// as its child, sees its output and exit, and drives pause, stop and
// restart on the one child it started.
import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { createModels, fauxAssistantMessage, fauxProvider } from "@arx-06/ai";
import { afterEach, describe, expect, test } from "vitest";
import { SessionForm } from "../src/agent.ts";
import { Harness } from "../src/harness.ts";
import { LaunchedProgram } from "../src/launch.ts";
import { defaultOptions } from "../src/options.ts";
import { SocketTransport } from "../src/transport-socket.ts";
import { scriptedChannel } from "../src/user-channel.ts";

const tick = resolve(import.meta.dirname, "fixtures/tick-program.ts");
const counterExample = resolve(import.meta.dirname, "../../abai/examples/counter");
const stubSrc = resolve(import.meta.dirname, "../../abai/src");

/** A copy of the counter example in `dir`, so its audit log lands there and not in the checked-in example. */
function copyCounter(dir: string): string {
	const copy = join(dir, "counter");
	cpSync(counterExample, copy, { recursive: true });
	const program = join(copy, "counter.ts");
	writeFileSync(program, readFileSync(program, "utf8").replaceAll("../../src/", `${stubSrc}/`));
	return program;
}

const dirs: string[] = [];
const launched: LaunchedProgram[] = [];
/** Programs a test started itself (the attach form), each ended by its own handle. */
const children: { child: ChildProcess; harness: Harness }[] = [];
afterEach(async () => {
	for (const program of launched.splice(0)) await program.shutdown("test over");
	for (const { child, harness } of children.splice(0)) {
		harness.shutdown("test over");
		if (child.exitCode === null && child.signalCode === null) {
			const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			child.kill("SIGTERM");
			await gone;
		}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("waited in vain");
		await sleep(20);
	}
}

/** The attach form: the program runs on its own, and the harness connects to it by pid. */
async function spawnAttached(mode: string) {
	const dir = mkdtempSync(join(tmpdir(), "attach-"));
	dirs.push(dir);
	const runDir = join(dir, "run");
	const child = spawn(process.execPath, [tick, mode], {
		env: {
			...process.env,
			ABAI_MODE: "sidecar",
			ABAI_RUN_DIR: runDir,
			ABAI_HOME: join(dir, "home"),
			ABAI_HARNESS: "",
			ABAI_HARNESS_BIN: join(dir, "no-such-harness"),
			ABAI_ATTACH_WAIT_MS: "100",
			TICK_AUDIT: join(dir, "tick-audit.jsonl"),
		},
		stdio: ["ignore", "ignore", "ignore"],
	});
	const harness = new Harness(defaultOptions("session", { auto: true }));
	children.push({ child, harness });
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			const transport = await SocketTransport.connect(child.pid as number, { runDir, connectTimeoutMs: 2000 });
			await harness.attach(transport);
			return { harness, child };
		} catch (error) {
			if (Date.now() > deadline) throw error;
			await sleep(20);
		}
	}
}

async function launch(args: string[] | ((dir: string) => string[]), budget?: number) {
	const dir = mkdtempSync(join(tmpdir(), "launch-"));
	dirs.push(dir);
	if (typeof args === "function") args = args(dir);
	const harness = new Harness(defaultOptions("session", { auto: true, ...(budget === undefined ? {} : { budget }) }));
	// what the person would see: the child's standard output written through, whole lines
	const out: string[] = [];
	const through = new Writable({
		write(chunk, _encoding, callback) {
			out.push(String(chunk));
			callback();
		},
	});
	const program = await LaunchedProgram.start(harness, {
		command: [process.execPath, ...args],
		runDir: join(dir, "run"),
		env: {
			ABAI_HARNESS: "",
			ABAI_HOME: join(dir, "home"),
			ABAI_HARNESS_BIN: join(dir, "no-such-harness"),
			TICK_AUDIT: join(dir, "tick-audit.jsonl"),
		},
		stdout: through,
		stderr: null,
		attachWaitMs: 10_000,
	});
	harness.launcher = program;
	launched.push(program);
	const lines = (name: string) =>
		harness.ring
			.last(5000)
			.map((l) => l.text)
			.filter((t) => t.startsWith(name));
	return { harness, program, lines, out };
}

describe("sidecar launch", () => {
	test("the child is attached, its output and its exit are observed, and the exit wakes the agent", async () => {
		const { harness, program, lines } = await launch([tick, "4"]);
		expect(program.lastNote).toMatch(/^attached to ticky \(pid \d+\) as k1/);
		expect(program.state()).toMatchObject({ running: true, starts: 1 });
		const status = (await harness.lifecycle("status", "look")) as { launch: unknown; program: unknown };
		expect(status.launch).toMatchObject({ running: true });
		expect(status.program).toMatchObject({ name: "ticky", launched: true, paused: false });
		await program.exited();
		expect(program.state()).toMatchObject({ running: false, exit: { code: 3, signal: null } });
		// the program's own exit is the session's code
		expect(program.exitCode()).toBe(3);
		// the observation floor: lines of both streams, then the exit
		expect(lines("abai.io.stdout").length).toBe(4);
		// observed lines are the harness's own: the program's sequence (no events here) is left at 0
		expect(harness.ring.lastSeq).toBe(0);
		expect(lines("abai.io.stdout")[0]).toBe("abai.io.stdout line=tick 1");
		expect(lines("abai.io.stderr")).toEqual(["abai.io.stderr line=err 2", "abai.io.stderr line=err 4"]);
		// the exit and the disconnect are the two wakes, in one delivery or two depending on which lands first;
		// the ticks are transcript lines carried along, not wakes
		const texts: string[] = [];
		for (let i = 0; i < 2 && !texts.some((t) => t.includes("disconnected from the program")); i++) {
			const woke = await harness.nextDelivery(2000);
			if (woke) texts.push(woke.text);
		}
		const all = texts.join("\n");
		expect(all).toContain("abai.lifecycle.exited");
		expect(all).toContain("code=3");
		expect(all).toContain("disconnected from the program");
		const wakes = texts.reduce((n, t) => n + Number(/\[abai wake\] (\d+) wake/.exec(t)?.[1] ?? 0), 0);
		expect(wakes).toBe(2);
	}, 20_000);

	test("past the per-second cap, lines are counted rather than kept, and the pipe is still drained", async () => {
		const { program, lines } = await launch([tick, "flood"]);
		await program.exited();
		const kept = lines("abai.io.stdout line=");
		const dropped = lines("abai.io.stdout dropped=");
		expect(kept.length).toBeLessThanOrEqual(200);
		expect(dropped.length).toBeGreaterThan(0);
		const counted = dropped.reduce((sum, t) => sum + Number(/dropped=(\d+)/.exec(t)?.[1] ?? 0), 0);
		expect(kept.length + counted).toBe(1000);
		expect(program.state().exit).toEqual({ code: 0, signal: null });
	}, 20_000);

	test("os pause holds the program and resume lets it go on; a program that ignores the first signal is ended by the last", async () => {
		const { harness, program, lines } = await launch([tick, "forever"]);
		await sleep(200);
		expect(await harness.lifecycle("pause", "hold it")).toBe("paused (os)");
		await sleep(100);
		const held = lines("abai.io.stdout").length;
		await sleep(300);
		expect(lines("abai.io.stdout").length).toBeLessThanOrEqual(held + 1);
		expect(await harness.lifecycle("resume", "go on")).toBe("resumed (os)");
		await sleep(300);
		expect(lines("abai.io.stdout").length).toBeGreaterThan(held + 2);
		// paused again when the stop comes: it is let go first, or it could never exit
		expect(await harness.lifecycle("pause", "hold it again")).toBe("paused (os)");
		// no stop handler declared, and the program does nothing on the first signal: the launcher's two steps
		const started = Date.now();
		const stopped = (await harness.lifecycle("stop", "enough", "auto")) as string;
		expect(stopped).toMatch(/resumed first, ended after the graceful window, forced; exited SIGKILL/);
		expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
		expect(program.state()).toMatchObject({ running: false, exit: { code: null, signal: "SIGKILL" } });
		// the launcher ended it: not the program's failure, so the session's code is 0
		expect(program.exitCode()).toBe(0);
	}, 20_000);

	test("a cooperative pause through the launcher holds the program at its next touchpoint, and the agent is told", async () => {
		const { harness, program, lines } = await launch([tick, "coop"]);
		await waitFor(() => lines("abai.io.stdout").length >= 2);
		await harness.lifecycle("pause", "hold it");
		await waitFor(() => lines("abai.pause.blocked").length >= 1);
		expect(lines("abai.pause.blocked")[0]).toBe("abai.pause.blocked touchpoint=tick");
		const held = lines("abai.io.stdout").length;
		await sleep(400);
		expect(lines("abai.io.stdout").length).toBe(held);
		expect(await harness.lifecycle("status", "look")).toMatchObject({ program: { paused: true } });
		await harness.lifecycle("resume", "go on");
		await waitFor(() => lines("abai.io.stdout").length > held);
		// paused once more, a stop supersedes the pause: the program goes on to the signal that ends it
		await harness.lifecycle("pause", "hold it again");
		await waitFor(() => lines("abai.pause.blocked").length >= 2);
		const stopped = (await harness.lifecycle("stop", "enough", "auto")) as string;
		expect(stopped).toMatch(/ended after the graceful window; exited SIGTERM/);
		expect(program.exitCode()).toBe(0);
	}, 20_000);

	test("the manifest's policy binds the launcher too: a forbidden stop never reaches the signals", async () => {
		const { harness, program } = await launch([tick, "forbid"]);
		await expect(harness.lifecycle("stop", "try", "auto")).rejects.toThrow(/policy forbids lifecycle stop/);
		await expect(harness.lifecycle("restart", "try", "auto")).rejects.toThrow(
			/forbids lifecycle stop, so restart too/,
		);
		expect(program.running).toBe(true);
	}, 20_000);

	test("the counter is attached before its first turn under launch: the turn reaches the agent and is not skipped", async () => {
		const { harness, program, out } = await launch((dir) => [copyCounter(dir), "1"]);
		expect(program.lastNote).toMatch(/^attached to counter/);
		const woke = await harness.nextDelivery(10_000);
		expect(woke?.text).toContain("end_of_batch");
		const turn = harness.status().turns[0];
		expect(turn?.name).toBe("end_of_batch");
		harness.endTurn(turn?.id as string);
		await program.exited();
		expect(program.state().exit).toEqual({ code: 0, signal: null });
		expect(out.join("")).toMatch(/counter: 1 batches.*"turn:end_of_batch":0/);
	}, 30_000);

	test("the person's question is answered and the session ends while a slow model and a stream of turns go on: a wake never extends the person's prompt", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses(
			Array.from({ length: 60 }, (_, i) => async () => {
				await sleep(250);
				return fauxAssistantMessage(`answer ${i + 1}`, { stopReason: "stop" });
			}),
		);
		// a turn on every tick, and a budget that lets every one of them wake: wakes arrive during every model call
		const { harness, program } = await launch([tick, "coop"], 1000);
		const channel = scriptedChannel(["what did the program print so far?"]);
		const form = new SessionForm({
			harness,
			model: { model: faux.getModel(), streamFn: (m, c, o) => models.streamSimple(m, c, o) },
			channel,
			connectTimeoutMs: 10_000,
			mode: "live",
		});
		const started = Date.now();
		await form.converse();
		const elapsed = Date.now() - started;
		// the person's one question costs at most the wake run before it and its own call
		expect(elapsed).toBeLessThan(2500);
		// every answer reaches the person when it is produced, not at the end of some run
		expect(channel.said.filter((t) => /^answer \d+$/.test(t)).length).toBeGreaterThanOrEqual(1);
		await program.shutdown("the session ended");
		form.shutdown("the session ended");
		expect(program.running).toBe(false);
	}, 20_000);

	test("attached to a program it did not launch, a stop is a request: the window says whether it stopped (5.5)", async () => {
		const ignoring = await spawnAttached("stop-ignored");
		await expect(ignoring.harness.lifecycle("pause", "no")).rejects.toThrow(/needs the harness that launched/);
		const report = (await ignoring.harness.lifecycle("stop", "please", "auto")) as string;
		expect(report).toMatch(/still connected after 300 ms: it did not stop/);
		expect(ignoring.harness.attached).toBe(true);
		const willing = await spawnAttached("graceful");
		const done = (await willing.harness.lifecycle("stop", "please", "auto")) as string;
		expect(done).toMatch(/ended within its graceful window/);
		await waitFor(() => willing.child.exitCode !== null);
	}, 20_000);

	test("a graceful stop runs the program's handler, which ends it within its window; restart gives a new child", async () => {
		const { harness, program, lines } = await launch([tick, "graceful"]);
		expect(program.lastNote).toMatch(/^attached to ticky/);
		const first = program.pid;
		await expect(harness.lifecycle("start", "again")).rejects.toThrow(/is running/);
		const restarted = (await harness.lifecycle("restart", "fresh", "approved")) as string;
		expect(restarted).toMatch(/stop handler requested; exited 0; attached to ticky/);
		expect(lines("abai.io.stdout line=stopping")).toHaveLength(1);
		expect(program.state()).toMatchObject({ running: true, starts: 2 });
		expect(program.pid).not.toBe(first);
		expect(harness.attached).toBe(true);
		const stopped = (await harness.lifecycle("stop", "done", "approved")) as string;
		expect(stopped).toBe("stopped: stop handler requested; exited 0");
		expect(program.state()).toMatchObject({ running: false, exit: { code: 0, signal: null } });
		// started again by hand
		expect((await harness.lifecycle("start", "once more")) as string).toMatch(/^attached to ticky/);
		expect(program.state().starts).toBe(3);
	}, 30_000);

	test("a program that cannot take up the connection is still observed from outside", async () => {
		const dir = mkdtempSync(join(tmpdir(), "launch-plain-"));
		dirs.push(dir);
		const harness = new Harness(defaultOptions("session"));
		const program = await LaunchedProgram.start(harness, {
			command: [process.execPath, "-e", 'console.log("plain program"); process.exit(4)'],
			runDir: join(dir, "run"),
			stdout: null,
			stderr: null,
			attachWaitMs: 3000,
		});
		launched.push(program);
		expect(program.lastNote).toMatch(/exited \(4\) before taking up the launch connection/);
		expect(harness.attached).toBe(false);
		expect(harness.ring.last(10).map((l) => l.text)).toContain("abai.io.stdout line=plain program");
		expect(program.state().exit).toEqual({ code: 4, signal: null });
	}, 20_000);
});
