// The socket transport against an in-test wire v1 endpoint: every channel
// of abaigrammar section 6.3 crosses a real Unix socket as LF-framed JSON,
// and the harness core drives it exactly as it drives the direct transport.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AbaigramOptions,
	createAbaigram,
	ensureRunDir,
	type Manifest,
	PROTOCOL_VERSION,
	writeDescriptor,
} from "@abaigram/abai-stub";
import { afterEach, describe, expect, test } from "vitest";
import { Harness } from "../src/harness.ts";
import { defaultOptions } from "../src/options.ts";
import { TransportCallError, type TransportDecision, type TransportEvent } from "../src/transport.ts";
import { SocketTransport } from "../src/transport-socket.ts";

function declarations(): AbaigramOptions {
	return {
		name: "socky",
		modes: ["sidecar"],
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
				handler: () => ({ ok: true }),
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
			on_input: {
				context: { text: "string" },
				answer: { action: "string" },
				default: { action: "continue" },
				timeout: "2m",
				doc: "Asked when input arrives.",
			},
			forbidden_one: {
				context: {},
				options: ["a", "b"],
				default: "a",
				timeout: "10s",
				policy: "forbid",
				doc: "Never asked.",
			},
		},
	};
}

type Line = Record<string, unknown>;

interface Fake {
	socketPath: string;
	runDir: string;
	manifest: Manifest;
	/** Every parsed client line, in order. */
	lines: Line[];
	/** Hooks the connection holds, as the server tracks them. */
	claims: Set<string>;
	connections: number;
	/** What hello reports as pid. */
	helloPid: number;
	/** What hello offers as claimable hooks; default: every decision policy does not forbid. */
	claimable: string[];
	/** What hello advertises; a v1-core host advertises none. */
	extensions: string[];
	/** Lines the server writes right after hello, in hello's own chunk. */
	withHello: unknown[];
	/** Command types the server never answers. */
	stall: Set<string>;
	/** The value of queue.depth. */
	depth: number;
	push(message: unknown): void;
	/** Push an event; `seq` overrides the next number (a host-wide gap). */
	event(name: string, payload: Line, seq?: number): void;
	/** The next client line matching `predicate`, waiting for it. */
	next(predicate: (line: Line) => boolean, timeoutMs?: number): Promise<Line>;
	close(): void;
}

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `get` returns a value (vitest workers share the machine; a fixed sleep is a flake). */
async function waitFor<T>(get: () => T | undefined | false, what = "the condition"): Promise<T> {
	for (let i = 0; i < 400; i++) {
		const value = get();
		if (value !== undefined && value !== false) return value;
		await sleep(5);
	}
	throw new Error(`timed out waiting for ${what}`);
}

