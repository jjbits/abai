import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { validateManifest } from "../src/manifest/manifest.ts";
import { AbaigramAbort, createAbaigram } from "../src/program.ts";
import { FLAG_ATTACHED, FLAG_QUEUE, FLAG_WORK } from "../src/region.ts";
import type { AbaigramOptions } from "../src/registry.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function options(): AbaigramOptions {
	return {
		name: "counter",
		modes: ["turns", "sidecar"],
		cells: {
			"queue.depth": { type: "int", access: "read", doc: "Jobs waiting." },
			"worker.count": { type: "int", access: "readwrite", default: 4, range: [1, 64], doc: "Workers." },
			"mode.name": { type: "enum", enum: ["slow", "fast"], access: "read", doc: "Speed." },
			busy: { type: "bool", access: "read", doc: "Busy." },
			"last.error": { type: "string", max: 8, access: "read", doc: "Last error." },
			label: { type: "string", max: 8, access: "readwrite", default: "none", doc: "A sized knob." },
			stats: { type: "object", max: 32, access: "read", doc: "An object cell." },
		},
		events: {
			"job.failed": {
				payload: { job_id: { type: "string", max: 4 }, error: "string", extra: { type: "object", max: 16 } },
				wakes: "always",
				doc: "A job failed.",
			},
		},
		capabilities: {
			"job.retry": {
				params: { job_id: "string" },
				result: { ok: "bool" },
				effect: "mutate",
				doc: "Retry.",
				handler: () => ({ ok: true }),
			},
			"queue.size": { params: {}, result: { n: "int" }, effect: "read", doc: "Size." },
		},
		decisions: {
			on_backlog: {
				context: { depth: "int" },
				options: ["scale_up", "wait"],
				default: "wait",
				timeout: "5s",
				doc: "Backlog.",
			},
			on_fatal: { context: {}, options: ["retry"], default: "abort", timeout: "1s", doc: "Fatal." },
		},
		turns: { end_of_batch: { timeout: "30s", doc: "Batch done." } },
	};
}

function make(env: NodeJS.ProcessEnv = {}) {
	const root = mkdtempSync(`${tmpdir()}/abai-`);
	dirs.push(root);
	return createAbaigram(options(), { root, env });
}

describe("declarations become the manifest", () => {
	test("defaults are filled, lists keep insertion order, and the result validates", () => {
		const app = make();
		const { manifest } = app;
		expect(validateManifest(manifest)).toEqual([]);
		expect(manifest.entry).toBe("counter abai");
		expect(manifest.audit.path).toBe("~/.abai/audit/counter.jsonl");
		expect(manifest.cells.map((c) => c.name)).toEqual([
			"queue.depth",
			"worker.count",
			"mode.name",
			"busy",
			"last.error",
			"label",
			"stats",
		]);
		expect(manifest.cells[1].policy).toBe("auto");
		expect(manifest.cells[5].timeout).toBe("30s");
		expect(manifest.events[0].wakes).toBe("always");
		expect(manifest.capabilities[0]).toMatchObject({ dispatch: "safepoint", policy: "confirm", timeout: "30s" });
		expect(manifest.capabilities[1]).toMatchObject({ policy: "auto" });
		expect(manifest.decisions[0].policy).toBe("auto");
		// the instantiation's four, then the sidecar one when the mode is declared
		expect(manifest.deviations).toHaveLength(5);
		expect(manifest.deviations?.[4]).toMatch(/sidecar/);
	});

	test("an invalid declaration throws at startup", () => {
		expect(() =>
			createAbaigram({ name: "bad", modes: ["turns"], cells: { Bad: { type: "int", access: "read", doc: "x" } } }),
		).toThrow(/do not validate/);
	});

	test("a payload over the slot size must be declared large; the registry never guesses", () => {
		const blob = { payload: { data: { type: "string" as const, max: 5000 } }, doc: "Big." };
		expect(() => createAbaigram({ name: "big", modes: ["turns"], events: { blob } }, { env: {} })).toThrow(/large/);
		const app = createAbaigram(
			{ name: "big", modes: ["turns"], events: { blob: { ...blob, large: true } } },
			{ env: {} },
		);
		expect(app.manifest.events[0].large).toBe(true);
	});

	test("a name declared as both a decision and a turn is rejected", () => {
		expect(() =>
			createAbaigram(
				{
					name: "dup",
					modes: ["turns"],
					decisions: { go: { context: {}, options: ["a"], default: "a", timeout: "1s", doc: "x" } },
					turns: { go: { timeout: "1s", doc: "x" } },
				},
				{ env: {} },
			),
		).toThrow(/both a decision and a turn/);
	});
});

