// The harness core (abaigrammar section 4.1, the agent side): loads the
// manifest and the content from the stub, is woken by declared events,
// watches, timers, decisions and turns, keeps the attention budget, and
// drives the channels with a reason for every act. It never imports a
// transport: it is handed one (direct in-process, or the socket client),
// and it carries no model: the front end runs the agent that calls its
// tools. Ported from arx-06-0's harness core and generalized: decisions
// are the manifest's, not a fixed hook list.
import type { CapabilityDecl, Consent, DecisionDecl, Manifest } from "@abaigram/abai-stub";
import { durationMs, validateManifest } from "@abaigram/abai-stub";
import type { HarnessOptions } from "./options.ts";
import { composeInstructions, composeSystemPrompt } from "./prompt.ts";
import {
	DECISION_MARGIN_MS,
	DEFAULT_WATCH_CADENCE_MS,
	type Delivery,
	MIN_WATCH_CADENCE_MS,
	type PendingDecision,
	summarizeDecision,
	type TimerInfo,
	TOOL_REQUEST_TIMEOUT_MS,
	TranscriptRing,
	validateAnswer,
	WATCH_OPS,
	WakeScheduler,
	type WakeSource,
	type WatchInfo,
	type WatchOp,
	watchHolds,
} from "./scheduler.ts";
import type {
	StubTransport,
	TransportDecision,
	TransportEvent,
	TransportHello,
	TransportTouchpoint,
	TransportTurn,
} from "./transport.ts";
import { wakesFor } from "./wakes.ts";

/** What a launcher (section 6.3, launch form) adds to the harness: the program's process is its child. */
export interface LaunchState {
	running: boolean;
	pid?: number;
	/** The last exit, when the child has exited at least once. */
	exit?: { code: number | null; signal: string | null };
	/** How many times the command was started. */
	starts: number;
}

export interface Launcher {
	state(): LaunchState;
	/** Every lifecycle operation, the ones only a launcher can perform included; the consent is the tool's. */
	lifecycle(op: string, reason: string, consent?: Consent): Promise<unknown>;
}

/** Library events that wake the agent without a declaration (section 5.6): the program's exit, and what a pause holds. */
export const ALWAYS_WAKE: ReadonlySet<string> = new Set(["abai.lifecycle.exited", "abai.pause.blocked"]);

export interface HarnessDeps {
	now?: () => number;
	/** A manifest to use before any attach (the MCP form's `abai_prompt`; tests). */
	manifest?: Manifest;
	/** An identity to use before any attach. */
	identity?: string;
}

export interface HarnessStatus {
	attached: boolean;
	program: { name: string; pid?: number; cwd?: string; mode: string; connection: string } | null;
	claims: string[];
	pending: PendingDecision[];
	turns: Array<{ id: string; name: string; deadline: number }>;
	touchpoints: Array<{ id: string; kind: string }>;
	/** Present when this harness launched the program. */
	launch?: LaunchState;
	watches: WatchInfo[];
	timers: TimerInfo[];
	budget: { perMinute: number | undefined; used: number };
	wakesPending: number;
	transcriptLines: number;
	lastError: string | null;
}

interface WatchEntry extends WatchInfo {
	sampled: boolean;
	held: boolean;
	last?: unknown;
}

interface TimerEntry extends TimerInfo {
	handle: NodeJS.Timeout;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function preview(value: unknown, max: number): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	} catch {
		text = String(value);
	}
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function requireReason(reason: string, what: string): string {
	if (typeof reason !== "string" || reason.trim() === "") throw new Error(`${what} needs a reason`);
	return reason;
}

export class Harness {
	readonly options: HarnessOptions;
	readonly ring: TranscriptRing;
	readonly scheduler: WakeScheduler;
	/** Set by the front end: a delivery may be ready. */
	onWake: (() => void) | undefined;
	/** Set by the front end: something the person should hear. */
	onNotice: ((text: string) => void) | undefined;
	/** Set by the front end: a session touchpoint is the person's loop, not a wake for the agent. */
	onSession: ((touchpoint: TransportTouchpoint) => void) | undefined;
	/** Set by the front end: the program is gone (detached, closed), with the reason. */
	onDetach: ((reason: string) => void) | undefined;
	/** Set by the `run` verb: this harness launched the program, so the full lifecycle is its to drive. */
	launcher: Launcher | undefined;
	/** The harness's own sequence for what it observes from outside, apart from the program's. */

