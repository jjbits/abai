// The stub finds the installed harness package by dynamic import and, with
// no model configured, attaches nothing and says why (abaigrammar 4.3).
import { execSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, expect, test } from "vitest";

const workspace = resolve(import.meta.dirname, "../..");
const example = resolve(workspace, "abai/examples/counter");
const dirs: string[] = [];

// the stub reaches the harness through the packages' real exports, which point at dist: build once
beforeAll(() => {
	execSync("npm run build", { cwd: workspace, stdio: "ignore" });
}, 60_000);
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a program with the harness installed but no model attaches nothing, with the reason (through the built packages)", () => {
	// the copy lives inside the workspace so the bare import of abai-embedded-harness resolves
	const copy = mkdtempSync(join(resolve(import.meta.dirname, ".."), "tmp-seam-"));
	dirs.push(copy);
	cpSync(example, copy, { recursive: true });
	const program = join(copy, "counter.ts");
	writeFileSync(
		program,
		readFileSync(program, "utf8").replaceAll("../../src/", `${resolve(import.meta.dirname, "../../abai/src")}/`),
	);
	const result = spawnSync(process.execPath, [program, "abai"], {
		cwd: copy,
		env: { ...process.env, ABAI_MODE: "", ABAI_HARNESS: "", ABAI_HARNESS_MODULE: "", ABAI_HOME: join(copy, "home") },
		encoding: "utf8",
		timeout: 20_000,
	});
	expect(result.status).toBe(1);
	expect(result.stderr).toMatch(/no harness attached \(no model configured for the embedded harness/);
});

test("the stub delegates config and doctor's online half to the installed harness", () => {
	const copy = mkdtempSync(join(resolve(import.meta.dirname, ".."), "tmp-seam-"));
	dirs.push(copy);
	cpSync(example, copy, { recursive: true });
	const program = join(copy, "counter.ts");
	writeFileSync(
		program,
		readFileSync(program, "utf8").replaceAll("../../src/", `${resolve(import.meta.dirname, "../../abai/src")}/`),
	);
	const home = join(copy, "home");
	const env = { ...process.env, ABAI_MODE: "", ABAI_HARNESS: "", ABAI_HARNESS_MODULE: "", ABAI_HOME: home };
	const run = (args: string[]) =>
		spawnSync(process.execPath, [program, ...args], { cwd: copy, env, encoding: "utf8", timeout: 20_000 });
	expect(run(["abai", "config", "set", "provider", "anthropic"]).status).toBe(0);
	const shown = run(["abai", "config"]);
	expect(shown.status).toBe(0);
	expect(shown.stdout).toContain(`home: ${home}`);
	expect(shown.stdout).toContain("provider: anthropic");
	const doctor = run(["abai", "doctor"]);
	expect(doctor.status).toBe(1);
	expect(doctor.stdout).toMatch(/^fail online: no model configured/m);
	const offline = run(["abai", "doctor", "--offline"]);
	expect(offline.status).toBe(0);
	expect(offline.stdout).toMatch(/^skip online: not asked/m);
});

test("under sidecar the entry spawns the built binary, which fails at once with no model (through the built packages)", () => {
	const copy = mkdtempSync(join(resolve(import.meta.dirname, ".."), "tmp-seam-"));
	dirs.push(copy);
	cpSync(example, copy, { recursive: true });
	const program = join(copy, "counter.ts");
	writeFileSync(
		program,
		readFileSync(program, "utf8").replaceAll("../../src/", `${resolve(import.meta.dirname, "../../abai/src")}/`),
	);
	const result = spawnSync(process.execPath, [program, "abai"], {
		cwd: copy,
		env: {
			...process.env,
			ABAI_MODE: "sidecar",
			ABAI_HARNESS: "",
			ABAI_HOME: join(copy, "home"),
			ABAI_RUN_DIR: join(copy, "run"),
			ABAI_HARNESS_BIN: resolve(import.meta.dirname, "../dist/bin.js"),
		},
		encoding: "utf8",
		timeout: 20_000,
	});
	expect(result.status).toBe(1);
	// the binary said why on the inherited stderr, and the program reported its exit
	expect(result.stderr).toMatch(/no model configured/);
	expect(result.stderr).toMatch(/no harness attached \(the harness binary exited with 1 before connecting\)/);
});

/** Three MCP lines: initialize, list the tools, read the cells. */
const MCP_LINES = [
	'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}',
	'{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
	'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"abai_cells","arguments":{}}}',
	"",
].join("\n");

