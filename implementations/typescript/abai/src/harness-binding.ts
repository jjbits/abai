// The direct face (abaigrammar section 4.1): what the stub hands a harness
// that attaches in-process. One object serves both sides. To the program it
// is the AttachedHarness that decisions, turns, touchpoints and emits reach;
// to the harness it is the channels: cells and events to read, knobs to
// write, capabilities to call, decisions and turns to answer, the audit log
// to tail, the counters to take. Every act of control is audited here, on
// the program side, as section 10 says, with the consent the harness states
// for an act whose policy is `confirm`.
import { resolve } from "node:path";
import { AuditLog, type AuditOutcome, type AuditTail, capValue, summarizeAnswer } from "./audit.ts";
import { validateKnobValue } from "./cells/fit.ts";
import { expandHome } from "./env.ts";
import {
	type CapabilityDecl,
	type DecisionDecl,
	durationMs,
	type FieldSchema,
	fieldOf,
	type Manifest,
	matchesType,
	type TurnDecl,
} from "./manifest/manifest.ts";
import type { Abaigram, AttachedHarness, CounterSnapshot } from "./program.ts";
import type { EventSlot } from "./region.ts";
import type { WireErrorCode } from "./wire/protocol.ts";

export interface DecisionRequest {
	id: string;
	name: string;
	decision: DecisionDecl;
	context: Record<string, unknown>;
	/** Epoch milliseconds by which an answer must arrive. */
	deadline: number;
}

export interface TurnRequest {
	id: string;
	name: string;
	turn: TurnDecl;
	deadline: number;
	/** The content slot for this turn, when the program has one. */
	content: string | undefined;
}

export type TouchpointKind = "install" | "session";

export interface TouchpointRequest {
	id: string;
	kind: TouchpointKind;
	content: string | undefined;
}

export interface LiveEvent {
	seq: number;
	name: string;
	payload: Record<string, unknown> | undefined;
	truncated: boolean;
	ts: number;
}

export interface EventBatch {
	events: LiveEvent[];
	/** Events overwritten before they were read; the harness synthesizes `abai.events.dropped` from it. */
	dropped: number;
	next: number;
}

export interface CellReading {
	value: unknown;
	version: number;
}

export interface KnobWriteOutcome {
	value: unknown;
	outcome: "done" | "failed";
	error?: string;
	/** Why it failed, in the capability error vocabulary (the endpoint sends it under `call_codes`). */
	code?: CallErrorCode;
}

/**
 * What the harness states about an act whose policy is `confirm` (section
 * 10): a person approved it, the harness approved it without asking (auto
 * mode, or the exercise form standing in for the abaigrammer), or it was
 * denied. An act under `auto` policy needs none.
 */
export type Consent = "approved" | "auto" | "denied";

/** Why a call failed: the one vocabulary, in process and on the wire. */
export type CallErrorCode = WireErrorCode;

export type LifecycleOutcome = { ok: true; data?: unknown } | { ok: false; code: CallErrorCode; error: string };

/** A capability call that did not return a result. */
export class CallError extends Error {
	readonly code: CallErrorCode;
	constructor(code: CallErrorCode, message: string) {
		super(message);
		this.name = "CallError";
		this.code = code;
	}
}

export interface BindingEvents {
	event: (event: LiveEvent) => void;
	decision: (request: DecisionRequest) => void;
	/** The decision expired: the program applied the default. */
	decision_timeout: (id: string, name: string) => void;
	turn: (request: TurnRequest) => void;
	touchpoint: (request: TouchpointRequest) => void;
	detach: (reason: string) => void;
}

/**
 * The harness's view of the stub, in-process. The optional trailing `conn`
 * of the acting methods names the connection that acts, for a front end
 * that multiplexes several (the sidecar endpoint); the audit record carries
 * it. An in-process harness passes none and is audited under the binding's
 * own label.
 */