	private transport: StubTransport | undefined;
	private unsubscribe: Array<() => void> = [];
	private _manifest: Manifest | undefined;
	private _identity: string;
	private claims: string[] = [];
	private readonly pending = new Map<string, PendingDecision>();
	private readonly pendingTurns = new Map<string, TransportTurn>();
	private readonly pendingTouchpoints = new Map<string, TransportTouchpoint>();
	private readonly watchList: WatchEntry[] = [];
	private readonly timerList: TimerEntry[] = [];
	private pollHandle: NodeJS.Timeout | undefined;
	private polling = false;
	private budgetTimer: NodeJS.Timeout | undefined;
	private nextWatchId = 1;
	private nextTimerId = 1;
	private lastError: string | null = null;
	private lastSeq = 0;
	private closed = false;
	private waiters: Array<() => void> = [];
	private readonly now: () => number;

	constructor(options: HarnessOptions, deps: HarnessDeps = {}) {
		this.options = options;
		this.now = deps.now ?? Date.now;
		this._identity = deps.identity ?? "";
		this.ring = new TranscriptRing((message) => [this.renderLine(message)]);
		this.scheduler = new WakeScheduler(options.budget, this.now);
		if (deps.manifest) this.applyManifest(deps.manifest);
	}

	/** The manifest's attention budget applies unless --budget was given (section 5.6). */
	private applyManifest(manifest: Manifest): void {
		this._manifest = manifest;
		if (this.options.budget === undefined) this.scheduler.budget = manifest.attention?.budget?.wakes_per_minute;
	}

	get attached(): boolean {
		return this.transport?.open === true;
	}

	get hello(): TransportHello | undefined {
		return this.transport?.hello;
	}

	get manifest(): Manifest | undefined {
		return this._manifest;
	}

	get identity(): string {
		return this._identity;
	}

	get lastErrorMessage(): string | null {
		return this.lastError;
	}

	// -----------------------------------------------------------------------
	// Attach and detach
	// -----------------------------------------------------------------------

	/** Take up a connected transport: load the manifest and content, claim, wire the channels. */
	async attach(transport: StubTransport): Promise<TransportHello> {
		if (this.transport !== undefined && this.transport !== transport) this.detach("reattaching to another program");
		this.transport = transport;
		this.lastError = null;
		this.lastSeq = 0; // a new program, a new sequence space
		this.closed = false;
		try {
			const manifest = await transport.manifest();
			const violations = validateManifest(manifest);
			if (violations.length > 0)
				throw new Error(`the program's manifest does not validate: ${violations.join("; ")}`);
			this.applyManifest(manifest);
			const content = await transport.content();
			this._identity = content.identity;
			// every decision the program offers, by default: policy forbid is never asked (sections 5.4 and 10), and a
			// program may offer a harness fewer than it declares (hello.claimable)
			const offered = manifest.decisions.filter((d) => d.policy !== "forbid").map((d) => d.name);
			const claimable = transport.hello.claimable;
			const wanted =
				this.options.claims.length > 0
					? this.options.claims
					: claimable === undefined
						? offered
						: offered.filter((name) => claimable.includes(name));
			if (wanted.length > 0) await this.claim(wanted, this.options.claimTimeoutMs);
			this.wire(transport);
			// a program at a touchpoint spoke before any of this: the transport held it, and delivers it now
			transport.start?.();
		} catch (error) {
			this.lastError = errorMessage(error);
			if (this.transport === transport) this.transport = undefined;
			transport.close(this.lastError);
			throw error;
		}
		this.ring.note(`# attached to ${transport.hello.name} as ${transport.hello.connection}`);
		return transport.hello;
	}

	/** Close the connection; the stub settles what was pending as detached, with `reason`. */
	detach(reason: string): void {
		const transport = this.transport;
		this.transport = undefined;
		for (const off of this.unsubscribe.splice(0)) off();
		this.pending.clear();
		this.pendingTurns.clear();
		this.pendingTouchpoints.clear();
		this.claims = [];
		if (transport?.open) transport.close(reason);
		if (transport !== undefined) this.detached(reason);
	}

