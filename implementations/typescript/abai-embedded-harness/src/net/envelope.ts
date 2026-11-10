// The aiap v1 envelope (agents-cowork, internal/envelope): the JSON object a
// message travels in over an aiip mailbox. The harness speaks it so an
// abaigram's agent and aiap's agents read each other. It carries no sender:
// the sender is the overlay address the daemon reports, which the tunnel
// authenticated; a name inside the payload would be anyone's to claim.
//
// What is here mirrors the Go package rule for rule: the id shape, the
// caps, what makes an envelope invalid, and how an inbound payload sorts
// into an envelope, a foreign aiap payload (another version, an unknown
// type, an invalid one) or raw bytes shown as a plain message. Nothing is
// dropped silently: every payload becomes one of the three. One known
// difference from Go: its JSON decoder matches field names without regard
// to case, this one does not, so `{"AIAP": 1, ...}` is raw here.
import { randomBytes } from "node:crypto";

export const AIAP_VERSION = 1;
export const MAX_ID_BYTES = 64;
export const MAX_BODY_BYTES = 65_536;
export const MAX_ENVELOPE_BYTES = 262_144;
/** An id a receiving daemon mints for a payload with no envelope; no wire envelope may use the prefix. */
export const RESERVED_ID_PREFIX = "raw-";

export type EnvelopeType = "msg" | "profile" | "profile-query" | "receipt";
const TYPES: ReadonlySet<string> = new Set<EnvelopeType>(["msg", "profile", "profile-query", "receipt"]);

export interface AiapProfile {
	agent?: string;
	project?: string;
	owner?: string;
	doing?: string;
	host?: string;
	dir?: string;
	updatedAt?: string;
}

export interface AiapReceipt {
	of: string;
	status: string;
}

/** One aiap v1 wire unit, as decoded. `thread` and `re` matter on `msg` (`re` also on `profile`). */
export interface Envelope {
	aiap: number;
	type: EnvelopeType;
	id: string;
	ts: string;
	thread?: string;
	re?: string;
	body?: string;
	profile?: AiapProfile;
	receipt?: AiapReceipt;
}

export type Classified =
	| { kind: EnvelopeType; envelope: Envelope }
	| { kind: "foreign"; note: string; version?: number }
	| { kind: "raw"; body: string };

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID-style id as aiap mints them: 48 bits of Unix milliseconds then 80
 * random bits, 26 characters of Crockford base32, most significant first.
 */
export function newMessageId(now: number = Date.now()): string {
	const bytes = Buffer.alloc(16);
	bytes.writeUIntBE(Math.max(0, Math.floor(now)) % 2 ** 48, 0, 6);
	randomBytes(10).copy(bytes, 6);
	// 128 bits into 26 five-bit groups, the first group holding the top 3 bits
	let bits = 0n;
	for (const b of bytes) bits = (bits << 8n) | BigInt(b);
	let out = "";
	for (let i = 25; i >= 0; i--) {
		const shift = BigInt(i * 5);
		out += CROCKFORD[Number((bits >> shift) & 31n)];
	}
	return out;
}

const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

function checkId(id: unknown, what: string): string | undefined {
	if (typeof id !== "string" || id === "") return `${what} is required`;
	if (byteLength(id) > MAX_ID_BYTES) return `${what} exceeds ${MAX_ID_BYTES} bytes`;
	if (id.startsWith(RESERVED_ID_PREFIX)) return `${what} uses the reserved prefix ${RESERVED_ID_PREFIX}`;
	return undefined;
}

function checkRef(value: unknown, what: string): string | undefined {
	// Go decodes a JSON null into an empty string, which is "not given"
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") return `${what} must be a string`;
	if (byteLength(value) > MAX_ID_BYTES) return `${what} exceeds ${MAX_ID_BYTES} bytes`;
	return undefined;
}