function fakeEndpoint(): Promise<Fake> {
	const dir = mkdtempSync(join(tmpdir(), "ts-"));
	dirs.push(dir);
	const runDir = join(dir, "run");
	const socketPath = join(dir, "p.sock");
	const manifest = createAbaigram(declarations(), { env: { ABAI_HARNESS: "off" }, root: dir }).manifest;
	const lines: Line[] = [];
	const waiters: Array<{ predicate: (line: Line) => boolean; resolve: (line: Line) => void }> = [];
	const claims = new Set<string>();
	const audit: unknown[] = [];
	let current: Socket | undefined;
	let seq = 0;
	const fake: Fake = {
		socketPath,
		runDir,
		manifest,
		lines,
		claims,
		connections: 0,
		helloPid: 424242,
		claimable: manifest.decisions.filter((d) => d.policy !== "forbid").map((d) => d.name),
		extensions: [],
		withHello: [],
		stall: new Set(),
		depth: 3,
		push: (message) => {
			current?.write(`${JSON.stringify(message)}\n`);
		},
		event: (name, payload, at) => {
			seq = at ?? seq + 1;
			fake.push({ type: "event", seq, ts: Date.now(), event: { type: name, ...payload } });
		},
		next: (predicate, timeoutMs = 5000) =>
			new Promise((resolve, reject) => {
				const found = lines.find(predicate);
				if (found) {
					resolve(found);
					return;
				}
				const timer = setTimeout(() => reject(new Error("no such client line in time")), timeoutMs);
				waiters.push({
					predicate,
					resolve: (line) => {
						clearTimeout(timer);
						resolve(line);
					},
				});
			}),
		close: () => {
			current?.destroy();
		},
	};
	const respond = (id: string, command: string, data?: unknown, error?: string) => {
		const response =
			error === undefined
				? { type: "response", id, command, success: true, data }
				: { type: "response", id, command, success: false, error };
		fake.push(response);
	};
	const handle = (line: Line) => {
		if (line.type !== "request") return;
		const id = line.id as string;
		const command = line.command as Line;
		const type = command.type as string;
		if (fake.stall.has(type)) return;
		switch (type) {
			case "ping":
				return respond(id, type, { pid: fake.helloPid, ts: Date.now() });
			case "subscribe":
				return respond(id, type, { include: command.include, exclude: command.exclude });
			case "claim_hooks": {
				const hooks = command.hooks as string[];
				const unknown = hooks.filter((h) => !fake.claimable.includes(h));
				if (unknown.length > 0) return respond(id, type, undefined, `unknown hooks: ${unknown.join(", ")}`);
				for (const h of hooks) claims.add(h);
				return respond(id, type, { hooks: [...claims], timeoutMs: command.timeoutMs ?? 30_000 });
			}
			case "release_hooks": {
				const hooks = (command.hooks as string[] | undefined) ?? [...claims];
				const released = hooks.filter((h) => claims.delete(h));
				return respond(id, type, { released });
			}
			case "get_manifest":
				return respond(id, type, { manifest });
			case "get_content":
				return respond(id, type, { identity: "I am socky.", turns: { end_of_batch: "Batch is done." } });
			case "get_audit":
				return respond(id, type, {
					path: join(dir, "audit.jsonl"),
					failed: null,
					records: audit,
					truncated: false,
				});
			case "get_cells":
				return respond(id, type, { seq, cells: { "queue.depth": fake.depth, "worker.count": 4 } });
			case "set_cell": {
				if (command.name !== "worker.count")
					return respond(id, type, undefined, `unknown knob ${String(command.name)}`);
				const value = Math.min(64, Math.max(1, command.value as number));
				audit.push({ act: "knob", name: command.name, value, reason: line.reason, consent: line.consent });
				return respond(id, type, { name: command.name, value });
			}
			case "job.retry":
				audit.push({ act: "capability", name: type, params: { job_id: command.job_id }, reason: line.reason });
				return respond(id, type, { ok: command.job_id === "j1" });
			case "forbidden.one":
				return respond(id, type, undefined, "policy forbids forbidden.one");
			case "boom":
				return respond(id, type, undefined, "permission denied: it broke");
			case "coded":
				fake.push({ type: "response", id, command: type, success: false, error: "no such job", code: "invalid" });
				return;
			case "lifecycle":
				if (command.op === "status") {
					return respond(id, type, {
						pid: fake.helloPid,
						name: "socky",
						mode: "sidecar",
						paused: false,
						launched: false,
					});
				}
				fake.push({ type: "response", id, command: type, success: false, error: "not declared", code: "invalid" });
				return;
			default:
				return respond(id, type, undefined, `Unknown command: ${type}`);
		}
	};
	const server = createServer((socket) => {
		fake.connections += 1;
		current = socket;
		const hello = {
			type: "hello",
			protocol: PROTOCOL_VERSION,
			pid: fake.helloPid,
			cwd: dir,
			mode: "sidecar",
			capabilities: { hooks: fake.claimable, commands: ["job.retry"] },
			lastSeq: seq,
			connection: `k${fake.connections}`,
			abai: {
				name: "socky",
				abaigrammar: "0.1",
				modes: ["sidecar"],
				audit: { path: join(dir, "audit.jsonl"), failed: null },
				...(fake.extensions.length === 0 ? {} : { extensions: fake.extensions }),
			},
		};
		// one write: what a program at a touchpoint says arrives in hello's own chunk
		socket.write([hello, ...fake.withHello].map((m) => `${JSON.stringify(m)}\n`).join(""));
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let at = buffer.indexOf("\n");
			while (at >= 0) {
				const raw = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				at = buffer.indexOf("\n");
				if (raw.trim() === "") continue;
				const line = JSON.parse(raw) as Line;
				lines.push(line);
				for (const waiter of waiters.splice(0)) {
					if (waiter.predicate(line)) waiter.resolve(line);
					else waiters.push(waiter);
				}
				handle(line);
			}
		});
		socket.on("error", () => {});
	});
	servers.push(server);
	return new Promise((resolve) => server.listen(socketPath, () => resolve(fake)));
}

