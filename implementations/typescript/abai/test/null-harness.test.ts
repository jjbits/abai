import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createAbaigram } from "../src/program.ts";
import type { AbaigramOptions } from "../src/registry.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function options(): AbaigramOptions {
	return {
		name: "nulled",
		modes: ["turns"],
		cells: {
			"queue.depth": { type: "int", access: "read", doc: "Depth." },
			"worker.count": { type: "int", access: "readwrite", default: 4, range: [1, 64], doc: "Workers." },
		},
		events: { "job.failed": { payload: { job_id: "string" }, wakes: "always", doc: "Failed." } },
		capabilities: {
			"job.retry": {
				params: { job_id: "string" },
				result: { ok: "bool" },
				effect: "mutate",
				example: { job_id: "j1" },
				doc: "Retry.",
				handler: () => ({ ok: true }),
			},
			"job.drop": { params: {}, result: {}, effect: "mutate", policy: "forbid", doc: "Drop.", handler: () => ({}) },
			"job.peek": {
				params: {},
				result: {},
				effect: "read",
				dispatch: "immediate",
				doc: "No example.",
				handler: () => ({}),
			},
		},
		decisions: {
			on_backlog: { context: {}, options: ["scale_up", "wait"], default: "wait", timeout: "1s", doc: "Backlog." },
			on_idle: { context: {}, options: ["sleep"], default: "sleep", timeout: "1s", doc: "Idle." },
		},
		turns: { end_of_batch: { timeout: "1s", doc: "Batch." }, never: { timeout: "1s", doc: "Never reached." } },
	};
}

function make(form: "null" | "exercise") {
	const dir = mkdtempSync(`${tmpdir()}/abai-null-`);
	dirs.push(dir);
	const auditPath = join(dir, "audit.jsonl");
	const app = createAbaigram(options(), { env: { ABAI_HARNESS: form }, root: dir, auditPath });
	const records = () =>
		existsSync(auditPath)
			? readFileSync(auditPath, "utf8")
					.split("\n")
					.filter((l) => l !== "")
					.map((l) => JSON.parse(l) as Record<string, unknown>)
			: [];
	return { app, auditPath, records };
}

describe("the passive null harness (ABAI_HARNESS=null)", () => {
	test("attaches at startup, drains channels, answers defaults, touches no control", async () => {
		const { app, records } = make("null");
		expect(app.attached).toBe(true);
		const nullHarness = app.attachedNullHarness;
		expect(nullHarness?.form).toBe("null");
		app.event("job.failed").emit({ job_id: "j1" });
		await expect(app.decide("on_backlog")).resolves.toBe("wait");
		await app.turn("end_of_batch");
		await app.install();
		await app.session();
		expect(nullHarness?.report()).toEqual({
			form: "null",
			events: 1,
			dropped: 0,
			decisions: 1,
			turns: 1,
			touchpoints: 2,
			cellsWritten: [],
			eventsEmitted: ["job.failed"],
			knobsWritten: [],
			capabilitiesCalled: [],
			unexercised: [],
		});
		expect(app.knob("worker.count").get()).toBe(4);
		expect(records().map((r) => [r.act, r.outcome, r.cause])).toEqual([
			["decision", "default", "answered"],
			["turn", "ok", undefined],
		]);
		expect(records()[0]).toMatchObject({ reason: "null harness: the default" });
	});

	test("drains every emit as it happens, so nothing is dropped in-process", async () => {
		const { app } = make("null");
		const failed = app.event("job.failed");
		for (let i = 0; i < 300; i++) failed.emit({ job_id: `j${i}` });
		const report = app.attachedNullHarness?.report();
		expect(report?.events).toBe(300);
		expect(report?.dropped).toBe(0);
	});
});

