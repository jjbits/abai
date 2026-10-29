// abaikit learnabai: the guide an agent reads before it creates or
// retrofits an abaigram. One text, `abai/learnabai.md`, delivered three
// ways: printed by the verb (whole, one section, or as JSON), returned by
// the `learnabai` capability to an agent on the MCP front end, and written
// as a Claude Code skill by `--skill`. The text names this machine's way
// to install the packages and the stub's own deviations, filled in here,
// so it is never out of step with what is installed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { ABAI_STUB_VERSION, ABAIGRAMMAR_VERSION, INSTANTIATION_DEVIATIONS, SIDECAR_DEVIATION } from "abai";
import { PACKAGE_ROOT } from "./abaigram.ts";
import type { ParsedArgs } from "./bin.ts";
import { type AbaikitIo, UsageError } from "./io.ts";
import { ABAIKIT_VERSION } from "./version.ts";

export const GUIDE_FILE = join(PACKAGE_ROOT, "abai", "learnabai.md");
export const SKILL_NAME = "learnabai";

export interface GuideSection {
	id: string;
	title: string;
	text: string;
}

export interface PackageSpecs {
	/** `npm install` arguments: `file:` paths, or `name@^version`. */
	abai: string;
	harness: string;
	/** The same packages as package.json values: `file:` paths, or `^version`; abaikit itself for a devDependency. */
	dependency: { abai: string; harness: string; abaikit: string };
	/** The specs are `file:` paths into a workspace checkout, not published versions. */
	fromWorkspace: boolean;
	/** Workspace checkouts only: both packages have their `dist/` built, so `npm install` of them works now. */
	built: boolean;
}

export interface Guide {
	abaigrammar: string;
	stub: string;
	abaikit: string;
	/** How this machine installs the stub and the harness. */
	packages: PackageSpecs;
	header: string;
	sections: GuideSection[];
	text: string;
}

const require = createRequire(import.meta.url);

function readPackage(dir: string): { name?: unknown; workspaces?: unknown } | undefined {
	const path = join(dir, "package.json");
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; workspaces?: unknown };
	} catch {
		return undefined;
	}
}

/**
 * The specs `npm install` takes for the two packages an abaigram needs, as
 * this abaikit can reach them. Inside the workspace checkout (the parent
 * is the workspace root whose `workspaces` name abaikit, not some
 * `node_modules` where hoisted siblings happen to sit) they are `file:`
 * paths to the sibling packages; anywhere else, the published versions.
 */
export function packageSpecs(packageRoot: string = PACKAGE_ROOT): PackageSpecs {
	const workspace = resolve(packageRoot, "..");
	const root = readPackage(workspace);
	const workspaces = Array.isArray(root?.workspaces) ? (root.workspaces as unknown[]) : [];
	const inWorkspace = basename(workspace) !== "node_modules" && workspaces.includes(basename(packageRoot));
	const abai = join(workspace, "abai");
	const harness = join(workspace, "abai-embedded-harness");
	if (inWorkspace && readPackage(abai)?.name === "abai" && readPackage(harness)?.name === "abai-embedded-harness") {
		const built = existsSync(join(abai, "dist", "index.js")) && existsSync(join(harness, "dist", "index.js"));
		return {
			abai: `file:${abai}`,
			harness: `file:${harness}`,
			dependency: { abai: `file:${abai}`, harness: `file:${harness}`, abaikit: `file:${resolve(packageRoot)}` },
			fromWorkspace: true,
			built,
		};
	}
	const harnessVersion = (require("abai-embedded-harness/package.json") as { version: string }).version;
	return {
		abai: `abai@^${ABAI_STUB_VERSION}`,
		harness: `abai-embedded-harness@^${harnessVersion}`,
		dependency: { abai: `^${ABAI_STUB_VERSION}`, harness: `^${harnessVersion}`, abaikit: `^${ABAIKIT_VERSION}` },
		fromWorkspace: false,
		built: true,
	};
}

/** The text with every fenced block blanked, so a heading inside one is not a section. */
function outsideFences(text: string): string {
	return text.replace(/^```[a-z]*\n[\s\S]*?^```$/gm, (block) => block.replace(/[^\n]/g, " "));
}

