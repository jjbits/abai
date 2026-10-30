// The abaikit binary: its arguments, its usage, the verbs' placeholders,
// abaikit's own standard agent entry, and the hello example.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type AbaikitIo, main, parseArgs, UsageError } from "../src/bin.ts";

const root = resolve(import.meta.dirname, "..");
const hello = join(root, "examples/hello");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "abaikit-home-"));
	dirs.push(dir);
	return dir;
}

function capture(env: NodeJS.ProcessEnv = {}, cwd = root) {
	const out: string[] = [];
	const err: string[] = [];
	const io: AbaikitIo = { out: (t) => out.push(t), err: (t) => err.push(`${t}\n`), env, cwd };
	return { io, out: () => out.join(""), err: () => err.join("") };
}

describe("abaikit's arguments", () => {
	test("parses each verb with every flag", () => {
		expect(parseArgs(["learnabai", "--section", "retrofit", "--json", "--skill", "--skill-dir", "/tmp/s"])).toEqual({
			verb: "learnabai",
			section: "retrofit",
			json: true,
			skill: true,
			skillDir: "/tmp/s",
		});
		expect(
			parseArgs([
				"check",
				"repo",
				"--level",
				"3",
				"--mode",
				"sidecar",
				"--entry",
				"node x.js abai",
				"--runs",
				"2",
				"--timeout",
				"60",
				"--json",
			]),
		).toEqual({
			verb: "check",
			repo: "repo",
			level: 3,
			mode: "sidecar",
			entry: "node x.js abai",
			runs: 2,
			timeoutS: 60,
			json: true,
		});
		expect(
			parseArgs([
				"new",
				"app",
				"--lang",
				"ts",
				"--level",
				"2",
				"--dir",
				"/tmp/app",
				"--abai-import",
				"@abaigram/abai-stub",
			]),
		).toEqual({ verb: "new", name: "app", lang: "ts", level: 2, dir: "/tmp/app", abaiImport: "@abaigram/abai-stub" });
		expect(parseArgs(["abaify", "repo", "--level", "4", "--mode", "turns", "--rounds", "7", "--dry-run"])).toEqual({
			verb: "abaify",
			repo: "repo",
			level: 4,
			mode: "turns",
			rounds: 7,
			dryRun: true,
		});
		expect(parseArgs(["run", "repo", "--", "--x", "1"])).toEqual({ verb: "run", repo: "repo", args: ["--x", "1"] });
		expect(parseArgs(["check", "repo"])).toEqual({ verb: "check", repo: "repo", json: false });
		for (const help of [[], ["help"], ["--help"], ["-h"]]) expect(parseArgs(help)).toEqual({ verb: "help" });
	});

	test("refuses what is missing, unknown or out of range", () => {
		const cases: [string[], RegExp][] = [
			[["check"], /^check needs a repository$/],
			[["new", "app"], /^new needs --lang <ts>$/],
			[["new", "app", "--lang", "py"], /^unknown language py; only ts is supported$/],
			[["check", "repo", "--level", "5"], /^--level needs a level from 1 to 4$/],
			[["run"], /^run needs a repository$/],
			[["learnabai", "--skill-dir", "x"], /^--skill-dir goes with --skill$/],
			[["check", "repo", "--json=1"], /^--json takes no value$/],
			[["check", "repo", "--level="], /^--level needs a value$/],
			[["check", "repo", "--verbose"], /^unknown argument --verbose$/],
			[["check", "repo", "--entry"], /^--entry needs a value$/],
			[["abaify", "repo", "--rounds", "0"], /^--rounds needs a positive integer$/],
			[["frobnicate"], /^unknown verb frobnicate$/],
		];
		for (const [argv, message] of cases) {
			expect(() => parseArgs(argv)).toThrow(UsageError);
			expect(() => parseArgs(argv)).toThrow(message);
		}
	});
});

describe("abaikit's main", () => {
	test("--help and no verb print the usage", async () => {
		for (const argv of [["--help"], []]) {
			const { io, out } = capture();
			expect(await main(argv, io)).toBe(0);
			expect(out().startsWith("usage: abaikit")).toBe(true);
		}
	});

	test("a usage error exits 2 with the message", async () => {
		const { io, err } = capture();
		expect(await main(["run"], io)).toBe(2);
		expect(err()).toMatch(/^abaikit: run needs a repository$/m);
	});

	test("abai manifest prints exactly the checked-in abaigram.yaml", async () => {
		const { io, out } = capture({ ABAI_HOME: tempHome(), ABAI_HARNESS: "" });
		expect(await main(["abai", "manifest"], io)).toBe(0);
		expect(out()).toBe(readFileSync(join(root, "abaigram.yaml"), "utf8"));
	});

	test("abai doctor passes offline on the package", async () => {
		// abaikit's audit goes to the user's abai home by default, so doctor needs a HOME to resolve it under
		const home = tempHome();
		const { io, out } = capture({ HOME: home, ABAI_HOME: join(home, ".abai"), ABAI_HARNESS: "" });
		expect(await main(["abai", "doctor", "--offline", "--json"], io)).toBe(0);
		expect(JSON.parse(out()).ok).toBe(true);
	});
});

describe("the hello example", () => {
	// a temporary copy whose `@abaigram/abai-stub` import points at the stub's source, so no build is needed and nothing is
	// written into the checked-in example
	const copyHello = (): string => {
		const copy = mkdtempSync(join(tmpdir(), "abaikit-hello-"));
		dirs.push(copy);
		cpSync(hello, copy, { recursive: true });
		const program = join(copy, "hello.ts");
		writeFileSync(
			program,
			readFileSync(program, "utf8").replace(
				'from "@abaigram/abai-stub"',
				`from "${resolve(root, "../abai-stub/src/index.ts")}"`,
			),
		);
		return copy;
	};
	const run = (args: string[]) => {
		const copy = copyHello();
		return spawnSync(process.execPath, [join(copy, "hello.ts"), ...args], {
			cwd: copy,
			env: { ...process.env, ABAI_MODE: "", ABAI_HARNESS: "", ABAI_HOME: tempHome() },
			encoding: "utf8",
			timeout: 20_000,
		});
	};

	test("doctor passes offline", () => {
		const result = run(["abai", "doctor", "--offline", "--json"]);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout).ok).toBe(true);
	});

	test("prints hello", () => {
		const result = run([]);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("hello\n");
	});
});
