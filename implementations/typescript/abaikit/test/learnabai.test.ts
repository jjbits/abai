// learnabai: the guide's sections, its filled-in values, the three ways it
// is delivered (the verb, the capability, the skill file), and that the
// commands it tells an agent to run are commands the tools accept.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ABAI_STUB_VERSION, SIDECAR_DEVIATION } from "@abaigram/abai-stub";
import { afterEach, describe, expect, test } from "vitest";
import { createAbaikit } from "../src/abaigram.ts";
import { type AbaikitIo, main, parseArgs } from "../src/bin.ts";
import { learnabaiHandler, loadGuide, packageSpecs, SKILL_NAME } from "../src/learnabai.ts";

const root = resolve(import.meta.dirname, "..");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function capture(env: NodeJS.ProcessEnv = {}, cwd = root) {
	const out: string[] = [];
	const err: string[] = [];
	const io: AbaikitIo = { out: (t) => out.push(t), err: (t) => err.push(`${t}\n`), env, cwd };
	return { io, out: () => out.join(""), err: () => err.join("") };
}

const SECTION_IDS = ["what", "declare", "entry", "levels", "retrofit", "use", "deviations", "never"];

describe("the guide", () => {
	test("has its eight sections in order, every value filled in, and this instantiation's deviations", () => {
		const guide = loadGuide();
		expect(guide.sections.map((s) => s.id)).toEqual(SECTION_IDS);
		expect(guide.text).not.toContain("{{");
		expect(guide.header).toContain(`abai stub ${ABAI_STUB_VERSION}`);
		expect(guide.header).toContain("abaigrammar 0.1");
		for (const section of guide.sections) expect(section.text.length).toBeGreaterThan(200);
		const deviations = guide.sections.find((s) => s.id === "deviations");
		expect(deviations?.text).toContain(SIDECAR_DEVIATION);
		// in this checkout the packages are the workspace's own, so the install line points at them
		expect(guide.packages.fromWorkspace).toBe(true);
		expect(guide.text).toContain(`npm install ${guide.packages.abai} ${guide.packages.harness}`);
		expect(guide.packages.abai.startsWith("file:")).toBe(true);
	});

	test("every abaikit command the retrofit names parses, and every entry verb is one the stub serves", () => {
		const guide = loadGuide();
		// every fenced block, whatever its info string, so a ts block's closing fence never opens the next
		const fenced = [...guide.text.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].flatMap((m) => m[1].split("\n"));
		const stubVerbs = ["", "install", "run", "config", "doctor", "manifest", "mcp"];
		let abaikitLines = 0;
		let entryLines = 0;
		for (const raw of fenced) {
			const line = raw.replace(/#.*$/, "").trim();
			if (line.startsWith("abaikit ")) {
				abaikitLines += 1;
				expect(() => parseArgs(line.split(/\s+/).slice(1))).not.toThrow();
			}
			if (line.startsWith("<entry>") || line.startsWith("<prog> abai")) {
				entryLines += 1;
				// the usage listing aligns a description after two or more spaces; the command is what comes before
				const command = line.split(/\s{2,}/)[0] ?? "";
				const verb =
					command
						.replace(/^<entry>|^<prog> abai/, "")
						.trim()
						.split(/\s+/)[0] ?? "";
				expect(stubVerbs, `${line}: ${verb}`).toContain(verb.startsWith("-") || verb === ">" ? "" : verb);
			}
		}
		expect(abaikitLines).toBeGreaterThanOrEqual(5);
		expect(entryLines).toBeGreaterThanOrEqual(8);
	});
});

describe("the verb", () => {
	test("prints the whole guide, one section, or the ids when the section is unknown", async () => {
		const whole = capture();
		expect(await main(["learnabai"], whole.io)).toBe(0);
		expect(whole.out().startsWith("# learnabai: abai for a coding agent")).toBe(true);
		const one = capture();
		expect(await main(["learnabai", "--section", "never"], one.io)).toBe(0);
		expect(one.out().startsWith("## 8. What never to do (never)")).toBe(true);
		expect(one.out()).not.toContain("## 7.");
		const unknown = capture();
		expect(await main(["learnabai", "--section", "nope"], unknown.io)).toBe(2);
		expect(unknown.err()).toMatch(
			/no section nope; the sections are what, declare, entry, levels, retrofit, use, deviations, never/,
		);
	});

	test("--json carries the versions, the package specs and the sections", async () => {
		const { io, out } = capture();
		expect(await main(["learnabai", "--json"], io)).toBe(0);
		const parsed = JSON.parse(out());
		expect(parsed).toMatchObject({ abaigrammar: "0.1", stub: ABAI_STUB_VERSION, packages: { fromWorkspace: true } });
		expect(Object.keys(parsed.sections)).toEqual(SECTION_IDS);
		const one = capture();
		expect(await main(["learnabai", "--json", "--section", "levels"], one.io)).toBe(0);
		expect(Object.keys(JSON.parse(one.out()).sections)).toEqual(["levels"]);
	});

	test("--skill writes Claude Code's skill file under HOME, or under --skill-dir", async () => {
		const home = mkdtempSync(join(tmpdir(), "learnabai-home-"));
		dirs.push(home);
		const { io, out } = capture({ HOME: home });
		expect(await main(["learnabai", "--skill"], io)).toBe(0);
		const path = join(home, ".claude", "skills", SKILL_NAME, "SKILL.md");
		expect(out().trim()).toBe(path);
		const skill = readFileSync(path, "utf8");
		expect(skill.startsWith(`---\nname: ${SKILL_NAME}\ndescription: `)).toBe(true);
		expect(skill).toContain("## 5. The retrofit, step by step (retrofit)");
		expect(skill).toContain("abaikit learnabai --section <id>");
		const elsewhere = capture({}, home);
		expect(await main(["learnabai", "--skill", "--skill-dir", "skills"], elsewhere.io)).toBe(0);
		expect(existsSync(join(home, "skills", SKILL_NAME, "SKILL.md"))).toBe(true);
		// no HOME and no dir: said, not guessed
		const nowhere = capture({});
		expect(await main(["learnabai", "--skill"], nowhere.io)).toBe(2);
		expect(nowhere.err()).toMatch(/--skill needs HOME, or --skill-dir/);
	});
});

describe("the capability", () => {
	test("is the same text, and abaikit's own manifest offers it to an agent", async () => {
		expect(learnabaiHandler({}).text).toBe(loadGuide().text);
		expect(learnabaiHandler({ section: "what" }).text.startsWith("## 1. What an abaigram is (what)")).toBe(true);
		expect(() => learnabaiHandler({ section: "nope" })).toThrow(/no section nope/);
		const home = mkdtempSync(join(tmpdir(), "learnabai-app-"));
		dirs.push(home);
		const app = createAbaikit(
			{ learnabai: learnabaiHandler },
			{ env: { HOME: home, ABAI_HOME: join(home, ".abai"), ABAI_HARNESS: "" } },
		);
		expect(app.manifest.capabilities.find((c) => c.name === "learnabai")).toMatchObject({
			effect: "read",
			dispatch: "immediate",
		});
		expect(await app.capabilityHandler("learnabai")?.({ section: "never" })).toMatchObject({
			text: expect.stringContaining("Never rewrite"),
		});
	});
});

describe("where the packages come from", () => {
	/** A fake package root in `dir` with the given siblings around it. */
	function layout(dir: string, parent: string, siblings: boolean, built: boolean, workspaces?: string[]) {
		const base = join(dir, parent);
		const kit = join(base, "abaikit");
		mkdirSync(kit, { recursive: true });
		writeFileSync(join(kit, "package.json"), JSON.stringify({ name: "@abaigram/abaikit" }));
		if (workspaces) writeFileSync(join(base, "package.json"), JSON.stringify({ name: "ws", workspaces }));
		if (siblings) {
			for (const [name, pkgName] of [
				["abai-stub", "@abaigram/abai-stub"],
				["abai-embedded-harness", "@abaigram/abai-embedded-harness"],
			]) {
				mkdirSync(join(base, name, "dist"), { recursive: true });
				writeFileSync(join(base, name, "package.json"), JSON.stringify({ name: pkgName }));
				if (built) writeFileSync(join(base, name, "dist", "index.js"), "");
			}
		}
		return kit;
	}

	test("an install under node_modules is not the workspace; a workspace root names abaikit", () => {
		const dir = mkdtempSync(join(tmpdir(), "learnabai-layout-"));
		dirs.push(dir);
		// the real layout: node_modules/@abaigram/abaikit, whose parent has no package.json
		const installed = packageSpecs(layout(dir, join("node_modules", "@abaigram"), true, true));
		expect(installed.fromWorkspace).toBe(false);
		expect(installed.abai).toMatch(/^@abaigram\/abai-stub@\^\d/);
		expect(installed.harness).toMatch(/^@abaigram\/abai-embedded-harness@\^\d/);
		// hoisted siblings directly under node_modules, the old layout, are not the workspace either
		const hoisted = packageSpecs(layout(dir, "node_modules", true, true));
		expect(hoisted.fromWorkspace).toBe(false);
		const unlisted = packageSpecs(layout(dir, "elsewhere", true, true, ["other"]));
		expect(unlisted.fromWorkspace).toBe(false);
		const unbuilt = packageSpecs(layout(dir, "ws", true, false, ["abai-stub", "abaikit"]));
		expect(unbuilt).toMatchObject({ fromWorkspace: true, built: false });
		expect(unbuilt.abai).toBe(`file:${join(dir, "ws", "abai-stub")}`);
		const builtOne = packageSpecs(layout(dir, "ws2", true, true, ["abaikit"]));
		expect(builtOne).toMatchObject({ fromWorkspace: true, built: true });
	});

	test("the guide says when the workspace checkouts are not built, and nothing when they are", () => {
		const dir = mkdtempSync(join(tmpdir(), "learnabai-note-"));
		dirs.push(dir);
		const guideFile = join(dir, "g.md");
		writeFileSync(
			guideFile,
			"# g\n\n## 1. One (one)\n\n```\nnpm install {{abai_spec}} {{harness_spec}}\n```\n{{workspace_note}}\nmore\n",
		);
		const unbuilt = loadGuide(guideFile, layout(dir, "ws", true, false, ["abaikit"]));
		expect(unbuilt.text).toContain("not built yet: run `npm run build`");
		const published = loadGuide(guideFile, layout(dir, "node_modules", true, true));
		expect(published.text).not.toContain("workspace");
		expect(published.text).toContain("npm install @abaigram/abai-stub@^");
	});
});

describe("the section parser", () => {
	const dir = () => {
		const d = mkdtempSync(join(tmpdir(), "learnabai-parse-"));
		dirs.push(d);
		return d;
	};
	const guideWith = (body: string) => {
		const file = join(dir(), "g.md");
		writeFileSync(file, body);
		return file;
	};

	test("refuses a heading without an id and two sections with one id; ignores a heading inside a fence", () => {
		expect(() => loadGuide(guideWith("# g\n\n## 1. Bare\n\ntext\n"))).toThrow(/ends in no \(id\)/);
		expect(() => loadGuide(guideWith("# g\n\n## 1. A (a)\n\nx\n\n## 2. B (a)\n\ny\n"))).toThrow(
			/two sections are named \(a\)/,
		);
		const fenced = loadGuide(guideWith("# g\n\n## 1. A (a)\n\n```md\n## not a heading\n```\n\n## 2. B (b)\n\ny\n"));
		expect(fenced.sections.map((s) => s.id)).toEqual(["a", "b"]);
		expect(fenced.sections[0]?.text).toContain("## not a heading");
	});

	test("--json gives a section the same text whether one or all are asked", async () => {
		const all = capture();
		expect(await main(["learnabai", "--json"], all.io)).toBe(0);
		const one = capture();
		expect(await main(["learnabai", "--json", "--section", "levels"], one.io)).toBe(0);
		expect(JSON.parse(one.out()).sections.levels).toBe(JSON.parse(all.out()).sections.levels);
	});
});
