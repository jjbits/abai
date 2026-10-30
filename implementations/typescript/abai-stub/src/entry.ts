// The standard agent entry (abaigrammar section 4.4), the part the stub
// provides itself: `<prog> abai manifest` prints the effective manifest and
// `<prog> abai doctor` runs the offline conformance checks. The verbs that
// need a harness (session, install, config, mcp, run) are delegated once a
// harness binding exists; until then the usage says so. Never throws;
// resolves to the exit code.
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findRoot, MANIFEST_FILE } from "./content.ts";
import { ENV_HARNESS, ENV_MODE, expandHome } from "./env.ts";
import { validateManifest } from "./manifest/manifest.ts";
import { parseManifestYaml, renderManifestYaml } from "./manifest/render.ts";
import { type Abaigram, harnessBinary, importHarnessModule } from "./program.ts";

export const STUB_VERSION = "0.1.0";

export type CheckStatus = "ok" | "fail" | "skip";

export interface DoctorCheck {
	name: string;
	status: CheckStatus;
	detail: string;
}

export interface DoctorReport {
	ok: boolean;
	root: string | null;
	checks: DoctorCheck[];
}

/** Where the entry writes; injectable for tests. */
export interface EntryIo {
	out(text: string): void;
	err(text: string): void;
	env: NodeJS.ProcessEnv;
	cwd: string;
}

