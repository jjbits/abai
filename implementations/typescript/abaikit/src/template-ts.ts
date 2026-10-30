// The TypeScript template behind `abaikit new`: one declaration, as data,
// rendered twice. Into the new project's `src/abai.ts` as source, and
// through the stub's `buildManifest` into its `abaigram.yaml`, so file and
// code agree without running the program. The program is a small loop
// that works through a number of steps; at each level the declarations it
// needs are live and the loop uses them, so `abaikit check` reaches that
// level out of the box. Below its level every declaration kind is present
// once, commented, as section 13 asks, and uncommenting one is all it
// takes to make it live.
import type { AbaigramOptions, CapabilityOptions } from "@abaigram/abai-stub";

export type Level = 1 | 2 | 3 | 4;

export interface TemplateInput {
	name: string;
	level: Level;
	/** The specifier the generated code imports the stub by; `@abaigram/abai-stub` unless a test points at the source. */
	abaiImport: string;
	/** What `package.json` depends on, in package.json form, and whether the packages are built workspace checkouts. */
	packages: { abai: string; harness: string; abaikit: string; fromWorkspace: boolean; built: boolean };
}

// The declaration's constants, each written once and read by both renderings.
const ENTRY = "node src/main.ts abai";
const MODES = ["turns", "sidecar"] as const;
const CONTENT = { identity: "abai/identity.md", use: "abai/use.md" };
const AUDIT = { path: "./abai-audit.log" };
const CHECK = { run: "node src/main.ts 4" };
const CELL_DONE = { type: "int", access: "read", doc: "Steps finished so far." } as const;
const KNOB_PACE = {
	type: "int",
	access: "readwrite",
	default: 10,
	range: [1, 1000],
	doc: "Milliseconds a step takes; the agent may slow or hasten the work.",
} as const;
const EVENT_STEP = { payload: { n: "int" }, wakes: "never", doc: "A step finished." } as const;
const CAPABILITY_SKIP: Omit<CapabilityOptions, "handler"> = {
	params: { n: "int" },
	result: { ok: "bool" },
	effect: "mutate",
	policy: "confirm",
	dispatch: "immediate",
	// step 2: the exercise's call lands while step 1 already runs, so this one is seen skipped under check
	example: { n: 2 },
	doc: "Skip step n when the loop reaches it.",
};
/** The handler as source, indented from column zero; the renderer places it. */
const SKIP_HANDLER = "({ n }) => {\n\tskipped.add(Number(n));\n\treturn { ok: true };\n}";
const DECISION_HALFWAY = {
	context: { done: "int", total: "int" },
	options: ["continue", "stop"],
	default: "continue",
	// long enough for an agent to answer under `abai run`; past it the default applies
	timeout: "15s",
	doc: "Asked halfway through the work: go on, or stop here.",
} as const;
const TURN_STEP = { timeout: "5s", doc: "After each step. The agent may skip a step or change the pace." } as const;

/** The level each declaration becomes live at. */
const LIVE_FROM = {
	check: 2,
	"work.done": 2,
	"work.step": 2,
	end_of_step: 2,
	"work.pace_ms": 3,
	"work.skip": 3,
	on_halfway: 4,
} as const;

/** The declaration the program makes at this level, as the stub takes it. */
export function declarationsFor(input: TemplateInput): AbaigramOptions {
	const { name, level } = input;
	const options: AbaigramOptions = {
		name,
		entry: ENTRY,
		modes: [...MODES],
		content: { ...CONTENT },
		audit: { ...AUDIT },
	};
	if (level >= LIVE_FROM.check) options.check = { ...CHECK };
	const cells: NonNullable<AbaigramOptions["cells"]> = {};
	if (level >= LIVE_FROM["work.done"]) cells["work.done"] = { ...CELL_DONE };
	if (level >= LIVE_FROM["work.pace_ms"]) cells["work.pace_ms"] = { ...KNOB_PACE, range: [...KNOB_PACE.range] };
	if (Object.keys(cells).length > 0) options.cells = cells;
	if (level >= LIVE_FROM["work.step"])
		options.events = { "work.step": { ...EVENT_STEP, payload: { ...EVENT_STEP.payload } } };
	if (level >= LIVE_FROM["work.skip"]) {
		// the handler here is a stand-in: the manifest never sees it, and the generated module has the real one
		options.capabilities = { "work.skip": { ...CAPABILITY_SKIP, handler: () => ({ ok: true }) } };
	}
	if (level >= LIVE_FROM.on_halfway) {
		options.decisions = {
			on_halfway: {
				...DECISION_HALFWAY,
				options: [...DECISION_HALFWAY.options],
				context: { ...DECISION_HALFWAY.context },
			},
		};
	}
	if (level >= LIVE_FROM.end_of_step) options.turns = { end_of_step: { ...TURN_STEP } };
	return options;
}

