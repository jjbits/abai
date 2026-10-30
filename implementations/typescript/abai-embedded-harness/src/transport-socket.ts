// The socket transport (abaigrammar section 6.3): the harness in its own
// process, driving a program's wire endpoint over wire protocol v1. The v1
// core is what arx-06's supervisor speaks, so a running arx-06 is a target
// as it is. What the core lacks (turns, touchpoints, knob outcomes, consent)
// is an extension a stub advertises in hello.abai.extensions, and this
// transport speaks an extension only when it is advertised. Events are
// pushed by the program after hello; `events()` has nothing to page. Every
// library request is bounded: a stalled program never hangs the harness.
import type {
	Consent,
	Extension,
	HookMessage,
	Manifest,
	SubscriptionFilter,
	WireErrorCode,
	WireResponse,
} from "@abaigram/abai-stub";
import { ATTACH_REQUEST_TIMEOUT_MS, POLL_REQUEST_TIMEOUT_MS } from "./scheduler.ts";
import type {
	AuditData,
	StubTransport,
	TransportCells,
	TransportContent,
	TransportEvents,
	TransportHello,
	TransportKnobOutcome,
	TransportListeners,
} from "./transport.ts";
import { TransportCallError } from "./transport.ts";
import { type ConnectTarget, type ReasonedResult, WireClient, withReason } from "./wire/client.ts";

export interface SocketTransportOptions {
	/** Where descriptors are read from for a pid or automatic target. */
	runDir?: string;
	/** One deadline for the connect and the hello. Default 5 s. */
	connectTimeoutMs?: number;
	/** Sent after hello; absent keeps the program's default event filter. */
	subscribe?: SubscriptionFilter;
	/** One bound for every library request, in place of the attach (10 s) and poll (5 s) defaults; tests. */
	requestTimeoutMs?: number;
}

/** Commands the library owns; a capability cannot be named like one. */
const LIBRARY_COMMANDS = new Set([
	"ping",
	"subscribe",
	"claim_hooks",
	"release_hooks",
	"get_manifest",
	"get_content",
	"get_audit",
	"get_cells",
	"set_cell",
]);

/** How many answered decision ids are remembered, to tell a rejected answer from a decision never asked. */
const ANSWERED_MEMORY = 256;
/**
 * Notifications held until the harness core says it is listening (`start`).
 * The core registers its listeners only after the manifest, the content and
 * the claim have crossed, and a program at a touchpoint speaks before that.
 * Past the cap only events are dropped.
 */
const EARLY_CAP = 500;

const ERROR_CODES: ReadonlySet<string> = new Set(["unknown", "forbidden", "denied", "invalid", "timeout", "error"]);