/** The guide, filled in and split into its sections. */
export function loadGuide(file: string = GUIDE_FILE, packageRoot: string = PACKAGE_ROOT): Guide {
	const packages = packageSpecs(packageRoot);
	const deviations = [...INSTANTIATION_DEVIATIONS, SIDECAR_DEVIATION].map((d) => `- ${d}`).join("\n");
	let workspaceNote = "";
	if (packages.fromWorkspace && !packages.built) {
		workspaceNote =
			"\nThese are workspace checkouts whose `dist/` is not built yet: run `npm run build` in the workspace first, or the packages install with nothing to import.\n";
	} else if (packages.fromWorkspace) {
		workspaceNote = "\n(These are the workspace's own checkouts, built; `npm install` links them.)\n";
	}
	const values: Record<string, string> = {
		abaigrammar: ABAIGRAMMAR_VERSION,
		stub: ABAI_STUB_VERSION,
		abaikit: ABAIKIT_VERSION,
		abai_spec: packages.abai,
		harness_spec: packages.harness,
		workspace_note: workspaceNote,
		deviations,
	};
	const text = readFileSync(file, "utf8").replace(/\{\{([a-z_]+)\}\}/g, (whole, key: string) => {
		const value = values[key];
		if (value === undefined) throw new Error(`${file} names an unknown value ${whole}`);
		return value;
	});
	// sections are the level-two headings outside fenced blocks, each ending in its id in parentheses
	const scan = outsideFences(text);
	const sections: GuideSection[] = [];
	let header = text;
	let previous: { id: string; title: string; start: number } | undefined;
	for (const match of scan.matchAll(/^## (.*)$/gm)) {
		const titled = /^(.+?) \(([a-z]+)\)$/.exec(match[1]);
		if (!titled) throw new Error(`${file}: the heading "## ${match[1]}" ends in no (id)`);
		const [, title, id] = titled;
		if (sections.some((s) => s.id === id) || previous?.id === id) {
			throw new Error(`${file}: two sections are named (${id})`);
		}
		const start = match.index;
		if (previous) {
			sections.push({ id: previous.id, title: previous.title, text: text.slice(previous.start, start).trimEnd() });
		} else header = text.slice(0, start).trimEnd();
		previous = { id, title, start };
	}
	if (previous) sections.push({ id: previous.id, title: previous.title, text: text.slice(previous.start).trimEnd() });
	return {
		abaigrammar: ABAIGRAMMAR_VERSION,
		stub: ABAI_STUB_VERSION,
		abaikit: ABAIKIT_VERSION,
		packages,
		header,
		sections,
		text,
	};
}

/** One section by id; an unknown id names the ids there are. */
export function findSection(guide: Guide, id: string): GuideSection {
	const found = guide.sections.find((s) => s.id === id);
	if (!found) throw new UsageError(`no section ${id}; the sections are ${guide.sections.map((s) => s.id).join(", ")}`);
	return found;
}

/** The whole guide, or one section, as printed. */
export function guideText(section?: string): string {
	const guide = loadGuide();
	if (section === undefined || section === "") return guide.text;
	return `${findSection(guide, section).text}\n`;
}

/** The `learnabai` capability: the guide for an agent, one section or all. */
export const learnabaiHandler = (params: Record<string, unknown>): { text: string } => {
	const section = typeof params.section === "string" ? params.section : undefined;
	return { text: guideText(section) };
};

/** The skill file Claude Code loads as `/learnabai`: the whole guide, with its source named. */
export function skillText(guide: Guide): string {
	return [
		"---",
		`name: ${SKILL_NAME}`,
		"description: How to create an abaigram or retrofit a repository into one with abai (the stub, the standard entry, the conformance levels, the step-by-step retrofit, and what never to do). Use when asked to abaify a repository, add abai to a program, or check an abaigram's conformance.",
		"---",
		"",
		`This is the output of \`abaikit learnabai\` for abaikit ${guide.abaikit}; run that command for the current text and \`abaikit learnabai --section <id>\` for one section.`,
		"",
		guide.text.trimEnd(),
		"",
	].join("\n");
}

/** Where `--skill` writes: `<dir>/learnabai/SKILL.md`, the dir defaulting to Claude Code's user skills. */
export function skillPath(io: AbaikitIo, dir?: string): string {
	if (dir !== undefined) return join(resolve(io.cwd, dir), SKILL_NAME, "SKILL.md");
	const home = io.env.HOME;
	if (!home) throw new UsageError("--skill needs HOME, or --skill-dir <dir>, to know where Claude Code's skills live");
	return join(home, ".claude", "skills", SKILL_NAME, "SKILL.md");
}

export async function runLearnabai(parsed: Extract<ParsedArgs, { verb: "learnabai" }>, io: AbaikitIo): Promise<number> {
	if (parsed.skill) {
		const path = skillPath(io, parsed.skillDir);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, skillText(loadGuide()));
		io.out(`${path}\n`);
		return 0;
	}
	if (parsed.json) {
		const guide = loadGuide();
		const sections: Record<string, string> = {};
		const picked = parsed.section === undefined ? guide.sections : [findSection(guide, parsed.section)];
		for (const s of picked) sections[s.id] = s.text;
		const json = {
			abaigrammar: guide.abaigrammar,
			stub: guide.stub,
			abaikit: guide.abaikit,
			packages: guide.packages,
			sections,
		};
		io.out(`${JSON.stringify(json, null, 2)}\n`);
		return 0;
	}
	io.out(guideText(parsed.section));
	return 0;
}
