// The daemon for a state directory: found or started, stopped only when
// started here. The spawn is injected and serves the fake on the dir's
// socket, so nothing but this test's own fakes ever runs or is signalled.
import { EventEmitter } from "node:events";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { KNOWN_AIIP_API } from "../src/net/client.ts";
import { type ChildLike, ensureAiipDaemon, type SpawnFn, socketPathFor } from "../src/net/daemon.ts";
import {
	aiipBinaryFor,
	ENV_AIIP_BIN,
	ENV_NET_DIR,
	findOnPath,
	networkDirFor,
	withoutInviteToken,
} from "../src/net/dir.ts";

const noSpawn: SpawnFn = () => {
	throw new Error("spawn must not be reached");
};

import { FakeAiipd, FakeOverlay } from "./net-fake.ts";

const dirs: string[] = [];
const fakes: FakeAiipd[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "abai-net-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const fake of fakes.splice(0)) await fake.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A child whose life is a fake daemon on the state dir's socket. */
class FakeChild extends EventEmitter implements ChildLike {
	/** The fake daemon answers with the test process's pid, so a served child carries it too. */
	pid: number | undefined = process.pid;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly kills: NodeJS.Signals[] = [];
	unrefs = 0;
	private readonly fake: FakeAiipd | undefined;
	private readonly behaviour: "serves" | "inert" | "ignores-term";
	constructor(fake: FakeAiipd | undefined, behaviour: "serves" | "inert" | "ignores-term" = "serves") {
		super();
		this.fake = fake;
		this.behaviour = behaviour;
	}
	unref(): void {
		this.unrefs++;
	}
	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.kills.push(signal);
		if (this.behaviour === "ignores-term" && signal === "SIGTERM") return true;
		void (this.fake?.stop() ?? Promise.resolve()).then(() => {
			this.exitCode = null;
			this.signalCode = signal;
			this.emit("exit", null, signal);
		});
		return true;
	}
}

/** A spawn that reads `--state-dir` and serves the fake there; records what it was asked. */
function fakeSpawn(overlay: FakeOverlay, children: FakeChild[], behaviour: FakeChild["behaviour"] = "serves") {
	const calls: Array<{ command: string; args: string[]; stdio: unknown; env: unknown }> = [];
	const spawn: SpawnFn = (command, args, options) => {
		calls.push({ command, args, stdio: options.stdio, env: options.env });
		const dir = args[args.indexOf("--state-dir") + 1] as string;
		let fake: FakeAiipd | undefined;
		if (behaviour === "serves" || behaviour === "ignores-term") {
			fake = new FakeAiipd(overlay, join(dir, "aiipd.sock"));
			fakes.push(fake);
			void fake.start();
		}
		const child = new FakeChild(fake, behaviour);
		children.push(child);
		return child;
	};
	return { spawn, calls };
}

