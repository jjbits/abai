// The manifest: the validator's rules and the YAML rendering.
import { describe, expect, test } from "vitest";
import {
	DEFAULT_SIZED_MAX,
	DEFAULT_STRING_MAX,
	durationMs,
	isValidName,
	type Manifest,
	matchesType,
	payloadBytes,
	SCALAR_BYTES,
	validateManifest,
} from "../src/manifest/manifest.ts";
import { parseManifestYaml, renderManifestYaml } from "../src/manifest/render.ts";
import { FIXTURE_MANIFEST, MINIMAL_MANIFEST } from "./fixtures/manifest.ts";

type Loose = Record<string, any>;

/** A fresh deep copy of the minimal manifest. */
function minimal(): Manifest {
	return structuredClone(MINIMAL_MANIFEST);
}
/** Violations of the minimal manifest after `mutate`. */
function violations(mutate: (m: Loose) => void): string[] {
	const m: Loose = minimal();
	mutate(m);
	return validateManifest(m);
}

const set = (key: string, value: unknown) => (m: Loose) => {
	m[key] = value;
};

const cell = (extra: Loose): Loose => ({ name: "a.b", type: "int", access: "read", doc: "d", ...extra });
const event = (extra: Loose): Loose => ({ name: "a.b", doc: "d", payload: {}, ...extra });
const capability = (extra: Loose): Loose => ({
	name: "a_b",
	doc: "d",
	params: {},
	result: {},
	effect: "read",
	dispatch: "immediate",
	policy: "auto",
	...extra,
});
const decision = (extra: Loose): Loose => ({
	name: "a_b",
	doc: "d",
	context: {},
	answer: {},
	default: {},
	timeout: "30s",
	policy: "auto",
	...extra,
});

