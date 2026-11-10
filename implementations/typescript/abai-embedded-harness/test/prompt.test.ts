// The harness's system prompt (abaigrammar section 8) is composed from the
// identity and the manifest, marks what the options change, and is
// byte-stable.
import { describe, expect, test } from "vitest";
import { FIXTURE_MANIFEST } from "../../abai-stub/test/fixtures/manifest.ts";
import { type ComposeInput, composeInstructions, composeSystemPrompt } from "../src/prompt.ts";

const IDENTITY = [
	"# Identity",
	"",
	"You supervise a counter program. You watch its queue and tune its workers. You explain every change you make.",
	"",
].join("\n");
const manifest = FIXTURE_MANIFEST;
const base: ComposeInput["options"] = { form: "session", auto: false, denyMutate: false, wakes: [] };
const compose = (options: Partial<typeof base> = {}, mode = "turns") =>
	composeSystemPrompt({ identity: IDENTITY, manifest, mode, options: { ...base, ...options } });

describe("the network paragraph", () => {
	const net = { doc: "Members are ships.", memberships: [{ network: "world", member: "beta", addr: "100.107.0.3" }] };
	const absent = { doc: "Members are ships.", absent: "no membership in /x", declared: true };
	const withNetwork = (network: ComposeInput["network"], form: "session" | "mcp" = "session") =>
		composeSystemPrompt({ identity: IDENTITY, manifest, mode: "turns", options: { ...base, form }, network });

	test("names the run's memberships with the program's doc, and lists abai_peers among the detached tools", () => {
		const text = withNetwork(net);
		expect(text).toContain(
			"This run is beta (100.107.0.3) on the network world. Members are ships. abai_peers lists the members and who is reachable now",
		);
		expect(text).toContain("abai_status, abai_attach, abai_peers, abai_messages, the transcript");
		expect(text).toContain("abai_audit, abai_send) fail");
		expect(text).toContain("abai_send answers a member by name");
		expect(text.indexOf("This run is beta")).toBeLessThan(text.indexOf("# The program:"));
	});

	test("says why a declared network is absent, and says nothing when none is declared", () => {
		expect(withNetwork(absent)).toContain(
			"The program declares a network. Members are ships. This run has none: no membership in /x. abai_peers says so too.",
		);
		expect(compose()).not.toContain("abai_peers");
		expect(compose()).not.toContain("network");
		// absent: the detached-tools line does not promise abai_peers
		expect(withNetwork(absent)).not.toContain("abai_attach, abai_peers,");
		expect(withNetwork(absent)).not.toContain("abai_send");
		expect(withNetwork({ absent: "no aiip binary found", declared: false })).toContain(
			"This run was given a network to join (ABAI_NET_DIR or ABAI_NET_TOKEN) but has none: no aiip binary found. abai_peers says so too.",
		);
	});

	test("the instructions mention abai_peers only for a run that is on a network", () => {
		const instructions = (network: ComposeInput["network"]) =>
			composeInstructions({ identity: IDENTITY, manifest, mode: "turns", options: base, network });
		expect(instructions(net)).toContain(
			"abai_peers lists who is on this run's network; a member's message wakes you as abai.net.message, and abai_send answers it.",
		);
		expect(instructions(absent)).not.toContain("abai_peers");
		expect(instructions(undefined)).not.toContain("abai_peers");
	});
});

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
		expect(text).toContain("You are attached to the running program counter, in turns mode.");
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

	test("names the selected mode, not the manifest's first, and offers watches only where they exist", () => {
		// the fixture declares turns first; a run under ABAI_MODE=thread or sidecar is told so
		const turns = compose();
		expect(turns).not.toContain("abai_watch");
		expect(turns).toContain("nothing can wake you between touchpoints, so there are no watches");
		expect(turns).toContain("between touchpoints you do not run");
		// the MCP form's agent parks in abai_wait: live in every mode, watches included
		expect(compose({ form: "mcp" })).toContain("A watch (abai_watch) wakes you when a cell meets a condition");
		const thread = compose({}, "thread");
		expect(thread).toContain("You are attached to the running program counter, in thread mode.");
		expect(thread).toContain("# The program: counter (abaigrammar 0.1, mode thread)");
		expect(thread).toContain("A watch (abai_watch) wakes you when a cell meets a condition");
		expect(compose({ form: "mcp" }, "sidecar")).toContain(
			"You are attached to the running program counter, in sidecar mode, from an MCP client.",
		);
	});

	test("the owner's appended text ends the prompt and outranks the rules", () => {
		const plain = compose();
		const withText = composeSystemPrompt({
			identity: IDENTITY,
			manifest,
			mode: "turns",
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
			expect(
				composeSystemPrompt({ identity: IDENTITY, manifest, mode: "turns", options: base, addendum: blank }),
			).toBe(plain);
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
		const text = composeInstructions({
			identity: IDENTITY,
			manifest,
			mode: "sidecar",
			options: { ...base, form: "mcp" },
		});
		expect(text.startsWith("counter abai harness (abaigrammar 0.1, sidecar).")).toBe(true);
		expect(
			composeInstructions({
				identity: IDENTITY,
				manifest,
				mode: "thread",
				options: { ...base, form: "mcp" },
			}).startsWith("counter abai harness (abaigrammar 0.1, thread)."),
		).toBe(true);
		expect(text).toContain("You supervise a counter program.");
		expect(text).toContain("abai_prompt");
		expect(text).toContain("abai_wait");
		expect(text.length).toBeLessThan(2000);
	});
});
