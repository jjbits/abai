// The stub's sidecar endpoint (abaigrammar section 6.3) driven by a raw wire
// v1 client written here, so nothing of the harness package is between the
// test and the protocol. Two connections where it matters: one binding,
// acts audited under the connection that made them, decisions to their
// claimant, turns and touchpoints to everyone.
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, test } from "vitest";
import { Endpoint, type EndpointOptions } from "../src/endpoint.ts";
import { type Abaigram, createAbaigram } from "../src/program.ts";
import type { AbaigramOptions } from "../src/registry.ts";
import { descriptorPath, EXTENSIONS, PROTOCOL_VERSION, readDescriptors } from "../src/wire/index.ts";

type Line = Record<string, unknown>;

function declarations(): AbaigramOptions {
	return {
		name: "endy",
		modes: ["sidecar", "turns"],
		cells: {
			"queue.depth": { type: "int", access: "read", doc: "Depth." },
			"worker.count": { type: "int", access: "readwrite", default: 4, range: [1, 64], doc: "Workers." },
			label: { type: "string", max: 8, access: "readwrite", default: "none", doc: "Label." },
			careful: { type: "bool", access: "readwrite", default: false, policy: "confirm", doc: "Needs consent." },
		},
		events: {
			"job.failed": {
				payload: { job_id: "string", error: { type: "string", max: 8 } },
				wakes: "always",
				doc: "Failed.",
			},
			"job.done": { payload: { job_id: "string" }, wakes: "never", doc: "Done." },
		},
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
				dispatch: "immediate",
				doc: "Peek.",
				handler: () => ({ n: 1 }),
			},
			"job.drop": { params: {}, result: {}, effect: "mutate", policy: "forbid", doc: "Never.", handler: () => ({}) },
			"job.boom": {
				params: {},
				result: {},
				effect: "read",
				dispatch: "immediate",
				doc: "Throws.",
				handler: () => {
					throw new Error("it broke");
				},
			},
		},
		decisions: {
			on_backlog: {
				context: { depth: "int", workers: "int" },
				options: ["scale_up", "shed_oldest", "wait"],
				default: "wait",
				timeout: "1s",
				doc: "Backlog.",
			},
			on_input: {
				context: { text: "string" },
				answer: { action: "string" },
				default: { action: "continue" },
				timeout: "1s",
				doc: "Input.",
			},
			forbidden_one: {
				context: {},
				options: ["a"],
				default: "a",
				timeout: "1s",
				policy: "forbid",
				doc: "Never asked.",
			},
		},
		turns: { end_of_batch: { timeout: "1s", doc: "Batch." } },
	};
}

interface Program {
	app: Abaigram;
	endpoint: Endpoint;
	dir: string;
	runDir: string;
	auditPath: string;
	records(): Line[];
}

interface Raw {
	socket: Socket;
	lines: Line[];
	hello: Line;
	closed: boolean;
	send(message: unknown): void;
	sendRaw(text: string): void;
	request(command: Line, extra?: Line): Promise<Line>;
	/** The next line matching `predicate` (already received or still to come). */
	next(predicate: (line: Line) => boolean, timeoutMs?: number): Promise<Line>;
	close(): void;
}

const dirs: string[] = [];
const endpoints: Endpoint[] = [];
const sockets: Socket[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
	for (const socket of sockets.splice(0)) socket.destroy();
	for (const endpoint of endpoints.splice(0)) endpoint.close("test over");
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(get: () => T | undefined | false, what = "the condition", tries = 400): Promise<T> {
	for (let i = 0; i < tries; i++) {
		const value = get();
		if (value !== undefined && value !== false) return value;
		await sleep(5);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/**
 * A program with its endpoint. With no options, the endpoint is the one the
 * program opens itself at startup under sidecar (the path every real program
 * takes). An option the program does not expose, such as a small buffer
 * bound, puts the program in turns mode and builds the endpoint by hand.
 */
async function program(
	options: Partial<EndpointOptions> = {},
	env: NodeJS.ProcessEnv = {},
	declare: Partial<AbaigramOptions> = {},
): Promise<Program> {
	const dir = mkdtempSync(join(tmpdir(), "ep-"));
	dirs.push(dir);
	mkdirSync(join(dir, "abai", "turns"), { recursive: true });
	writeFileSync(join(dir, "abai", "identity.md"), "I am endy.\n");
	writeFileSync(join(dir, "abai", "use.md"), "Welcome to endy.\n");
	writeFileSync(join(dir, "abai", "turns", "end_of_batch.md"), "Batch is done.\n");
	const auditPath = join(dir, "audit.jsonl");
	const runDir = join(dir, "run");
	const byHand = Object.keys(options).length > 0;
	const app = createAbaigram(
		{ ...declarations(), ...declare },
		{
			env: {
				ABAI_HARNESS: "",
				ABAI_MODE: byHand ? "turns" : "sidecar",
				ABAI_RUN_DIR: runDir,
				// a stray attach must fail fast rather than start the workspace's real binary
				ABAI_HARNESS_BIN: join(dir, "no-such-harness"),
				...env,
			},
			root: dir,
			auditPath,
		},
	);
	const endpoint = byHand ? new Endpoint(app, { runDir, ...options }) : (app.endpoint as Endpoint);
	endpoints.push(endpoint);
	await endpoint.ready;
	return {
		app,
		endpoint,
		dir,
		runDir,
		auditPath,
		records: () =>
			existsSync(auditPath)
				? readFileSync(auditPath, "utf8")
						.split("\n")
						.filter((l) => l !== "")
						.map((l) => JSON.parse(l) as Line)
				: [],
	};
}

function connect(socketPath: string): Promise<Raw> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		sockets.push(socket);
		const lines: Line[] = [];
		const waiters: Array<{ predicate: (line: Line) => boolean; resolve: (line: Line) => void }> = [];
		let buffer = "";
		let nextId = 1;
		const raw: Raw = {
			socket,
			lines,
			hello: {},
			closed: false,
			send: (message) => {
				socket.write(`${JSON.stringify(message)}\n`);
			},
			sendRaw: (text) => {
				socket.write(text);
			},
			request: (command, extra = {}) => {
				const id = `c${nextId++}`;
				raw.send({ type: "request", id, command, ...extra });
				return raw.next((l) => l.type === "response" && l.id === id);
			},
			next: (predicate, timeoutMs = 5000) =>
				new Promise((done, fail) => {
					const found = lines.find(predicate);
					if (found) {
						done(found);
						return;
					}
					const timer = setTimeout(() => fail(new Error(`no such line within ${timeoutMs} ms`)), timeoutMs);
					waiters.push({
						predicate,
						resolve: (line) => {
							clearTimeout(timer);
							done(line);
						},
					});
				}),
			close: () => socket.destroy(),
		};
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let at = buffer.indexOf("\n");
			while (at >= 0) {
				const text = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				at = buffer.indexOf("\n");
				if (text === "") continue;
				const line = JSON.parse(text) as Line;
				if (!raw.hello.type && line.type === "hello") {
					raw.hello = line;
					resolve(raw);
					continue;
				}
				lines.push(line);
				for (const waiter of waiters.splice(0)) {
					if (waiter.predicate(line)) waiter.resolve(line);
					else waiters.push(waiter);
				}
			}
		});
		socket.on("error", (error) => reject(error));
		socket.on("close", () => {
			raw.closed = true;
		});
	});
}

