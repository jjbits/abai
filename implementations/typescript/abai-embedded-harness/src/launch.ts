// Sidecar launch (abaigrammar section 6.3) and outside observation (5.7):
// the harness starts the program as its supervised child, hands it the
// connection through ABAI_LAUNCH_SOCKET, reads its output as lines into the
// transcript, and drives the lifecycle operations only a launcher can (5.5).
// Everything here acts on the one child this launcher started, by its own
// handle; nothing else on the machine is looked at.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import {
	type Consent,
	durationMs,
	ENV_LAUNCH_SOCKET,
	ENV_MODE,
	ensureRunDir,
	MAX_SOCKET_PATH_BYTES,
	type SubscriptionFilter,
	shortSocketPath,
} from "@abaigram/abai-stub";
import type { Harness, Launcher, LaunchState } from "./harness.ts";
import { TransportCallError } from "./transport.ts";
import { SocketTransport } from "./transport-socket.ts";

export interface LaunchOptions {
	/** The program's own command line. */
	command: string[];
	/** Where the launch socket goes; the child's descriptor lands there too. */
	runDir: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** How long the child gets to take up the connection. Default 30 s. */
	attachWaitMs?: number;
	/** Where the child's lines are written through, so the person still sees the program; null for nowhere. */
	stdout?: NodeJS.WritableStream | null;
	stderr?: NodeJS.WritableStream | null;
	/** Lines per second per stream kept in the transcript; past it they are counted (5.7). Default 200. */
	linesPerSecond?: number;
	/** The event subscription asked of the child on attach (the program's default filter otherwise). */
	subscribe?: SubscriptionFilter;
	now?: () => number;
}

export const DEFAULT_LAUNCH_WAIT_MS = 30_000;
export const DEFAULT_LINES_PER_SECOND = 200;
/** After the graceful window, how long the child gets after the first signal before the last. */
export const FORCE_GRACE_MS = 2000;
const CONNECT_RETRY_MS = 20;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Nothing listens at the path yet: the child has not opened its endpoint. Anything else is a failure to report. */
function notListeningYet(error: unknown): boolean {
	const code = (error as { code?: unknown })?.code;
	return code === "ENOENT" || code === "ECONNREFUSED";
}

/** Split a pipe into lines and hand each on; a trailing fragment at the end is a line too. */
function readLines(stream: Readable, onLine: (line: string) => void): void {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		buffer += chunk;
		let at = buffer.indexOf("\n");
		while (at >= 0) {
			onLine(buffer.slice(0, at).replace(/\r$/, ""));
			buffer = buffer.slice(at + 1);
			at = buffer.indexOf("\n");
		}
	});
	stream.on("end", () => {
		if (buffer !== "") onLine(buffer);
	});
}

export class LaunchedProgram implements Launcher {
	/** Start the program and take it up; resolves once it is attached, or once the wait says it will not be. */
	static async start(harness: Harness, options: LaunchOptions): Promise<LaunchedProgram> {
		const launched = new LaunchedProgram(harness, options);
		await launched.startChild();
		return launched;
	}

	private readonly harness: Harness;
	private readonly options: LaunchOptions;
	private readonly now: () => number;
	private child: ChildProcess | undefined;
	private starts = 0;
	private last: { code: number | null; signal: string | null } | undefined;
	private exitWaiters: Array<() => void> = [];
	/** The current child is held by SIGSTOP (os pause); a stop lets it go first, or it could never exit. */
	private osPaused = false;
	/** The launcher's own signals ended the last child, so its exit is not the program's own verdict. */
	private endedByLauncher = false;
	/** A stop in progress; a second caller joins it rather than signalling twice. */
	private stopping: Promise<string> | undefined;
	/** The last attach's outcome, in words, for the agent and the person. */
	lastNote = "";