export interface HarnessBinding {
	readonly manifest: Manifest;
	readonly name: string;
	readonly connection: string;
	content(): {
		identity: string;
		install: string | undefined;
		use: string | undefined;
		turn(name: string): string | undefined;
	};
	readCells(names?: string[]): { seq: number; cells: Record<string, CellReading> };
	readEvents(after: number): EventBatch;
	writeKnob(name: string, value: unknown, reason: string, consent?: Consent, conn?: string): Promise<KnobWriteOutcome>;
	call(
		name: string,
		params: Record<string, unknown> | undefined,
		reason: string,
		consent?: Consent,
		conn?: string,
	): Promise<unknown>;
	auditTail(limit: number): AuditTail;
	/** Where the audit log is, and the error that latched it off, if any. */
	auditInfo(): { path: string; failed: string | null };
	takeCounters(): CounterSnapshot;
	on<K extends keyof BindingEvents>(type: K, listener: BindingEvents[K]): () => void;
	/** Answer a pending decision; `null` means "apply the default" with this reason. Throws when the answer is invalid. */
	answerDecision(id: string, answer: unknown, reason: string, consent?: Consent, conn?: string): void;
	/**
	 * Let a pending decision take its default now, for a cause of the front
	 * end's: `no_harness` when nobody holds it, `timeout` when a claim's own
	 * shorter wait ran out, `detached` when its claimant went away. Audited
	 * like every other settlement, and `decision_timeout` is notified for a
	 * timeout, so one path serves every cause.
	 */
	defaultDecision(id: string, cause: string, conn?: string): void;
	/** @internal Name the connection that was asked a pending decision, so its settlement is audited under it. */
	assignDecision(id: string, conn: string): void;
	pendingDecisions(): DecisionRequest[];
	/** End a turn. `cause` says why the agent did nothing with it (the grammar's `budget`), and is audited. */
	endTurn(id: string, conn?: string, cause?: string): void;
	endTouchpoint(id: string): void;
	/**
	 * A lifecycle operation of the program's own (section 5.5): `status`,
	 * `pause` and `resume` for a cooperative pause, `stop` for the declared
	 * stop handler. Policy and consent are checked here like any act of
	 * control, and the acts that change something are audited.
	 */
	lifecycle(op: string, reason: string, consent?: Consent, conn?: string): LifecycleOutcome;
	detach(reason: string): void;
	readonly attached: boolean;
}

interface Pending<T> {
	resolve: (value: T) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout | undefined;
	startedAt: number;
	/** The connection this was asked of, when a front end named one. */
	conn?: string;
}

/**
 * A touchpoint has no timeout of its own, so nothing of the program's holds
 * its event loop open while a harness in another process holds the
 * touchpoint; this ref'd timer does, and never fires in practice (the
 * longest delay a timer takes). Cleared when the touchpoint ends.
 */
const TOUCHPOINT_KEEPALIVE_MS = 2 ** 31 - 1;

export interface BindingOptions {
	/** Where the audit log goes; default: the manifest's path, `~` expanded, relative to the program's root. */
	auditPath?: string;
	connection?: string;
}

/**
 * Check a value against a schema: an object with no undeclared field, whose
 * every present field is of its declared type. A declared field may be
 * absent (decided 2026-10-14: the schema language has no required marker,
 * and a manifest's own defaults omit fields); `nullable` governs an
 * explicit null. Nested objects and lists are checked by `matchesType`.
 */
export function schemaProblem(schema: Record<string, FieldSchema>, value: unknown, what: string): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return `${what} must be an object`;
	const record = value as Record<string, unknown>;
	for (const [key, field] of Object.entries(schema)) {
		const item = record[key];
		if (item === undefined) continue;
		if (!matchesType(item, field)) return `${what}.${key} must be a ${fieldOf(field).type}`;
	}
	for (const key of Object.keys(record)) {
		if (!(key in schema)) return `${what} has an undeclared field ${key}`;
	}
	return undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function consentGranted(consent: Consent | undefined): boolean {
	return consent === "approved" || consent === "auto";
}