const isType = (type: string) => (line: Line) => line.type === type;

describe("the sidecar endpoint: hello and the library commands", () => {
	test("listens from startup with a descriptor, says hello, and answers every library command", async () => {
		const prog = await program();
		expect(prog.endpoint.socketPath).toBe(join(prog.runDir, `${process.pid}.sock`));
		expect(existsSync(descriptorPath(prog.runDir, process.pid))).toBe(true);
		expect(readDescriptors(prog.runDir)[0]).toMatchObject({ pid: process.pid, name: "endy", mode: "sidecar" });
		// nothing is attached until someone connects
		expect(prog.app.attached).toBe(false);

		const raw = await connect(prog.endpoint.socketPath);
		expect(prog.app.attached).toBe(true);
		expect(raw.hello).toMatchObject({
			type: "hello",
			protocol: PROTOCOL_VERSION,
			pid: process.pid,
			mode: "sidecar",
			capabilities: { hooks: ["on_backlog", "on_input"], commands: ["job.retry", "job.peek", "job.boom"] },
			lastSeq: 0,
			connection: "k1",
			abai: {
				name: "endy",
				abaigrammar: "0.1",
				modes: ["sidecar", "turns"],
				audit: { path: prog.auditPath, failed: null },
				extensions: [...EXTENSIONS],
			},
		});

		expect((await raw.request({ type: "ping" })).data).toMatchObject({ pid: process.pid });
		expect((await raw.request({ type: "get_manifest" })).data).toEqual({ manifest: prog.app.manifest });
		expect((await raw.request({ type: "get_content" })).data).toEqual({
			identity: "I am endy.\n",
			use: "Welcome to endy.\n",
			turns: { end_of_batch: "Batch is done.\n" },
		});
		prog.app.cell("queue.depth").set(7);
		expect((await raw.request({ type: "get_cells" })).data).toEqual({
			seq: 0,
			cells: { "queue.depth": 7, "worker.count": 4, label: "none", careful: false },
		});
		expect((await raw.request({ type: "subscribe", include: ["job.failed"] })).data).toEqual({
			include: ["job.failed"],
			exclude: [],
		});
		expect(await raw.request({ type: "subscribe", include: "nope" })).toMatchObject({
			success: false,
			code: "invalid",
		});
		expect(await raw.request({ type: "get_audit", limit: 10 })).toMatchObject({
			success: true,
			data: { path: prog.auditPath, failed: null, records: [], truncated: false },
		});
	});

	test("a run directory too deep for a socket path puts the socket under the temp dir; the descriptor says where", async () => {
		const deep = join(mkdtempSync(join(tmpdir(), "ep-deep-")), "a".repeat(60), "b".repeat(40));
		dirs.push(dirname(dirname(deep)));
		const prog = await program({}, { ABAI_RUN_DIR: deep });
		expect(prog.endpoint.runDir).toBe(deep);
		expect(prog.endpoint.socketPath).not.toContain(deep);
		expect(Buffer.byteLength(prog.endpoint.socketPath)).toBeLessThanOrEqual(103);
		expect(readDescriptors(deep)[0]).toMatchObject({ pid: process.pid, socket: prog.endpoint.socketPath });
		// a client that follows the descriptor finds it
		const raw = await connect(readDescriptors(deep)[0].socket);
		expect(raw.hello.connection).toBe("k1");
	});

	test("knob writes and capability calls carry consent and codes, audited under their connection", async () => {
		const prog = await program();
		const k1 = await connect(prog.endpoint.socketPath);
		const k2 = await connect(prog.endpoint.socketPath);
		expect(k2.hello.connection).toBe("k2");
		expect(prog.endpoint.connectionIds()).toEqual(["k1", "k2"]);

		expect(
			(await k1.request({ type: "set_cell", name: "worker.count", value: 8 }, { reason: "more hands" })).data,
		).toEqual({
			name: "worker.count",
			value: 8,
		});
		expect(prog.app.knob("worker.count").get()).toBe(8);
		expect(await k1.request({ type: "set_cell", name: "worker.count", value: 999 }, { reason: "r" })).toMatchObject({
			success: false,
			code: "invalid",
		});
		expect(await k1.request({ type: "set_cell", name: "nope", value: 1 }, { reason: "r" })).toMatchObject({
			success: false,
			code: "unknown",
		});
		expect(await k1.request({ type: "set_cell", name: "queue.depth", value: 1 }, { reason: "r" })).toMatchObject({
			success: false,
			code: "invalid",
		});
		// a confirm knob needs consent stated on the request (the consent extension)
		expect(await k2.request({ type: "set_cell", name: "careful", value: true }, { reason: "r" })).toMatchObject({
			success: false,
			code: "denied",
		});
		expect(
			await k2.request({ type: "set_cell", name: "careful", value: true }, { reason: "yes", consent: "approved" }),
		).toMatchObject({ success: true, data: { name: "careful", value: true } });

		// capability calls: mutate defaults to confirm
		expect(await k1.request({ type: "job.retry", job_id: "j1" }, { reason: "retry" })).toMatchObject({
			success: false,
			code: "denied",
		});
		expect(await k1.request({ type: "job.retry", job_id: "j1" }, { reason: "retry", consent: "auto" })).toMatchObject(
			{
				success: true,
				data: { ok: true },
			},
		);
		expect(await k2.request({ type: "job.peek" }, { reason: "look" })).toMatchObject({
			success: true,
			data: { n: 1 },
		});
		expect(await k2.request({ type: "job.drop" }, { reason: "r" })).toMatchObject({
			success: false,
			code: "forbidden",
		});
		expect(await k2.request({ type: "nothing" }, { reason: "r" })).toMatchObject({ success: false, code: "unknown" });
		expect(await k2.request({ type: "job.boom" }, { reason: "r" })).toMatchObject({
			success: false,
			code: "error",
			error: "it broke",
		});
		expect(await k2.request({ type: "job.retry", job_id: 7 }, { reason: "r", consent: "auto" })).toMatchObject({
			success: false,
			code: "invalid",
		});

		const acts = prog.records().map((r) => `${r.act}:${r.name}:${r.conn}:${r.outcome}`);
		expect(acts).toEqual([
			"knob:worker.count:k1:ok",
			"knob:worker.count:k1:error",
			"knob:nope:k1:error",
			"knob:queue.depth:k1:error",
			"knob:careful:k2:error",
			"knob:careful:k2:ok",
			"capability:job.retry:k1:error",
			"capability:job.retry:k1:ok",
			"capability:job.peek:k2:ok",
			"capability:job.drop:k2:forbidden",
			"capability:nothing:k2:error",
			"capability:job.boom:k2:error",
			"capability:job.retry:k2:error",
		]);
		expect(prog.records()[0]).toMatchObject({ reason: "more hands" });
		expect(prog.records()[5]).toMatchObject({ consent: "approved", reason: "yes" });
		const audit = await k1.request({ type: "get_audit", limit: 3 });
		expect((audit.data as { records: unknown[]; truncated: boolean }).records).toHaveLength(3);
		expect((audit.data as { truncated: boolean }).truncated).toBe(true);
	});

	test("events are pushed under each connection's filter, with the truncation flag", async () => {
		const prog = await program();
		const k1 = await connect(prog.endpoint.socketPath);
		const k2 = await connect(prog.endpoint.socketPath);
		await k2.request({ type: "subscribe", exclude: ["job.failed"] });
		prog.app.event("job.failed").emit({ job_id: "j1", error: "a very long error text" });
		prog.app.event("job.done").emit({ job_id: "j1" });
		const failed = await k1.next(isType("event"));
		expect(failed).toEqual({
			type: "event",
			seq: 1,
			ts: expect.any(Number),
			event: { type: "job.failed", job_id: "j1", error: "a very l" },
			truncated: true,
		});
		const done = await k1.next((l) => l.type === "event" && (l.event as Line).type === "job.done");
		expect(done).toEqual({
			type: "event",
			seq: 2,
			ts: expect.any(Number),
			event: { type: "job.done", job_id: "j1" },
		});
		// k2 excluded job.failed: its first event is job.done
		const second = await k2.next(isType("event"));
		expect((second.event as Line).type).toBe("job.done");
		expect(k2.lines.filter(isType("event"))).toHaveLength(1);
		// an include list narrows further
		await k2.request({ type: "subscribe", include: ["job.failed"] });
		prog.app.event("job.done").emit({ job_id: "j2" });
		prog.app.event("job.failed").emit({ job_id: "j2", error: "x" });
		await waitFor(() => k1.lines.filter(isType("event")).length === 4, "k1's four events");
		await waitFor(() => k2.lines.filter(isType("event")).length === 2, "k2's second event");
		expect((k2.lines.filter(isType("event"))[1].event as Line).type).toBe("job.failed");
	});

	test("a malformed line or an unknown message type gets an error response, and the connection stays", async () => {
		const prog = await program();
		const raw = await connect(prog.endpoint.socketPath);
		raw.sendRaw("{not json\n");
		expect(await raw.next((l) => l.type === "response" && l.error === "invalid json")).toEqual({
			type: "response",
			command: "unknown",
			success: false,
			error: "invalid json",
		});
		raw.send({ type: "whatever", id: "x1" });
		expect(await raw.next((l) => l.type === "response" && l.id === "x1")).toMatchObject({
			success: false,
			code: "unknown",
			error: "unknown message type: whatever",
		});
		raw.send({ type: "request", id: "", command: { type: "ping" } });
		expect(await raw.next((l) => l.type === "response" && l.code === "invalid")).toMatchObject({
			error: "request id must be a non-empty string",
		});
		raw.send({ type: "request", id: "c9", command: "ping" });
		expect(await raw.next((l) => l.type === "response" && l.id === "c9")).toMatchObject({ code: "invalid" });
		expect((await raw.request({ type: "ping" })).success).toBe(true);
		expect(prog.app.attached).toBe(true);
	});

	test("a connection that cannot keep up is closed by the endpoint; another connection is unaffected", async () => {
		// 128 KiB: well above what one synchronous burst queues for a reader, well below what a paused reader piles up
		const prog = await program({ maxBuffered: 128 * 1024 });
		const slow = await connect(prog.endpoint.socketPath);
		const fine = await connect(prog.endpoint.socketPath);
		slow.socket.pause();
		const failed = prog.app.event("job.failed");
		for (let burst = 0; burst < 400 && prog.endpoint.connectionIds().length === 2; burst++) {
			for (let i = 0; i < 100; i++) failed.emit({ job_id: `j${burst}-${i}`, error: "x" });
			// the test and the clients share one event loop: the reading client drains between bursts
			await sleep(2);
		}
		// a paused client reads nothing, its own close included: the endpoint's view is what the test can see first
		expect(prog.endpoint.connectionIds()).toEqual(["k2"]);
		expect(prog.app.attached).toBe(true);
		slow.socket.resume();
		await waitFor(() => slow.closed, "the closed client to notice");
		expect((await fine.request({ type: "ping" })).success).toBe(true);
	});
});