	private constructor(harness: Harness, options: LaunchOptions) {
		this.harness = harness;
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	get running(): boolean {
		return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
	}

	get pid(): number | undefined {
		return this.running ? this.child?.pid : undefined;
	}

	state(): LaunchState {
		return {
			running: this.running,
			...(this.pid === undefined ? {} : { pid: this.pid }),
			...(this.last === undefined ? {} : { exit: this.last }),
			starts: this.starts,
		};
	}

	/** Resolves when the current child has exited (at once when none is running). */
	exited(): Promise<void> {
		if (!this.running) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.exitWaiters.push(resolve);
		});
	}

	/**
	 * The code a session under this launcher ends with: the program's own
	 * when it exited by itself, 128 plus the signal's number when it died of
	 * one by itself, and 0 when the launcher ended it (the person's quit is
	 * not the program's failure).
	 */
	exitCode(): number {
		const exit = this.last;
		if (exit === undefined || this.endedByLauncher) return 0;
		if (exit.code !== null) return exit.code;
		const number = exit.signal === null ? undefined : osConstants.signals[exit.signal as NodeJS.Signals];
		return number === undefined ? 1 : 128 + number;
	}

	/**
	 * A path no other launcher can be using: this process, this start and a
	 * random part, so a dead launcher's child or a second terminal cannot be
	 * answering it; a short one when the run directory is too deep for a
	 * socket.
	 */
	private socketPathFor(start: number): string {
		const name = `launch-${process.pid}-${start}-${randomBytes(4).toString("hex")}.sock`;
		const preferred = join(ensureRunDir(this.options.runDir), name);
		if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
		const dir = dirname(shortSocketPath(process.pid));
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return join(dir, name);
	}

	// -----------------------------------------------------------------------
	// Starting and observing
	// -----------------------------------------------------------------------

	private async startChild(): Promise<void> {
		this.starts += 1;
		const socketPath = this.socketPathFor(this.starts);
		const [command, ...args] = this.options.command;
		if (command === undefined) throw new Error("run needs a program command");
		const child = spawn(command, args, {
			cwd: this.options.cwd,
			env: { ...process.env, ...(this.options.env ?? {}), [ENV_LAUNCH_SOCKET]: socketPath, [ENV_MODE]: "sidecar" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.child = child;
		this.osPaused = false;
		this.endedByLauncher = false;
		const spawnFailure = new Promise<string>((resolve) => {
			child.once("error", (error) => resolve(errorMessage(error)));
		});
		child.once("exit", (code, signal) => {
			this.last = { code, signal };
			this.osPaused = false;
			// the observation floor: the exit is the one event that always wakes the agent (5.6, 5.7)
			this.harness.observed("abai.lifecycle.exited", { pid: child.pid ?? null, code, signal }, true);
			for (const waiter of this.exitWaiters.splice(0)) waiter();
		});
		if (child.stdout) this.observe(child.stdout, "abai.io.stdout", this.options.stdout ?? null);
		if (child.stderr) this.observe(child.stderr, "abai.io.stderr", this.options.stderr ?? null);
		this.harness.ring.note(
			`# launched ${this.options.command.join(" ")} (pid ${child.pid ?? "?"}, start ${this.starts})`,
		);
		this.lastNote = await this.attach(socketPath, spawnFailure);
		this.harness.ring.note(`# ${this.lastNote}`);
	}

	/** A line a second is a transcript line; past the cap they are counted, so the pipe is always drained (5.7). */
	private observe(stream: Readable, name: string, through: NodeJS.WritableStream | null): void {
		const cap = this.options.linesPerSecond ?? DEFAULT_LINES_PER_SECOND;
		let second = 0;
		let seen = 0;
		let dropped = 0;
		let timer: NodeJS.Timeout | undefined;
		const flushDropped = (): void => {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			if (dropped > 0) this.harness.observed(name, { dropped });
			dropped = 0;
		};
		readLines(stream, (line) => {
			if (through) through.write(`${line}\n`);
			const now = Math.floor(this.now() / 1000);
			if (now !== second) {
				flushDropped();
				second = now;
				seen = 0;
			}
			seen += 1;
			if (seen > cap) {
				dropped += 1;
				// a burst that stops is still reported within the second, not held until the next line
				if (timer === undefined) timer = setTimeout(flushDropped, 1000).unref();
				return;
			}
			this.harness.observed(name, { line });
		});
		stream.once("end", flushDropped);
	}

	/** Connect to the launch socket as soon as it accepts; the child exiting first, or the wait running out, ends it. */
	private async attach(socketPath: string, spawnFailure: Promise<string>): Promise<string> {
		const waitMs = this.options.attachWaitMs ?? DEFAULT_LAUNCH_WAIT_MS;
		const deadline = this.now() + waitMs;
		let failed: string | undefined;
		void spawnFailure.then((message) => {
			failed = message;
		});
		while (this.now() < deadline) {
			if (failed !== undefined) return `the program could not be started: ${failed}`;
			if (!this.running) {
				const exit = this.last;
				return `the program exited (${exit?.code ?? exit?.signal ?? "?"}) before taking up the launch connection`;
			}
			let transport: SocketTransport;
			try {
				transport = await SocketTransport.connect(socketPath, {
					connectTimeoutMs: 2000,
					...(this.options.subscribe === undefined ? {} : { subscribe: this.options.subscribe }),
				});
			} catch (error) {
				// the child has not opened its endpoint yet: try again; anything else is the child's to answer for
				if (notListeningYet(error)) {
					await sleep(CONNECT_RETRY_MS);
					continue;
				}
				return `the launch socket could not be used (${errorMessage(error)}); observing the program from outside only`;
			}
			try {
				const hello = await this.harness.attach(transport);
				// a wrapper command (a shell, npm) puts the program a generation down: said, not refused
				const generation =
					hello.pid !== undefined && hello.pid !== this.child?.pid ? `, child pid ${this.child?.pid}` : "";
				return `attached to ${hello.name} (pid ${hello.pid ?? "?"}${generation}) as ${hello.connection}; claims: ${
					this.harness.currentClaims().join(", ") || "none"
				}`;
			} catch (error) {
				transport.close("the attach failed");
				return `connected to the launch socket, but the attach failed (${errorMessage(error)}); observing the program from outside only`;
			}
		}
		return `the program did not take up the launch connection within ${waitMs} ms; observing it from outside only`;
	}

	// -----------------------------------------------------------------------
	// The lifecycle channel, launch form (5.5)
	// -----------------------------------------------------------------------

	async lifecycle(op: string, reason: string, consent?: Consent): Promise<unknown> {
		const declared = this.harness.manifest?.lifecycle;
		// the manifest's policy binds the launcher's own steps too: a forbidden stop never reaches the signals,
		// and a restart is a stop first, so it is forbidden with it
		const forbidden = (what: "pause" | "resume" | "stop" | "restart"): boolean =>
			declared?.policy?.[what] === "forbid";
		if (op === "pause" || op === "resume" || op === "stop" || op === "restart") {
			if (forbidden(op)) throw new Error(`the program's policy forbids lifecycle ${op}`);
			if (op === "restart" && forbidden("stop"))
				throw new Error("the program's policy forbids lifecycle stop, so restart too");
		}
		switch (op) {
			case "status":
				return {
					launch: this.state(),
					program: await this.programStatus(reason),
				};
			case "pause":
			case "resume": {
				if (!this.running) throw new Error("the program is not running");
				if (declared?.pause === "cooperative") return this.harness.transportLifecycle(op, reason, consent);
				if (declared?.pause === "os") {
					this.child?.kill(op === "pause" ? "SIGSTOP" : "SIGCONT");
					this.osPaused = op === "pause";
					this.harness.ring.note(`# launcher: ${op} (os) ${reason}`);
					return `${op}d (os)`;
				}
				throw new Error("the program declares no pause");
			}
			case "stop":
				return this.stop(reason, consent);
			case "start":
				if (this.running) throw new Error(`the program is running (pid ${this.pid}); stop or restart it`);
				await this.startChild();
				return this.lastNote;
			case "restart": {
				const stopped = this.running ? await this.stop(reason, consent) : "the program was not running";
				await this.startChild();
				return `${stopped}; ${this.lastNote}`;
			}
			default:
				throw new Error(`unknown lifecycle operation ${op}`);
		}
	}

	/**
	 * Graceful first: the program's stop handler through the wire when it
	 * declares one, then its graceful window; then the launcher ends the
	 * child, in two steps, and reports how it went.
	 */
	/** The program's own status; a program speaking no lifecycle extension is said so, not an error for the whole. */
	private async programStatus(reason: string): Promise<unknown> {
		if (!this.harness.attached) return null;
		try {
			return await this.harness.transportLifecycle("status", reason);
		} catch (error) {
			return { unavailable: errorMessage(error) };
		}
	}

	private stop(reason: string, consent?: Consent): Promise<string> {
		if (this.stopping === undefined) {
			this.stopping = this.stopSteps(reason, consent).finally(() => {
				this.stopping = undefined;
			});
		}
		return this.stopping;
	}

	private async stopSteps(reason: string, consent?: Consent): Promise<string> {
		if (!this.running || !this.child) return "the program is not running";
		const child = this.child;
		const declared = this.harness.manifest?.lifecycle?.stop;
		const steps: string[] = [];
		// a child held by SIGSTOP can run neither its handler nor its signal handlers: it goes on first
		if (this.osPaused) {
			child.kill("SIGCONT");
			this.osPaused = false;
			steps.push("resumed first");
		}
		if (declared && this.harness.attached) {
			try {
				await this.harness.transportLifecycle("stop", reason, consent);
				steps.push("stop handler requested");
				await this.waitExit(durationMs(declared.graceful));
			} catch (error) {
				// the program refused on policy or consent: that is the answer, and no signal follows it
				if (error instanceof TransportCallError && (error.code === "forbidden" || error.code === "denied")) {
					this.harness.ring.note(`# launcher: stop refused by the program: ${error.message}; ${reason}`);
					return `not stopped: the program refused (${error.message})`;
				}
				steps.push(`stop handler not requested (${errorMessage(error)})`);
			}
		}
		if (this.running) {
			this.endedByLauncher = true;
			child.kill("SIGTERM");
			steps.push("ended after the graceful window");
			await this.waitExit(FORCE_GRACE_MS);
		}
		if (this.running) {
			child.kill("SIGKILL");
			steps.push("forced");
			await this.waitExit(FORCE_GRACE_MS);
		}
		const exit = this.last;
		const how = exit ? `exited ${exit.code ?? exit.signal ?? "?"}` : "still running";
		this.harness.ring.note(`# launcher: stop (${steps.join(", ")}): ${how}; ${reason}`);
		return `stopped: ${steps.join(", ")}; ${how}`;
	}

	private waitExit(ms: number): Promise<void> {
		if (!this.running) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			this.exitWaiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	/** The launcher is going: a running child is stopped the graceful way first. */
	async shutdown(reason: string): Promise<void> {
		if (this.running) await this.stop(reason, "auto");
	}
}