// ---------------------------------------------------------------------------
// Rendering source
// ---------------------------------------------------------------------------

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const WIDTH = 110;

/** A value rendered verbatim, at the current indent: a handler's source. */
class Raw {
	readonly source: string;
	constructor(source: string) {
		this.source = source;
	}
}

function key(k: string): string {
	return IDENT.test(k) ? k : JSON.stringify(k);
}

/** A value as a TypeScript literal, on one line when it fits in `room` columns, else nested by `indent` tabs. */
function literal(value: unknown, indent: number, room: number): string {
	if (value instanceof Raw) {
		const pad = "\t".repeat(indent);
		return value.source
			.split("\n")
			.map((line, i) => (i === 0 ? line : `${pad}${line}`))
			.join("\n");
	}
	if (Array.isArray(value)) return `[${value.map((v) => literal(v, indent, room)).join(", ")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value);
		if (entries.length === 0) return "{}";
		const inline = entries.map(([k, v]) => `${key(k)}: ${literal(v, indent, room)}`).join(", ");
		if (!inline.includes("\n") && inline.length + 4 <= room) return `{ ${inline} }`;
		const pad = "\t".repeat(indent + 1);
		const lines = entries.map(([k, v]) => {
			const head = `${pad}${key(k)}: `;
			return `${head}${literal(v, indent + 1, WIDTH - head.length * 2)},`;
		});
		return `{\n${lines.join("\n")}\n${"\t".repeat(indent)}}`;
	}
	return JSON.stringify(value);
}

/** Comment out a rendered piece, every line. */
function commented(text: string, indent: number): string {
	const pad = "\t".repeat(indent);
	return text
		.split("\n")
		.map((line) => (line.startsWith(pad) ? `${pad}// ${line.slice(pad.length)}` : `${pad}// ${line.trimStart()}`))
		.join("\n");
}

/**
 * One declaration block, `cells: { ... },` with each entry live or
 * commented on its own, so uncommenting an entry is all it takes; a block
 * with no live entry is commented whole, as the example of its kind.
 */
function block(name: string, entries: Array<{ key: string; value: unknown; live: boolean }>, indent: number): string {
	const pad = "\t".repeat(indent);
	const inner = "\t".repeat(indent + 1);
	const raw = entries.map((e) => {
		const head = `${inner}${key(e.key)}: `;
		return { text: `${head}${literal(e.value, indent + 1, WIDTH - head.length * 2)},`, live: e.live };
	});
	if (!raw.some((e) => e.live)) {
		// no live entry: the whole block is the example, commented once
		return commented(`${pad}${name}: {\n${raw.map((e) => e.text).join("\n")}\n${pad}},`, indent);
	}
	const rendered = raw.map((e) => (e.live ? e.text : commented(e.text, indent + 1)));
	return `${pad}${name}: {\n${rendered.join("\n")}\n${pad}},`;
}