describe("the active null harness (ABAI_HARNESS=exercise)", () => {
	test("writes each knob's default, calls each capability's example, and reports the rest", async () => {
		const { app, records } = make("exercise");
		const nullHarness = app.attachedNullHarness;
		expect(nullHarness?.form).toBe("exercise");
		// the program sets the knob before the exercise writes it: a program write, however the harness's lands after
		app.knob("worker.count").set(6);
		// the exercise's safepoint-dispatched call needs the program to reach a safepoint
		const pump = setInterval(() => app.safepoint(), 5);
		await nullHarness?.exercised;
		clearInterval(pump);
		await expect(app.decide("on_backlog")).resolves.toBe("wait");
		await app.turn("end_of_batch");
		const report = nullHarness?.report();
		expect(report?.knobsWritten).toEqual(["worker.count"]);
		// the program's write counts; the harness's own write of the same knob alone would not
		expect(report?.cellsWritten).toContain("worker.count");
		expect(report?.capabilitiesCalled).toEqual(["job.retry"]);
		expect(report?.unexercised).toEqual([
			{ kind: "capability", name: "job.drop", why: "policy forbids it" },
			{ kind: "capability", name: "job.peek", why: "no example declared" },
			{ kind: "decision", name: "on_idle", why: "not reached" },
			{ kind: "turn", name: "never", why: "not reached" },
		]);
		const acts = records().map((r) => [r.act, r.name, r.outcome, r.consent]);
		expect(acts).toEqual([
			["knob", "worker.count", "ok", "auto"],
			["capability", "job.retry", "ok", "auto"],
			["decision", "on_backlog", "default", undefined],
			["turn", "end_of_batch", "ok", undefined],
		]);
	});
});

describe("the counter example under a null harness", () => {
	const example = resolve(import.meta.dirname, "../examples/counter");

	function run(form: "null" | "exercise") {
		const copy = mkdtempSync(`${tmpdir()}/abai-counter-`);
		dirs.push(copy);
		cpSync(example, copy, { recursive: true });
		// the copy imports the stub by absolute path, so it runs from anywhere
		const program = join(copy, "counter.ts");
		const source = readFileSync(program, "utf8").replaceAll(
			"../../src/",
			`${resolve(import.meta.dirname, "../src")}/`,
		);
		writeFileSync(program, source);
		// five batches: the queue crosses the high-water mark in the fifth, so the decision is reached
		const result = spawnSync(process.execPath, [program, "5"], {
			cwd: copy,
			env: { ...process.env, ABAI_MODE: "", ABAI_HARNESS: form },
			encoding: "utf8",
			timeout: 20_000,
		});
		if (result.status !== 0) throw new Error(`counter exited ${result.status}: ${result.stderr}`);
		const audit = readFileSync(join(copy, "abai-audit.log"), "utf8")
			.split("\n")
			.filter((l) => l !== "")
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		return { code: result.status, out: result.stdout, err: result.stderr, audit };
	}

	test("passive: the program runs, every decision defaults, the log shows it", () => {
		const { code, out, err, audit } = run("null");
		expect(code).toBe(0);
		expect(out).toMatch(/^counter: 5 batches/);
		expect(err).toBe("");
		expect(audit.map((r) => [r.act, r.name])).toEqual([
			["turn", "end_of_batch"],
			["turn", "end_of_batch"],
			["turn", "end_of_batch"],
			["turn", "end_of_batch"],
			["decision", "on_backlog"],
			["turn", "end_of_batch"],
		]);
	});

	test("exercise: knobs and capabilities are driven, and the report lands on stderr at exit", () => {
		const { code, err, audit } = run("exercise");
		expect(code).toBe(0);
		const report = JSON.parse(err.trim().split("\n").at(-1) as string);
		expect(report).toMatchObject({
			form: "exercise",
			// the counter writes queue.depth; worker.count moved only by the harness's write, so it is not the program's
			cellsWritten: ["queue.depth"],
			eventsEmitted: ["job.failed"],
			knobsWritten: ["worker.count"],
			capabilitiesCalled: ["job.retry"],
			unexercised: [],
		});
		expect(report.events).toBe(1);
		// the exercise starts at the program's first activity, its first turn, so that turn is logged first
		expect(audit[0]).toMatchObject({ act: "turn", name: "end_of_batch", outcome: "ok" });
		expect(audit.find((r) => r.act === "knob")).toMatchObject({
			name: "worker.count",
			outcome: "ok",
			value: 4,
			consent: "auto",
		});
		// the call is safepoint-dispatched: it lands at the first batch's safepoint, after that batch's turn is logged
		expect(audit.find((r) => r.act === "capability")).toMatchObject({
			act: "capability",
			name: "job.retry",
			outcome: "ok",
			params: { job_id: "job-0001" },
		});
	});
});