describe("cells and knobs", () => {
	test("scalar cells store and load with their declared type, and bump the version", () => {
		const app = make();
		const depth = app.cell<number>("queue.depth");
		expect(app.cell("queue.depth")).toBe(depth);
		expect(depth.get()).toBe(0);
		depth.set(7);
		expect(depth.get()).toBe(7);
		expect(app.version("queue.depth")).toBe(1);
		const busy = app.cell<boolean>("busy");
		busy.set(true);
		expect(busy.get()).toBe(true);
		const mode = app.cell<string>("mode.name");
		mode.set("fast");
		expect(mode.get()).toBe("fast");
		expect(() => mode.set("warp")).toThrow(/not a declared value/);
	});

	test("knobs start at their default and reset to it", () => {
		const app = make();
		const workers = app.knob<number>("worker.count");
		expect(workers.get()).toBe(4);
		workers.set(8);
		expect(workers.get()).toBe(8);
		workers.reset();
		expect(workers.get()).toBe(4);
		expect(() => app.knob("queue.depth")).toThrow(/read cell/);
	});

	test("sized cells are fitted to their max, and object cells are copied, never shared", () => {
		const app = make();
		const error = app.cell<string>("last.error");
		error.set("a very long message");
		expect(error.get()).toBe("a very l");
		expect(app.version("last.error")).toBe(1);
		const label = app.knob<string>("label");
		expect(label.get()).toBe("none");
		expect(() => label.onChange(() => {})).not.toThrow();
		expect(() => app.knob("worker.count").onChange(() => {})).toThrow(/scalar knob/);
		const stats = app.cell<Record<string, unknown>>("stats");
		const mine = { n: 1 };
		stats.set(mine);
		mine.n = 2;
		expect(stats.get()).toEqual({ n: 1 });
		stats.set({ text: "x".repeat(40) });
		expect(stats.get()).toMatchObject({ truncated: true });
	});

	test("readCells reports every cell by name", () => {
		const app = make();
		expect(app.readCells()).toEqual({
			"queue.depth": 0,
			"worker.count": 4,
			"mode.name": "slow",
			busy: false,
			"last.error": undefined,
			label: "none",
			stats: undefined,
		});
	});
});

describe("events", () => {
	test("an event handle is checked once and cached; an emit with no harness attached does nothing", () => {
		const app = make();
		const failed = app.event("job.failed");
		expect(app.event("job.failed")).toBe(failed);
		failed.emit({ job_id: "j1", error: "x" });
		expect(app.region.lastSeq).toBe(0);
	});

	test("an emit while attached copies declared fields, cuts sized ones and flags truncation", () => {
		const app = make();
		app.region.flags[FLAG_ATTACHED] = 1;
		const extra = { k: "a long value that will not fit" };
		app.event("job.failed").emit({ job_id: "job-0001", error: "boom", extra, undeclared: 1 });
		const read = app.region.readEvents(0);
		expect(read.slots.length).toBe(1);
		const slot = read.slots[0];
		expect(app.eventName(slot.event)).toBe("job.failed");
		expect(slot.payload).toEqual({ job_id: "job-", error: "boom", extra: { truncated: true, bytes: 38 } });
		expect(slot.truncated).toBe(true);
	});

	test("an undeclared event name is refused at the handle, attached or not", () => {
		const app = make();
		expect(() => app.event("nope")).toThrow(/declares no event/);
	});
});

describe("decisions, turns, safepoints", () => {
	test("with no harness a decision applies its default at once and is counted", async () => {
		const app = make();
		await expect(app.decide("on_backlog", { depth: 20 })).resolves.toBe("wait");
		await expect(app.decide("on_backlog")).resolves.toBe("wait");
		expect(app.counters()).toEqual({
			"decision:on_backlog": 2,
			"decision:on_fatal": 0,
			"turn:end_of_batch": 0,
			"abai.mode_fallback": 0,
		});
	});

	test("a default of abort throws AbaigramAbort", async () => {
		const app = make();
		await expect(app.decide("on_fatal")).rejects.toBeInstanceOf(AbaigramAbort);
		expect(app.counters()["decision:on_fatal"]).toBe(1);
	});

	test("a turn with no harness returns at once and is counted; takeCounters resets", async () => {
		const app = make();
		await app.turn("end_of_batch");
		expect(app.counters()["turn:end_of_batch"]).toBe(1);
		expect(app.takeCounters()["turn:end_of_batch"]).toBe(1);
		expect(app.counters()["turn:end_of_batch"]).toBe(0);
	});

	test("an undeclared decision or turn throws", async () => {
		const app = make();
		await expect(app.decide("nope")).rejects.toThrow(/declares no decision/);
		await expect(app.turn("nope")).rejects.toThrow(/declares no turn/);
	});

	test("safepoint drains queued work and clears the flag", () => {
		const app = make();
		const ran: string[] = [];
		app.safepoint();
		app.enqueue(() => ran.push("a"));
		app.enqueue(() => {
			throw new Error("handler failure stays inside");
		});
		app.enqueue(() => ran.push("b"));
		expect(app.region.flags[FLAG_QUEUE]).toBe(3);
		expect(app.region.flags[FLAG_WORK]).toBe(1);
		app.safepoint();
		expect(ran).toEqual(["a", "b"]);
		expect(app.region.flags[FLAG_QUEUE]).toBe(0);
		expect(app.region.flags[FLAG_WORK]).toBe(0);
	});

	test("capability handlers register at declaration or later", () => {
		const app = make();
		expect(app.capabilityHandler("job.retry")).toBeTypeOf("function");
		expect(app.capabilityHandler("queue.size")).toBeUndefined();
		app.capability("queue.size", () => ({ n: 1 }));
		expect(app.capabilityHandler("queue.size")).toBeTypeOf("function");
		expect(() => app.capability("nope", () => 1)).toThrow(/declares no capability/);
	});
});

