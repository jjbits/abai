// The aiipd client against the fake daemon: every membership route, the
// error envelope, and the two refusals a join can meet.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AiipClient, AiipError, type AiipMessage, isAlreadyMember } from "../src/net/client.ts";
import { type FakeAiipd, FakeOverlay } from "./net-fake.ts";

const dirs: string[] = [];
const fakes: FakeAiipd[] = [];

function socket(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), "abai-net-"));
	dirs.push(dir);
	return join(dir, `${name}.sock`);
}

afterEach(async () => {
	for (const fake of fakes.splice(0)) await fake.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function outsider(overlay: FakeOverlay, name: string): Promise<FakeAiipd> {
	const fake = await overlay.newOutsider(socket(name));
	fakes.push(fake);
	return fake;
}

describe("AiipClient", () => {
	test("create, invite, join, members, peers and leave round trip", async () => {
		const overlay = new FakeOverlay();
		const a = await outsider(overlay, "a");
		const b = await outsider(overlay, "b");
		const ca = new AiipClient(a.socketPath);
		const cb = new AiipClient(b.socketPath);

		expect((await ca.status()).version).toBe("aiip-m8");
		expect(await ca.networks()).toEqual([]);

		const created = await ca.create({ name: "demo", as: "alpha" });
		expect(created).toMatchObject({ networkName: "demo", selfName: "alpha", authority: true, peers: 0 });
		expect(created.selfAddr).toMatch(/^100\.107\./);

		const invite = await ca.invite("demo", "beta");
		expect(invite.token).toMatch(/^fake-invite-/);
		expect(invite.name).toBe("beta");

		const before = await ca.members("demo");
		expect(before.source).toBe("authority");
		expect(before.members.map((m) => [m.name, m.enrolled, m.self === true])).toEqual([
			["alpha", true, true],
			["beta", false, false],
		]);
		// an invitee that never joined is a slot, not a peer with a tunnel
		expect((await ca.peers("demo")).peers).toEqual([expect.objectContaining({ name: "beta", established: false })]);

		const joined = await cb.join(invite.token);
		expect(joined).toMatchObject({ networkName: "demo", selfName: "beta", authority: false });
		expect(joined.selfAddr).toBe(invite.addr);
		// the same token again: the daemon says this state dir is already a member
		await expect(cb.join(invite.token)).rejects.toSatisfy(isAlreadyMember);

		const after = await cb.members(created.networkID);
		expect(after.members.map((m) => [m.name, m.enrolled, m.self === true])).toEqual([
			["alpha", true, false],
			["beta", true, true],
		]);
		const peers = await ca.peers(created.networkID.slice(0, 8));
		expect(peers.self).toMatchObject({ name: "alpha", addr: created.selfAddr });
		expect(peers.peers).toEqual([
			expect.objectContaining({ name: "beta", addr: invite.addr, enrolled: true, established: true }),
		]);

		await cb.leave("demo");
		expect(await cb.networks()).toEqual([]);
		// leaving is local: the authority still lists the slot
		expect((await ca.members("demo")).members).toHaveLength(2);
	});

	test("the daemon's error envelope becomes an AiipError with its status and reason", async () => {
		const overlay = new FakeOverlay();
		const a = await outsider(overlay, "a");
		const b = await outsider(overlay, "b");
		const ca = new AiipClient(a.socketPath);
		const cb = new AiipClient(b.socketPath);
		await ca.create({ name: "demo", as: "alpha" });
		await cb.join((await ca.invite("demo", "beta")).token);

		const notAuthority = await cb.invite("demo", "gamma").catch((e: unknown) => e);
		expect(notAuthority).toBeInstanceOf(AiipError);
		expect(notAuthority).toMatchObject({ status: 403, message: "this daemon is not the network's authority" });

		const unknown = await ca.members("nope").catch((e: unknown) => e);
		expect(unknown).toMatchObject({ status: 404, message: expect.stringMatching(/^no membership matches "nope"/) });

		// the network reference is escaped: a slash reaches the handler as part of the name, not as a route
		const slashed = await ca.members("x/y").catch((e: unknown) => e);
		expect(slashed).toMatchObject({ status: 404, message: expect.stringMatching(/^no membership matches "x\/y"/) });

		const ownName = await ca.invite("demo", "alpha").catch((e: unknown) => e);
		expect(ownName).toMatchObject({ status: 409 });
		expect(isAlreadyMember(ownName)).toBe(true);

		a.fault = { status: 503, error: "no known endpoints for beta", reason: "no-known-endpoints" };
		const fault = await ca.peers("demo").catch((e: unknown) => e);
		expect(fault).toMatchObject({ status: 503, reason: "no-known-endpoints", unreachable: false });
	});

	test("a slow daemon is a timeout and a caller's abort is an abort, neither an unreachable daemon", async () => {
		const overlay = new FakeOverlay();
		const a = await outsider(overlay, "a");
		a.delayMs = 300;
		const client = new AiipClient(a.socketPath);
		const slow = await client.status({ timeoutMs: 50 }).catch((e: unknown) => e);
		expect(slow).toMatchObject({ status: 0, reason: "timeout", unreachable: false });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		const aborted = await client.status({ timeoutMs: 5_000, signal: controller.signal }).catch((e: unknown) => e);
		expect(aborted).toMatchObject({ status: 0, reason: "aborted", unreachable: false });
	});

	test("no daemon at the socket is an unreachable error, not an exception of the transport", async () => {
		const client = new AiipClient(socket("nobody"));
		const error = await client.status().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AiipError);
		expect(error).toMatchObject({ status: 0, reason: "unreachable", unreachable: true });
		expect((error as AiipError).message).toMatch(/no daemon at .*nobody\.sock: ENOENT/);
	});

	test("a join is refused for a bad token and for an inviter that cannot be reached", async () => {
		const overlay = new FakeOverlay();
		const a = await outsider(overlay, "a");
		const b = await outsider(overlay, "b");
		const ca = new AiipClient(a.socketPath);
		const cb = new AiipClient(b.socketPath);
		await ca.create({ name: "demo", as: "alpha" });
		const invite = await ca.invite("demo", "beta");

		const bad = await cb.join("aiip-invite.nonsense").catch((e: unknown) => e);
		expect(bad).toMatchObject({ status: 400, message: expect.stringMatching(/^token: /) });
		expect(isAlreadyMember(bad)).toBe(false);

		await a.stop();
		const unreachable = await cb.join(invite.token).catch((e: unknown) => e);
		expect(unreachable).toMatchObject({ status: 502 });
		expect((unreachable as AiipError).message).toMatch(/could not reach inviter alpha/);
		expect(await cb.networks()).toEqual([]);
	});
});

describe("mail", () => {
	/** An overlay with two members, alpha the authority and beta, each on its own socket. */
	async function twoMembers() {
		const overlay = new FakeOverlay();
		const alphaFake = await overlay.newMember("alpha", socket("alpha"));
		const betaFake = await overlay.newMember("beta", socket("beta"));
		fakes.push(alphaFake, betaFake);
		return {
			net: overlay.networkName,
			alphaFake,
			betaFake,
			alphaAddr: alphaFake.member?.addr as string,
			betaAddr: betaFake.member?.addr as string,
			alphaClient: new AiipClient(alphaFake.socketPath),
			betaClient: new AiipClient(betaFake.socketPath),
		};
	}
	const payload = new TextEncoder().encode("hello beta");

	test("a send lands in the member's mailbox and recv takes it once", async () => {
		const { net, alphaAddr, betaAddr, alphaClient, betaClient } = await twoMembers();
		const r = await alphaClient.send(net, "beta", payload);
		expect(r.to).toMatchObject({ name: "beta", addr: betaAddr });
		const m = await betaClient.recv(net, { waitMs: 1000 });
		expect(m).toBeDefined();
		const got = m as AiipMessage;
		expect(got.from.addr).toBe(alphaAddr);
		expect(got.from.name).toBe("alpha");
		expect(Buffer.from(got.payload).toString()).toBe("hello beta");
		expect(got.broadcast).toBe(false);
		expect(typeof got.sentAt).toBe("string");
		expect(await betaClient.recv(net, { waitMs: 100 })).toBeUndefined();
	});

	test("a send to a name the authority never issued is refused", async () => {
		const { net, alphaClient } = await twoMembers();
		await expect(alphaClient.send(net, "nobody", payload)).rejects.toMatchObject({
			status: 404,
			message: expect.stringMatching(/no known peer named/),
		});
	});

	test("a payload over the daemon's cap is refused before the request", async () => {
		const { net, alphaClient } = await twoMembers();
		await expect(alphaClient.send(net, "beta", new Uint8Array(1024 * 1024 + 1))).rejects.toMatchObject({
			status: 0,
			message: expect.stringMatching(/exceeds the daemon's 1048576 byte cap/),
		});
	});

	test("an unreachable member times the dial out", async () => {
		const { net, betaFake, alphaClient } = await twoMembers();
		betaFake.unreachable = true;
		await expect(alphaClient.send(net, "beta", payload)).rejects.toMatchObject({ status: 504 });
		betaFake.unreachable = false;
	});

	test("a full mailbox refuses the sender", async () => {
		const { net, alphaAddr, betaFake, alphaClient, betaClient } = await twoMembers();
		for (let i = 0; i < 1024; i++) betaFake.inject({ addr: alphaAddr }, payload);
		await expect(alphaClient.send(net, "beta", payload)).rejects.toMatchObject({
			status: 502,
			message: expect.stringMatching(/mailbox full/),
		});
		const m = await betaClient.recv(net, { waitMs: 100 });
		expect(m?.from.addr).toBe(alphaAddr);
		betaFake.mailbox.length = 0;
	});

	test("an aborted recv rejects at once with the caller's reason", async () => {
		const { net, alphaClient } = await twoMembers();
		const ac = new AbortController();
		const p = alphaClient.recv(net, { waitMs: 5000, signal: ac.signal });
		setTimeout(() => ac.abort(), 20);
		await expect(p).rejects.toMatchObject({ status: 0, reason: "aborted" });
	});

	test("a member that left refuses the sender, and its waiting reader hears it", async () => {
		const { net, alphaClient, betaClient } = await twoMembers();
		// the expectation is attached before the leave, so the 410 is never an unhandled rejection
		const waiting = expect(betaClient.recv(net, { waitMs: 5000 })).rejects.toMatchObject({ status: 410 });
		await new Promise((r) => setTimeout(r, 20));
		await betaClient.leave(net);
		await waiting;
		await expect(alphaClient.send(net, "beta", payload)).rejects.toMatchObject({
			status: 502,
			message: expect.stringMatching(/mailbox gone/),
		});
		await expect(betaClient.recv(net, { waitMs: 10 })).rejects.toMatchObject({ status: 404 });
	});
});
