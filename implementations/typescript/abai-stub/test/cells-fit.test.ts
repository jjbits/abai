// Fitting cell values to their declared sizes (abaigrammar section 5.2):
// cutting is linear and never splits a code point; knob writes are checked
// against the declared type, enum and range.
import { describe, expect, test } from "vitest";
import { fitValue, validateKnobValue } from "../src/cells/fit.ts";
import { type CellDecl, encodedBytes } from "../src/manifest/manifest.ts";

const name: CellDecl = { name: "session.name", type: "string", access: "read", doc: "d" };
const steering: CellDecl = {
	name: "queue.steering",
	type: "list",
	access: "read",
	doc: "d",
	max: 4096,
	items: { type: "string", max: 1024 },
};

describe("fitValue", () => {
	test("cuts strings to their max bytes and lists to the items that fit", () => {
		expect(fitValue("a".repeat(300), name)).toHaveLength(256);
		const accented = fitValue("é".repeat(200), name) as string;
		expect(Buffer.byteLength(accented, "utf8")).toBeLessThanOrEqual(256);
		expect(accented).toBe("é".repeat(128));
		const many = Array.from({ length: 100 }, () => "m".repeat(100));
		const kept = fitValue(many, steering) as string[];
		expect(kept.length).toBeGreaterThan(0);
		expect(kept.length).toBeLessThan(100);
		expect(encodedBytes(kept)).toBeLessThanOrEqual(4096);
		expect(encodedBytes([...kept, "m".repeat(100)])).toBeGreaterThan(4096);
		const long = fitValue(["x".repeat(2000)], steering) as string[];
		expect(long).toEqual(["x".repeat(1024)]);
		expect(fitValue(5, { name: "n", type: "int", access: "read", doc: "d" })).toBe(5);
	});

	test("a megabyte of text is cut in milliseconds", () => {
		const big = "x".repeat(1_048_576);
		const cut = fitValue([big], steering) as string[];
		expect(cut).toEqual(["x".repeat(1024)]);
		const max: CellDecl = { name: "s", type: "string", access: "read", doc: "d", max: 1000 };
		const cutString = fitValue("é".repeat(1_048_576), max) as string;
		expect(cutString).toBe("é".repeat(500));
	});

	test("an astral code point is dropped whole rather than split", () => {
		const emoji = "ab\u{1F600}";
		const short: CellDecl = { name: "s", type: "string", access: "read", doc: "d", max: 5 };
		expect(fitValue(emoji, short)).toBe("ab");
		expect(fitValue(emoji, { ...short, max: 6 })).toBe(emoji);
		expect(fitValue("é", { ...short, max: 1 })).toBe("");
	});
});

describe("validateKnobValue", () => {
	test("checks the type, the enum and the range", () => {
		const flag: CellDecl = { name: "retry.auto", type: "bool", access: "readwrite", doc: "d", default: true };
		expect(validateKnobValue(flag, true)).toBeUndefined();
		expect(validateKnobValue(flag, "true")).toBe("value must be a bool");
		const level: CellDecl = {
			name: "thinking.level",
			type: "enum",
			access: "readwrite",
			doc: "d",
			enum: ["low", "max"],
			default: "low",
		};
		expect(validateKnobValue(level, "max")).toBeUndefined();
		expect(validateKnobValue(level, "MAX")).toBe("value must be one of: low, max");
		const ranged: CellDecl = { name: "n", type: "int", access: "readwrite", doc: "d", default: 1, range: [1, 4] };
		expect(validateKnobValue(ranged, 4)).toBeUndefined();
		expect(validateKnobValue(ranged, 5)).toBe("value must be within 1 and 4");
		expect(validateKnobValue(ranged, 1.5)).toBe("value must be a int");
	});
});
