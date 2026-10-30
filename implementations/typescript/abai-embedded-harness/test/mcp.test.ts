// The MCP front end over in-memory streams against a program in this
// process: the protocol's shape, every tool reached through it, and the
// rule that a wake's decisions, turns and touchpoints are settled when the
// agent parks again.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type AbaigramOptions, createAbaigram, type DirectBinding, type HarnessBinding } from "@abaigram/stub";
import { afterEach, describe, expect, test } from "vitest";
import { Harness } from "../src/harness.ts";
import { MCP_PROTOCOL_VERSIONS, MCP_SERVER_NAME, PARKED_UNDECIDED, serveMcp } from "../src/mcp.ts";
import { defaultOptions, type HarnessOptions } from "../src/options.ts";
import { DirectTransport } from "../src/transport-direct.ts";

type Line = Record<string, unknown>;

function declarations(): AbaigramOptions {
	return {
		name: "mcpy",
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
				dispatch: "immediate",
				doc: "Retry.",
				handler: ({ job_id }) => ({ ok: job_id === "j1" }),
			},
			"job.peek": {
				params: {},
				result: { n: "int" },
				effect: "read",
				doc: "Peek, at a safepoint.",
				handler: () => ({ n: 1 }),
			},
		},
		decisions: {
			on_backlog: {
				context: { depth: "int" },
				options: ["scale_up", "wait"],
				default: "wait",
				timeout: "10s",
				doc: "Backlog.",
			},
		},
		turns: { end_of_batch: { timeout: "10s", doc: "Batch." } },
	};
}

interface World {
	app: ReturnType<typeof createAbaigram>;
	harness: Harness;
	binding: HarnessBinding;
	input: PassThrough;
	output: PassThrough;
	errors: string[];
	served: Promise<number>;
	/** Begin serving (done at once unless the world was built with `serve: false`). */
	start(): void;
	/** Send a JSON-RPC request and await its response. */
	request(method: string, params?: unknown, id?: string | number): Promise<Line>;
	send(message: unknown): void;
	sendRaw(text: string): void;
	/** Responses received so far, by id (the last for an id), and all of them in order. */
	responses: Map<string | number | null, Line>;
	all: Line[];
	/** A tool call, answering the text of its result. */
	call(
		name: string,
		args?: Record<string, unknown>,
		id?: string | number,
	): Promise<{ text: string; isError: boolean }>;
	records(): Line[];
}

