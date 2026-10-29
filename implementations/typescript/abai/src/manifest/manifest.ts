// The abaigrammar 0.1 manifest: types, validation and helpers (spec/abaigrammar.md sections 5 and 7).
//
// The manifest exists in two forms that must agree: in code (the program's
// declarations, the source of truth at runtime) and in the repo
// (abaigram.yaml, rendered by render.ts). The validator here checks either
// form, so `<entry> doctor` and the self-check test apply the same rules.
// Fields beyond the grammar (`deviations`, `writes`, `nullable`) are
// extensions a partial realization needs; the manifest's `deviations` list
// names them.

export const ABAIGRAMMAR_VERSION = "0.1";

export type ScalarType = "bool" | "int" | "float" | "enum";
export type SizedType = "string" | "object" | "list";
export type ValueType = ScalarType | SizedType;

export type Mode = "turns" | "thread" | "sidecar";
export const MODES: readonly Mode[] = ["turns", "thread", "sidecar"];

export type Access = "read" | "readwrite";
export type Effect = "read" | "mutate";
export type Dispatch = "immediate" | "safepoint";
export type Policy = "auto" | "confirm" | "forbid";
export type Wakes = "always" | "never" | string;

/** Default `max` sizes of the sized types (grammar section 5, common rules). */
export const DEFAULT_STRING_MAX = 256;
export const DEFAULT_SIZED_MAX = 1024;
/** Payload bytes an event slot holds; a larger declared payload must be `large`. */
export const EVENT_SLOT_BYTES = 4096;
/** Bytes counted for a scalar field. */
export const SCALAR_BYTES = 8;

/**
 * A schema field: a bare type name when the defaults suffice, or an object
 * with `type` and `max` (and, beyond the grammar, `enum` values, an object's
 * `fields`, a list's `items`, `nullable` and a `doc`).
 */
export type FieldSchema =
	| ValueType
	| {
			type: ValueType;
			max?: number;
			enum?: string[];
			fields?: Schema;
			items?: FieldSchema;
			nullable?: boolean;
			doc?: string;
	  };

export type Schema = Record<string, FieldSchema>;

export interface CellDecl {
	name: string;
	type: ValueType;
	access: Access;
	doc: string;
	/** Sized types only. */
	max?: number;
	/** `enum` cells. */
	enum?: string[];
	/** `int` and `float` cells. */
	range?: [number, number];
	/** Required for `readwrite`. */
	default?: unknown;
	/** Hint in milliseconds. */
	cadence?: number;
	/** `readwrite` only; knobs are never `forbid`. */
	policy?: "auto" | "confirm";
	/** Sized knobs only: delivery timeout. */
	timeout?: string;
	/** `object` cells: the fields. */
	fields?: Schema;
	/** `list` cells: the item schema. */
	items?: FieldSchema;
	/** Extension: the value may be null. */
	nullable?: boolean;
}

export interface EventDecl {
	name: string;
	doc: string;
	payload: Schema;
	wakes?: Wakes;
	large?: boolean;
}

export interface CapabilityDecl {
	name: string;
	doc: string;
	params: Schema;
	result: Schema;
	effect: Effect;
	dispatch: Dispatch;
	timeout?: string;
	policy: Policy;
	example?: Record<string, unknown>;
	/** Extension: the knob this capability sets; such calls are audited as knob writes. */
	writes?: string;
}

export interface DecisionDecl {
	name: string;
	doc: string;
	context: Schema;
	/** Either `options` (an enum of choices) or `answer` (a schema). */
	options?: string[];
	answer?: Schema;
	default: unknown;
	timeout: string;
	policy: Policy;
}

export interface TurnDecl {
	name: string;
	doc: string;
	timeout: string;
}