describe("validateManifest", () => {
	test("the minimal manifest validates", () => {
		expect(validateManifest(minimal())).toEqual([]);
	});

	test("top-level rules", () => {
		expect(validateManifest("nope")).toEqual(["manifest: must be an object"]);
		expect(violations(set("abaigrammar", "0.2"))).toEqual(['abaigrammar: must be "0.1"']);
		expect(violations(set("name", ""))).toEqual(["name: is required"]);
		expect(violations((m) => delete m.entry)).toEqual(["entry: is required"]);
		expect(violations(set("modes", []))).toEqual(["modes: must list at least one mode"]);
		expect(violations(set("modes", ["fork"]))).toEqual(['modes[0]: unknown mode "fork"']);
		expect(violations(set("modes", ["sidecar", "sidecar"]))).toEqual(["modes: must not repeat a mode"]);
		expect(violations(set("content", {}))).toEqual(["content.identity: is required"]);
		expect(violations(set("audit", { path: "" }))).toEqual(["audit.path: is required"]);
		expect(violations(set("lifecycle", { pause: "maybe" }))).toEqual([
			"lifecycle.pause: must be cooperative, os or none",
		]);
		expect(violations(set("deviations", ["ok", ""]))).toEqual(["deviations: must be a list of non-empty strings"]);
		expect(violations(set("check", {}))).toEqual(["check.run: is required when check is declared"]);
		expect(violations(set("cells", "x"))).toEqual(["cells: must be a list"]);
	});

	test("names", () => {
		expect(isValidName("queue.depth")).toBe(true);
		expect(isValidName("on_backlog")).toBe(true);
		expect(isValidName("Queue")).toBe(false);
		expect(isValidName("a..b")).toBe(false);
		expect(isValidName("1a")).toBe(false);
		expect(violations((m) => m.cells.push(cell({ name: "Bad" })))).toEqual(['cells[0]: invalid name "Bad"']);
		expect(violations((m) => m.cells.push(cell({}), cell({})))).toEqual(["cells.a.b: duplicate name"]);
		expect(violations((m) => m.cells.push(cell({ name: "abai.x" })))).toEqual([
			"cells.abai.x: the abai. prefix is reserved for the library",
		]);
		expect(violations((m) => m.events.push(event({ name: "abai.audit.failed" })))).toEqual([]);
		expect(violations((m) => m.events.push(event({ name: "abai.mine" })))).toEqual([
			"events.abai.mine: the abai. prefix is reserved for the library",
		]);
		expect(violations((m) => m.cells.push(cell({ doc: " " })))).toEqual(["cells.a.b: doc is required"]);
	});

	test("cells", () => {
		expect(violations((m) => m.cells.push(cell({ type: "any" })))).toEqual(['cells.a.b: unknown type "any"']);
		expect(violations((m) => m.cells.push(cell({ access: "write" })))).toEqual([
			"cells.a.b: access must be read or readwrite",
		]);
		expect(violations((m) => m.cells.push(cell({ access: "readwrite" })))).toEqual([
			"cells.a.b: a readwrite cell needs a default",
		]);
		expect(violations((m) => m.cells.push(cell({ access: "readwrite", default: "4" })))).toEqual([
			"cells.a.b: default is not of the cell's type",
		]);
		expect(violations((m) => m.cells.push(cell({ access: "readwrite", default: 4, policy: "forbid" })))).toEqual([
			"cells.a.b: a knob's policy is auto or confirm",
		]);
		expect(violations((m) => m.cells.push(cell({ type: "enum" })))).toEqual([
			"cells.a.b: enum cells need a non-empty list of string values",
		]);
		expect(violations((m) => m.cells.push(cell({ enum: ["x"] })))).toEqual([
			"cells.a.b: enum values belong to enum cells only",
		]);
		expect(violations((m) => m.cells.push(cell({ type: "string", range: [1, 2] })))).toEqual([
			"cells.a.b: range applies to int and float cells only",
		]);
		expect(violations((m) => m.cells.push(cell({ range: [2, 1] })))).toEqual(["cells.a.b: range must be [min, max]"]);
		expect(violations((m) => m.cells.push(cell({ max: 10 })))).toEqual([
			"cells.a.b: max applies to sized types only",
		]);
		expect(violations((m) => m.cells.push(cell({ type: "string", max: 0 })))).toEqual([
			"cells.a.b: max must be a positive integer",
		]);
		expect(violations((m) => m.cells.push(cell({ policy: "auto" })))).toEqual([
			"cells.a.b: policy applies to readwrite cells only",
		]);
		expect(violations((m) => m.cells.push(cell({ default: 1 })))).toEqual([
			"cells.a.b: default applies to readwrite cells only",
		]);
		expect(violations((m) => m.cells.push(cell({ fields: { x: "int" } })))).toEqual([
			"cells.a.b: fields belong to object cells only",
		]);
		expect(violations((m) => m.cells.push(cell({ type: "object", fields: { x: "nope" } })))).toEqual([
			'cells.a.b.x: unknown type "nope"',
		]);
		expect(violations((m) => m.cells.push(cell({ type: "list", items: "enum" })))).toEqual([
			"cells.a.b.item: an enum field needs its values (use the object form)",
		]);
		expect(
			violations((m) =>
				m.cells.push(cell({ type: "string", access: "readwrite", default: "x", max: 8, timeout: "5s" })),
			),
		).toEqual([]);
		expect(violations((m) => m.cells.push(cell({ access: "readwrite", default: 1, timeout: "5s" })))).toEqual([
			"cells.a.b: a delivery timeout applies to sized knobs only",
		]);
	});

	test("events", () => {
		expect(violations((m) => m.events.push(event({ payload: "x" })))).toEqual([
			"events.a.b.payload: must be an object of fields",
		]);
		expect(violations((m) => m.events.push(event({ wakes: "" })))).toEqual([
			"events.a.b: wakes must be always, never or a condition",
		]);
		expect(violations((m) => m.events.push(event({ large: "yes" })))).toEqual([
			"events.a.b: large must be a boolean",
		]);
		expect(violations((m) => m.events.push(event({ payload: { big: { type: "object", max: 5000 } } })))).toEqual([
			"events.a.b: payload counts 5000 bytes, over 4096: declare large: true",
		]);
		expect(
			violations((m) => m.events.push(event({ payload: { big: { type: "object", max: 5000 } }, large: true }))),
		).toEqual([]);
		expect(violations((m) => m.events.push(event({ payload: { "bad-name": "int" } })))).toEqual([
			"events.a.b.payload.bad-name: field names are identifiers",
		]);
		expect(violations((m) => m.events.push(event({ payload: { n: { type: "int", max: 4 } } })))).toEqual([
			"events.a.b.payload.n: max applies to sized types only",
		]);
	});

	test("capabilities", () => {
		expect(violations((m) => m.capabilities.push(capability({ effect: "write" })))).toEqual([
			"capabilities.a_b: effect must be read or mutate",
		]);
		expect(violations((m) => m.capabilities.push(capability({ dispatch: undefined })))).toEqual([
			"capabilities.a_b: dispatch must be declared",
		]);
		expect(violations((m) => m.capabilities.push(capability({ policy: undefined })))).toEqual([
			"capabilities.a_b: policy must be declared",
		]);
		expect(violations((m) => m.capabilities.push(capability({ timeout: "soon" })))).toEqual([
			"capabilities.a_b: timeout must be a duration such as 30s",
		]);
		expect(violations((m) => m.capabilities.push(capability({ example: { z: 1 } })))).toEqual([
			"capabilities.a_b: example has an undeclared parameter z",
		]);
		expect(violations((m) => m.capabilities.push(capability({ writes: "Bad" })))).toEqual([
			"capabilities.a_b: writes must name a cell",
		]);
	});

	test("decisions and turns", () => {
		expect(violations((m) => m.decisions.push(decision({ options: ["a"], default: "a" })))).toEqual([
			"decisions.a_b: declare either options or answer",
		]);
		expect(violations((m) => m.decisions.push(decision({ answer: undefined })))).toEqual([
			"decisions.a_b: declare either options or answer",
		]);
		expect(
			violations((m) => m.decisions.push(decision({ answer: undefined, options: ["a"], default: "b" }))),
		).toEqual(["decisions.a_b: default must be one of the options or abort"]);
		expect(
			violations((m) => m.decisions.push(decision({ answer: undefined, options: ["a"], default: "abort" }))),
		).toEqual([]);
		expect(violations((m) => m.decisions.push(decision({ default: undefined })))).toEqual([
			"decisions.a_b: default is required",
		]);
		expect(violations((m) => m.decisions.push(decision({ timeout: undefined })))).toEqual([
			"decisions.a_b: timeout is required (a duration such as 30s)",
		]);
		expect(violations((m) => m.decisions.push(decision({ policy: "maybe" })))).toEqual([
			"decisions.a_b: policy must be declared",
		]);
		expect(violations((m) => m.turns.push({ name: "t", doc: "d" }))).toEqual([
			"turns.t: timeout is required (a duration such as 30s)",
		]);
	});

	test("helpers", () => {
		expect(durationMs("250ms")).toBe(250);
		expect(durationMs("30s")).toBe(30_000);
		expect(durationMs("2m")).toBe(120_000);
		expect(durationMs("1h")).toBe(3_600_000);
		expect(() => durationMs("soon")).toThrow();
		expect(payloadBytes({ a: "int", b: "bool", c: "string", d: "object", e: { type: "list", max: 10 } })).toBe(
			SCALAR_BYTES * 2 + DEFAULT_STRING_MAX + DEFAULT_SIZED_MAX + 10,
		);
		expect(matchesType(1, "int")).toBe(true);
		expect(matchesType(1.5, "int")).toBe(false);
		expect(matchesType(1.5, "float")).toBe(true);
		expect(matchesType(null, "float")).toBe(false);
		expect(matchesType(null, { type: "float", nullable: true })).toBe(true);
		expect(matchesType("a", { type: "enum", enum: ["a"] })).toBe(true);
		expect(matchesType("b", { type: "enum", enum: ["a"] })).toBe(false);
		expect(matchesType({ x: 1 }, { type: "object", fields: { x: "int" } })).toBe(true);
		expect(matchesType({ x: "1" }, { type: "object", fields: { x: "int" } })).toBe(false);
		expect(matchesType(["a"], { type: "list", items: "string" })).toBe(true);
		expect(matchesType(["a", 1], { type: "list", items: "string" })).toBe(false);
	});

	test("the fixture manifest validates", () => {
		expect(validateManifest(FIXTURE_MANIFEST)).toEqual([]);
	});
});

