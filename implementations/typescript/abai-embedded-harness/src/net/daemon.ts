// The aiip daemon for a state directory: found if one answers, started if
// none does. Mirrors the aiip CLI's own spawn (`aiip --state-dir <dir>
// daemon`, a readiness poll of GET /v1/status every 50 ms for up to 10 s).
// The CLI detaches the daemon and leaves it for the next command; so does
// a run whose state dir is the shared per-program one. A run with a state
// dir of its own (ABAI_NET_DIR set, as the arena sets for each ship) ends
// at `stop()` the daemon it started. A daemon somebody else started is
// never signalled, and a child that lost aiipd's single-instance lock to
// one is not counted as ours.
import type { SpawnOptions } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIIP_SOCKET_NAME, AIIP_SOCKET_PATH_MAX, AiipClient, type AiipStatus, KNOWN_AIIP_API } from "./client.ts";
import { withoutInviteToken } from "./dir.ts";

/** What `ensureAiipDaemon` needs of a spawned child; `ChildProcess` satisfies it, tests inject their own. */
export interface ChildLike {
	pid?: number;
	exitCode: number | null;
	signalCode?: NodeJS.Signals | null;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	kill(signal?: NodeJS.Signals): boolean;
	/** Let the parent exit without waiting for this child (a daemon outlives a run that never stops it). */
	unref?(): void;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildLike;

export interface EnsureOptions {
	/** The aiip binary. */
	bin: string;
	/** The spawn to use; tests inject one that serves a fake on the socket. */
	spawn?: SpawnFn;
	/** The environment a daemon started here runs in; default this process's. The invite token is left out either way: the daemon joins through its API and never reads it. */
	env?: NodeJS.ProcessEnv;
	/** How long a started daemon may take to answer; default 10 s, as the aiip CLI. */
	readyTimeoutMs?: number;
	pollMs?: number;
	/** How long `stop()` waits after SIGTERM before SIGKILL; aiip's own shutdown grace is 5 s. */
	stopTimeoutMs?: number;
}

export interface AiipDaemon {
	dir: string;
	socketPath: string;
	client: AiipClient;
	/** The API version the daemon reports. */
	version: string;
	/** Set when the daemon speaks another `aiip-*` version than this harness knows. */
	versionSkew: string | undefined;
	/** The daemon answering is the process this call started, so `stop()` ends it. */
	spawned: boolean;
	pid: number | undefined;
	/** End the daemon this call started; a found daemon is left alone. Idempotent. */
	stop(): Promise<void>;
}

export const DEFAULT_READY_TIMEOUT_MS = 10_000;
export const DEFAULT_POLL_MS = 50;
export const DEFAULT_STOP_TIMEOUT_MS = 7_000;

/** The socket a state directory's daemon listens on, or why it cannot. */
export function socketPathFor(dir: string): string {
	const path = join(dir, AIIP_SOCKET_NAME);
	const bytes = Buffer.byteLength(path);
	if (bytes > AIIP_SOCKET_PATH_MAX) {
		throw new Error(
			`the network state directory is too deep: its socket path ${path} is ${bytes} bytes and the daemon allows ${AIIP_SOCKET_PATH_MAX}; set ABAI_NET_DIR to a shorter path`,
		);
	}
	return path;
}

/** The daemon's version string is `aiip-<milestone>`; anything else is not aiipd. */
function checkVersion(status: AiipStatus, socketPath: string): string | undefined {
	if (typeof status.version !== "string" || !status.version.startsWith("aiip-")) {
		throw new Error(`what answers at ${socketPath} is not aiipd (version ${JSON.stringify(status.version)})`);
	}
	return status.version === KNOWN_AIIP_API
		? undefined
		: `the daemon speaks ${status.version}; this harness was written against ${KNOWN_AIIP_API}`;
}

function lastLogLine(path: string): string | undefined {
	try {
		const lines = readFileSync(path, "utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i]?.trim() ?? "";
			if (line !== "" && !line.startsWith("---")) return line;
		}
	} catch {
		// no log yet
	}
	return undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function found(dir: string, socketPath: string, client: AiipClient, status: AiipStatus): AiipDaemon {
	return {
		dir,
		socketPath,
		client,
		version: status.version,
		versionSkew: checkVersion(status, socketPath),
		spawned: false,
		pid: status.pid,
		stop: async () => {},
	};
}

/**
 * The daemon for `dir`: the one answering at its socket, else one started
 * now from `bin`. Throws when the socket path is too long, when nothing
 * answers within the readiness timeout, when the child exits first with no
 * daemon behind it, or when what answers is not aiipd (a started one is
 * ended first).
 */
export async function ensureAiipDaemon(dir: string, options: EnsureOptions): Promise<AiipDaemon> {
	const socketPath = socketPathFor(dir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const client = new AiipClient(socketPath);
	const spawn: SpawnFn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
	const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

	const present = await ping(client);
	if (present) return found(dir, socketPath, client, present);

	// the child's output goes to the dir's log; the child holds its own copy of the descriptor, so ours closes at once
	const logPath = join(dir, "daemon.log");
	appendFileSync(logPath, `--- abai starting aiipd ${new Date().toISOString()} ---\n`, { mode: 0o600 });
	const log = openSync(logPath, "a");
	let child: ChildLike;
	try {
		child = spawn(options.bin, ["--state-dir", dir, "daemon"], {
			stdio: ["ignore", log, log],
			env: withoutInviteToken(options.env ?? process.env),
		});
	} catch (error) {
		closeSync(log);
		throw new Error(`the aiip binary could not be started (${options.bin}): ${errorMessage(error)}`);
	}
	closeSync(log);
	child.unref?.();
	let exited: string | undefined;
	let spawnError: string | undefined;
	child.on("exit", (code, signal) => {
		exited = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
	});
	child.on("error", (error) => {
		spawnError = error.message;
	});

	const deadline = Date.now() + readyTimeoutMs;
	let status: AiipStatus | undefined;
	while (Date.now() < deadline) {
		if (spawnError !== undefined) break;
		status = await ping(client);
		if (status) break;
		if (exited !== undefined) break;
		await sleep(pollMs);
	}
	if (!status && exited !== undefined) {
		// the child lost aiipd's lock to a daemon that came up meanwhile: that one answers, and is not ours
		status = await ping(client);
		if (status) return found(dir, socketPath, client, status);
	}
	if (!status) {
		const tail = lastLogLine(logPath);
		const detail = tail === undefined ? "" : `; last log line: ${tail}`;
		if (spawnError !== undefined) {
			throw new Error(`the aiip binary could not be started (${options.bin}): ${spawnError}`);
		}
		if (exited !== undefined) {
			throw new Error(`aiipd exited with ${exited} before answering at ${socketPath}${detail}`);
		}
		// the one process this call started, by its own handle
		await endChild(child, stopTimeoutMs);
		throw new Error(`aiipd did not answer at ${socketPath} within ${readyTimeoutMs} ms${detail}`);
	}
	// another run's daemon won the lock while ours was booting: it answers, ours is gone or going
	if (child.pid !== undefined && status.pid !== child.pid) {
		await endChild(child, stopTimeoutMs);
		return found(dir, socketPath, client, status);
	}
	let versionSkew: string | undefined;
	try {
		versionSkew = checkVersion(status, socketPath);
	} catch (error) {
		await endChild(child, stopTimeoutMs);
		throw error;
	}
	let stopping: Promise<void> | undefined;
	return {
		dir,
		socketPath,
		client,
		version: status.version,
		versionSkew,
		spawned: true,
		pid: child.pid ?? status.pid,
		stop: () => {
			stopping ??= endChild(child, stopTimeoutMs);
			return stopping;
		},
	};
}

async function ping(client: AiipClient): Promise<AiipStatus | undefined> {
	try {
		return await client.status();
	} catch {
		return undefined;
	}
}

/** SIGTERM the child, wait for its exit, SIGKILL when it will not go. */
async function endChild(child: ChildLike, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode) return;
	const gone = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
	});
	child.kill("SIGTERM");
	const outcome = await Promise.race([
		gone.then(() => "exited" as const),
		sleep(timeoutMs).then(() => "timeout" as const),
	]);
	if (outcome === "timeout") {
		child.kill("SIGKILL");
		await Promise.race([gone, sleep(1_000)]);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
