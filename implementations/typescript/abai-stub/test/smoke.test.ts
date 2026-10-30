import { expect, test } from "vitest";
import { parse, stringify } from "yaml";
import { ABAI_STUB_VERSION } from "../src/index.ts";

test("the stub package loads", () => {
	expect(ABAI_STUB_VERSION).toBe("0.1.0");
});

test("yaml round-trips a manifest-shaped document", () => {
	const text = stringify({ abaigrammar: "0.1", name: "counter", modes: ["turns"] });
	expect(parse(text)).toEqual({ abaigrammar: "0.1", name: "counter", modes: ["turns"] });
});
