// counter: the smallest abaigram. A job queue runs a few batches; the agent
// may watch the depth, tune the worker count, retry failed jobs, and is
// asked which way to go when the backlog crosses the high-water mark.
//
//   node examples/counter/counter.ts              run the program
//   node examples/counter/counter.ts abai manifest
//   node examples/counter/counter.ts abai doctor
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAbaigram } from "../../src/index.ts";

const app = createAbaigram(
	{
		name: "counter",
		// a runnable entry: abaikit check and run reach the program through it, in this directory
		entry: "node counter.ts abai",
		modes: ["turns", "sidecar"],
		audit: { path: "./abai-audit.log" },
		// five batches cross the high-water mark, so the exercise run reaches the decision (level 4)
		check: { run: "node counter.ts 5" },
		cells: {
			"queue.depth": {
				type: "int",
				access: "read",
				doc: "Number of jobs waiting. Rises when producers outpace workers.",
			},
			"worker.count": {
				type: "int",
				access: "readwrite",
				default: 4,
				range: [1, 64],
				cadence: 1000,
				doc: "Active worker threads. The pool resizes within a batch of a change.",
			},
		},
		events: {
			"job.failed": {
				payload: { job_id: { type: "string", max: 64 }, error: { type: "string", max: 512 } },
				wakes: "always",
				doc: "A job exhausted its retries.",
			},
		},
		capabilities: {
			"job.retry": {
				params: { job_id: "string" },
				result: { ok: "bool" },
				effect: "mutate",
				example: { job_id: "job-0001" },
				doc: "Requeue a failed job once.",
				handler: ({ job_id }) => ({ ok: typeof job_id === "string" }),
			},
		},
		decisions: {
			on_backlog: {
				context: { depth: "int", workers: "int" },
				options: ["scale_up", "shed_oldest", "wait"],
				default: "wait",
				timeout: "5s",
				doc: "Asked when the queue depth crosses the high-water mark.",
			},
		},
		turns: {
			end_of_batch: { timeout: "30s", doc: "After each batch completes. The agent may tune worker.count." },
		},
	},
	{ root: dirname(fileURLToPath(import.meta.url)) },
);

const args = process.argv.slice(2);
const { runEntry } = await import("../../src/entry.ts");
const code = await runEntry(app, args);
if (code >= 0) process.exit(code);

const depth = app.cell<number>("queue.depth");
const workers = app.knob<number>("worker.count");
const failed = app.event("job.failed");
const batches = Number(args[0] ?? 3);
let queued = 0;
for (let batch = 1; batch <= batches; batch++) {
	queued += 10;
	depth.set(queued);
	if (batch === 2) failed.emit({ job_id: `job-${batch}`, error: "simulated failure" });
	if (queued > 16) {
		const choice = await app.decide<string>("on_backlog", { depth: queued, workers: workers.get() });
		if (choice === "scale_up") workers.set(Math.min(64, workers.get() * 2));
		if (choice === "shed_oldest") queued = Math.max(0, queued - 10);
	}
	queued = Math.max(0, queued - workers.get() * 2);
	depth.set(queued);
	app.safepoint();
	await app.turn("end_of_batch");
}
console.log(
	`counter: ${batches} batches, ${queued} jobs left, ${workers.get()} workers, counters ${JSON.stringify(app.counters())}`,
);
