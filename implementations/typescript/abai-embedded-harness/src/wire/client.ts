// The wire client: connects to a program's endpoint by socket path, pid or
// (when exactly one runs) automatically, reads the hello, streams the
// server's messages to typed listeners, correlates requests with responses
// and answers claimed hooks through a handler.
import { createConnection, type Socket } from "node:net";
import {
	attachCappedLineReader,
	DEFAULT_MAX_LINE_BYTES,
	type EventMessage,
	type HelloMessage,
	type HookClaimsReleasedMessage,
	type HookMessage,
	type HookRejectedMessage,
	type HookTimeoutMessage,
	type LooseSnapshotMessage,
	PROTOCOL_VERSION,
	pruneDescriptors,
	type SerializeErrorMessage,
	type ServerMessage,
	type SubscriptionFilter,
	type TouchpointEndMessage,
	type TouchpointMessage,
	type TurnEndMessage,
	type TurnMessage,
	type WireCommand,
	type WireConsent,
	type WireDescriptor,
	type WireResponse,
} from "@abaigram/abai-stub";

/** A socket path, a pid, or undefined for "the one running program". */
export type ConnectTarget = string | number | undefined;

export interface ConnectOptions {
	/** Where descriptors are read from for pid and auto targets. */
	runDir?: string;
	/** One deadline for the connect and the hello line. Default 5000. */
	timeoutMs?: number;
	/** A reply line above this many bytes ends the connection. Default 64 MiB. */
	maxLineBytes?: number;
}

export interface ResolvedTarget {
	socketPath: string;
	/** Known when the target came from a descriptor; the hello must confirm it. */
	pid?: number;
}

export interface RequestOptions {
	/** Reject when no response arrives in time. Default: wait. */
	timeoutMs?: number;
	/** The request id to use. */
	id?: string;
	/** The agent's stated reason for an act of control; the host writes it to its audit log. */
	reason?: string;
	/** Consent stated for a `confirm` act (the `consent` extension; a v1-core host ignores it). */
	consent?: WireConsent;
}

const REASON: unique symbol = Symbol("reason");

/** A hook answer with the agent's stated reason attached (see `withReason`). */
export interface ReasonedResult<T = unknown> {
	[REASON]: string;
	result: T;
	consent?: WireConsent;
}

/**
 * Wrap a hook handler's result with the reason for it, and the consent
 * stated for a `confirm` decision. The client sends the result as the answer
 * and the rest on the `hook_response` envelope, where the host writes it to
 * its audit log (abaigrammar section 10).
 */
export function withReason<T>(result: T, reason: string, consent?: WireConsent): ReasonedResult<T> {
	return consent === undefined ? { [REASON]: reason, result } : { [REASON]: reason, result, consent };
}

function isReasoned(value: unknown): value is ReasonedResult {
	return typeof value === "object" && value !== null && REASON in value && typeof value[REASON] === "string";
}

export interface ClaimOptions {
	/** How long the host may wait for each claimed hook's answer (never past the manifest's timeout). */
	timeoutMs?: number;
	/** Reject when the claim's own response does not arrive in time. Default: wait. */
	requestTimeoutMs?: number;
	/**
	 * The result sent when the handler returns `null` or `undefined`, throws,
	 * or returns a result that cannot be serialized: the caller supplies the
	 * decision's manifest default.
	 */
	fallback: (hook: HookMessage) => unknown;
}

/** Returns the hook's result; `null` or `undefined` sends the fallback. */
export type HookHandler = (hook: HookMessage) => unknown | Promise<unknown>;

export interface ClientEvents {
	event: EventMessage;
	snapshot: LooseSnapshotMessage;
	serialize_error: SerializeErrorMessage;
	hook_timeout: HookTimeoutMessage;
	hook_rejected: HookRejectedMessage;
	hook_claims_released: HookClaimsReleasedMessage;
	/** The `turns` extension: the program gives the harness a turn, or opens a touchpoint. */
	turn: TurnMessage;
	touchpoint: TouchpointMessage;
	/** Every message after hello, with the line it came on. */
	message: { message: ServerMessage; line: string };
	/** The connection ended; with the error that ended it, if any. */
	close: Error | undefined;
	/** A recoverable problem: a malformed line, a hook handler that threw. */
	error: Error;
}

