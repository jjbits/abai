import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { anthropicProbeHeaders, type CliIo, doctorOnline, runConfig } from "../src/cli.ts";
import { FileCredentialStore, readConfig } from "../src/config.ts";
import { createModelSetup } from "../src/model/index.ts";
import { AiipClient } from "../src/net/client.ts";
import type { ChildLike, SpawnFn } from "../src/net/daemon.ts";
import { FakeAiipd, FakeOverlay } from "./net-fake.ts";

const fakes: FakeAiipd[] = [];
afterEach(async () => {
	for (const fake of fakes.splice(0)) await fake.stop();
});

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

/** A spawn serving a fake of `overlay` on the directory it is asked for. */
function fakeSpawn(overlay: FakeOverlay, spawned: FakeAiipd[]): SpawnFn {
	return (_command, args) => {
		const dir = args[args.indexOf("--state-dir") + 1] as string;
		const fake = new FakeAiipd(overlay, join(dir, "aiipd.sock"));
		fakes.push(fake);
		spawned.push(fake);
		void fake.start();
		return new FakeChild(fake);
	};
}

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
	const dir = mkdtempSync(`${tmpdir()}/abai-cli-`);
	dirs.push(dir);
	return dir;
}

function capture(home: string) {
	const out: string[] = [];
	const err: string[] = [];
	const cli: CliIo = { out: (t) => out.push(t), err: (t) => err.push(t), env: { ABAI_HOME: home } };
	return { cli, out, err };
}

describe("abai config", () => {
	test("shows, sets and unsets", async () => {
		const dir = home();
		const { cli, out, err } = capture(dir);
		expect(await runConfig([], cli)).toBe(0);
		expect(out.join("")).toContain("provider: (none)");
		expect(await runConfig(["set", "provider", "nope"], cli)).toBe(2);
		expect(err.join("\n")).toContain("unknown provider nope; config providers lists them");
		expect(readConfig(dir).provider).toBeUndefined();
		expect(await runConfig(["set", "provider", "anthropic"], cli)).toBe(0);
		expect(await runConfig(["set", "model", "claude-opus-5"], cli)).toBe(0);
		expect(await runConfig(["set", "connect-timeout", "5000"], cli)).toBe(0);
		expect(await runConfig(["set", "url", "freetoken", "http://127.0.0.1:1919"], cli)).toBe(0);
		expect(await runConfig(["set", "url", "nope"], cli)).toBe(2);
		expect(await runConfig(["set", "key", "anthropic", "sk-test"], cli)).toBe(0);
		expect(readConfig(dir)).toEqual({
			provider: "anthropic",
			model: "claude-opus-5",
			connectTimeoutMs: 5000,
			providers: { freetoken: { FREETOKEN_BASE_URL: "http://127.0.0.1:1919" } },
		});
		expect(await new FileCredentialStore(dir).read("anthropic")).toEqual({ type: "api_key", key: "sk-test" });
		out.length = 0;
		expect(await runConfig(["show"], cli)).toBe(0);
		expect(out.join("")).toContain("credentials: anthropic (api_key)");
		expect(out.join("")).not.toContain("sk-test");
		expect(await runConfig(["unset", "key", "anthropic"], cli)).toBe(0);
		expect(await new FileCredentialStore(dir).read("anthropic")).toBeUndefined();
		expect(await runConfig(["set", "bogus", "1"], cli)).toBe(2);
		expect(await runConfig(["set", "connect-timeout", "-1"], cli)).toBe(2);
		expect(err.join("\n")).toMatch(/usage: abai config/);
	});

	test("providers lists every provider the harness knows, sorted, with the login each offers", async () => {
		const { cli, out } = capture(home());
		expect(await runConfig(["providers"], cli)).toBe(0);
		const lines = out.join("").trimEnd().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(43);
		const ids = lines.map((line) => line.split(/\s+/)[0]);
		expect(ids).toEqual([...ids].sort());
		expect(lines.find((l) => l.startsWith("anthropic "))).toMatch(/login: account, key\s+Anthropic/);
		expect(lines.find((l) => l.startsWith("openai-codex "))).toMatch(/login: account\s{2,}/);
		expect(lines.find((l) => l.startsWith("freetoken "))).toMatch(/login: key\s{2,}/);
	});
});

