// The content slots (abaigrammar section 8): the abaigrammer's prompts, read
// from files under the program's root. The root is where abaigram.yaml lives:
// an explicit option, else the nearest ancestor of the cwd holding this
// program's manifest, else the cwd. Reads are lazy, so a program that never
// attaches never touches the files.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Manifest } from "./manifest/manifest.ts";
import { parseManifestYaml } from "./manifest/render.ts";

export const MANIFEST_FILE = "abaigram.yaml";

export interface ContentSlots {
	readonly root: string;
	/** The identity text; throws when the slot is missing or empty. */
	identity(): string;
	install(): string | undefined;
	use(): string | undefined;
	/** The content for a named turn or decision, from the `turns` directory. */
	turn(name: string): string | undefined;
}

/** Whether the manifest file at `path` names this program. */
export function isManifestOf(path: string, name: string): boolean {
	try {
		const parsed = parseManifestYaml(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && (parsed as { name?: unknown }).name === name;
	} catch {
		return false;
	}
}

/** The nearest ancestor of `dir` (itself included) holding this program's abaigram.yaml. */
export function findRoot(name: string, dir: string = process.cwd()): string | undefined {
	let current = resolve(dir);
	while (true) {
		if (isManifestOf(join(current, MANIFEST_FILE), name)) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function readOptional(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf8");
}

export function createContent(manifest: Manifest, resolveRoot: () => string): ContentSlots {
	let found: string | undefined;
	const root = (): string => {
		if (found === undefined) found = resolveRoot();
		return found;
	};
	const slot = (relative: string): string => resolve(root(), relative);
	return {
		get root() {
			return root();
		},
		identity() {
			const path = slot(manifest.content.identity);
			const text = readOptional(path);
			if (text === undefined) throw new Error(`the identity content is missing: ${path}`);
			if (text.trim() === "") throw new Error(`the identity content is empty: ${path}`);
			return text;
		},
		// the undeclared slots default to the abai/ directory (section 8); a missing file is simply no content
		install() {
			return readOptional(slot(manifest.content.install ?? "abai/install.md"));
		},
		use() {
			return readOptional(slot(manifest.content.use ?? "abai/use.md"));
		},
		turn(name) {
			const dir = manifest.content.turns ?? "abai/turns";
			return readOptional(slot(join(dir, `${name}.md`)));
		},
	};
}
