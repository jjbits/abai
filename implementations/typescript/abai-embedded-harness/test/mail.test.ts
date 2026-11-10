// The mail loop against the fake aiipd: one long-poll per membership, a
// handler that sees each message once, a failing daemon retried and heard
// about once each way, a membership the daemon dropped ending its loop, and
// a run's network that starts and stops its mail and names senders.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AiipClient, type AiipMessage } from "../src/net/client.ts";
import type { AiipDaemon } from "../src/net/daemon.ts";
import { MailLoop, type MailLoopOptions } from "../src/net/mail.ts";
import { type NetworkMembership, RunNetwork } from "../src/net/membership.ts";
import { type FakeAiipd, FakeOverlay } from "./net-fake.ts";

const dirs: string[] = [];
const fakes: FakeAiipd[] = [];
const loops: MailLoop[] = [];
const networks: RunNetwork[] = [];

function socket(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), "abai-net-"));
	dirs.push(dir);
	return join(dir, `${name}.sock`);
}

afterEach(async () => {
	for (const loop of loops.splice(0)) await loop.stop();
	for (const network of networks.splice(0)) await network.stop();
	for (const fake of fakes.splice(0)) await fake.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fastOptions: MailLoopOptions = { waitMs: 200, backoffMinMs: 10, backoffMaxMs: 50 };
const payload = new TextEncoder().encode("hi");
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
		await delay(10);
	}
}

/** An overlay with two members, alpha the authority and beta, each on its own socket; `net` is the network id. */
async function twoMembers() {
	const overlay = new FakeOverlay();
	const alphaFake = await overlay.newMember("alpha", socket("alpha"));
	const betaFake = await overlay.newMember("beta", socket("beta"));
	fakes.push(alphaFake, betaFake);
	const alphaAddr = alphaFake.member?.addr as string;
	const betaAddr = betaFake.member?.addr as string;
	const betaMembership: NetworkMembership = {
		network: overlay.networkName,
		id: overlay.networkID,
		member: "beta",
		addr: betaAddr,
		authority: false,
		peers: 1,
	};
	return {
		overlay,
		alphaFake,
		betaFake,
		alphaClient: new AiipClient(alphaFake.socketPath),
		betaClient: new AiipClient(betaFake.socketPath),
		net: overlay.networkID,
		alphaAddr,
		betaAddr,
		betaMembership,
	};
}

interface Got {
	message: AiipMessage;
	membership: NetworkMembership;
}

function newLoop(client: AiipClient, notes: string[], options: MailLoopOptions = {}): MailLoop {
	const loop = new MailLoop(client, (t) => notes.push(t), { ...fastOptions, ...options });
	loops.push(loop);
	return loop;
}

