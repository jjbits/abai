import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runDoctor, runEntry } from "../src/entry.ts";
import { createAbaigram } from "../src/program.ts";

const example = resolve(import.meta.dirname, "../examples/counter");
const program = join(example, "counter.ts");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
	const result = spawnSync(process.execPath, [program, ...args], {
		cwd: options.cwd ?? example,
		env: { ...process.env, ABAI_MODE: "", ABAI_HARNESS: "", ...options.env },
		encoding: "utf8",
		timeout: 20_000,
	});
	return { code: result.status, out: result.stdout, err: result.stderr };
}

describe("<prog> abai", () => {
	test("manifest prints exactly the checked-in abaigram.yaml", () => {
		const { code, out } = run(["abai", "manifest"]);
		expect(code).toBe(0);
		expect(out).toBe(readFileSync(join(example, "abaigram.yaml"), "utf8"));
		expect(out.startsWith("# abaigram.yaml: the manifest of counter as an abaigram (abaigrammar 0.1).\n")).toBe(true);
	});

	test("manifest --json prints the manifest as JSON", () => {
		const { code, out } = run(["abai", "manifest", "--json"]);
		expect(code).toBe(0);
		expect(JSON.parse(out)).toMatchObject({ abaigrammar: "0.1", name: "counter", modes: ["turns", "sidecar"] });
	});

	test("manifest refuses an undeclared ABAI_MODE at the entry", () => {
		const { code, err } = run(["abai", "manifest"], { env: { ABAI_MODE: "thread" } });
		expect(code).toBe(2);
		expect(err).toMatch(/ABAI_MODE=thread is not a declared mode/);
	});

	test("doctor passes on the example checkout (offline half)", () => {
		const { code, out } = run(["abai", "doctor", "--offline"]);
		expect(code).toBe(0);
		expect(out).toMatch(/^ok {3}entry: node counter.ts abai reached/m);
		expect(out).toMatch(/^ok {3}abaigram.yaml: .* validates and agrees with the code$/m);
		expect(out).toMatch(/^ok {3}identity: /m);
		expect(out).toMatch(/^skip online: not asked/m);
		expect(out.trimEnd().endsWith("doctor: ok")).toBe(true);
	});

	test("doctor --json reports the checks", () => {
		const { code, out } = run(["abai", "doctor", "--json", "--offline"]);
		expect(code).toBe(0);
		const report = JSON.parse(out);
		expect(report.ok).toBe(true);
		expect(report.checks.map((c: { name: string }) => c.name)).toEqual([
			"entry",
			"manifest",
			"root",
			"abaigram.yaml",
			"identity",
			"harness",
			"modes",
			"audit",
			"online",
		]);
	});

	test("doctor's online half is the harness's: skipped when none is installed, otherwise its verdict", () => {
		const { out } = run(["abai", "doctor"], { env: { ABAI_HOME: mkdtempSync(`${tmpdir()}/abai-nohome-`) } });
		expect(out).toMatch(/^(skip online: no harness is installed|fail online: no model configured)/m);
	});

	test("doctor fails on a stale abaigram.yaml and names the line", () => {
		const copy = mkdtempSync(`${tmpdir()}/abai-stale-`);
		dirs.push(copy);
		cpSync(example, copy, { recursive: true });
		const path = join(copy, "abaigram.yaml");
		writeFileSync(path, readFileSync(path, "utf8").replace("default: 4", "default: 5"));
		const { code, out } = run(["abai", "doctor", "--root", copy]);
		expect(code).toBe(1);
		expect(out).toMatch(/^fail abaigram.yaml: .* is stale: first difference at line \d+/m);
		expect(out.trimEnd().endsWith("doctor: failed")).toBe(true);
	});

	test("doctor fails on a missing identity and an undeclared ABAI_MODE", () => {
		const copy = mkdtempSync(`${tmpdir()}/abai-noid-`);
		dirs.push(copy);
		cpSync(example, copy, { recursive: true });
		rmSync(join(copy, "abai/identity.md"));
		const { code, out } = run(["abai", "doctor", "--root", copy], { env: { ABAI_MODE: "thread" } });
		expect(code).toBe(1);
		expect(out).toMatch(/^fail identity: .* is missing$/m);
		expect(out).toMatch(/^fail modes: ABAI_MODE=thread is not declared/m);
	});

	test("doctor fails on a root with no abaigram.yaml", () => {
		const empty = mkdtempSync(`${tmpdir()}/abai-empty-`);
		dirs.push(empty);
		const { code, out } = run(["abai", "doctor", "--root", empty]);
		expect(code).toBe(1);
		expect(out).toMatch(/^fail abaigram.yaml: .* is missing; run: node counter.ts abai manifest > abaigram.yaml$/m);
	});

	test("doctor skips the checkout checks when no checkout can be found", async () => {
		const empty = mkdtempSync(`${tmpdir()}/abai-nowhere-`);
		dirs.push(empty);
		const app = createAbaigram({ name: "nowhere", modes: ["turns"] }, { root: empty, env: {} });
		const out: string[] = [];
		const report = await runDoctor(app, {
			io: { out: (t) => out.push(t), err: () => {}, env: { HOME: empty }, cwd: empty },
			online: false,
		});
		expect(report.root).toBeNull();
		expect(report.checks.find((c) => c.name === "root")).toMatchObject({ status: "skip" });
		expect(report.checks.find((c) => c.name === "abaigram.yaml")).toMatchObject({ status: "skip" });
		expect(report.checks.find((c) => c.name === "identity")).toMatchObject({ status: "skip" });
		expect(report.ok).toBe(true);
	});

	test("doctor reports an unknown ABAI_HARNESS as a failed check", () => {
		const { code, out } = run(["abai", "doctor"], { env: { ABAI_HARNESS: "maybe" } });
		expect(code).toBe(1);
		expect(out).toMatch(/^fail harness: ABAI_HARNESS must be unset/m);
	});

	test("an unknown verb and a verb that needs a harness binding print the usage and exit 2", () => {
		expect(run(["abai", "bogus"]).code).toBe(2);
		// the harness package resolves in this workspace, so the verb is made to miss it on purpose
		const mcp = run(["abai", "mcp"], { env: { ABAI_HARNESS_MODULE: "/nonexistent/harness.js" } });
		expect(mcp.code).toBe(2);
		expect(mcp.err).toMatch(/mcp needs the harness package, which is not installed/);
		expect(mcp.code).toBe(2);
		expect(mcp.err).toMatch(/usage: node counter.ts abai/);
	});

	test("session and install return at once under a null harness, exit 0", () => {
		expect(run(["abai"], { env: { ABAI_HARNESS: "null" } }).code).toBe(0);
		expect(run(["abai", "install"], { env: { ABAI_HARNESS: "null" } }).code).toBe(0);
	});

	test("session and install return without a harness: a message, exit 1, no usage text", () => {
		const session = run(["abai"]);
		expect(session.code).toBe(1);
		// the reason depends on whether the harness package resolves here: not installed, or installed with no model
		expect(session.err).toMatch(
			/^node counter.ts abai: no harness attached \((no harness is installed|no model configured)/,
		);
		expect(session.err).not.toMatch(/usage:/);
		const install = run(["abai", "install"], { env: { ABAI_HARNESS: "off" } });
		expect(install.code).toBe(1);
		expect(install.err).toMatch(/no harness attached \(ABAI_HARNESS=off\)/);
	});

	test("under sidecar the entry spawns the harness binary; its fate is the session's fate", () => {
		const dir = mkdtempSync(join(tmpdir(), "entry-sc-"));
		dirs.push(dir);
		const failing = join(dir, "failing.mjs");
		writeFileSync(failing, "process.exit(3);\n");
		const env = { ABAI_MODE: "sidecar", ABAI_RUN_DIR: join(dir, "run"), ABAI_HOME: join(dir, "home") };
		const failed = run(["abai"], { env: { ...env, ABAI_HARNESS_BIN: failing } });
		expect(failed.code).toBe(1);
		expect(failed.err).toMatch(/no harness attached \(the harness binary exited with 3 before connecting\)/);
		// a binary that connects and returns the touchpoint: the session ends well
		const connecting = join(dir, "connecting.mjs");
		writeFileSync(
			connecting,
			[
				'import { createConnection } from "node:net";',
				'const socket = createConnection(process.argv[process.argv.indexOf("--target") + 1]);',
				'let buffer = "";',
				'socket.on("data", (chunk) => {',
				'	buffer += chunk.toString("utf8");',
				'	let at = buffer.indexOf("\\n");',
				"	while (at >= 0) {",
				"		const line = JSON.parse(buffer.slice(0, at));",
				"		buffer = buffer.slice(at + 1);",
				'		at = buffer.indexOf("\\n");',
				'		if (line.type === "touchpoint") socket.write(JSON.stringify({ type: "touchpoint_end", id: line.id }) + "\\n");',
				"	}",
				"});",
				'socket.on("close", () => process.exit(0));',
			].join("\n"),
		);
		const served = run(["abai"], { env: { ...env, ABAI_HARNESS_BIN: connecting } });
		expect(served.err).toBe("");
		expect(served.code).toBe(0);
		// doctor under sidecar reports its endpoint, which the entry opened at startup
		const doctor = run(["abai", "doctor", "--offline"], { env });
		expect(doctor.code).toBe(0);
		expect(doctor.out).toMatch(/^ok {3}endpoint: listening at .*\.sock$/m);
	});

	test("under sidecar, mcp is served by the binary on this process's stdio, and its exit is the entry's", () => {
		const dir = mkdtempSync(join(tmpdir(), "entry-mcp-"));
		dirs.push(dir);
		// a stand-in for the binary's mcp verb: it connects (so the program is attached), echoes the first
		// line it reads on stdin as its own output, and exits 7 with it
		const standIn = join(dir, "mcp.mjs");
		writeFileSync(
			standIn,
			[
				'import { createConnection } from "node:net";',
				'import { createInterface } from "node:readline";',
				'const socket = createConnection(process.argv[process.argv.indexOf("--target") + 1]);',
				'socket.on("data", () => {});',
				'socket.once("connect", () => {',
				'	createInterface({ input: process.stdin }).once("line", (line) => {',
				'		process.stdout.write("served " + line + "\\n");',
				"		process.exit(7);",
				"	});",
				"});",
			].join("\n"),
		);
		const result = spawnSync(process.execPath, [program, "abai", "mcp"], {
			cwd: example,
			env: {
				...process.env,
				ABAI_MODE: "sidecar",
				ABAI_HARNESS: "",
				ABAI_RUN_DIR: join(dir, "run"),
				ABAI_HOME: join(dir, "home"),
				ABAI_HARNESS_BIN: standIn,
			},
			input: '{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(result.stdout).toBe('served {"jsonrpc":"2.0","id":1,"method":"ping"}\n');
		expect(result.status).toBe(7);
	});

	test("run is sidecar launch: refused by a program that declares no sidecar mode, else the binary is started with this program's own command", () => {
		const dir = mkdtempSync(join(tmpdir(), "entry-run-"));
		dirs.push(dir);
		// a copy of the counter that declares turns only
		cpSync(example, join(dir, "turns-only"), { recursive: true });
		const turnsOnly = join(dir, "turns-only", "counter.ts");
		writeFileSync(
			turnsOnly,
			readFileSync(turnsOnly, "utf8")
				.replaceAll("../../src/", `${resolve(import.meta.dirname, "../src")}/`)
				.replace('modes: ["turns", "sidecar"],', 'modes: ["turns"],'),
		);
		const refused = spawnSync(process.execPath, [turnsOnly, "abai", "run", "--", "3"], {
			cwd: join(dir, "turns-only"),
			env: { ...process.env, ABAI_MODE: "", ABAI_HARNESS: "" },
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(refused.status).toBe(2);
		expect(refused.stderr).toMatch(/run is sidecar launch, and counter declares turns/);
		// a stand-in binary that prints what it was asked to run
		const standIn = join(dir, "run.mjs");
		writeFileSync(standIn, 'console.log(process.argv.slice(2).join(" "));\nprocess.exit(5);\n');
		const launched = run(["abai", "run", "--auto", "--", "3"], {
			env: { ABAI_RUN_DIR: join(dir, "run"), ABAI_HOME: join(dir, "home"), ABAI_HARNESS_BIN: standIn },
		});
		expect(launched.out.trim()).toBe(`run --auto -- ${process.execPath} ${program} 3`);
		expect(launched.code).toBe(5);
	});

	test("under launch the entry attaches before the program's own work, so its first touchpoint finds the agent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "entry-launch-"));
		dirs.push(dir);
		process.env.ABAI_LAUNCH_SOCKET = join(dir, "launch.sock");
		process.env.ABAI_ATTACH_WAIT_MS = "150";
		process.env.ABAI_HARNESS_BIN = join(dir, "must-not-run");
		try {
			const app = createAbaigram(
				{ name: "launched", modes: ["sidecar"] },
				{ root: dir, auditPath: join(dir, "a.jsonl") },
			);
			expect(app.launched).toBe(true);
			const started = Date.now();
			// a plain invocation: the entry waits for the launcher before handing the program its own arguments
			const io = { out: () => {}, err: () => {}, env: process.env, cwd: dir };
			expect(await runEntry(app, ["3"], io)).toBe(-1);
			expect(Date.now() - started).toBeGreaterThanOrEqual(140);
			expect(app.attachError).toMatch(/launched, but the launcher did not connect within 150 ms/);
			app.endpoint?.close("test over");
		} finally {
			delete process.env.ABAI_LAUNCH_SOCKET;
			delete process.env.ABAI_ATTACH_WAIT_MS;
			delete process.env.ABAI_HARNESS_BIN;
		}
	});

	test("without the abai word the program runs as itself", () => {
		const { code, out } = run(["2"]);
		expect(code).toBe(0);
		expect(out).toMatch(/^counter: 2 batches/);
		expect(out).toMatch(/"turn:end_of_batch":2/);
	});
});
