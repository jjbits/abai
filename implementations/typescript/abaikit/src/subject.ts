// A repository as check and run see it: its root, the nearest ancestor of
// the given path holding abaigram.yaml, and that checked-in manifest,
// parsed and validated. The tools reach the program only through the
// manifest's entry, a command line run by the shell in the root.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MANIFEST_FILE, type Manifest, parseManifestYaml, validateManifest } from "@abaigram/stub";
import { UsageError } from "./io.ts";

export interface Subject {
	root: string;
	manifestPath: string;
	manifest: Manifest;
}

/** The nearest ancestor of `start` (itself included) holding an abaigram.yaml. */
export function findSubjectRoot(start: string): string | undefined {
	let current = resolve(start);
	for (;;) {
		if (existsSync(join(current, MANIFEST_FILE))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** The subject at `path` (relative to `cwd`): a usage error when there is none or its manifest is not one. */
export function loadSubject(path: string, cwd: string): Subject {
	const given = resolve(cwd, path);
	if (!existsSync(given)) throw new UsageError(`${path}: no such file or directory`);
	const root = findSubjectRoot(given);
	if (root === undefined) {
		throw new UsageError(`${path}: no ${MANIFEST_FILE} here or above it (is the repository an abaigram yet?)`);
	}
	const manifestPath = join(root, MANIFEST_FILE);
	let parsed: unknown;
	try {
		parsed = parseManifestYaml(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new UsageError(`${manifestPath} does not parse: ${error instanceof Error ? error.message : String(error)}`);
	}
	const violations = validateManifest(parsed);
	if (violations.length > 0) throw new UsageError(`${manifestPath} does not validate: ${violations.join("; ")}`);
	return { root, manifestPath, manifest: parsed as Manifest };
}

/** One argument for `sh -c`, quoted so the shell passes it through whole. */
export function shellQuote(arg: string): string {
	if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg)) return arg;
	return `'${arg.replaceAll("'", "'\\''")}'`;
}

/** The entry's command line with words appended, for the shell in the root. */
export function entryCommand(manifest: Manifest, ...words: string[]): string {
	return [manifest.entry, ...words.map(shellQuote)].join(" ");
}