function mcpResponses(stdout: string): Array<Record<string, unknown>> {
	return stdout
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("the program's own entry serves an MCP client: in-process under turns, through the built binary under sidecar", () => {
	const copy = mkdtempSync(join(resolve(import.meta.dirname, ".."), "tmp-seam-"));
	dirs.push(copy);
	cpSync(example, copy, { recursive: true });
	const program = join(copy, "counter.ts");
	writeFileSync(
		program,
		readFileSync(program, "utf8").replaceAll("../../src/", `${resolve(import.meta.dirname, "../../abai/src")}/`),
	);
	const base = {
		...process.env,
		ABAI_HARNESS: "",
		ABAI_HARNESS_MODULE: "",
		ABAI_HOME: join(copy, "home"),
		ABAI_RUN_DIR: join(copy, "run"),
		ABAI_HARNESS_BIN: resolve(import.meta.dirname, "../dist/bin.js"),
	};
	for (const mode of ["", "sidecar"]) {
		const result = spawnSync(process.execPath, [program, "abai", "mcp"], {
			cwd: copy,
			env: { ...base, ABAI_MODE: mode },
			input: MCP_LINES,
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(result.status, `mode ${mode || "turns"}: ${result.stderr}`).toBe(0);
		const responses = mcpResponses(result.stdout);
		expect(responses.map((r) => r.id)).toEqual([1, 2, 3]);
		expect((responses[0].result as { serverInfo: { name: string } }).serverInfo.name).toBe("abai-embedded-harness");
		expect((responses[1].result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toContain(
			"abai_wait",
		);
		const cells = (responses[2].result as { content: Array<{ text: string }> }).content[0].text;
		expect(JSON.parse(cells)).toEqual({ "queue.depth": 0, "worker.count": 4 });
		// nothing but protocol on stdout; the binary says where it attached on stderr under sidecar
		if (mode === "sidecar") expect(result.stderr).toMatch(/attached to counter \(pid \d+\) as k1/);
	}
});

test("run through the built binary with no model fails at once, with the reason, before any program is started", () => {
	const copy = mkdtempSync(join(resolve(import.meta.dirname, ".."), "tmp-seam-"));
	dirs.push(copy);
	cpSync(example, copy, { recursive: true });
	const program = join(copy, "counter.ts");
	writeFileSync(
		program,
		readFileSync(program, "utf8").replaceAll("../../src/", `${resolve(import.meta.dirname, "../../abai/src")}/`),
	);
	const result = spawnSync(process.execPath, [program, "abai", "run", "--", "2"], {
		cwd: copy,
		env: {
			...process.env,
			ABAI_MODE: "",
			ABAI_HARNESS: "",
			ABAI_HOME: join(copy, "home"),
			ABAI_RUN_DIR: join(copy, "run"),
			ABAI_HARNESS_BIN: resolve(import.meta.dirname, "../dist/bin.js"),
		},
		encoding: "utf8",
		timeout: 20_000,
	});
	expect(result.status).toBe(1);
	expect(result.stderr).toMatch(/no model configured/);
	// the counter itself never ran: its own output would say so
	expect(result.stdout).not.toMatch(/counter: 2 batches/);
});

test("the sidecar binary runs as a process entry and exits with the verb's code (through the built package)", () => {
	const bin = resolve(import.meta.dirname, "../dist/bin.js");
	const home = mkdtempSync(join(resolve(import.meta.dirname, ".."), "tmp-seam-"));
	dirs.push(home);
	const env = { ...process.env, ABAI_HOME: home };
	const help = spawnSync(process.execPath, [bin, "help"], { env, encoding: "utf8", timeout: 20_000 });
	expect(help.status).toBe(0);
	expect(help.stdout).toMatch(/usage: abai-embedded-harness session/);
	// a relative path to the entry still counts as the entry
	const list = spawnSync(process.execPath, ["dist/bin.js", "list", "--run-dir", home], {
		cwd: resolve(import.meta.dirname, ".."),
		env,
		encoding: "utf8",
		timeout: 20_000,
	});
	expect(list.status).toBe(0);
	expect(list.stdout).toMatch(/no program is running/);
	const bad = spawnSync(process.execPath, [bin, "nope"], { env, encoding: "utf8", timeout: 20_000 });
	expect(bad.status).toBe(2);
});
