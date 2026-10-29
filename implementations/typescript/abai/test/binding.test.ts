import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CallError, type DecisionRequest, type HarnessBinding, type LiveEvent } from "../src/harness-binding.ts";
import { AbaigramAbort, createAbaigram } from "../src/program.ts";
import { FLAG_WORK } from "../src/region.ts";
import type { AbaigramOptions } from "../src/registry.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function options(): AbaigramOptions {
	return {
		name: "bound",
		modes: ["turns"],
		cells: {
			"queue.depth": { type: "int", access: "read", doc: "Depth." },
			"worker.count": { type: "int", access: "readwrite", default: 4, range: [1, 64], doc: "Workers." },
			label: { type: "string", max: 8, access: "readwrite", default: "none", timeout: "50ms", doc: "Label." },
		},
		events: { "job.failed": { payload: { job_id: "string" }, wakes: "always", doc: "Failed." } },
		capabilities: {
			"job.retry": {
				params: { job_id: "string" },
				result: { ok: "bool" },
				effect: "mutate",
				timeout: "50ms",
				doc: "Retry.",
				handler: ({ job_id }) => ({ ok: job_id === "j1" }),
			},
			"queue.size": {
				params: {},
				result: { n: "int" },
				effect: "read",
				dispatch: "immediate",
				doc: "Size.",
				handler: () => ({ n: 3 }),
			},
			"job.drop": { params: {}, result: {}, effect: "mutate", policy: "forbid", doc: "Drop.", handler: () => ({}) },
			"job.boom": {
				params: {},
				result: {},
				effect: "mutate",
				dispatch: "immediate",
				doc: "Boom.",
				handler: () => {
					throw new Error("kaboom");
				},
			},
			"job.silent": { params: {}, result: {}, effect: "mutate", dispatch: "immediate", doc: "No handler." },
		},
		decisions: {
			on_backlog: {
				context: { depth: "int" },
				options: ["scale_up", "wait"],
				default: "wait",
				timeout: "50ms",
				doc: "Backlog.",
			},
			on_shape: { context: {}, answer: { n: "int" }, default: { n: 0 }, timeout: "50ms", doc: "Shape." },
			on_secret: {
				context: {},
				options: ["a"],
				default: "a",
				timeout: "50ms",
				policy: "forbid",
				doc: "Never asked.",
			},
			on_fatal: { context: {}, options: ["retry"], default: "abort", timeout: "50ms", doc: "Fatal." },
		},
		turns: { end_of_batch: { timeout: "50ms", doc: "Batch." } },
	};
}

interface Bound {
	app: ReturnType<typeof createAbaigram>;
	binding: HarnessBinding;
	auditPath: string;
	records(): Array<Record<string, unknown>>;
	decisions: DecisionRequest[];
	events: LiveEvent[];
}

async function bind(extra: Partial<AbaigramOptions> = {}): Promise<Bound> {
	const dir = mkdtempSync(`${tmpdir()}/abai-bind-`);
	dirs.push(dir);
	const auditPath = join(dir, "audit.jsonl");
	let binding: HarnessBinding | undefined;
	const decisions: DecisionRequest[] = [];
	const events: LiveEvent[] = [];
	const app = createAbaigram(
		{ ...options(), ...extra },
		{
			env: {},
			root: dir,
			auditPath,
			harness: (b) => {
				binding = b;
				b.on("decision", (request) => {
					decisions.push(request);
				});
				b.on("event", (event) => {
					events.push(event);
				});
			},
		},
	);
	expect(await app.attach()).toBe(true);
	if (!binding) throw new Error("the factory was not called");
	return {
		app,
		binding,
		auditPath,
		decisions,
		events,
		records: () =>
			existsSync(auditPath)
				? readFileSync(auditPath, "utf8")
						.split("\n")
						.filter((line) => line !== "")
						.map((line) => JSON.parse(line) as Record<string, unknown>)
				: [],
	};
}

const tick = (): Promise<void> => new Promise((done) => setImmediate(done));