export class DirectBinding implements HarnessBinding, AttachedHarness {
	readonly manifest: Manifest;
	readonly name: string;
	readonly connection: string;
	private readonly app: Abaigram;
	private readonly audit: AuditLog;
	private readonly listeners: { [K in keyof BindingEvents]: Set<BindingEvents[K]> } = {
		event: new Set(),
		decision: new Set(),
		decision_timeout: new Set(),
		turn: new Set(),
		touchpoint: new Set(),
		detach: new Set(),
	};
	private readonly decisions = new Map<string, Pending<unknown> & { request: DecisionRequest }>();
	private readonly turns = new Map<string, Pending<void> & { request: TurnRequest }>();
	private readonly touchpoints = new Map<string, Pending<void> & { request: TouchpointRequest }>();
	private readonly capabilityIndex = new Map<string, CapabilityDecl>();
	/** Touchpoints in progress: while one is open the program sits at a safepoint, so queued work runs at once (section 5.3). */
	private openTouchpoints = 0;
	private nextId = 1;
	private _attached = true;

	constructor(app: Abaigram, options: BindingOptions = {}) {
		this.app = app;
		this.manifest = app.manifest;
		this.name = app.manifest.name;
		this.connection = options.connection ?? "direct";
		for (const capability of this.manifest.capabilities) this.capabilityIndex.set(capability.name, capability);
		const auditPath = options.auditPath ?? resolve(app.content.root, expandHome(this.manifest.audit.path));
		this.audit = new AuditLog(auditPath, (error) => {
			app.emitLibrary("abai.audit.failed", { error });
		});
	}

	get attached(): boolean {
		return this._attached;
	}

	/** @internal Called by the program once the binding is set: the counters go to the log first (section 10). */
	flushCounters(): void {
		const counters = this.app.takeCounters();
		for (const [name, count] of Object.entries(counters)) {
			if (count === 0) continue;
			const cause = name === "abai.mode_fallback" ? "mode_fallback" : "no_harness";
			this.audit.append({ act: "counters", name, outcome: "default", cause, count });
		}
	}

	/** Queue work for the program's next safepoint, or run it now when a touchpoint holds the program at one. */
	private atSafepoint(work: () => void): void {
		this.app.enqueue(work);
		if (this.openTouchpoints > 0) this.app.drain();
	}

	/**
	 * @internal The program is at a safepoint and will stay there (its entry
	 * serving an MCP client): safepoint-dispatched work runs at once rather
	 * than waiting for a safepoint the program would never reach. Paired
	 * with `leaveSafepoint`.
	 */
	enterSafepoint(): void {
		this.openTouchpoints += 1;
		this.app.drain();
	}

	/** @internal */
	leaveSafepoint(): void {
		if (this.openTouchpoints > 0) this.openTouchpoints -= 1;
	}

	// -----------------------------------------------------------------------
	// Harness side
	// -----------------------------------------------------------------------

	content(): {
		identity: string;
		install: string | undefined;
		use: string | undefined;
		turn(name: string): string | undefined;
	} {
		const slots = this.app.content;
		return {
			identity: slots.identity(),
			install: slots.install(),
			use: slots.use(),
			turn: (name) => slots.turn(name),
		};
	}

	readCells(names?: string[]): { seq: number; cells: Record<string, CellReading> } {
		const all = this.app.readCells();
		const cells: Record<string, CellReading> = {};
		for (const name of names ?? Object.keys(all)) {
			if (!(name in all)) throw new Error(`unknown cell: ${name}`);
			cells[name] = { value: all[name], version: this.app.version(name) };
		}
		return { seq: this.app.region.lastSeq, cells };
	}

	readEvents(after: number): EventBatch {
		const read = this.app.region.readEvents(after);
		return { events: read.slots.map((slot) => this.live(slot)), dropped: read.dropped, next: read.next };
	}

	private live(slot: EventSlot): LiveEvent {
		return {
			seq: slot.seq,
			name: this.app.eventName(slot.event),
			payload: slot.payload,
			truncated: slot.truncated,
			ts: slot.ts,
		};
	}

