// Sidecar mode across two processes (abaigrammar section 6.3): a TypeScript
// program under ABAI_MODE=sidecar in a child, the harness in this process
// over the socket transport. The first test is the wire v1 conformance run
// against the TypeScript endpoint (live-arx.test.ts is the same run against
// arx-06); the second puts a faux agent in the loop, answering the program's
// session touchpoint over the socket.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import type { JsonObject, TranscriptContext } from "@arx-06/ai";
import { createModels, type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@arx-06/ai";
import { afterEach, describe, expect, test } from "vitest";
import { SessionForm } from "../src/agent.ts";
import { parseArgs, runMcp } from "../src/bin.ts";
import { Harness } from "../src/harness.ts";
import { defaultOptions } from "../src/options.ts";
import { SocketTransport } from "../src/transport-socket.ts";
import { scriptedChannel } from "../src/user-channel.ts";
import { mcpClient } from "./helpers/jsonrpc.ts";

const fixture = resolve(import.meta.dirname, "fixtures/sidecar-program.ts");

interface Program {
	child: ChildProcess;
	runDir: string;
	socketPath: string;
	lines: string[];
	send(command: string): void;
	expectLine(pattern: RegExp, timeoutMs?: number): Promise<string>;
	records(): Array<Record<string, unknown>>;
}

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function program(extraEnv: NodeJS.ProcessEnv = {}): Promise<Program> {
	const dir = mkdtempSync(join(tmpdir(), "sc-"));
	dirs.push(dir);
	const runDir = join(dir, "run");
	const auditPath = join(dir, "audit.jsonl");
	const child = spawn(process.execPath, [fixture], {
		env: {
			...process.env,
			ABAI_MODE: "sidecar",
			ABAI_RUN_DIR: runDir,
			ABAI_HARNESS: "",
			ABAI_HARNESS_BIN: join(dir, "no-such-harness"),
			ABAI_HOME: join(dir, "home"),
			SIDECAR_AUDIT: auditPath,
			...extraEnv,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);
	const lines: string[] = [];
	const stderr: string[] = [];
	const waiters: Array<{ pattern: RegExp; resolve: (line: string) => void }> = [];
	child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
	createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
		lines.push(line);
		for (const waiter of waiters.splice(0)) {
			if (waiter.pattern.test(line)) waiter.resolve(line);
			else waiters.push(waiter);
		}
	});
	const expectLine = (pattern: RegExp, timeoutMs = 10_000): Promise<string> =>
		new Promise((done, fail) => {
			const found = lines.find((l) => pattern.test(l));
			if (found) {
				done(found);
				return;
			}
			const timer = setTimeout(
				() =>
					fail(
						new Error(`no line matching ${pattern} (stdout: ${lines.join(" | ")}; stderr: ${stderr.join("")})`),
					),
				timeoutMs,
			);
			waiters.push({
				pattern,
				resolve: (line) => {
					clearTimeout(timer);
					done(line);
				},
			});
		});
	const ready = await expectLine(/^ready /);
	return {
		child,
		runDir,
		socketPath: ready.slice("ready ".length),
		lines,
		send: (command) => {
			child.stdin?.write(`${command}\n`);
		},
		expectLine,
		records: () =>
			existsSync(auditPath)
				? readFileSync(auditPath, "utf8")
						.split("\n")
						.filter((l) => l !== "")
						.map((l) => JSON.parse(l) as Record<string, unknown>)
				: [],
	};
}

function lastUserText(context: TranscriptContext): string {
	const last = [...context.messages].reverse().find((m) => m.role === "user");
	if (!last || last.role !== "user") return "";
	return typeof last.content === "string"
		? last.content
		: last.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

const toolUse = (name: string, args: JsonObject) =>
	fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

describe("sidecar mode across two processes", () => {
	test("wire v1 conformance: the harness core drives the TypeScript endpoint through every channel", async () => {
		const prog = await program();
		// the one running program, found through its descriptor in the run directory
		const transport = await SocketTransport.connect(undefined, { runDir: prog.runDir });
		expect(transport.hello).toMatchObject({
			name: "sidey",
			abaigrammar: "0.1",
			modes: ["sidecar", "turns"],
			pid: prog.child.pid,
			connection: "k1",
			extensions: ["consent", "content", "turns", "call_codes", "defaults", "lifecycle"],
			claimable: ["on_backlog"],
		});
		const harness = new Harness(defaultOptions("session"));
		await harness.attach(transport);
		expect(harness.currentClaims()).toEqual(["on_backlog"]);
		expect(harness.identity).toContain("sidey");
		prog.send("attached");
		await prog.expectLine(/^attached true$/);

		expect(await harness.cells()).toEqual({ "queue.depth": 0, "worker.count": 4 });
		expect(await harness.setCell("worker.count", 8, "eight is enough")).toBe(8);
		// job.retry mutates, so its policy is confirm: the harness states the consent it obtained
		await expect(harness.call("job.retry", { job_id: "j1" }, "retry it")).rejects.toMatchObject({ code: "denied" });
		expect(await harness.call("job.retry", { job_id: "j1" }, "retry it", "auto")).toEqual({ ok: true });
		await expect(harness.call("job.retry", { job_id: 7 }, "bad", "auto")).rejects.toMatchObject({ code: "invalid" });

		prog.send("decide");
		const asked = await harness.nextDelivery(5000);
		expect(asked?.text).toContain("on_backlog");
		const pending = harness.pendingDecisions();
		expect(pending).toHaveLength(1);
		expect(pending[0].payload).toEqual({ depth: 20, workers: 8 });
		harness.decide(pending[0].id, "scale_up", "the backlog is growing");
		await prog.expectLine(/^decided scale_up$/);

		// a decision the agent declines: the program applies its default and audits it as a default, not a choice
		prog.send("decide");
		await harness.nextDelivery(5000);
		harness.defaultDecision(harness.pendingDecisions()[0].id, "nothing to add");
		await prog.expectLine(/^decided wait$/);

		prog.send("turn");
		const turn = await harness.nextDelivery(5000);
		expect(turn?.text).toContain("end_of_batch");
		expect(turn?.text).toContain("The batch is done");
		expect(harness.pendingTurnList()).toHaveLength(1);
		harness.endTurn(harness.pendingTurnList()[0].id);
		await prog.expectLine(/^turned$/);

		prog.send("emit j123456789");
		const woke = await harness.nextDelivery(5000);
		expect(woke?.text).toContain("job.failed");
		expect(woke?.text).toContain("j1234567");
		expect(woke?.text).toContain("(truncated)");
		expect(woke?.text).not.toContain("dropped");

		// a session touchpoint is the person's loop, never a wake: with no front end it is held for one
		prog.send("session");
		for (let i = 0; i < 200 && harness.pendingTouchpointList().length === 0; i++)
			await new Promise((r) => setTimeout(r, 10));
		expect(harness.pendingTouchpointList()).toMatchObject([
			{ kind: "session", content: expect.stringContaining("Welcome") },
		]);
		expect(await harness.nextDelivery(200)).toBeUndefined();
		harness.endTouchpoint(harness.pendingTouchpointList()[0].id);
		await prog.expectLine(/^session ended attached=true$/);

		const audit = (await harness.audit(50)) as { records: Array<Record<string, unknown>> };
		const acts = audit.records.map((r) => `${r.act}:${r.name}:${r.conn}:${r.outcome}:${r.cause ?? ""}`);
		expect(acts).toContain("knob:worker.count:k1:ok:");
		expect(acts).toContain("capability:job.retry:k1:ok:");
		expect(acts).toContain("decision:on_backlog:k1:agent:");
		expect(acts).toContain("decision:on_backlog:k1:default:answered");
		expect(audit.records.find((r) => r.cause === "answered")).toMatchObject({ reason: "nothing to add" });
		expect(acts).toContain("turn:end_of_batch:k1:ok:");

		prog.send("exit");
		const gone = await harness.nextDelivery(5000);
		expect(gone?.text).toMatch(/disconnected from the program/);
		expect(harness.attached).toBe(false);
		harness.shutdown("done");
	}, 30_000);

	test("a faux agent in this process decides, takes a turn and holds a session for a program in another", async () => {
		const prog = await program();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const steps: FauxResponseStep[] = [
			(context) => {
				const id = /decision (d\d+) on_backlog/.exec(lastUserText(context))?.[1];
				if (!id) throw new Error(`no decision in the wake: ${lastUserText(context)}`);
				return toolUse("abai_decide", { id, answer: "shed_oldest", reason: "the oldest jobs are stale" });
			},
			() => fauxAssistantMessage("Decided.", { stopReason: "stop" }),
			() => toolUse("abai_cells", {}),
			() => fauxAssistantMessage("Workers look fine.", { stopReason: "stop" }),
			() => toolUse("abai_cells", {}),
			() => fauxAssistantMessage("The queue depth is 0.", { stopReason: "stop" }),
		];
		faux.setResponses(steps);
		const transport = await SocketTransport.connect(prog.child.pid as number, { runDir: prog.runDir });
		const harness = new Harness(defaultOptions("session"));
		await harness.attach(transport);
		const channel = scriptedChannel(["how deep is the queue?"]);
		const form = new SessionForm({
			harness,
			model: { model: faux.getModel(), streamFn: (m, c, o) => models.streamSimple(m, c, o) },
			channel,
			connectTimeoutMs: 10_000,
		});
		expect(form.mode).toBe("live");

		prog.send("decide");
		await prog.expectLine(/^decided shed_oldest$/);
		prog.send("turn");
		await prog.expectLine(/^turned$/);
		prog.send("session");
		await prog.expectLine(/^session ended attached=true$/);
		expect(channel.said).toContain("The queue depth is 0.");

		const records = prog.records();
		expect(records.find((r) => r.act === "decision")).toMatchObject({
			outcome: "agent",
			reason: "the oldest jobs are stale",
			conn: "k1",
		});
		expect(records.find((r) => r.act === "turn")).toMatchObject({ outcome: "ok" });
		prog.send("exit");
		await new Promise<void>((done) => prog.child.once("exit", () => done()));
		form.shutdown("done");
	}, 30_000);

	test("the mcp verb: an MCP client in this process drives a program in another through the binary's server", async () => {
		const prog = await program();
		const input = new PassThrough();
		const output = new PassThrough();
		const stderr = new PassThrough();
		const err: string[] = [];
		stderr.on("data", (chunk) => err.push(String(chunk)));
		const io = { out: () => {}, err: (text: string) => err.push(text), env: {} };
		const served = runMcp(parseArgs(["mcp", "--target", String(prog.child.pid), "--run-dir", prog.runDir]), io, {
			input,
			output,
			stderr,
		});
		const client = mcpClient(input, output);
		const initialized = await client.request("initialize", { protocolVersion: "2025-06-18" });
		expect((initialized.result as { instructions: string }).instructions).toContain("sidey");
		expect(err.join("")).toMatch(/attached to sidey \(pid \d+\) as k1; claims: on_backlog/);
		expect(JSON.parse((await client.call("abai_cells")).text)).toEqual({ "queue.depth": 0, "worker.count": 4 });
		expect((await client.call("abai_set", { cell: "worker.count", value: 8, reason: "eight" })).text).toBe(
			"worker.count = 8",
		);
		// a decision through the park: the program asks, the agent parks, decides, and the program goes on
		prog.send("decide");
		const asked = (await client.call("abai_wait", { wait_s: 5 })).text;
		const id = /decision (d\d+) on_backlog/.exec(asked)?.[1];
		expect(id).toBeDefined();
		await client.call("abai_decide", { id, answer: "shed_oldest", reason: "stale" });
		await prog.expectLine(/^decided shed_oldest$/);
		// a turn the agent does nothing with ends when the agent parks again
		prog.send("turn");
		expect((await client.call("abai_wait", { wait_s: 5 })).text).toContain("end_of_batch");
		const parked = client.call("abai_wait", { wait_s: 0.5 });
		await prog.expectLine(/^turned$/);
		await parked;
		const records = prog.records();
		expect(records.find((r) => r.act === "knob")).toMatchObject({
			name: "worker.count",
			conn: "k1",
			reason: "eight",
		});
		expect(records.find((r) => r.act === "decision")).toMatchObject({
			outcome: "agent",
			reason: "stale",
			conn: "k1",
		});
		expect(records.find((r) => r.act === "turn")).toMatchObject({ outcome: "ok", conn: "k1" });
		// the program exits: the next park says so, and the server stays up for its client
		const gone = client.call("abai_wait", { wait_s: 5 });
		prog.send("exit");
		expect((await gone).text).toMatch(/disconnected from the program/);
		expect(JSON.parse((await client.call("abai_status")).text)).toMatchObject({ attached: false });
		// a program that comes up later, in the same run directory, is attached through the front, by pid
		const next = await program({ ABAI_RUN_DIR: prog.runDir });
		const attached = await client.call("abai_attach", { target: next.child.pid });
		expect(attached.isError).toBe(false);
		expect(attached.text).toMatch(/^attached to sidey \(pid \d+\) as k1/);
		expect(JSON.parse((await client.call("abai_cells")).text)).toEqual({ "queue.depth": 0, "worker.count": 4 });
		next.send("exit");
		input.end();
		expect(await served).toBe(0);
	}, 30_000);

	test("the mcp verb against a program waiting at session(): the held touchpoint reaches the first park", async () => {
		// the program is inside its attach wait (an idle stand-in binary, a long wait); the MCP server is the
		// connection it gets, and the session touchpoint it opens at once must reach the agent
		const dir = mkdtempSync(join(tmpdir(), "sc-mcp-"));
		dirs.push(dir);
		const idle = join(dir, "idle.mjs");
		writeFileSync(idle, "setTimeout(() => {}, 5000);\n");
		const prog = await program({ ABAI_HARNESS_BIN: idle, ABAI_ATTACH_WAIT_MS: "20000" });
		prog.send("session");
		await new Promise((r) => setTimeout(r, 150));
		const input = new PassThrough();
		const output = new PassThrough();
		const stderr = new PassThrough();
		stderr.on("data", () => {});
		const served = runMcp(
			parseArgs(["mcp", "--target", String(prog.child.pid), "--run-dir", prog.runDir]),
			{ out: () => {}, err: () => {}, env: {} },
			{ input, output, stderr },
		);
		const client = mcpClient(input, output);
		const wake = (await client.call("abai_wait", { wait_s: 5 })).text;
		expect(wake).toContain("session p");
		expect(wake).toContain("Welcome to sidey.");
		await client.call("abai_wait", { wait_s: 0.3 });
		await prog.expectLine(/^session ended attached=true$/);
		prog.send("exit");
		input.end();
		expect(await served).toBe(0);
	}, 30_000);

	test("the attach verb's order: a program waiting at session() is served by a form built after the attach", async () => {
		// what a spawned binary always finds: the program inside its attach wait, opening the touchpoint the
		// moment a connection is accepted. The stand-in binary only idles, so this test is the connection.
		const dir = mkdtempSync(join(tmpdir(), "sc-bin-"));
		dirs.push(dir);
		const idle = join(dir, "idle.mjs");
		writeFileSync(idle, "setTimeout(() => {}, 5000);\n");
		const prog = await program({ ABAI_HARNESS_BIN: idle, ABAI_ATTACH_WAIT_MS: "20000" });
		prog.send("session");
		await new Promise((r) => setTimeout(r, 150));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([() => fauxAssistantMessage("Four workers.", { stopReason: "stop" })]);
		const transport = await SocketTransport.connect(undefined, { runDir: prog.runDir });
		const harness = new Harness(defaultOptions("session"));
		await harness.attach(transport);
		// held by the harness, with no wake for the agent, until a front end takes it
		expect(harness.pendingTouchpointList()).toMatchObject([{ kind: "session" }]);
		expect(await harness.nextDelivery(100)).toBeUndefined();
		const channel = scriptedChannel(["how many workers?"]);
		const form = new SessionForm({
			harness,
			model: { model: faux.getModel(), streamFn: (m, c, o) => models.streamSimple(m, c, o) },
			channel,
			connectTimeoutMs: 10_000,
			mode: "live",
		});
		await prog.expectLine(/^session ended attached=true$/);
		expect(channel.said).toContain("Four workers.");
		expect(harness.pendingTouchpointList()).toEqual([]);
		prog.send("exit");
		await new Promise<void>((done) => prog.child.once("exit", () => done()));
		form.shutdown("done");
	}, 30_000);
});