describe("attaching through the factory", () => {
	test("attach is one of the places, is idempotent, and flushes the counters first", async () => {
		const dir = mkdtempSync(`${tmpdir()}/abai-bind-`);
		dirs.push(dir);
		const auditPath = join(dir, "audit.jsonl");
		let calls = 0;
		const app = createAbaigram(options(), {
			env: {},
			root: dir,
			auditPath,
			harness: () => {
				calls += 1;
			},
		});
		await expect(app.decide("on_backlog")).resolves.toBe("wait"); // counted while detached
		expect(await app.attach()).toBe(true);
		expect(await app.attach()).toBe(true);
		expect(calls).toBe(1);
		expect(app.attached).toBe(true);
		expect(app.directBinding?.name).toBe("bound");
		const counters = JSON.parse(readFileSync(auditPath, "utf8").split("\n")[0]);
		expect(counters).toMatchObject({ act: "counters", name: "decision:on_backlog", count: 1, cause: "no_harness" });
		expect(app.counters()["decision:on_backlog"]).toBe(0);
	});

	test("a factory that throws leaves the program detached with the reason", async () => {
		const dir = mkdtempSync(`${tmpdir()}/abai-bind-`);
		dirs.push(dir);
		const app = createAbaigram(options(), {
			env: {},
			root: dir,
			auditPath: join(dir, "a.jsonl"),
			harness: () => {
				throw new Error("no model configured");
			},
		});
		expect(await app.attach()).toBe(false);
		expect(app.attached).toBe(false);
		expect(app.attachError).toBe("no model configured");
	});
});

describe("decisions through the binding", () => {
	test("an answer with a reason reaches the program and the audit log", async () => {
		const { app, binding, decisions, records } = await bind();
		const pending = app.decide<string>("on_backlog", { depth: 20 });
		await tick();
		expect(decisions.length).toBe(1);
		expect(decisions[0]).toMatchObject({ name: "on_backlog", context: { depth: 20 } });
		expect(binding.pendingDecisions().map((d) => d.id)).toEqual([decisions[0].id]);
		binding.answerDecision(decisions[0].id, "scale_up", "the backlog is growing");
		await expect(pending).resolves.toBe("scale_up");
		expect(binding.pendingDecisions()).toEqual([]);
		const record = records().find((r) => r.act === "decision");
		expect(record).toMatchObject({
			name: "on_backlog",
			outcome: "agent",
			reason: "the backlog is growing",
			value: { option: "scale_up" },
			conn: "direct",
		});
	});

	test("an invalid answer is refused and the program applies the default", async () => {
		const { app, binding, decisions, records } = await bind();
		const pending = app.decide("on_backlog");
		await tick();
		expect(() => binding.answerDecision(decisions[0].id, "explode", "oops")).toThrow(/one of: scale_up, wait/);
		await expect(pending).resolves.toBe("wait");
		expect(records().find((r) => r.act === "decision")).toMatchObject({ outcome: "default", cause: "invalid" });
	});

	test("an answer-schema decision validates its fields", async () => {
		const { app, binding, decisions } = await bind();
		const pending = app.decide<{ n: number }>("on_shape");
		await tick();
		expect(() => binding.answerDecision(decisions[0].id, { n: "x" }, "r")).toThrow(/answer.n must be a int/);
		await expect(pending).resolves.toEqual({ n: 0 });
		const again = app.decide<{ n: number }>("on_shape");
		await tick();
		binding.answerDecision(decisions[1].id, { n: 7 }, "seven");
		await expect(again).resolves.toEqual({ n: 7 });
	});

	test("a null answer means the default, with the harness's reason", async () => {
		const { app, binding, decisions, records } = await bind();
		const pending = app.decide("on_backlog");
		await tick();
		binding.answerDecision(decisions[0].id, null, "nothing to add");
		await expect(pending).resolves.toBe("wait");
		expect(records().find((r) => r.act === "decision")).toMatchObject({
			outcome: "default",
			cause: "answered",
			reason: "nothing to add",
		});
		expect(() => binding.answerDecision(decisions[0].id, null, "again")).toThrow(/no pending decision/);
		expect(() => binding.answerDecision("d99", null, "")).toThrow(/no pending decision/);
	});

	test("a reason is required", async () => {
		const { app, binding, decisions } = await bind();
		const pending = app.decide("on_backlog");
		await tick();
		expect(() => binding.answerDecision(decisions[0].id, "wait", "  ")).toThrow(/needs a reason/);
		binding.answerDecision(decisions[0].id, "wait", "ok");
		await pending;
	});

	test("the timeout applies the default; an abort default rejects", async () => {
		const { app, records } = await bind();
		await expect(app.decide("on_backlog")).resolves.toBe("wait");
		expect(records().find((r) => r.act === "decision")).toMatchObject({ outcome: "default", cause: "timeout" });
		await expect(app.decide("on_fatal")).rejects.toBeInstanceOf(AbaigramAbort);
	});

	test("a forbidden decision is never asked and is audited", async () => {
		const { app, decisions, records } = await bind();
		await expect(app.decide("on_secret")).resolves.toBe("a");
		expect(decisions).toEqual([]);
		expect(records().find((r) => r.act === "decision")).toMatchObject({ name: "on_secret", cause: "forbidden" });
	});

	test("detaching mid-decision applies the default with the reason and clears the program", async () => {
		const { app, binding, records } = await bind();
		const pending = app.decide("on_backlog");
		await tick();
		let detached: string | undefined;
		binding.on("detach", (reason) => {
			detached = reason;
		});
		binding.detach("harness quit");
		await expect(pending).resolves.toBe("wait");
		expect(detached).toBe("harness quit");
		expect(app.attached).toBe(false);
		expect(app.attachError).toBe("harness quit");
		expect(binding.attached).toBe(false);
		expect(records().find((r) => r.act === "decision")).toMatchObject({ cause: "detached", reason: "harness quit" });
	});
});

