#!/usr/bin/env node
// The abaikit binary: learnabai prints the guide, check verifies a
// repository's conformance, new creates a fresh abaigram, abaify retrofits
// an existing repository, and run starts a repository's program with an
// agent attached. `abaikit abai ...` is abaikit's own standard agent entry,
// served by the stub, since abaikit is itself an abaigram.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runEntry } from "abai";
import { runAbaify } from "./abaify.ts";
import { type AbaikitApp, createApp } from "./app.ts";
import { runCheck } from "./check.ts";
import { type AbaikitIo, errorMessage, processIo, UsageError } from "./io.ts";
import { runLearnabai } from "./learnabai.ts";
import { runNew } from "./new.ts";
import { runRun } from "./run.ts";

export { type AbaikitIo, processIo, UsageError } from "./io.ts";

export type Mode = "turns" | "sidecar";

export type ParsedArgs =
	| { verb: "help" }
	| { verb: "learnabai"; section?: string; json: boolean; skill: boolean; skillDir?: string }
	| {
			verb: "check";
			repo: string;
			level?: number;
			mode?: Mode;
			entry?: string;
			runs?: number;
			timeoutS?: number;
			json: boolean;
	  }
	| { verb: "new"; name: string; lang: "ts"; level?: number; dir?: string; abaiImport?: string }
	| { verb: "abaify"; repo: string; level?: number; mode?: Mode; rounds?: number; dryRun: boolean }
	| { verb: "run"; repo: string; args: string[] };

export type Verb = ParsedArgs["verb"];

const USAGE = [
	"usage: abaikit learnabai|check|new|abaify|run ...",
	"       abaikit learnabai [--section <name>] [--json] [--skill] [--skill-dir <dir>]",
	"       abaikit check <repo> [--level <1-4>] [--mode <turns|sidecar>] [--entry <cmd>] [--runs <n>] [--timeout <seconds>] [--json]",
	"       abaikit new <name> --lang <ts> [--level <1-4>] [--dir <dir>]",
	"       abaikit abaify <repo> [--level <1-4>] [--mode <turns|sidecar>] [--rounds <n>] [--dry-run]",
	"       abaikit run <repo> [--] ARGS",
	"       abaikit abai ...            the standard agent entry (session, install, manifest, doctor, config, mcp, run)",
	"",
	"learnabai prints the guide for an agent; check verifies a repository's conformance and needs no model;",
	"new creates a fresh abaigram; abaify retrofits an existing repository, adding and never removing;",
	"run starts the repository's program with everything after -- as its arguments.",
];

type FlagKind = "bool" | "string" | "int" | "level" | "mode";

