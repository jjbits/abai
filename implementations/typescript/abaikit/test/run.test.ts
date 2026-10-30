// abaikit run: the repository's own `<entry> run -- ARGS`, found through
// its abaigram.yaml and run by the shell in its root. A stand-in harness
// binary records what the entry asked it to launch, so no model is needed.
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type AbaikitIo, main } from "../src/bin.ts";
import { entryCommand, findSubjectRoot, shellQuote } from "../src/subject.ts";

const counterExample = resolve(import.meta.dirname, "../../abai-stub/examples/counter");
const stubSrc = resolve(import.meta.dirname, "../../abai-stub/src");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function capture(env: NodeJS.ProcessEnv, cwd: string) {
	const out: string[] = [];
	const err: string[] = [];
	const io: AbaikitIo = { out: (t) => out.push(t), err: (t) => err.push(`${t}\n`), env, cwd };
	return { io, out: () => out.join(""), err: () => err.join("") };
}

/** A copy of the counter in a temporary directory, its import pointed at the stub's source. */
function copyCounter(dir: string): string {
	const copy = join(dir, "counter");
	cpSync(counterExample, copy, { recursive: true });
	const program = join(copy, "counter.ts");
	writeFileSync(program, readFileSync(program, "utf8").replaceAll("../../src/", `${stubSrc}/`));
	return copy;
}

describe("abaikit run", () => {
	test("runs the repository's entry with run -- ARGS in its root, arguments quoted whole, and returns its exit code", async () => {
		const dir = mkdtempSync(join(tmpdir(), "abaikit-run-"));
		dirs.push(dir);
		const repo = copyCounter(dir);
		// a stand-in for the harness binary: it records its arguments and exits 5
		const record = join(dir, "standin.txt");
		const standIn = join(dir, "standin.mjs");
		writeFileSync(
			standIn,
			'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.STANDIN_OUT, process.argv.slice(2).join("\\n"));\nprocess.exit(5);\n',
		);
		const env = {
			...process.env,
			ABAI_MODE: "",
			ABAI_HARNESS: "",
			ABAI_HOME: join(dir, "home"),
			ABAI_HARNESS_BIN: standIn,
			STANDIN_OUT: record,
		};
		// from a directory inside the repository, by a relative path, with arguments the shell would otherwise split
		const { io, err } = capture(env, dir);
		expect(await main(["run", "counter/abai", "--", "2", "two words", "it's"], io)).toBe(5);
		expect(err()).toBe("");
		const recorded = readFileSync(record, "utf8").split("\n");
		expect(recorded.slice(0, 3)).toEqual(["run", "--", process.execPath]);
		expect(recorded[3]).toBe(realpathSync(join(repo, "counter.ts")));
		expect(recorded.slice(4)).toEqual(["2", "two words", "it's"]);
	});

	test("a path with no abaigram.yaml above it, or none at all, is a usage error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "abaikit-run-none-"));
		dirs.push(dir);
		const { io, err } = capture({ ...process.env }, dir);
		expect(await main(["run", ".", "--", "x"], io)).toBe(2);
		expect(err()).toMatch(/no abaigram.yaml here or above it/);
		const missing = capture({ ...process.env }, dir);
		expect(await main(["run", "nowhere"], missing.io)).toBe(2);
		expect(missing.err()).toMatch(/nowhere: no such file or directory/);
	});

	test("a repository whose manifest declares no sidecar mode is refused before anything runs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "abaikit-run-turns-"));
		dirs.push(dir);
		const repo = copyCounter(dir);
		const manifest = join(repo, "abaigram.yaml");
		writeFileSync(
			manifest,
			readFileSync(manifest, "utf8").replace("modes:\n  - turns\n  - sidecar\n", "modes:\n  - turns\n"),
		);
		const { io, err } = capture({ ...process.env, ABAI_HARNESS_BIN: join(dir, "must-not-run") }, dir);
		expect(await main(["run", "counter", "--", "1"], io)).toBe(2);
		expect(err()).toMatch(/run is sidecar launch, and counter declares turns only/);
	});

	test("the root is the nearest manifest above the path; the entry command quotes only what needs it", () => {
		const dir = mkdtempSync(join(tmpdir(), "abaikit-root-"));
		dirs.push(dir);
		const repo = copyCounter(dir);
		expect(findSubjectRoot(join(repo, "abai", "identity.md"))).toBe(repo);
		expect(findSubjectRoot(dir)).toBeUndefined();
		expect(shellQuote("plain-1.2/x")).toBe("plain-1.2/x");
		expect(shellQuote("two words")).toBe("'two words'");
		expect(shellQuote("it's")).toBe("'it'\\''s'");
		const manifest = { entry: "node counter.ts abai" } as Parameters<typeof entryCommand>[0];
		expect(entryCommand(manifest, "run", "--", "3", "a b")).toBe("node counter.ts abai run -- 3 'a b'");
	});
});