const dirs: string[] = [];
const worlds: World[] = [];
afterEach(async () => {
	for (const world of worlds.splice(0)) {
		world.input.end();
		await world.served;
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function world(setup: { options?: Partial<HarnessOptions>; serve?: boolean } = {}): Promise<World> {
	const root = mkdtempSync(join(tmpdir(), "mcp-"));
	dirs.push(root);
	mkdirSync(join(root, "abai"));
	writeFileSync(join(root, "abai/identity.md"), "You are the agent fused into mcpy.\n");
	writeFileSync(join(root, "abai/install.md"), "Set it up once.\n");
	writeFileSync(join(root, "abai/use.md"), "Welcome to mcpy.\n");
	const auditPath = join(root, "audit.jsonl");
	let harness: Harness | undefined;
	let binding: HarnessBinding | undefined;
	const app = createAbaigram(declarations(), {
		env: {},
		root,
		auditPath,
		harness: async (b) => {
			binding = b;
			harness = new Harness(defaultOptions("mcp", setup.options ?? {}));
			await harness.attach(new DirectTransport(b));
		},
	});
	expect(await app.attach()).toBe(true);
	if (!harness || !binding) throw new Error("the factory did not run");
	const input = new PassThrough();
	const output = new PassThrough();
	const errors: string[] = [];
	const stderr = new PassThrough();
	stderr.on("data", (chunk) => errors.push(String(chunk)));
	const responses = new Map<string | number | null, Line>();
	const all: Line[] = [];
	const waiters: Array<{ id: string | number | null; resolve: (line: Line) => void }> = [];
	let buffer = "";
	output.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let at = buffer.indexOf("\n");
		while (at >= 0) {
			const text = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			at = buffer.indexOf("\n");
			const line = JSON.parse(text) as Line;
			const id = (line.id ?? null) as string | number | null;
			responses.set(id, line);
			all.push(line);
			for (const waiter of waiters.splice(0)) {
				if (waiter.id === id) waiter.resolve(line);
				else waiters.push(waiter);
			}
		}
	});
	const started = harness;
	let resolveServed: (code: Promise<number>) => void = () => {};
	const served = new Promise<number>((resolve) => {
		resolveServed = (code) => void code.then(resolve);
	});
	const start = (): void => resolveServed(serveMcp(started, { input, output, stderr, signals: [] }));
	if (setup.serve !== false) start();
	let nextId = 1;
	const send = (message: unknown): void => {
		input.write(`${JSON.stringify(message)}\n`);
	};
	const request = (method: string, params?: unknown, id: string | number = nextId++): Promise<Line> => {
		send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
		return new Promise((resolve, reject) => {
			const found = responses.get(id);
			if (found) {
				resolve(found);
				return;
			}
			const timer = setTimeout(() => reject(new Error(`no response to ${method} (${String(id)}) in time`)), 8000);
			waiters.push({
				id,
				resolve: (line) => {
					clearTimeout(timer);
					resolve(line);
				},
			});
		});
	};
	const w: World = {
		app,
		harness,
		binding,
		input,
		output,
		errors,
		served,
		start,
		request,
		send,
		sendRaw: (text) => {
			input.write(text);
		},
		responses,
		all,
		call: async (name, args = {}, id) => {
			const response = await request("tools/call", { name, arguments: args }, id);
			const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
			return { text: result.content[0].text, isError: result.isError === true };
		},
		records: () =>
			existsSync(auditPath)
				? readFileSync(auditPath, "utf8")
						.split("\n")
						.filter((l) => l !== "")
						.map((l) => JSON.parse(l) as Line)
				: [],
	};
	worlds.push(w);
	return w;
}

describe("the MCP server's protocol", () => {
	test("initialize echoes a known protocol version, falls back otherwise, and carries the instructions", async () => {
		const w = await world();
		const known = await w.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
		expect(known.result).toMatchObject({
			protocolVersion: "2024-11-05",
			capabilities: { tools: {} },
			serverInfo: { name: MCP_SERVER_NAME, version: "0.1.0" },
		});
		expect((known.result as { instructions: string }).instructions).toContain("abai_wait");
		expect((known.result as { instructions: string }).instructions).toContain("mcpy");
		const unknown = await w.request("initialize", { protocolVersion: "1999-01-01" });
		expect((unknown.result as Line).protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0]);
		const none = await w.request("initialize", {});
		expect((none.result as Line).protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0]);
		expect((await w.request("ping")).result).toEqual({});
	});

	test("tools/list names the MCP form's fourteen tools with JSON Schema inputs", async () => {
		const w = await world();
		const listed = (await w.request("tools/list")).result as { tools: Array<{ name: string; inputSchema: Line }> };
		expect(listed.tools.map((t) => t.name)).toEqual([
			"abai_status",
			"abai_transcript",
			"abai_cells",
			"abai_set",
			"abai_call",
			"abai_claim",
			"abai_decide",
			"abai_watch",
			"abai_timer",
			"abai_audit",
			"abai_lifecycle",
			"abai_attach",
			"abai_wait",
			"abai_prompt",
		]);
		const set = listed.tools.find((t) => t.name === "abai_set") as { inputSchema: Line };
		expect(set.inputSchema).toMatchObject({ type: "object", required: ["cell", "value", "reason"] });
	});

	test("malformed and unknown traffic: a parse error, a batch, a methodless request, an unknown method, a notification", async () => {
		const w = await world();
		w.sendRaw("{not json\n");
		w.sendRaw("[]\n");
		w.send({ jsonrpc: "2.0", id: "m1" });
		const unknown = await w.request("nope", {}, "u1");
		expect(unknown.error).toEqual({ code: -32601, message: "method not found: nope" });
		expect(w.responses.get(null)).toBeDefined();
		await sleep(20);
		const errors = w.all.filter((r) => r.error !== undefined).map((r) => `${String(r.id)}:${(r.error as Line).code}`);
		expect(errors).toContain("null:-32700");
		expect(errors).toContain("null:-32600");
		// an id with no method is a client's own response: not answered
		expect(w.responses.get("m1")).toBeUndefined();
		// a notification gets no response at all, nor does a client's own response (an id and no method)
		const before = w.all.length;
		w.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		w.send({ jsonrpc: "2.0", id: "r1", result: {} });
		await sleep(30);
		expect(w.all.length).toBe(before);
		// an id of another type is refused without being echoed
		w.send({ jsonrpc: "2.0", id: { nested: true }, method: "ping" });
		await sleep(20);
		expect(w.all.at(-1)).toMatchObject({ id: null, error: { code: -32600 } });
		expect((await w.request("ping")).result).toEqual({});
	});
});