function positiveInt(value: string, flag: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} needs a positive integer`);
	return n;
}

/** The verb's flags and positionals; a flag missing its value, an unknown flag or a stray argument is a usage error. */
function scan(
	verb: string,
	argv: string[],
	kinds: Record<string, FlagKind>,
): { positionals: string[]; values: Record<string, string | number | boolean> } {
	const positionals: string[] = [];
	const values: Record<string, string | number | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const raw = argv[i];
		if (raw === "--") throw new UsageError(`${verb} takes no program command`);
		if (!raw.startsWith("-")) {
			positionals.push(raw);
			continue;
		}
		// `--flag value` and `--flag=value`, as the stub's entry accepts them
		const eq = raw.indexOf("=");
		const arg = eq === -1 ? raw : raw.slice(0, eq);
		const kind = kinds[arg];
		if (kind === undefined) throw new UsageError(`unknown argument ${arg}`);
		if (kind === "bool") {
			if (eq !== -1) throw new UsageError(`${arg} takes no value`);
			values[arg] = true;
			continue;
		}
		let value: string | undefined;
		if (eq !== -1) value = raw.slice(eq + 1);
		else {
			value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
			i += 1;
		}
		if (value === "") throw new UsageError(`${arg} needs a value`);
		switch (kind) {
			case "string":
				values[arg] = value;
				break;
			case "int":
				values[arg] = positiveInt(value, arg);
				break;
			case "level": {
				const n = Number(value);
				if (!Number.isInteger(n) || n < 1 || n > 4) throw new UsageError(`${arg} needs a level from 1 to 4`);
				values[arg] = n;
				break;
			}
			case "mode":
				if (value !== "turns" && value !== "sidecar") throw new UsageError(`${arg} needs turns or sidecar`);
				values[arg] = value;
				break;
		}
	}
	return { positionals, values };
}

/** Exactly one positional, named `what` in the error. */
function one(verb: string, positionals: string[], what: string): string {
	if (positionals.length === 0) throw new UsageError(`${verb} needs ${what}`);
	if (positionals.length > 1) throw new UsageError(`unexpected argument ${positionals[1]}`);
	return positionals[0];
}

export function parseArgs(argv: string[]): ParsedArgs {
	const verb = argv[0];
	if (verb === undefined || verb === "help" || verb === "--help" || verb === "-h") return { verb: "help" };
	const rest = argv.slice(1);
	switch (verb) {
		case "learnabai": {
			const { positionals, values } = scan(verb, rest, {
				"--section": "string",
				"--json": "bool",
				"--skill": "bool",
				"--skill-dir": "string",
			});
			if (positionals.length > 0) throw new UsageError(`unexpected argument ${positionals[0]}`);
			if (values["--skill-dir"] !== undefined && values["--skill"] !== true)
				throw new UsageError("--skill-dir goes with --skill");
			return {
				verb,
				section: values["--section"] as string | undefined,
				json: values["--json"] === true,
				skill: values["--skill"] === true,
				skillDir: values["--skill-dir"] as string | undefined,
			};
		}
		case "check": {
			const { positionals, values } = scan(verb, rest, {
				"--level": "level",
				"--mode": "mode",
				"--entry": "string",
				"--runs": "int",
				"--timeout": "int",
				"--json": "bool",
			});
			return {
				verb,
				repo: one(verb, positionals, "a repository"),
				level: values["--level"] as number | undefined,
				mode: values["--mode"] as Mode | undefined,
				entry: values["--entry"] as string | undefined,
				runs: values["--runs"] as number | undefined,
				timeoutS: values["--timeout"] as number | undefined,
				json: values["--json"] === true,
			};
		}
		case "new": {
			const { positionals, values } = scan(verb, rest, {
				"--lang": "string",
				"--level": "level",
				"--dir": "string",
				"--abai-import": "string",
			});
			const name = one(verb, positionals, "a name");
			const lang = values["--lang"];
			if (lang === undefined) throw new UsageError("new needs --lang <ts>");
			if (lang !== "ts") throw new UsageError(`unknown language ${lang}; only ts is supported`);
			return {
				verb,
				name,
				lang,
				level: values["--level"] as number | undefined,
				dir: values["--dir"] as string | undefined,
				abaiImport: values["--abai-import"] as string | undefined,
			};
		}
		case "abaify": {
			const { positionals, values } = scan(verb, rest, {
				"--level": "level",
				"--mode": "mode",
				"--rounds": "int",
				"--dry-run": "bool",
			});
			return {
				verb,
				repo: one(verb, positionals, "a repository"),
				level: values["--level"] as number | undefined,
				mode: values["--mode"] as Mode | undefined,
				rounds: values["--rounds"] as number | undefined,
				dryRun: values["--dry-run"] === true,
			};
		}
		case "run": {
			// the repository, then the program's arguments; `--` before them is allowed, as in the stub's own run
			const repo = rest[0];
			if (repo === undefined || repo.startsWith("-")) throw new UsageError("run needs a repository");
			const after = rest.slice(1);
			return { verb, repo, args: after[0] === "--" ? after.slice(1) : after };
		}
		default:
			throw new UsageError(`unknown verb ${verb}`);
	}
}

/** The binary's entry; resolves to the exit code and never throws. */
export async function main(argv: string[], io: AbaikitIo = processIo): Promise<number> {
	// abaikit is an abaigram, built before anything else so its own entry, its null harness under check runs and
	// its capabilities are there whichever verb runs (section 13: main hands control to the harness at once)
	let bundle: AbaikitApp;
	try {
		bundle = createApp(io);
	} catch (error) {
		io.err(`abaikit: ${errorMessage(error)}`);
		return 1;
	}
	const { app } = bundle;
	try {
		const code = await runEntry(app, argv, io);
		if (code >= 0) return code;
	} catch (error) {
		io.err(`abaikit abai: ${errorMessage(error)}`);
		return 1;
	}
	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		io.err(`abaikit: ${errorMessage(error)}`);
		for (const line of USAGE) io.err(line);
		return 2;
	}
	try {
		switch (parsed.verb) {
			case "help":
				for (const line of USAGE) io.out(`${line}\n`);
				return 0;
			case "learnabai":
				return await runLearnabai(parsed, io);
			case "check":
				return await runCheck(parsed, io, app);
			case "new":
				return await runNew(parsed, io);
			case "abaify":
				return await runAbaify(parsed, io, bundle);
			case "run":
				return await runRun(parsed, io);
		}
	} catch (error) {
		if (error instanceof UsageError) {
			io.err(`abaikit: ${error.message}`);
			return 2;
		}
		io.err(`abaikit ${parsed.verb}: ${errorMessage(error)}`);
		return 1;
	}
}

/** Whether this module is the process's entry: by its real path, so a relative path or npm's bin symlink both count. */
function isEntry(): boolean {
	const entry = process.argv[1];
	if (entry === undefined) return false;
	try {
		return import.meta.url === pathToFileURL(realpathSync(entry)).href;
	} catch {
		return false;
	}
}

if (isEntry()) {
	main(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