	private detached(reason: string): void {
		for (const waiter of this.detachWaiters.splice(0)) waiter();
		try {
			this.onDetach?.(reason);
		} catch {
			// the front end's failure stays with the front end
		}
	}

	/** Who waits for the program to go (an attach-form stop watching its window). */
	private detachWaiters: Array<() => void> = [];

	/** The front end is going away: detach, drop watches and timers, release waiters. */
	shutdown(reason: string): void {
		this.closed = true;
		this.detach(reason);
		this.stopPolling();
		if (this.budgetTimer !== undefined) {
			clearTimeout(this.budgetTimer);
			this.budgetTimer = undefined;
		}
		this.watchList.splice(0);
		for (const timer of this.timerList) clearTimeout(timer.handle);
		this.timerList.splice(0);
		this.scheduler.clear();
		this.releaseWaiters();
	}

	private wire(transport: StubTransport): void {
		this.unsubscribe.push(
			transport.on("event", (event) => {
				if (this.transport !== transport) return;
				if (transport.denseSeq && this.lastSeq > 0 && event.seq > this.lastSeq + 1) {
					const dropped = event.seq - this.lastSeq - 1;
					this.ring.note(`[abai.events.dropped ${dropped}]`);
					this.wake("event", `abai.events.dropped count=${dropped}`);
				}
				this.lastSeq = event.seq;
				this.ring.push(event);
				const decl = this._manifest?.events.find((e) => e.name === event.name);
				if (
					ALWAYS_WAKE.has(event.name) ||
					this.options.wakes.includes(event.name) ||
					wakesFor(decl?.wakes, event.payload)
				) {
					this.wake("event", this.eventLine(event));
				}
			}),
			transport.on("decision", (decision) => {
				if (this.transport !== transport) return;
				this.onDecision(decision);
			}),
			transport.on("decision_timeout", (id, name) => {
				const entry = this.pending.get(id);
				if (!entry) return;
				entry.expired = true;
				this.pending.delete(id);
				this.wake("expired", `decision ${id} ${name} expired: the program applied the default`);
			}),
			transport.on("decision_rejected", (id, name, error) => {
				if (this.transport !== transport) return;
				// answered already (the harness validates first), so nothing is pending; the agent learns its answer did not land
				this.pending.delete(id);
				this.ring.note(`# decision ${id} ${name} rejected by the program: ${error}`);
				this.wake(
					"rejected",
					`decision ${id} ${name} was rejected by the program (${error}); it applied the default`,
				);
			}),
			transport.on("turn", (turn) => {
				if (this.transport !== transport) return;
				// beyond the attention budget a turn returns at once with nothing done, audited with reason budget (5.6)
				if (!this.scheduler.allowed(this.now())) {
					this.ring.note(`# turn ${turn.id} ${turn.name} returned at once: the wake budget is spent`);
					transport.endTurn(turn.id, "budget");
					return;
				}
				this.pendingTurns.set(turn.id, turn);
				const due = Math.max(0, Math.round((turn.deadline - this.now()) / 1000));
				const content = turn.content === undefined ? "" : `\n${turn.content}`;
				this.wake("turn", `turn ${turn.id} ${turn.name} due in ${due}s${content}`, turn.id);
			}),
			transport.on("touchpoint", (touchpoint) => {
				if (this.transport !== transport) return;
				this.pendingTouchpoints.set(touchpoint.id, touchpoint);
				if (touchpoint.kind === "session") {
					// the person's loop, never a wake for the agent: a front end that exists takes it now, and one
					// built after the attach (the sidecar verbs) finds it in pendingTouchpointList()
					if (!this.onSession) return;
					try {
						this.onSession(touchpoint);
					} catch {
						// the front end's failure stays with the front end
					}
					return;
				}
				const content = touchpoint.content === undefined ? "" : `\n${touchpoint.content}`;
				this.wake("touchpoint", `${touchpoint.kind} ${touchpoint.id}${content}`, touchpoint.id);
			}),
			transport.on("claims_released", (names, reason) => {
				if (this.transport !== transport) return;
				this.claims = this.claims.filter((name) => !names.includes(name));
				this.resolvePending("claims released by the program", names);
				const text = `the program released your claims (${reason}): ${names.join(", ")}`;
				this.wake("released", text);
				this.notice(`abai: ${text}`);
			}),
			transport.on("close", (reason) => {
				if (this.transport !== transport) return;
				this.transport = undefined;
				this.claims = [];
				this.lastError = reason ?? null;
				this.resolvePending("the program disconnected");
				this.pendingTurns.clear();
				this.pendingTouchpoints.clear();
				this.ring.note(`# disconnected${reason ? `: ${reason}` : ""}`);
				this.wake(
					"disconnect",
					`disconnected from the program${reason ? `: ${reason}` : ""}; abai_attach reattaches`,
				);
				this.detached(reason ?? "the program disconnected");
			}),
		);
	}

