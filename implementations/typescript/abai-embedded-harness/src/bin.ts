#!/usr/bin/env node
// The sidecar binary (abaigrammar section 4.4): the harness in its own
// process, attached to a running program over its wire endpoint. `session`
// is the person's loop against the configured model; `attach` serves a
// program that spawned this binary at a touchpoint, and ends when the
// program goes; `list` shows the programs whose descriptors are in the run
// directory; `config` and `doctor` are the machine-level verbs the stub also
// delegates here. `mcp` serves the harness's tools to an MCP client such as
// Claude Code, whose own agent is then the program's; no model is needed.
import { realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { attachWaitMsFrom, type Manifest, validateManifest } from "@abaigram/stub";
import { SessionForm } from "./agent.ts";
import { type CliIo, doctorOnline, processIo, runConfig } from "./cli.ts";
import { abaiHome } from "./config.ts";
import { Harness } from "./harness.ts";
import { LaunchedProgram } from "./launch.ts";
import { type McpDeps, serveMcp } from "./mcp.ts";
import { createModelSetup, ModelNotConfigured, resolveConfiguredModel } from "./model/index.ts";
import { defaultOptions, type HarnessOptions } from "./options.ts";
import { terminalChannel } from "./terminal-channel.ts";
import { SocketTransport } from "./transport-socket.ts";
import { WireClient } from "./wire/client.ts";

export const VERBS = ["session", "attach", "mcp", "run", "list", "config", "doctor", "help"] as const;
export type Verb = (typeof VERBS)[number];

export interface ParsedArgs {
	verb: Verb;
	/** A socket path or a pid; undefined means the one running program. */
	target: string | undefined;
	runDir: string | undefined;
	/** Harness options the flags set. */
	options: Partial<HarnessOptions>;
	/** Subscribe to every event the program emits (the program's default filter otherwise). */
	allEvents: boolean;
	json: boolean;
	/** What follows the verb for `config`. */
	rest: string[];
	/** For `run`: the program's own command, after `--`. */
	program: string[];
}

const USAGE = [
	"usage: abai-embedded-harness session [--target <socket|pid>] [--run-dir <dir>] [options]",
	"       abai-embedded-harness attach --target <socket|pid> [--run-dir <dir>] [options]",
	"       abai-embedded-harness mcp [--target <socket|pid>] [--run-dir <dir>] [options]",
	"       abai-embedded-harness run [--run-dir <dir>] [options] -- <command> [args...]",
	"       abai-embedded-harness list [--run-dir <dir>] [--json]",
	"       abai-embedded-harness doctor [--target <socket|pid>] [--run-dir <dir>]",
	"       abai-embedded-harness config [show|set ...|unset ...]",
	"",
	"session is the person's loop against a running program; attach is what a program spawns at its own",
	"touchpoint: it serves the program's decisions, turns and touchpoints, opens the person's loop when a",
	"session touchpoint arrives, and exits when the program goes. mcp is an MCP server on stdin and stdout",
	"for a client such as Claude Code, whose agent is then the program's; it needs no model, attaches to",
	"the target (or the one running program) when it can, and serves detached otherwise (abai_attach attaches).",
	"run is sidecar launch: the harness starts the command as its supervised child, observes its output and",
	"exit, and has the whole lifecycle channel; the session on this terminal ends it.",
	"",
	"options for session, attach, mcp and run:",
	"  --claim <name,...>        decisions to claim (default: every decision the program offers; a program",
	"                            with many, such as arx-06, is better served by naming the ones you want)",
	"  --claim-timeout <ms>      the claim's timeout where the program lets a harness shorten it",
	"  --wake <event,...>        event names that wake the agent beyond the manifest's wakes",
	"  --budget <n>              wakes per minute",
	"  --auto                    allow mutate calls without asking the person",
	"  --deny-mutate             refuse mutate calls",
	"  --all-events              subscribe to every event (the program's default filter otherwise)",
	"",
	"the run directory holds the descriptors of running programs; default: ~/.abai/run",
];

export class UsageError extends Error {}

function takeValue(argv: string[], i: number, flag: string): string {
	const value = argv[i + 1];
	if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
	return value;
}

function positiveInt(value: string, flag: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} needs a positive integer`);
	return n;
}

function list(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
}

export function parseArgs(argv: string[]): ParsedArgs {
	const verb = argv[0];
	if (verb === undefined || verb === "help" || verb === "--help" || verb === "-h") {
		return {
			verb: "help",
			target: undefined,
			runDir: undefined,
			options: {},
			allEvents: false,
			json: false,
			rest: [],
			program: [],
		};
	}
	if (!VERBS.includes(verb as Verb)) throw new UsageError(`unknown verb ${verb}`);
	const parsed: ParsedArgs = {
		verb: verb as Verb,
		target: undefined,
		runDir: undefined,
		options: {},
		allEvents: false,
		json: false,
		rest: [],
		program: [],
	};
	if (verb === "config") {
		parsed.rest = argv.slice(1);
		return parsed;
	}
	// run takes the program's own command after --, and nothing else may
	const separator = argv.indexOf("--");
	const flags = separator === -1 ? argv : argv.slice(0, separator);
	if (separator !== -1) {
		if (verb !== "run") throw new UsageError(`${verb} takes no program command`);
		parsed.program = argv.slice(separator + 1);
	}
	if (verb === "run" && parsed.program.length === 0) throw new UsageError("run needs a program command after --");
	for (let i = 1; i < flags.length; i++) {
		const arg = flags[i];
		switch (arg) {
			case "--target":
				parsed.target = takeValue(flags, i++, arg);
				break;
			case "--run-dir":
				parsed.runDir = takeValue(flags, i++, arg);
				break;
			case "--claim":
				parsed.options.claims = list(takeValue(flags, i++, arg));
				break;
			case "--claim-timeout":
				parsed.options.claimTimeoutMs = positiveInt(takeValue(flags, i++, arg), arg);
				break;
			case "--wake":
				parsed.options.wakes = list(takeValue(flags, i++, arg));
				break;
			case "--budget":
				parsed.options.budget = positiveInt(takeValue(flags, i++, arg), arg);
				break;
			case "--auto":
				parsed.options.auto = true;
				break;
			case "--deny-mutate":
				parsed.options.denyMutate = true;
				break;
			case "--all-events":
				parsed.allEvents = true;
				break;
			case "--json":
				parsed.json = true;
				break;
			default:
				throw new UsageError(`unknown argument ${arg}`);
		}
	}
	if (parsed.options.auto && parsed.options.denyMutate)
		throw new UsageError("--auto and --deny-mutate exclude each other");
	return parsed;
}

export function defaultRunDir(env: NodeJS.ProcessEnv): string {
	return join(abaiHome(env), "run");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function runList(parsed: ParsedArgs, io: CliIo): Promise<number> {
	const runDir = parsed.runDir ?? defaultRunDir(io.env);
	const programs = WireClient.listPrograms(runDir);
	if (parsed.json) {
		io.out(`${JSON.stringify(programs)}\n`);
		return 0;
	}
	if (programs.length === 0) {
		io.out(`no program is running (descriptors in ${runDir})\n`);
		return 0;
	}
	for (const p of programs) io.out(`${p.pid}\t${p.name}\t${p.mode}\t${p.cwd}\t${p.socket}\n`);
	return 0;
}

async function runDoctor(parsed: ParsedArgs, io: CliIo): Promise<number> {
	let manifest: Manifest = { model: {} } as Manifest;
	if (parsed.target !== undefined || parsed.runDir !== undefined) {
		const transport = await SocketTransport.connect(parsed.target, {
			runDir: parsed.runDir ?? defaultRunDir(io.env),
		});
		try {
			manifest = await transport.manifest();
			const violations = validateManifest(manifest);
			if (violations.length > 0) {
				for (const violation of violations) io.out(`fail manifest: ${violation}\n`);
				return 1;
			}
			io.out(`ok program: ${transport.hello.name} (pid ${transport.hello.pid}) speaks wire v1, manifest valid\n`);
		} finally {
			transport.close("doctor done");
		}
	}
	const checks = await doctorOnline(manifest, io.env);
	for (const check of checks) io.out(`${check.status} ${check.name}: ${check.detail}\n`);
	return checks.some((c) => c.status === "fail") ? 1 : 0;
}

/** The model, then the connection, then the harness over it: shared by `session` and `attach`. */
async function connectHarness(parsed: ParsedArgs, io: CliIo) {
	const setup = createModelSetup(io.env);
	const connectTimeoutMs = setup.config.connectTimeoutMs;
	// resolved before any connection: an unconfigured machine fails here, at once (section 4.3)
	const model = await resolveConfiguredModel(setup, {
		allowNetwork: true,
		signal: AbortSignal.timeout(connectTimeoutMs),
	});
	const transport = await SocketTransport.connect(parsed.target, {
		runDir: parsed.runDir ?? defaultRunDir(io.env),
		...(parsed.allEvents ? { subscribe: { exclude: [] } } : {}),
	});
	const harness = new Harness(defaultOptions("session", parsed.options));
	return { model, connectTimeoutMs, transport, harness };
}

async function runSession(parsed: ParsedArgs, io: CliIo): Promise<number> {
	const { model, connectTimeoutMs, transport, harness } = await connectHarness(parsed, io);
	let form: SessionForm | undefined;
	let lost: string | undefined;
	let ending = false;
	// set before attach: a disconnect right after the claim must end the session, not leave the loop asking
	harness.onDetach = (reason) => {
		if (ending) return;
		lost = reason;
		io.err(`abai: detached: ${reason}`);
		form?.shutdown(reason);
	};
	const hello = await harness.attach(transport);
	const channel = terminalChannel();
	form = new SessionForm({ harness, model, channel, connectTimeoutMs, mode: "live" });
	if (lost !== undefined) {
		form.shutdown(lost);
		return 1;
	}
	io.err(
		`attached to ${hello.name}${hello.pid === undefined ? "" : ` (pid ${hello.pid})`} as ${hello.connection}; claims: ${
			harness.currentClaims().join(", ") || "none"
		}`,
	);
	try {
		await form.converse();
	} finally {
		ending = true;
		form.shutdown("the session ended");
	}
	// the person ended it: 0; the program went away or the model was unreachable: 1, said on stderr
	return lost === undefined ? 0 : 1;
}

/**
 * Serve a program that spawned this binary at a touchpoint (section 6.3,
 * attach form). The session form answers what the program asks: a session
 * touchpoint opens the person's loop on the inherited terminal and ends the
 * touchpoint when the person is done; an install touchpoint is delivered to
 * the agent and ended with its run. The binary exits when the program goes,
 * 0 unless the model could not be reached.
 */
async function runAttach(parsed: ParsedArgs, io: CliIo): Promise<number> {
	const { model, connectTimeoutMs, transport, harness } = await connectHarness(parsed, io);
	let form: SessionForm | undefined;
	const gone = new Promise<string>((resolve) => {
		harness.onDetach = (reason) => {
			// the program ending is the normal end of this verb; anything else is said
			if (reason !== "the program disconnected") io.err(`abai: detached: ${reason}`);
			form?.shutdown(reason);
			resolve(reason);
		};
	});
	const hello = await harness.attach(transport);
	// the inherited terminal is the person's channel, a pipe included (a scripted session); ABAI_CHANNEL=none for a daemon
	const channel = io.env.ABAI_CHANNEL?.trim() === "none" ? undefined : terminalChannel();
	// built after the attach, so a session touchpoint the program opened at once is found held, not lost
	form = new SessionForm({ harness, model, channel, connectTimeoutMs, mode: "live" });
	io.err(
		`attached to ${hello.name}${hello.pid === undefined ? "" : ` (pid ${hello.pid})`} as ${hello.connection}; claims: ${
			harness.currentClaims().join(", ") || "none"
		}`,
	);
	const reason = await gone;
	form.shutdown(reason);
	return form.modelFailure === undefined ? 0 : 1;
}

export type McpStreams = Pick<McpDeps, "input" | "output" | "stderr">;

/**
 * The MCP server (section 4.4, `mcp`): no model, the client's agent is the
 * program's. With a target, or exactly one running program, the harness is
 * attached before serving; otherwise it serves detached, says so, and
 * `abai_attach` attaches later. Exits 0 when the client goes.
 */
export async function runMcp(parsed: ParsedArgs, io: CliIo, streams: McpStreams = {}): Promise<number> {
	const runDir = parsed.runDir ?? defaultRunDir(io.env);
	const harness = new Harness(defaultOptions("mcp", parsed.options));
	const connect = async (target: string | number | undefined): Promise<string> => {
		const transport = await SocketTransport.connect(target, {
			runDir,
			...(parsed.allEvents ? { subscribe: { exclude: [] } } : {}),
		});
		const hello = await harness.attach(transport);
		return `attached to ${hello.name}${hello.pid === undefined ? "" : ` (pid ${hello.pid})`} as ${hello.connection}; claims: ${
			harness.currentClaims().join(", ") || "none"
		}`;
	};
	try {
		io.err(`abai mcp: ${await connect(parsed.target)}`);
	} catch (error) {
		// the client is already talking to this server: a program that is not there yet is a notice, not an exit
		io.err(`abai mcp: not attached (${errorMessage(error)}); abai_attach attaches to a program later`);
	}
	return await serveMcp(harness, { ...streams, attach: connect });
}

/**
 * Sidecar launch (section 6.3): the model first, then the program as this
 * harness's child, then the person's session on this terminal with the
 * whole lifecycle channel. The session ending stops a program still running,
 * the graceful way; the exit code is the program's when it exited.
 */
async function runLaunch(parsed: ParsedArgs, io: CliIo): Promise<number> {
	const setup = createModelSetup(io.env);
	const connectTimeoutMs = setup.config.connectTimeoutMs;
	const model = await resolveConfiguredModel(setup, {
		allowNetwork: true,
		signal: AbortSignal.timeout(connectTimeoutMs),
	});
	const harness = new Harness(defaultOptions("session", parsed.options));
	const channel = terminalChannel();
	let form: SessionForm | undefined;
	let modelLost: string | undefined;
	harness.onDetach = (reason) => {
		// under launch a detach is the program going, which the exit event already says; nothing ends here
		if (reason === "the program disconnected") return;
		io.err(`abai: detached: ${reason}`);
		// the model could not be reached: the person's loop has no agent behind it, so it ends; the program
		// goes on as itself (section 4.3), observed from outside until it exits
		if (form?.modelFailure !== undefined) {
			modelLost = reason;
			channel.close();
		}
	};
	const launched = await LaunchedProgram.start(harness, {
		command: parsed.program,
		runDir: parsed.runDir ?? defaultRunDir(io.env),
		env: io.env,
		attachWaitMs: attachWaitMsFrom(io.env),
		...(parsed.allEvents ? { subscribe: { exclude: [] } } : {}),
		stdout: process.stdout,
		stderr: process.stderr,
	});
	harness.launcher = launched;
	io.err(`abai: ${launched.lastNote}`);
	form = new SessionForm({ harness, model, channel, connectTimeoutMs, mode: "live" });
	const session = form;
	// whoever ends this process ends the program it supervises, the graceful way: the person's loop closes,
	// the program is stopped while the harness is still attached to ask it, then the agent is ended
	let signalled: NodeJS.Signals | undefined;
	const onSignal = (signal: NodeJS.Signals): void => {
		if (signalled !== undefined) return;
		signalled = signal;
		io.err(`abai: ${signal}; stopping the program`);
		channel.close();
		void launched
			.shutdown(`the launcher received ${signal}`)
			.then(() => session.shutdown(`the launcher received ${signal}`));
	};
	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
	for (const signal of signals) process.on(signal, onSignal);
	try {
		await session.converse();
		if (modelLost === undefined && signalled === undefined && launched.running) {
			io.err("abai: the session ended; stopping the program");
		}
		if (modelLost !== undefined && signalled === undefined && launched.running) {
			io.err("abai: the program runs on without an agent; waiting for it to exit");
			await launched.exited();
		}
		await launched.shutdown("the session ended");
	} finally {
		for (const signal of signals) process.off(signal, onSignal);
		session.shutdown("the session ended");
	}
	if (signalled !== undefined) return 128 + (osConstants.signals[signalled] ?? 0);
	return launched.exitCode();
}

/** The binary's entry; resolves to the exit code and never throws. */
export async function main(argv: string[], io: CliIo = processIo): Promise<number> {
	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		io.err(`abai-embedded-harness: ${errorMessage(error)}`);
		for (const line of USAGE) io.err(line);
		return 2;
	}
	try {
		switch (parsed.verb) {
			case "help":
				for (const line of USAGE) io.out(`${line}\n`);
				return 0;
			case "list":
				return await runList(parsed, io);
			case "config":
				return await runConfig(parsed.rest, io);
			case "doctor":
				return await runDoctor(parsed, io);
			case "session":
				return await runSession(parsed, io);
			case "attach":
				if (parsed.target === undefined) throw new UsageError("attach needs --target <socket|pid>");
				return await runAttach(parsed, io);
			case "mcp":
				return await runMcp(parsed, io);
			case "run":
				return await runLaunch(parsed, io);
		}
	} catch (error) {
		if (error instanceof UsageError) {
			io.err(`abai-embedded-harness: ${error.message}`);
			return 2;
		}
		io.err(
			`abai-embedded-harness ${parsed.verb}: ${error instanceof ModelNotConfigured ? error.message : errorMessage(error)}`,
		);
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