describe("ensureAiipDaemon", () => {
	test("a daemon started here gets the caller's environment without the invite token", async () => {
		const dir = join(scratch(), "net");
		const { spawn, calls } = fakeSpawn(new FakeOverlay(), []);
		const env = { PATH: "/usr/bin", HOME: "/home/x", ABAI_NET_TOKEN: "aiip-invite.secret", ABAI_NET_DIR: dir };
		await ensureAiipDaemon(dir, { bin: "/opt/aiip", spawn, env });
		expect(calls[0]?.env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", ABAI_NET_DIR: dir });
		// the caller keeps its own copy
		expect(env.ABAI_NET_TOKEN).toBe("aiip-invite.secret");
		// with no environment given, the process's own, less the token
		const other = join(scratch(), "net2");
		const before = process.env.ABAI_NET_TOKEN;
		process.env.ABAI_NET_TOKEN = "aiip-invite.process";
		try {
			await ensureAiipDaemon(other, { bin: "/opt/aiip", spawn });
		} finally {
			if (before === undefined) delete process.env.ABAI_NET_TOKEN;
			else process.env.ABAI_NET_TOKEN = before;
		}
		expect(calls[1]?.env).not.toHaveProperty("ABAI_NET_TOKEN");
		expect((calls[1]?.env as NodeJS.ProcessEnv).PATH).toBe(process.env.PATH);
		expect(withoutInviteToken({ PATH: "/p" })).toEqual({ PATH: "/p" });
	});

	test("starts a daemon for the dir, finds it on the next call, and stops only what it started", async () => {
		const dir = join(scratch(), "net");
		const children: FakeChild[] = [];
		const { spawn, calls } = fakeSpawn(new FakeOverlay(), children);

		const first = await ensureAiipDaemon(dir, { bin: "/opt/aiip", spawn });
		expect(first.spawned).toBe(true);
		expect(first.version).toBe(KNOWN_AIIP_API);
		expect(first.versionSkew).toBeUndefined();
		expect(first.pid).toBe(process.pid);
		expect(first.socketPath).toBe(join(dir, "aiipd.sock"));
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ command: "/opt/aiip", args: ["--state-dir", dir, "daemon"] });
		expect(Array.isArray(calls[0]?.stdio) && (calls[0]?.stdio as unknown[])[0]).toBe("ignore");
		expect(readFileSync(join(dir, "daemon.log"), "utf8")).toMatch(/^--- abai starting aiipd .* ---\n$/);
		expect(children[0]?.unrefs).toBe(1);

		const second = await ensureAiipDaemon(dir, { bin: "/opt/aiip", spawn });
		expect(second.spawned).toBe(false);
		expect(second.pid).toBe(process.pid); // the fake reports its own pid
		expect(calls).toHaveLength(1);
		await second.stop();
		expect(children[0]?.kills).toEqual([]);
		expect((await second.client.status()).version).toBe(KNOWN_AIIP_API);

		await first.stop();
		expect(children[0]?.kills).toEqual(["SIGTERM"]);
		expect(existsSync(first.socketPath)).toBe(false);
		await expect(first.client.status()).rejects.toMatchObject({ unreachable: true });
		await first.stop(); // idempotent
		expect(children[0]?.kills).toEqual(["SIGTERM"]);
	});

	test("a child that exits before answering fails with the log's last line", async () => {
		const dir = join(scratch(), "net");
		const spawn: SpawnFn = (_command, args) => {
			const where = args[args.indexOf("--state-dir") + 1] as string;
			const child = new FakeChild(undefined, "inert");
			queueMicrotask(() => {
				appendFileSync(join(where, "daemon.log"), "daemon: state dir is not writable\n");
				child.exitCode = 1;
				child.emit("exit", 1, null);
			});
			return child;
		};
		await expect(ensureAiipDaemon(dir, { bin: "/opt/aiip", spawn })).rejects.toThrow(
			/aiipd exited with code 1 before answering .*; last log line: daemon: state dir is not writable/,
		);
	});

	test("a daemon that never answers is ended by its own handle and reported", async () => {
		const dir = join(scratch(), "net");
		const children: FakeChild[] = [];
		const { spawn } = fakeSpawn(new FakeOverlay(), children, "inert");
		await expect(ensureAiipDaemon(dir, { bin: "/opt/aiip", spawn, readyTimeoutMs: 150, pollMs: 20 })).rejects.toThrow(
			/aiipd did not answer at .* within 150 ms/,
		);
		expect(children[0]?.kills).toEqual(["SIGTERM"]);
	});

	test("a daemon that ignores SIGTERM gets SIGKILL after the stop timeout", async () => {
		const dir = join(scratch(), "net");
		const children: FakeChild[] = [];
		const { spawn } = fakeSpawn(new FakeOverlay(), children, "ignores-term");
		const daemon = await ensureAiipDaemon(dir, { bin: "/opt/aiip", spawn, stopTimeoutMs: 50 });
		await daemon.stop();
		expect(children[0]?.kills).toEqual(["SIGTERM", "SIGKILL"]);
	});

	test("version skew is noted; what is not aiipd is refused", async () => {
		const overlay = new FakeOverlay();
		const dir = join(scratch(), "net");
		mkdirSync(dir, { recursive: true });
		const old = await overlay.newOutsider(join(dir, "aiipd.sock"));
		fakes.push(old);
		old.version = "aiip-m7";
		const found = await ensureAiipDaemon(dir, { bin: "/opt/aiip", spawn: noSpawn });
		expect(found.spawned).toBe(false);
		expect(found.versionSkew).toBe(`the daemon speaks aiip-m7; this harness was written against ${KNOWN_AIIP_API}`);

		old.version = "something-else";
		await expect(ensureAiipDaemon(dir, { bin: "/opt/aiip", spawn: noSpawn })).rejects.toThrow(
			/is not aiipd \(version "something-else"\)/,
		);
	});

	test("a started daemon that is not aiipd is ended before the refusal", async () => {
		const overlay = new FakeOverlay();
		const dir = join(scratch(), "net");
		const children: FakeChild[] = [];
		const spawn: SpawnFn = (_command, args) => {
			const where = args[args.indexOf("--state-dir") + 1] as string;
			const fake = new FakeAiipd(overlay, join(where, "aiipd.sock"));
			fake.version = "something-else";
			fakes.push(fake);
			void fake.start();
			const child = new FakeChild(fake);
			children.push(child);
			return child;
		};
		await expect(ensureAiipDaemon(dir, { bin: "/opt/aiip", spawn })).rejects.toThrow(/is not aiipd/);
		expect(children[0]?.kills).toEqual(["SIGTERM"]);
		expect(existsSync(join(dir, "aiipd.sock"))).toBe(false);
	});

	test("a child that loses the lock to a daemon that came up meanwhile is not ours: found, and left alone", async () => {
		const overlay = new FakeOverlay();
		const dir = join(scratch(), "net");
		mkdirSync(dir, { recursive: true });
		const children: FakeChild[] = [];
		const spawn: SpawnFn = () => {
			// another run's daemon takes the socket while our child boots; our child exits as the lock's loser
			const other = new FakeAiipd(overlay, join(dir, "aiipd.sock"));
			fakes.push(other);
			const child = new FakeChild(undefined, "inert");
			child.pid = 4243; // not the pid the other daemon reports
			children.push(child);
			void other.start().then(() => {
				child.exitCode = 0;
				child.emit("exit", 0, null);
			});
			return child;
		};
		const daemon = await ensureAiipDaemon(dir, { bin: "/opt/aiip", spawn, pollMs: 10 });
		expect(daemon.spawned).toBe(false);
		expect(daemon.pid).toBe(process.pid);
		await daemon.stop();
		expect(children[0]?.kills).toEqual([]);
		expect((await daemon.client.status()).version).toBe(KNOWN_AIIP_API);
	});

	test("a daemon answering with another pid than our child is found, and our child is ended", async () => {
		const overlay = new FakeOverlay();
		const dir = join(scratch(), "net");
		mkdirSync(dir, { recursive: true });
		const children: FakeChild[] = [];
		const spawn: SpawnFn = () => {
			const other = new FakeAiipd(overlay, join(dir, "aiipd.sock")); // reports process.pid, not 4242
			fakes.push(other);
			void other.start();
			const child = new FakeChild(undefined, "inert");
			child.pid = 4242;
			children.push(child);
			return child;
		};
		const daemon = await ensureAiipDaemon(dir, { bin: "/opt/aiip", spawn, pollMs: 10 });
		expect(daemon.spawned).toBe(false);
		expect(children[0]?.kills).toEqual(["SIGTERM"]);
		await daemon.stop();
		expect(children[0]?.kills).toEqual(["SIGTERM"]);
	});

	test("a socket path over the daemon's limit is refused before anything starts", async () => {
		const dir = join(scratch(), "x".repeat(100));
		expect(() => socketPathFor(dir)).toThrow(/is \d+ bytes and the daemon allows 100; set ABAI_NET_DIR/);
		const spawn: SpawnFn = () => {
			throw new Error("spawn must not be reached");
		};
		await expect(ensureAiipDaemon(dir, { bin: "/opt/aiip", spawn })).rejects.toThrow(/daemon allows 100/);
		expect(existsSync(dir)).toBe(false);
	});

	test("a binary that cannot be started is reported as such", async () => {
		const dir = join(scratch(), "net");
		const spawn: SpawnFn = () => {
			throw Object.assign(new Error("spawn /nope/aiip ENOENT"), { code: "ENOENT" });
		};
		await expect(ensureAiipDaemon(dir, { bin: "/nope/aiip", spawn })).rejects.toThrow(
			/the aiip binary could not be started \(\/nope\/aiip\): spawn \/nope\/aiip ENOENT/,
		);
	});
});

