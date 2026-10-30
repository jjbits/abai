// Manifests for the tests: a small counter program that declares every
// channel, and the smallest manifest that validates.
import type { Manifest } from "../../src/manifest/manifest.ts";

export const FIXTURE_MANIFEST: Manifest = {
	abaigrammar: "0.1",
	name: "counter",
	entry: "counter abai",
	modes: ["turns", "sidecar"],
	content: { identity: "abai/identity.md" },
	audit: { path: "./abai-audit.log" },
	cells: [
		{
			name: "queue.depth",
			type: "int",
			access: "read",
			doc: "Number of jobs waiting. Rises when producers outpace workers.",
		},
		{
			name: "worker.count",
			type: "int",
			access: "readwrite",
			default: 4,
			range: [1, 64],
			cadence: 1000,
			policy: "auto",
			doc: "Active worker threads. The pool resizes within a second of a change.",
		},
	],
	events: [
		{
			name: "job.failed",
			payload: { job_id: { type: "string", max: 64 }, error: { type: "string", max: 512 } },
			wakes: "always",
			doc: "A job exhausted its retries.",
		},
	],
	capabilities: [
		{
			name: "job.retry",
			params: { job_id: "string" },
			result: { ok: "bool" },
			effect: "mutate",
			dispatch: "safepoint",
			timeout: "5s",
			policy: "confirm",
			example: { job_id: "job-0001" },
			doc: "Requeue a failed job once.",
		},
	],
	decisions: [
		{
			name: "on_backlog",
			context: { depth: "int", workers: "int" },
			options: ["scale_up", "shed_oldest", "wait"],
			default: "wait",
			timeout: "5s",
			policy: "auto",
			doc: "Asked when the queue depth crosses the high-water mark.",
		},
	],
	turns: [
		{ name: "end_of_batch", timeout: "30s", doc: "After each batch completes. The agent may tune worker.count." },
	],
};

export const MINIMAL_MANIFEST: Manifest = {
	abaigrammar: "0.1",
	name: "minimal",
	entry: "minimal abai",
	modes: ["turns"],
	content: { identity: "abai/identity.md" },
	audit: { path: "./abai-audit.log" },
	cells: [],
	events: [],
	capabilities: [],
	decisions: [],
	turns: [],
};