/** RFC 3339 as Go's time.Parse(time.RFC3339) accepts it: the fields in range, a day the month has. */
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function isRfc3339(value: string): boolean {
	const m = RFC3339.exec(value);
	if (!m) return false;
	const field = (i: number): number | undefined => (m[i] === undefined ? undefined : Number(m[i]));
	const [y, mo, d, h, mi, s, oh, om] = [1, 2, 3, 4, 5, 6, 8, 9].map(field);
	if (y === undefined || mo === undefined || d === undefined || h === undefined || mi === undefined || s === undefined)
		return false;
	if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
	if (oh !== undefined && (oh > 23 || (om ?? 0) > 59)) return false;
	const probe = new Date(Date.UTC(y, mo - 1, d));
	return probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

function checkTime(value: unknown, what: string): string | undefined {
	if (typeof value !== "string" || !isRfc3339(value)) return `${what} is not an RFC 3339 time`;
	return undefined;
}

const AGENT_NAME = /^[a-z0-9-]{1,32}$/;
const PROFILE_FIELD_CAP = 256;
const PROFILE_DOING_CAP = 1024;
const PROFILE_DIR_CAP = 1024;

/** Why a decoded envelope is not a valid v1 envelope, or undefined when it is. The Go package's rules. */
export function validate(e: Record<string, unknown>): string | undefined {
	if (e.aiap !== AIAP_VERSION) return `aiap version ${String(e.aiap)} is not ${AIAP_VERSION}`;
	if (typeof e.type !== "string" || !TYPES.has(e.type)) return `unknown type ${JSON.stringify(e.type)}`;
	const idError = checkId(e.id, "id");
	if (idError) return idError;
	const tsError = checkTime(e.ts, "ts");
	if (tsError) return tsError;
	const threadError = checkRef(e.thread, "thread") ?? checkRef(e.re, "re");
	if (threadError) return threadError;
	switch (e.type) {
		case "msg": {
			if (typeof e.body !== "string" || e.body === "") return "a msg needs a body";
			if (byteLength(e.body) > MAX_BODY_BYTES) return `body exceeds ${MAX_BODY_BYTES} bytes`;
			return undefined;
		}
		case "profile": {
			const p = e.profile;
			if (typeof p !== "object" || p === null || Array.isArray(p)) return "a profile needs its profile section";
			const prof = p as Record<string, unknown>;
			for (const [field, cap] of [
				["agent", PROFILE_FIELD_CAP],
				["project", PROFILE_FIELD_CAP],
				["owner", PROFILE_FIELD_CAP],
				["host", PROFILE_FIELD_CAP],
				["doing", PROFILE_DOING_CAP],
				["dir", PROFILE_DIR_CAP],
			] as const) {
				const v = prof[field];
				if (v === undefined || v === null) continue;
				if (typeof v !== "string") return `profile.${field} must be a string`;
				if (byteLength(v) > cap) return `profile.${field} exceeds ${cap} bytes`;
			}
			if (typeof prof.agent === "string" && prof.agent !== "" && !AGENT_NAME.test(prof.agent)) {
				return "profile.agent is not an agent name";
			}
			if (prof.updatedAt !== undefined && prof.updatedAt !== null && prof.updatedAt !== "") {
				const t = checkTime(prof.updatedAt, "profile.updatedAt");
				if (t) return t;
			}
			return undefined;
		}
		case "receipt": {
			const r = e.receipt;
			if (typeof r !== "object" || r === null || Array.isArray(r)) return "a receipt needs its receipt section";
			const rec = r as Record<string, unknown>;
			if (typeof rec.of !== "string" || rec.of === "") return "receipt.of is required";
			if (byteLength(rec.of) > MAX_ID_BYTES) return `receipt.of exceeds ${MAX_ID_BYTES} bytes`;
			if (rec.status !== "delivered") return `receipt.status ${JSON.stringify(rec.status)} is not delivered`;
			return undefined;
		}
		default:
			return undefined;
	}
}

export interface MessageInput {
	body: string;
	thread?: string;
	re?: string;
	id?: string;
	now?: number;
}

/**
 * A `msg` envelope's bytes for the wire. Throws a plain Error when the
 * message breaks aiap's caps: an empty body, a body over 64 KiB, a thread or
 * reply reference over 64 bytes, or an encoded envelope over 256 KiB.
 */
export function encodeMessage(input: MessageInput): { id: string; ts: string; bytes: Uint8Array } {
	const id = input.id ?? newMessageId(input.now);
	const ts = new Date(input.now ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
	const envelope: Envelope = {
		aiap: AIAP_VERSION,
		type: "msg",
		id,
		ts,
		...(input.thread === undefined ? {} : { thread: input.thread }),
		...(input.re === undefined ? {} : { re: input.re }),
		body: input.body,
	};
	const problem = validate(envelope as unknown as Record<string, unknown>);
	if (problem) throw new Error(`the message cannot be sent: ${problem}`);
	const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
	if (bytes.byteLength > MAX_ENVELOPE_BYTES) {
		throw new Error(`the message cannot be sent: the envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`);
	}
	return { id, ts, bytes };
}

/**
 * Sort an inbound payload as aiap's daemon does. Raw: over the envelope cap,
 * or not a JSON object with an integer `aiap` field (its body is the text,
 * or a note for a payload too large or not UTF-8). Foreign: JSON with an
 * `aiap` field that is not a valid v1 envelope. Otherwise the envelope, by
 * its type.
 */
export function classify(payload: Uint8Array): Classified {
	if (payload.byteLength > MAX_ENVELOPE_BYTES)
		return { kind: "raw", body: `payload too large: ${payload.byteLength} bytes` };
	// Go decodes the JSON before it looks at the bytes: an envelope with a bad byte inside is still an envelope
	// (the byte becomes U+FFFD), and a leading byte order mark is not JSON to it
	const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(payload);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { kind: "raw", body: rawBody(payload) };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { kind: "raw", body: rawBody(payload) };
	}
	const record = parsed as Record<string, unknown>;
	// an integer in the JSON text itself: Go's decoder refuses 1.0 and 1e0 for an int field
	if (typeof record.aiap !== "number" || !Number.isInteger(record.aiap) || !AIAP_INT.test(text)) {
		return { kind: "raw", body: rawBody(payload) };
	}
	if (record.aiap !== AIAP_VERSION) {
		return { kind: "foreign", note: `aiap v${record.aiap} envelope`, version: record.aiap };
	}
	const problem = validate(record);
	if (problem) return { kind: "foreign", note: problem, version: AIAP_VERSION };
	return { kind: record.type as EnvelopeType, envelope: record as unknown as Envelope };
}

/** The `aiap` field written as an integer literal, as Go's decoder requires of an int. */
const AIAP_INT = /"aiap"\s*:\s*-?\d+\s*[,}]/;

/**
 * A raw payload's body as the Go daemon shows it: the size first (over the
 * body cap it is a note, not the text), then whether it is UTF-8, then the
 * text itself.
 */
function rawBody(payload: Uint8Array): string {
	if (payload.byteLength > MAX_BODY_BYTES) return `payload too large: ${payload.byteLength} bytes`;
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload);
	} catch {
		return `binary payload, ${payload.byteLength} bytes`;
	}
}