describe("the sidecar endpoint: decisions, turns, touchpoints", () => {
	test("a decision reaches only its claimant, with reason and consent audited; unclaimed takes the default at once", async () => {
		const prog = await program();
		const k1 = await connect(prog.endpoint.socketPath);
		const k2 = await connect(prog.endpoint.socketPath);
		expect(await k1.request({ type: "claim_hooks", hooks: ["on_backlog"] })).toMatchObject({
			success: true,
			data: { hooks: ["on_backlog"], timeoutMs: 1000 },
		});
		expect(await k2.request({ type: "claim_hooks", hooks: ["on_backlog"] })).toMatchObject({
			success: false,
			code: "denied",
			error: "decision on_backlog is held by connection k1",
		});
		// a claim's wait may only shorten the manifest's: 60 s on a 1 s decision is answered 1 s
		expect((await k2.request({ type: "claim_hooks", hooks: ["on_input"], timeoutMs: 60_000 })).data).toEqual({
			hooks: ["on_input"],
			timeoutMs: 1000,
		});
		expect((await k2.request({ type: "release_hooks" })).data).toEqual({ released: ["on_input"] });
		expect(await k2.request({ type: "claim_hooks", hooks: ["nope"] })).toMatchObject({
			success: false,
			code: "unknown",
		});
		expect(await k2.request({ type: "claim_hooks", hooks: ["forbidden_one"] })).toMatchObject({
			success: false,
			code: "forbidden",
		});
		expect(await k2.request({ type: "claim_hooks", hooks: ["on_input"], timeoutMs: 0 })).toMatchObject({
			success: false,
			code: "invalid",
		});

		const deciding = prog.app.decide<string>("on_backlog", { depth: 9, workers: 2 });
		const hook = await k1.next(isType("hook"));
		expect(hook).toMatchObject({ hook: "on_backlog", payload: { depth: 9, workers: 2 } });
		expect(hook.timeoutMs as number).toBeLessThanOrEqual(1000);
		expect(k2.lines.filter(isType("hook"))).toHaveLength(0);
		k1.send({ type: "hook_response", id: hook.id, result: "scale_up", reason: "the queue is deep", consent: "auto" });
		expect(await deciding).toBe("scale_up");
		expect(prog.records().at(-1)).toMatchObject({
			act: "decision",
			name: "on_backlog",
			conn: "k1",
			outcome: "agent",
			reason: "the queue is deep",
			consent: "auto",
		});

		// nobody claimed on_input: the program goes on with the default, counted as no_harness under the
		// endpoint's own label, since no connection acted
		await expect(prog.app.decide("on_input", { text: "hi" })).resolves.toEqual({ action: "continue" });
		expect(prog.records().at(-1)).toMatchObject({
			act: "decision",
			name: "on_input",
			outcome: "default",
			cause: "no_harness",
			conn: "endpoint",
		});
		expect(k1.lines.filter(isType("hook"))).toHaveLength(1);

		// a release lets the other connection take the claim
		expect((await k1.request({ type: "release_hooks" })).data).toEqual({ released: ["on_backlog"] });
		expect((await k2.request({ type: "claim_hooks", hooks: ["on_backlog", "on_input"] })).data).toEqual({
			hooks: ["on_backlog", "on_input"],
			timeoutMs: 1000,
		});
	});

	test("a claim's shorter wait applies the default and tells the claimant; three timeouts release its claims", async () => {
		const prog = await program();
		const k1 = await connect(prog.endpoint.socketPath);
		expect((await k1.request({ type: "claim_hooks", hooks: ["on_backlog"], timeoutMs: 60 })).data).toEqual({
			hooks: ["on_backlog"],
			timeoutMs: 60,
		});
		for (let i = 0; i < 3; i++) {
			const started = Date.now();
			await expect(prog.app.decide("on_backlog", { depth: 1, workers: 1 })).resolves.toBe("wait");
			expect(Date.now() - started).toBeLessThan(900);
			const hook = k1.lines.filter(isType("hook")).at(-1) as Line;
			expect(hook.timeoutMs).toBe(60);
			await k1.next((l) => l.type === "hook_timeout" && l.id === hook.id);
			expect(prog.records().at(-1)).toMatchObject({
				act: "decision",
				conn: "k1",
				outcome: "default",
				cause: "timeout",
			});
		}
		expect(await k1.next(isType("hook_claims_released"))).toEqual({
			type: "hook_claims_released",
			reason: "timeouts",
			hooks: ["on_backlog"],
		});
		// nothing is claimed now: the next decision is not asked at all
		await expect(prog.app.decide("on_backlog", { depth: 1, workers: 1 })).resolves.toBe("wait");
		expect(prog.records().at(-1)).toMatchObject({ cause: "no_harness" });
		expect(k1.lines.filter(isType("hook"))).toHaveLength(3);
	});

	test("an answer from another connection is ignored; an invalid answer is rejected and the default applies", async () => {
		const prog = await program();
		const k1 = await connect(prog.endpoint.socketPath);
		const k2 = await connect(prog.endpoint.socketPath);
		await k1.request({ type: "claim_hooks", hooks: ["on_backlog"] });
		const deciding = prog.app.decide<string>("on_backlog", { depth: 9, workers: 2 });
		const hook = await k1.next(isType("hook"));
		k2.send({ type: "hook_response", id: hook.id, result: "scale_up", reason: "not mine" });
		await sleep(30);
		expect(prog.app.directBinding?.pendingDecisions()).toHaveLength(1);
		k1.send({ type: "hook_response", id: hook.id, result: "fly", reason: "wrong" });
		expect(await k1.next(isType("hook_rejected"))).toMatchObject({ id: hook.id, hook: "on_backlog" });
		expect((await k1.next(isType("hook_rejected"))).error).toMatch(/one of: scale_up/);
		expect(await deciding).toBe("wait");
		expect(prog.records().at(-1)).toMatchObject({ outcome: "default", cause: "invalid", conn: "k1" });
		// a late answer for a settled decision writes nothing and breaks nothing
		k1.send({ type: "hook_response", id: hook.id, result: "wait", reason: "late" });
		expect((await k1.request({ type: "ping" })).success).toBe(true);
	});

	test("a release while a decision is pending defaults it as detached; a claimant leaving does the same, and the program stays attached", async () => {
		const prog = await program();
		const k1 = await connect(prog.endpoint.socketPath);
		const k2 = await connect(prog.endpoint.socketPath);
		await k1.request({ type: "claim_hooks", hooks: ["on_backlog"] });
		const first = prog.app.decide<string>("on_backlog", { depth: 9, workers: 2 });
		const hook = await k1.next(isType("hook"));
		expect((await k1.request({ type: "release_hooks", hooks: ["on_backlog"] })).data).toEqual({
			released: ["on_backlog"],
		});
		expect(await first).toBe("wait");
		expect(prog.records().at(-1)).toMatchObject({
			act: "decision",
			id: hook.id,
			outcome: "default",
			cause: "detached",
			conn: "k1",
		});
		// k2 takes the claim and then goes away with a decision open: the program is still attached through k1
		await k2.request({ type: "claim_hooks", hooks: ["on_backlog"] });
		const second = prog.app.decide<string>("on_backlog", { depth: 9, workers: 2 });
		await k2.next(isType("hook"));
		k2.close();
		expect(await second).toBe("wait");
		expect(prog.records().at(-1)).toMatchObject({ outcome: "default", cause: "detached", conn: "k2" });
		expect(prog.app.attached).toBe(true);
		await waitFor(() => prog.endpoint.connectionIds().length === 1, "k2 to be gone");
		expect(prog.endpoint.connectionIds()).toEqual(["k1"]);
		// a context that cannot cross: the claimant is told, and the default applies as invalid
		await k1.request({ type: "claim_hooks", hooks: ["on_backlog"] });
		const context = { depth: 1n as unknown as number, workers: 1 };
		await expect(prog.app.decide<string>("on_backlog", context)).resolves.toBe("wait");
		expect(await k1.next(isType("hook_rejected"))).toMatchObject({
			hook: "on_backlog",
			error: expect.stringMatching(/serialized/),
		});
		expect(prog.records().at(-1)).toMatchObject({ outcome: "default", cause: "invalid" });
	});

	test("turns and touchpoints are broadcast; the first end settles one; a turn ends on its own at its timeout", async () => {
		const prog = await program();
		const k1 = await connect(prog.endpoint.socketPath);
		const k2 = await connect(prog.endpoint.socketPath);
		const turning = prog.app.turn("end_of_batch");
		const [t1, t2] = await Promise.all([k1.next(isType("turn")), k2.next(isType("turn"))]);
		expect(t1).toMatchObject({ name: "end_of_batch", content: "Batch is done.\n" });
		expect(t1.timeoutMs as number).toBeLessThanOrEqual(1000);
		expect(t2.id).toBe(t1.id);
		k2.send({ type: "turn_end", id: t1.id });
		await turning;
		expect(prog.records().at(-1)).toMatchObject({ act: "turn", name: "end_of_batch", conn: "k2", outcome: "ok" });

		const started = Date.now();
		await prog.app.turn("end_of_batch");
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
		expect(prog.records().at(-1)).toMatchObject({ act: "turn", outcome: "default", cause: "timeout" });

		// the program is attached, so session() reaches the binding's touchpoint and is broadcast
		const session = prog.app.session();
		const [p1, p2] = await Promise.all([k1.next(isType("touchpoint")), k2.next(isType("touchpoint"))]);
		expect(p1).toMatchObject({ kind: "session", content: "Welcome to endy.\n" });
		expect(p2.id).toBe(p1.id);
		k1.send({ type: "touchpoint_end", id: p1.id });
		await session;
		expect(prog.app.attached).toBe(true);
	});

	test("a harness that connects while a touchpoint is open is told at once, and may end it", async () => {
		const prog = await program();
		const k1 = await connect(prog.endpoint.socketPath);
		const session = prog.app.session();
		const first = await k1.next(isType("touchpoint"));
		const k2 = await connect(prog.endpoint.socketPath);
		const replayed = await k2.next(isType("touchpoint"));
		expect(replayed.id).toBe(first.id);
		k2.send({ type: "touchpoint_end", id: first.id });
		await session;
		// ended: a third connection is not told about it again
		const k3 = await connect(prog.endpoint.socketPath);
		expect((await k3.request({ type: "ping" })).success).toBe(true);
		expect(k3.lines.filter(isType("touchpoint"))).toHaveLength(0);
	});

	test("the last connection leaving detaches: open work settles as detached, and a new connection attaches again", async () => {
		const prog = await program();
		const k1 = await connect(prog.endpoint.socketPath);
		await k1.request({ type: "claim_hooks", hooks: ["on_backlog"] });
		const deciding = prog.app.decide<string>("on_backlog", { depth: 9, workers: 2 });
		const turning = prog.app.turn("end_of_batch");
		const session = prog.app.session();
		await k1.next(isType("touchpoint"));
		k1.close();
		expect(await deciding).toBe("wait");
		await turning;
		await session;
		await waitFor(() => !prog.app.attached, "the program to be detached");
		expect(prog.app.attachError).toMatch(/last harness connection closed/);
		// the decision and the turn settle as detached; a touchpoint is not an act of control and is not audited
		const settled = prog
			.records()
			.slice(-2)
			.map((r) => `${r.act}:${r.outcome}:${r.cause}:${r.conn}`);
		// the decision's claimant was k1; the turn was nobody's to end, so it is audited under the endpoint's own label
		expect(settled).toEqual(["decision:default:detached:k1", "turn:default:detached:endpoint"]);
		expect(
			prog
				.records()
				.filter((r) => r.act === "decision")
				.at(-1),
		).toMatchObject({ cause: "detached", conn: "k1" });
		// detached, an emit does nothing and nothing is queued for later
		prog.app.event("job.failed").emit({ job_id: "j9", error: "x" });

		// the connection is restored when a harness connects again (section 6.3)
		const k2 = await connect(prog.endpoint.socketPath);
		expect(k2.hello.connection).toBe("k2");
		expect(prog.app.attached).toBe(true);
		expect((await k2.request({ type: "get_cells" })).success).toBe(true);
		expect(k2.lines.filter(isType("event"))).toHaveLength(0);
	});
});