describe("the mail loop", () => {
	test("a message reaches the handler once, with its membership", async () => {
		const { alphaClient, betaClient, net, alphaAddr, betaMembership } = await twoMembers();
		const notes: string[] = [];
		const got: Got[] = [];
		const loop = newLoop(betaClient, notes);
		loop.start(
			(message, membership) => {
				got.push({ message, membership });
			},
			[betaMembership],
		);
		await alphaClient.send(net, "beta", payload);
		await waitFor(() => got.length === 1);
		expect(text((got[0] as Got).message.payload)).toBe("hi");
		expect((got[0] as Got).message.from.addr).toBe(alphaAddr);
		expect((got[0] as Got).membership.member).toBe("beta");
		expect(loop.active).toEqual([net]);
		expect(loop.running).toBe(true);
		await loop.stop();
		expect(loop.active).toEqual([]);
		expect(loop.running).toBe(false);
		await delay(300);
		expect(got.length).toBe(1);
	});

	test("sync follows the membership list", async () => {
		const { alphaClient, betaClient, betaFake, net, betaMembership } = await twoMembers();
		const notes: string[] = [];
		const got: Got[] = [];
		const loop = newLoop(betaClient, notes);
		loop.start((message, membership) => {
			got.push({ message, membership });
		}, []);
		expect(loop.active).toEqual([]);
		loop.sync([betaMembership]);
		expect(loop.active).toEqual([net]);
		loop.sync([]);
		expect(loop.active).toEqual([]);
		await alphaClient.send(net, "beta", payload);
		await delay(300);
		expect(betaFake.mailbox.length).toBe(1);
		expect(got).toEqual([]);
		loop.sync([betaMembership]);
		await waitFor(() => got.length === 1);
		expect(betaFake.mailbox.length).toBe(0);
	});

	test("a handler that throws loses only that message", async () => {
		const { alphaClient, betaClient, net, betaMembership } = await twoMembers();
		const notes: string[] = [];
		const got: Got[] = [];
		let calls = 0;
		const loop = newLoop(betaClient, notes);
		loop.start(
			(message, membership) => {
				calls += 1;
				if (calls === 1) throw new Error("no thanks");
				got.push({ message, membership });
			},
			[betaMembership],
		);
		await alphaClient.send(net, "beta", new TextEncoder().encode("first"));
		await alphaClient.send(net, "beta", new TextEncoder().encode("second"));
		await waitFor(() => got.length === 1);
		expect(text((got[0] as Got).message.payload)).toBe("second");
		expect(notes.some((n) => /was not handled: no thanks/.test(n))).toBe(true);
	});

	test("a daemon that stops answering is retried, and the transcript hears once each way", async () => {
		const { alphaClient, betaClient, betaFake, net, betaMembership } = await twoMembers();
		const notes: string[] = [];
		const got: Got[] = [];
		betaFake.fault = { status: 500, error: "boom" };
		const loop = newLoop(betaClient, notes);
		loop.start(
			(message, membership) => {
				got.push({ message, membership });
			},
			[betaMembership],
		);
		await delay(150);
		expect(notes.filter((n) => /cannot be read: boom/.test(n))).toHaveLength(1);
		betaFake.fault = undefined;
		await alphaClient.send(net, "beta", payload);
		await waitFor(() => got.length === 1);
		expect(notes.filter((n) => /is read again/.test(n))).toHaveLength(1);
	});

	test("a membership the daemon no longer holds ends its loop and reports it", async () => {
		const { betaClient, net, betaMembership } = await twoMembers();
		const notes: string[] = [];
		const dropped: NetworkMembership[] = [];
		const loop = newLoop(betaClient, notes, { onDropped: (m) => dropped.push(m) });
		loop.start(() => {}, [betaMembership]);
		await delay(30);
		await betaClient.leave(net);
		await waitFor(() => loop.active.length === 0);
		expect(dropped).toHaveLength(1);
		expect((dropped[0] as NetworkMembership).member).toBe("beta");
		expect(notes.some((n) => /no longer a member of/.test(n))).toBe(true);
		expect(loop.running).toBe(true);
	});

	test("stop ends a poll in flight at once", async () => {
		const { betaClient, betaMembership } = await twoMembers();
		const notes: string[] = [];
		const loop = newLoop(betaClient, notes, { waitMs: 5000 });
		loop.start(() => {}, [betaMembership]);
		await delay(30);
		const started = Date.now();
		await loop.stop();
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test("stop is idempotent and a stopped loop ignores sync", async () => {
		const { betaClient, betaMembership } = await twoMembers();
		const notes: string[] = [];
		const loop = newLoop(betaClient, notes);
		loop.start(() => {}, [betaMembership]);
		await loop.stop();
		await loop.stop();
		loop.sync([betaMembership]);
		expect(loop.active).toEqual([]);
	});
});

describe("a run's network reads its mail", () => {
	let stopped = 0;
	let clock = 1_000_000;

	async function runNetwork(owned: boolean) {
		const members = await twoMembers();
		stopped = 0;
		clock = 1_000_000;
		const notes: string[] = [];
		const daemon: AiipDaemon = {
			dir: "(fake)",
			socketPath: members.betaFake.socketPath,
			client: members.betaClient,
			version: "aiip-m8",
			versionSkew: undefined,
			spawned: true,
			pid: 1,
			stop: async () => {
				stopped += 1;
			},
		};
		const network = new RunNetwork(daemon, await members.betaClient.networks(), owned, (t) => notes.push(t), {
			mail: fastOptions,
			now: () => clock,
		});
		networks.push(network);
		return { ...members, network, notes };
	}

	test("startMail reads, stop stops the mail then the owned daemon", async () => {
		const { alphaClient, net, network } = await runNetwork(true);
		const got: Got[] = [];
		network.startMail((message, membership) => {
			got.push({ message, membership });
		});
		await alphaClient.send(net, "beta", payload);
		await waitFor(() => got.length === 1);
		await network.stop();
		expect(network.mail.running).toBe(false);
		expect(stopped).toBe(1);
	});

	test("a shared directory's daemon is left running", async () => {
		const { alphaClient, net, network } = await runNetwork(false);
		const got: Got[] = [];
		network.startMail((message, membership) => {
			got.push({ message, membership });
		});
		await alphaClient.send(net, "beta", payload);
		await waitFor(() => got.length === 1);
		await network.stop();
		expect(stopped).toBe(0);
		expect(network.mail.running).toBe(false);
	});

	test("nameFor names a sender from the roster, by address", async () => {
		const { alphaClient, betaFake, net, alphaAddr, betaAddr, network } = await runNetwork(true);
		expect(await network.nameFor(net, alphaAddr)).toBe("alpha");
		expect(await network.nameFor(net, betaAddr)).toBe("beta");
		expect(await network.nameFor(net, "100.107.9.9")).toBeUndefined();
		betaFake.fault = { status: 500, error: "down" };
		expect(await network.nameFor(net, alphaAddr)).toBe("alpha");
		expect(await network.nameFor(net, "100.107.9.8")).toBeUndefined();
		clock += 20_000;
		betaFake.fault = undefined;
		const gamma = await alphaClient.invite(net, "gamma");
		expect(await network.nameFor(net, gamma.addr)).toBe("gamma");
	});

	test("refresh keeps the loops in step with the daemon's list", async () => {
		const { betaClient, net, network } = await runNetwork(true);
		network.startMail(() => {});
		await betaClient.leave(net);
		await waitFor(() => network.mail.active.length === 0);
		expect(await network.refresh()).toEqual([]);
	});
});

describe("the mail loop keeps what it took", () => {
	test("a stop from inside the handler delivers nothing more and loses nothing", async () => {
		const { alphaClient, betaClient, betaFake, net, betaMembership } = await twoMembers();
		const notes: string[] = [];
		const loop = newLoop(betaClient, notes, fastOptions);
		const got: AiipMessage[] = [];
		// two messages wait before the loop reads; the handler stops the loop on the first
		await alphaClient.send(net, "beta", new TextEncoder().encode("one"));
		await alphaClient.send(net, "beta", new TextEncoder().encode("two"));
		loop.start(
			(m) => {
				got.push(m);
				void loop.stop();
			},
			[betaMembership],
		);
		await waitFor(() => got.length === 1 && !loop.running);
		await delay(300);
		expect(got.map((m) => text(m.payload))).toEqual(["one"]);
		// the second message is still the daemon's: not taken, so not lost
		expect(betaFake.mailbox.length).toBe(1);
	});

	test("stop lets go of a handler that never settles, after its limit", async () => {
		const { alphaClient, betaClient, net, betaMembership } = await twoMembers();
		const notes: string[] = [];
		const loop = newLoop(betaClient, notes, { ...fastOptions, stopTimeoutMs: 100 });
		let entered = false;
		loop.start(() => {
			entered = true;
			return new Promise<void>(() => {});
		}, [betaMembership]);
		await alphaClient.send(net, "beta", payload);
		await waitFor(() => entered);
		const started = Date.now();
		await loop.stop();
		expect(Date.now() - started).toBeLessThan(1000);
	});
});
