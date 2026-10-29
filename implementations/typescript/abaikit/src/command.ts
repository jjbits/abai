// Running a subject's commands: its entry's verbs and its check.run, by
// the shell in its root, with a constructed environment and a bound on
// time. The command runs in a process group of its own, so a compound
// command's children are ended with it: a run that outlives its bound is
// ended by that group, SIGTERM then SIGKILL, and abaikit's own end ends
// it too. Nothing on the machine is looked for by name.
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface CommandRun {
	command: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	/** The last `maxOutputBytes` of each stream; what came before is counted in `dropped`. */
	stdout: string;
	stderr: string;
	dropped: { stdout: number; stderr: number };
	/** Wall clock, from spawn to exit. */
	ms: number;
	timedOut: boolean;
}

export interface CommandOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	/** Bytes of each stream kept, the newest; default 4 MiB. */
	maxOutputBytes?: number;
}

/** Variables that tell the stub what to do; a subject inherits only where things are (`ABAI_HOME`, `ABAI_RUN_DIR`, the harness locations). */
export const BEHAVIOUR_VARIABLES = [
	"ABAI_MODE",
	"ABAI_HARNESS",
	"ABAI_LAUNCH_SOCKET",
	"ABAI_CHANNEL",
	"ABAI_ATTACH_WAIT_MS",
];

/** The environment a subject's run gets: ours without the behaviour variables, plus exactly what this run means. */
export function subjectEnv(base: NodeJS.ProcessEnv, set: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		if (!BEHAVIOUR_VARIABLES.includes(key)) env[key] = value;
	}
	return { ...env, ...set };
}

/** After the timeout's SIGTERM, how long before the group is killed. */
export const FORCE_AFTER_MS = 2000;
/** After the shell has exited, how long a survivor may hold the pipes before the group is killed and the run resolves. */
export const CLOSE_GRACE_MS = 1500;

/** The newest `max` bytes of a stream, as chunks arrive. */
class Tail {
	private readonly chunks: Buffer[] = [];
	private readonly max: number;
	private kept = 0;
	dropped = 0;
	constructor(max: number) {
		this.max = max;
	}
	push(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.kept += chunk.length;
		while (this.kept > this.max && this.chunks.length > 1) {
			const oldest = this.chunks.shift() as Buffer;
			this.kept -= oldest.length;
			this.dropped += oldest.length;
		}
	}
	text(): string {
		return Buffer.concat(this.chunks).toString("utf8");
	}
}

export function runCommand(command: string, options: CommandOptions): Promise<CommandRun> {
	const max = options.maxOutputBytes ?? 4 * 1024 * 1024;
	return new Promise((resolve) => {
		const started = performance.now();
		const child = spawn("sh", ["-c", command], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const out = new Tail(max);
		const err = new Tail(max);
		child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
		// the whole group, by the pid we were given; the child alone when the group is already gone
		const signalGroup = (signal: NodeJS.Signals): void => {
			const pid = child.pid;
			if (pid === undefined) return;
			try {
				process.kill(-pid, signal);
			} catch {
				try {
					child.kill(signal);
				} catch {
					// already gone
				}
			}
		};
		let timedOut = false;
		let settled = false;
		let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
		let closeGrace: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			signalGroup("SIGTERM");
		}, options.timeoutMs);
		const force = setTimeout(() => signalGroup("SIGKILL"), options.timeoutMs + FORCE_AFTER_MS);
		force.unref();
		// a group of its own is outside the terminal's foreground group: our end has to reach it
		const forward = (signal: NodeJS.Signals): void => signalGroup(signal);
		const forwarded: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
		for (const signal of forwarded) process.on(signal, forward);
		const finish = (code: number | null, signal: NodeJS.Signals | null, failure?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(force);
			if (closeGrace !== undefined) clearTimeout(closeGrace);
			for (const s of forwarded) process.off(s, forward);
			resolve({
				command,
				code,
				signal,
				stdout: out.text(),
				stderr: err.text() + (failure ? `${failure.message}\n` : ""),
				dropped: { stdout: out.dropped, stderr: err.dropped },
				ms: performance.now() - started,
				timedOut,
			});
		};
		child.once("error", (error) => finish(null, null, error));
		child.once("exit", (code, signal) => {
			exited = { code, signal };
			// the pipes may be held by a survivor of the group: a bounded wait for close, then the group is ended
			closeGrace = setTimeout(() => {
				signalGroup("SIGKILL");
				finish(code, signal);
			}, CLOSE_GRACE_MS);
		});
		child.once("close", (code, signal) => finish(exited?.code ?? code, exited?.signal ?? signal));
	});
}

/** A stream that is one JSON object, pretty or not, else its last line that is one. */
export function jsonDocument(text: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
			return parsed as Record<string, unknown>;
	} catch {
		// not one document
	}
	return lastJsonLine(text);
}

/** The last line of a stream that parses as a JSON object and satisfies `accept`, or undefined. */
export function lastJsonLine(
	text: string,
	accept: (value: Record<string, unknown>) => boolean = () => true,
): Record<string, unknown> | undefined {
	const lines = text.split("\n").filter((l) => l.trim() !== "");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed) &&
				accept(parsed as Record<string, unknown>)
			) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// not this line
		}
	}
	return undefined;
}

/** The last non-empty line that is not a JSON object, for saying how a run failed. */
export function lastPlainLine(text: string): string {
	const lines = text.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("{"));
	return lines.at(-1)?.trim() ?? "";
}

/** The newest `bytes` of a text, for a report that should not carry a whole log. */
export function tailOf(text: string, bytes: number): string {
	return text.length <= bytes ? text : `[${text.length - bytes} earlier characters omitted]\n${text.slice(-bytes)}`;
}

export function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
