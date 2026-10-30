// abaikit's own manifest: the tool is itself an abaigram. Its agent reads
// the guide, runs check, creates new abaigrams and changes a repository only
// through the additive repo.* capabilities. The verbs fill in the handlers;
// a capability with none supplied says it is not yet implemented. Every
// capability is dispatched at once: a command-line tool has no hot loop
// reaching safepoints, and its handlers are I/O-bound.
import { resolve } from "node:path";
import { type Abaigram, type AbaigramExtras, type CapabilityHandler, createAbaigram } from "@abaigram/abai-stub";

export type Handler = CapabilityHandler;

export interface AbaikitHandlers {
	learnabai?: Handler;
	check?: Handler;
	new?: Handler;
	repoList?: Handler;
	repoRead?: Handler;
	repoWrite?: Handler;
	repoInsert?: Handler;
	repoAddDependency?: Handler;
	repoManifest?: Handler;
	repoInstall?: Handler;
}

/** The abaikit package root, where abaigram.yaml and the content live; the same from src/ and dist/. */
export const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

function notYet(name: string): Handler {
	return () => {
		throw new Error(`${name}: not yet implemented`);
	};
}

export function createAbaikit(handlers: AbaikitHandlers = {}, extras: AbaigramExtras = {}): Abaigram {
	return createAbaigram(
		{
			name: "abaikit",
			modes: ["turns", "sidecar"],
			// no audit path of its own: a tool's audit belongs in the user's abai home, not in its install directory
			content: { use: "abai/use.md" },
			// run in the package root, where the check example below resolves
			check: { run: "node dist/bin.js check examples/hello" },
			cells: {
				"check.runs": { type: "int", access: "read", doc: "Conformance checks run by this process." },
				"check.last_level": { type: "int", access: "read", doc: "The level the last check reported, 0 to 4." },
				"abaify.max_rounds": {
					type: "int",
					access: "readwrite",
					default: 5,
					range: [1, 20],
					doc: "Agent rounds abaify gives a retrofit before it stops.",
				},
			},
			events: {
				"check.completed": {
					payload: { repo: { type: "string", max: 512 }, level: { type: "int" } },
					wakes: "never",
					doc: "A conformance check finished.",
				},
				"repo.changed": {
					payload: { path: { type: "string", max: 512 }, how: { type: "string", max: 32 } },
					wakes: "never",
					doc: "abaify changed the repository: wrote a file, inserted lines, added a dependency, regenerated the manifest, or installed.",
				},
			},
			capabilities: {
				learnabai: {
					params: { section: "string" },
					result: { text: "string" },
					dispatch: "immediate",
					effect: "read",
					example: {},
					doc: "The guide for an agent: what an abaigram is, how to declare one in TypeScript, how to retrofit a repository, how check judges it; one section or all.",
					handler: handlers.learnabai ?? notYet("learnabai"),
				},
				check: {
					params: { repo: "string", level: "int", mode: "string", entry: "string", runs: "int" },
					result: { level: "int", passed: "bool", report: "string" },
					dispatch: "immediate",
					effect: "mutate",
					policy: "auto",
					timeout: "1800s",
					// relative to the working directory: the package root, where abaikit's own check.run runs
					example: { repo: "examples/hello" },
					doc: "Verify a repository's conformance (section 12): L1 through its entry, L2 to L4 by running the repository's check.run command under the null harness, an exercise run and the measurement runs per mode. Needs no model; may take minutes.",
					handler: handlers.check ?? notYet("check"),
				},
				new: {
					params: { name: "string", lang: "string", level: "int", dir: "string" },
					result: { path: "string", written: "int" },
					dispatch: "immediate",
					effect: "mutate",
					policy: "confirm",
					doc: "Create a fresh abaigram in a language, at a level, with one example of each declaration and the content slots in place.",
					handler: handlers.new ?? notYet("new"),
				},
				"repo.list": {
					params: { repo: "string", glob: "string" },
					result: { count: "int", listing: "string" },
					dispatch: "immediate",
					effect: "read",
					example: { repo: "examples/hello" },
					doc: "List a repository's files, skipping dependencies, build output and ignored trees; bounded, and the bound is said first. glob narrows: *.json by name anywhere, src/** or scripts/*.mjs by path.",
					handler: handlers.repoList ?? notYet("repo.list"),
				},
				"repo.read": {
					params: { repo: "string", path: "string", start: "int", lines: "int" },
					result: { text: "string", total_lines: "int", from: "int", to: "int" },
					dispatch: "immediate",
					effect: "read",
					example: { repo: "examples/hello", path: "abaigram.yaml" },
					doc: "Read part of a file in a repository: a window from line start, 400 lines or 12 KB at most a call; the result says from and to.",
					handler: handlers.repoRead ?? notYet("repo.read"),
				},
				"repo.write": {
					params: { repo: "string", path: "string", content: "string", why: "string" },
					result: { written: "bool" },
					dispatch: "immediate",
					effect: "mutate",
					policy: "confirm",
					doc: "Write a new file in a repository (any directory this process can reach; under an MCP client each call is the client's permission prompt); an existing file is refused, since abaify adds and never replaces.",
					handler: handlers.repoWrite ?? notYet("repo.write"),
				},
				"repo.insert": {
					params: {
						repo: "string",
						path: "string",
						anchor: "string",
						where: "string",
						text: "string",
						why: "string",
					},
					result: { line: "int" },
					dispatch: "immediate",
					effect: "mutate",
					policy: "confirm",
					doc: "Insert text before or after a unique anchor line in an existing file of a repository; no line the file had is removed or reordered.",
					handler: handlers.repoInsert ?? notYet("repo.insert"),
				},
				"repo.add_dependency": {
					params: { repo: "string", name: "string", spec: "string", why: "string" },
					result: { spec: "string" },
					dispatch: "immediate",
					effect: "mutate",
					policy: "confirm",
					doc: "Add a dependency to the repository's package.json in sorted place (the file is re-serialized, keys and indentation kept); the spec defaults to how abaikit reaches @abaigram/abai-stub, @abaigram/abai-embedded-harness and @abaigram/abaikit.",
					handler: handlers.repoAddDependency ?? notYet("repo.add_dependency"),
				},
				"repo.manifest": {
					params: { repo: "string", entry: "string", why: "string" },
					result: { written: "bool", lines: "int", text: "string" },
					dispatch: "immediate",
					effect: "mutate",
					policy: "confirm",
					timeout: "90s",
					doc: "Run the repository's entry (`<entry> manifest`) and write what it prints to abaigram.yaml, the one file never written by hand.",
					handler: handlers.repoManifest ?? notYet("repo.manifest"),
				},
				"repo.install": {
					params: { repo: "string", why: "string" },
					result: { ok: "bool", output: "string" },
					dispatch: "immediate",
					effect: "mutate",
					policy: "confirm",
					timeout: "660s",
					doc: "Run npm install in the repository (network; the repository's own install scripts run; the lock file and node_modules are rewritten), so the dependencies just added resolve.",
					handler: handlers.repoInstall ?? notYet("repo.install"),
				},
			},
		},
		{ root: PACKAGE_ROOT, ...extras },
	);
}
