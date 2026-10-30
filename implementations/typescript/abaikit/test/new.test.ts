// abaikit new: for each level, the project it makes is the level it says,
// proven by check; its manifest is what its own program prints; it refuses
// to overwrite; its README's commands are the tools' verbs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createAbaikit } from "../src/abaigram.ts";
import { type AbaikitIo, main, parseArgs } from "../src/bin.ts";
import type { CheckReport } from "../src/check.ts";
import { subjectEnv } from "../src/command.ts";
import { newHandler } from "../src/new.ts";
import { templateFiles } from "../src/template-ts.ts";

const root = resolve(import.meta.dirname, "..");
const stubIndex = resolve(root, "../abai/src/index.ts");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function world(prefix: string) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	const env: NodeJS.ProcessEnv = {
		...subjectEnv(process.env),
		HOME: join(dir, "home"),
		ABAI_HOME: join(dir, "home", ".abai"),
		ABAI_RUN_DIR: join(dir, "run"),
		ABAI_HARNESS_BIN: join(dir, "no-such-harness"),
	};
	const out: string[] = [];
	const err: string[] = [];
	const io: AbaikitIo = { out: (t) => out.push(t), err: (t) => err.push(`${t}\n`), env, cwd: dir };
	return { dir, env, io, out: () => out.join(""), err: () => err.join("") };
}

async function makeAndCheck(level: number) {
	const w = world(`new-l${level}-`);
	const made = await main(
		["new", "stepper", "--lang", "ts", "--level", String(level), "--abai-import", stubIndex],
		w.io,
	);
	expect(made).toBe(0);
	const project = join(w.dir, "stepper");
	expect(w.out()).toContain(project);
	const out: string[] = [];
	const code = await main(["check", project, "--runs", "1", "--json"], { ...w.io, out: (t) => out.push(t) });
	const report = JSON.parse(out.join("")) as CheckReport;
	return { w, project, code, report };
}