describe("rendering", () => {
	test("round-trips through YAML", () => {
		const text = renderManifestYaml(FIXTURE_MANIFEST);
		expect(parseManifestYaml(text)).toEqual(JSON.parse(JSON.stringify(FIXTURE_MANIFEST)));
	});

	test("is byte-stable: one trailing newline, no folding, YAML 1.1 booleans quoted", () => {
		const text = renderManifestYaml(FIXTURE_MANIFEST);
		expect(text.endsWith("\n")).toBe(true);
		expect(text.endsWith("\n\n")).toBe(false);
		expect(text).toBe(renderManifestYaml(FIXTURE_MANIFEST));
		expect(text.split("\n")[0]).toBe("# abaigram.yaml: the manifest of counter as an abaigram (abaigrammar 0.1).");
		// no folded or literal blocks: every doc is one line
		for (const line of text.split("\n")) {
			if (line.trim().startsWith("doc:")) expect(line).not.toMatch(/: [>|][-+]?$/);
		}
		// the fixture has no YAML 1.1 boolean strings; a decision with an "off" option shows the quoting
		const withOff: Manifest = {
			...FIXTURE_MANIFEST,
			decisions: [{ ...FIXTURE_MANIFEST.decisions[0], options: ["on", "off"], default: "off" }],
		};
		const quoted = renderManifestYaml(withOff);
		expect(quoted).toContain('- "off"');
		expect(quoted).not.toMatch(/^\s+- off$/m);
	});
});