describe("the MCP server's tools", () => {
	test("cells, a knob with its reason, a confirm capability under the client's consent, and the audit", async () => {
		const w = await world();
		w.app.cell("queue.depth").set(7);
		expect(JSON.parse((await w.call("abai_cells")).text)).toEqual({ "queue.depth": 7, "worker.count": 4 });
		expect((await w.call("abai_set", { cell: "worker.count", value: 8, reason: "more hands" })).text).toBe(
			"worker.count = 8",
		);
		// this stub refuses a value outside the range rather than clamping it: the agent is told, as a tool error
		const refused = await w.call("abai_set", { cell: "worker.count", value: 999, reason: "too many" });
		expect(refused.isError).toBe(true);
		expect(refused.text).toMatch(/within 1 and 64/);
		// job.retry mutates, so its policy is confirm: the MCP client's own prompt was the person's consent
		const retried = await w.call("abai_call", { capability: "job.retry", params: { job_id: "j1" }, reason: "retry" });
		expect(retried.isError).toBe(false);
		expect(JSON.parse(retried.text)).toEqual({ ok: true });
		// a safepoint-dispatched capability runs at once: the program at its entry holds the safepoint open
		(w.binding as DirectBinding).enterSafepoint();
		expect(JSON.parse((await w.call("abai_call", { capability: "job.peek", reason: "look" })).text)).toEqual({
			n: 1,
		});
		(w.binding as DirectBinding).leaveSafepoint();
		const bad = await w.call("abai_call", { capability: "nothing", reason: "r" });
		expect(bad.isError).toBe(true);
		expect(bad.text).toMatch(/not a capability/);
		const audit = JSON.parse((await w.call("abai_audit", { limit: 10 })).text) as { records: Line[] };
		expect(audit.records.map((r) => `${r.act}:${r.name}:${r.outcome}:${r.consent ?? ""}`)).toEqual([
			"knob:worker.count:ok:",
			"knob:worker.count:error:",
			"capability:job.retry:ok:auto",
			"capability:job.peek:ok:",
		]);
		expect(w.records()[0]).toMatchObject({ reason: "more hands" });
		expect((await w.call("abai_prompt")).text).toContain("You are the agent fused into mcpy.");
		expect(JSON.parse((await w.call("abai_status")).text)).toMatchObject({
			attached: true,
			program: { name: "mcpy" },
		});
	});

	test("abai_lifecycle: status answers in process; anything more has no channel in turns mode", async () => {
		const w = await world();
		const status = await w.call("abai_lifecycle", { op: "status", reason: "look" });
		expect(status.isError).toBe(false);
		expect(JSON.parse(status.text)).toMatchObject({ name: "mcpy", mode: "turns", paused: false, launched: false });
		// under MCP the client's consent stands, so stop reaches the transport, which has no such channel here
		const stop = await w.call("abai_lifecycle", { op: "stop", reason: "done" });
		expect(stop.isError).toBe(true);
		expect(stop.text).toMatch(/no lifecycle channel in turns mode/);
		const pause = await w.call("abai_lifecycle", { op: "pause", reason: "hold" });
		expect(pause.isError).toBe(true);
	});

	test("invalid arguments are a result the model can read, not a protocol error; an unknown tool is", async () => {
		const w = await world();
		const invalid = await w.call("abai_set", { cell: "worker.count", value: 1 });
		expect(invalid.isError).toBe(true);
		expect(invalid.text).toMatch(/invalid arguments/);
		expect(invalid.text).toMatch(/reason/);
		const unknown = await w.request("tools/call", { name: "abai_nothing", arguments: {} });
		expect(unknown.error).toMatchObject({ code: -32602 });
		const nameless = await w.request("tools/call", {});
		expect(nameless.error).toMatchObject({ code: -32602 });
	});

	test("abai_wait returns the next wake: an event, a decision; a wait with nothing to say times out", async () => {
		const w = await world();
		expect((await w.call("abai_wait", { wait_s: 0.2 })).text).toMatch(/^no wake in 0.2s/);
		const parked = w.call("abai_wait", { wait_s: 5 });
		await sleep(20);
		w.app.event("job.failed").emit({ job_id: "j9" });
		const woke = (await parked).text;
		expect(woke).toContain("[abai wake]");
		expect(woke).toContain("job.failed");
		expect(woke).toContain("j9");
		const deciding = w.app.decide<string>("on_backlog", { depth: 20 });
		const asked = (await w.call("abai_wait", { wait_s: 5 })).text;
		const id = /decision (d\d+) on_backlog/.exec(asked)?.[1];
		expect(id).toBeDefined();
		expect((await w.call("abai_decide", { id, answer: "scale_up", reason: "deep" })).text).toContain("answered");
		expect(await deciding).toBe("scale_up");
	});

	test("parking again settles what the last wake carried: a turn ends, an undecided decision defaults, a session touchpoint returns", async () => {
		const w = await world();
		const turning = w.app.turn("end_of_batch");
		const turn = (await w.call("abai_wait", { wait_s: 5 })).text;
		expect(turn).toContain("turn t");
		expect(w.harness.pendingTurnList()).toHaveLength(1);
		// the agent did nothing with the turn and parks again: the turn ends now, the program goes on
		const next = w.call("abai_wait", { wait_s: 0.3 });
		await turning;
		expect(w.harness.pendingTurnList()).toEqual([]);
		expect((await next).text).toMatch(/^no wake/);

		const deciding = w.app.decide<string>("on_backlog", { depth: 20 });
		expect((await w.call("abai_wait", { wait_s: 5 })).text).toContain("on_backlog");
		const again = w.call("abai_wait", { wait_s: 0.3 });
		expect(await deciding).toBe("wait");
		await again;
		expect(w.records().find((r) => r.act === "decision")).toMatchObject({
			outcome: "default",
			cause: "answered",
			reason: PARKED_UNDECIDED,
		});

		// a session touchpoint is a step of the agent here, with its content, and ends at the next park
		const session = w.app.session();
		const wake = (await w.call("abai_wait", { wait_s: 5 })).text;
		expect(wake).toContain("session p");
		expect(wake).toContain("Welcome to mcpy.");
		const after = w.call("abai_wait", { wait_s: 0.3 });
		await session;
		await after;
		expect(w.harness.pendingTouchpointList()).toEqual([]);
	});

	test("a cancelled wait returns at once, and a wake that arrives after it is kept for the next park", async () => {
		const w = await world();
		const parked = w.call("abai_wait", { wait_s: 20 }, 42);
		await sleep(20);
		const started = Date.now();
		w.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 42, reason: "user" } });
		const cancelled = (await parked).text;
		// the abort listener ends the wait at once; the tick alone would take up to a second
		expect(Date.now() - started).toBeLessThan(200);
		expect(cancelled).toMatch(/^cancelled;/);
		w.app.event("job.failed").emit({ job_id: "late" });
		expect((await w.call("abai_wait", { wait_s: 2 })).text).toContain("late");
	});

	test("two waits in flight: what each returns is settled at the next park, none of it lost", async () => {
		const w = await world();
		const first = w.call("abai_wait", { wait_s: 5 }, "w1");
		const second = w.call("abai_wait", { wait_s: 5 }, "w2");
		await sleep(30);
		const turning = w.app.turn("end_of_batch");
		const texts = [(await first).text];
		await sleep(30);
		const deciding = w.app.decide<string>("on_backlog", { depth: 20 });
		texts.push((await second).text);
		expect(texts.join("\n")).toContain("turn t");
		expect(texts.join("\n")).toContain("on_backlog");
		// one park settles both: the turn ends, the decision defaults
		const park = w.call("abai_wait", { wait_s: 0.3 });
		await turning;
		expect(await deciding).toBe("wait");
		await park;
		expect(w.harness.pendingTurnList()).toEqual([]);
		expect(w.harness.pendingDecisions()).toEqual([]);
	});

	test("a session touchpoint held before the server started is delivered by the first park", async () => {
		const w = await world({ serve: false });
		// the program opened its session while the harness was attached and no front end existed yet
		const session = w.app.session();
		await sleep(20);
		expect(w.harness.pendingTouchpointList()).toMatchObject([{ kind: "session" }]);
		w.start();
		const wake = (await w.call("abai_wait", { wait_s: 5 })).text;
		expect(wake).toContain("session p");
		expect(wake).toContain("Welcome to mcpy.");
		const next = w.call("abai_wait", { wait_s: 0.3 });
		await session;
		await next;
		expect(w.harness.pendingTouchpointList()).toEqual([]);
	});

	test("a wait longer than the harness allows is capped; a mutate call is refused under --deny-mutate", async () => {
		const w = await world({ options: { waitMaxMs: 300, denyMutate: true } });
		const started = Date.now();
		expect((await w.call("abai_wait", { wait_s: 100 })).text).toMatch(/^no wake in 0.3s/);
		expect(Date.now() - started).toBeLessThan(2000);
		const refused = await w.call("abai_call", { capability: "job.retry", params: { job_id: "j1" }, reason: "r" });
		expect(refused.isError).toBe(true);
		expect(refused.text).toMatch(/refused/);
	});

	test("the output failing ends the server too", async () => {
		const w = await world();
		w.output.destroy(new Error("the client is gone"));
		expect(await w.served).toBe(0);
		expect(w.errors.join("")).toContain("output closed; the harness exited");
	});

	test("a request followed at once by the end of input is still answered before the server goes", async () => {
		const w = await world();
		// the way a scripted client talks: everything at once, then end of input
		const answered = w.request("tools/call", { name: "abai_cells", arguments: {} }, "last");
		w.input.end();
		const response = await answered;
		expect(JSON.parse((response.result as { content: Array<{ text: string }> }).content[0].text)).toEqual({
			"queue.depth": 0,
			"worker.count": 4,
		});
		expect(await w.served).toBe(0);
	});

	test("the input ending ends the server with exit 0 and detaches the program", async () => {
		const w = await world();
		expect(w.app.attached).toBe(true);
		w.input.end();
		expect(await w.served).toBe(0);
		expect(w.app.attached).toBe(false);
		expect(w.errors.join("")).toContain("input ended; the harness exited");
	});
});
