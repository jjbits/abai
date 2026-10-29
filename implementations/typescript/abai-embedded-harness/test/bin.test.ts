import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { defaultRunDir, main, parseArgs, runMcp } from "../src/bin.ts";
import type { CliIo } from "../src/cli.ts";
import { mcpClient } from "./helpers/jsonrpc.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function capture(env: NodeJS.ProcessEnv) {
	const out: string[] = [];
	const err: string[] = [];
	const io: CliIo = { out: (t) => out.push(t), err: (t) => err.push(t), env };
	return { io, out, err };
}

describe("the sidecar binary's arguments", () => {
	test("parses the session flags into harness options", () => {
		const parsed = parseArgs([
			"session",
			"--target",
			"/tmp/p.sock",
			"--run-dir",
			"/tmp/run",
			"--claim",
			"a, b",
			"--claim-timeout",
			"5000",
			"--wake",
			"x.y",
			"--budget",
			"3",
			"--auto",
			"--all-events",
		]);
		expect(parsed).toEqual({
			verb: "session",
			target: "/tmp/p.sock",
			runDir: "/tmp/run",
			options: { claims: ["a", "b"], claimTimeoutMs: 5000, wakes: ["x.y"], budget: 3, auto: true },
			allEvents: true,
			json: false,
			rest: [],
			program: [],
		});
		expect(parseArgs(["config", "set", "model", "m"]).rest).toEqual(["set", "model", "m"]);
		expect(parseArgs(["attach", "--target", "/tmp/p.sock", "--auto"])).toMatchObject({
			verb: "attach",
			target: "/tmp/p.sock",
			options: { auto: true },
		});
		expect(parseArgs(["mcp", "--run-dir", "/tmp/run", "--claim", "x"])).toMatchObject({
			verb: "mcp",
			target: undefined,
			runDir: "/tmp/run",
			options: { claims: ["x"] },
		});
		// run takes the program's own command after --, and nothing else may
		expect(parseArgs(["run", "--auto", "--", "node", "app.js", "--fast"])).toMatchObject({
			verb: "run",
			options: { auto: true },
			program: ["node", "app.js", "--fast"],
		});
		expect(() => parseArgs(["run"])).toThrow(/run needs a program/);
		expect(() => parseArgs(["run", "--"])).toThrow(/run needs a program/);
		expect(() => parseArgs(["session", "--", "node"])).toThrow(/takes no program/);
		expect(parseArgs([]).verb).toBe("help");
	});

	test("refuses what it does not know", () => {
		expect(() => parseArgs(["bogus"])).toThrow(/unknown verb/);
		expect(() => parseArgs(["session", "--target"])).toThrow(/needs a value/);
		expect(() => parseArgs(["session", "--budget", "0"])).toThrow(/positive integer/);
		expect(() => parseArgs(["session", "--auto", "--deny-mutate"])).toThrow(/exclude each other/);
		expect(() => parseArgs(["list", "--what"])).toThrow(/unknown argument/);
	});
});

describe("the sidecar binary's verbs", () => {
	test("help, usage errors, list with nothing running, and a session with no model", async () => {
		const home = mkdtempSync(join(tmpdir(), "bin-"));
		dirs.push(home);
		const env = { ABAI_HOME: home };
		expect(defaultRunDir(env)).toBe(join(home, "run"));
		let io = capture(env);
		expect(await main(["help"], io.io)).toBe(0);
		expect(io.out.join("")).toMatch(/usage: abai-embedded-harness session/);
		io = capture(env);
		expect(await main(["nope"], io.io)).toBe(2);
		expect(io.err.join("\n")).toMatch(/unknown verb nope/);
		io = capture(env);
		expect(await main(["list"], io.io)).toBe(0);
		expect(io.out.join("")).toMatch(/no program is running/);
		io = capture(env);
		expect(await main(["list", "--json"], io.io)).toBe(0);
		expect(JSON.parse(io.out.join(""))).toEqual([]);
		// no model configured: the session fails before any connection is attempted (section 4.3)
		io = capture(env);
		expect(await main(["session", "--target", join(home, "none.sock")], io.io)).toBe(1);
		expect(io.err.join("\n")).toMatch(/no model configured/);
		// attach needs the program's socket, and a model before it connects, like session
		io = capture(env);
		expect(await main(["attach"], io.io)).toBe(2);
		expect(io.err.join("\n")).toMatch(/attach needs --target/);
		io = capture(env);
		expect(await main(["attach", "--target", join(home, "none.sock")], io.io)).toBe(1);
		expect(io.err.join("\n")).toMatch(/no model configured/);
		// doctor without a target reports the configuration only
		io = capture(env);
		expect(await main(["doctor"], io.io)).toBe(1);
		expect(io.out.join("")).toMatch(/fail online: no model configured/);
	});

	test("mcp needs no model: with nothing to attach to it serves detached, says so, and ends with its input", async () => {
		const home = mkdtempSync(join(tmpdir(), "bin-mcp-"));
		dirs.push(home);
		const io = capture({ ABAI_HOME: home });
		const input = new PassThrough();
		const output = new PassThrough();
		const stderr = new PassThrough();
		const client = mcpClient(input, output);
		const served = runMcp(parseArgs(["mcp", "--run-dir", join(home, "run")]), io.io, { input, output, stderr });
		const initialized = await client.request("initialize", { protocolVersion: "2025-06-18" });
		expect((initialized.result as { instructions: string }).instructions).toContain("abai_attach");
		expect(JSON.parse((await client.call("abai_status")).text)).toMatchObject({ attached: false });
		const attach = await client.call("abai_attach");
		expect(attach.isError).toBe(true);
		expect(attach.text).toMatch(/no program is running/);
		input.end();
		expect(await served).toBe(0);
		expect(io.err.join("\n")).toMatch(/not attached \(no program is running\)/);
	});
});