describe("abai config net", () => {
	test("aiip-bin is set, shown and unset", async () => {
		const dir = home();
		const { cli, out } = capture(dir);
		expect(await runConfig(["set", "aiip-bin", "/opt/aiip"], cli)).toBe(0);
		expect(readConfig(dir).aiip).toEqual({ bin: "/opt/aiip" });
		expect(await runConfig([], cli)).toBe(0);
		expect(out.join("")).toContain("aiip: /opt/aiip");
		expect(await runConfig(["unset", "aiip-bin"], cli)).toBe(0);
		expect(readConfig(dir).aiip).toBeUndefined();
		out.length = 0;
		expect(await runConfig(["show"], cli)).toBe(0);
		expect(out.join("")).toContain("aiip: (aiip on the PATH)");
	});

	test("net needs the program or ABAI_NET_DIR, and shows the memberships on disk when no daemon runs", async () => {
		const dir = home();
		const { cli, err } = capture(dir);
		expect(await runConfig(["net"], cli)).toBe(2);
		expect(err.join("\n")).toMatch(/config net needs the program .* or ABAI_NET_DIR/);

		const net = join(dir, "net");
		mkdirSync(join(net, "memberships"), { recursive: true });
		writeFileSync(
			join(net, "memberships", "x.json"),
			JSON.stringify({
				networkID: "x".repeat(32),
				networkName: "world",
				identity: { name: "beta", addr: "100.107.0.9" },
				authority: { ca: "..." },
				peers: [{}, {}],
			}),
		);
		const out: string[] = [];
		const withDir: CliIo = { out: (t) => out.push(t), err: () => {}, env: { ABAI_HOME: dir, ABAI_NET_DIR: net } };
		expect(await runConfig(["net"], withDir)).toBe(0);
		const text = out.join("");
		expect(text).toContain(`network dir: ${net}`);
		expect(text).toContain("daemon: not running (it starts with the harness)");
		expect(text).toContain("  beta on world (100.107.0.9), authority");
		out.length = 0;
		expect(await runConfig(["net", "show"], { ...withDir, env: { ABAI_HOME: dir } }, { program: "netty" })).toBe(0);
		expect(out.join("")).toContain(`network dir: ${join(dir, "net", "netty")}`);
		expect(out.join("")).toContain("memberships: (none)");
	});

	test("create, invite, join and leave run against the directory's daemon", async () => {
		const overlay = new FakeOverlay();
		const homeA = home();
		const homeB = home();
		const dirA = join(homeA, "net", "netty");
		const dirB = join(homeB, "net", "netty");
		mkdirSync(dirA, { recursive: true });
		mkdirSync(dirB, { recursive: true });
		// daemons already running in both directories: found, used, and left running
		fakes.push(
			await overlay.newOutsider(join(dirA, "aiipd.sock")),
			await overlay.newOutsider(join(dirB, "aiipd.sock")),
		);
		const a = capture(homeA);
		a.cli.env.ABAI_AIIP_BIN = "/opt/aiip";
		const b = capture(homeB);
		b.cli.env.ABAI_AIIP_BIN = "/opt/aiip";
		const noSpawn: SpawnFn = () => {
			throw new Error("spawn must not be reached");
		};
		const ctx = { program: "netty", spawn: noSpawn };

		expect(await runConfig(["net", "create", "world", "--as", "alpha"], a.cli, ctx)).toBe(0);
		expect(a.out.join("")).toMatch(/^created world as alpha \(100\.107\.\d+\.\d+\), the authority\n$/);
		a.out.length = 0;
		expect(await runConfig(["net", "invite", "world", "--for", "beta"], a.cli, ctx)).toBe(0);
		expect(a.out).toHaveLength(1);
		const token = (a.out[0] as string).trim();
		expect(token).toMatch(/^fake-invite-/);
		expect(a.err.join("\n")).toMatch(/invite for beta \(100\.107\.\d+\.\d+\) on world: a bearer secret/);

		expect(await runConfig(["net", "join", "--token", token], b.cli, ctx)).toBe(0);
		expect(b.out.join("")).toMatch(/^joined world as beta /);
		expect((await new AiipClient(join(dirB, "aiipd.sock")).networks()).map((m) => m.selfName)).toEqual(["beta"]);
		b.out.length = 0;
		expect(await runConfig(["net"], b.cli, ctx)).toBe(0);
		expect(b.out.join("")).toMatch(/daemon: running \(aiip-m8, pid \d+\)/);
		expect(b.out.join("")).toContain("  beta on world (");
		b.out.length = 0;
		expect(await runConfig(["net", "leave", "world"], b.cli, ctx)).toBe(0);
		expect(b.out.join("")).toBe("left world\n");
		expect(await new AiipClient(join(dirB, "aiipd.sock")).networks()).toEqual([]);

		expect(await runConfig(["net", "invite", "world"], a.cli, ctx)).toBe(2);
		expect(await runConfig(["net", "bogus"], a.cli, ctx)).toBe(2);
		expect(await runConfig(["net", "leave", "nope"], b.cli, ctx)).toBe(1);
		expect(b.err.join("\n")).toMatch(/abai config net: no membership matches "nope"/);
	});

	test("a daemon started for one command is ended after it in the run's own directory, kept in the shared one", async () => {
		const dir = home();
		const spawned: FakeAiipd[] = [];
		const own = capture(dir);
		own.cli.env.ABAI_AIIP_BIN = "/opt/aiip";
		own.cli.env.ABAI_NET_DIR = join(dir, "own");
		const ctx = { program: "netty", spawn: fakeSpawn(new FakeOverlay(), spawned) };
		expect(await runConfig(["net", "create", "world", "--as", "alpha"], own.cli, ctx)).toBe(0);
		expect(own.out.join("")).toMatch(/^created world as alpha/);
		expect(spawned).toHaveLength(1);
		const deadline = Date.now() + 1_000;
		while (spawned[0]?.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
		expect(spawned[0]?.running).toBe(false);

		const shared = capture(dir);
		shared.cli.env.ABAI_AIIP_BIN = "/opt/aiip";
		const sharedCtx = { program: "netty", spawn: fakeSpawn(new FakeOverlay(), spawned) };
		expect(await runConfig(["net", "create", "world", "--as", "alpha"], shared.cli, sharedCtx)).toBe(0);
		expect(spawned).toHaveLength(2);
		await new Promise((r) => setTimeout(r, 30));
		expect(spawned[1]?.running).toBe(true); // stays for the program's next run, as the aiip CLI leaves its daemons
	});

	test("doctor's network checks: nothing without a declaration, the binary and the daemon and the memberships otherwise", async () => {
		const dir = home();
		const byName = (checks: Array<{ name: string; status: string; detail: string }>) =>
			Object.fromEntries(
				checks.filter((c) => c.name.startsWith("aiip.")).map((c) => [c.name, [c.status, c.detail]]),
			);

		const plain = await doctorOnline({ name: "netty", model: {} } as never, { ABAI_HOME: dir, PATH: "" });
		expect(byName(plain)).toEqual({});

		const net = join(dir, "net", "netty");
		const declared = { name: "netty", model: {}, network: { doc: "x" } } as never;
		const noBin = await doctorOnline(declared, { ABAI_HOME: dir, PATH: "" });
		expect(byName(noBin)["aiip.binary"]?.[0]).toBe("skip");
		expect(byName(noBin)["aiip.daemon"]).toEqual(["skip", `not running at ${net} (it starts with the harness)`]);
		expect(byName(noBin)["aiip.network"]?.[0]).toBe("skip");

		const required = { name: "netty", model: {}, network: { required: true, doc: "x" } } as never;
		const missing = await doctorOnline(required, { ABAI_HOME: dir, PATH: "" });
		expect(byName(missing)["aiip.binary"]?.[0]).toBe("fail");
		expect(byName(missing)["aiip.network"]?.[0]).toBe("fail");

		mkdirSync(net, { recursive: true });
		const overlay = new FakeOverlay();
		fakes.push(await overlay.newMember("beta", join(net, "aiipd.sock")));
		const live = await doctorOnline(required, { ABAI_HOME: dir, PATH: "", ABAI_AIIP_BIN: "/opt/aiip" });
		expect(byName(live)).toEqual({
			"aiip.binary": ["ok", "/opt/aiip"],
			"aiip.daemon": ["ok", `aiip-m8 at ${join(net, "aiipd.sock")}`],
			"aiip.network": ["ok", "beta on fake"],
		});
	});
});

describe("doctor's online half", () => {
	test("the Anthropic probe sends a key as x-api-key and an account token as a bearer under the OAuth beta", () => {
		expect(anthropicProbeHeaders({ apiKey: "sk-ant-api03-key" })).toEqual({
			"anthropic-version": "2023-06-01",
			"x-api-key": "sk-ant-api03-key",
		});
		expect(anthropicProbeHeaders({ apiKey: "sk-ant-oat01-token" })).toEqual({
			"anthropic-version": "2023-06-01",
			Authorization: "Bearer sk-ant-oat01-token",
			"anthropic-beta": "oauth-2025-04-20",
		});
		expect(anthropicProbeHeaders({ apiKey: "k", headers: { Authorization: "Bearer theirs" } })).toEqual({
			"anthropic-version": "2023-06-01",
			Authorization: "Bearer theirs",
		});
		expect(anthropicProbeHeaders({})).toEqual({ "anthropic-version": "2023-06-01" });
	});

	test("fails with nothing configured, resolves a configured static model, probes its endpoint", async () => {
		const dir = home();
		const manifest = { model: { tools: true } } as never;
		expect(await doctorOnline(manifest, { ABAI_HOME: dir })).toMatchObject([{ name: "online", status: "fail" }]);
		const { cli } = capture(dir);
		await runConfig(["set", "provider", "anthropic"], cli);
		await runConfig(["set", "key", "anthropic", "sk-test"], cli);
		await runConfig(["set", "model", "no-such-model"], cli);
		expect(await doctorOnline(manifest, { ABAI_HOME: dir })).toMatchObject([
			{ name: "online", status: "fail", detail: expect.stringContaining("no model no-such-model") },
		]);
		const known = createModelSetup({ ABAI_HOME: dir }, dir).models.getModels("anthropic")[0].id;
		await runConfig(["set", "model", known], cli);
		// the reachability probe goes to the configured base URL: a closed local port, never the network
		await runConfig(["set", "url", "anthropic", "http://127.0.0.1:9"], cli);
		const checks = await doctorOnline(manifest, { ABAI_HOME: dir });
		expect(checks).toMatchObject([
			{ name: "online", status: "ok" },
			{ name: "reachable", status: "fail", detail: expect.stringContaining("could not be reached") },
			{ name: "model.tools", status: "skip" },
		]);
	});
});
