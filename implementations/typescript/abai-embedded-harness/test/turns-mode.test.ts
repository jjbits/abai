// Turns mode end to end (abaigrammar section 6.1): the program includes the
// stub, the harness attaches in-process through the direct transport, and
// its agent is an @arx-06/agent Agent with a faux-scripted model. Every act
// crosses the real channels and lands in the audit log.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, TranscriptContext } from "@arx-06/ai";
import { createModels, type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@arx-06/ai";
import { type AbaigramOptions, createAbaigram } from "abai";
import { afterEach, describe, expect, test } from "vitest";
import { SessionForm } from "../src/agent.ts";
import { Harness } from "../src/harness.ts";
import { defaultOptions, type HarnessOptions } from "../src/options.ts";
import { DirectTransport } from "../src/transport-direct.ts";
import { type ScriptedChannel, scriptedChannel, type UserChannel } from "../src/user-channel.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function declarations(): AbaigramOptions {
	return {
		name: "turnsy",
		modes: ["turns"],
		cells: {
			"queue.depth": { type: "int", access: "read", doc: "Jobs waiting." },
			"worker.count": { type: "int", access: "readwrite", default: 4, range: [1, 64], doc: "Workers." },
		},
		events: { "job.failed": { payload: { job_id: "string" }, wakes: "always", doc: "A job failed." } },
		capabilities: {
			"job.retry": {
				params: { job_id: "string" },
				result: { ok: "bool" },
				effect: "mutate",
				doc: "Requeue a failed job once.",
				handler: ({ job_id }) => ({ ok: job_id === "j1" }),
			},
		},
		decisions: {
			on_backlog: {
				context: { depth: "int", workers: "int" },
				options: ["scale_up", "shed_oldest", "wait"],
				default: "wait",
				timeout: "30s",
				doc: "Asked when the queue depth crosses the high-water mark.",
			},
		},
		turns: { end_of_batch: { timeout: "30s", doc: "After each batch." } },
	};
}