describe("where the identity lives and which binary runs it", () => {
	test("the state dir is ABAI_NET_DIR, else the program's place under abai's home, else none", () => {
		expect(networkDirFor({ [ENV_NET_DIR]: "/tmp/x" }, "counter")).toBe("/tmp/x");
		expect(networkDirFor({ ABAI_HOME: "/home/u/.abai" }, "counter")).toBe("/home/u/.abai/net/counter");
		expect(networkDirFor({ HOME: "/home/u" }, "counter")).toBe("/home/u/.abai/net/counter");
		expect(networkDirFor({ HOME: "/home/u" })).toBeUndefined();
		expect(networkDirFor({ HOME: "/home/u", [ENV_NET_DIR]: "  " }, "")).toBeUndefined();
	});

	test("the binary is ABAI_AIIP_BIN, else the configuration's, else aiip on the PATH, else none", () => {
		const bin = scratch();
		const other = scratch();
		writeFileSync(join(bin, "aiip"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(bin, "aiip"), 0o755);
		const config = { connectTimeoutMs: 1 };
		expect(aiipBinaryFor({ [ENV_AIIP_BIN]: "/opt/aiip", PATH: bin }, config)).toBe("/opt/aiip");
		expect(aiipBinaryFor({ PATH: bin }, { ...config, aiip: { bin: "/usr/local/bin/aiip" } })).toBe(
			"/usr/local/bin/aiip",
		);
		expect(aiipBinaryFor({ PATH: `${other}:${bin}` }, config)).toBe(join(bin, "aiip"));
		expect(aiipBinaryFor({ PATH: other }, config)).toBeUndefined();
		expect(findOnPath("aiip", {})).toBeUndefined();
	});
});
