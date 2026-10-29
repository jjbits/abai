// The harness's attention machinery (abaigrammar section 5.6): the transcript
// ring, the wake scheduler with its budget, watches, timers, and the decision
// summaries and answer checks. Pure: no transport, no model.
import { type DecisionDecl, schemaProblem } from "abai";

export type WakeSource =
	| "event"
	| "watch"
	| "timer"
	| "decision"
	| "expired"
	| "released"
	| "rejected"
	| "serialize_error"
	| "snapshot"
	| "turn"
	| "touchpoint"
	| "disconnect";

export type WatchOp = "changed" | "eq" | "ne" | "gt" | "lt" | "crossed";
export const WATCH_OPS: readonly WatchOp[] = ["changed", "eq", "ne", "gt", "lt", "crossed"];

/** Wake lines kept per delivery; the rest are folded into a count. */
export const MAX_WAKE_LINES = 40;
/** Transcript lines carried by a delivery. */
export const MAX_DELIVERY_LINES = 40;
/** Transcript lines kept in the ring. */
export const RING_CAPACITY = 2000;
/** The budget window (grammar: wakes per period). */
export const BUDGET_WINDOW_MS = 60_000;
export const MIN_WATCH_CADENCE_MS = 100;
export const DEFAULT_WATCH_CADENCE_MS = 1000;
export const CONNECT_TIMEOUT_MS = 2000;
/** Requests made while attaching and while polling; a stalled program must not hang the harness. */
export const ATTACH_REQUEST_TIMEOUT_MS = 10_000;
export const POLL_REQUEST_TIMEOUT_MS = 5000;
/** Requests made by a tool. */
export const TOOL_REQUEST_TIMEOUT_MS = 120_000;
/** A decision answered this close to its deadline is treated as late: the host may already have timed it out. */
export const DECISION_MARGIN_MS = 250;
export const SUMMARY_CAP = 2048;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cap(text: string, max = SUMMARY_CAP): string {
	return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more)`;
}

function preview(value: unknown, max = 200): string {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	return cap(text.replace(/\s+/g, " "), max);
}

// ---------------------------------------------------------------------------
// The transcript ring
// ---------------------------------------------------------------------------

export interface TranscriptLine {
	seq: number;
	text: string;
}

/** Characters the default renderer keeps of one message. */
const DEFAULT_RENDER_CHARS = 400;

function defaultRender(message: unknown): string[] {
	return [(JSON.stringify(message) ?? String(message)).slice(0, DEFAULT_RENDER_CHARS)];
}

/** The program's stream rendered one line per thing, newest last, bounded. */
export class TranscriptRing {
	private readonly render: (message: unknown) => string[];
	private readonly lines: TranscriptLine[] = [];
	private partial = "";
	private partialSeq = 0;
	private seq = 0;
	private added = 0;

	/** `render` gives the lines to append for one pushed message. */
	constructor(render: (message: unknown) => string[] = defaultRender) {
		this.render = render;
	}

	/** The highest event sequence number seen. */
	get lastSeq(): number {
		return this.seq;
	}

	get size(): number {
		return this.lines.length;
	}

	/** Lines ever added; a delivery remembers this to take what came after it. */
	get totalAdded(): number {
		return this.added;
	}

	push(message: unknown): void {
		const seq = typeof (message as { seq?: unknown })?.seq === "number" ? (message as { seq: number }).seq : this.seq;
		this.append(
			this.render(message)
				.map((line) => `${line}\n`)
				.join(""),
			seq,
		);
	}

	/** A line of the harness's own (a note, a status change). */
	note(text: string): void {
		this.append(`${text}\n`, this.seq);
	}

	/** Close an open line. */
	flush(): void {
		if (this.partial !== "") {
			this.add(this.partial, this.partialSeq);
			this.partial = "";
		}
	}

	private append(text: string, seq: number): void {
		if (text === "") return;
		const combined = this.partial + text;
		const pieces = combined.split("\n");
		this.partial = pieces.pop() ?? "";
		if (this.partial !== "") this.partialSeq = Math.max(this.partialSeq, seq);
		for (const piece of pieces) this.add(piece, seq);
	}

	private add(text: string, seq: number): void {
		this.seq = Math.max(this.seq, seq);
		this.lines.push({ seq: this.seq, text });
		this.added += 1;
		if (this.lines.length > RING_CAPACITY) this.lines.splice(0, this.lines.length - RING_CAPACITY);
	}

	/** The last `count` lines, optionally only those after event sequence `since`. */
	last(count: number, since?: number): TranscriptLine[] {
		const from = since === undefined ? this.lines : this.lines.filter((line) => line.seq > since);
		return from.slice(-count);
	}

	/** Every line after event sequence `since`. */
	after(since: number): TranscriptLine[] {
		return this.lines.filter((line) => line.seq > since);
	}

	/** Every line added after the first `count` lines ever added (bounded by the ring). */
	sinceAdded(count: number): TranscriptLine[] {
		const newer = this.added - count;
		if (newer <= 0) return [];
		return this.lines.slice(-Math.min(newer, this.lines.length));
	}
}

// ---------------------------------------------------------------------------
// The wake scheduler (attention, grammar section 5.6)
// ---------------------------------------------------------------------------

export interface WakeNote {
	source: WakeSource;
	line: string;
	/** The decision, turn or touchpoint this wake is about, when it is about one. */
	id?: string;
}

export interface Delivery {
	text: string;
	notes: number;
	folded: number;
	decisions: number;
	/** The decisions, turns and touchpoints this delivery carries. */
	ids: string[];
}

/**
 * Pure: notes wakes, coalesces them into one delivery, keeps the budget.
 * Beyond the budget, event and watch wakes wait for the window (folded into
 * one delivery; past the line cap only their count is kept); a decision is
 * always due.
 */
export class WakeScheduler {
	private notes: WakeNote[] = [];
	private folded = 0;
	private foldedIds: string[] = [];
	private deliveries: number[] = [];
	private lastCount = 0;
	private budgetPerMinute: number | undefined;
	private readonly now: () => number;

	constructor(budgetPerMinute: number | undefined, now: () => number = Date.now) {
		this.budgetPerMinute = budgetPerMinute;
		this.now = now;
	}

	get budget(): number | undefined {
		return this.budgetPerMinute;
	}

	set budget(value: number | undefined) {
		this.budgetPerMinute = value;
	}

	get pendingNotes(): number {
		return this.notes.length + this.folded;
	}

	note(source: WakeSource, line: string, id?: string): void {
		if (source !== "decision" && this.notes.length >= MAX_WAKE_LINES) {
			this.folded += 1;
			if (id !== undefined) this.foldedIds.push(id);
			return;
		}
		this.notes.push(id === undefined ? { source, line } : { source, line, id });
	}

	/** Deliveries in the current window. */
	used(now = this.now()): number {
		this.deliveries = this.deliveries.filter((at) => now - at < BUDGET_WINDOW_MS);
		return this.deliveries.length;
	}

	allowed(now = this.now()): boolean {
		return this.budgetPerMinute === undefined || this.used(now) < this.budgetPerMinute;
	}

	/** Milliseconds until the budget window admits a delivery; undefined when it does now or nothing waits. */
	nextAllowedIn(now = this.now()): number | undefined {
		if (this.allowed(now) || this.deliveries.length === 0) return undefined;
		return Math.max(0, this.deliveries[0] + BUDGET_WINDOW_MS - now);
	}

	hasDecision(): boolean {
		return this.notes.some((note) => note.source === "decision");
	}

	/** Forget the decision lines (the decisions were resolved by a replacement). */
	dropDecisions(): void {
		this.notes = this.notes.filter((note) => note.source !== "decision");
	}

	/** Whether a delivery may go now. */
	due(now = this.now()): boolean {
		if (this.notes.length === 0 && this.folded === 0) return false;
		return this.hasDecision() || this.allowed(now);
	}

	/** Build the delivery and reset. Undefined when nothing is due. */
	take(ring: TranscriptRing, now = this.now()): Delivery | undefined {
		if (!this.due(now)) return undefined;
		const notes = this.notes;
		const folded = this.folded;
		const ids = [...notes.flatMap((note) => (note.id === undefined ? [] : [note.id])), ...this.foldedIds];
		this.notes = [];
		this.folded = 0;
		this.foldedIds = [];
		this.deliveries.push(now);
		ring.flush();
		const since = ring.sinceAdded(this.lastCount);
		this.lastCount = ring.totalAdded;
		const shown = since.slice(-MAX_DELIVERY_LINES);
		const lines: string[] = [`[abai wake] ${notes.length + folded} wake${notes.length + folded === 1 ? "" : "s"}`];
		for (const note of notes) lines.push(`- ${note.line}`);
		if (folded > 0) lines.push(`- ${folded} more wake${folded === 1 ? "" : "s"} (folded; the transcript has them)`);
		if (since.length > 0) {
			const header =
				since.length > shown.length
					? `Transcript since the last wake (${since.length} lines, the last ${shown.length}; abai_transcript has the rest):`
					: `Transcript since the last wake (${since.length} line${since.length === 1 ? "" : "s"}):`;
			lines.push(header, ...shown.map((line) => line.text));
		}
		return {
			text: `${lines.join("\n")}\n`,
			notes: notes.length,
			folded,
			decisions: notes.filter((note) => note.source === "decision").length,
			ids,
		};
	}

	/** Forget everything noted (a detach). */
	clear(): void {
		this.notes = [];
		this.folded = 0;
		this.foldedIds = [];
	}
}

// ---------------------------------------------------------------------------
// Decisions, watches, timers
// ---------------------------------------------------------------------------

export interface PendingDecision {
	id: string;
	hook: string;
	payload: unknown;
	summary: string;
	/** Epoch ms. */
	deadline: number;
	expired: boolean;
}

export interface WatchInfo {
	id: number;
	cell: string;
	op: WatchOp;
	value?: unknown;
	cadenceMs: number;
	last?: unknown;
}

export interface TimerInfo {
	id: number;
	dueAt: number;
	note: string;
}

/** Characters of one context field a summary shows. */
const SUMMARY_FIELD_CHARS = 80;

/** A decision's summary for a wake line: its name and its context's fields, never the transcript. */
export function summarizeDecision(name: string, context: unknown): string {
	const fields = isRecord(context) ? Object.entries(context) : [];
	const parts = fields.map(([key, value]) => `${key}=${preview(value, SUMMARY_FIELD_CHARS)}`);
	return cap([name, ...parts].join(" "));
}

/** Validate a decision answer against the manifest's options or answer schema before it is sent. */
export function validateAnswer(decision: DecisionDecl, answer: unknown): string | undefined {
	if (decision.options !== undefined) {
		if (typeof answer !== "string" || !decision.options.includes(answer))
			return `answer must be one of: ${decision.options.join(", ")}`;
		return undefined;
	}
	// one rule on both sides: the stub's (every declared field required unless nullable, none undeclared)
	if (decision.answer !== undefined) return schemaProblem(decision.answer, answer, "answer");
	return undefined;
}

function compare(a: unknown, b: unknown): number | undefined {
	if (typeof a === "number" && typeof b === "number") return a - b;
	if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
	return undefined;
}

/** Whether a watch's condition holds for a value. */
export function watchHolds(op: WatchOp, current: unknown, value: unknown, last: unknown, sampled: boolean): boolean {
	switch (op) {
		case "changed":
			return sampled && JSON.stringify(current) !== JSON.stringify(last);
		case "eq":
			return JSON.stringify(current) === JSON.stringify(value);
		case "ne":
			return JSON.stringify(current) !== JSON.stringify(value);
		case "gt": {
			const c = compare(current, value);
			return c !== undefined && c > 0;
		}
		case "lt": {
			const c = compare(current, value);
			return c !== undefined && c < 0;
		}
		case "crossed": {
			if (!sampled) return false;
			const before = compare(last, value);
			const after = compare(current, value);
			if (before === undefined || after === undefined) return false;
			return (before < 0 && after >= 0) || (before >= 0 && after < 0);
		}
		default:
			return false;
	}
}
