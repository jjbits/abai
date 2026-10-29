// The harness's system prompt (abaigrammar section 8) is composed from the
// identity and the manifest, marks what the options change, and is
// byte-stable.
import { describe, expect, test } from "vitest";
import { FIXTURE_MANIFEST } from "../../abai/test/fixtures/manifest.ts";
import { type ComposeInput, composeInstructions, composeSystemPrompt } from "../src/prompt.ts";

const IDENTITY = [
	"# Identity",
	"",
	"You supervise a counter program. You watch its queue and tune its workers. You explain every change you make.",
	"",
].join("\n");
const manifest = FIXTURE_MANIFEST;
const base: ComposeInput["options"] = { form: "session", auto: false, denyMutate: false, wakes: [] };
const compose = (options: Partial<typeof base> = {}) =>
	composeSystemPrompt({ identity: IDENTITY, manifest, options: { ...base, ...options } });

describe("composeSystemPrompt", () => {
	test("contains the identity, every declaration with its doc, the waking events and the rules", () => {
		const text = compose();
		expect(text.startsWith(IDENTITY.trimEnd())).toBe(true);
		for (const section of ["## Cells", "## Capabilities", "## Decisions", "## Events that wake you", "# Rules"]) {
			expect(text).toContain(section);
		}
		for (const cell of manifest.cells) {
			expect(text).toContain(`- ${cell.name} (`);
			expect(text).toContain(cell.doc);
		}
		for (const capability of manifest.capabilities) {
			expect(text).toContain(`- ${capability.name}`);
			expect(text).toContain(capability.doc);
		}
		for (const decision of manifest.decisions) {
			expect(text).toContain(`- ${decision.name}:`);
			expect(text).toContain(decision.doc);
		}
		for (const event of manifest.events) {
			const listed = text.includes(`- ${event.name}: ${event.doc}`);
			expect(listed, event.name).toBe(event.wakes === "always");
		}
		expect(text).toContain("You are attached to the running program counter, in sidecar mode.");
		expect(text).toContain("# The program: counter (abaigrammar 0.1, mode turns)");
		expect(text).toContain("[abai wake]");
		expect(text).toContain("State a reason with every act of control");
		expect(text).toContain("- job.retry [mutate, confirmed by the person]: ");
		expect(text).not.toContain("Expensive: it carries the transcript");
	});

	test("the marks follow the options", () => {
		expect(compose({ auto: true })).toContain("auto mode");
		expect(compose({ auto: true })).not.toContain("confirmed by the person");
		expect(compose({ denyMutate: true })).toContain("Mutate capabilities are refused");
		expect(compose({ form: "mcp" })).toContain("abai_wait");
		expect(compose({ form: "mcp" })).toContain("shown to the person by your own client");
		expect(compose({ form: "mcp" })).toContain("You are attached to the running program counter");
		expect(compose({ form: "mcp" })).not.toContain("confirmed by the person");
	});

	test("the owner's appended text ends the prompt and outranks the rules", () => {
		const plain = compose();
		const withText = composeSystemPrompt({
			identity: IDENTITY,
			manifest,
			options: base,
			addendum: "  Lab rule: fix small things in the workshop.\n",
		});
		expect(withText.startsWith(plain.trimEnd())).toBe(true);
		expect(withText.slice(plain.trimEnd().length)).toBe(
			[
				"",
				"",
				"# From the owner",
				"",
				"The owner added the text below when this harness was started. Where it conflicts with the rules above, it wins.",
				"",
				"Lab rule: fix small things in the workshop.",
				"",
			].join("\n"),
		);
		expect(withText.endsWith("\n\n")).toBe(false);
		expect(plain).not.toContain("# From the owner");
		for (const blank of [undefined, "", "  \n"]) {
			expect(composeSystemPrompt({ identity: IDENTITY, manifest, options: base, addendum: blank })).toBe(plain);
		}
	});

	test("is byte-stable and free of per-attach data", () => {
		const text = compose();
		expect(compose()).toBe(text);
		expect(text).not.toMatch(/pid|sessionId/);
		expect(text.endsWith("\n")).toBe(true);
		expect(text.endsWith("\n\n")).toBe(false);
	});
});

describe("composeInstructions", () => {
	test("is short and points at abai_prompt and abai_wait", () => {
		const text = composeInstructions({ identity: IDENTITY, manifest, options: { ...base, form: "mcp" } });
		expect(text.startsWith("counter abai harness (abaigrammar 0.1, sidecar).")).toBe(true);
		expect(text).toContain("You supervise a counter program.");
		expect(text).toContain("abai_prompt");
		expect(text).toContain("abai_wait");
		expect(text.length).toBeLessThan(2000);
	});
});