	private renderLine(message: unknown): string {
		const event = message as Partial<TransportEvent>;
		if (typeof event.name === "string" && typeof event.seq === "number")
			return this.eventLine(event as TransportEvent);
		return preview(message, 400);
	}

	private eventLine(event: TransportEvent): string {
		const decl = this._manifest?.events.find((e) => e.name === event.name);
		const keys = decl ? Object.keys(decl.payload).slice(0, 4) : Object.keys(event.payload ?? {}).slice(0, 4);
		const parts = keys
			.filter((key) => event.payload?.[key] !== undefined)
			.map((key) => `${key}=${preview(event.payload?.[key], 80)}`);
		const flag = event.truncated ? " (truncated)" : "";
		return parts.length === 0 ? `${event.name}${flag}` : `${event.name} ${parts.join(" ")}${flag}`;
	}

	private wake(source: WakeSource, line: string, id?: string): void {
		this.scheduler.note(source, line, id);
		this.armBudgetRetry();
		this.releaseWaiters();
		try {
			this.onWake?.();
		} catch {
			// a front end's failure must not reach the transport listener
		}
	}

	private notice(text: string): void {
		try {
			this.onNotice?.(text);
		} catch {
			// same
		}
	}

	/** When the budget holds a wake back, wake the front end again as soon as the window frees. */
	private armBudgetRetry(): void {
		if (this.budgetTimer !== undefined || this.scheduler.due(this.now())) return;
		const wait = this.scheduler.nextAllowedIn(this.now());
		if (wait === undefined) return;
		this.budgetTimer = setTimeout(() => {
			this.budgetTimer = undefined;
			this.releaseWaiters();
			try {
				this.onWake?.();
			} catch {
				// a front end's failure stays with the front end
			}
			this.armBudgetRetry();
		}, wait + 1);
		this.budgetTimer.unref();
	}