function declarationModule(input: TemplateInput): string {
	const { name, level, abaiImport } = input;
	const live = (from: number) => level >= from;
	const lines: string[] = [];
	lines.push(`// ${name} as an abaigram: what the agent may observe and steer, declared once.`);
	lines.push("// The manifest (abaigram.yaml) is generated from this: after a change, run");
	lines.push("//   node src/main.ts abai manifest > abaigram.yaml");
	lines.push("// and check it with: abaikit check .");
	if (level < 4) {
		lines.push("// A commented declaration is the example of its kind: uncomment it (and the lines");
		lines.push("// in src/main.ts that use it) when the program has the fact or the fork.");
	}
	lines.push('import { fileURLToPath } from "node:url";');
	lines.push(`import { createAbaigram } from ${JSON.stringify(abaiImport)};`);
	lines.push("");
	lines.push("/** Steps the agent asked to skip (work.skip); the loop in main.ts honours it. */");
	lines.push(
		live(LIVE_FROM["work.skip"])
			? "export const skipped = new Set<number>();"
			: "// export const skipped = new Set<number>();",
	);
	lines.push("");
	lines.push("export const app = createAbaigram(");
	lines.push("\t{");
	lines.push(`\t\tname: ${JSON.stringify(name)},`);
	lines.push("\t\t// a runnable entry: the tools reach the program through it, in this directory");
	lines.push(`\t\tentry: ${JSON.stringify(ENTRY)},`);
	lines.push(`\t\tmodes: ${literal([...MODES], 2, WIDTH)},`);
	lines.push(`\t\tcontent: ${literal(CONTENT, 2, WIDTH)},`);
	lines.push(`\t\taudit: ${literal(AUDIT, 2, WIDTH)},`);
	lines.push("\t\t// a short run that exercises every channel: what abaikit check runs for the levels above 1");
	const checkLine = `\t\tcheck: ${literal(CHECK, 2, WIDTH)},`;
	lines.push(live(LIVE_FROM.check) ? checkLine : commented(checkLine, 2));
	lines.push("\t\t// cells the program writes; a readwrite cell is a knob the agent may set within its range");
	lines.push(
		block(
			"cells",
			[
				{ key: "work.done", value: CELL_DONE, live: live(LIVE_FROM["work.done"]) },
				{ key: "work.pace_ms", value: KNOB_PACE, live: live(LIVE_FROM["work.pace_ms"]) },
			],
			2,
		),
	);
	lines.push("\t\t// events the program emits; wakes says when one wakes the agent");
	lines.push(block("events", [{ key: "work.step", value: EVENT_STEP, live: live(LIVE_FROM["work.step"]) }], 2));
	lines.push("\t\t// capabilities the agent may call. dispatch immediate runs the handler at once; the default");
	lines.push("\t\t// (safepoint) waits for app.safepoint(). check calls the example, so keep it harmless");
	lines.push(
		block(
			"capabilities",
			[
				{
					key: "work.skip",
					value: { ...CAPABILITY_SKIP, handler: new Raw(SKIP_HANDLER) },
					live: live(LIVE_FROM["work.skip"]),
				},
			],
			2,
		),
	);
	lines.push("\t\t// decisions the program asks at a real fork; the default is what it does when nobody answers");
	lines.push(
		block("decisions", [{ key: "on_halfway", value: DECISION_HALFWAY, live: live(LIVE_FROM.on_halfway) }], 2),
	);
	lines.push("\t\t// turns: bounded moments the program hands the agent");
	lines.push(block("turns", [{ key: "end_of_step", value: TURN_STEP, live: live(LIVE_FROM.end_of_step) }], 2));
	lines.push("\t},");
	lines.push("\t// the directory holding abaigram.yaml and abai/: one level up from this file");
	lines.push('\t{ root: fileURLToPath(new URL("..", import.meta.url)) },');
	lines.push(");");
	return `${lines.join("\n")}\n`;
}

function mainModule(input: TemplateInput): string {
	const { name, level, abaiImport } = input;
	const live = (from: number) => level >= from;
	const lines: string[] = [];
	lines.push(`// ${name}: works through a number of steps and prints each. Node 22.19 and`);
	lines.push("// later run this file as it is (node src/main.ts 5); the first lines hand the");
	lines.push("// standard agent entry to the stub, and the program's own run follows.");
	lines.push(`import { runEntry } from ${JSON.stringify(abaiImport)};`);
	lines.push(
		live(LIVE_FROM["work.skip"]) ? 'import { app, skipped } from "./abai.ts";' : 'import { app } from "./abai.ts";',
	);
	lines.push("");
	lines.push("const code = await runEntry(app, process.argv.slice(2));");
	lines.push("if (code >= 0) process.exit(code); // an abai verb ran; otherwise the program's own run begins");
	lines.push("");
	lines.push("const total = Number(process.argv[2] ?? 5);");
	lines.push("const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));");
	if (live(LIVE_FROM["work.done"])) {
		lines.push("// handles once, at startup; set and emit are the cheap calls");
		lines.push('const done = app.cell<number>("work.done");');
		lines.push('const step = app.event("work.step");');
	}
	if (live(LIVE_FROM["work.pace_ms"])) lines.push('const pace = app.knob<number>("work.pace_ms");');
	lines.push("");
	lines.push("for (let n = 1; n <= total; n++) {");
	if (live(LIVE_FROM.on_halfway)) {
		lines.push("\tif (n === Math.ceil(total / 2)) {");
		lines.push("\t\t// a real fork: the default is what the program did before it was an abaigram");
		lines.push('\t\tconst choice = await app.decide<string>("on_halfway", { done: n - 1, total });');
		lines.push('\t\tif (choice === "stop") {');
		lines.push(`\t\t\tconsole.log("${name}: stopped halfway, as asked");`);
		lines.push("\t\t\tbreak;");
		lines.push("\t\t}");
		lines.push("\t}");
	}
	if (live(LIVE_FROM["work.skip"])) {
		lines.push("\tif (skipped.has(n)) {");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: this is the generated program's source, a template literal in it
		lines.push("\t\tconsole.log(`step ${n} skipped`);");
		lines.push("\t\tcontinue;");
		lines.push("\t}");
		lines.push("\tawait sleep(pace.get());");
	} else {
		lines.push("\tawait sleep(10);");
	}
	if (live(LIVE_FROM["work.done"])) {
		lines.push("\tdone.set(n);");
		lines.push("\tstep.emit({ n });");
	}
	// biome-ignore lint/suspicious/noTemplateCurlyInString: this is the generated program's source, a template literal in it
	lines.push("\tconsole.log(`step ${n} of ${total}`);");
	lines.push("\tapp.safepoint();");
	if (live(LIVE_FROM.end_of_step)) lines.push('\tawait app.turn("end_of_step");');
	lines.push("}");
	lines.push(
		live(LIVE_FROM["work.done"])
			? `console.log(\`${name}: \${done.get()} steps done\`);`
			: `console.log("${name}: done");`,
	);
	return `${lines.join("\n")}\n`;
}

