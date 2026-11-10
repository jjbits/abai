// A run on an agent network (abaigrammar section 7, `network`), end to end
// against the fake daemon: the harness joins at attach with the invite the
// environment hands it, the prompt and the status say where the run is,
// abai_peers lists who else is there, and a declared network that cannot
// be had either refuses the attach (`required`) or is named as absent. Who
// stops the daemon follows the directory: a run's own (ABAI_NET_DIR) goes
// with the run, the shared per-program one stays for the next run.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AbaigramOptions, createAbaigram } from "@abaigram/abai-stub";
import { createModels, fauxProvider } from "@arx-06/ai";
import { afterEach, describe, expect, test } from "vitest";
import { SessionForm } from "../src/agent.ts";
import { Harness } from "../src/harness.ts";
import { AiipClient } from "../src/net/client.ts";
import type { ChildLike, SpawnFn } from "../src/net/daemon.ts";
import { connectNetwork, type RunNetwork } from "../src/net/membership.ts";
import { defaultOptions } from "../src/options.ts";
import { type ToolFront, toolsFor } from "../src/tools.ts";
import { DirectTransport } from "../src/transport-direct.ts";
import { FakeAiipd, FakeOverlay } from "./net-fake.ts";

const dirs: string[] = [];
const fakes: FakeAiipd[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.shutdown("done");
	for (const fake of fakes.splice(0)) await fake.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = "abai-netty-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** Wait until the fake has stopped (its child's SIGTERM lands asynchronously), or fail after a second. */
async function stopped(fake: FakeAiipd | undefined): Promise<boolean> {
	const deadline = Date.now() + 1_000;
	while (fake?.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
	return fake?.running === false;
}

const DOC = "Members are ships of one world; a member's name is its callsign.";

function declarations(network?: AbaigramOptions["network"]): AbaigramOptions {
	return {
		name: "netty",
		modes: ["turns"],
		cells: { "queue.depth": { type: "int", access: "read", doc: "Jobs waiting." } },
		events: { "job.failed": { payload: { job_id: "string" }, wakes: "always", doc: "A job failed." } },
		...(network === undefined ? {} : { network }),
	};
}

/** A child whose life is a fake daemon; the fake answers with this process's pid, so the child carries it too. */
class FakeChild extends EventEmitter implements ChildLike {
	pid: number | undefined = process.pid;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	private readonly fake: FakeAiipd;
	constructor(fake: FakeAiipd) {
		super();
		this.fake = fake;
	}
	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		void this.fake.stop().then(() => {
			this.signalCode = signal;
			this.emit("exit", null, signal);
		});
		return true;
	}
	unref(): void {}
}

/** An overlay with a world created by `alpha`, and a spawn that serves a fake daemon on whatever dir it is asked for. */
async function overlayWithWorld() {
	const overlay = new FakeOverlay();
	const authority = await overlay.newOutsider(join(scratch(), "alpha.sock"));
	fakes.push(authority);
	const alpha = new AiipClient(authority.socketPath);
	await alpha.create({ name: "world", as: "alpha" });
	const spawned: FakeAiipd[] = [];
	const spawn: SpawnFn = (_command, args) => {
		const dir = args[args.indexOf("--state-dir") + 1] as string;
		const fake = new FakeAiipd(overlay, join(dir, "aiipd.sock"));
		fakes.push(fake);
		spawned.push(fake);
		void fake.start();
		return new FakeChild(fake);
	};
	return { overlay, authority, alpha, spawn, spawned };
}

interface WorldInput {
	network?: AbaigramOptions["network"];
	env: NodeJS.ProcessEnv;
	spawn: SpawnFn;
}

async function world(input: WorldInput) {
	const root = scratch("abai-netty-root-");
	mkdirSync(join(root, "abai"));
	writeFileSync(join(root, "abai/identity.md"), "You are the agent fused into netty, a job queue.\n");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let harness: Harness | undefined;
	let form: SessionForm | undefined;
	const app = createAbaigram(declarations(input.network), {
		env: {},
		root,
		auditPath: join(root, "audit.jsonl"),
		harness: async (binding) => {
			harness = new Harness(defaultOptions("session", { auto: true }), { env: input.env, spawn: input.spawn });
			await harness.attach(new DirectTransport(binding));
			form = new SessionForm({
				harness,
				model: { model: faux.getModel(), streamFn: (m, c, o) => models.streamSimple(m, c, o) },
			});
		},
	});
	const attached = await app.attach();
	return { app, attached, harness, form, root };
}

/** The program's audit log, one record per line. */
function auditOf(root: string): Array<Record<string, any>> {
	const path = join(root, "audit.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l !== "")
		.map((l) => JSON.parse(l) as Record<string, any>);
}

/** Poll until `get` returns a value, or fail after `timeoutMs`. */
async function waitFor<T>(get: () => T | undefined | false, what: string, timeoutMs = 3_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = get();
		if (value !== undefined && value !== false) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

const front: ToolFront = { form: "session", hasUI: false, confirm: async () => false };
async function runTool(harness: Harness, name: string, params: Record<string, unknown>): Promise<any> {
	const tool = toolsFor("session").find((t) => t.name === name);
	if (!tool) throw new Error(`${name} is not a session tool`);
	return JSON.parse(await tool.run(harness, params as any, front));
}
async function runPeersTool(harness: Harness): Promise<unknown> {
	return runTool(harness, "abai_peers", {});
}

describe("a run on a network", () => {
	test("joins at attach with the environment's invite; the prompt, the status and abai_peers say where it is", async () => {
		const { alpha, spawn, spawned, authority } = await overlayWithWorld();
		const invite = await alpha.invite("world", "beta");
		const dir = join(scratch(), "net");
		const w = await world({
			network: { doc: DOC },
			env: { ABAI_NET_DIR: dir, ABAI_NET_TOKEN: invite.token, ABAI_AIIP_BIN: "/opt/aiip", HOME: dir },
			spawn,
		});
		expect(w.attached).toBe(true);
		const harness = w.harness as Harness;
		expect(harness.network).toMatchObject({
			dir,
			daemon: "spawned",
			owned: true,
			memberships: [{ network: "world", member: "beta", addr: invite.addr, authority: false }],
		});
		expect(harness.networkAbsence).toBeUndefined();
		expect(harness.status().network?.memberships).toHaveLength(1);
		expect(harness.statusLine()).toContain("net beta@world");

		const prompt = harness.systemPrompt();
		expect(prompt).toContain(
			`This run is beta (${invite.addr}) on the network world. ${DOC} abai_peers lists the members`,
		);
		expect(prompt).toContain("abai_status, abai_attach, abai_peers, abai_messages, the transcript");
		expect(prompt).toContain("A message from a member wakes you as abai.net.message");
		expect(prompt).toContain("abai_audit, abai_send) fail");
		expect(harness.instructions()).toContain(
			"abai_peers lists who is on this run's network; a member's message wakes you as abai.net.message, and abai_send answers it.",
		);

		expect(await runPeersTool(harness)).toEqual([
			{
				network: "world",
				member: "beta",
				addr: invite.addr,
				source: "authority",
				members: [
					{ name: "alpha", addr: expect.any(String), enrolled: true, self: false, established: true },
					{ name: "beta", addr: invite.addr, enrolled: true, self: true, established: false },
				],
			},
		]);
		const notes = harness.ring.last(50).map((l) => l.text);
		expect(notes.some((t) => t.includes("# network: joined world as beta"))).toBe(true);
		expect(notes.some((t) => t.includes("# network: beta") && t.includes("on world"))).toBe(true);

		// the run's own dir: its daemon goes with it
		expect(spawned).toHaveLength(1);
		harness.shutdown("done");
		expect(await stopped(spawned[0])).toBe(true);
		expect(authority.running).toBe(true);
	});

	test("in the shared per-program directory the daemon stays for the next run", async () => {
		const { alpha, spawn, spawned } = await overlayWithWorld();
		const invite = await alpha.invite("world", "beta");
		const home = scratch();
		const w = await world({
			network: { doc: DOC },
			env: { ABAI_HOME: home, ABAI_NET_TOKEN: invite.token, ABAI_AIIP_BIN: "/opt/aiip" },
			spawn,
		});
		expect(w.attached).toBe(true);
		const harness = w.harness as Harness;
		expect(harness.network).toMatchObject({ dir: join(home, "net", "netty"), daemon: "spawned", owned: false });
		harness.shutdown("done");
		await new Promise((r) => setTimeout(r, 30));
		expect(spawned).toHaveLength(1);
		expect(spawned[0]?.running).toBe(true);
	});

	test("a run that is already a member finds its daemon, joins nothing again, and leaves the daemon running", async () => {
		const { overlay, alpha, spawn } = await overlayWithWorld();
		const dir = join(scratch(), "net");
		mkdirSync(dir, { recursive: true });
		const mine = await overlay.newMember("beta", join(dir, "aiipd.sock"));
		fakes.push(mine);
		const invite = await alpha.invite("world", "gamma"); // a token for somebody else: not used, since the run is a member
		const w = await world({
			network: { doc: DOC },
			env: { ABAI_NET_DIR: dir, ABAI_NET_TOKEN: invite.token, ABAI_AIIP_BIN: "/opt/aiip", HOME: dir },
			spawn,
		});
		expect(w.attached).toBe(true);
		const harness = w.harness as Harness;
		expect(harness.network).toMatchObject({ daemon: "found", memberships: [{ member: "beta", network: "world" }] });
		// the token did not fit a membership this run holds: the daemon answered 409, which is not a failure
		const notes = harness.ring.last(50).map((l) => l.text);
		expect(notes.some((t) => t.includes("# network: joined"))).toBe(false);
		harness.shutdown("done");
		await new Promise((r) => setTimeout(r, 30));
		expect(mine.running).toBe(true);
	});

	test("the authority's own run sees itself as self and the others around it", async () => {
		const { overlay, alpha, spawn } = await overlayWithWorld();
		const invite = await alpha.invite("world", "beta");
		const other = await overlay.newOutsider(join(scratch(), "beta.sock"));
		fakes.push(other);
		await new AiipClient(other.socketPath).join(invite.token);
		const dir = join(scratch(), "net");
		mkdirSync(dir, { recursive: true });
		const mine = await overlay.newMember("gamma", join(dir, "aiipd.sock"));
		fakes.push(mine);
		const w = await world({
			network: { doc: DOC },
			env: { ABAI_NET_DIR: dir, ABAI_AIIP_BIN: "/opt/aiip", HOME: dir },
			spawn,
		});
		expect(w.attached).toBe(true);
		const [view] = (await runPeersTool(w.harness as Harness)) as Array<{ members: Array<Record<string, unknown>> }>;
		expect(view?.members.map((m) => [m.name, m.self, m.established])).toEqual([
			["alpha", false, true],
			["beta", false, true],
			["gamma", true, false],
		]);
	});

	test("a required network that cannot be had refuses the attach with the reason", async () => {
		const { alpha, spawn } = await overlayWithWorld();
		const dir = join(scratch(), "net");
		const invite = await alpha.invite("world", "beta");
		// an invite in hand but no binary to use it with
		const w = await world({
			network: { required: true, doc: DOC },
			env: { ABAI_NET_DIR: dir, ABAI_NET_TOKEN: invite.token, PATH: "", HOME: dir },
			spawn,
		});
		expect(w.attached).toBe(false);
		expect(w.app.attachError).toMatch(/the program requires a network: no aiip binary found/);
	});

	test("a required network whose invite is refused: the attach fails and the daemon this run started goes", async () => {
		const { spawn, spawned } = await overlayWithWorld();
		const dir = join(scratch(), "net");
		const w = await world({
			network: { required: true, doc: DOC },
			env: { ABAI_NET_DIR: dir, ABAI_NET_TOKEN: "fake-invite-bogus", ABAI_AIIP_BIN: "/opt/aiip", HOME: dir },
			spawn,
		});
		expect(w.attached).toBe(false);
		expect(w.app.attachError).toMatch(/the program requires a network: the invite could not be used: token: /);
		expect(spawned).toHaveLength(1);
		expect(await stopped(spawned[0])).toBe(true);
	});

	test("a declared network that is not required, with no membership and no invite: the run goes on and says why", async () => {
		const { spawn, spawned } = await overlayWithWorld();
		const dir = join(scratch(), "net");
		const w = await world({
			network: { doc: DOC },
			env: { ABAI_NET_DIR: dir, ABAI_AIIP_BIN: "/opt/aiip", HOME: dir },
			spawn,
		});
		expect(w.attached).toBe(true);
		const harness = w.harness as Harness;
		expect(harness.network).toBeUndefined();
		expect(harness.networkAbsence).toMatch(/^no membership in .*net \(set ABAI_NET_TOKEN/);
		const prompt = harness.systemPrompt();
		expect(prompt).toContain(`The program declares a network. ${DOC} This run has none: no membership in`);
		expect(prompt).not.toContain("abai_attach, abai_peers,");
		expect(harness.status().networkAbsence).toBe(harness.networkAbsence);
		await expect(harness.peers()).rejects.toThrow(/this run has no network: no membership in/);
		// nothing to run a daemon for
		expect(spawned).toHaveLength(0);
	});

	test("a not-required network whose invite is refused: the run goes on, and the daemon it started goes", async () => {
		const { spawn, spawned } = await overlayWithWorld();
		const dir = join(scratch(), "net");
		const w = await world({
			network: { doc: DOC },
			env: { ABAI_NET_DIR: dir, ABAI_NET_TOKEN: "fake-invite-bogus", ABAI_AIIP_BIN: "/opt/aiip", HOME: dir },
			spawn,
		});
		expect(w.attached).toBe(true);
		const harness = w.harness as Harness;
		expect(harness.network).toBeUndefined();
		expect(harness.networkAbsence).toMatch(/^no membership in/);
		const notes = harness.ring.last(50).map((l) => l.text);
		expect(notes.some((t) => t.includes("# network: the invite could not be used: token: "))).toBe(true);
		expect(await stopped(spawned[0])).toBe(true);
	});

	test("nothing declared and nothing in the environment: no network, no paragraph, and abai_peers says so", async () => {
		const { spawn, spawned } = await overlayWithWorld();
		const w = await world({ env: { HOME: scratch() }, spawn });
		expect(w.attached).toBe(true);
		const harness = w.harness as Harness;
		expect(harness.network).toBeUndefined();
		expect(harness.networkAbsence).toBeUndefined();
		expect(harness.systemPrompt()).not.toContain("network");
		expect(harness.status().network).toBeUndefined();
		await expect(harness.peers()).rejects.toThrow(/this run has no network: the program declares none/);
		expect(spawned).toHaveLength(0);
	});

	test("nothing declared but a network asked for in the environment that cannot be had: the prompt says so", async () => {
		const w = await world({
			env: { ABAI_NET_DIR: join(scratch(), "net"), ABAI_NET_TOKEN: "fake-invite-x", PATH: "", HOME: scratch() },
			spawn: () => {
				throw new Error("spawn must not be reached");
			},
		});
		expect(w.attached).toBe(true);
		const harness = w.harness as Harness;
		expect(harness.networkAbsence).toMatch(/^no aiip binary found/);
		expect(harness.systemPrompt()).toContain(
			"This run was given a network to join (ABAI_NET_DIR or ABAI_NET_TOKEN) but has none: no aiip binary found",
		);
	});

	test("a declared network whose daemon cannot start is absent with the daemon's reason", async () => {
		const dir = join(scratch(), "net");
		mkdirSync(join(dir, "memberships"), { recursive: true });
		writeFileSync(
			join(dir, "memberships", "x.json"),
			JSON.stringify({
				networkID: "x".repeat(32),
				networkName: "world",
				identity: { name: "beta", addr: "100.107.0.9" },
			}),
		);
		const spawn: SpawnFn = () => {
			throw Object.assign(new Error("spawn /opt/aiip ENOENT"), { code: "ENOENT" });
		};
		const w = await world({
			network: { doc: DOC },
			env: { ABAI_NET_DIR: dir, ABAI_AIIP_BIN: "/opt/aiip", HOME: dir },
			spawn,
		});
		expect(w.attached).toBe(true);
		expect((w.harness as Harness).networkAbsence).toMatch(/the aiip binary could not be started/);
	});

	test("a relative ABAI_NET_DIR is refused with a reason", async () => {
		const { spawn } = await overlayWithWorld();
		const relative = await world({
			network: { required: true, doc: DOC },
			env: { ABAI_NET_DIR: "net", ABAI_AIIP_BIN: "/opt/aiip", HOME: scratch() },
			spawn,
		});
		expect(relative.attached).toBe(false);
		expect(relative.app.attachError).toMatch(/ABAI_NET_DIR must be an absolute path \(got net\)/);
	});
});

describe("messages between two runs on a network", () => {
	/** One world with two runs on it, beta and gamma, each with its own daemon and audit log. */
	async function twoRuns() {
		const { alpha, authority, spawn, spawned } = await overlayWithWorld();
		const betaInvite = await alpha.invite("world", "beta");
		const gammaInvite = await alpha.invite("world", "gamma");
		const run = async (token: string) => {
			const dir = join(scratch(), "net");
			const w = await world({
				network: { doc: DOC },
				env: { ABAI_NET_DIR: dir, ABAI_NET_TOKEN: token, ABAI_AIIP_BIN: "/opt/aiip", HOME: dir },
				spawn,
			});
			expect(w.attached).toBe(true);
			const harness = w.harness as Harness;
			harnesses.push(harness);
			return { harness, root: w.root, app: w.app };
		};
		const beta = await run(betaInvite.token);
		const gamma = await run(gammaInvite.token);
		const betaFake = spawned[0] as FakeAiipd;
		const gammaFake = spawned[1] as FakeAiipd;
		expect(betaFake.member?.name).toBe("beta");
		expect(gammaFake.member?.name).toBe("gamma");
		return {
			authority,
			beta: beta.harness,
			betaRoot: beta.root,
			betaFake,
			gamma: gamma.harness,
			gammaRoot: gamma.root,
			gammaApp: gamma.app,
			gammaFake,
		};
	}

	const messageAudit = (root: string) => auditOf(root).filter((r) => r.act === "message");

	test("abai_send reaches the other run as a wake, and both audit logs have the line", async () => {
		const { beta, betaRoot, gamma, gammaRoot } = await twoRuns();
		const result = await runTool(beta, "abai_send", {
			to: "gamma",
			body: "hello gamma",
			reason: "greeting the neighbour",
		});
		expect(result).toMatchObject({ network: "world", to: { name: "gamma" }, id: expect.any(String) });
		expect(result.thread).toBe(result.id);
		await waitFor(() => gamma.messages().length === 1, "gamma's message");

		const [received] = gamma.messages();
		expect(received).toMatchObject({
			direction: "received",
			network: "world",
			peer: "beta",
			kind: "msg",
			body: "hello gamma",
			id: result.id,
			thread: result.id,
		});
		expect(received).not.toHaveProperty("claimed");
		expect(gamma.status().messages).toEqual({ sent: 0, received: 1 });
		expect(gamma.status().wakesPending).toBeGreaterThanOrEqual(1);
		const lines = gamma.ring.last(50).map((l) => l.text);
		expect(lines.some((t) => t.includes("abai.net.message") && t.includes("hello gamma"))).toBe(true);

		const gammaAddr = gamma.network?.memberships[0]?.addr;
		expect(gammaAddr).toEqual(expect.any(String));
		expect(beta.messages()).toHaveLength(1);
		expect(beta.messages()[0]).toMatchObject({
			direction: "sent",
			peer: "gamma",
			kind: "msg",
			body: "hello gamma",
			id: result.id,
			addr: gammaAddr,
		});
		expect(beta.status().messages).toEqual({ sent: 1, received: 0 });

		const sent = messageAudit(betaRoot);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			name: "gamma",
			id: result.id,
			params: { direction: "sent", network: "world", kind: "msg" },
			value: "hello gamma",
			outcome: "ok",
			reason: "greeting the neighbour",
			conn: "direct",
		});
		expect(typeof sent[0]?.ms).toBe("number");
		const got = await waitFor(() => messageAudit(gammaRoot).length === 1 && messageAudit(gammaRoot), "gamma's audit");
		expect(got).toHaveLength(1);
		expect(got[0]).toMatchObject({
			name: "beta",
			id: result.id,
			params: { direction: "received", network: "world", kind: "msg" },
			value: "hello gamma",
			outcome: "ok",
		});
		expect(got[0]).not.toHaveProperty("reason");
	});

	test("a reply carries the thread", async () => {
		const { beta, betaRoot, gamma } = await twoRuns();
		const first = await runTool(beta, "abai_send", { to: "gamma", body: "hello gamma", reason: "greeting" });
		await waitFor(() => gamma.messages().length === 1, "gamma's message");
		await runTool(gamma, "abai_send", {
			to: "beta",
			body: "hello beta",
			reason: "answering",
			thread: first.id,
			re: first.id,
		});
		await waitFor(() => beta.messages().length === 2, "beta's reply");
		const reply = beta.messages().find((m) => m.direction === "received");
		expect(reply).toMatchObject({ direction: "received", peer: "gamma", thread: first.id, re: first.id });
		const record = await waitFor(
			() => messageAudit(betaRoot).find((r) => r.params?.direction === "received"),
			"beta's received audit line",
		);
		expect(record.params.thread).toBe(first.id);
		expect(record.params.re).toBe(first.id);
	});

	test("a long body is previewed in the wake and whole in abai_messages", async () => {
		const { beta, gamma } = await twoRuns();
		await runTool(beta, "abai_send", { to: "gamma", body: "x".repeat(1000), reason: "a long one" });
		await waitFor(() => gamma.messages().length === 1, "gamma's message");
		const listed = await runTool(gamma, "abai_messages", {});
		expect(listed.at(-1).body.length).toBe(1000);
		// the session form in turns mode takes no delivery outside a touchpoint, so the wake is still pending
		expect(gamma.status().wakesPending).toBeGreaterThanOrEqual(1);
		const delivery = gamma.takeDelivery();
		expect(delivery?.text).toContain("abai.net.message from=beta network=world: ");
		expect(delivery?.text).toContain(`${"x".repeat(300)}… (700 more characters; abai_messages has the whole)`);
	});

	test("a raw payload from a member is shown and audited as raw", async () => {
		const { beta, gamma, gammaRoot, gammaFake } = await twoRuns();
		const betaAddr = beta.network?.memberships[0]?.addr as string;
		gammaFake.inject({ addr: betaAddr }, new TextEncoder().encode("plain hello"));
		const entry = await waitFor(() => gamma.messages().find((m) => m.kind === "raw"), "the raw message");
		expect(entry).toMatchObject({ peer: "beta", body: "plain hello", kind: "raw" });
		expect(entry).not.toHaveProperty("id");
		const record = await waitFor(
			() => messageAudit(gammaRoot).find((r) => r.params?.kind === "raw"),
			"the raw audit",
		);
		expect(record).toMatchObject({
			name: "beta",
			params: { direction: "received", kind: "raw" },
			value: "plain hello",
		});
	});

	test("a profile query is a transcript line only", async () => {
		const { authority, gamma, gammaRoot, gammaFake } = await twoRuns();
		const before = gamma.status().wakesPending;
		const auditBefore = auditOf(gammaRoot).length;
		const receivedBefore = gamma.status().messages?.received;
		gammaFake.inject(
			{ addr: authority.member?.addr as string },
			new TextEncoder().encode(
				JSON.stringify({ aiap: 1, type: "profile-query", id: "Q1", ts: "2026-01-01T00:00:00Z" }),
			),
		);
		const entry = await waitFor(() => gamma.messages().find((m) => m.kind === "profile-query"), "the profile query");
		expect(entry.body).toBe("(profile query)");
		expect(entry.peer).toBe("alpha");
		expect(gamma.status().wakesPending).toBe(before);
		expect(auditOf(gammaRoot).length).toBe(auditBefore);
		expect(gamma.status().messages?.received).toBe(receivedBefore);
	});

	test("a send to a name nobody holds, to an unreachable member, and while detached fail in words", async () => {
		const { beta, betaRoot, gammaFake } = await twoRuns();
		await expect(runTool(beta, "abai_send", { to: "nobody", body: "x", reason: "r" })).rejects.toThrow(
			/no member named nobody on world; abai_peers lists them/,
		);
		expect(messageAudit(betaRoot)).toContainEqual(
			expect.objectContaining({
				name: "nobody",
				params: expect.objectContaining({ direction: "sent" }),
				outcome: "error",
				error: expect.stringMatching(/no member named/),
			}),
		);
		gammaFake.unreachable = true;
		await expect(runTool(beta, "abai_send", { to: "gamma", body: "x", reason: "r" })).rejects.toThrow(
			/could not be reached/,
		);
		gammaFake.unreachable = false;
		beta.detach("test");
		await expect(beta.send({ to: "gamma", body: "x", reason: "r" })).rejects.toThrow(/needs an attached program/);
	});

	test("when the program goes away on its own, the mail stops and the daemon keeps what arrives", async () => {
		const { beta, gamma, gammaApp, gammaFake } = await twoRuns();
		(gammaApp as any).directBinding?.detach("program gone");
		await waitFor(() => !gamma.attached, "gamma detached");
		await waitFor(() => (gamma as any).net.mail.running === false, "gamma's mail stopped");
		await runTool(beta, "abai_send", { to: "gamma", body: "anyone there", reason: "r" });
		await new Promise((r) => setTimeout(r, 300));
		expect(gammaFake.mailbox.length).toBe(1);
		expect(gamma.messages().some((m) => m.body === "anyone there")).toBe(false);
	});

	test("a send is refused when the program's stub cannot record it", async () => {
		const { beta, betaRoot, gamma, gammaFake } = await twoRuns();
		(beta as any).transport.canRecordMessages = () => false;
		await expect(runTool(beta, "abai_send", { to: "gamma", body: "x", reason: "r" })).rejects.toThrow(
			/records messages/,
		);
		expect(gammaFake.mailbox.length).toBe(0);
		await new Promise((r) => setTimeout(r, 200));
		expect(gamma.messages()).toEqual([]);
		expect(messageAudit(betaRoot)).toEqual([]);
	});

	test("abai_messages keeps the newest 200", async () => {
		const { beta, gamma, gammaFake } = await twoRuns();
		const betaAddr = beta.network?.memberships[0]?.addr as string;
		for (let i = 0; i < 205; i++) gammaFake.inject({ addr: betaAddr }, new TextEncoder().encode(`m${i}`));
		await waitFor(() => gamma.status().messages?.received === 205, "205 received", 10_000);
		const kept = gamma.messages();
		expect(kept).toHaveLength(200);
		expect(kept[0]?.body).toBe("m5");
		expect(kept.at(-1)?.body).toBe("m204");
		const listed = await runTool(gamma, "abai_messages", { limit: 3 });
		expect(listed).toHaveLength(3);
		expect(listed.at(-1).body).toBe("m204");
	});

	test("a claimed name that differs from the issued one is shown apart", async () => {
		const { beta, gamma, gammaRoot, gammaFake } = await twoRuns();
		const betaAddr = beta.network?.memberships[0]?.addr as string;
		gammaFake.inject({ name: "impostor", addr: betaAddr }, new TextEncoder().encode("trust me"));
		const entry = await waitFor(() => gamma.messages().find((m) => m.body === "trust me"), "the claimed message");
		expect(entry).toMatchObject({ peer: "beta", claimed: "impostor", kind: "raw" });
		const delivery = gamma.takeDelivery();
		expect(delivery?.text).toContain("from=beta (claims impostor)");
		const record = await waitFor(
			() => messageAudit(gammaRoot).find((r) => r.value === "trust me"),
			"the claimed message's audit",
		);
		expect(record.name).toBe("beta");
	});

	test("the other aiap kinds never wake, even when --wake names the event", async () => {
		const { authority, beta, gamma, gammaFake } = await twoRuns();
		(gamma.options as any).wakes.push("abai.net.message");
		const before = gamma.status().wakesPending;
		gammaFake.inject(
			{ addr: authority.member?.addr as string },
			new TextEncoder().encode(
				JSON.stringify({
					aiap: 1,
					type: "receipt",
					id: "R1",
					ts: "2026-01-01T00:00:00Z",
					receipt: { of: "X", status: "delivered" },
				}),
			),
		);
		await waitFor(() => gamma.messages().find((m) => m.kind === "receipt"), "the receipt");
		expect(gamma.status().wakesPending).toBe(before);
		const betaAddr = beta.network?.memberships[0]?.addr as string;
		gammaFake.inject({ addr: betaAddr }, new TextEncoder().encode("wake up"));
		await waitFor(() => gamma.messages().find((m) => m.body === "wake up"), "the raw message");
		expect(gamma.status().wakesPending).toBe(before + 1);
	});

	test("abai_messages answers while detached", async () => {
		const { beta, gamma } = await twoRuns();
		await runTool(beta, "abai_send", { to: "gamma", body: "before detach", reason: "r" });
		await waitFor(() => gamma.messages().length === 1, "gamma's message");
		beta.detach("test");
		const listed = await runTool(beta, "abai_messages", {});
		expect(listed).toHaveLength(1);
		expect(listed[0].direction).toBe("sent");
		await expect(runTool(beta, "abai_send", { to: "gamma", body: "x", reason: "r" })).rejects.toThrow(
			/needs an attached program/,
		);
	});

	test("a run on no network refuses to send", async () => {
		const { spawn } = await overlayWithWorld();
		const w = await world({ env: { HOME: scratch() }, spawn });
		expect(w.attached).toBe(true);
		const harness = w.harness as Harness;
		harnesses.push(harness);
		await expect(harness.send({ to: "x", body: "y", reason: "z" })).rejects.toThrow(/this run has no network/);
		expect(harness.messages()).toEqual([]);
		expect(harness.status().messages).toBeUndefined();
	});
});

describe("connectNetwork across attaches", () => {
	const note = () => {};

	test("the same directory reuses the daemon; another directory stops an owned one and starts anew", async () => {
		const { alpha, spawn, spawned } = await overlayWithWorld();
		const a = join(scratch(), "a");
		const b = join(scratch(), "b");
		const first = await connectNetwork({
			env: {
				ABAI_NET_DIR: a,
				ABAI_NET_TOKEN: (await alpha.invite("world", "beta")).token,
				ABAI_AIIP_BIN: "/opt/aiip",
			},
			program: "netty",
			declared: { doc: DOC },
			spawn,
			note,
		});
		const run = first.network as RunNetwork;
		expect(run.status).toMatchObject({ dir: a, owned: true, memberships: [{ member: "beta" }] });
		expect(spawned).toHaveLength(1);

		const again = await connectNetwork({
			env: { ABAI_NET_DIR: a, ABAI_AIIP_BIN: "/opt/aiip" },
			program: "netty",
			declared: { doc: DOC },
			current: run,
			spawn,
			note,
		});
		expect(again.network).toBe(run);
		expect(spawned).toHaveLength(1);
		expect(spawned[0]?.running).toBe(true);

		const elsewhere = await connectNetwork({
			env: {
				ABAI_NET_DIR: b,
				ABAI_NET_TOKEN: (await alpha.invite("world", "gamma")).token,
				ABAI_AIIP_BIN: "/opt/aiip",
			},
			program: "netty",
			declared: { doc: DOC },
			current: run,
			spawn,
			note,
		});
		expect(elsewhere.network?.status).toMatchObject({ dir: b, memberships: [{ member: "gamma" }] });
		expect(spawned).toHaveLength(2);
		expect(await stopped(spawned[0])).toBe(true);
		expect(spawned[1]?.running).toBe(true);
		await elsewhere.network?.stop();
		expect(await stopped(spawned[1])).toBe(true);
	});

	test("a reused daemon is not orphaned when the reattach fails: an owned one is stopped", async () => {
		const { alpha, spawn, spawned } = await overlayWithWorld();
		const a = join(scratch(), "a");
		const first = await connectNetwork({
			env: {
				ABAI_NET_DIR: a,
				ABAI_NET_TOKEN: (await alpha.invite("world", "beta")).token,
				ABAI_AIIP_BIN: "/opt/aiip",
			},
			program: "netty",
			declared: { doc: DOC },
			spawn,
			note,
		});
		const run = first.network as RunNetwork;
		await run.daemon.client.leave("world");
		await expect(
			connectNetwork({
				env: { ABAI_NET_DIR: a, ABAI_AIIP_BIN: "/opt/aiip" },
				program: "netty",
				declared: { required: true, doc: DOC },
				current: run,
				spawn,
				note,
			}),
		).rejects.toThrow(/the program requires a network: no membership in/);
		expect(await stopped(spawned[0])).toBe(true);
	});

	test("abai_peers follows a membership change made outside the run; the prompt's snapshot stands", async () => {
		const { alpha, spawn } = await overlayWithWorld();
		const a = join(scratch(), "a");
		const first = await connectNetwork({
			env: {
				ABAI_NET_DIR: a,
				ABAI_NET_TOKEN: (await alpha.invite("world", "beta")).token,
				ABAI_AIIP_BIN: "/opt/aiip",
			},
			program: "netty",
			declared: { doc: DOC },
			spawn,
			note,
		});
		const run = first.network as RunNetwork;
		expect((await run.peers()).map((p) => p.network)).toEqual(["world"]);
		await run.daemon.client.leave("world"); // what `config net leave` does in another process
		expect(await run.peers()).toEqual([]);
		expect(run.promptMemberships.map((m) => m.network)).toEqual(["world"]);
		await run.stop();
	});
});