/** The text of the last user message the model saw: the wake, or the person's line. */
function lastUserText(context: TranscriptContext): string {
	const last = [...context.messages].reverse().find((m) => m.role === "user");
	if (!last || last.role !== "user") return "";
	return typeof last.content === "string"
		? last.content
		: last.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

const toolUse = (name: string, args: JsonObject) =>
	fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

interface World {
	app: ReturnType<typeof createAbaigram>;
	harness: Harness;
	form: SessionForm;
	channel: ScriptedChannel | undefined;
	setResponses: (steps: FauxResponseStep[]) => void;
	records: () => Array<Record<string, unknown>>;
}

async function world(
	options: Partial<HarnessOptions> = {},
	inputs?: string[],
	consent = true,
	connectTimeoutMs?: number,
	ownChannel?: UserChannel,
): Promise<World> {
	const root = mkdtempSync(`${tmpdir()}/abai-turns-`);
	dirs.push(root);
	mkdirSync(join(root, "abai"));
	writeFileSync(
		join(root, "abai/identity.md"),
		"You are the agent fused into turnsy, a job queue. Keep the backlog low.\n",
	);
	writeFileSync(join(root, "abai/install.md"), "Check the worker count once.\n");
	const auditPath = join(root, "audit.jsonl");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const scripted = inputs === undefined ? undefined : scriptedChannel(inputs, () => consent);
	const channel = ownChannel ?? scripted;
	let harness: Harness | undefined;
	let form: SessionForm | undefined;
	const app = createAbaigram(declarations(), {
		env: {},
		root,
		auditPath,
		harness: async (binding) => {
			harness = new Harness(defaultOptions("session", { auto: true, ...options }));
			await harness.attach(new DirectTransport(binding));
			form = new SessionForm({
				harness,
				model: { model: faux.getModel(), streamFn: (m, c, o) => models.streamSimple(m, c, o) },
				channel,
				connectTimeoutMs,
			});
		},
	});
	expect(await app.attach()).toBe(true);
	if (!harness || !form) throw new Error("the factory did not run");
	return {
		app,
		harness,
		form,
		channel: scripted,
		setResponses: (steps) => faux.setResponses(steps),
		records: () =>
			existsSync(auditPath)
				? readFileSync(auditPath, "utf8")
						.split("\n")
						.filter((l) => l !== "")
						.map((l) => JSON.parse(l) as Record<string, unknown>)
				: [],
	};
}

describe("turns mode with a faux model", () => {
	test("the attached harness composed its prompt from the manifest, byte-stable", async () => {
		const { harness, form } = await world();
		expect(harness.attached).toBe(true);
		expect(harness.currentClaims()).toEqual(["on_backlog"]);
		const prompt = harness.systemPrompt();
		expect(prompt).toBe(harness.systemPrompt());
		expect(prompt).toContain("turnsy");
		expect(prompt).toContain("job.retry");
		expect(prompt).toContain("on_backlog");
		expect(form.agent.state.systemPrompt).toBe(prompt);
		form.shutdown("test over");
	});

	test("a decision is answered through abai_decide with a reason", async () => {
		const { app, form, setResponses, records } = await world();
		setResponses([
			(context) => {
				const id = /decision (d\d+) on_backlog/.exec(lastUserText(context))?.[1];
				if (!id) throw new Error(`no decision in the wake: ${lastUserText(context)}`);
				return toolUse("abai_decide", { id, answer: "scale_up", reason: "the backlog is growing" });
			},
			fauxAssistantMessage("scaled up"),
		]);
		await expect(app.decide<string>("on_backlog", { depth: 20, workers: 4 })).resolves.toBe("scale_up");
		expect(records().find((r) => r.act === "decision")).toMatchObject({
			name: "on_backlog",
			outcome: "agent",
			reason: "the backlog is growing",
			value: { option: "scale_up" },
		});
		form.shutdown("test over");
	});

	test("a decision the run leaves unanswered takes its default, with the reason recorded", async () => {
		const { app, form, setResponses, records } = await world();
		setResponses([fauxAssistantMessage("nothing to do")]);
		await expect(app.decide<string>("on_backlog", { depth: 20, workers: 4 })).resolves.toBe("wait");
		expect(records().find((r) => r.act === "decision")).toMatchObject({
			outcome: "default",
			cause: "answered",
			reason: "the agent's turn ended without deciding",
		});
		form.shutdown("test over");
	});

	test("a turn: the agent reads cells, writes a knob, calls a capability during the turn, and the turn ends", async () => {
		const { app, form, setResponses, records } = await world();
		app.cell<number>("queue.depth").set(12);
		let cellsSeen = "";
		setResponses([
			toolUse("abai_cells", {}),
			(context) => {
				const result = [...context.messages].reverse().find((m) => m.role === "toolResult");
				cellsSeen = result && result.role === "toolResult" ? JSON.stringify(result.content) : "";
				return toolUse("abai_set", { cell: "worker.count", value: 8, reason: "more workers for the backlog" });
			},
			toolUse("abai_call", { capability: "job.retry", params: { job_id: "j1" }, reason: "retry the failed one" }),
			fauxAssistantMessage("tuned"),
		]);
		await app.turn("end_of_batch");
		expect(cellsSeen).toContain("12"); // queue.depth reached the model through abai_cells
		expect(app.knob<number>("worker.count").get()).toBe(8);
		const acts = records().map((r) => [r.act, r.name, r.outcome, r.consent]);
		expect(acts).toEqual([
			["knob", "worker.count", "ok", undefined],
			["capability", "job.retry", "ok", "auto"],
			["turn", "end_of_batch", "ok", undefined],
		]);
		expect(form.lastText()).toBe("tuned");
		form.shutdown("test over");
	});

	test("in turns mode an event outside a touchpoint waits, and arrives in the next turn's wake", async () => {
		const { app, form, setResponses, harness } = await world();
		let wake = "";
		setResponses([
			(context) => {
				wake = lastUserText(context);
				return fauxAssistantMessage("noted");
			},
		]);
		app.event("job.failed").emit({ job_id: "j7" });
		await new Promise((done) => setImmediate(done));
		expect(form.agent.state.messages.filter((m) => m.role === "user")).toEqual([]); // nothing ran outside a touchpoint
		await app.turn("end_of_batch");
		expect(wake).toContain("job.failed job_id=j7");
		expect(wake).toContain("turn t1 end_of_batch");
		expect(harness.ring.size).toBeGreaterThan(0);
		form.shutdown("test over");
	});

	test("a wake during a run is not injected into it: it is delivered in the run after, each run settling only its own", async () => {
		const { app, form, setResponses, records } = await world();
		let deciding: Promise<string> | undefined;
		let secondCall = "";
		let decisionWake = "";
		app.capability("job.retry", () => {
			// the program asks a decision while the agent's turn is running: it waits for the run to end
			deciding = app.decide<string>("on_backlog", { depth: 30, workers: 4 });
			return { ok: true };
		});
		setResponses([
			toolUse("abai_call", { capability: "job.retry", params: { job_id: "j1" }, reason: "retry" }),
			(context) => {
				secondCall = lastUserText(context);
				return fauxAssistantMessage("retried");
			},
			(context) => {
				decisionWake = lastUserText(context);
				const id = /decision (d\d+) on_backlog/.exec(decisionWake)?.[1];
				if (!id) return fauxAssistantMessage("no decision seen");
				return toolUse("abai_decide", { id, answer: "shed_oldest", reason: "too deep" });
			},
			fauxAssistantMessage("decided"),
		]);
		await app.turn("end_of_batch");
		// the turn's run saw only its own wake; the decision came in a run of its own, right after it
		expect(secondCall).not.toContain("decision d");
		expect(await deciding).toBe("shed_oldest");
		expect(decisionWake).toContain("decision d");
		expect(records().map((r) => [r.act, r.outcome])).toEqual([
			["capability", "ok"],
			["turn", "ok"],
			["decision", "agent"],
		]);
		form.shutdown("test over");
	});

	test("install delivers its content and ends when the run ends; a session takes the person's lines", async () => {
		const { app, form, channel, setResponses } = await world({}, ["how deep is the queue?"]);
		let installWake = "";
		setResponses([
			(context) => {
				installWake = lastUserText(context);
				return fauxAssistantMessage("checked the workers");
			},
			fauxAssistantMessage("the queue is empty"),
		]);
		await app.install();
		expect(installWake).toContain("Check the worker count once.");
		await app.session();
		expect(channel?.asked.length).toBe(2); // the line, then the end
		expect(channel?.said).toContain("checked the workers");
		expect(channel?.said).toContain("the queue is empty");
		form.shutdown("test over");
	});

	test("a session touchpoint arriving while the person is already conversing is ended at once", async () => {
		// a channel whose next line arrives only when the test says so, holding the person's loop open
		let answer: ((line: string | undefined) => void) | undefined;
		const channel: UserChannel = {
			say: () => {},
			ask: () =>
				new Promise((resolve) => {
					answer = resolve;
				}),
			confirm: async () => true,
			close: () => {},
		};
		const { app, form } = await world({}, undefined, true, undefined, channel);
		const conversing = form.converse();
		await new Promise((r) => setImmediate(r));
		expect(answer).toBeDefined();
		// the program opens its session touchpoint: the person is already talking, so it is returned at once
		const started = Date.now();
		await app.session();
		expect(Date.now() - started).toBeLessThan(500);
		expect(form.harness.pendingTouchpointList()).toEqual([]);
		// the conversation was not disturbed: it is still waiting on the person
		answer?.(undefined);
		await conversing;
		form.shutdown("test over");
	});

	test("without auto, a mutate call asks the person; a denial is stated to the program and audited", async () => {
		const { app, form, channel, setResponses, records } = await world({ auto: false }, [], false);
		setResponses([
			toolUse("abai_call", { capability: "job.retry", params: { job_id: "j1" }, reason: "retry" }),
			fauxAssistantMessage("it was not allowed"),
		]);
		await app.turn("end_of_batch");
		expect(channel?.confirmations).toEqual([
			{ title: "abai: job.retry", message: expect.stringContaining("Reason: retry") },
		]);
		expect(records().filter((r) => r.act === "capability")).toMatchObject([
			{ name: "job.retry", outcome: "error", cause: "denied", consent: "denied" },
		]);
		expect(form.lastText()).toBe("it was not allowed");
		form.shutdown("test over");
	});

	test("a model that never answers: the connect timeout detaches the harness and the program keeps going", async () => {
		const { app, form, setResponses, records } = await world({}, undefined, true, 150);
		setResponses([() => new Promise(() => {})]); // the first contact never comes back
		const started = Date.now();
		await expect(app.decide<string>("on_backlog", { depth: 20, workers: 4 })).resolves.toBe("wait");
		expect(Date.now() - started).toBeLessThan(5000);
		expect(app.attached).toBe(false);
		expect(app.attachError).toMatch(/did not answer within 150 ms/);
		expect(form.modelFailure).toMatch(/did not answer within 150 ms/);
		expect(records().find((r) => r.act === "decision")).toMatchObject({ outcome: "default", cause: "detached" });
		await app.turn("end_of_batch"); // returns at once now: counted, not asked
		expect(app.counters()["turn:end_of_batch"]).toBe(1);
		form.shutdown("test over");
	});

	test("a model that refuses the connection: the first failed request detaches at once", async () => {
		const { app, form, setResponses, records } = await world({}, undefined, true, 10_000);
		setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "connect ECONNREFUSED 127.0.0.1:1" }),
		]);
		const started = Date.now();
		await expect(app.decide<string>("on_backlog", { depth: 20, workers: 4 })).resolves.toBe("wait");
		expect(Date.now() - started).toBeLessThan(5000); // long before the 10 s connect timeout
		expect(app.attached).toBe(false);
		expect(app.attachError).toMatch(/could not be reached: connect ECONNREFUSED/);
		expect(records().find((r) => r.act === "decision")).toMatchObject({ outcome: "default", cause: "detached" });
		form.shutdown("test over");
	});
});