describe("the sidecar endpoint: the lifecycle channel", () => {
	test("status; a cooperative pause holds a decision and a turn until the resume, and the agent is told", async () => {
		const prog = await program({}, {}, { lifecycle: { pause: "cooperative" } });
		const raw = await connect(prog.endpoint.socketPath);
		expect((await raw.request({ type: "lifecycle", op: "status" })).data).toMatchObject({
			pid: process.pid,
			name: "endy",
			mode: "sidecar",
			connections: 1,
			paused: false,
			launched: false,
		});
		await raw.request({ type: "claim_hooks", hooks: ["on_backlog"] });
		expect(await raw.request({ type: "lifecycle", op: "pause" }, { reason: "hold it" })).toMatchObject({
			success: true,
			data: { op: "pause", done: true },
		});
		expect(prog.app.paused).toBe(true);
		// the program reaches a decision and a turn while paused: both wait, and the harness hears why
		const deciding = prog.app.decide<string>("on_backlog", { depth: 9, workers: 2 });
		const turning = prog.app.turn("end_of_batch");
		const blocked = await raw.next((l) => l.type === "event" && (l.event as Line).type === "abai.pause.blocked");
		expect((blocked.event as Line).touchpoint).toBe("on_backlog");
		await sleep(150);
		expect(raw.lines.filter(isType("hook"))).toHaveLength(0);
		expect(raw.lines.filter(isType("turn"))).toHaveLength(0);
		// resume: the decision is asked now, and its wait starts now (the turn too)
		const resumedAt = Date.now();
		expect((await raw.request({ type: "lifecycle", op: "resume" }, { reason: "go on" })).success).toBe(true);
		const hook = await raw.next(isType("hook"));
		expect(hook.timeoutMs as number).toBeGreaterThan(900);
		raw.send({ type: "hook_response", id: hook.id, result: "wait", reason: "fine" });
		expect(await deciding).toBe("wait");
		const turn = await raw.next(isType("turn"));
		raw.send({ type: "turn_end", id: turn.id });
		await turning;
		expect(Date.now() - resumedAt).toBeLessThan(900);
		const acts = prog.records().map((r) => `${r.act}:${r.name}:${r.outcome}:${r.conn}`);
		expect(acts).toContain("lifecycle:pause:ok:k1");
		expect(acts).toContain("lifecycle:resume:ok:k1");
		expect(prog.records().find((r) => r.act === "lifecycle")).toMatchObject({ reason: "hold it" });
	});

	test("pause is refused where the manifest declares os or no pause; stop needs consent and a handler", async () => {
		let stopped = 0;
		const prog = await program(
			{},
			{},
			{
				lifecycle: {
					pause: "os",
					stop: {
						graceful: "1s",
						handler: () => {
							stopped += 1;
						},
					},
				},
			},
		);
		const raw = await connect(prog.endpoint.socketPath);
		expect(await raw.request({ type: "lifecycle", op: "pause" }, { reason: "r" })).toMatchObject({
			success: false,
			code: "invalid",
			error: expect.stringMatching(/os pause/),
		});
		expect(await raw.request({ type: "lifecycle", op: "stop" }, { reason: "r" })).toMatchObject({
			success: false,
			code: "denied",
		});
		expect(stopped).toBe(0);
		// with consent the handler runs at the next safepoint, which the program reaches here
		expect(
			(await raw.request({ type: "lifecycle", op: "stop" }, { reason: "done", consent: "approved" })).success,
		).toBe(true);
		prog.app.safepoint();
		expect(stopped).toBe(1);
		expect(
			await raw.request({ type: "lifecycle", op: "restart" }, { reason: "r", consent: "approved" }),
		).toMatchObject({
			success: false,
			code: "invalid",
			error: expect.stringMatching(/launcher/),
		});
		expect(await raw.request({ type: "lifecycle", op: "nothing" }, { reason: "r" })).toMatchObject({
			code: "unknown",
		});
		const acts = prog.records().map((r) => `${r.act}:${r.name}:${r.outcome}:${r.cause ?? ""}:${r.consent ?? ""}`);
		expect(acts).toContain("lifecycle:pause:error:invalid:");
		expect(acts).toContain("lifecycle:stop:error:denied:");
		expect(acts).toContain("lifecycle:stop:ok::approved");
		// no pause declared at all: also invalid; no handler: stop is invalid too
		const bare = await program();
		const k = await connect(bare.endpoint.socketPath);
		expect(await k.request({ type: "lifecycle", op: "pause" }, { reason: "r" })).toMatchObject({ code: "invalid" });
		expect(await k.request({ type: "lifecycle", op: "stop" }, { reason: "r", consent: "auto" })).toMatchObject({
			code: "invalid",
			error: expect.stringMatching(/no stop handler/),
		});
	});

	test("a pause ends with the connection that set it, and a stop supersedes a pause", async () => {
		let stopped = 0;
		const prog = await program(
			{},
			{},
			{
				lifecycle: {
					pause: "cooperative",
					stop: {
						graceful: "1s",
						handler: () => {
							stopped += 1;
						},
					},
				},
			},
		);
		const k1 = await connect(prog.endpoint.socketPath);
		expect((await k1.request({ type: "lifecycle", op: "pause" }, { reason: "hold" })).success).toBe(true);
		const held = prog.app.turn("end_of_batch");
		await k1.next((l) => l.type === "event" && (l.event as Line).type === "abai.pause.blocked");
		// the harness goes: the program runs as itself again, and the held turn is counted, not kept waiting
		k1.close();
		await held;
		expect(prog.app.paused).toBe(false);
		expect(prog.app.attached).toBe(false);
		// a new harness pauses it again; its stop lifts the pause so the program reaches the handler's safepoint
		const k2 = await connect(prog.endpoint.socketPath);
		expect((await k2.request({ type: "lifecycle", op: "pause" }, { reason: "hold" })).success).toBe(true);
		const turning = prog.app.turn("end_of_batch");
		await k2.next((l) => l.type === "event" && (l.event as Line).type === "abai.pause.blocked");
		expect(
			await k2.request({ type: "lifecycle", op: "stop" }, { reason: "done", consent: "approved" }),
		).toMatchObject({ success: true, data: { op: "stop", requested: true } });
		expect(prog.app.paused).toBe(false);
		const turn = await k2.next(isType("turn"));
		k2.send({ type: "turn_end", id: turn.id });
		await turning;
		prog.app.safepoint();
		expect(stopped).toBe(1);
	});

	test("a turn ended with a cause is audited as a default with that cause", async () => {
		const prog = await program();
		const raw = await connect(prog.endpoint.socketPath);
		const turning = prog.app.turn("end_of_batch");
		const turn = await raw.next(isType("turn"));
		raw.send({ type: "turn_end", id: turn.id, cause: "budget" });
		await turning;
		expect(prog.records().at(-1)).toMatchObject({ act: "turn", outcome: "default", cause: "budget", conn: "k1" });
	});
});

