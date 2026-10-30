// The repository capabilities: bounded reads, and writes that can only add.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { subjectEnv } from "../src/command.ts";
import {
	addDependency,
	insertRepo,
	installRepo,
	LIST_CAP,
	listRepo,
	READ_CAP_BYTES,
	type RepoContext,
	readRepo,
	regenerateManifest,
	repoHandlers,
	summarizeRepo,
	writeRepo,
} from "../src/repo.ts";

const root = resolve(import.meta.dirname, "..");
const plainCli = join(root, "test/fixtures/plain-cli");
const hello = join(root, "examples/hello");
const stubIndex = resolve(root, "../abai/src/index.ts");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copy(from: string, prefix: string): { dir: string; repo: string; ctx: RepoContext } {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	const repo = join(dir, "repo");
	mkdirSync(repo);
	for (const entry of ["package.json", "src", "README.md", "hello.ts", "abai", "abaigram.yaml"]) {
		if (existsSync(join(from, entry))) cpSync(join(from, entry), join(repo, entry), { recursive: true });
	}
	const ctx: RepoContext = {
		cwd: dir,
		env: { ...subjectEnv(process.env), ABAI_HOME: join(dir, "home") },
		changes: [],
	};
	return { dir, repo, ctx };
}

describe("reading", () => {
	test("list skips dependencies, build output and what .gitignore names, and is bounded", () => {
		const { repo } = copy(plainCli, "repo-list-");
		mkdirSync(join(repo, "node_modules", "x"), { recursive: true });
		writeFileSync(join(repo, "node_modules", "x", "index.js"), "");
		mkdirSync(join(repo, "generated"));
		writeFileSync(join(repo, "generated", "out.txt"), "");
		writeFileSync(join(repo, "notes.log"), "");
		writeFileSync(join(repo, ".gitignore"), "generated/\n*.log\n");
		const { count, listing } = listRepo(repo);
		expect(listing.split("\n").sort()).toEqual([".gitignore", "README.md", "package.json", "src/main.js"]);
		expect(count).toBe(4);
		expect(listRepo(repo, "*.json").listing).toBe("package.json");
		mkdirSync(join(repo, "many"));
		for (let i = 0; i < LIST_CAP + 5; i++)
			writeFileSync(join(repo, "many", `f${String(i).padStart(4, "0")}.txt`), "");
		const bounded = listRepo(repo);
		expect(bounded.count).toBe(LIST_CAP);
		expect(bounded.total).toBe(LIST_CAP + 9);
		expect(bounded.truncated).toBe(9);
		// the bound is said first, so a reader that is cut short still knows
		expect(bounded.listing.startsWith(`[${LIST_CAP} of ${LIST_CAP + 9} files listed; 9 more: narrow with glob`)).toBe(
			true,
		);
		expect(listRepo(repo, "many/f000*").count).toBe(10);
		// the shape for a brief: root files, directories with counts; a src/build is the program's own
		mkdirSync(join(repo, "src", "build"), { recursive: true });
		writeFileSync(join(repo, "src", "build", "step.js"), "");
		const { total, summary } = summarizeRepo(repo);
		expect(summary.split("\n")).toEqual([
			".gitignore",
			"README.md",
			"package.json",
			`many/ (${LIST_CAP + 5} files)`,
			"src/ (2 files)",
		]);
		expect(total).toBe(LIST_CAP + 5 + 3 + 2);
	});

	test("read gives a window of a file and refuses a path outside the repository", () => {
		const { repo } = copy(plainCli, "repo-read-");
		const whole = readRepo(repo, "src/main.js");
		expect(whole.from).toBe(1);
		expect(whole.total_lines).toBeGreaterThan(5);
		const window = readRepo(repo, "src/main.js", 2, 2);
		expect(window.text.split("\n")).toHaveLength(2);
		expect(window).toMatchObject({ from: 2, to: 3 });
		expect(() => readRepo(repo, "../outside.txt")).toThrow(/outside the repository/);
		expect(() => readRepo(repo, "nope.js")).toThrow(/no such file/);
		// bytes bound a window too, and the window says where it stopped
		writeFileSync(
			join(repo, "wide.txt"),
			Array.from({ length: 50 }, (_, i) => `${i}:${"x".repeat(1000)}`).join("\n"),
		);
		const wide = readRepo(repo, "wide.txt");
		expect(wide.text.length).toBeLessThanOrEqual(READ_CAP_BYTES);
		expect(wide.to).toBeLessThan(50);
		expect(wide.total_lines).toBe(50);
		expect(readRepo(repo, "wide.txt", wide.to + 1).from).toBe(wide.to + 1);
	});
});