type Listener<K extends keyof ClientEvents> = (payload: ClientEvents[K]) => void;

interface PendingRequest {
	resolve: (response: WireResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout | undefined;
}

interface HookRegistration {
	handler: HookHandler;
	fallback: (hook: HookMessage) => unknown;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
/**
 * Lines held between hello and `release()`. A program at a touchpoint speaks
 * the moment the connection opens, often in hello's own chunk, before the
 * consumer that would hear it exists. Past the cap only events are dropped:
 * a turn, a touchpoint or a hook's fate is never.
 */
const HELD_LINES = 500;
const DROPPABLE_WHEN_HELD = new Set(["event", "snapshot", "serialize_error"]);

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * Turn a target into a socket path. A string that looks like a path is used
 * as is; a pid selects that program's descriptor in `runDir`; nothing selects
 * the single running program. Descriptors of dead processes are pruned on the way.
 */
export function resolveTarget(target: ConnectTarget, runDir?: string): ResolvedTarget {
	if (typeof target === "string" && (target.includes("/") || target.endsWith(".sock"))) {
		return { socketPath: target };
	}
	let pid: number | undefined;
	if (typeof target === "number") {
		pid = target;
	} else if (typeof target === "string" && /^\d+$/.test(target)) {
		pid = Number(target);
	} else if (target !== undefined) {
		throw new Error(`target must be a socket path or a pid: ${String(target)}`);
	}
	if (runDir === undefined) throw new Error("a pid or automatic target needs a run directory");
	const programs = pruneDescriptors(runDir);
	if (pid !== undefined) {
		const found = programs.find((program) => program.pid === pid);
		if (!found) throw new Error(`no program with pid ${pid}`);
		return { socketPath: found.socket, pid };
	}
	if (programs.length === 0) throw new Error("no program is running");
	if (programs.length > 1) {
		const pids = programs.map((program) => program.pid).join(", ");
		throw new Error(`several programs are running: pids ${pids}; pass a pid or socket path`);
	}
	return { socketPath: programs[0].socket, pid: programs[0].pid };
}

export class WireClient {
	/** Live descriptors; dead ones are removed. */
	static listPrograms(runDir: string): WireDescriptor[] {
		return pruneDescriptors(runDir);
	}

	static async connect(target?: ConnectTarget, options: ConnectOptions = {}): Promise<WireClient> {
		const resolved = resolveTarget(target, options.runDir);
		const socket = createConnection(resolved.socketPath);
		const client = new WireClient(socket, resolved, options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES);
		await client.awaitHello(options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
		return client;
	}

	readonly target: ResolvedTarget;
	private readonly socket: Socket;
	private readonly listeners = new Map<keyof ClientEvents, Set<(payload: never) => void>>();
	private readonly pending = new Map<string, PendingRequest>();
	private readonly hookHandlers = new Map<string, HookRegistration>();
	/** Hooks whose handler is still running; a `hook_timeout` marks one expired so its late answer is not written. */
	private readonly inFlight = new Map<string, { hook: string; expired: boolean }>();
	private readonly detachReader: () => void;
	/** Lines after hello that nobody is listening for yet; undefined once released. */
	private held: string[] | undefined = [];
	/** Events dropped from the hold past its cap, reported once at release. */
	private heldDropped = 0;
	private _hello: HelloMessage | undefined;
	private _helloLine = "";
	private helloWaiter: { resolve: () => void; reject: (error: Error) => void } | undefined;
	private closed = false;
	private closeError: Error | undefined;
	private nextId = 1;

	private constructor(socket: Socket, target: ResolvedTarget, maxLineBytes: number) {
		this.socket = socket;
		this.target = target;
		socket.setNoDelay?.(true);
		this.detachReader = attachCappedLineReader(
			socket,
			maxLineBytes,
			(line) => this.onLine(line),
			() => this.fail(new Error(`a line from the program exceeded ${maxLineBytes} bytes`)),
		);
		socket.on("error", (error) => this.onSocketError(error));
		socket.on("close", () => this.onSocketClose());
	}

	/** The hello message; set before `connect` resolves. */
	get hello(): HelloMessage {
		if (!this._hello) throw new Error("not connected");
		return this._hello;
	}

	/** The hello line as received (for raw output). */
	get helloLine(): string {
		return this._helloLine;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	on<K extends keyof ClientEvents>(type: K, listener: Listener<K>): () => void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener as (payload: never) => void);
		return () => {
			set?.delete(listener as (payload: never) => void);
		};
	}