	private releaseWaiters(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) waiter();
	}

	// -----------------------------------------------------------------------
	// Deliveries (parking)
	// -----------------------------------------------------------------------

	/** The next delivery if one is due now. */
	takeDelivery(): Delivery | undefined {
		return this.scheduler.take(this.ring, this.now());
	}

	/**
	 * Wait up to `timeoutMs` for a delivery (the MCP form parks here). An
	 * aborted signal ends the wait at once with nothing taken, so a delivery
	 * that arrives later is still there for the next park.
	 */
	async nextDelivery(timeoutMs: number, signal?: AbortSignal): Promise<Delivery | undefined> {
		const deadline = this.now() + timeoutMs;
		while (!this.closed && !signal?.aborted) {
			const delivery = this.takeDelivery();
			if (delivery) return delivery;
			const remaining = deadline - this.now();
			if (remaining <= 0) return undefined;
			const check = Math.min(remaining, 1000);
			await new Promise<void>((resolve) => {
				let settled = false;
				const waiter = (): void => {
					clearTimeout(timer);
					done();
				};
				const done = (): void => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", done);
					// a tick or an abort that ends this wait takes its waiter with it, or idle parks would pile them up
					const index = this.waiters.indexOf(waiter);
					if (index !== -1) this.waiters.splice(index, 1);
					resolve();
				};
				const timer = setTimeout(done, check);
				timer.unref();
				signal?.addEventListener("abort", done, { once: true });
				this.waiters.push(waiter);
			});
		}
		return undefined;
	}

	/**
	 * A delivery handed the agent decisions, turns and touchpoints by id; the
	 * step that received them is over (the agent-loop run ended, or the MCP
	 * agent parked again), so what it did not settle is settled now: turns
	 * end, touchpoints end, a decision left unanswered takes its default with
	 * `reason`. One rule for both front ends.
	 */
	settleDelivered(ids: readonly string[], reason: string): void {
		const decisions = new Set(this.pending.keys());
		const turns = new Set(this.pendingTurns.keys());
		const touchpoints = new Set(this.pendingTouchpoints.keys());
		for (const id of ids) {
			try {
				if (decisions.has(id)) this.defaultDecision(id, reason);
				else if (turns.has(id)) this.endTurn(id);
				else if (touchpoints.has(id)) this.endTouchpoint(id);
			} catch {
				// already settled by the program
			}
		}
	}

	/**
	 * Something seen from outside the program (section 5.7): a line of its
	 * output, its exit. The harness's own, with its own sequence, in the
	 * transcript like an event; it wakes the agent when `wake` says so or the
	 * name always does.
	 */
	observed(name: string, payload: Record<string, unknown>, wake = false): void {
		// a line of the harness's own: it carries the sequence of the last program event before it, like a note,
		// so the program's numbering (and `since`) is never disturbed by what the launcher saw
		const event: TransportEvent = { seq: this.ring.lastSeq, name, payload, truncated: false, ts: this.now() };
		this.ring.push(event);
		if (wake || ALWAYS_WAKE.has(name) || this.options.wakes.includes(name)) this.wake("event", this.eventLine(event));
	}

	/**
	 * The lifecycle channel (section 5.5). A harness that launched the program
	 * drives every operation through its launcher; attached to a program it
	 * did not start, it may ask the program's status and request a graceful
	 * stop, and nothing more.
	 */
	async lifecycle(op: string, reason: string, consent?: Consent): Promise<unknown> {
		requireReason(reason, "a lifecycle operation");
		if (this.launcher) return this.launcher.lifecycle(op, reason, consent);
		if (op !== "status" && op !== "stop") {
			throw new Error(
				`lifecycle ${op} needs the harness that launched the program; attached, only status and stop are available (section 5.5)`,
			);
		}
		if (op === "status") return this.connected().lifecycle(op, reason, consent);
		// attached, a stop is a request: the program's graceful window says whether it stopped, and 5.5 wants it said
		await this.connected().lifecycle(op, reason, consent);
		const windowMs = durationMs(this._manifest?.lifecycle?.stop?.graceful ?? "5s");
		const gone = await this.awaitDetach(windowMs);
		return gone
			? "stop requested; the program ended within its graceful window"
			: `stop requested, but the program is still connected after ${windowMs} ms: it did not stop (section 5.5)`;
	}

	/** Resolves true when the program disconnects within `ms`, false when it is still connected then. */
	awaitDetach(ms: number): Promise<boolean> {
		if (!this.attached) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			const waiter = (): void => {
				clearTimeout(timer);
				resolve(true);
			};
			const timer = setTimeout(() => {
				const at = this.detachWaiters.indexOf(waiter);
				if (at >= 0) this.detachWaiters.splice(at, 1);
				resolve(false);
			}, ms);
			this.detachWaiters.push(waiter);
		});
	}

	/** @internal The program's own lifecycle operation over the transport, for the launcher's use. */
	transportLifecycle(op: string, reason: string, consent?: Consent): Promise<unknown> {
		return this.connected().lifecycle(op, reason, consent);
	}

	/** A front end with no person's loop (the MCP form) takes a session touchpoint as a wake, like install. */
	noteTouchpoint(touchpoint: TransportTouchpoint): void {
		const content = touchpoint.content === undefined ? "" : `\n${touchpoint.content}`;
		this.wake("touchpoint", `${touchpoint.kind} ${touchpoint.id}${content}`, touchpoint.id);
	}

	// -----------------------------------------------------------------------
	// Channels
	// -----------------------------------------------------------------------

	private connected(): StubTransport {
		if (!this.transport || !this.transport.open)
			throw new Error("not attached to a program (abai_attach reattaches)");
		return this.transport;
	}

	async cells(names?: string[]): Promise<Record<string, unknown>> {
		const reading = await this.connected().cells(names && names.length > 0 ? names : undefined);
		const cells: Record<string, unknown> = {};
		for (const [name, cell] of Object.entries(reading.cells)) cells[name] = cell.value;
		return cells;
	}

	/** The knob's declaration, for the front end's consent decision. */
	knob(name: string) {
		return this._manifest?.cells.find((cell) => cell.name === name && cell.access === "readwrite");
	}

	async setCell(cell: string, value: unknown, reason: string, consent?: Consent): Promise<unknown> {
		const outcome = await this.connected().setCell(cell, value, requireReason(reason, "a knob write"), consent);
		if (outcome.outcome === "failed") throw new Error(outcome.error ?? `${cell} was not written`);
		return outcome.value;
	}

	capability(name: string): CapabilityDecl | undefined {
		return this._manifest?.capabilities.find((capability) => capability.name === name);
	}

	/** Call a capability; the front end decides consent before calling this and states it. */
	async call(
		name: string,
		params: Record<string, unknown> | undefined,
		reason: string,
		consent?: Consent,
	): Promise<unknown> {
		const capability = this.capability(name);
		if (!capability) throw new Error(`${name} is not a capability of the program (see abai_prompt or the manifest)`);
		if (capability.policy === "forbid") throw new Error(`the program's policy forbids ${name}`);
		if (this.options.denyMutate && capability.effect === "mutate") {
			throw new Error(`mutate capabilities are refused in this harness (${name})`);
		}
		return this.connected().call(
			name,
			params,
			requireReason(reason, "a capability call"),
			TOOL_REQUEST_TIMEOUT_MS,
			consent,
		);
	}

	async audit(limit?: number): Promise<unknown> {
		return this.connected().audit(limit);
	}

	// -----------------------------------------------------------------------
	// Decisions, turns, touchpoints
	// -----------------------------------------------------------------------

	currentClaims(): string[] {
		return [...this.claims];
	}

	async claim(names: string[], timeoutMs?: number): Promise<string[]> {
		const transport = this.connected();
		let shortest = Number.POSITIVE_INFINITY;
		for (const name of names) {
			const decl = this._manifest?.decisions.find((d) => d.name === name);
			if (this._manifest && !decl) throw new Error(`unknown decision: ${name}`);
			if (decl?.policy === "forbid")
				throw new Error(`decision ${name} is forbidden by policy: the agent is never asked`);
			if (transport.hello.claimable !== undefined && !transport.hello.claimable.includes(name))
				throw new Error(`the program does not offer decision ${name} to a harness`);
			if (decl) shortest = Math.min(shortest, durationMs(decl.timeout));
		}
		// a claim's timeout may shorten the wait, never lengthen it past the manifest's
		const bounded = timeoutMs === undefined ? undefined : Math.min(timeoutMs, shortest);
		const claimed = await transport.claim(names, bounded);
		this.claims = claimed;
		return claimed;
	}

	async release(names?: string[]): Promise<string[]> {
		const transport = this.connected();
		const released = await transport.release(names);
		this.claims = this.claims.filter((name) => !released.includes(name));
		this.resolvePending("claim released", released);
		return released;
	}

	private onDecision(decision: TransportDecision): void {
		const decl = this._manifest?.decisions.find((d) => d.name === decision.name);
		const summary = summarizeDecision(decision.name, decision.context);
		const entry: PendingDecision = {
			id: decision.id,
			hook: decision.name,
			payload: decision.context,
			summary,
			deadline: decision.deadline,
			expired: false,
		};
		this.pending.set(decision.id, entry);
		const due = Math.max(0, Math.round((decision.deadline - this.now()) / 1000));
		const options = decl?.options ? ` options: ${decl.options.join(", ")}` : "";
		this.wake(
			"decision",
			`decision ${decision.id} ${decision.name} due in ${due}s: ${summary}${options}`,
			decision.id,
		);
	}

	pendingDecisions(): PendingDecision[] {
		return [...this.pending.values()].map((entry) => ({ ...entry }));
	}

	decisionFor(id: string): DecisionDecl | undefined {
		const entry = this.pending.get(id);
		return entry ? this._manifest?.decisions.find((d) => d.name === entry.hook) : undefined;
	}

	/** Answer a pending decision; validated against the manifest before it is sent. `consent` is stated for a `confirm` decision. */
	decide(id: string, answer: unknown, reason: string, consent?: Consent): PendingDecision {
		const entry = this.pending.get(id);
		if (!entry)
			throw new Error(`no pending decision ${id} (it may have expired; abai_status lists the pending ones)`);
		if (this.now() > entry.deadline - DECISION_MARGIN_MS) {
			this.pending.delete(id);
			throw new Error(`decision ${id} is past its deadline; the program applied the default`);
		}
		const decision = this._manifest?.decisions.find((d) => d.name === entry.hook);
		if (decision) {
			const problem = validateAnswer(decision, answer);
			if (problem !== undefined) throw new Error(problem);
		}
		requireReason(reason, "a decision");
		this.pending.delete(id);
		this.connected().answer(id, answer, reason, consent);
		return { ...entry };
	}

	/** Let the program apply a pending decision's default, with the reason recorded. */
	defaultDecision(id: string, reason: string): void {
		const entry = this.pending.get(id);
		if (!entry) throw new Error(`no pending decision ${id}`);
		this.pending.delete(id);
		this.connected().answer(id, null, requireReason(reason, "a decision"));
	}

	private resolvePending(reason: string, names?: string[]): void {
		for (const [id, entry] of [...this.pending]) {
			if (names && !names.includes(entry.hook)) continue;
			this.pending.delete(id);
			if (this.transport?.open) {
				try {
					this.transport.answer(id, null, reason);
				} catch {
					// the stub may have settled it already
				}
			}
		}
	}

	pendingTurnList(): TransportTurn[] {
		return [...this.pendingTurns.values()];
	}

	/** The front end finished a turn: hand control back to the program. */
	endTurn(id: string): void {
		if (!this.pendingTurns.delete(id)) return;
		this.transport?.endTurn(id);
	}

	pendingTouchpointList(): TransportTouchpoint[] {
		return [...this.pendingTouchpoints.values()];
	}

	endTouchpoint(id: string): void {
		if (!this.pendingTouchpoints.delete(id)) return;
		this.transport?.endTouchpoint(id);
	}

	// -----------------------------------------------------------------------
	// Watches and timers
	// -----------------------------------------------------------------------

	addWatch(cell: string, op: WatchOp, value: unknown, cadenceMs?: number): WatchInfo {
		if (!WATCH_OPS.includes(op)) throw new Error(`unknown watch op ${op} (one of: ${WATCH_OPS.join(", ")})`);
		if ((op === "eq" || op === "ne" || op === "gt" || op === "lt" || op === "crossed") && value === undefined) {
			throw new Error(`watch op ${op} needs a value`);
		}
		const declared = this._manifest?.cells.find((c) => c.name === cell);
		if (this._manifest && !declared) throw new Error(`unknown cell: ${cell}`);
		const cadence = Math.max(MIN_WATCH_CADENCE_MS, cadenceMs ?? declared?.cadence ?? DEFAULT_WATCH_CADENCE_MS);
		const entry: WatchEntry = {
			id: this.nextWatchId++,
			cell,
			op,
			value,
			cadenceMs: cadence,
			sampled: false,
			held: false,
		};
		this.watchList.push(entry);
		this.restartPolling();
		return this.watchInfo(entry);
	}

	removeWatch(id: number): boolean {
		const index = this.watchList.findIndex((watch) => watch.id === id);
		if (index === -1) return false;
		this.watchList.splice(index, 1);
		this.restartPolling();
		return true;
	}

	watches(): WatchInfo[] {
		return this.watchList.map((watch) => this.watchInfo(watch));
	}

	private watchInfo(watch: WatchEntry): WatchInfo {
		const { sampled: _s, held: _h, last: _l, ...info } = watch;
		return info;
	}

	/** One interval at the shortest cadence; none without watches. */
	private restartPolling(): void {
		this.stopPolling();
		if (this.watchList.length === 0) return;
		const cadence = Math.min(...this.watchList.map((watch) => watch.cadenceMs));
		this.pollHandle = setInterval(() => void this.poll(), cadence);
		this.pollHandle.unref();
	}

	private stopPolling(): void {
		if (!this.pollHandle) return;
		clearInterval(this.pollHandle);
		this.pollHandle = undefined;
	}

	/** One sample of every watched cell; edge-triggered wakes; one at a time. Never throws. */
	async poll(): Promise<void> {
		if (this.polling || this.watchList.length === 0 || !this.attached) return;
		this.polling = true;
		let cells: Record<string, unknown>;
		try {
			cells = await this.cells();
		} catch {
			return;
		} finally {
			// a read that never settles is bounded by the transport's request timeout; either way the next poll may run
			this.polling = false;
		}
		for (const watch of [...this.watchList]) {
			const current = cells[watch.cell];
			const holds = watchHolds(watch.op, current, watch.value, watch.last, watch.sampled);
			const fires = watch.op === "changed" || watch.op === "crossed" ? holds : holds && !watch.held;
			watch.held = holds;
			watch.last = current;
			watch.sampled = true;
			if (fires) {
				const target = watch.value === undefined ? "" : ` ${preview(watch.value, 40)}`;
				this.wake("watch", `watch ${watch.id} ${watch.cell} ${watch.op}${target}: now ${preview(current, 80)}`);
			}
		}
	}

	addTimer(seconds: number, note: string): TimerInfo {
		if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400)
			throw new Error("a timer takes 0 < seconds <= 86400");
		const id = this.nextTimerId++;
		const dueAt = this.now() + seconds * 1000;
		const handle = setTimeout(() => {
			const index = this.timerList.findIndex((timer) => timer.id === id);
			if (index !== -1) this.timerList.splice(index, 1);
			this.wake("timer", `timer ${id}${note ? `: ${note}` : ""}`);
		}, seconds * 1000);
		handle.unref();
		this.timerList.push({ id, dueAt, note, handle });
		return { id, dueAt, note };
	}

	timers(): TimerInfo[] {
		return this.timerList.map(({ handle: _h, ...info }) => info);
	}

	// -----------------------------------------------------------------------
	// Status and prompt
	// -----------------------------------------------------------------------

	status(): HarnessStatus {
		const hello = this.hello;
		return {
			attached: this.attached,
			program:
				this.attached && hello
					? {
							name: hello.name,
							...(hello.pid === undefined ? {} : { pid: hello.pid }),
							...(hello.cwd === undefined ? {} : { cwd: hello.cwd }),
							mode: hello.modes[0] ?? "unknown",
							connection: hello.connection,
						}
					: null,
			claims: this.currentClaims(),
			pending: this.pendingDecisions(),
			turns: [...this.pendingTurns.values()].map(({ id, name, deadline }) => ({ id, name, deadline })),
			touchpoints: [...this.pendingTouchpoints.values()].map(({ id, kind }) => ({ id, kind })),
			watches: this.watches(),
			timers: this.timers(),
			budget: { perMinute: this.scheduler.budget, used: this.scheduler.used(this.now()) },
			wakesPending: this.scheduler.pendingNotes,
			transcriptLines: this.ring.size,
			lastError: this.lastError,
			...(this.launcher === undefined ? {} : { launch: this.launcher.state() }),
		};
	}

	/** One line for a footer or a status command. */
	statusLine(): string {
		const status = this.status();
		if (!status.attached || !status.program)
			return `abai: not attached${status.lastError ? ` (${status.lastError})` : ""}`;
		const parts = [`abai: ${status.program.name} ${status.program.connection}`];
		if (status.launch) parts.push(status.launch.running ? `launched pid ${status.launch.pid}` : "launched, exited");
		if (status.pending.length > 0) parts.push(`pending ${status.pending.length}`);
		if (status.turns.length > 0) parts.push(`turns ${status.turns.length}`);
		if (status.watches.length > 0) parts.push(`watches ${status.watches.length}`);
		if (status.timers.length > 0) parts.push(`timers ${status.timers.length}`);
		if (status.budget.perMinute !== undefined) parts.push(`budget ${status.budget.used}/${status.budget.perMinute}`);
		return parts.join(" · ");
	}

	/** The composed system prompt; the manifest must be loaded (attach) or given to the constructor. */
	systemPrompt(addendum?: string): string {
		const manifest = this._manifest;
		if (!manifest) throw new Error("no manifest yet: attach first");
		return composeSystemPrompt({ identity: this._identity, manifest, options: this.options, addendum });
	}

	instructions(): string {
		const manifest = this._manifest;
		if (!manifest) throw new Error("no manifest yet: attach first");
		return composeInstructions({ identity: this._identity, manifest, options: this.options });
	}
}