export interface Manifest {
	abaigrammar: string;
	name: string;
	entry: string;
	modes: Mode[];
	harness?: { path: string | null };
	model?: Record<string, unknown>;
	check?: { run: string; overhead?: string };
	content: { identity: string; install?: string; use?: string; turns?: string };
	audit: { path: string };
	lifecycle?: {
		pause: "cooperative" | "os" | "none";
		stop?: { graceful: string; handler: string };
		policy?: Partial<Record<"pause" | "resume" | "stop" | "restart", Policy>>;
	};
	attention?: { budget?: { wakes_per_minute?: number; tokens_per_hour?: number } };
	policy?: { confirm_timeout?: string };
	/** Where this instantiation departs from the grammar, one sentence each (section 7); a program may add its own. */
	deviations?: string[];
	cells: CellDecl[];
	events: EventDecl[];
	capabilities: CapabilityDecl[];
	decisions: DecisionDecl[];
	turns: TurnDecl[];
}

/** Events the library (the stub) emits under the reserved `abai.` prefix. */
export const LIBRARY_EVENTS: readonly string[] = [
	"abai.events.dropped",
	"abai.knob.reset",
	"abai.lifecycle.exited",
	"abai.pause.blocked",
	"abai.io.stdout",
	"abai.io.stderr",
	"abai.audit.failed",
];

const NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const DURATION = /^[0-9]+(ms|s|m|h)$/;
const VALUE_TYPES: readonly string[] = ["bool", "int", "float", "enum", "string", "object", "list"];
const SIZED_TYPES: readonly string[] = ["string", "object", "list"];
const POLICIES: readonly string[] = ["auto", "confirm", "forbid"];

/** A valid abai name: lowercase segments joined by dots, words joined by underscores. */
export function isValidName(name: unknown): name is string {
	return typeof name === "string" && NAME.test(name);
}

export function isDuration(value: unknown): value is string {
	return typeof value === "string" && DURATION.test(value);
}