	/** Send a command; resolves with its response. */
	request(command: WireCommand, options: RequestOptions = {}): Promise<WireResponse> {
		if (this.closed) return Promise.reject(this.closeError ?? new Error("connection closed"));
		const id = options.id ?? `c${this.nextId++}`;
		let line: string;
		try {
			line = serializeJsonLine({
				type: "request",
				id,
				command,
				...(options.reason === undefined ? {} : { reason: options.reason }),
				...(options.consent === undefined ? {} : { consent: options.consent }),
			});
		} catch (error) {
			return Promise.reject(new Error(`command could not be serialized: ${errorMessage(error)}`));
		}
		return new Promise((resolve, reject) => {
			const entry: PendingRequest = { resolve, reject, timer: undefined };
			if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
				entry.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`request ${String(command.type)} timed out after ${options.timeoutMs} ms`));
				}, options.timeoutMs);
			}
			this.pending.set(id, entry);
			this.socket.write(line);
		});
	}

	subscribe(filter: SubscriptionFilter): Promise<WireResponse> {
		return this.request({ type: "subscribe", ...filter });
	}

	/**
	 * Claim hooks and answer them with `handler`. The handler's return value
	 * is the hook's result; `undefined` or `null` sends `options.fallback`'s
	 * result, and so does a throw, with the reason "handler failed: <message>".
	 * Handlers run concurrently: several hooks can be pending at once.
	 */
	async claimHooks(hooks: string[], handler: HookHandler, options: ClaimOptions): Promise<WireResponse> {
		// registered before the request: a hook can follow the response in the same
		// chunk; a failed claim changes nothing on the host, so the previous
		// registrations come back
		const previous = new Map(hooks.map((hook) => [hook, this.hookHandlers.get(hook)] as const));
		for (const hook of hooks) this.hookHandlers.set(hook, { handler, fallback: options.fallback });
		const restore = () => {
			for (const [hook, registration] of previous) {
				if (registration) this.hookHandlers.set(hook, registration);
				else this.hookHandlers.delete(hook);
			}
		};
		let response: WireResponse;
		try {
			response = await this.request(
				{
					type: "claim_hooks",
					hooks,
					...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
				},
				{ timeoutMs: options.requestTimeoutMs },
			);
		} catch (error) {
			restore();
			throw error;
		}
		if (!response.success) restore();
		return response;
	}

	async releaseHooks(hooks?: string[], options: { timeoutMs?: number } = {}): Promise<WireResponse> {
		const response = await this.request(
			{ type: "release_hooks", ...(hooks === undefined ? {} : { hooks }) },
			{ timeoutMs: options.timeoutMs },
		);
		if (response.success) {
			const released = (response.data as { released?: string[] } | undefined)?.released ?? [];
			for (const hook of released) this.hookHandlers.delete(hook);
			this.expire(released);
		}
		return response;
	}

	/** Hooks of these names still being handled will not be answered: the host no longer waits for them. */
	private expire(hooks: string[]): void {
		for (const running of this.inFlight.values()) {
			if (hooks.includes(running.hook)) running.expired = true;
		}
	}

	/**
	 * The consumer is wired: deliver what arrived after hello, in order, and
	 * stop holding. Responses and hooks were never held, since a request's
	 * caller and a claim's handler are consumers of their own.
	 */
	release(): void {
		const held = this.held;
		if (held === undefined) return;
		this.held = undefined;
		for (const line of held) this.onLine(line);
		if (this.heldDropped > 0) {
			this.emit(
				"error",
				new Error(`${this.heldDropped} events arrived before the consumer was wired and were dropped`),
			);
			this.heldDropped = 0;
		}
	}

	/** Send one message that expects no response (`turn_end`, `touchpoint_end`). */
	send(message: TurnEndMessage | TouchpointEndMessage): void {
		if (this.closed) return;
		this.socket.write(serializeJsonLine(message));
	}

	/** Stop reading (a caller does this while its output is backed up). */
	pause(): void {
		this.socket.pause();
	}

	resume(): void {
		this.socket.resume();
	}

	close(): void {
		if (this.closed) return;
		this.socket.end();
		this.socket.destroy();
	}

	// -----------------------------------------------------------------------

	private awaitHello(timeoutMs: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.helloWaiter = undefined;
				this.fail(new Error(`timed out connecting to ${this.target.socketPath}`));
				reject(this.closeError ?? new Error("timed out"));
			}, timeoutMs);
			this.helloWaiter = {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			};
		});
	}

	private onLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch (error) {
			this.malformed(line, `malformed line from the program: ${errorMessage(error)}`);
			return;
		}
		if (!isRecord(message) || typeof message.type !== "string") {
			this.malformed(line, "message without a type from the program");
			return;
		}
		const server = message as unknown as ServerMessage;
		if (!this._hello) {
			this.onHelloCandidate(server, line);
			return;
		}
		// a response belongs to a request this caller made and a hook to its handler, so neither is ever held
		if (this.held !== undefined && server.type !== "response" && server.type !== "hook") {
			if (this.held.length < HELD_LINES || !DROPPABLE_WHEN_HELD.has(server.type)) this.held.push(line);
			else this.heldDropped += 1;
			return;
		}
		this.emit("message", { message: server, line });
		switch (server.type) {
			case "response": {
				const entry = server.id === undefined ? undefined : this.pending.get(server.id);
				if (!entry) return;
				this.pending.delete(server.id as string);
				if (entry.timer !== undefined) clearTimeout(entry.timer);
				entry.resolve(server);
				return;
			}
			case "hook":
				void this.dispatchHook(server);
				return;
			case "hook_timeout": {
				const running = this.inFlight.get(server.id);
				if (running) running.expired = true;
				this.emit(server.type, server);
				return;
			}
			case "hook_claims_released":
				// the host settled those hooks' pending asks as released; a late answer would be ignored
				this.expire(server.hooks);
				this.emit(server.type, server);
				return;
			case "event":
			case "snapshot":
			case "serialize_error":
			case "hook_rejected":
			case "turn":
			case "touchpoint":
				this.emit(server.type, server as never);
				return;
			default:
				return;
		}
	}

	private onHelloCandidate(message: ServerMessage, line: string): void {
		const record = message as unknown as Record<string, unknown>;
		let error: Error | undefined;
		if (message.type !== "hello") {
			error = new Error(`not a wire endpoint: ${this.target.socketPath}`);
		} else if (record.protocol !== PROTOCOL_VERSION) {
			error = new Error(`wire protocol ${String(record.protocol)} is not the expected ${PROTOCOL_VERSION}`);
		} else if (this.target.pid !== undefined && record.pid !== this.target.pid) {
			error = new Error(
				`socket ${this.target.socketPath} is served by pid ${String(record.pid)}, not ${this.target.pid}`,
			);
		}
		if (error) {
			this.fail(error);
			return;
		}
		this._hello = message as HelloMessage;
		this._helloLine = line;
		const waiter = this.helloWaiter;
		this.helloWaiter = undefined;
		waiter?.resolve();
	}

	private malformed(line: string, description: string): void {
		if (!this._hello) {
			this.fail(new Error(`not a wire endpoint: ${this.target.socketPath} (${description})`));
			return;
		}
		this.emit("error", new Error(`${description}: ${line.slice(0, 200)}`));
	}

	private async dispatchHook(message: HookMessage): Promise<void> {
		const registration = this.hookHandlers.get(message.hook);
		if (!registration) {
			// no fallback is known for a hook nobody claimed here; the host's own
			// timeout applies its default
			this.emit("error", new Error(`hook ${message.hook} arrived without a handler; not answered`));
			return;
		}
		let result: unknown;
		let reason: string | undefined;
		let consent: WireConsent | undefined;
		const running = { hook: message.hook, expired: false };
		this.inFlight.set(message.id, running);
		try {
			result = await registration.handler(message);
		} catch (error) {
			this.emit("error", new Error(`hook handler for ${message.hook} failed: ${errorMessage(error)}`));
			result = undefined;
			reason = `handler failed: ${errorMessage(error)}`;
		} finally {
			this.inFlight.delete(message.id);
		}
		// the host already applied the default: a late answer would be ignored there, so none is written
		if (running.expired || this.closed || this.socket.destroyed) return;
		// a handler may state its reason with `withReason`; it goes to the host's audit log
		if (isReasoned(result)) {
			reason = result[REASON];
			consent = result.consent;
			result = result.result;
		}
		const fallback = () => {
			try {
				return registration.fallback(message);
			} catch (error) {
				this.emit("error", new Error(`hook fallback for ${message.hook} failed: ${errorMessage(error)}`));
				return null;
			}
		};
		if (result === undefined || result === null) result = fallback();
		if (this.closed) return;
		const envelope = {
			...(reason === undefined ? {} : { reason }),
			...(consent === undefined ? {} : { consent }),
		};
		let line: string;
		try {
			line = serializeJsonLine({ type: "hook_response", id: message.id, result, ...envelope });
		} catch (error) {
			this.emit(
				"error",
				new Error(`hook result for ${message.hook} could not be serialized: ${errorMessage(error)}`),
			);
			line = serializeJsonLine({ type: "hook_response", id: message.id, result: fallback(), ...envelope });
		}
		this.socket.write(line);
	}

	/** End the connection with an error; `close` reports it. */
	private fail(error: Error): void {
		if (this.closed || this.closeError) return;
		this.closeError = error;
		this.socket.destroy();
	}

	private onSocketError(error: NodeJS.ErrnoException): void {
		if (this.closeError) return;
		if (!this._hello && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
			// the code stays on the friendlier error: a launcher polling its child's socket tells this failure from the rest
			this.closeError = Object.assign(
				new Error(`nothing is listening at ${this.target.socketPath} (stale descriptor?)`),
				{ code: error.code },
			);
			return;
		}
		this.closeError = error;
	}

	private onSocketClose(): void {
		if (this.closed) return;
		this.closed = true;
		this.detachReader();
		if (!this._hello) {
			const error =
				this.closeError ?? new Error(`the program at ${this.target.socketPath} closed the connection before hello`);
			this.closeError = error;
			const waiter = this.helloWaiter;
			this.helloWaiter = undefined;
			waiter?.reject(error);
		}
		const closeError = this.closeError ?? new Error("connection closed");
		for (const [id, entry] of this.pending) {
			this.pending.delete(id);
			if (entry.timer !== undefined) clearTimeout(entry.timer);
			entry.reject(closeError);
		}
		this.emit("close", this.closeError);
	}

	private emit<K extends keyof ClientEvents>(type: K, payload: ClientEvents[K]): void {
		const set = this.listeners.get(type);
		if (!set) return;
		for (const listener of [...set]) {
			try {
				(listener as Listener<K>)(payload);
			} catch {
				// a listener's throw must not take the reader down
			}
		}
	}
}