describe("abaikit new", () => {
	for (const level of [1, 2, 3, 4]) {
		test(`a level ${level} project checks at level ${level} with nothing unexercised and no violation`, async () => {
			const { project, code, report, w } = await makeAndCheck(level);
			expect(report.violations).toEqual([]);
			expect(report).toMatchObject({ name: "stepper", level, passed: true, declaredModes: ["turns", "sidecar"] });
			expect(code).toBe(0);
			if (level >= 2) expect(report.unexercised).toEqual([]);
			// the manifest new rendered is what the program itself prints
			const printed = spawnSync(process.execPath, ["src/main.ts", "abai", "manifest"], {
				cwd: project,
				env: subjectEnv(w.env),
				encoding: "utf8",
				timeout: 20_000,
			});
			expect(printed.status).toBe(0);
			expect(printed.stdout).toBe(readFileSync(join(project, "abaigram.yaml"), "utf8"));
			// and the program runs as itself
			const ran = spawnSync(process.execPath, ["src/main.ts", "3"], {
				cwd: project,
				env: subjectEnv(w.env),
				encoding: "utf8",
				timeout: 20_000,
			});
			expect(ran.status).toBe(0);
			expect(ran.stdout).toContain("step 3 of 3");
			expect(ran.stdout).toContain(level >= 2 ? "stepper: 3 steps done" : "stepper: done");
		}, 60_000);
	}

	test("the files, the dependencies, the commented examples at level 1, and the README's commands", async () => {
		const w = world("new-files-");
		expect(await main(["new", "stepper", "--lang", "ts", "--dir", "projects"], w.io)).toBe(0);
		const project = join(w.dir, "projects", "stepper");
		for (const file of [
			"package.json",
			"src/abai.ts",
			"src/main.ts",
			"abai/identity.md",
			"abai/use.md",
			"abaigram.yaml",
			"README.md",
			".gitignore",
		]) {
			expect(existsSync(join(project, file)), file).toBe(true);
		}
		const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
		expect(Object.keys(pkg.dependencies)).toEqual(["@abaigram/embedded-harness", "@abaigram/stub"]);
		// in this checkout the packages are the workspace's, as file: values; abaikit itself is there for npm run check
		expect(pkg.dependencies["@abaigram/stub"]).toMatch(/^file:/);
		expect(pkg.devDependencies["@abaigram/abaikit"]).toMatch(/^file:.*abaikit$/);
		const declaration = readFileSync(join(project, "src/abai.ts"), "utf8");
		expect(declaration).toContain('import { createAbaigram } from "@abaigram/stub";');
		for (const kind of ["// cells:", "// events:", "// capabilities:", "// decisions:", "// turns:", "// check:"]) {
			expect(declaration, kind).toContain(kind);
		}
		expect(declaration).toContain('fileURLToPath(new URL("..", import.meta.url))');
		const readme = readFileSync(join(project, "README.md"), "utf8");
		// every abaikit command the README names, on its own or behind an npm script's comment, parses
		const commands = [...readme.matchAll(/(?:^|# )(abaikit [a-z][^#:\n`]*)/gm)].map((m) => m[1].trim());
		expect(commands.length).toBeGreaterThanOrEqual(1);
		for (const line of commands) expect(() => parseArgs(line.split(/\s+/).slice(1)), line).not.toThrow();
	});

	test("published package specs are package.json values, not install arguments", () => {
		const files = templateFiles({
			name: "demo",
			level: 1,
			abaiImport: "@abaigram/stub",
			packages: { abai: "^0.1.0", harness: "^0.1.0", abaikit: "^0.1.0", fromWorkspace: false, built: true },
		});
		const pkg = JSON.parse(files["package.json"]);
		expect(pkg.dependencies).toEqual({ "@abaigram/embedded-harness": "^0.1.0", "@abaigram/stub": "^0.1.0" });
		expect(pkg.devDependencies).toEqual({ "@abaigram/abaikit": "^0.1.0" });
		expect(files["README.md"]).toContain("The packages come from npm");
	});

	test("the level 1 file's commented examples, uncommented, are the level 4 declaration: the program still prints its manifest", async () => {
		const w = world("new-uncomment-");
		expect(await main(["new", "stepper", "--lang", "ts", "--level", "1", "--abai-import", stubIndex], w.io)).toBe(0);
		const project = join(w.dir, "stepper");
		const file = join(project, "src/abai.ts");
		const source = readFileSync(file, "utf8");
		// one cells block, every example inside it; nothing to uncomment twice
		expect(source.match(/^\s*(\/\/ )?cells: \{/gm)).toHaveLength(1);
		const uncommented = source
			.split("\n")
			.map((line) => {
				// a commented code line is nested (a tab after the marker), or a key, a quoted name or a brace
				// ending in { or ,; a prose comment is words
				const m = /^(\t+)\/\/ (.*)$/.exec(line);
				if (!m) return line.startsWith("// export const skipped") ? line.slice(3) : line;
				const code = m[2].startsWith("\t") || (/^(?:"|[a-zA-Z_]+: |\},?$)/.test(m[2]) && /[{,]$/.test(m[2]));
				return code ? `${m[1]}${m[2]}` : line;
			})
			.join("\n");
		writeFileSync(file, uncommented);
		const printed = spawnSync(process.execPath, ["src/main.ts", "abai", "manifest", "--json"], {
			cwd: project,
			env: subjectEnv(w.env),
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(printed.stderr).toBe("");
		expect(printed.status).toBe(0);
		const manifest = JSON.parse(printed.stdout);
		expect(manifest.cells.map((c: { name: string }) => c.name)).toEqual(["work.done", "work.pace_ms"]);
		expect(manifest.capabilities.map((c: { name: string }) => c.name)).toEqual(["work.skip"]);
		expect(manifest.decisions.map((d: { name: string }) => d.name)).toEqual(["on_halfway"]);
		expect(manifest.turns.map((d: { name: string }) => d.name)).toEqual(["end_of_step"]);
		expect(manifest.check).toEqual({ run: "node src/main.ts 4" });
	}, 30_000);

	test("refuses an existing directory, a name the manifest would not accept, and a language it has not got", async () => {
		const w = world("new-refuse-");
		expect(await main(["new", "stepper", "--lang", "ts"], w.io)).toBe(0);
		expect(await main(["new", "stepper", "--lang", "ts"], w.io)).toBe(2);
		expect(w.err()).toMatch(/exists already; new creates a directory of its own/);
		const bad = world("new-bad-");
		expect(await main(["new", "Step-per", "--lang", "ts"], bad.io)).toBe(2);
		expect(bad.err()).toMatch(/is not a name the manifest accepts/);
		expect(() => parseArgs(["new", "x", "--lang", "py"])).toThrow(/only ts is supported/);
	});

	test("the new capability creates the same project for an agent", async () => {
		const w = world("new-capability-");
		const app = createAbaikit({ new: newHandler({ cwd: w.dir }) }, { env: w.env });
		const result = (await app.capabilityHandler("new")?.({ name: "stepper", level: 2 })) as {
			path: string;
			written: number;
		};
		expect(result.path).toBe(join(w.dir, "stepper"));
		expect(result.written).toBe(8);
		expect(existsSync(join(w.dir, "stepper", "abaigram.yaml"))).toBe(true);
		await expect(async () => app.capabilityHandler("new")?.({ name: "stepper", lang: "py" })).rejects.toThrow(
			/only ts is supported/,
		);
	});
});