describe("adding", () => {
	test("write makes a new file and refuses an existing one; insert adds at a unique anchor and nothing else", () => {
		const { repo, ctx } = copy(plainCli, "repo-write-");
		ctx.created = new Set();
		expect(writeRepo(ctx, repo, "src/abai.mjs", "export const app = 1;\n", "the declaration")).toEqual({
			written: true,
			path: "src/abai.mjs",
		});
		expect(() => writeRepo(ctx, repo, "src/main.js", "x", "no")).toThrow(
			/exists already; repo.write makes new files only/,
		);
		// a file of this run's own may be written again; the repository had nothing there
		expect(writeRepo(ctx, repo, "src/abai.mjs", "export const app = 2;\n", "corrected")).toEqual({
			written: true,
			path: "src/abai.mjs",
		});
		expect(readFileSync(join(repo, "src/abai.mjs"), "utf8")).toBe("export const app = 2;\n");
		const before = readFileSync(join(repo, "src/main.js"), "utf8");
		const result = insertRepo(
			ctx,
			repo,
			"src/main.js",
			"const arg = process.argv[2];",
			"before",
			"// hook\nconst hook = 1;\n",
			"the entry hook",
		);
		const after = readFileSync(join(repo, "src/main.js"), "utf8");
		expect(result.line).toBeGreaterThan(1);
		expect(after.split("\n")).toHaveLength(before.split("\n").length + 2);
		// everything that was there is still there, in order
		const originalLines = before.split("\n");
		let cursor = 0;
		for (const line of after.split("\n")) if (line === originalLines[cursor]) cursor += 1;
		expect(cursor).toBe(originalLines.length);
		expect(() => insertRepo(ctx, repo, "src/main.js", "nowhere to be found", "after", "x", "no")).toThrow(
			/no line reads/,
		);
		expect(() => insertRepo(ctx, repo, "src/main.js", "", "after", "x", "no")).toThrow(/anchor must be a line/);
		expect(() => insertRepo(ctx, repo, "src/main.js", "const arg = process.argv[2];", "sideways", "x", "no")).toThrow(
			/before or after/,
		);
		expect(() => insertRepo(ctx, repo, "src/nope.js", "x", "after", "x", "no")).toThrow(/no such file/);
		writeFileSync(join(repo, "two.txt"), "same\nsame\n");
		expect(() => insertRepo(ctx, repo, "two.txt", "same", "after", "x", "no")).toThrow(
			/2 lines read "same" \(lines 1, 2\); the anchor must be unique/,
		);
		expect(ctx.changes.map((c) => [c.how, c.path])).toEqual([
			["write", "src/abai.mjs"],
			["write", "src/abai.mjs"],
			["insert", "src/main.js"],
		]);
		expect(ctx.changes[1]?.detail).toContain("this run's own file, written again");
	});

	test("add_dependency keeps the file's shape, defaults the specs it knows, and leaves an existing entry", () => {
		const { repo, ctx } = copy(plainCli, "repo-dep-");
		const file = join(repo, "package.json");
		writeFileSync(
			file,
			'{\n\t"name": "plain-cli",\n\t"type": "module",\n\t"scripts": { "start": "node src/main.js" }\n}\n',
		);
		const added = addDependency(ctx, repo, "@abaigram/stub", undefined, "the stub");
		expect(added.added).toBe(true);
		expect(added.spec).toMatch(/^file:.*\/abai$/);
		const text = readFileSync(file, "utf8");
		expect(text.startsWith('{\n\t"name"')).toBe(true);
		expect(text.endsWith("\n")).toBe(true);
		expect(JSON.parse(text)).toMatchObject({
			scripts: { start: "node src/main.js" },
			dependencies: { "@abaigram/stub": added.spec },
		});
		expect(addDependency(ctx, repo, "@abaigram/stub", "^9.9.9", "again")).toEqual({ spec: added.spec, added: false });
		expect(() => addDependency(ctx, repo, "left-pad", undefined, "why")).toThrow(/needs a spec/);
		expect(addDependency(ctx, repo, "left-pad", "^1.0.0", "why").added).toBe(true);
		// sorted place, and a CRLF file stays CRLF
		expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).dependencies)).toEqual(["@abaigram/stub", "left-pad"]);
		writeFileSync(file, '{\r\n  "name": "crlf",\r\n  "dependencies": { "zeta": "1" }\r\n}\r\n');
		addDependency(ctx, repo, "alpha", "2", "why");
		const crlf = readFileSync(file, "utf8");
		expect(crlf.split("\r\n").length).toBeGreaterThan(3);
		expect(crlf).not.toMatch(/[^\r]\n/);
		expect(Object.keys(JSON.parse(crlf).dependencies)).toEqual(["alpha", "zeta"]);
		expect(ctx.changes.filter((c) => c.how === "add_dependency").every((c) => c.kind === "rewritten")).toBe(true);
	});

	test("install runs npm install in the repository, offline here against a local package, and records the lock file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "repo-install-"));
		dirs.push(dir);
		const dep = join(dir, "tiny-dep");
		mkdirSync(dep);
		writeFileSync(
			join(dep, "package.json"),
			JSON.stringify({ name: "tiny-dep", version: "1.0.0", type: "module", main: "index.js" }),
		);
		writeFileSync(join(dep, "index.js"), "export const tiny = true;\n");
		const repo = join(dir, "repo");
		mkdirSync(repo);
		writeFileSync(
			join(repo, "package.json"),
			JSON.stringify({ name: "installs", version: "0.0.0", dependencies: { "tiny-dep": `file:${dep}` } }, null, 2),
		);
		const ctx: RepoContext = {
			cwd: dir,
			env: { ...subjectEnv(process.env), npm_config_offline: "true", ABAI_HOME: join(dir, "home") },
			changes: [],
		};
		const result = await installRepo(ctx, repo, "the dependencies just added");
		expect(result.ok).toBe(true);
		expect(existsSync(join(repo, "node_modules", "tiny-dep", "index.js"))).toBe(true);
		expect(ctx.changes.map((c) => [c.how, c.path, c.kind])).toEqual([
			["install", "node_modules", "rewritten"],
			["install", "package-lock.json", "rewritten"],
		]);
	}, 60_000);

	test("manifest runs the entry and writes abaigram.yaml; a dry run writes nothing and says what it would", async () => {
		const { repo, ctx } = copy(hello, "repo-manifest-");
		const program = join(repo, "hello.ts");
		writeFileSync(program, readFileSync(program, "utf8").replace('from "@abaigram/stub"', `from "${stubIndex}"`));
		const expected = readFileSync(join(repo, "abaigram.yaml"), "utf8");
		rmSync(join(repo, "abaigram.yaml"));
		const result = await regenerateManifest(ctx, repo, "node hello.ts abai", "the manifest");
		expect(result.written).toBe(true);
		expect(readFileSync(join(repo, "abaigram.yaml"), "utf8")).toBe(expected);
		await expect(regenerateManifest(ctx, repo, "node nope.ts abai", "x")).rejects.toThrow(
			/node nope.ts abai manifest exited 1/,
		);
		const dry: RepoContext = { ...ctx, dryRun: true, changes: [] };
		expect(writeRepo(dry, repo, "new.txt", "x", "why")).toEqual({ written: false, path: "new.txt" });
		expect(existsSync(join(repo, "new.txt"))).toBe(false);
		expect(dry.changes[0]?.detail).toMatch(/^dry run: would write/);
		const viaHandlers = repoHandlers(dry);
		expect(
			(await viaHandlers["repo.manifest"]({ repo, entry: "node hello.ts abai", why: "w" })) as { written: boolean },
		).toMatchObject({ written: false });
		expect(() => viaHandlers["repo.read"]({ repo })).toThrow(/path is required/);
		expect(
			viaHandlers["repo.write"]({ repo, path: "empty.txt", content: "", why: "an empty file is a file" }),
		).toMatchObject({ written: false });
	}, 30_000);
});