export const processIo: EntryIo = {
	out: (text) => {
		process.stdout.write(text);
	},
	err: (text) => {
		process.stderr.write(`${text}\n`);
	},
	env: process.env,
	get cwd() {
		return process.cwd();
	},
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function usageLines(entry: string): string[] {
	return [
		`usage: ${entry}                      open a session`,
		`       ${entry} install              run the install touchpoint`,
		`       ${entry} manifest [--json]    print the effective manifest`,
		`       ${entry} doctor [--root <dir>] [--offline] [--json]`,
		`       ${entry} config [set ...]       the machine-level model configuration`,
		`       ${entry} mcp                  serve the agent's tools to an MCP client over stdio`,
		`       ${entry} run [--auto] -- ARGS  the harness starts this program as its supervised child`,
		"",
		"doctor  offline conformance checks: the effective manifest, the checked-in",
		`        ${MANIFEST_FILE}, the identity content, the modes, the audit directory`,
		"",
		"session and install attach a harness and return when none can attach; mcp needs no model,",
		"since the client's own agent is this program's; run is always sidecar launch, with the whole",
		"lifecycle channel and the program's output observed from outside.",
	];
}

interface Flags {
	json: boolean;
	root: string | undefined;
	offline: boolean;
}

/** `--flag`, `--flag value` and `--flag=value`; anything else is a usage error. */
function parseFlags(args: string[], allowed: readonly string[]): Flags | string {
	const flags: Flags = { json: false, root: undefined, offline: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const eq = arg.indexOf("=");
		const name = eq === -1 ? arg : arg.slice(0, eq);
		if (!allowed.includes(name)) return `unknown option ${arg}`;
		const takeValue = (): string | undefined => {
			if (eq !== -1) return arg.slice(eq + 1);
			i += 1;
			return args[i];
		};
		switch (name) {
			case "--json":
				flags.json = true;
				break;
			case "--offline":
				flags.offline = true;
				break;
			case "--root": {
				const value = takeValue();
				if (value === undefined || value === "") return "--root needs a directory";
				flags.root = value;
				break;
			}
			default:
				return `unknown option ${arg}`;
		}
	}
	return flags;
}

/** The first line at which two texts differ (1-based), or undefined when equal. */
export function firstDifferingLine(a: string, b: string): number | undefined {
	if (a === b) return undefined;
	const linesA = a.split("\n");
	const linesB = b.split("\n");
	const n = Math.max(linesA.length, linesB.length);
	for (let i = 0; i < n; i++) {
		if (linesA[i] !== linesB[i]) return i + 1;
	}
	return n;
}

/** The first existing ancestor of a path (the path itself included). */
function existingAncestor(path: string): string {
	let current = path;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return current;
}

/** The offline half of `doctor` (section 4.4), plus the online half when the harness package is installed. Never throws. */
export async function runDoctor(
	app: Abaigram,
	options: { root?: string; io?: EntryIo; online?: boolean } = {},
): Promise<DoctorReport> {
	const io = options.io ?? processIo;
	const checks: DoctorCheck[] = [];
	const add = (name: string, status: CheckStatus, detail: string) => {
		checks.push({ name, status, detail });
	};
	const { manifest } = app;

	add("entry", "ok", `${manifest.entry} reached (abai stub ${STUB_VERSION})`);

	const violations = validateManifest(manifest);
	let rendered: string | undefined;
	if (violations.length === 0) {
		rendered = renderManifestYaml(manifest);
		add(
			"manifest",
			"ok",
			`the effective manifest validates (${manifest.cells.length} cells, ${manifest.events.length} events, ${manifest.capabilities.length} capabilities, ${manifest.decisions.length} decisions, ${manifest.turns.length} turns)`,
		);
	} else {
		add("manifest", "fail", `the effective manifest does not validate: ${violations.join("; ")}`);
	}

	const root =
		options.root !== undefined
			? resolve(io.cwd, options.root)
			: (findRoot(manifest.name, io.cwd) ??
				(existsSync(join(app.content.root, MANIFEST_FILE)) ? app.content.root : undefined));
	if (root === undefined) {
		add("root", "skip", `no checkout found (pass --root <dir> to check a checked-in ${MANIFEST_FILE})`);
		add(MANIFEST_FILE, "skip", "no checkout");
		add("identity", "skip", "no checkout");
	} else {
		add("root", "ok", root);
		const path = join(root, MANIFEST_FILE);
		if (!existsSync(path)) {
			add(MANIFEST_FILE, "fail", `${path} is missing; run: ${manifest.entry} manifest > ${MANIFEST_FILE}`);
		} else {
			let text: string | undefined;
			try {
				text = readFileSync(path, "utf8");
			} catch (error) {
				add(MANIFEST_FILE, "fail", `${path} could not be read: ${errorMessage(error)}`);
			}
			if (text !== undefined) {
				let parsed: unknown;
				let parseError: string | undefined;
				try {
					parsed = parseManifestYaml(text);
				} catch (error) {
					parseError = errorMessage(error);
				}
				if (parseError !== undefined) {
					add(MANIFEST_FILE, "fail", `${path} does not parse: ${parseError}`);
				} else {
					const fileViolations = validateManifest(parsed);
					if (fileViolations.length > 0) {
						add(MANIFEST_FILE, "fail", `${path} does not validate: ${fileViolations.join("; ")}`);
					} else if (rendered !== undefined && text !== rendered) {
						add(
							MANIFEST_FILE,
							"fail",
							`${path} is stale: first difference at line ${firstDifferingLine(text, rendered)}; run: ${manifest.entry} manifest > ${MANIFEST_FILE}`,
						);
					} else if (rendered !== undefined) {
						add(MANIFEST_FILE, "ok", `${path} validates and agrees with the code`);
					} else {
						add(MANIFEST_FILE, "fail", `${path} validates but the effective manifest does not`);
					}
				}
			}
		}
		const identity = join(root, manifest.content.identity);
		try {
			if (!existsSync(identity)) add("identity", "fail", `${identity} is missing`);
			else if (readFileSync(identity, "utf8").trim() === "") add("identity", "fail", `${identity} is empty`);
			else add("identity", "ok", identity);
		} catch (error) {
			add("identity", "fail", `${identity} could not be read: ${errorMessage(error)}`);
		}
	}

	if (app.harnessSelectionError !== undefined) add("harness", "fail", app.harnessSelectionError);
	else add("harness", "ok", `${ENV_HARNESS}: ${app.harnessSelection}`);

	const modes = manifest.modes as string[];
	const selected = io.env[ENV_MODE]?.trim();
	if (selected === undefined || selected === "") {
		add("modes", "ok", `declared: ${modes.join(", ")}; default ${modes[0]}`);
	} else if (modes.includes(selected)) {
		add("modes", "ok", `${ENV_MODE}=${selected} is declared (declared: ${modes.join(", ")})`);
	} else {
		add(
			"modes",
			"fail",
			`${ENV_MODE}=${selected} is not declared (declared: ${modes.join(", ")}); a plain run falls back and counts it`,
		);
	}

	if (app.endpoint !== undefined) {
		// under sidecar the endpoint has been listening since startup; doctor says where, or why not
		try {
			await app.endpoint.ready;
			add("endpoint", "ok", `listening at ${app.endpoint.socketPath}`);
		} catch (error) {
			add("endpoint", "fail", `the endpoint could not listen: ${errorMessage(error)}`);
		}
	}

	try {
		const auditPath = expandHome(manifest.audit.path, io.env.HOME ?? "");
		const ancestor = existingAncestor(dirname(resolve(io.cwd, auditPath)));
		if (!statSync(ancestor).isDirectory()) {
			add("audit", "fail", `${ancestor} is not a directory`);
		} else {
			accessSync(ancestor, constants.W_OK);
			add("audit", "ok", `${auditPath} (${ancestor} is writable)`);
		}
	} catch (error) {
		add("audit", "fail", `the audit directory is not writable: ${errorMessage(error)}`);
	}

	if (options.online === false) {
		add("online", "skip", "not asked (--offline)");
	} else {
		const harness = await importHarnessModule(io.env, manifest);
		if (!harness?.doctorOnline) {
			add("online", "skip", "no harness is installed to check the model");
		} else {
			try {
				for (const check of await harness.doctorOnline(manifest, io.env))
					add(check.name, check.status, check.detail);
			} catch (error) {
				add("online", "fail", `the harness's check failed: ${errorMessage(error)}`);
			}
		}
	}

	return { ok: checks.every((check) => check.status !== "fail"), root: root ?? null, checks };
}

function printReport(report: DoctorReport, io: EntryIo): void {
	for (const check of report.checks) io.out(`${check.status.padEnd(4)} ${check.name}: ${check.detail}\n`);
	io.out(report.ok ? "doctor: ok\n" : "doctor: failed\n");
}

/**
 * `<prog> abai <verb> ...`. `args` are the arguments after the program's
 * own name; the first must be `abai`. Resolves to the exit code; -1 means
 * the arguments were not an abai entry at all.
 */
export async function runEntry(app: Abaigram, args: string[], io: EntryIo = processIo): Promise<number> {
	if (args[0] !== "abai") {
		// the entry is one of the five attach places (4.3): a launched program takes up its connection here,
		// before its own work, so its first touchpoint finds the agent present
		if (app.launched) await app.attach();
		return -1;
	}
	const { manifest } = app;
	const usage = (problem?: string): number => {
		if (problem !== undefined) io.err(`${manifest.entry}: ${problem}`);
		for (const line of usageLines(manifest.entry)) io.err(line);
		return 2;
	};
	try {
		const verb = args[1];
		switch (verb) {
			case "manifest": {
				const flags = parseFlags(args.slice(2), ["--json"]);
				if (typeof flags === "string") return usage(flags);
				// a selected mode the manifest does not declare is an error at the entry (section 4.4)
				const selected = io.env[ENV_MODE]?.trim();
				if (selected !== undefined && selected !== "" && !(manifest.modes as string[]).includes(selected)) {
					io.err(
						`${manifest.entry}: ${ENV_MODE}=${selected} is not a declared mode (declared: ${manifest.modes.join(", ")})`,
					);
					return 2;
				}
				io.out(flags.json ? `${JSON.stringify(manifest, null, 2)}\n` : renderManifestYaml(manifest));
				return 0;
			}
			case "doctor": {
				const flags = parseFlags(args.slice(2), ["--json", "--root", "--offline"]);
				if (typeof flags === "string") return usage(flags);
				const report = await runDoctor(app, { root: flags.root, io, online: !flags.offline });
				if (flags.json) io.out(`${JSON.stringify(report, null, 2)}\n`);
				else printReport(report, io);
				return report.ok ? 0 : 1;
			}
			case undefined:
			case "session": {
				await app.session();
				if (app.attached) return 0;
				io.err(`${manifest.entry}: no harness attached (${app.attachError ?? "unknown reason"})`);
				return 1;
			}
			case "install": {
				await app.install();
				if (app.attached) return 0;
				io.err(`${manifest.entry}: no harness attached (${app.attachError ?? "unknown reason"})`);
				return 1;
			}
			case "config": {
				const harness = await importHarnessModule(io.env, manifest);
				if (!harness?.runConfig) return usage("config needs the harness package, which is not installed");
				return await harness.runConfig(args.slice(2), io);
			}
			case "mcp": {
				// the program at its entry serves an MCP client: under sidecar through the binary on this
				// process's stdio, otherwise in-process through the installed harness package (section 4.4).
				// ABAI_HARNESS is honoured like everywhere: off attaches nothing, a null harness is attached already
				if (app.harnessSelection === "off") {
					io.err(`${manifest.entry}: no harness attached (${ENV_HARNESS}=off)`);
					return 1;
				}
				if (app.attached) {
					io.err(`${manifest.entry}: ${manifest.name} already has a harness attached`);
					return 1;
				}
				if (app.endpoint !== undefined) {
					const code = await app.serveMcpSidecar(app.endpoint);
					if (code >= 0) return code;
					io.err(`${manifest.entry}: no harness attached (${app.attachError ?? "unknown reason"})`);
					return 1;
				}
				const harness = await importHarnessModule(io.env, manifest);
				if (!harness?.serveMcpEmbedded) return usage("mcp needs the harness package, which is not installed");
				const binding = app.bind("mcp");
				binding.enterSafepoint();
				try {
					return await harness.serveMcpEmbedded(binding);
				} finally {
					binding.leaveSafepoint();
				}
			}
			case "run": {
				// sidecar launch (4.4, 6.3): the harness binary starts this very program again as its child
				if (!(manifest.modes as string[]).includes("sidecar")) {
					io.err(
						`${manifest.entry}: run is sidecar launch, and ${manifest.name} declares ${manifest.modes.join(", ")}`,
					);
					return 2;
				}
				const separator = args.indexOf("--");
				const flags = args.slice(2, separator === -1 ? undefined : separator);
				const programArgs = separator === -1 ? [] : args.slice(separator + 1);
				for (const flag of flags) {
					if (flag !== "--auto" && flag !== "--deny-mutate" && flag !== "--all-events") {
						return usage(`unknown option ${flag} (run takes --auto, --deny-mutate, --all-events)`);
					}
				}
				const binary = harnessBinary(io.env, app.content.root);
				const script = process.argv[1];
				if (script === undefined) return usage("run cannot tell how this program was started");
				const command = [process.execPath, ...process.execArgv, script, ...programArgs];
				const child = spawn(binary.command, [...binary.args, "run", ...flags, "--", ...command], {
					stdio: "inherit",
					env: { ...process.env, ...io.env },
				});
				// whoever ends this process ends the launcher behind it, which ends the program it supervises
				const forward = (signal: NodeJS.Signals): void => {
					if (child.exitCode === null && child.signalCode === null) child.kill(signal);
				};
				const forwarded: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
				for (const signal of forwarded) process.on(signal, forward);
				try {
					return await new Promise<number>((resolve) => {
						child.once("error", (error) => {
							io.err(`${manifest.entry}: the harness binary could not be started: ${errorMessage(error)}`);
							resolve(1);
						});
						child.once("exit", (code) => resolve(code ?? 1));
					});
				} finally {
					for (const signal of forwarded) process.off(signal, forward);
				}
			}
			default:
				return usage(`unknown verb ${verb}`);
		}
	} catch (error) {
		io.err(`${manifest.entry}: ${errorMessage(error)}`);
		return 2;
	}
}