const isRequest = (type: string) => (line: Line) => line.type === "request" && (line.command as Line).type === type;
const isHookResponse = (id: string) => (line: Line) => line.type === "hook_response" && line.id === id;

describe("SocketTransport over wire v1", () => {
	test("connects, maps hello, and refuses its own process", async () => {
		const fake = await fakeEndpoint();
		const transport = await SocketTransport.connect(fake.socketPath);
		expect(transport.hello).toEqual({
			name: "socky",
			abaigrammar: "0.1",
			modes: ["sidecar"],
			pid: 424242,
			cwd: expect.any(String),
			connection: "k1",
			extensions: [],
			claimable: ["on_backlog", "on_input"],
		});
		expect(transport.open).toBe(true);
		expect(transport.denseSeq).toBe(false);
		transport.close("done");
		expect(transport.open).toBe(false);
		await expect(transport.manifest()).rejects.toBeInstanceOf(TransportCallError);

		fake.helloPid = process.pid;
		await expect(SocketTransport.connect(fake.socketPath)).rejects.toThrow(/this process/);
	});

	test("resolves a pid and the one program through descriptors in the run dir", async () => {
		const fake = await fakeEndpoint();
		await expect(SocketTransport.connect(undefined, { runDir: fake.runDir })).rejects.toThrow(
			/no program is running/,
		);
		ensureRunDir(fake.runDir);
		writeDescriptor(fake.runDir, {
			pid: process.pid, // alive, so the descriptor survives pruning; hello must then report it
			socket: fake.socketPath,
			cwd: "/",
			name: "socky",
			mode: "sidecar",
			startedAt: new Date().toISOString(),
		});
		// hello says 424242, the descriptor says this pid: refused rather than trusted
		await expect(SocketTransport.connect(process.pid, { runDir: fake.runDir })).rejects.toThrow(
			/served by pid 424242/,
		);
		fake.helloPid = process.pid;
		// the one program; its hello pid is this process, which the transport refuses: the resolution itself worked
		await expect(SocketTransport.connect(undefined, { runDir: fake.runDir })).rejects.toThrow(/this process/);
	});

	test("manifest, content, cells, knob writes and capability calls cross as v1 requests", async () => {
		const fake = await fakeEndpoint();
		const transport = await SocketTransport.connect(fake.socketPath, { subscribe: { exclude: [] } });
		expect((await fake.next(isRequest("subscribe"))).command).toEqual({ type: "subscribe", exclude: [] });
		expect(await transport.manifest()).toEqual(fake.manifest);
		const content = await transport.content();
		expect(content.identity).toBe("I am socky.");
		expect(content.install).toBeUndefined();
		expect(content.turn("end_of_batch")).toBe("Batch is done.");
		expect(content.turn("other")).toBeUndefined();
		expect(await transport.cells()).toEqual({
			seq: 0,
			cells: { "queue.depth": { value: 3 }, "worker.count": { value: 4 } },
		});
		expect((await transport.cells(["queue.depth"])).cells).toEqual({ "queue.depth": { value: 3 } });

		expect(await transport.setCell("worker.count", 99, "more hands", "approved")).toEqual({
			value: 64,
			outcome: "done",
		});
		const write = await fake.next(isRequest("set_cell"));
		expect(write).toMatchObject({
			reason: "more hands",
			consent: "approved",
			command: { name: "worker.count", value: 99 },
		});
		expect(await transport.setCell("nope", 1, "why")).toEqual({
			value: 1,
			outcome: "failed",
			error: "unknown knob nope",
		});

		expect(await transport.call("job.retry", { job_id: "j1" }, "retry it", 1000)).toEqual({ ok: true });
		const call = await fake.next(isRequest("job.retry"));
		expect(call).toMatchObject({ reason: "retry it", command: { type: "job.retry", job_id: "j1" } });
		await expect(transport.call("forbidden.one", undefined, "r", 1000)).rejects.toMatchObject({ code: "forbidden" });
		await expect(transport.call("nothing", undefined, "r", 1000)).rejects.toMatchObject({ code: "unknown" });
		// a capability's own words are not read for a code: "denied" here is the capability's, not a consent refusal
		await expect(transport.call("boom", undefined, "r", 1000)).rejects.toMatchObject({ code: "error" });
		await expect(transport.call("get_cells", undefined, "r", 1000)).rejects.toMatchObject({ code: "unknown" });
		fake.stall.add("slow");
		await expect(transport.call("slow", undefined, "r", 50)).rejects.toMatchObject({ code: "timeout" });

		const audit = await transport.audit(10);
		expect(audit.records).toEqual([
			{ act: "knob", name: "worker.count", value: 64, reason: "more hands", consent: "approved" },
			{ act: "capability", name: "job.retry", params: { job_id: "j1" }, reason: "retry it" },
		]);
		expect(audit.truncated).toBe(false);
		expect(await transport.events(0)).toEqual({ events: [], dropped: 0, next: 0 });
		transport.close("done");
	});

	test("a library request is bounded: a stalled program yields a timeout, not a hang", async () => {
		const fake = await fakeEndpoint();
		const transport = await SocketTransport.connect(fake.socketPath, { requestTimeoutMs: 60 });
		fake.stall.add("get_cells");
		await expect(transport.cells()).rejects.toMatchObject({ code: "timeout" });
		fake.stall.add("get_manifest");
		await expect(transport.manifest()).rejects.toMatchObject({ code: "timeout" });
		fake.stall.delete("get_cells");
		expect((await transport.cells(["queue.depth"])).cells).toEqual({ "queue.depth": { value: 3 } });
		transport.close("done");
	});

	test("pushed events, snapshots and a closed socket reach the listeners", async () => {
		const fake = await fakeEndpoint();
		const transport = await SocketTransport.connect(fake.socketPath);
		const events: TransportEvent[] = [];
		const closes: Array<string | undefined> = [];
		transport.on("event", (event) => events.push(event));
		transport.on("close", (reason) => closes.push(reason));
		transport.start();
		fake.event("job.failed", { job_id: "j7" });
		fake.push({ type: "snapshot", seq: 2, ts: 5, session: { id: "s1" } });
		fake.push({ type: "serialize_error", seq: 3, ts: 6, eventType: "big", error: "cycle" });
		await waitFor(() => events.length === 3, "three events");
		expect(events).toEqual([
			{ seq: 1, name: "job.failed", payload: { job_id: "j7" }, truncated: false, ts: expect.any(Number) },
			{ seq: 2, name: "snapshot", payload: { session: { id: "s1" } }, truncated: false, ts: 5 },
			{ seq: 3, name: "serialize_error", payload: { event: "big", error: "cycle" }, truncated: true, ts: 6 },
		]);
		expect(await transport.events(0)).toEqual({ events: [], dropped: 0, next: 3 });
		fake.close();
		await waitFor(() => closes.length === 1, "the close");
		expect(transport.open).toBe(false);
		await expect(transport.call("job.retry", {}, "r", 100)).rejects.toMatchObject({ code: "detached" });
	});

	test("claims, decisions answered with reason and consent, the default on null, expiry, rejection, release", async () => {
		const fake = await fakeEndpoint();
		const transport = await SocketTransport.connect(fake.socketPath);
		const decisions: TransportDecision[] = [];
		const expired: string[] = [];
		const rejected: string[] = [];
		const released: string[][] = [];
		transport.on("decision", (d) => decisions.push(d));
		transport.on("decision_timeout", (id) => expired.push(id));
		transport.on("decision_rejected", (id, _name, error) => rejected.push(`${id}:${error}`));
		transport.on("claims_released", (names) => released.push(names));
		transport.start();

		expect(await transport.claim(["on_backlog", "on_input"], 5000)).toEqual(["on_backlog", "on_input"]);
		expect((await fake.next(isRequest("claim_hooks"))).command).toEqual({
			type: "claim_hooks",
			hooks: ["on_backlog", "on_input"],
			timeoutMs: 5000,
		});
		await expect(transport.claim(["nope"])).rejects.toThrow(/unknown hooks: nope/);

		const before = Date.now();
		fake.push({ type: "hook", id: "h1", hook: "on_backlog", timeoutMs: 30_000, payload: { depth: 9, workers: 2 } });
		await waitFor(() => decisions.length === 1, "the decision");
		expect(decisions[0]).toMatchObject({ id: "h1", name: "on_backlog", context: { depth: 9, workers: 2 } });
		expect(decisions[0].deadline).toBeGreaterThanOrEqual(before + 30_000);
		transport.answer("h1", "scale_up", "the queue is deep", "auto");
		expect(await fake.next(isHookResponse("h1"))).toEqual({
			type: "hook_response",
			id: "h1",
			result: "scale_up",
			reason: "the queue is deep",
			consent: "auto",
		});

		// null is "apply the default": the manifest default travels with the reason
		fake.push({ type: "hook", id: "h2", hook: "on_input", timeoutMs: 30_000, payload: { text: "hi" } });
		await waitFor(() => decisions.length === 2, "the second decision");
		transport.answer("h2", null, "nothing to add");
		expect(await fake.next(isHookResponse("h2"))).toEqual({
			type: "hook_response",
			id: "h2",
			result: { action: "continue" },
			reason: "nothing to add",
		});

		// expired before the answer: the harness hears it and a late answer writes nothing
		fake.push({ type: "hook", id: "h3", hook: "on_backlog", timeoutMs: 30_000, payload: {} });
		await waitFor(() => decisions.length === 3, "the third decision");
		fake.push({ type: "hook_timeout", id: "h3", hook: "on_backlog" });
		await waitFor(() => expired.length === 1, "the expiry");
		transport.answer("h3", "wait", "too late");
		await sleep(50); // nothing should arrive
		expect(fake.lines.some(isHookResponse("h3"))).toBe(false);

		// rejected after an answer, and rejected before it was ever asked (an unserializable context)
		fake.push({ type: "hook_rejected", id: "h1", hook: "on_backlog", error: "not an option" });
		fake.push({ type: "hook_rejected", id: "h9", hook: "on_backlog", error: "payload could not be serialized" });
		await waitFor(() => rejected.length === 2, "the rejections");
		expect(rejected).toEqual(["h1:not an option", "h9:never asked: payload could not be serialized"]);

		// claims released by the program while a decision is open: the open one is settled, no late answer
		fake.push({ type: "hook", id: "h4", hook: "on_input", timeoutMs: 30_000, payload: { text: "x" } });
		await waitFor(() => decisions.length === 4, "the fourth decision");
		fake.push({ type: "hook_claims_released", reason: "three timeouts", hooks: ["on_input"] });
		await waitFor(() => released.length === 1, "the release");
		expect(released).toEqual([["on_input"]]);
		transport.answer("h4", { action: "handled" }, "late");
		await sleep(50);
		expect(fake.lines.some(isHookResponse("h4"))).toBe(false);

		expect(await transport.release(["on_backlog"])).toEqual(["on_backlog"]);
		expect((await fake.next(isRequest("release_hooks"))).command).toEqual({
			type: "release_hooks",
			hooks: ["on_backlog"],
		});
		transport.close("done");
	});

	test("the harness core attaches over the socket as it does in-process", async () => {
		const fake = await fakeEndpoint();
		const transport = await SocketTransport.connect(fake.socketPath);
		// a claim timeout longer than the manifest's is clamped to the shortest claimed decision's (30s here)
		const harness = new Harness(defaultOptions("session", { claimTimeoutMs: 999_999 }));
		const hello = await harness.attach(transport);
		expect(hello.name).toBe("socky");
		// every decision the program offers is claimed by default; policy forbid is never asked
		expect((await fake.next(isRequest("claim_hooks"))).command).toEqual({
			type: "claim_hooks",
			hooks: ["on_backlog", "on_input"],
			timeoutMs: 30_000,
		});
		expect(harness.currentClaims()).toEqual(["on_backlog", "on_input"]);
		expect(await harness.cells(["worker.count"])).toEqual({ "worker.count": 4 });
		expect(await harness.setCell("worker.count", 8, "eight is enough")).toBe(8);
		await expect(harness.setCell("worker.count", 0, "zero")).resolves.toBe(1);

		fake.push({ type: "hook", id: "h1", hook: "on_backlog", timeoutMs: 30_000, payload: { depth: 9, workers: 2 } });
		const delivery = await harness.nextDelivery(2000);
		expect(delivery?.text).toContain("on_backlog");
		expect(harness.pendingDecisions().map((d) => d.id)).toEqual(["h1"]);
		expect(() => harness.decide("h1", "fly", "nope")).toThrow(/one of/);
		harness.decide("h1", "shed_oldest", "drop the oldest");
		expect(await fake.next(isHookResponse("h1"))).toMatchObject({ result: "shed_oldest", reason: "drop the oldest" });
		expect(harness.pendingDecisions()).toEqual([]);

		// the program's own validation refused the answer after the fact: the agent is told
		fake.push({ type: "hook_rejected", id: "h1", hook: "on_backlog", error: "not now" });
		const told = await harness.nextDelivery(2000);
		expect(told?.text).toMatch(/rejected by the program \(not now\)/);

		// an event with wakes: always reaches the agent; a gap in the program's host-wide numbering is not a loss
		fake.event("job.failed", { job_id: "j9" }, 7);
		const woke = await harness.nextDelivery(2000);
		expect(woke?.text).toContain("job.failed");
		expect(woke?.text).toContain("j9");
		expect(woke?.text).not.toContain("dropped");
		fake.event("job.failed", { job_id: "j10" }, 40);
		const again = await harness.nextDelivery(2000);
		expect(again?.text).toContain("j10");
		expect(again?.text).not.toContain("dropped");

		fake.close();
		const gone = await harness.nextDelivery(2000);
		expect(gone?.text).toMatch(/disconnected from the program/);
		expect(harness.attached).toBe(false);
		harness.shutdown("test over");
	});

	test("claims follow policy and what the program offers; an explicit claim outside them is refused", async () => {
		const fake = await fakeEndpoint();
		let transport = await SocketTransport.connect(fake.socketPath);
		let harness = new Harness(defaultOptions("session", { claims: ["forbidden_one"] }));
		await expect(harness.attach(transport)).rejects.toThrow(/forbidden by policy/);
		expect(transport.open).toBe(false);

		fake.claimable = ["on_backlog"];
		transport = await SocketTransport.connect(fake.socketPath);
		harness = new Harness(defaultOptions("session", { claims: ["on_input"] }));
		await expect(harness.attach(transport)).rejects.toThrow(/does not offer decision on_input/);

		transport = await SocketTransport.connect(fake.socketPath);
		harness = new Harness(defaultOptions("session"));
		await harness.attach(transport);
		expect(harness.currentClaims()).toEqual(["on_backlog"]);
		harness.shutdown("done");
	});

	test("under the turns extension, turns and touchpoints arrive and are ended on the wire; the truncation flag is read", async () => {
		const fake = await fakeEndpoint();
		fake.extensions = ["turns", "call_codes"];
		const transport = await SocketTransport.connect(fake.socketPath);
		expect(transport.hello.extensions).toEqual(["turns", "call_codes"]);
		const harness = new Harness(defaultOptions("session"));
		await harness.attach(transport);
		fake.push({ type: "turn", id: "t1", name: "end_of_batch", timeoutMs: 30_000, content: "Batch is done." });
		const turn = await harness.nextDelivery(2000);
		expect(turn?.text).toContain("turn t1 end_of_batch");
		expect(turn?.text).toContain("Batch is done.");
		expect(harness.pendingTurnList()).toMatchObject([{ id: "t1", name: "end_of_batch", content: "Batch is done." }]);
		harness.endTurn("t1");
		expect(await fake.next((l) => l.type === "turn_end")).toEqual({ type: "turn_end", id: "t1" });
		expect(harness.pendingTurnList()).toEqual([]);

		fake.push({ type: "touchpoint", id: "p1", kind: "install", content: "Set it up." });
		const install = await harness.nextDelivery(2000);
		expect(install?.text).toContain("install p1");
		harness.endTouchpoint("p1");
		expect(await fake.next((l) => l.type === "touchpoint_end")).toEqual({ type: "touchpoint_end", id: "p1" });

		fake.push({ type: "event", seq: 9, ts: 1, event: { type: "job.failed", job_id: "j9" }, truncated: true });
		const woke = await harness.nextDelivery(2000);
		expect(woke?.text).toContain("(truncated)");
		// the code is explicit under call_codes, where a v1-core host's wording would have read as "error"
		await expect(transport.call("coded", {}, "r", 1000)).rejects.toMatchObject({ code: "invalid" });
		harness.shutdown("done");
	});

	test("a declined decision travels as null under the defaults extension, as the manifest default without it", async () => {
		const fake = await fakeEndpoint();
		fake.extensions = ["defaults"];
		const transport = await SocketTransport.connect(fake.socketPath);
		transport.start();
		await transport.claim(["on_input"]);
		fake.push({ type: "hook", id: "h1", hook: "on_input", timeoutMs: 30_000, payload: { text: "hi" } });
		await fake.next((l) => l.type === "request" && (l.command as Line).type === "claim_hooks");
		await sleep(20);
		transport.answer("h1", null, "nothing to add");
		expect(await fake.next(isHookResponse("h1"))).toEqual({
			type: "hook_response",
			id: "h1",
			result: null,
			reason: "nothing to add",
		});
		transport.close("done");
	});

	test("lifecycle crosses as a request under its extension, with the program's code on a refusal; a turn's end carries its cause", async () => {
		const fake = await fakeEndpoint();
		fake.extensions = ["turns", "lifecycle", "call_codes"];
		const transport = await SocketTransport.connect(fake.socketPath);
		transport.start();
		expect(await transport.lifecycle("status", "look")).toMatchObject({ name: "socky", paused: false });
		expect((await fake.next(isRequest("lifecycle"))).reason).toBe("look");
		await expect(transport.lifecycle("pause", "hold")).rejects.toMatchObject({ code: "invalid" });
		transport.endTurn("t1", "budget");
		expect(await fake.next((l) => l.type === "turn_end")).toEqual({ type: "turn_end", id: "t1", cause: "budget" });
		transport.close("done");
	});

	test("a program that speaks no lifecycle extension has no lifecycle channel", async () => {
		const fake = await fakeEndpoint();
		const transport = await SocketTransport.connect(fake.socketPath);
		transport.start();
		await expect(transport.lifecycle("status", "look")).rejects.toMatchObject({ code: "unknown" });
		expect(fake.lines.some(isRequest("lifecycle"))).toBe(false);
		transport.close("done");
	});

	test("beyond the wake budget a turn is returned at once with cause budget, and nothing is pending", async () => {
		const fake = await fakeEndpoint();
		fake.extensions = ["turns"];
		const transport = await SocketTransport.connect(fake.socketPath);
		const harness = new Harness(defaultOptions("session", { budget: 1 }));
		await harness.attach(transport);
		// the one wake the window allows
		fake.event("job.failed", { job_id: "j1" });
		expect((await harness.nextDelivery(2000))?.text).toContain("j1");
		// a turn now would be held back by the budget: the program gets it back at once instead
		fake.push({ type: "turn", id: "t9", name: "end_of_batch", timeoutMs: 30_000 });
		expect(await fake.next((l) => l.type === "turn_end")).toEqual({ type: "turn_end", id: "t9", cause: "budget" });
		expect(harness.pendingTurnList()).toEqual([]);
		expect(
			harness.ring
				.last(5)
				.map((l) => l.text)
				.join("\n"),
		).toContain("wake budget is spent");
		harness.shutdown("done");
	});

	test("without the turns extension nothing is sent for an end, and a failure's code comes from the wording", async () => {
		const fake = await fakeEndpoint();
		const transport = await SocketTransport.connect(fake.socketPath);
		transport.start();
		transport.endTurn("t1");
		transport.endTouchpoint("p1");
		await expect(transport.call("coded", {}, "r", 1000)).rejects.toMatchObject({ code: "error" });
		await transport.cells();
		expect(fake.lines.some((l) => l.type === "turn_end" || l.type === "touchpoint_end")).toBe(false);
		transport.close("done");
	});

	test("what a program says in hello's own chunk, and before the harness has wired, reaches the harness", async () => {
		const fake = await fakeEndpoint();
		fake.extensions = ["turns"];
		// a program waiting at session() tells the connection at once, and emits before the claim has crossed
		fake.withHello = [
			{ type: "touchpoint", id: "p1", kind: "session", content: "Welcome." },
			{ type: "event", seq: 1, ts: 0, event: { type: "job.failed", job_id: "early" } },
		];
		const transport = await SocketTransport.connect(fake.socketPath);
		const harness = new Harness(defaultOptions("session"));
		await harness.attach(transport);
		// held through connect, manifest, content and the claim; the session touchpoint waits for a front end
		// (the sidecar verbs build theirs after the attach) and wakes nobody, the event wakes the agent
		expect(harness.pendingTouchpointList()).toMatchObject([{ id: "p1", kind: "session", content: "Welcome." }]);
		const woke = await harness.nextDelivery(2000);
		expect(woke?.text).toContain("job.failed");
		expect(woke?.text).toContain("early");
		expect(woke?.text).not.toContain("session");
		expect(await harness.nextDelivery(100)).toBeUndefined();
		// a front end set later takes it
		const sessions: string[] = [];
		harness.onSession = (touchpoint) => sessions.push(touchpoint.id);
		for (const touchpoint of harness.pendingTouchpointList()) harness.onSession(touchpoint);
		expect(sessions).toEqual(["p1"]);
		harness.shutdown("done");
	});

	test("a watch survives a stalled read: the poll gives up at the request timeout and the next one runs", async () => {
		const fake = await fakeEndpoint();
		const transport = await SocketTransport.connect(fake.socketPath, { requestTimeoutMs: 80 });
		const harness = new Harness(defaultOptions("session"));
		await harness.attach(transport);
		fake.stall.add("get_cells");
		harness.addWatch("queue.depth", "changed", undefined, 100);
		await waitFor(() => fake.lines.filter(isRequest("get_cells")).length >= 2, "two stalled polls");
		fake.stall.delete("get_cells");
		const sampled = fake.lines.filter(isRequest("get_cells")).length;
		await waitFor(() => fake.lines.filter(isRequest("get_cells")).length > sampled + 1, "a sample after the stall");
		fake.depth = 5;
		const woke = await harness.nextDelivery(3000);
		expect(woke?.text).toMatch(/watch 1 queue\.depth changed: now 5/);
		harness.shutdown("done");
	});
});
