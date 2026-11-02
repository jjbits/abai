// Thread mode end to end (abaigrammar section 6.2): the program includes the
// stub, the harness attaches in-process through the direct transport and
// runs live on the program's event loop, with no touchpoint gating the
// agent. The program's own loop keeps ticking while the agent runs; a
// safepoint-dispatched call waits for the program's safepoint() and times
// out without one; an immediate call runs at once; a watch fires between
// touchpoints; a fault in the harness stays with the harness. The faux
// model is scripted as in turns-mode.test.ts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AbaigramOptions, createAbaigram, type HarnessBinding, THREAD_DEVIATION } from "@abaigram/abai-stub";
import type { JsonObject, TranscriptContext } from "@arx-06/ai";
import { createModels, type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@arx-06/ai";
import { afterEach, describe, expect, test } from "vitest";
import { SessionForm } from "../src/agent.ts";
import { Harness } from "../src/harness.ts";
import { defaultOptions, type HarnessOptions } from "../src/options.ts";
import { DirectTransport } from "../src/transport-direct.ts";
import type { UserChannel } from "../src/user-channel.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function declarations(modes: AbaigramOptions["modes"]): AbaigramOptions {
	return {
		name: "thready",
		modes,
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
				timeout: "300ms",
				doc: "Requeue a failed job once; runs at the program's next safepoint.",
				handler: ({ job_id }) => ({ ok: job_id === "j1" }),
			},
			"queue.size": {
				params: {},
				result: { n: "int" },
				effect: "read",
				dispatch: "immediate",
				doc: "The depth, read at once.",
				handler: () => ({ n: 3 }),
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

/** The last tool result the model saw, as text. */
function lastToolResult(context: TranscriptContext): string {
	const result = [...context.messages].reverse().find((m) => m.role === "toolResult");
	return result && result.role === "toolResult" ? JSON.stringify(result.content) : "";
}

const toolUse = (name: string, args: JsonObject) =>
	fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const settle = (): Promise<void> => new Promise((done) => setImmediate(done));

interface World {
	app: ReturnType<typeof createAbaigram>;
	harness: Harness;
	form: SessionForm;
	binding: HarnessBinding;
	setResponses: (steps: FauxResponseStep[]) => void;
	records: () => Array<Record<string, unknown>>;
}

interface WorldOptions {
	modes?: AbaigramOptions["modes"];
	env?: NodeJS.ProcessEnv;
	harness?: Partial<HarnessOptions>;
	channel?: UserChannel;
}

async function world(options: WorldOptions = {}): Promise<World> {
	const root = mkdtempSync(`${tmpdir()}/abai-thread-`);
	dirs.push(root);
	mkdirSync(join(root, "abai"));
	writeFileSync(
		join(root, "abai/identity.md"),
		"You are the agent fused into thready, a job queue. Keep the backlog low.\n",
	);
	const auditPath = join(root, "audit.jsonl");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let harness: Harness | undefined;
	let form: SessionForm | undefined;
	let binding: HarnessBinding | undefined;
	const app = createAbaigram(declarations(options.modes ?? ["thread", "turns"]), {
		env: options.env ?? {},
		root,
		auditPath,
		harness: async (b) => {
			binding = b;
			harness = new Harness(defaultOptions("session", { auto: true, ...options.harness }));
			await harness.attach(new DirectTransport(b));
			form = new SessionForm({
				harness,
				model: { model: faux.getModel(), streamFn: (m, c, o) => models.streamSimple(m, c, o) },
				channel: options.channel,
			});
		},
	});
	expect(await app.attach()).toBe(true);
	if (!harness || !form || !binding) throw new Error("the factory did not run");
	return {
		app,
		harness,
		form,
		binding,
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

describe("thread mode with a faux model", () => {
	test("the harness is live: the selected mode is thread, the form is live, the prompt says so", async () => {
		const { app, harness, form } = await world();
		expect(app.mode).toBe("thread");
		expect(harness.mode).toBe("thread");
		expect(harness.hello?.mode).toBe("thread");
		expect(harness.status().program?.mode).toBe("thread");
		expect(form.mode).toBe("live");
		const prompt = harness.systemPrompt();
		expect(prompt).toContain("You are attached to the running program thready, in thread mode.");
		expect(prompt).toContain("(abaigrammar 0.1, mode thread)");
		expect(prompt).toContain("A watch (abai_watch) wakes you");
		expect(app.manifest.deviations).toContain(THREAD_DEVIATION);
		expect(prompt).toContain(THREAD_DEVIATION);
		form.shutdown("test over");
	});

	test("an always-wake event outside any touchpoint starts a run at once, while the program's loop keeps ticking", async () => {
		const { app, form, setResponses } = await world();
		let ticks = 0;
		const loop = setInterval(() => {
			ticks += 1;
			app.cell<number>("queue.depth").set(ticks);
		}, 2);
		let wake = "";
		let ticksAtWake = 0;
		const answered = new Promise<void>((resolve) => {
			setResponses([
				async (context) => {
					wake = lastUserText(context);
					ticksAtWake = ticks;
					// the model takes its time; the program's interval runs on meanwhile
					await new Promise((r) => setTimeout(r, 40));
					resolve();
					return fauxAssistantMessage("noted");
				},
			]);
		});
		try {
			app.event("job.failed").emit({ job_id: "j7" });
			await answered;
			await form.agent.waitForIdle();
		} finally {
			clearInterval(loop);
		}
		expect(wake).toContain("job.failed job_id=j7");
		expect(wake).not.toContain("turn t"); // no touchpoint was needed
		expect(ticks).toBeGreaterThan(ticksAtWake);
		expect(form.lastText()).toBe("noted");
		form.shutdown("test over");
	});

	test("a watch set by the agent fires between touchpoints and wakes it", async () => {
		const { app, form, harness, setResponses } = await world();
		let wake = "";
		const woke = new Promise<void>((resolve) => {
			setResponses([
				toolUse("abai_watch", { cell: "queue.depth", op: "gt", value: 10, cadence_ms: 100 }),
				fauxAssistantMessage("watching"),
				(context) => {
					wake = lastUserText(context);
					resolve();
					return fauxAssistantMessage("seen");
				},
			]);
		});
		await app.turn("end_of_batch");
		expect(harness.watches()).toHaveLength(1);
		expect(form.lastText()).toBe("watching");
		app.cell<number>("queue.depth").set(12);
		await woke;
		expect(wake).toMatch(/watch 1 queue\.depth gt 10: now 12/);
		await form.agent.waitForIdle();
		form.shutdown("test over");
	});

	test("a safepoint call waits for the program's safepoint(): a timeout error without one, the result once the program reaches it", async () => {
		const { app, form, setResponses, records } = await world();
		let first = "";
		let second = "";
		let loop: NodeJS.Timeout | undefined;
		const started = Date.now();
		let firstSeenAt = 0;
		const done = new Promise<void>((resolve) => {
			setResponses([
				toolUse("abai_call", { capability: "job.retry", params: { job_id: "j1" }, reason: "retry it" }),
				(context) => {
					first = lastToolResult(context);
					firstSeenAt = Date.now();
					// now the program has a loop that reaches a safepoint
					loop = setInterval(() => app.safepoint(), 10);
					return toolUse("abai_call", { capability: "job.retry", params: { job_id: "j1" }, reason: "again" });
				},
				(context) => {
					second = lastToolResult(context);
					resolve();
					return fauxAssistantMessage("retried");
				},
			]);
		});
		try {
			app.event("job.failed").emit({ job_id: "j1" });
			await done;
			await form.agent.waitForIdle();
		} finally {
			if (loop) clearInterval(loop);
		}
		expect(first).toContain("job.retry did not answer within 300ms");
		expect(firstSeenAt - started).toBeGreaterThanOrEqual(280);
		expect(second).toMatch(/ok[^a-z]+true/);
		expect(
			records()
				.filter((r) => r.act === "capability")
				.map((r) => [r.outcome, r.cause]),
		).toEqual([
			["error", "timeout"],
			["ok", undefined],
		]);
		form.shutdown("test over");
	});

	test("an immediate call runs with no safepoint at all", async () => {
		const { app, form, setResponses, records } = await world();
		let result = "";
		const done = new Promise<void>((resolve) => {
			setResponses([
				toolUse("abai_call", { capability: "queue.size", params: {}, reason: "how deep" }),
				(context) => {
					result = lastToolResult(context);
					resolve();
					return fauxAssistantMessage("three");
				},
			]);
		});
		app.event("job.failed").emit({ job_id: "j2" });
		await done;
		await form.agent.waitForIdle();
		expect(result).toMatch(/n[^0-9]+3/);
		// no safepoint was ever reached here, so a safepoint-dispatched call would have timed out instead
		expect(records().filter((r) => r.act === "capability")).toMatchObject([{ name: "queue.size", outcome: "ok" }]);
		form.shutdown("test over");
	});

	test("a decision is answered through abai_decide, as in every mode", async () => {
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
			outcome: "agent",
			value: { option: "scale_up" },
		});
		form.shutdown("test over");
	});

	test("ABAI_MODE=thread over a turns-first manifest gives a live form that says thread", async () => {
		const { app, harness, form, setResponses } = await world({
			modes: ["turns", "thread"],
			env: { ABAI_MODE: "thread" },
		});
		expect(app.manifest.modes).toEqual(["turns", "thread"]);
		expect(app.mode).toBe("thread");
		expect(harness.mode).toBe("thread");
		expect(form.mode).toBe("live");
		expect(harness.systemPrompt()).toContain("in thread mode.");
		let wake = "";
		const woke = new Promise<void>((resolve) => {
			setResponses([
				(context) => {
					wake = lastUserText(context);
					resolve();
					return fauxAssistantMessage("live indeed");
				},
			]);
		});
		app.event("job.failed").emit({ job_id: "j4" });
		await woke;
		await form.agent.waitForIdle();
		expect(wake).toContain("job.failed job_id=j4");
		form.shutdown("test over");
	});

	test("a fault in the harness stays with the harness: the program keeps emitting, deciding and giving turns", async () => {
		const { app, form, harness, binding, setResponses, records } = await world();
		// contact first, so a later failure is a failed run, not an unreachable model
		setResponses([fauxAssistantMessage("here")]);
		await app.turn("end_of_batch");
		expect(form.lastText()).toBe("here");
		// a listener of the harness side that throws on every event is caught at the binding
		binding.on("event", () => {
			throw new Error("listener exploded");
		});
		let after = 0;
		binding.on("event", () => {
			after += 1;
		});
		const before = harness.ring.size;
		setResponses([fauxAssistantMessage("noted")]);
		expect(() => app.event("job.failed").emit({ job_id: "j9" })).not.toThrow();
		expect(harness.ring.size).toBeGreaterThan(before); // the harness's own listener, before the thrower, ran
		expect(after).toBe(1); // and the one after it too: each listener is isolated on its own
		await settle();
		await form.agent.waitForIdle();
		expect(form.lastText()).toBe("noted");
		// the model fails mid-conversation: the run ends, the decision takes its default, nothing detaches
		setResponses([
			() => {
				throw new Error("model exploded");
			},
		]);
		await expect(app.decide<string>("on_backlog", { depth: 20, workers: 4 })).resolves.toBe("wait");
		expect(app.attached).toBe(true);
		expect(harness.attached).toBe(true);
		expect(form.modelFailure).toBeUndefined();
		expect(records().find((r) => r.act === "decision")).toMatchObject({ outcome: "default" });
		// and the next wake runs as usual
		setResponses([fauxAssistantMessage("back")]);
		await app.turn("end_of_batch");
		expect(form.lastText()).toBe("back");
		form.shutdown("test over");
	});

	test("a session touchpoint gates nothing: an event during the person's loop runs at once", async () => {
		let answer: ((line: string | undefined) => void) | undefined;
		const said: string[] = [];
		const channel: UserChannel = {
			say: (text) => {
				said.push(text);
			},
			ask: () =>
				new Promise((resolve) => {
					answer = resolve;
				}),
			confirm: async () => true,
			close: () => {},
		};
		const { app, form, setResponses } = await world({ channel });
		let wake = "";
		const woke = new Promise<void>((resolve) => {
			setResponses([
				(context) => {
					wake = lastUserText(context);
					resolve();
					return fauxAssistantMessage("handled while you type");
				},
			]);
		});
		const session = app.session();
		await settle();
		expect(answer).toBeDefined(); // the person is being asked
		app.event("job.failed").emit({ job_id: "j3" });
		await woke;
		await form.agent.waitForIdle();
		expect(wake).toContain("job.failed job_id=j3");
		expect(said).toContain("handled while you type");
		answer?.(undefined); // the person is done
		await session;
		form.shutdown("test over");
	});
});