describe("turns and touchpoints through the binding", () => {
	test("a turn ends when the harness ends it, or at its timeout", async () => {
		const { app, binding, records } = await bind();
		const turns: string[] = [];
		binding.on("turn", (request) => {
			turns.push(request.id);
			expect(request.name).toBe("end_of_batch");
			binding.endTurn(request.id);
		});
		await app.turn("end_of_batch");
		expect(turns.length).toBe(1);
		expect(records().find((r) => r.act === "turn")).toMatchObject({ name: "end_of_batch", outcome: "ok" });
		const { app: app2, records: records2 } = await bind();
		const started = Date.now();
		await app2.turn("end_of_batch");
		expect(Date.now() - started).toBeGreaterThanOrEqual(40);
		expect(records2().find((r) => r.act === "turn")).toMatchObject({ outcome: "default", cause: "timeout" });
	});

	test("install and session wait for the harness to end them", async () => {
		const { app, binding } = await bind();
		const kinds: string[] = [];
		binding.on("touchpoint", (request) => {
			kinds.push(request.kind);
			setTimeout(() => binding.endTouchpoint(request.id), 5);
		});
		await app.install();
		await app.session();
		expect(kinds).toEqual(["install", "session"]);
	});
});

describe("capabilities through the binding", () => {
	test("immediate dispatch runs the handler now; every call is audited, reads included", async () => {
		const { binding, records } = await bind();
		await expect(binding.call("queue.size", {}, "look")).resolves.toEqual({ n: 3 });
		expect(records().filter((r) => r.act === "capability")).toMatchObject([
			{ name: "queue.size", outcome: "ok", reason: "look" },
		]);
	});

	test("safepoint dispatch runs the handler inside the program's safepoint, and times out without one", async () => {
		const { app, binding, records } = await bind();
		let ran = false;
		app.capability("job.retry", ({ job_id }) => {
			ran = true;
			return { ok: job_id === "j1" };
		});
		const call = binding.call("job.retry", { job_id: "j1" }, "retry it", "auto");
		await tick();
		expect(ran).toBe(false);
		app.safepoint();
		expect(ran).toBe(true); // the synchronous part ran before safepoint() returned
		await expect(call).resolves.toEqual({ ok: true });
		expect(records().find((r) => r.act === "capability")).toMatchObject({
			name: "job.retry",
			outcome: "ok",
			reason: "retry it",
			consent: "auto",
			params: { job_id: "j1" },
		});
		await expect(binding.call("job.retry", { job_id: "j2" }, "again", "auto")).rejects.toMatchObject({
			code: "timeout",
		});
		expect(
			records()
				.filter((r) => r.act === "capability")
				.at(-1),
		).toMatchObject({ outcome: "error", cause: "timeout" });
		expect(app.region.flags[FLAG_WORK]).toBe(0); // the timed-out work left the queue
	});

	test("a capability under confirm policy needs consent; a call during a turn runs at once", async () => {
		const { app, binding, records } = await bind();
		await expect(binding.call("job.retry", { job_id: "j1" }, "no consent")).rejects.toMatchObject({ code: "denied" });
		expect(records().at(-1)).toMatchObject({ act: "capability", outcome: "error", cause: "denied" });
		await expect(binding.call("job.retry", { job_id: "j1" }, "denied", "denied")).rejects.toMatchObject({
			code: "denied",
		});
		let inTurn: unknown;
		binding.on("turn", async (request) => {
			inTurn = await binding.call("job.retry", { job_id: "j1" }, "during the turn", "approved");
			binding.endTurn(request.id);
		});
		await app.turn("end_of_batch");
		expect(inTurn).toEqual({ ok: true });
		expect(records().find((r) => r.consent === "approved")).toMatchObject({ act: "capability", outcome: "ok" });
	});

	test("a declared parameter may be absent; a present one must match; an explicit null needs nullable", async () => {
		const { binding, app } = await bind();
		// the handler sees undefined for job_id and answers from it (job.retry runs at a safepoint)
		const absent = binding.call("job.retry", {}, "r", "auto");
		app.safepoint();
		await expect(absent).resolves.toEqual({ ok: false });
		await expect(binding.call("job.retry", { job_id: null }, "r", "auto")).rejects.toMatchObject({
			code: "invalid",
			message: "params.job_id must be a string",
		});
	});

	test("forbidden, unknown, invalid, failing and handler-less calls each fail with their code", async () => {
		const { binding, records } = await bind();
		await expect(binding.call("job.drop", {}, "r")).rejects.toMatchObject({ code: "forbidden" });
		await expect(binding.call("nope", {}, "r")).rejects.toMatchObject({ code: "unknown" });
		await expect(binding.call("job.retry", { job_id: 5 }, "r", "auto")).rejects.toMatchObject({ code: "invalid" });
		await expect(binding.call("job.retry", { job_id: "j1", extra: 1 }, "r", "auto")).rejects.toMatchObject({
			code: "invalid",
		});
		await expect(binding.call("job.boom", {}, "r", "auto")).rejects.toMatchObject({
			code: "error",
			message: "kaboom",
		});
		await expect(binding.call("job.silent", {}, "r", "auto")).rejects.toBeInstanceOf(CallError);
		const outcomes = records()
			.filter((r) => r.act === "capability")
			.map((r) => [r.name, r.outcome, r.cause]);
		expect(outcomes).toEqual([
			["job.drop", "forbidden", "forbidden"],
			["nope", "error", "unknown"],
			["job.retry", "error", "invalid"],
			["job.retry", "error", "invalid"],
			["job.boom", "error", "error"],
			["job.silent", "error", "error"],
		]);
	});
});