function isErrorCode(value: unknown): value is WireErrorCode {
	return typeof value === "string" && ERROR_CODES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The code a failed capability request maps to. Only the host's two fixed
 * phrasings are read; anything else is the capability's own error, whose
 * words are kept. The `call_codes` extension (M6) makes this explicit.
 */
function callCode(error: string): TransportCallError["code"] {
	if (/^policy forbids\b/i.test(error)) return "forbidden";
	if (/^unknown command\b/i.test(error)) return "unknown";
	return "error";
}

/** A client rejection as a transport error: a timeout, a closed connection, or a request that could not be sent. */
function requestFailure(what: string, error: unknown, closed: boolean): TransportCallError {
	const message = errorMessage(error);
	if (/timed out/.test(message)) return new TransportCallError("timeout", `${what}: ${message}`);
	if (closed) return new TransportCallError("detached", `${what}: ${message}`);
	return new TransportCallError("error", `${what}: ${message}`);
}

export class SocketTransport implements StubTransport {
	/** Connect to a program's endpoint and read its hello. Refuses this very process. */
	static async connect(target: ConnectTarget, options: SocketTransportOptions = {}): Promise<SocketTransport> {
		const client = await WireClient.connect(target, { runDir: options.runDir, timeoutMs: options.connectTimeoutMs });
		try {
			if (client.hello.pid === process.pid) {
				throw new Error("the target is this process: a harness cannot attach to itself");
			}
			const transport = new SocketTransport(client, options.requestTimeoutMs);
			if (options.subscribe) {
				const response = await client.subscribe(options.subscribe);
				if (!response.success) throw new Error(`the program refused the subscription: ${response.error}`);
			}
			return transport;
		} catch (error) {
			client.close();
			throw error;
		}
	}

	readonly hello: TransportHello;
	readonly denseSeq = false;
	readonly client: WireClient;
	/** The last recoverable problem the client reported (a malformed line, a handler failure). */
	lastProblem: string | undefined;
	private readonly attachTimeoutMs: number;
	private readonly pollTimeoutMs: number;
	private readonly listeners: { [K in keyof TransportListeners]: Set<TransportListeners[K]> } = {
		event: new Set(),
		decision: new Set(),
		decision_timeout: new Set(),
		decision_rejected: new Set(),
		turn: new Set(),
		touchpoint: new Set(),
		claims_released: new Set(),
		close: new Set(),
	};
	/** Decisions the program asked and the harness has not answered: resolving one sends the hook response. */
	private readonly asked = new Map<string, { name: string; resolve: (answer: ReasonedResult | null) => void }>();
	/** Recently answered decision ids, so a rejection can be told from a decision that was never asked. */
	private readonly answered: string[] = [];
	private _manifest: Manifest | undefined;
	private lastSeq = 0;
	private _open = true;
	private started = false;
	/** Notifications that arrived before `start()`, as thunks, in order. */
	private early: Array<{ type: keyof TransportListeners; deliver: () => void }> = [];
	private earlyDropped = 0;

	private constructor(client: WireClient, requestTimeoutMs: number | undefined) {
		this.client = client;
		this.attachTimeoutMs = requestTimeoutMs ?? ATTACH_REQUEST_TIMEOUT_MS;
		this.pollTimeoutMs = requestTimeoutMs ?? POLL_REQUEST_TIMEOUT_MS;
		const hello = client.hello as unknown as Record<string, unknown>;
		const abai = isRecord(hello.abai) ? hello.abai : undefined;
		if (!abai || typeof abai.name !== "string" || typeof abai.abaigrammar !== "string") {
			throw new Error(`not an abai endpoint: hello carries no abai identity (${client.target.socketPath})`);
		}
		this.lastSeq = typeof hello.lastSeq === "number" ? hello.lastSeq : 0;
		const capabilities = isRecord(hello.capabilities) ? hello.capabilities : undefined;
		const claimable = strings(capabilities?.hooks);
		this.hello = {
			name: abai.name,
			abaigrammar: abai.abaigrammar,
			modes: strings(abai.modes) ?? [],
			pid: typeof hello.pid === "number" ? hello.pid : undefined,
			cwd: typeof hello.cwd === "string" ? hello.cwd : undefined,
			connection: typeof hello.connection === "string" ? hello.connection : "?",
			extensions: strings(abai.extensions) ?? [],
			...(claimable === undefined ? {} : { claimable }),
		};
		client.on("event", (message) => {
			const { type, ...payload } = message.event;
			if (message.seq > this.lastSeq) this.lastSeq = message.seq;
			this.notify("event", {
				seq: message.seq,
				name: type,
				payload,
				truncated: message.truncated === true,
				ts: message.ts,
			});
		});
		client.on("turn", (message) => {
			this.notify("turn", {
				id: message.id,
				name: message.name,
				deadline: Date.now() + message.timeoutMs,
				content: message.content,
			});
		});
		client.on("touchpoint", (message) => {
			this.notify("touchpoint", { id: message.id, kind: message.kind, content: message.content });
		});
		client.on("snapshot", (message) => {
			// a host's own state message (arx-06 sends one per session start): a transcript line, nothing more
			const { type, seq, ts, ...rest } = message;
			void type;
			// seq is host-wide: a snapshot and a serialize error count like events
			const at = typeof seq === "number" ? seq : this.lastSeq;
			if (at > this.lastSeq) this.lastSeq = at;
			this.notify("event", {
				seq: at,
				name: "snapshot",
				payload: rest,
				truncated: false,
				ts: typeof ts === "number" ? ts : Date.now(),
			});
		});
		client.on("serialize_error", (message) => {
			if (message.seq > this.lastSeq) this.lastSeq = message.seq;
			this.notify("event", {
				seq: message.seq,
				name: "serialize_error",
				payload: { event: message.eventType, error: message.error },
				truncated: true,
				ts: message.ts,
			});
		});
		client.on("hook_timeout", (message) => {
			const entry = this.asked.get(message.id);
			this.asked.delete(message.id);
			entry?.resolve(null);
			this.notify("decision_timeout", message.id, message.hook);
		});
		client.on("hook_rejected", (message) => {
			const entry = this.asked.get(message.id);
			this.asked.delete(message.id);
			entry?.resolve(null);
			// an id never seen here was rejected before it was asked (its context could not be serialized)
			const known = entry !== undefined || this.answered.includes(message.id);
			const error = known ? message.error : `never asked: ${message.error}`;
			this.notify("decision_rejected", message.id, message.hook, error);
		});
		client.on("hook_claims_released", (message) => {
			for (const [id, entry] of [...this.asked]) {
				if (!message.hooks.includes(entry.name)) continue;
				this.asked.delete(id);
				entry.resolve(null);
			}
			this.notify("claims_released", message.hooks, message.reason);
		});
		client.on("error", (error) => {
			this.lastProblem = error.message;
		});
		client.on("close", (error) => {
			if (!this._open) return;
			this._open = false;
			for (const [, entry] of this.asked) entry.resolve(null);
			this.asked.clear();
			this.notify("close", error?.message);
		});
		// every listener is in place: what the program said in hello's own chunk is delivered now
		client.release();
	}

	get open(): boolean {
		return this._open && !this.client.isClosed;
	}

	/** Whether the program advertised an extension; the transport speaks one only when it did. */
	speaks(extension: Extension): boolean {
		return this.hello.extensions.includes(extension);
	}

	/** The harness core is listening: deliver what was held, in order, then deliver live. */
	start(): void {
		if (this.started) return;
		this.started = true;
		for (const { deliver } of this.early.splice(0)) deliver();
		if (this.earlyDropped > 0) {
			this.lastProblem = `${this.earlyDropped} events arrived before the harness was listening and were dropped`;
			this.earlyDropped = 0;
		}
	}

	private notify<K extends keyof TransportListeners>(type: K, ...args: Parameters<TransportListeners[K]>): void {
		if (!this.started) {
			if (this.early.length < EARLY_CAP || type !== "event") {
				this.early.push({ type, deliver: () => this.deliver(type, ...args) });
			} else this.earlyDropped += 1;
			return;
		}
		this.deliver(type, ...args);
	}

	private deliver<K extends keyof TransportListeners>(type: K, ...args: Parameters<TransportListeners[K]>): void {
		for (const listener of this.listeners[type]) {
			try {
				(listener as (...a: Parameters<TransportListeners[K]>) => void)(...args);
			} catch {
				// a harness listener's failure stays with the harness
			}
		}
	}

	private assertOpen(): void {
		if (!this.open) throw new TransportCallError("detached", "not connected to a program");
	}

	/** A library request that must succeed within `timeoutMs`; its failure is an error with the host's words. */
	private async must(
		command: Parameters<WireClient["request"]>[0],
		what: string,
		timeoutMs: number,
		consent?: Consent,
	): Promise<unknown> {
		this.assertOpen();
		let response: WireResponse;
		try {
			response = await this.client.request(command, { timeoutMs, consent });
		} catch (error) {
			throw requestFailure(what, error, this.client.isClosed);
		}
		if (!response.success) throw new Error(`${what}: ${response.error}`);
		return response.data;
	}

	async manifest(): Promise<Manifest> {
		const data = await this.must({ type: "get_manifest" }, "get_manifest", this.attachTimeoutMs);
		if (!isRecord(data) || !isRecord(data.manifest)) throw new Error("get_manifest: no manifest in the reply");
		this._manifest = data.manifest as unknown as Manifest;
		return this._manifest;
	}

	async content(): Promise<TransportContent> {
		const data = await this.must({ type: "get_content" }, "get_content", this.attachTimeoutMs);
		if (!isRecord(data) || typeof data.identity !== "string")
			throw new Error("get_content: no identity in the reply");
		const turns = isRecord(data.turns) ? data.turns : {};
		return {
			identity: data.identity,
			...(typeof data.install === "string" ? { install: data.install } : {}),
			...(typeof data.use === "string" ? { use: data.use } : {}),
			turn: (name) => (typeof turns[name] === "string" ? turns[name] : undefined),
		};
	}

	async cells(names?: string[]): Promise<TransportCells> {
		const data = await this.must({ type: "get_cells" }, "get_cells", this.pollTimeoutMs);
		if (!isRecord(data) || !isRecord(data.cells)) throw new Error("get_cells: no cells in the reply");
		const cells: TransportCells["cells"] = {};
		for (const [name, value] of Object.entries(data.cells)) {
			if (names !== undefined && !names.includes(name)) continue;
			cells[name] = { value };
		}
		const seq = typeof data.seq === "number" ? data.seq : this.lastSeq;
		if (seq > this.lastSeq) this.lastSeq = seq;
		return { seq, cells };
	}

	/** Events are pushed on the socket; there is no page to read. */
	async events(_after: number): Promise<TransportEvents> {
		this.assertOpen();
		return { events: [], dropped: 0, next: this.lastSeq };
	}

	async setCell(name: string, value: unknown, reason: string, consent?: Consent): Promise<TransportKnobOutcome> {
		this.assertOpen();
		let response: WireResponse;
		try {
			response = await this.client.request(
				{ type: "set_cell", name, value },
				{ reason, consent, timeoutMs: this.attachTimeoutMs },
			);
		} catch (error) {
			throw requestFailure(`set_cell ${name}`, error, this.client.isClosed);
		}
		if (!response.success) return { value, outcome: "failed", error: response.error };
		const landed = isRecord(response.data) && "value" in response.data ? response.data.value : value;
		return { value: landed, outcome: "done" };
	}

	async call(
		name: string,
		params: Record<string, unknown> | undefined,
		reason: string,
		timeoutMs: number,
		consent?: Consent,
	): Promise<unknown> {
		this.assertOpen();
		if (LIBRARY_COMMANDS.has(name)) throw new TransportCallError("unknown", `${name} is not a capability`);
		if (params !== undefined && "type" in params) {
			throw new TransportCallError("invalid", `${name}: a parameter cannot be named type`);
		}
		let response: WireResponse;
		try {
			response = await this.client.request({ type: name, ...(params ?? {}) }, { reason, consent, timeoutMs });
		} catch (error) {
			throw requestFailure(name, error, this.client.isClosed);
		}
		if (!response.success) {
			// the code is explicit under call_codes; a v1-core host's two fixed phrasings are read otherwise
			const code =
				this.speaks("call_codes") && isErrorCode(response.code) ? response.code : callCode(response.error);
			throw new TransportCallError(code, `${name}: ${response.error}`);
		}
		return response.data;
	}

	async audit(limit = 100): Promise<AuditData> {
		const data = await this.must({ type: "get_audit", limit }, "get_audit", this.attachTimeoutMs);
		if (!isRecord(data) || !Array.isArray(data.records)) throw new Error("get_audit: no records in the reply");
		return {
			...(typeof data.path === "string" ? { path: data.path } : {}),
			...(data.failed === null || typeof data.failed === "string" ? { failed: data.failed } : {}),
			records: data.records,
			truncated: data.truncated === true,
		};
	}

	/** The manifest default of a decision: what the program applies when the harness answers `null`. */
	private defaultFor(name: string): unknown {
		const decl = this._manifest?.decisions.find((d) => d.name === name);
		return decl?.default ?? null;
	}

	/** A claimed decision arrived: the harness is told, and the answer it gives later is the hook's result. */
	private onHook(hook: HookMessage): Promise<ReasonedResult | null> {
		return new Promise((resolve) => {
			this.asked.set(hook.id, { name: hook.hook, resolve });
			this.notify("decision", {
				id: hook.id,
				name: hook.hook,
				context: isRecord(hook.payload) ? hook.payload : {},
				deadline: Date.now() + hook.timeoutMs,
			});
		});
	}

	async claim(decisions: string[], timeoutMs?: number): Promise<string[]> {
		this.assertOpen();
		if (!this._manifest) await this.manifest();
		let response: WireResponse;
		try {
			response = await this.client.claimHooks(decisions, (hook) => this.onHook(hook), {
				timeoutMs,
				requestTimeoutMs: this.attachTimeoutMs,
				// "apply the default": a program that speaks `defaults` is asked to, and audits it as a default;
				// a v1-core host has no such answer, so it is sent the manifest default (section 5.4)
				fallback: (hook) => (this.speaks("defaults") ? null : this.defaultFor(hook.hook)),
			});
		} catch (error) {
			throw requestFailure("claim_hooks", error, this.client.isClosed);
		}
		if (!response.success) throw new Error(`claim_hooks: ${response.error}`);
		const data = response.data;
		return (isRecord(data) ? strings(data.hooks) : undefined) ?? decisions;
	}

	async release(decisions?: string[]): Promise<string[]> {
		if (!this.open) return [];
		let response: WireResponse;
		try {
			response = await this.client.releaseHooks(decisions, { timeoutMs: this.attachTimeoutMs });
		} catch (error) {
			throw requestFailure("release_hooks", error, this.client.isClosed);
		}
		if (!response.success) throw new Error(`release_hooks: ${response.error}`);
		const data = response.data;
		const released = (isRecord(data) ? strings(data.released) : undefined) ?? decisions ?? [];
		for (const [id, entry] of [...this.asked]) {
			if (!released.includes(entry.name)) continue;
			this.asked.delete(id);
			entry.resolve(null);
		}
		return released;
	}

	answer(id: string, result: unknown, reason: string, consent?: Consent): void {
		const entry = this.asked.get(id);
		if (!entry) return; // expired, released or disconnected: the program settled it
		this.asked.delete(id);
		this.answered.push(id);
		if (this.answered.length > ANSWERED_MEMORY) this.answered.shift();
		// null is "apply the default": the client sends the manifest default with this reason
		entry.resolve(withReason(result ?? null, reason, consent));
	}

	/** The `turns` extension: hand a turn back. A v1-core host has no turns, so there is nothing to end. */
	endTurn(id: string, cause?: string): void {
		if (this.open && this.speaks("turns")) {
			this.client.send({ type: "turn_end", id, ...(cause === undefined ? {} : { cause }) });
		}
	}

	/** The `lifecycle` extension: the program's own operations. A host without it has no lifecycle channel. */
	async lifecycle(op: string, reason: string, consent?: Consent): Promise<unknown> {
		this.assertOpen();
		if (!this.speaks("lifecycle")) {
			throw new TransportCallError("unknown", "the program speaks no lifecycle extension");
		}
		let response: WireResponse;
		try {
			response = await this.client.request(
				{ type: "lifecycle", op },
				{ reason, consent, timeoutMs: this.attachTimeoutMs },
			);
		} catch (error) {
			throw requestFailure(`lifecycle ${op}`, error, this.client.isClosed);
		}
		if (!response.success) {
			const code = isErrorCode(response.code) ? response.code : "error";
			throw new TransportCallError(code, `lifecycle ${op}: ${response.error}`);
		}
		return response.data;
	}

	endTouchpoint(id: string): void {
		if (this.open && this.speaks("turns")) this.client.send({ type: "touchpoint_end", id });
	}

	on<K extends keyof TransportListeners>(type: K, listener: TransportListeners[K]): () => void {
		const set = this.listeners[type] as Set<TransportListeners[K]>;
		set.add(listener);
		return () => {
			set.delete(listener);
		};
	}

	close(reason: string): void {
		if (!this._open) return;
		this._open = false;
		for (const [, entry] of this.asked) entry.resolve(null);
		this.asked.clear();
		this.client.close();
		this.notify("close", reason);
	}
}
