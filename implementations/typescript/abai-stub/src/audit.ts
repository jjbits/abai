// The audit log (abaigrammar section 10).
//
// One JSON line per act of control: a mutate capability call, a knob write
// by any path, a decision's outcome, and the counters of defaulted decisions
// flushed at attach, close and exit. Written synchronously, one line per
// act: acts are rare and a partial line on a crash is worse than a syscall.
// Nothing here throws into the agent: the first failure latches the log off,
// reports once through `onFailure`, and every later append is a no-op.
// `tail` reads the log back for the harness.
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { cutUtf8, type DecisionDecl } from "./manifest/manifest.ts";

export type AuditAct = "capability" | "knob" | "decision" | "turn" | "lifecycle" | "counters";
export type AuditOutcome = "ok" | "error" | "forbidden" | "agent" | "default" | "stub" | "failed";

export interface AuditRecord {
	ts: string;
	pid: number;
	/** The connection that acted (`k1`, `k2`, ...); absent for counters. */
	conn?: string;
	act: AuditAct;
	/** The capability, cell, decision or counter name. */
	name: string;
	/** The request id or hook id. */
	id?: string;
	/** The parameters (capped, see `capValue`). */
	params?: unknown;
	/** A knob's landed value, or a decision answer's summary. */
	value?: unknown;
	outcome: AuditOutcome;
	/** Why a default or stub answer applied, or what a counter counts. */
	cause?: string;
	/** What the harness stated for an act whose policy is `confirm`: approved, auto, or denied. */
	consent?: string;
	/** The agent's stated reason. */
	reason?: unknown;
	error?: unknown;
	/** Milliseconds from dispatch to settle. */
	ms?: number;
	/** Counters only. */
	count?: number;
}

/** Bytes a string or the JSON of a value may take in a record before it is cut. */
export const AUDIT_VALUE_CAP = 512;
/** Bytes `tail` reads from the end of the file. */
export const AUDIT_TAIL_BYTES = 1024 * 1024;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Cap a value for a record: a value whose JSON exceeds the cap becomes
 * `{truncated: true, bytes, head}` with the JSON's first 512 characters, so
 * the record stays valid JSON. A value that cannot be serialized becomes a
 * marker string.
 */
export function capValue(value: unknown): unknown {
	if (value === undefined) return undefined;
	let json: string;
	try {
		json = JSON.stringify(value) ?? "null";
	} catch (error) {
		return `<unserializable: ${errorMessage(error)}>`;
	}
	const bytes = Buffer.byteLength(json, "utf8");
	if (bytes <= AUDIT_VALUE_CAP) return value;
	return { truncated: true, bytes, head: cutUtf8(json, AUDIT_VALUE_CAP) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What an audit record keeps of a decision answer: never the transcript.
 * An options decision keeps the chosen option; any other answer keeps
 * whether it changed something (a non-empty object).
 */
export function summarizeAnswer(decision: DecisionDecl | undefined, answer: unknown): unknown {
	if (answer === undefined) return undefined;
	if (decision?.options && typeof answer === "string") return { option: answer };
	return { changed: Object.keys(isRecord(answer) ? answer : {}).length > 0 };
}

export interface AuditTail {
	records: unknown[];
	/** More records exist than were returned. */
	truncated: boolean;
}

export class AuditLog {
	readonly path: string;
	private readonly onFailure: ((error: string) => void) | undefined;
	private fd: number | undefined;
	private _failed: string | undefined;
	private closed = false;

	constructor(path: string, onFailure?: (error: string) => void) {
		this.path = path;
		this.onFailure = onFailure;
	}

	/** The error that latched the log off, if any. */
	get failed(): string | undefined {
		return this._failed;
	}

	/** Append one record. Never throws; a no-op once the log failed or was closed. */
	append(record: Omit<AuditRecord, "ts" | "pid">): void {
		if (this._failed !== undefined || this.closed) return;
		try {
			if (this.fd === undefined) {
				mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
				this.fd = openSync(this.path, "a", 0o600);
			}
			const full: AuditRecord = { ts: new Date().toISOString(), pid: process.pid, ...record };
			writeSync(this.fd, `${JSON.stringify(full)}\n`);
		} catch (error) {
			this.fail(errorMessage(error));
		}
	}

	private fail(error: string): void {
		this._failed = error;
		this.close();
		try {
			this.onFailure?.(error);
		} catch {
			// a failure callback must not fail the caller
		}
	}

	/** Close the file descriptor; later appends are dropped. Idempotent; safe inside `process.on("exit")`. */
	close(): void {
		this.closed = true;
		if (this.fd === undefined) return;
		const fd = this.fd;
		this.fd = undefined;
		try {
			closeSync(fd);
		} catch {
			// ignore
		}
	}

	/** The last `limit` records, read from the last megabyte of the file. Never throws. */
	tail(limit: number): AuditTail {
		let fd: number | undefined;
		try {
			fd = openSync(this.path, "r");
			const size = fstatSync(fd).size;
			const start = Math.max(0, size - AUDIT_TAIL_BYTES);
			const buffer = Buffer.alloc(size - start);
			let read = 0;
			while (read < buffer.length) {
				const n = readSync(fd, buffer, read, buffer.length - read, start + read);
				if (n === 0) break;
				read += n;
			}
			const lines = buffer.toString("utf8", 0, read).split("\n");
			// the window may start mid-line: drop the first line unless the byte before it ends a line
			if (start > 0) {
				const before = Buffer.alloc(1);
				const n = readSync(fd, before, 0, 1, start - 1);
				if (n !== 1 || before[0] !== 0x0a) lines.shift();
			}
			const records: unknown[] = [];
			for (const line of lines) {
				if (line === "") continue;
				try {
					records.push(JSON.parse(line));
				} catch {
					records.push({ raw: line });
				}
			}
			const truncated = start > 0 || records.length > limit;
			return { records: records.slice(-limit), truncated };
		} catch (error) {
			// no log yet, or a path that can never hold one (the failure is in `failed`)
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") return { records: [], truncated: false };
			return { records: [{ error: errorMessage(error) }], truncated: false };
		} finally {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					// ignore
				}
			}
		}
	}
}