describe("cells, knobs and events through the binding", () => {
	test("readCells carries values and versions; a scalar knob write lands at once and is audited", async () => {
		const { app, binding, records } = await bind();
		app.cell("queue.depth").set(9);
		expect(binding.readCells(["queue.depth"]).cells["queue.depth"]).toEqual({ value: 9, version: 1 });
		expect(() => binding.readCells(["nope"])).toThrow(/unknown cell/);
		await expect(binding.writeKnob("worker.count", 8, "more workers")).resolves.toEqual({
			value: 8,
			outcome: "done",
		});
		expect(app.knob("worker.count").get()).toBe(8);
		await expect(binding.writeKnob("worker.count", 99, "too many")).resolves.toMatchObject({ outcome: "failed" });
		await expect(binding.writeKnob("queue.depth", 1, "not a knob")).resolves.toMatchObject({ outcome: "failed" });
		expect(
			records()
				.filter((r) => r.act === "knob")
				.map((r) => [r.outcome, r.value]),
		).toEqual([
			["ok", 8],
			["error", undefined],
			["error", undefined],
		]);
	});

	test("a sized knob is delivered at the next safepoint, to its handler, within its timeout", async () => {
		const { app, binding } = await bind();
		await expect(binding.writeKnob("label", "x", "no handler yet")).resolves.toMatchObject({
			outcome: "failed",
			error: /no handler/,
		});
		const seen: unknown[] = [];
		app.knob<string>("label").onChange((value) => {
			seen.push(value);
		});
		const write = binding.writeKnob("label", "a very long label", "rename");
		await tick();
		expect(seen).toEqual([]);
		app.safepoint();
		await expect(write).resolves.toEqual({ value: "a very l", outcome: "done" });
		expect(seen).toEqual(["a very l"]);
		expect(app.knob("label").get()).toBe("a very l");
		await expect(binding.writeKnob("label", "x", "no safepoint")).resolves.toMatchObject({ outcome: "failed" });
	});

	test("events reach the harness live, and the ring reports what it dropped", async () => {
		const { app, binding, events } = await bind();
		const failed = app.event("job.failed");
		failed.emit({ job_id: "j1" });
		expect(events).toEqual([
			{ seq: 1, name: "job.failed", payload: { job_id: "j1" }, truncated: false, ts: expect.any(Number) },
		]);
		for (let i = 2; i <= 300; i++) failed.emit({ job_id: `j${i}` });
		const batch = binding.readEvents(0);
		expect(batch.dropped).toBe(44);
		expect(batch.events.length).toBe(256);
		expect(batch.events[0].seq).toBe(45);
		expect(batch.next).toBe(300);
		expect(binding.readCells().seq).toBe(300);
	});

	test("auditTail reads the log back", async () => {
		const { app, binding } = await bind();
		await binding.writeKnob("worker.count", 2, "fewer");
		await app.decide("on_backlog");
		const tail = binding.auditTail(10);
		expect(tail.records.map((r) => (r as { act: string }).act)).toEqual(["knob", "decision"]);
	});
});