describe("mode and harness selection", () => {
	test("the first declared mode is the default; ABAI_MODE picks a declared one", () => {
		expect(make().mode).toBe("turns");
		expect(make({ ABAI_MODE: "sidecar" }).mode).toBe("sidecar");
	});

	test("an undeclared ABAI_MODE falls back and is counted", () => {
		const app = make({ ABAI_MODE: "thread" });
		expect(app.mode).toBe("turns");
		expect(app.modeFallback).toBe(true);
		expect(app.counters()["abai.mode_fallback"]).toBe(1);
	});

	test("ABAI_HARNESS=off makes attach fail at once; install and session return", async () => {
		const app = make({ ABAI_HARNESS: "off" });
		await expect(app.attach()).resolves.toBe(false);
		expect(app.attachError).toBe("ABAI_HARNESS=off");
		await app.install();
		await app.session();
		expect(app.attached).toBe(false);
	});

	test("a launch socket is read once and removed from the environment; the launched program waits for its launcher and spawns nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "launch-"));
		dirs.push(dir);
		const socketPath = join(dir, "launch-1.sock");
		// the real process environment, as a launched child sees it
		process.env.ABAI_LAUNCH_SOCKET = socketPath;
		process.env.ABAI_ATTACH_WAIT_MS = "200";
		process.env.ABAI_HARNESS_BIN = join(dir, "must-not-run");
		const app = createAbaigram({ ...options(), modes: ["sidecar"] }, { root: dir, auditPath: join(dir, "a.jsonl") });
		expect(process.env.ABAI_LAUNCH_SOCKET).toBeUndefined();
		expect(app.launched).toBe(true);
		expect(app.endpoint?.socketPath).toBe(socketPath);
		await app.endpoint?.ready;
		// nobody connects: the attach fails with the reason, and no binary was looked for
		expect(await app.attach()).toBe(false);
		expect(app.attachError).toMatch(/launched, but the launcher did not connect within 200 ms/);
		// the launcher connects: attached
		const socket = createConnection(socketPath);
		await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
		for (let i = 0; i < 100 && !app.attached; i++) await new Promise((r) => setTimeout(r, 5));
		expect(app.attached).toBe(true);
		expect(app.lifecycleStatus()).toMatchObject({ launched: true, connections: 1, paused: false, mode: "sidecar" });
		socket.destroy();
		for (let i = 0; i < 100 && app.attached; i++) await new Promise((r) => setTimeout(r, 5));
		expect(app.attached).toBe(false);
		// the launcher has been and gone: a later attach place returns at once, not after the wait
		const started = Date.now();
		expect(await app.attach()).toBe(false);
		expect(Date.now() - started).toBeLessThan(150);
		expect(app.attachError).toBeDefined();
		app.endpoint?.close("test over");
		delete process.env.ABAI_ATTACH_WAIT_MS;
		delete process.env.ABAI_HARNESS_BIN;
	});

	test("a launched program that declares no sidecar mode runs as itself and says why", () => {
		process.env.ABAI_LAUNCH_SOCKET = "/tmp/never.sock";
		const app = createAbaigram({ ...options(), modes: ["turns"] }, { root: process.cwd() });
		expect(process.env.ABAI_LAUNCH_SOCKET).toBeUndefined();
		expect(app.launched).toBe(false);
		expect(app.endpoint).toBeUndefined();
		expect(app.attachError).toMatch(/launched, but .* declares no sidecar mode/);
	});

	test("an unknown ABAI_HARNESS never crashes the program: it is recorded and attach fails with it", async () => {
		const app = make({ ABAI_HARNESS: "maybe" });
		expect(app.harnessSelection).toBe("real");
		expect(app.harnessSelectionError).toMatch(/ABAI_HARNESS must be unset/);
		await expect(app.attach()).resolves.toBe(false);
		expect(app.attachError).toMatch(/ABAI_HARNESS must be unset/);
	});

	test("the root is found lazily, never at construction", () => {
		const app = createAbaigram(options(), { env: {} });
		expect(app.explicitRoot).toBeUndefined();
		expect(typeof app.content.root).toBe("string");
	});
});