describe("the endpoint's readiness", () => {
	test("closed before it listens, ready rejects rather than waiting forever; a run dir that cannot be made rejects too", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ep-ready-"));
		dirs.push(dir);
		const app = createAbaigram(declarations(), {
			env: { ABAI_HARNESS: "", ABAI_MODE: "turns" },
			root: dir,
			auditPath: join(dir, "a.jsonl"),
		});
		const early = new Endpoint(app, { runDir: join(dir, "run") });
		early.close("test closes it at once");
		await expect(early.ready).rejects.toThrow(/closes it at once/);
		writeFileSync(join(dir, "not-a-dir"), "x");
		const blocked = new Endpoint(app, { runDir: join(dir, "not-a-dir") });
		endpoints.push(blocked);
		await expect(blocked.ready).rejects.toThrow(/ENOTDIR|EEXIST|not a directory/);
	});
});

describe("the sidecar attach: the program spawns the harness binary at a touchpoint", () => {
	/** A stand-in for the harness binary, as a script run under this node. */
	function standIn(dir: string, name: string, body: string): string {
		const path = join(dir, `${name}.mjs`);
		writeFileSync(path, body);
		chmodSync(path, 0o755);
		return path;
	}

	const CONNECTING = `
import { createConnection } from "node:net";
const target = process.argv[process.argv.indexOf("--target") + 1];
const socket = createConnection(target);
let buffer = "";
socket.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let at = buffer.indexOf("\\n");
	while (at >= 0) {
		const line = JSON.parse(buffer.slice(0, at));
		buffer = buffer.slice(at + 1);
		at = buffer.indexOf("\\n");
		if (line.type === "touchpoint") socket.write(JSON.stringify({ type: "touchpoint_end", id: line.id }) + "\\n");
	}
});
socket.on("close", () => process.exit(0));
`;

	async function sidecar(env: NodeJS.ProcessEnv): Promise<Program> {
		return program({}, env);
	}

	test("a binary that connects serves the touchpoint: the session returns with the program attached", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ep-bin-"));
		dirs.push(dir);
		const prog = await sidecar({ ABAI_HARNESS_BIN: standIn(dir, "connecting", CONNECTING) });
		expect(prog.app.attached).toBe(false);
		await prog.app.session();
		expect(prog.app.attached).toBe(true);
		expect(prog.app.attachError).toBeUndefined();
		expect(prog.endpoint.connectionIds()).toEqual(["k1"]);
		// a second touchpoint finds the harness already connected: nothing is spawned again
		await prog.app.install();
		expect(prog.endpoint.connectionIds()).toEqual(["k1"]);
	}, 15_000);

	test("a binary that exits before connecting fails the attach at once, with its code, not at the wait", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ep-bin-"));
		dirs.push(dir);
		const prog = await sidecar({
			ABAI_HARNESS_BIN: standIn(dir, "failing", "process.exit(3);\n"),
			ABAI_ATTACH_WAIT_MS: "20000",
		});
		const started = Date.now();
		await prog.app.session();
		expect(Date.now() - started).toBeLessThan(5000);
		expect(prog.app.attached).toBe(false);
		expect(prog.app.attachError).toBe("the harness binary exited with 3 before connecting");
	}, 15_000);

	test("a binary that never connects is ended at the wait, and the attach fails with the reason", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ep-bin-"));
		dirs.push(dir);
		const prog = await sidecar({
			ABAI_HARNESS_BIN: standIn(dir, "idle", "setTimeout(() => {}, 30_000);\n"),
			ABAI_ATTACH_WAIT_MS: "300",
		});
		await prog.app.install();
		expect(prog.app.attached).toBe(false);
		expect(prog.app.attachError).toMatch(/did not connect within 300 ms/);
	}, 15_000);

	test("a binary that cannot be started fails the attach with the reason", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ep-bin-"));
		dirs.push(dir);
		const prog = await sidecar({ ABAI_HARNESS_BIN: join(dir, "nothing-here") });
		await prog.app.session();
		expect(prog.app.attached).toBe(false);
		expect(prog.app.attachError).toMatch(/could not be started: ENOENT/);
	}, 15_000);
});

