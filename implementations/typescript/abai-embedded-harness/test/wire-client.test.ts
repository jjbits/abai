// The wire client against an in-test fake server on a temp Unix socket.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, writeDescriptor } from "@abaigram/stub";
import { afterEach, describe, expect, test } from "vitest";
import { resolveTarget, WireClient, withReason } from "../src/wire/client.ts";

type Rec = Record<string, unknown>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const helloLine = (pid = process.pid) =>
	`${JSON.stringify({
		type: "hello",
		protocol: PROTOCOL_VERSION,
		pid,
		version: "0",
		cwd: "/",
		agentDir: "/",
		mode: "turns",
		capabilities: { hooks: ["decide"], commands: ["ping"] },
		lastSeq: 0,
		connection: "k1",
		abai: { name: "demo", abaigrammar: "1", modes: ["turns"], audit: { path: "/a", failed: null } },
	})}\n`;

describe("WireClient", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	function tempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "w-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		return dir;
	}

	interface Fake {
		server: Server;
		path: string;
		socket: () => Socket;
		received: () => Rec[];
	}

	/**
	 * A raw JSON-lines server: sends hello on connect, answers each request with
	 * a success response echoing the command, and records every line it gets.
	 */
	async function fakeServer(dir: string, options: { hello?: boolean; answer?: boolean } = {}): Promise<Fake> {
		const path = join(dir, "s.sock");
		let current: Socket | undefined;
		const received: Rec[] = [];
		const server = createServer((socket) => {
			current = socket;
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				let index = buffer.indexOf("\n");
				while (index !== -1) {
					const message = JSON.parse(buffer.slice(0, index)) as Rec;
					buffer = buffer.slice(index + 1);
					index = buffer.indexOf("\n");
					received.push(message);
					if (message.type === "request" && options.answer !== false) {
						const command = message.command as Rec;
						socket.write(
							`${JSON.stringify({ type: "response", id: message.id, command: command.type, success: true, data: command })}\n`,
						);
					}
				}
			});
			socket.on("error", () => {});
			if (options.hello !== false) socket.write(helloLine());
		});
		await new Promise<void>((resolve) => server.listen(path, () => resolve()));
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		return {
			server,
			path,
			socket: () => {
				if (!current) throw new Error("no connection");
				return current;
			},
			received: () => received,
		};
	}

	async function connect(fake: Fake): Promise<WireClient> {
		const client = await WireClient.connect(fake.path, { timeoutMs: 2000 });
		cleanups.push(() => client.close());
		return client;
	}

	async function waitFor<T>(get: () => T | undefined): Promise<T> {
		for (let i = 0; i < 200; i++) {
			const value = get();
			if (value !== undefined) return value;
			await sleep(5);
		}
		throw new Error("timed out waiting");
	}

	const answerFor = (fake: Fake, id: string) => () =>
		fake.received().find((m) => m.type === "hook_response" && m.id === id);

	const hook = (id: string, name = "decide") =>
		`${JSON.stringify({ type: "hook", id, hook: name, timeoutMs: 1000, payload: { n: 1 } })}\n`;

	test("connects and reads the hello", async () => {
		const fake = await fakeServer(tempDir());
		const client = await connect(fake);
		expect(client.hello.protocol).toBe(PROTOCOL_VERSION);
		expect(client.hello.abai.name).toBe("demo");
		expect(client.helloLine.startsWith('{"type":"hello"')).toBe(true);
		expect(client.target).toEqual({ socketPath: fake.path });
		expect(client.isClosed).toBe(false);
	});

	test("refuses a wrong protocol version", async () => {
		const dir = tempDir();
		const path = join(dir, "s.sock");
		const server = createServer((socket) => {
			socket.on("error", () => {});
			socket.write(`${JSON.stringify({ type: "hello", protocol: 99, pid: process.pid })}\n`);
		});
		await new Promise<void>((resolve) => server.listen(path, () => resolve()));
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		await expect(WireClient.connect(path, { timeoutMs: 1000 })).rejects.toThrow("wire protocol 99");
	});

	test("a request round trip carries the reason on the wire; subscribe sends the filter", async () => {
		const fake = await fakeServer(tempDir());
		const client = await connect(fake);
		const response = await client.request({ type: "set_cell", name: "speed", value: 3 }, { reason: "too slow" });
		expect(response).toMatchObject({ type: "response", command: "set_cell", success: true });
		const sent = fake.received().find((m) => m.type === "request" && (m.command as Rec).type === "set_cell");
		expect(sent).toMatchObject({ reason: "too slow", command: { name: "speed", value: 3 } });
		const capability = await client.request({ type: "my_capability", x: 1 });
		expect(capability.success).toBe(true);
		const subscribed = await client.subscribe({ include: ["tick"] });
		expect(subscribed.success).toBe(true);
		expect(fake.received().at(-1)).toMatchObject({ command: { type: "subscribe", include: ["tick"] } });
		expect(fake.received().at(-1)).not.toHaveProperty("reason");
	});

	test("pushed events reach listeners; unsubscribe stops them", async () => {
		const fake = await fakeServer(tempDir());
		const client = await connect(fake);
		const seen: string[] = [];
		const off = client.on("event", (message) => seen.push(message.event.type));
		client.release();
		fake.socket().write(`${JSON.stringify({ type: "event", seq: 1, ts: 0, event: { type: "tick" } })}\n`);
		await waitFor(() => (seen.length > 0 ? true : undefined));
		off();
		fake.socket().write(`${JSON.stringify({ type: "event", seq: 2, ts: 0, event: { type: "tock" } })}\n`);
		await client.request({ type: "ping" });
		expect(seen).toEqual(["tick"]);
	});

	test("a claimed hook is answered by the handler with its reason", async () => {
		const fake = await fakeServer(tempDir());
		const client = await connect(fake);
		const claimed = await client.claimHooks(
			["decide"],
			(message) => withReason({ pick: (message.payload as Rec).n }, "the first"),
			{ fallback: () => ({ pick: 0 }) },
		);
		expect(claimed.success).toBe(true);
		fake.socket().write(hook("h1"));
		expect(await waitFor(answerFor(fake, "h1"))).toEqual({
			type: "hook_response",
			id: "h1",
			result: { pick: 1 },
			reason: "the first",
		});
	});

	test("a handler returning null sends the fallback", async () => {
		const fake = await fakeServer(tempDir());
		const client = await connect(fake);
		await client.claimHooks(["decide"], () => null, { fallback: (message) => ({ default: message.hook }) });
		fake.socket().write(hook("h1"));
		const answer = await waitFor(answerFor(fake, "h1"));
		expect(answer.result).toEqual({ default: "decide" });
		expect(answer).not.toHaveProperty("reason");
	});

	test("a handler that throws sends the fallback with the failure as the reason", async () => {
		const fake = await fakeServer(tempDir());
		const client = await connect(fake);
		const errors: string[] = [];
		client.on("error", (error) => errors.push(error.message));
		await client.claimHooks(
			["decide"],
			() => {
				throw new Error("broke");
			},
			{ fallback: () => ({ pick: 0 }) },
		);
		fake.socket().write(hook("h1"));
		expect(await waitFor(answerFor(fake, "h1"))).toMatchObject({
			result: { pick: 0 },
			reason: "handler failed: broke",
		});
		expect(errors.some((e) => e.includes("broke"))).toBe(true);
	});

	test("an unserializable result falls back; a failed re-claim keeps the earlier handler", async () => {
		const fake = await fakeServer(tempDir(), { answer: false });
		const client = await connect(fake);
		const errors: string[] = [];
		client.on("error", (error) => errors.push(error.message));
		const cyclic: Rec = {};
		cyclic.self = cyclic;
		const first = client.claimHooks(["decide"], () => cyclic, { fallback: () => ({ pick: 0 }) });
		fake.socket().write('{"type":"response","id":"c1","command":"claim_hooks","success":true}\n');
		expect((await first).success).toBe(true);
		const second = client.claimHooks(["decide"], () => ({ pick: 2 }), { fallback: () => ({ pick: 9 }) });
		fake.socket().write('{"type":"response","id":"c2","command":"claim_hooks","success":false,"error":"held"}\n');
		expect((await second).success).toBe(false);
		fake.socket().write(hook("h1"));
		expect((await waitFor(answerFor(fake, "h1"))).result).toEqual({ pick: 0 });
		expect(errors.some((e) => e.includes("could not be serialized"))).toBe(true);
	});

	test("hook_timeout, hook_rejected and hook_claims_released surface", async () => {
		const fake = await fakeServer(tempDir());
		const client = await connect(fake);
		const got: string[] = [];
		client.on("hook_timeout", (m) => got.push(`timeout ${m.id}`));
		client.on("hook_rejected", (m) => got.push(`rejected ${m.id}`));
		client.on("hook_claims_released", (m) => got.push(`released ${m.hooks.join(",")}`));
		client.on("snapshot", (m) => got.push(`snapshot ${String(m.seq)}`));
		client.release();
		const s = fake.socket();
		s.write('{"type":"hook_timeout","hook":"decide","id":"h1"}\n');
		s.write('{"type":"hook_rejected","hook":"decide","id":"h2","error":"bad"}\n');
		s.write('{"type":"hook_claims_released","reason":"three timeouts","hooks":["decide"]}\n');
		s.write('{"type":"snapshot","seq":4,"ts":0,"session":{}}\n');
		await waitFor(() => (got.length === 4 ? true : undefined));
		expect(got).toEqual(["timeout h1", "rejected h2", "released decide", "snapshot 4"]);
	});

	test("what arrives after hello is held until the consumer is wired, and delivered in order", async () => {
		const fake = await fakeServer(tempDir());
		const client = await connect(fake);
		const s = fake.socket();
		// a program at a touchpoint speaks at once: these can share hello's own chunk, before any listener exists
		s.write(
			`${JSON.stringify({ type: "touchpoint", id: "p1", kind: "session" })}\n${JSON.stringify({
				type: "event",
				seq: 1,
				ts: 0,
				event: { type: "early" },
			})}\n`,
		);
		await client.request({ type: "ping" });
		const got: string[] = [];
		client.on("touchpoint", (m) => got.push(`touchpoint ${m.id}`));
		client.on("event", (m) => got.push(`event ${m.event.type}`));
		client.on("turn", (m) => got.push(`turn ${m.id}`));
		expect(got).toEqual([]);
		client.release();
		expect(got).toEqual(["touchpoint p1", "event early"]);
		// live from here on, in order with what was held
		s.write(`${JSON.stringify({ type: "turn", id: "t1", name: "end_of_batch", timeoutMs: 1000 })}\n`);
		await waitFor(() => (got.length === 3 ? true : undefined));
		expect(got[2]).toBe("turn t1");
		client.send({ type: "turn_end", id: "t1" });
		await waitFor(() => fake.received().find((m) => m.type === "turn_end"));
		expect(fake.received().find((m) => m.type === "turn_end")).toEqual({ type: "turn_end", id: "t1" });
	});

	test("a released hook loses its handler", async () => {
		const fake = await fakeServer(tempDir(), { answer: false });
		const client = await connect(fake);
		const errors: string[] = [];
		client.on("error", (error) => errors.push(error.message));
		const claim = client.claimHooks(["decide"], () => ({ pick: 1 }), { fallback: () => ({ pick: 0 }) });
		fake.socket().write('{"type":"response","id":"c1","command":"claim_hooks","success":true}\n');
		await claim;
		const release = client.releaseHooks(["decide"]);
		fake
			.socket()
			.write(
				'{"type":"response","id":"c2","command":"release_hooks","success":true,"data":{"released":["decide"]}}\n',
			);
		expect((await release).success).toBe(true);
		fake.socket().write(hook("h1"));
		await waitFor(() => (errors.some((e) => e.includes("without a handler")) ? true : undefined));
		expect(answerFor(fake, "h1")()).toBeUndefined();
	});

	test("a malformed server line is reported, not fatal", async () => {
		const fake = await fakeServer(tempDir());
		const client = await connect(fake);
		const errors: string[] = [];
		client.on("error", (error) => errors.push(error.message));
		fake.socket().write("{oops\n");
		fake.socket().write("[1]\n");
		await waitFor(() => (errors.length === 2 ? true : undefined));
		expect(errors[0].startsWith("malformed line")).toBe(true);
		expect(errors[1].startsWith("message without a type")).toBe(true);
		expect(client.isClosed).toBe(false);
		expect((await client.request({ type: "ping" })).success).toBe(true);
	});

	test("close rejects pending requests; a request timeout rejects on its own", async () => {
		const fake = await fakeServer(tempDir(), { answer: false });
		const client = await connect(fake);
		await expect(client.request({ type: "ping" }, { timeoutMs: 50 })).rejects.toThrow(
			"request ping timed out after 50 ms",
		);
		let closed: Error | undefined | null = null;
		client.on("close", (error) => {
			closed = error;
		});
		const pending = client.request({ type: "ping" });
		await waitFor(() => (fake.received().length === 2 ? true : undefined));
		fake.socket().destroy();
		await expect(pending).rejects.toThrow("connection closed");
		await waitFor(() => (closed === null ? undefined : true));
		expect(closed).toBeUndefined();
		expect(client.isClosed).toBe(true);
		await expect(client.request({ type: "ping" })).rejects.toThrow("connection closed");
	});

	test("resolveTarget by socket path, by pid and the one program; errors otherwise", async () => {
		const dir = tempDir();
		const fake = await fakeServer(dir);
		expect(resolveTarget(fake.path)).toEqual({ socketPath: fake.path });
		expect(resolveTarget("x.sock")).toEqual({ socketPath: "x.sock" });
		expect(() => resolveTarget("what", dir)).toThrow("target must be a socket path or a pid");

		const runDir = join(dir, "run");
		expect(() => resolveTarget(undefined, runDir)).toThrow("no program is running");
		mkdirSync(runDir);
		writeDescriptor(runDir, {
			pid: process.pid,
			socket: fake.path,
			cwd: "/",
			name: "demo",
			mode: "turns",
			startedAt: "",
		});
		expect(resolveTarget(process.pid, runDir)).toEqual({ socketPath: fake.path, pid: process.pid });
		expect(resolveTarget(String(process.pid), runDir)).toEqual({ socketPath: fake.path, pid: process.pid });
		expect(resolveTarget(undefined, runDir)).toEqual({ socketPath: fake.path, pid: process.pid });
		expect(() => resolveTarget(process.pid + 100_000, runDir)).toThrow("no program with pid");
		expect(WireClient.listPrograms(runDir).map((d) => d.pid)).toEqual([process.pid]);

		const byPid = await WireClient.connect(process.pid, { runDir, timeoutMs: 2000 });
		cleanups.push(() => byPid.close());
		expect(byPid.hello.pid).toBe(process.pid);
		const auto = await WireClient.connect(undefined, { runDir, timeoutMs: 2000 });
		cleanups.push(() => auto.close());
		expect(auto.target).toEqual({ socketPath: fake.path, pid: process.pid });
	});
});
