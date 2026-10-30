// A program in another process for sidecar.test.ts: the stub under
// ABAI_MODE=sidecar, driven by one-word commands on stdin, reporting on
// stdout. The stub is imported from source so no build is needed.
import { createInterface } from "node:readline";
import { createAbaigram } from "../../../abai-stub/src/index.ts";

const app = createAbaigram(
	{
		name: "sidey",
		modes: ["sidecar", "turns"],
		cells: {
			"queue.depth": { type: "int", access: "read", doc: "Jobs waiting." },
			"worker.count": { type: "int", access: "readwrite", default: 4, range: [1, 64], doc: "Workers." },
		},
		events: {
			"job.failed": { payload: { job_id: { type: "string", max: 8 } }, wakes: "always", doc: "A job failed." },
		},
		capabilities: {
			"job.retry": {
				params: { job_id: "string" },
				result: { ok: "bool" },
				effect: "mutate",
				dispatch: "immediate",
				doc: "Requeue a failed job once.",
				handler: () => ({ ok: true }),
			},
		},
		decisions: {
			on_backlog: {
				context: { depth: "int", workers: "int" },
				options: ["scale_up", "shed_oldest", "wait"],
				default: "wait",
				timeout: "10s",
				doc: "Asked when the queue depth crosses the high-water mark.",
			},
		},
		turns: { end_of_batch: { timeout: "10s", doc: "After each batch." } },
	},
	{ root: `${import.meta.dirname}/sidecar-root`, auditPath: process.env.SIDECAR_AUDIT as string },
);
const endpoint = app.endpoint;
if (!endpoint) throw new Error("no endpoint: is ABAI_MODE sidecar?");
await endpoint.ready;
console.log(`ready ${endpoint.socketPath}`);

const depth = app.cell<number>("queue.depth");
const workers = app.knob<number>("worker.count");
const failed = app.event("job.failed");
depth.set(0);
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
	const [verb, arg] = line.trim().split(/\s+/);
	switch (verb) {
		case "attached":
			console.log(`attached ${app.attached}`);
			break;
		case "emit":
			failed.emit({ job_id: arg ?? "j1" });
			break;
		case "decide": {
			const choice = await app.decide<string>("on_backlog", { depth: 20, workers: workers.get() });
			console.log(`decided ${choice}`);
			break;
		}
		case "turn":
			await app.turn("end_of_batch");
			console.log("turned");
			break;
		case "session":
			await app.session();
			console.log(`session ended attached=${app.attached}`);
			break;
		case "exit":
			process.exit(0);
			break;
		default:
			console.log(`unknown ${verb}`);
	}
}
