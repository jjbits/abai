// The tool specifications apart from any front end: what consent each act
// needs, decided before anything reaches the program.
import { describe, expect, test } from "vitest";
import { Harness } from "../src/harness.ts";
import { defaultOptions } from "../src/options.ts";
import { HARNESS_TOOLS, type ToolFront } from "../src/tools.ts";

const tool = (name: string) => {
	const spec = HARNESS_TOOLS.find((t) => t.name === name);
	if (!spec) throw new Error(`no tool ${name}`);
	return spec;
};

describe("abai_lifecycle's consent", () => {
	test("stop and restart ask the person; with nobody to ask they are denied before the program is reached", async () => {
		// a harness attached to nothing: any op that reached it would fail with "not attached"
		const harness = new Harness(defaultOptions("session"));
		const noChannel: ToolFront = { form: "session", hasUI: false, confirm: async () => false };
		expect(await tool("abai_lifecycle").run(harness, { op: "stop", reason: "r" }, noChannel)).toBe(
			"lifecycle stop was not consented; nothing was done",
		);
		expect(await tool("abai_lifecycle").run(harness, { op: "restart", reason: "r" }, noChannel)).toBe(
			"lifecycle restart was not consented; nothing was done",
		);
		// a person who says no
		const refusing: ToolFront = { form: "session", hasUI: true, confirm: async () => false };
		expect(await tool("abai_lifecycle").run(harness, { op: "stop", reason: "r" }, refusing)).toMatch(/not consented/);
		// pause needs no consent, so it reaches the harness, which is attached to nothing
		await expect(tool("abai_lifecycle").run(harness, { op: "pause", reason: "r" }, noChannel)).rejects.toThrow(
			/needs the harness that launched the program/,
		);
		await expect(tool("abai_lifecycle").run(harness, { op: "status", reason: "r" }, noChannel)).rejects.toThrow(
			/not attached/,
		);
	});

	test("under the MCP form the client's consent stands, and a person who says yes is approved", async () => {
		const harness = new Harness(defaultOptions("session"));
		const mcp: ToolFront = { form: "mcp", hasUI: false, confirm: async () => false };
		// consent auto: the op reaches the harness, which is attached to nothing
		await expect(tool("abai_lifecycle").run(harness, { op: "stop", reason: "r" }, mcp)).rejects.toThrow(
			/not attached/,
		);
		const agreeing: ToolFront = { form: "session", hasUI: true, confirm: async () => true };
		await expect(tool("abai_lifecycle").run(harness, { op: "stop", reason: "r" }, agreeing)).rejects.toThrow(
			/not attached/,
		);
	});
});
