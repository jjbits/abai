// The cost model (abaigrammar section 11.1, measured per section 11.6): every
// detached row, timed and with its heap allocation per operation. The scalar
// rows must not allocate at all: no collector may run during their loop and
// the heap may not grow beyond the measurement's own noise. The sized rows
// allocate by nature (a declared deviation) and are reported.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { describe, expect, test } from "vitest";
import { createAbaigram } from "../src/program.ts";

/** Few enough iterations that a row allocating even a few bytes each stays under one young-generation cycle. */
const ITERATIONS = 200_000;
/** Heap growth allowed over a whole run of a non-allocating row, in bytes: the measurement's own objects. */
const DRIFT_ALLOWANCE = 64 * 1024;

function gc(): void {
	const collect = (globalThis as { gc?: () => void }).gc;
	if (!collect) throw new Error("run with --expose-gc (vitest.config.ts sets it)");
	collect();
}

interface Row {
	name: string;
	nsPerOp: number;
	bytesPerOp: number;
	collections: number;
	allocates: "no" | "yes";
}

/**
 * Time one row and measure what it allocates: the heap is collected before
 * the loop and read right after it, with no collection in between, while a
 * performance observer counts any collection the loop itself triggered.
 */
async function measure(name: string, op: () => void, expectNoAlloc: boolean): Promise<Row> {
	for (let i = 0; i < 10_000; i++) op(); // warm the JIT before measuring
	gc();
	let collections = 0;
	const observer = new PerformanceObserver((list) => {
		collections += list.getEntries().length;
	});
	observer.observe({ entryTypes: ["gc"] });
	const heapBefore = process.memoryUsage().heapUsed;
	const started = performance.now();
	for (let i = 0; i < ITERATIONS; i++) op();
	const elapsed = performance.now() - started;
	const heapAfter = process.memoryUsage().heapUsed;
	await new Promise<void>((done) => setImmediate(done)); // the observer delivers its entries asynchronously
	observer.disconnect();
	const grown = heapAfter - heapBefore;
	if (expectNoAlloc) {
		expect(collections, `${name}: a collection ran during the loop`).toBe(0);
		expect(grown, `${name}: the heap grew by ${grown} bytes`).toBeLessThanOrEqual(DRIFT_ALLOWANCE);
	}
	return {
		name,
		nsPerOp: (elapsed * 1e6) / ITERATIONS,
		bytesPerOp: Math.max(0, grown) / ITERATIONS,
		collections,
		allocates: expectNoAlloc ? "no" : "yes",
	};
}

describe("section 11.1: cost with no harness attached", () => {
	test("every row, measured", async () => {
		const app = createAbaigram(
			{
				name: "cost",
				modes: ["turns"],
				cells: {
					"queue.depth": { type: "int", access: "read", doc: "Depth." },
					busy: { type: "bool", access: "read", doc: "Busy." },
					speed: { type: "enum", enum: ["slow", "fast"], access: "read", doc: "Speed." },
					"worker.count": { type: "int", access: "readwrite", default: 4, doc: "Workers." },
					"last.error": { type: "string", max: 64, access: "read", doc: "Error." },
					stats: { type: "object", max: 256, access: "read", doc: "Stats." },
				},
				events: { tick: { payload: { n: "int" }, doc: "Tick." } },
				decisions: { go: { context: {}, options: ["yes"], default: "yes", timeout: "1s", doc: "Go." } },
				turns: { t: { timeout: "1s", doc: "T." } },
			},
			{ env: {} },
		);
		const depth = app.cell<number>("queue.depth");
		const busy = app.cell<boolean>("busy");
		const speed = app.cell<string>("speed");
		const workers = app.knob<number>("worker.count");
		const lastError = app.cell<string>("last.error");
		const stats = app.cell<object>("stats");
		const tick = app.event("tick");
		const tickPayload = { n: 1 }; // the row measures the stub, not the caller's payload literal
		let sink = 0;
		const rows: Row[] = [
			await measure("write an int cell", () => depth.set(sink++), true),
			await measure("write a bool cell", () => busy.set((sink++ & 1) === 0), true),
			await measure("write an enum cell", () => speed.set(sink++ & 1 ? "fast" : "slow"), true),
			await measure(
				"read a scalar knob",
				() => {
					sink += workers.get();
				},
				true,
			),
			await measure("emit an event (detached)", () => tick.emit(tickPayload), true),
			await measure("safepoint()", () => app.safepoint(), true),
			await measure("write a string cell", () => lastError.set("error text"), false),
			await measure("write an object cell", () => stats.set({ n: 1, ok: true }), false),
		];
		// decide and turn return promises, which allocate by nature; their time is reported, not their bytes
		const decideStarted = performance.now();
		for (let i = 0; i < 100_000; i++) await app.decide("go");
		rows.push({
			name: "decide (detached, awaited)",
			nsPerOp: ((performance.now() - decideStarted) * 1e6) / 100_000,
			bytesPerOp: Number.NaN,
			collections: 0,
			allocates: "yes",
		});
		const turnStarted = performance.now();
		for (let i = 0; i < 100_000; i++) await app.turn("t");
		rows.push({
			name: "turn (detached, awaited)",
			nsPerOp: ((performance.now() - turnStarted) * 1e6) / 100_000,
			bytesPerOp: Number.NaN,
			collections: 0,
			allocates: "yes",
		});
		expect(sink).toBeGreaterThan(0);
		expect(app.counters()["decision:go"]).toBe(100_000);

		// the gate run is the measurement: the table lands in the workspace's design dir (section 11.6)
		const lines = rows.map(
			(r) =>
				`| ${r.name} | ${r.nsPerOp.toFixed(1)} | ${Number.isNaN(r.bytesPerOp) ? "n/a" : r.bytesPerOp.toFixed(1)} | ${r.collections} | ${r.allocates} |`,
		);
		const report = [
			"# Section 11.1 cost, measured",
			"",
			`Written by \`abai/test/cost.test.ts\` on ${new Date().toISOString()} (Node ${process.version}, ${process.arch}, ${ITERATIONS} iterations per row).`,
			"Bytes are heap growth over the loop with no collection in between; the scalar rows are asserted to allocate nothing and to trigger no collection. The sized rows allocate (a declared deviation); a collection during their loop makes their bytes an underestimate.",
			"",
			"| Row | ns/op | B/op | collections | allocates |",
			"|---|---|---|---|---|",
			...lines,
			"",
		].join("\n");
		const out = resolve(import.meta.dirname, "../../.design/cost-11.1.md");
		mkdirSync(resolve(out, ".."), { recursive: true });
		writeFileSync(out, report);
	});
});
