// abai wire protocol v1 (abaigrammar section 6.3): LF-framed JSON lines over a
// local socket. The core is the generic part of arx-06's supervisor protocol,
// unchanged, so a running arx-06 is a sidecar target; extensions are
// advertised in hello.abai.extensions.
import type { Manifest } from "../manifest/manifest.ts";

export const PROTOCOL_VERSION = 1;

/**
 * The extensions a TypeScript stub speaks beyond the v1 core, named in
 * `hello.abai.extensions` so a client speaks each only when it is offered:
 * `consent` (consent stated on a request or hook answer), `content` (the
 * install, use and turn slots on `get_content`), `turns` (turns and
 * touchpoints as messages), `call_codes` (a code beside every error),
 * `defaults` (a `hook_response` whose `result` is null asks the program to
 * apply the decision's default, audited as a default; a v1-core host has no
 * such answer, so the client sends it the manifest default instead),
 * `lifecycle` (the `lifecycle {op}` command of section 5.5 and a cause on
 * `turn_end`).
 */
export const EXTENSIONS = ["consent", "content", "turns", "call_codes", "defaults", "lifecycle"] as const;
export type Extension = (typeof EXTENSIONS)[number];

/** Why a request failed, in the capability error vocabulary (the `call_codes` extension). */
export type WireErrorCode = "unknown" | "forbidden" | "denied" | "invalid" | "timeout" | "error";

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/** The abai identity of the program, in `hello`. */
export interface HelloAbai {
	name: string;
	abaigrammar: string;
	modes: string[];
	audit: { path: string; failed: string | null };
	/** Wire extensions beyond the v1 core; absent means none. */
	extensions?: string[];
}

export interface HelloMessage {
	type: "hello";
	protocol: number;
	pid: number;
	/** The program's own version string, when it has one. */
	version?: string;
	cwd: string;
	/** A directory the program calls its own (arx-06's agent dir); absent for most programs. */
	agentDir?: string;
	mode: string;
	/** What this host offers: hooks and commands policy does not forbid. */
	capabilities: { hooks: string[]; commands: string[] };
	/** Sequence number of the last event the host counted. */
	lastSeq: number;
	/** This connection's id (`k1`, `k2`, ...), as the audit log names it. */
	connection: string;
	abai: HelloAbai;
}

export type WireEvent = { type: string } & Record<string, unknown>;

export interface EventMessage {
	type: "event";
	seq: number;
	ts: number;
	event: WireEvent;
	/** A sized field was cut to its declared max. An additive field; a v1-core client ignores it. */
	truncated?: boolean;
}

/** A `snapshot` message some hosts send; parsed, its shape is the host's. */
export type LooseSnapshotMessage = { type: "snapshot" } & Record<string, unknown>;

/** An event that could not be serialized was dropped; the program continues. */
export interface SerializeErrorMessage {
	type: "serialize_error";
	seq: number;
	ts: number;
	eventType: string;
	error: string;
}

export type WireResponse =
	| { type: "response"; id?: string; command: string; success: true; data?: unknown }
	| { type: "response"; id?: string; command: string; success: false; error: string; code?: WireErrorCode };

/** Extension `turns`: the program gives the harness a turn; `turn_end` hands control back. */
export interface TurnMessage {
	type: "turn";
	id: string;
	name: string;
	/** How long the program waits before the turn ends on its own. */
	timeoutMs: number;
	content?: string;
}

/** Extension `turns`: a program-initiated `install` or `session`; `touchpoint_end` returns it. */
export interface TouchpointMessage {
	type: "touchpoint";
	id: string;
	kind: "install" | "session";
	content?: string;
}

/** Interceptable hook round trip. Only sent to the connection holding the hook. */
export interface HookMessage {
	type: "hook";
	id: string;
	hook: string;
	timeoutMs: number;
	payload: unknown;
}

export interface HookTimeoutMessage {
	type: "hook_timeout";
	hook: string;
	id: string;
}

/** The claimant's claims were dropped by the host (three consecutive timeouts). */
export interface HookClaimsReleasedMessage {
	type: "hook_claims_released";
	reason: string;
	hooks: string[];
}

/**
 * A hook could not be served: the payload was not serializable (no `hook`
 * message was sent for this id) or the claimant's result failed validation.
 * The run continued as if the hook were unclaimed.
 */
