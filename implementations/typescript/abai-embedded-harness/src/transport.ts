// The transport (abaigrammar section 4.1): the harness's view of a stub,
// in the grammar's own terms. The harness core never imports a transport;
// it is handed one. Two bindings exist: direct, in-process, over the stub's
// HarnessBinding (turns and thread modes), and socket, over wire protocol
// v1 (sidecar mode). Both carry the same meaning for every channel.
import type { Consent, Manifest } from "abai";

export interface TransportHello {
	name: string;
	abaigrammar: string;
	modes: string[];
	pid?: number;
	cwd?: string;
	/** This connection's id, as the audit log names it. */
	connection: string;
	/** Wire extensions the stub speaks beyond the v1 core (empty in-process: everything is live). */
	extensions: string[];
	/** The decisions the program lets a harness claim, when it says (sidecar: hello.capabilities.hooks); absent means every one policy does not forbid. */
	claimable?: string[];
}

export interface TransportContent {
	identity: string;
	install?: string;
	use?: string;
	turn(name: string): string | undefined;
}

export interface TransportCell {
	value: unknown;
	version?: number;
}

export interface TransportCells {
	seq: number;
	cells: Record<string, TransportCell>;
}

export interface TransportEvent {
	seq: number;
	name: string;
	payload: Record<string, unknown> | undefined;
	truncated: boolean;
	ts: number;
}

export interface TransportEvents {
	events: TransportEvent[];
	/** Overwritten before they were read; the harness synthesizes `abai.events.dropped` from it. */
	dropped: number;
	next: number;
}

export interface TransportKnobOutcome {
	value: unknown;
	outcome: "done" | "failed";
	error?: string;
}

export interface TransportDecision {
	id: string;
	name: string;
	context: Record<string, unknown>;
	/** Epoch milliseconds by which an answer must arrive. */
	deadline: number;
}

export interface TransportTurn {
	id: string;
	name: string;
	deadline: number;
	content: string | undefined;
}

export interface TransportTouchpoint {
	id: string;
	kind: "install" | "session";
	content: string | undefined;
}

export interface TransportEvents_ {
	event: (event: TransportEvent) => void;
	decision: (decision: TransportDecision) => void;
	/** The stub expired a pending decision: the program applied the default. */
	decision_timeout: (id: string, name: string) => void;
	/** The stub refused an answer it had received (its own validation): the program applied the default. */
	decision_rejected: (id: string, name: string, error: string) => void;
	turn: (turn: TransportTurn) => void;
	touchpoint: (touchpoint: TransportTouchpoint) => void;
	/** The stub released decisions the harness held (sidecar only). */
	claims_released: (names: string[], reason: string) => void;
	close: (reason: string | undefined) => void;
}

export type TransportListeners = TransportEvents_;

export interface AuditData {
	path?: string;
	failed?: string | null;
	records: unknown[];
	truncated: boolean;
}

/** A capability call that returned no result. */
export class TransportCallError extends Error {
	readonly code: "unknown" | "forbidden" | "denied" | "invalid" | "timeout" | "error" | "detached";
	constructor(code: TransportCallError["code"], message: string) {
		super(message);
		this.name = "TransportCallError";
		this.code = code;
	}
}

export interface StubTransport {
	readonly hello: TransportHello;
	readonly open: boolean;
	/**
	 * Whether event sequence numbers are dense on this transport, so a gap is a loss (the in-process ring overwrote
	 * unread slots). Over a socket the program's numbers count events this connection never receives (filtered,
	 * or on other channels), so a gap means nothing and a dropped connection is seen as `close`.
	 */
	readonly denseSeq: boolean;
	manifest(): Promise<Manifest>;
	content(): Promise<TransportContent>;
	cells(names?: string[]): Promise<TransportCells>;
	events(after: number): Promise<TransportEvents>;
	setCell(name: string, value: unknown, reason: string, consent?: Consent): Promise<TransportKnobOutcome>;
	call(
		name: string,
		params: Record<string, unknown> | undefined,
		reason: string,
		timeoutMs: number,
		consent?: Consent,
	): Promise<unknown>;
	audit(limit?: number): Promise<AuditData>;
	/** Which decisions this harness is asked. The direct binding asks every declared one; claiming is a no-op there. */
	claim(decisions: string[], timeoutMs?: number): Promise<string[]>;
	release(decisions?: string[]): Promise<string[]>;
	/** Answer a decision; `null` means "apply the default" with this reason. `consent` is stated for a `confirm` decision. */
	answer(id: string, result: unknown, reason: string, consent?: Consent): void;
	/** End a turn. `cause` says why the agent did nothing with it (the grammar's `budget`), and is audited. */
	endTurn(id: string, cause?: string): void;
	endTouchpoint(id: string): void;
	/**
	 * The lifecycle channel (section 5.5), as far as the program itself
	 * serves it: `status` always; `pause`, `resume` and `stop` as the
	 * program declares them. The launcher's own operations are not here.
	 */
	lifecycle(op: string, reason: string, consent?: Consent): Promise<unknown>;
	on<K extends keyof TransportListeners>(type: K, listener: TransportListeners[K]): () => void;
	/**
	 * The consumer has registered its listeners: deliver what the transport
	 * held until now, in order. A transport that can hold nothing (in-process,
	 * where the program waits for the attach to finish) needs none.
	 */
	start?(): void;
	close(reason: string): void;
}
