// abaikit new: a fresh abaigram in a language, at a level, from the
// template. The declaration is data: it becomes the project's `src/abai.ts`
// and, through the stub's own `buildManifest`, its `abaigram.yaml`, so the
// two agree before the program has ever run; `abaikit check` then proves
// the level. Only TypeScript so far.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildManifest, renderManifestYaml } from "@abaigram/abai-stub";
import type { ParsedArgs } from "./bin.ts";
import { type AbaikitIo, UsageError } from "./io.ts";
import { packageSpecs } from "./learnabai.ts";
import { declarationsFor, type Level, templateFiles } from "./template-ts.ts";

export interface NewOptions {
	name: string;
	lang: string;
	level?: number;
	dir?: string;
	abaiImport?: string;
	cwd: string;
}

export interface NewResult {
	path: string;
	written: string[];
	/** Something the person must do before the project runs, when there is one. */
	note?: string;
}

/** The stub's rule for a program's name, so the manifest validates. */
const NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export function createProject(options: NewOptions): NewResult {
	if (options.lang !== "ts") throw new UsageError(`unknown language ${options.lang}; only ts is supported`);
	if (!NAME.test(options.name)) {
		throw new UsageError(
			`${options.name} is not a name the manifest accepts (lower-case letters, digits, _ and . between words)`,
		);
	}
	const level = options.level ?? 1;
	if (![1, 2, 3, 4].includes(level)) throw new UsageError("level must be 1 to 4");
	const path = resolve(options.cwd, options.dir ?? ".", options.name);
	if (existsSync(path)) throw new UsageError(`${path} exists already; new creates a directory of its own`);
	const specs = packageSpecs();
	const input = {
		name: options.name,
		level: level as Level,
		abaiImport: options.abaiImport ?? "@abaigram/abai-stub",
		packages: { ...specs.dependency, fromWorkspace: specs.fromWorkspace, built: specs.built },
	};
	const files = templateFiles(input);
	files["abaigram.yaml"] = renderManifestYaml(buildManifest(declarationsFor(input)));
	const written: string[] = [];
	try {
		for (const [relative, content] of Object.entries(files)) {
			const file = join(path, relative);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, content);
			written.push(relative);
		}
	} catch (error) {
		// nothing half made: the directory is new's own, so it goes with the failure
		rmSync(path, { recursive: true, force: true });
		throw error;
	}
	return { path, written, note: specs.fromWorkspace && !specs.built ? UNBUILT_NOTE : undefined };
}

const UNBUILT_NOTE =
	"the dependencies are workspace checkouts whose dist/ is not built yet: run `npm run build` in the workspace before `npm install` here";

/** The `new` capability: the same creation, for the agent on any front end. */
export function newHandler(io: Pick<AbaikitIo, "cwd">) {
	return (params: Record<string, unknown>): { path: string; written: number } => {
		if (typeof params.name !== "string" || params.name === "") throw new UsageError("new needs a name");
		if (params.level !== undefined && (typeof params.level !== "number" || !Number.isInteger(params.level))) {
			throw new UsageError("level must be 1 to 4");
		}
		const result = createProject({
			name: params.name,
			lang: typeof params.lang === "string" && params.lang !== "" ? params.lang : "ts",
			level: typeof params.level === "number" ? params.level : undefined,
			dir: typeof params.dir === "string" && params.dir !== "" ? params.dir : undefined,
			cwd: io.cwd,
		});
		return { path: result.path, written: result.written.length };
	};
}

export async function runNew(parsed: Extract<ParsedArgs, { verb: "new" }>, io: AbaikitIo): Promise<number> {
	const result = createProject({
		name: parsed.name,
		lang: parsed.lang,
		level: parsed.level,
		dir: parsed.dir,
		abaiImport: parsed.abaiImport,
		cwd: io.cwd,
	});
	io.out(`${result.path}\n`);
	for (const file of result.written) io.out(`  ${file}\n`);
	if (result.note) io.out(`note: ${result.note}\n`);
	io.out(`next: cd ${result.path} && npm install && node src/main.ts abai doctor --offline && npm run check\n`);
	return 0;
}