	async writeKnob(
		name: string,
		value: unknown,
		reason: string,
		consent?: Consent,
		conn?: string,
	): Promise<KnobWriteOutcome> {
		const decl = this.manifest.cells.find((cell) => cell.name === name);
		const started = this.app.now();
		const record = (
			outcome: AuditOutcome,
			landed: unknown,
			error?: string,
			cause?: CallErrorCode,
		): KnobWriteOutcome => {
			this.audit.append({
				conn: conn ?? this.connection,
				act: "knob",
				name,
				value: capValue(landed),
				outcome,
				...(cause === undefined ? {} : { cause }),
				...(consent === undefined ? {} : { consent }),
				reason,
				...(error === undefined ? {} : { error }),
				ms: this.app.now() - started,
			});
			return outcome === "ok"
				? { value: landed, outcome: "done" }
				: { value: landed, outcome: "failed", error, ...(cause === undefined ? {} : { code: cause }) };
		};
		if (!decl) return record("error", undefined, `unknown cell: ${name}`, "unknown");
		if (decl.access !== "readwrite") return record("error", undefined, `${name} is read-only`, "invalid");
		if (decl.policy === "confirm" && !consentGranted(consent)) {
			return record("error", undefined, `${name} needs consent (its policy is confirm)`, "denied");
		}
		const problem = validateKnobValue(decl, value);
		if (problem !== undefined) return record("error", undefined, problem, "invalid");
		const sized = decl.type === "string" || decl.type === "object" || decl.type === "list";
		if (!sized) {
			this.app.knob(name).set(value);
			return record("ok", this.app.cell(name).get());
		}
		// a sized knob is delivered at the program's next safepoint, to its handler, within its delivery timeout (section 5.2)
		const handler = this.app.knobHandler(name);
		if (!handler) {
			return record("failed", undefined, `no handler registered for ${name}: nothing can receive it`, "error");
		}
		const timeoutMs = durationMs(decl.timeout ?? "30s");
		return new Promise<KnobWriteOutcome>((done) => {
			let settled = false;
			const work = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.app.cell(name).set(value);
				const landed = this.app.cell(name).get();
				try {
					handler(landed);
					done(record("ok", landed));
				} catch (error) {
					done(record("error", landed, errorMessage(error), "error"));
				}
			};
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				this.app.dequeue(work);
				done(
					record(
						"failed",
						undefined,
						`not delivered within ${decl.timeout ?? "30s"}: the program reached no safepoint`,
						"timeout",
					),
				);
			}, timeoutMs);
			timer.unref();
			this.atSafepoint(work);
		});
	}

	async call(
		name: string,
		params: Record<string, unknown> | undefined,
		reason: string,
		consent?: Consent,
		conn?: string,
	): Promise<unknown> {
		const decl = this.capabilityIndex.get(name);
		const started = this.app.now();
		const record = (outcome: AuditOutcome, extra: { error?: string; cause?: string } = {}): void => {
			this.audit.append({
				conn: conn ?? this.connection,
				act: "capability",
				name,
				params: capValue(params),
				outcome,
				...(consent === undefined ? {} : { consent }),
				reason,
				...extra,
				ms: this.app.now() - started,
			});
		};
		const fail = (code: CallErrorCode, message: string): CallError => {
			record(code === "forbidden" ? "forbidden" : "error", { error: message, cause: code });
			return new CallError(code, message);
		};
		if (!decl) throw fail("unknown", `${this.name} declares no capability ${name}`);
		if (decl.policy === "forbid") throw fail("forbidden", `the program's policy forbids ${name}`);
		if (decl.policy === "confirm" && !consentGranted(consent))
			throw fail("denied", `${name} needs consent (its policy is confirm)`);
		const problem = schemaProblem(decl.params, params ?? {}, "params");
		if (problem !== undefined) throw fail("invalid", problem);
		const timeoutMs = durationMs(decl.timeout ?? "30s");
		const result = await new Promise<unknown>((done, reject) => {
			let settled = false;
			const settle = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				fn();
			};
			// the handler is resolved at dispatch, so one registered after startup still serves
			const run = (): void => {
				if (settled) return;
				const handler = this.app.capabilityHandler(name);
				if (!handler) {
					settle(() => reject(new CallError("error", `${name} has no handler registered`)));
					return;
				}
				let outcome: unknown;
				try {
					outcome = handler(params ?? {}); // synchronous part runs inside the safepoint, on the program's thread
				} catch (error) {
					settle(() => reject(new CallError("error", errorMessage(error))));
					return;
				}
				Promise.resolve(outcome).then(
					(value) => settle(() => done(value)),
					(error) => settle(() => reject(new CallError("error", errorMessage(error)))),
				);
			};
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				this.app.dequeue(run);
				reject(new CallError("timeout", `${name} did not answer within ${decl.timeout ?? "30s"}`));
			}, timeoutMs);
			timer.unref();
			if (decl.dispatch === "immediate") run();
			else this.atSafepoint(run);
		}).catch((error: CallError) => {
			record("error", { error: error.message, cause: error.code });
			throw error;
		});
		record("ok");
		return result;
	}

	auditTail(limit: number): AuditTail {
		return this.audit.tail(limit);
	}

	auditInfo(): { path: string; failed: string | null } {
		return { path: this.audit.path, failed: this.audit.failed ?? null };
	}

	takeCounters(): CounterSnapshot {
		return this.app.takeCounters();
	}

	on<K extends keyof BindingEvents>(type: K, listener: BindingEvents[K]): () => void {
		const set = this.listeners[type] as Set<BindingEvents[K]>;
		set.add(listener);
		return () => {
			set.delete(listener);
		};
	}

	private notify<K extends keyof BindingEvents>(type: K, ...args: Parameters<BindingEvents[K]>): void {
		for (const listener of this.listeners[type]) {
			try {
				(listener as (...a: Parameters<BindingEvents[K]>) => void)(...args);
			} catch {
				// a harness listener's failure never reaches the program
			}
		}
	}

	answerDecision(id: string, answer: unknown, reason: string, consent?: Consent, conn?: string): void {
		const pending = this.decisions.get(id);
		if (!pending) throw new Error(`no pending decision ${id}`);
		if (reason.trim() === "") throw new Error("a decision needs a reason");
		if (conn !== undefined) pending.conn = conn;
		const { decision } = pending.request;
		if (answer !== null) {
			const problem = decision.options
				? decision.options.includes(answer as string)
					? undefined
					: `answer must be one of: ${decision.options.join(", ")}`
				: schemaProblem(decision.answer ?? {}, answer, "answer");
			if (problem !== undefined) {
				this.settleDecision(id, { source: "default", cause: "invalid", reason, answer });
				throw new Error(problem);
			}
			if (decision.policy === "confirm" && !consentGranted(consent)) {
				this.settleDecision(id, { source: "default", cause: "denied", reason, consent });
				return;
			}
		}
		this.settleDecision(
			id,
			answer === null
				? { source: "default", cause: "answered", reason }
				: { source: "agent", reason, answer, consent },
		);
	}

	defaultDecision(id: string, cause: string, conn?: string): void {
		const pending = this.decisions.get(id);
		if (!pending) return;
		if (conn !== undefined) pending.conn = conn;
		this.settleDecision(id, { source: "default", cause });
	}

	assignDecision(id: string, conn: string): void {
		const pending = this.decisions.get(id);
		if (pending) pending.conn = conn;
	}

	pendingDecisions(): DecisionRequest[] {
		return [...this.decisions.values()].map((p) => p.request);
	}

	private settleDecision(
		id: string,
		outcome: { source: "agent" | "default"; cause?: string; reason?: string; answer?: unknown; consent?: Consent },
	): void {
		const pending = this.decisions.get(id);
		if (!pending) return;
		this.decisions.delete(id);
		if (pending.timer) clearTimeout(pending.timer);
		this.openTouchpoints -= 1;
		const { decision } = pending.request;
		this.audit.append({
			conn: pending.conn ?? this.connection,
			act: "decision",
			name: decision.name,
			id,
			value: summarizeAnswer(decision, outcome.source === "agent" ? outcome.answer : decision.default),
			outcome: outcome.source,
			...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
			...(outcome.consent === undefined ? {} : { consent: outcome.consent }),
			...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
			ms: this.app.now() - pending.startedAt,
		});
		if (outcome.source === "agent") pending.resolve(outcome.answer);
		else pending.reject(new Error(outcome.cause ?? "default"));
		if (outcome.cause === "timeout") this.notify("decision_timeout", id, decision.name);
	}

	endTurn(id: string, conn?: string, cause?: string): void {
		const pending = this.turns.get(id);
		if (!pending) return;
		if (conn !== undefined) pending.conn = conn;
		// a turn the agent did nothing with (held back by its budget) is a default, with the cause it names
		if (cause === undefined) this.settleTurn(id, "ok");
		else this.settleTurn(id, "default", cause);
	}

	/** @internal Queue work for the program's next safepoint, running it now when one is held open. */
	atNextSafepoint(work: () => void): void {
		this.atSafepoint(work);
	}

	lifecycle(op: string, reason: string, consent?: Consent, conn?: string): LifecycleOutcome {
		const declared = this.manifest.lifecycle;
		const started = this.app.now();
		const record = (outcome: AuditOutcome, extra: { cause?: string; error?: string } = {}): void => {
			this.audit.append({
				conn: conn ?? this.connection,
				act: "lifecycle",
				name: op,
				outcome,
				...(consent === undefined ? {} : { consent }),
				reason,
				...extra,
				ms: this.app.now() - started,
			});
		};
		const refuse = (code: CallErrorCode, error: string): LifecycleOutcome => {
			record(code === "forbidden" ? "forbidden" : "error", { cause: code, error });
			return { ok: false, code, error };
		};
		if (op === "status") return { ok: true, data: this.app.lifecycleStatus() };
		if (op !== "pause" && op !== "resume" && op !== "stop" && op !== "restart" && op !== "start") {
			return { ok: false, code: "unknown", error: `unknown lifecycle operation: ${op}` };
		}
		// section 10: pause and resume are auto, stop and restart confirm, unless the manifest says otherwise
		const policy =
			declared?.policy?.[op as "pause" | "resume" | "stop" | "restart"] ??
			(op === "stop" || op === "restart" ? "confirm" : "auto");
		if (policy === "forbid") return refuse("forbidden", `the program's policy forbids lifecycle ${op}`);
		if (policy === "confirm" && !consentGranted(consent)) {
			return refuse("denied", `lifecycle ${op} needs consent (its policy is confirm)`);
		}
		switch (op) {
			case "pause":
				if (declared?.pause !== "cooperative") {
					return refuse(
						"invalid",
						declared?.pause === "os"
							? "this program declares os pause, which its launcher performs"
							: "this program declares no cooperative pause",
					);
				}
				this.app.requestPause();
				record("ok");
				return { ok: true };
			case "resume":
				this.app.resumeFromPause();
				record("ok");
				return { ok: true };
			case "stop": {
				if (!this.app.stopHandler) return refuse("invalid", "this program declares no stop handler");
				// a stop supersedes a pause: a program held at a touchpoint goes on to the safepoint where the handler runs
				this.app.resumeFromPause();
				// at the next safepoint, on the thread that reaches it (5.5); the program is expected to exit
				const handler = this.app.stopHandler;
				this.atNextSafepoint(() => {
					// on the thread that reached the safepoint; a failing handler is the program's own matter, and the
					// launcher's window runs either way
					try {
						Promise.resolve(handler()).catch(() => {});
					} catch {
						// same
					}
				});
				record("ok");
				return { ok: true, data: { op, requested: true } };
			}
			default:
				return refuse("invalid", `lifecycle ${op} is the launcher's, not the program's`);
		}
	}

	private settleTurn(id: string, outcome: AuditOutcome, cause?: string): void {
		const pending = this.turns.get(id);
		if (!pending) return;
		this.turns.delete(id);
		if (pending.timer) clearTimeout(pending.timer);
		this.openTouchpoints -= 1;
		this.audit.append({
			conn: pending.conn ?? this.connection,
			act: "turn",
			name: pending.request.name,
			id,
			outcome,
			...(cause === undefined ? {} : { cause }),
			ms: this.app.now() - pending.startedAt,
		});
		pending.resolve();
	}

	endTouchpoint(id: string): void {
		const pending = this.touchpoints.get(id);
		if (!pending) return;
		this.touchpoints.delete(id);
		if (pending.timer) clearInterval(pending.timer);
		this.openTouchpoints -= 1;
		pending.resolve();
	}

	detach(reason: string): void {
		if (!this._attached) return;
		this._attached = false;
		for (const id of [...this.decisions.keys()])
			this.settleDecision(id, { source: "default", cause: "detached", reason });
		for (const id of [...this.turns.keys()]) this.settleTurn(id, "default", "detached");
		for (const id of [...this.touchpoints.keys()]) this.endTouchpoint(id);
		this.notify("detach", reason);
		this.app.clearHarness(reason);
		this.audit.close();
	}

	// -----------------------------------------------------------------------
	// Program side (AttachedHarness)
	// -----------------------------------------------------------------------

	decide(decision: DecisionDecl, context: Record<string, unknown>, deadline: number): Promise<unknown> {
		if (decision.policy === "forbid") {
			this.audit.append({
				conn: this.connection,
				act: "decision",
				name: decision.name,
				outcome: "default",
				cause: "forbidden",
			});
			return Promise.reject(new Error("forbidden"));
		}
		const id = `d${this.nextId++}`;
		const request: DecisionRequest = { id, name: decision.name, decision, context, deadline };
		return new Promise<unknown>((resolve, reject) => {
			// this timer bounds the program's own wait: it keeps the process alive until the answer or the default
			const timer = setTimeout(
				() => this.settleDecision(id, { source: "default", cause: "timeout" }),
				Math.max(0, deadline - this.app.now()),
			);
			this.decisions.set(id, { request, resolve, reject, timer, startedAt: this.app.now() });
			this.openTouchpoints += 1;
			this.notify("decision", request);
		});
	}

	turn(turn: TurnDecl, deadline: number): Promise<void> {
		const id = `t${this.nextId++}`;
		const request: TurnRequest = { id, name: turn.name, turn, deadline, content: this.app.content.turn(turn.name) };
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => this.settleTurn(id, "default", "timeout"),
				Math.max(0, deadline - this.app.now()),
			);
			this.turns.set(id, { request, resolve, reject, timer, startedAt: this.app.now() });
			this.openTouchpoints += 1;
			this.notify("turn", request);
		});
	}

	/** @internal A program-initiated `install` or `session`; resolves when the harness ends it or detaches. */
	touchpoint(kind: TouchpointKind): Promise<void> {
		const id = `p${this.nextId++}`;
		const content = kind === "install" ? this.app.content.install() : this.app.content.use();
		const request: TouchpointRequest = { id, kind, content };
		return new Promise<void>((resolve, reject) => {
			const timer = setInterval(() => {}, TOUCHPOINT_KEEPALIVE_MS);
			this.touchpoints.set(id, { request, resolve, reject, timer, startedAt: this.app.now() });
			this.openTouchpoints += 1;
			this.notify("touchpoint", request);
		});
	}

	emitted(seq: number): void {
		const read = this.app.region.readEvents(seq - 1);
		const slot = read.slots.find((s) => s.seq === seq);
		if (slot) this.notify("event", this.live(slot));
	}
}