/** A duration string in milliseconds. */
export function durationMs(value: string): number {
	const match = /^([0-9]+)(ms|s|m|h)$/.exec(value);
	if (!match) throw new Error(`not a duration: ${value}`);
	const n = Number(match[1]);
	switch (match[2]) {
		case "ms":
			return n;
		case "s":
			return n * 1000;
		case "m":
			return n * 60_000;
		default:
			return n * 3_600_000;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Normalize a field schema to its object form. */
export function fieldOf(field: FieldSchema): Exclude<FieldSchema, string> {
	return typeof field === "string" ? { type: field } : field;
}

/** Bytes a field counts toward an event slot: scalars 8, sized fields their `max`. */
export function fieldBytes(field: FieldSchema): number {
	const f = fieldOf(field);
	if (f.type === "string") return f.max ?? DEFAULT_STRING_MAX;
	if (f.type === "object" || f.type === "list") return f.max ?? DEFAULT_SIZED_MAX;
	return SCALAR_BYTES;
}

/** Bytes a payload counts toward an event slot (grammar section 5.1). */
export function payloadBytes(schema: Schema): number {
	let total = 0;
	for (const field of Object.values(schema)) total += fieldBytes(field);
	return total;
}

/** Whether a value has a declared type. `int` accepts integers only; `float` any finite number. */
export function matchesType(value: unknown, field: FieldSchema): boolean {
	const f = fieldOf(field);
	if (value === null) return f.nullable === true;
	switch (f.type) {
		case "bool":
			return typeof value === "boolean";
		case "int":
			return typeof value === "number" && Number.isInteger(value);
		case "float":
			return typeof value === "number" && Number.isFinite(value);
		case "enum":
			return typeof value === "string" && (f.enum?.includes(value) ?? false);
		case "string":
			return typeof value === "string";
		case "object":
			if (!isRecord(value)) return false;
			if (f.fields) {
				for (const [key, sub] of Object.entries(f.fields)) {
					if (!matchesType(value[key], sub)) return false;
				}
			}
			return true;
		case "list":
			if (!Array.isArray(value)) return false;
			if (f.items) {
				const items = f.items;
				return value.every((item) => matchesType(item, items));
			}
			return true;
		default:
			return false;
	}
}

/** Encoded size of a value in bytes, as the wire would carry it. */
export function encodedBytes(value: unknown): number {
	return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

/**
 * Cut a string to at most `maxBytes` of UTF-8 without splitting a code
 * point: one encode, a cut, a step back over continuation bytes, one decode.
 */
export function cutUtf8(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	let end = Math.max(0, maxBytes);
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	return bytes.toString("utf8", 0, end);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

class Violations {
	readonly list: string[] = [];
	add(where: string, what: string): void {
		this.list.push(`${where}: ${what}`);
	}
}

function validateSchema(v: Violations, where: string, schema: unknown): void {
	if (!isRecord(schema)) {
		v.add(where, "must be an object of fields");
		return;
	}
	for (const [key, field] of Object.entries(schema)) {
		const at = `${where}.${key}`;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) v.add(at, "field names are identifiers");
		if (typeof field === "string") {
			if (!VALUE_TYPES.includes(field)) v.add(at, `unknown type ${JSON.stringify(field)}`);
			else if (field === "enum") v.add(at, "an enum field needs its values (use the object form)");
			continue;
		}
		if (!isRecord(field) || typeof field.type !== "string" || !VALUE_TYPES.includes(field.type)) {
			v.add(at, "must be a type name or an object with a valid type");
			continue;
		}
		if (field.max !== undefined) {
			if (!isPositiveInt(field.max)) v.add(at, "max must be a positive integer");
			if (!SIZED_TYPES.includes(field.type)) v.add(at, "max applies to sized types only");
		}
		if (field.type === "enum") {
			if (!Array.isArray(field.enum) || field.enum.length === 0 || !field.enum.every((e) => typeof e === "string")) {
				v.add(at, "enum fields need a non-empty list of string values");
			}
		} else if (field.enum !== undefined) v.add(at, "enum values belong to enum fields only");
		if (field.fields !== undefined) {
			if (field.type !== "object") v.add(at, "fields belong to object fields only");
			else validateSchema(v, at, field.fields);
		}
		if (field.items !== undefined) {
			if (field.type !== "list") v.add(at, "items belong to list fields only");
			else validateSchema(v, at, { item: field.items });
		}
		if (field.nullable !== undefined && typeof field.nullable !== "boolean") v.add(at, "nullable must be a boolean");
		if (field.doc !== undefined && typeof field.doc !== "string") v.add(at, "doc must be a string");
	}
}

function validateNamed(v: Violations, where: string, items: unknown, seen: Set<string>): Record<string, unknown>[] {
	if (!Array.isArray(items)) {
		v.add(where, "must be a list");
		return [];
	}
	const valid: Record<string, unknown>[] = [];
	items.forEach((item, index) => {
		const at = `${where}[${index}]`;
		if (!isRecord(item)) {
			v.add(at, "must be an object");
			return;
		}
		if (!isValidName(item.name)) {
			v.add(at, `invalid name ${JSON.stringify(item.name)}`);
			return;
		}
		if (seen.has(item.name)) v.add(`${where}.${item.name}`, "duplicate name");
		seen.add(item.name);
		if (item.name.startsWith("abai.") && !(where === "events" && LIBRARY_EVENTS.includes(item.name))) {
			v.add(`${where}.${item.name}`, "the abai. prefix is reserved for the library");
		}
		if (typeof item.doc !== "string" || item.doc.trim() === "") v.add(`${where}.${item.name}`, "doc is required");
		valid.push(item);
	});
	return valid;
}

function validateCell(v: Violations, cell: Record<string, unknown>): void {
	const at = `cells.${cell.name}`;
	const type = cell.type;
	if (typeof type !== "string" || !VALUE_TYPES.includes(type)) {
		v.add(at, `unknown type ${JSON.stringify(type)}`);
		return;
	}
	if (cell.access !== "read" && cell.access !== "readwrite") v.add(at, "access must be read or readwrite");
	if (cell.max !== undefined) {
		if (!isPositiveInt(cell.max)) v.add(at, "max must be a positive integer");
		if (!SIZED_TYPES.includes(type)) v.add(at, "max applies to sized types only");
	}
	if (type === "enum") {
		if (!Array.isArray(cell.enum) || cell.enum.length === 0 || !cell.enum.every((e) => typeof e === "string")) {
			v.add(at, "enum cells need a non-empty list of string values");
		}
	} else if (cell.enum !== undefined) v.add(at, "enum values belong to enum cells only");
	if (cell.range !== undefined) {
		const range = cell.range;
		if (
			!Array.isArray(range) ||
			range.length !== 2 ||
			typeof range[0] !== "number" ||
			typeof range[1] !== "number" ||
			range[0] > range[1]
		) {
			v.add(at, "range must be [min, max]");
		}
		if (type !== "int" && type !== "float") v.add(at, "range applies to int and float cells only");
	}
	if (cell.cadence !== undefined && !isPositiveInt(cell.cadence)) v.add(at, "cadence must be a positive integer");
	if (cell.fields !== undefined) {
		if (type !== "object") v.add(at, "fields belong to object cells only");
		else validateSchema(v, at, cell.fields);
	}
	if (cell.items !== undefined) {
		if (type !== "list") v.add(at, "items belong to list cells only");
		else validateSchema(v, at, { item: cell.items });
	}
	if (cell.nullable !== undefined && typeof cell.nullable !== "boolean") v.add(at, "nullable must be a boolean");
	if (cell.access === "readwrite") {
		if (cell.default === undefined) v.add(at, "a readwrite cell needs a default");
		else if (!matchesType(cell.default, cell as unknown as FieldSchema))
			v.add(at, "default is not of the cell's type");
		if (cell.policy !== undefined && cell.policy !== "auto" && cell.policy !== "confirm") {
			v.add(at, "a knob's policy is auto or confirm");
		}
		if (cell.timeout !== undefined) {
			if (!isDuration(cell.timeout)) v.add(at, "timeout must be a duration such as 30s");
			if (!SIZED_TYPES.includes(type)) v.add(at, "a delivery timeout applies to sized knobs only");
		}
	} else {
		if (cell.policy !== undefined) v.add(at, "policy applies to readwrite cells only");
		if (cell.timeout !== undefined) v.add(at, "timeout applies to readwrite cells only");
		if (cell.default !== undefined) v.add(at, "default applies to readwrite cells only");
	}
}

function validateEvent(v: Violations, event: Record<string, unknown>): void {
	const at = `events.${event.name}`;
	validateSchema(v, `${at}.payload`, event.payload);
	if (event.wakes !== undefined && (typeof event.wakes !== "string" || event.wakes.trim() === "")) {
		v.add(at, "wakes must be always, never or a condition");
	}
	if (event.large !== undefined && typeof event.large !== "boolean") v.add(at, "large must be a boolean");
	if (isRecord(event.payload)) {
		const bytes = payloadBytes(event.payload as Schema);
		if (bytes > EVENT_SLOT_BYTES && event.large !== true) {
			v.add(at, `payload counts ${bytes} bytes, over ${EVENT_SLOT_BYTES}: declare large: true`);
		}
	}
}

function validateCapability(v: Violations, cap: Record<string, unknown>, knobs: ReadonlySet<string>): void {
	const at = `capabilities.${cap.name}`;
	validateSchema(v, `${at}.params`, cap.params);
	validateSchema(v, `${at}.result`, cap.result);
	if (cap.effect !== "read" && cap.effect !== "mutate") v.add(at, "effect must be read or mutate");
	if (cap.dispatch !== "immediate" && cap.dispatch !== "safepoint") v.add(at, "dispatch must be declared");
	if (typeof cap.policy !== "string" || !POLICIES.includes(cap.policy)) v.add(at, "policy must be declared");
	if (cap.timeout !== undefined && !isDuration(cap.timeout)) v.add(at, "timeout must be a duration such as 30s");
	if (cap.example !== undefined) {
		if (!isRecord(cap.example)) v.add(at, "example must be an object of parameters");
		else if (isRecord(cap.params)) {
			for (const key of Object.keys(cap.example)) {
				if (!(key in cap.params)) v.add(at, `example has an undeclared parameter ${key}`);
			}
		}
	}
	if (cap.writes !== undefined) {
		if (!isValidName(cap.writes)) v.add(at, "writes must name a cell");
		else if (!knobs.has(cap.writes)) v.add(at, `writes names ${cap.writes}, which is not a readwrite cell`);
	}
}

function validateDecision(v: Violations, decision: Record<string, unknown>): void {
	const at = `decisions.${decision.name}`;
	validateSchema(v, `${at}.context`, decision.context);
	const hasOptions = decision.options !== undefined;
	const hasAnswer = decision.answer !== undefined;
	if (hasOptions === hasAnswer) v.add(at, "declare either options or answer");
	if (hasOptions) {
		const options = decision.options;
		if (!Array.isArray(options) || options.length === 0 || !options.every((o) => typeof o === "string")) {
			v.add(at, "options must be a non-empty list of strings");
		} else if (decision.default !== "abort" && !options.includes(decision.default as string)) {
			v.add(at, "default must be one of the options or abort");
		}
	}
	if (hasAnswer) validateSchema(v, `${at}.answer`, decision.answer);
	if (decision.default === undefined) v.add(at, "default is required");
	if (!isDuration(decision.timeout)) v.add(at, "timeout is required (a duration such as 30s)");
	if (typeof decision.policy !== "string" || !POLICIES.includes(decision.policy)) v.add(at, "policy must be declared");
}

function validateTurn(v: Violations, turn: Record<string, unknown>): void {
	if (!isDuration(turn.timeout)) v.add(`turns.${turn.name}`, "timeout is required (a duration such as 30s)");
}

/**
 * Validate a manifest in either form. Returns the violations, each
 * `<where>: <what>`; an empty list means the manifest validates.
 */
export function validateManifest(value: unknown): string[] {
	const v = new Violations();
	if (!isRecord(value)) return ["manifest: must be an object"];
	if (value.abaigrammar !== ABAIGRAMMAR_VERSION) {
		v.add("abaigrammar", `must be ${JSON.stringify(ABAIGRAMMAR_VERSION)}`);
	}
	if (typeof value.name !== "string" || value.name.trim() === "") v.add("name", "is required");
	if (typeof value.entry !== "string" || value.entry.trim() === "") v.add("entry", "is required");
	const modes = value.modes;
	if (!Array.isArray(modes) || modes.length === 0) v.add("modes", "must list at least one mode");
	else {
		modes.forEach((mode, index) => {
			if (!(MODES as readonly unknown[]).includes(mode))
				v.add(`modes[${index}]`, `unknown mode ${JSON.stringify(mode)}`);
		});
		if (new Set(modes).size !== modes.length) v.add("modes", "must not repeat a mode");
	}
	if (!isRecord(value.content) || typeof value.content.identity !== "string" || value.content.identity === "") {
		v.add("content.identity", "is required");
	}
	if (!isRecord(value.audit) || typeof value.audit.path !== "string" || value.audit.path === "") {
		v.add("audit.path", "is required");
	}
	if (value.lifecycle !== undefined) {
		const lifecycle = value.lifecycle;
		if (!isRecord(lifecycle) || !["cooperative", "os", "none"].includes(lifecycle.pause as string)) {
			v.add("lifecycle.pause", "must be cooperative, os or none");
		}
	}
	if (value.deviations !== undefined) {
		const deviations = value.deviations;
		if (!Array.isArray(deviations) || !deviations.every((d) => typeof d === "string" && d.trim() !== "")) {
			v.add("deviations", "must be a list of non-empty strings");
		}
	}
	if (value.check !== undefined && (!isRecord(value.check) || typeof value.check.run !== "string")) {
		v.add("check.run", "is required when check is declared");
	}

	const cells = validateNamed(v, "cells", value.cells, new Set());
	for (const cell of cells) validateCell(v, cell);
	const knobs = new Set(cells.filter((cell) => cell.access === "readwrite").map((cell) => cell.name as string));
	for (const event of validateNamed(v, "events", value.events, new Set())) validateEvent(v, event);
	for (const cap of validateNamed(v, "capabilities", value.capabilities, new Set())) {
		validateCapability(v, cap, knobs);
	}
	for (const decision of validateNamed(v, "decisions", value.decisions, new Set())) validateDecision(v, decision);
	for (const turn of validateNamed(v, "turns", value.turns, new Set())) validateTurn(v, turn);
	return v.list;
}

/** Narrow an unknown value to a Manifest; throws with the violations otherwise. */
export function assertManifest(value: unknown): Manifest {
	const violations = validateManifest(value);
	if (violations.length > 0) throw new Error(`manifest does not validate:\n${violations.join("\n")}`);
	return value as Manifest;
}