export interface HookRejectedMessage {
	type: "hook_rejected";
	id: string;
	hook: string;
	error: string;
}

export type ServerMessage =
	| HelloMessage
	| EventMessage
	| LooseSnapshotMessage
	| SerializeErrorMessage
	| WireResponse
	| HookMessage
	| HookTimeoutMessage
	| HookClaimsReleasedMessage
	| HookRejectedMessage
	| TurnMessage
	| TouchpointMessage;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/**
 * Per-connection event filter. `include` restricts the stream to the listed
 * event types; `exclude` drops the listed types. A `subscribe` request
 * replaces the whole filter, so an omitted `exclude` means no exclusions.
 */
export interface SubscriptionFilter {
	include?: string[];
	exclude?: string[];
}

/** The library's commands: the connection's own, the stub's, and the cells channel. */
export type LibraryCommand =
	// connection
	| { type: "ping" }
	| ({ type: "subscribe" } & SubscriptionFilter)
	| { type: "claim_hooks"; hooks: string[]; timeoutMs?: number }
	| { type: "release_hooks"; hooks?: string[] }
	// library
	| { type: "get_manifest" }
	| { type: "get_content" }
	| { type: "get_audit"; limit?: number }
	// cells (abaigrammar section 5.2)
	| { type: "get_cells" }
	| { type: "set_cell"; name: string; value: unknown }
	// lifecycle (abaigrammar section 5.5), the `lifecycle` extension: status always, pause and resume for a
	// cooperative pause, stop for the declared stop handler; start and restart are the launcher's own
	| { type: "lifecycle"; op: string };

/**
 * Every command a client can send: the library commands, plus any capability
 * call sent as `{ type: <capability name>, ...params }`. The advertised list
 * is the host's (`hello.capabilities.commands`).
 */
export type WireCommand = LibraryCommand | ({ type: string } & Record<string, unknown>);

/** Consent stated for an act whose policy is `confirm` (abaigrammar section 10); the `consent` extension. */
export type WireConsent = "approved" | "auto" | "denied";

export interface RequestMessage {
	type: "request";
	id: string;
	command: WireCommand;
	/** The agent's stated reason for an act of control; written to the audit log. */
	reason?: string;
	/** Extension `consent`: ignored by a v1-core host. */
	consent?: WireConsent;
}

export interface HookResponseMessage {
	type: "hook_response";
	id: string;
	result: unknown;
	/** The agent's stated reason for its answer; written to the audit log. */
	reason?: string;
	/** Extension `consent`: ignored by a v1-core host. */
	consent?: WireConsent;
}

/** Extension `turns`: the harness is done with a turn. `cause` says why the agent did nothing with it (`budget`). */
export interface TurnEndMessage {
	type: "turn_end";
	id: string;
	cause?: string;
}

/** Extension `turns`: the harness is done with a touchpoint. */
export interface TouchpointEndMessage {
	type: "touchpoint_end";
	id: string;
}

export type ClientMessage = RequestMessage | HookResponseMessage | TurnEndMessage | TouchpointEndMessage;

// ---------------------------------------------------------------------------
// Response data of the library commands
// ---------------------------------------------------------------------------

/** `get_cells`: every cell's value (sized ones cut to their max) and the host's event sequence number. */
export interface GetCellsData {
	seq: number;
	cells: Record<string, unknown>;
}

/** `set_cell`: the knob and the value that landed (it may be clamped). */
export interface SetCellData {
	name: string;
	value: unknown;
}

/** `get_manifest`: the effective manifest of this running host. */
export interface GetManifestData {
	manifest: Manifest;
}

/** `get_content`: the content slots the stub embeds (abaigrammar section 8). A v1-core host sends `identity` only. */
export interface GetContentData {
	identity: string;
	install?: string;
	use?: string;
	turns?: Record<string, string>;
}

/** `lifecycle {op: "status"}`: what the stub knows of its own process. */
export interface LifecycleStatusData {
	pid: number;
	name: string;
	mode: string;
	cwd: string;
	startedAt: string;
	connections: number;
	paused: boolean;
	/** A launcher handed this program its connection, so the full lifecycle is available to it. */
	launched: boolean;
}

/** `get_audit`: the log's location and state, and its last records. */
export interface GetAuditData {
	path: string;
	failed: string | null;
	records: unknown[];
	/** More records exist than were returned. */
	truncated: boolean;
}