function readme(input: TemplateInput): string {
	const { name, level, packages } = input;
	const where = packages.fromWorkspace
		? `The two packages come from the abai workspace checkout (\`file:\` dependencies)${packages.built ? "" : ", which is not built yet: run `npm run build` there first"}; abaikit itself is a devDependency, so \`npm run check\` finds it.`
		: "The packages come from npm; abaikit itself is a devDependency, so `npm run check` finds it.";
	return [
		`# ${name}`,
		"",
		`An abaigram at level ${level}, made by \`abaikit new\`: a small program that works through a number of steps,`,
		"with an agent fused in through the abai stub. Node 22.19 or later runs the TypeScript as it is.",
		"",
		"```",
		"npm install                              # the stub, the harness, and abaikit for check",
		"node src/main.ts 5                       # the program, as itself",
		"node src/main.ts abai doctor --offline   # the manifest, the content, the modes",
		"npm run check                            # abaikit check .: the conformance level, with no model",
		"node src/main.ts abai                    # a session with the agent about the program (needs a model: node src/main.ts abai config)",
		"node src/main.ts abai run -- 5           # the harness starts the program as its child; the loop meets the agent here",
		"```",
		"",
		where,
		"",
		"`src/abai.ts` declares what the agent may observe and steer; `src/main.ts` is the program. After a change to",
		"the declaration, regenerate the manifest: `node src/main.ts abai manifest > abaigram.yaml`. The agent's prompt is",
		"`abai/identity.md`. For the next level, `abaikit learnabai --section retrofit` says what to add.",
		"",
	].join("\n");
}

/** Every file of the new project, by path relative to its root. The manifest is rendered by the caller. */
export function templateFiles(input: TemplateInput): Record<string, string> {
	const { name, packages } = input;
	const pkg = {
		name,
		version: "0.1.0",
		private: true,
		type: "module",
		scripts: { start: "node src/main.ts", abai: "node src/main.ts abai", check: "abaikit check ." },
		dependencies: { "@abaigram/abai-embedded-harness": packages.harness, "@abaigram/abai-stub": packages.abai },
		devDependencies: { "@abaigram/abaikit": packages.abaikit },
		engines: { node: ">=22.19.0" },
	};
	return {
		"package.json": `${JSON.stringify(pkg, null, 2)}\n`,
		"src/abai.ts": declarationModule(input),
		"src/main.ts": mainModule(input),
		"abai/identity.md": `You are the agent fused into ${name}, a small program that works through a number of steps and prints each. Watch its progress, skip or pace steps only when that serves the person, and say why in every act.\n`,
		"abai/use.md": `<!-- The use slot (abaigrammar section 8): what the agent should know during sessions and live operation, beyond its identity. -->\nUnder \`node src/main.ts abai\` the program opens a session before its loop: answer about the manifest and the plan. Under \`node src/main.ts abai run -- N\` the loop runs while you watch: read the cells before you act, and prefer watching to steering.\n`,
		"README.md": readme(input),
		".gitignore": "node_modules/\nabai-audit.log\n",
	};
}
