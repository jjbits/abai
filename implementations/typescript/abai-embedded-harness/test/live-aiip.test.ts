// Two real aiip daemons on one machine, through the harness's network layer:
// create a network, invite, join, read the roster, see the tunnel come up,
// send an aiap envelope each way and read it back, leave, and stop both
// daemons by their own handles. Gated: runs only with
// ABAI_AIIP_BIN pointing at an aiip binary (the Mac's is ~/.local/bin/aiip).
// State dirs live under /tmp so the socket paths stay under the daemon's
// 100-byte limit.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { type AiipDaemon, ensureAiipDaemon } from "../src/net/daemon.ts";
import { classify, encodeMessage } from "../src/net/envelope.ts";
import { RunNetwork } from "../src/net/membership.ts";

const bin = process.env.ABAI_AIIP_BIN;
const base = bin ? mkdtempSync("/tmp/abai-aiip-") : undefined;
const daemons: AiipDaemon[] = [];

afterAll(async () => {
	for (const daemon of daemons.splice(0)) await daemon.stop();
	if (base) rmSync(base, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!bin)("two real aiip daemons on one machine", () => {
	test("create, invite, join, roster, tunnel, leave, and a clean stop", { timeout: 120_000 }, async () => {
		const aiip = bin as string;
		const root = base as string;
		const a = await ensureAiipDaemon(join(root, "a"), { bin: aiip });
		daemons.push(a);
		expect(a.spawned).toBe(true);
		expect(a.version).toMatch(/^aiip-/);
		const b = await ensureAiipDaemon(join(root, "b"), { bin: aiip });
		daemons.push(b);
		expect(b.spawned).toBe(true);
		expect(b.pid).not.toBe(a.pid);
		// the real daemon, not a fake: it names its state dir and its own pid
		const status = await a.client.status();
		expect(status.stateDir).toBe(join(root, "a"));
		expect(status.pid).toBe(a.pid);
		console.log(`live aiip: ${a.version}${a.versionSkew ? ` (${a.versionSkew})` : ""}, pids ${a.pid} and ${b.pid}`);

		const created = await a.client.create({ name: "demo", as: "alpha" });
		expect(created).toMatchObject({ networkName: "demo", selfName: "alpha", authority: true });
		expect(created.selfAddr).toMatch(/^100\./);
		expect(await b.client.networks()).toEqual([]);

		const invite = await a.client.invite("demo", "beta");
		expect(invite.token).toMatch(/^aiip-invite\./);
		expect(invite.name).toBe("beta");

		// a plain join returns after the hello round trip to the inviter, over loopback here
		const joined = await b.client.join(invite.token);
		expect(joined).toMatchObject({
			networkID: created.networkID,
			selfName: "beta",
			selfAddr: invite.addr,
			authority: false,
		});

		const roster = await b.client.members("demo");
		expect(roster.source).toBe("authority");
		expect(roster.members.map((m) => [m.name, m.enrolled, m.self === true]).sort()).toEqual([
			["alpha", true, false],
			["beta", true, true],
		]);

		// the tunnel from the authority to the newcomer comes up within seconds
		let established = false;
		const deadline = Date.now() + 15_000;
		while (!established && Date.now() < deadline) {
			const peers = await a.client.peers("demo");
			established = peers.peers.some((p) => p.name === "beta" && p.established);
			if (!established) await sleep(250);
		}
		expect(established).toBe(true);

		// the harness's own view of it
		const run = new RunNetwork(b, await b.client.networks(), true);
		expect(run.status.memberships).toEqual([
			{ network: "demo", id: created.networkID, member: "beta", addr: invite.addr, authority: false, peers: 1 },
		]);
		const [view] = await run.peers();
		expect(view).toMatchObject({ network: "demo", member: "beta", addr: invite.addr });
		expect(view?.members.find((m) => m.name === "alpha")).toMatchObject({ enrolled: true, self: false });
		expect(view?.members.find((m) => m.name === "alpha")).not.toHaveProperty("claimedName");
		expect(view?.members.find((m) => m.name === "beta")).toMatchObject({ enrolled: true, self: true });

		// mail across the two daemons: an aiap envelope from alpha lands in beta's mailbox with alpha's address
		const hello = encodeMessage({ body: "hello beta", now: Date.now() });
		const sent = await a.client.send("demo", "beta", hello.bytes);
		expect(sent.to).toMatchObject({ name: "beta", addr: invite.addr });
		const got = await b.client.recv("demo", { waitMs: 10_000 });
		expect(got).toBeDefined();
		expect(got?.from.addr).toBe(created.selfAddr);
		expect(classify(got?.payload as Uint8Array)).toMatchObject({
			kind: "msg",
			envelope: { id: hello.id, body: "hello beta" },
		});
		// beta answers on the thread; alpha takes it
		const reply = encodeMessage({ body: "hello alpha", thread: hello.id, re: hello.id });
		await b.client.send("demo", "alpha", reply.bytes);
		const back = await a.client.recv("demo", { waitMs: 10_000 });
		expect(back?.from.addr).toBe(invite.addr);
		expect(classify(back?.payload as Uint8Array)).toMatchObject({
			kind: "msg",
			envelope: { thread: hello.id, re: hello.id, body: "hello alpha" },
		});
		// a name the authority never issued
		await expect(a.client.send("demo", "nobody", hello.bytes)).rejects.toMatchObject({ status: 404 });
		// nothing else waits
		expect(await b.client.recv("demo", { waitMs: 200 })).toBeUndefined();

		await b.client.leave("demo");
		expect(await b.client.networks()).toEqual([]);
		// the authority still lists the slot: leaving is local
		expect((await a.client.members("demo")).members).toHaveLength(2);

		const pids = [a.pid, b.pid] as number[];
		await a.stop();
		await b.stop();
		daemons.splice(0);
		// gone, by pid: a signal-0 probe of a process that was ours
		for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
	});
});