describe("the sidecar endpoint and the program's event loop", () => {
	const fixture = resolve(import.meta.dirname, "fixtures/endpoint-program.ts");

	function child(what: string, withStdin = false) {
		const dir = mkdtempSync(join(tmpdir(), "ep-child-"));
		dirs.push(dir);
		const proc = spawn(process.execPath, [fixture, what], {
			env: { ...process.env, FIXTURE_RUN_DIR: join(dir, "run"), FIXTURE_AUDIT: join(dir, "audit.jsonl") },
			stdio: [withStdin ? "pipe" : "ignore", "pipe", "pipe"],
		});
		children.push(proc);
		const out: string[] = [];
		const err: string[] = [];
		createInterface({ input: proc.stdout as NodeJS.ReadableStream }).on("line", (line) => out.push(line));
		proc.stderr?.on("data", (chunk) => err.push(String(chunk)));
		const exited = new Promise<number | null>((done) => proc.once("exit", (code) => done(code)));
		return { proc, out, err, exited };
	}

	test("a program whose work is done exits with a harness still connected", async () => {
		const { out, err, exited } = child("exit");
		const ready = await waitFor(() => out.find((l) => l.startsWith("ready ")), `ready (stderr: ${err.join("")})`);
		const raw = await connect(ready.slice("ready ".length));
		await raw.next(isType("event"));
		const started = Date.now();
		expect(await exited).toBe(0);
		expect(Date.now() - started).toBeLessThan(3000);
		expect(err.join("")).toBe("");
		await waitFor(() => raw.closed, "the connection to close");
	}, 15_000);

	test("a program held by a cooperative pause stays alive until the resume, then its touchpoint proceeds", async () => {
		const { proc, out, err, exited } = child("paused-session", true);
		const ready = await waitFor(() => out.find((l) => l.startsWith("ready ")), `ready (stderr: ${err.join("")})`);
		const raw = await connect(ready.slice("ready ".length));
		expect((await raw.request({ type: "lifecycle", op: "pause" }, { reason: "hold" })).success).toBe(true);
		proc.stdin?.end("go\n");
		await waitFor(() => out.includes("going paused=true"), "the program to reach its session");
		await raw.next((l) => l.type === "event" && (l.event as Line).type === "abai.pause.blocked");
		// nothing of its own is pending and the sockets are unref'd: without the keep-alive it would be gone by now
		await sleep(400);
		expect(proc.exitCode).toBeNull();
		expect(raw.lines.filter(isType("touchpoint"))).toHaveLength(0);
		expect((await raw.request({ type: "lifecycle", op: "resume" }, { reason: "go" })).success).toBe(true);
		const touchpoint = await raw.next(isType("touchpoint"));
		raw.send({ type: "touchpoint_end", id: touchpoint.id });
		await waitFor(() => out.includes("session ended attached=true"), "the session to end");
		expect(await exited).toBe(0);
	}, 15_000);

	test("a graceful stop runs the program's handler, which ends the program", async () => {
		const { out, err, exited } = child("stop");
		const ready = await waitFor(() => out.find((l) => l.startsWith("ready ")), `ready (stderr: ${err.join("")})`);
		const raw = await connect(ready.slice("ready ".length));
		await raw.next(isType("touchpoint"));
		expect(
			(await raw.request({ type: "lifecycle", op: "stop" }, { reason: "enough", consent: "approved" })).success,
		).toBe(true);
		await waitFor(() => out.includes("stopping"), "the stop handler to run");
		expect(await exited).toBe(0);
		expect(out).not.toContain("session ended without a stop");
	}, 15_000);

	test("a program awaiting a touchpoint over the socket stays alive until the harness ends it", async () => {
		const { out, err, exited } = child("session");
		const ready = await waitFor(() => out.find((l) => l.startsWith("ready ")), `ready (stderr: ${err.join("")})`);
		const raw = await connect(ready.slice("ready ".length));
		const touchpoint = await raw.next(isType("touchpoint"));
		expect(touchpoint.kind).toBe("session");
		// with nothing of its own pending, an unguarded program would be gone by now (Node exit 13)
		await sleep(400);
		expect(out).not.toContain("session ended attached=true");
		raw.send({ type: "touchpoint_end", id: touchpoint.id });
		await waitFor(() => out.includes("session ended attached=true"), `the session to end (stderr: ${err.join("")})`);
		expect(await exited).toBe(0);
		expect(err.join("")).toBe("");
	}, 15_000);
});
