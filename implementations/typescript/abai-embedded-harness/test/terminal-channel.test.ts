// The terminal channel over streams: what a person at a terminal, or a line
// piped into a session, gets back.
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { terminalChannel } from "../src/terminal-channel.ts";

function streams() {
	const input = new PassThrough();
	const output = new PassThrough();
	let written = "";
	output.on("data", (chunk) => {
		written += String(chunk);
	});
	return { input, output, text: () => written };
}

describe("terminalChannel", () => {
	test("a piped line whose pipe ends at once still gets the answer printed; the next ask is done", async () => {
		const { input, output, text } = streams();
		const channel = terminalChannel(input, output);
		input.end("hi\n");
		expect(await channel.ask("p> ")).toBe("hi");
		await new Promise((r) => setTimeout(r, 20));
		channel.say("the answer");
		expect(text()).toContain("the answer");
		expect(await channel.ask("p> ")).toBeUndefined();
		expect(await channel.confirm("t", "m", 100)).toBe(false);
		channel.close();
		channel.say("after close");
		expect(text()).not.toContain("after close");
	});

	test("input ending while a question is open resolves it with nothing and does not throw", async () => {
		const { input, output } = streams();
		const channel = terminalChannel(input, output);
		const asked = channel.ask("p> ");
		await new Promise((r) => setTimeout(r, 10));
		input.end();
		expect(await asked).toBeUndefined();
		expect(await channel.ask("p> ")).toBeUndefined();
		channel.close();
	});

	test("consent is a y/n question with a timeout; a timed-out question is withdrawn", async () => {
		const { input, output, text } = streams();
		const channel = terminalChannel(input, output);
		const denied = channel.confirm("Write worker.count", "to 8", 30);
		expect(await denied).toBe(false);
		input.write("y\n");
		expect(await channel.confirm("Write worker.count", "to 9", 1000)).toBe(true);
		input.write("n\n");
		expect(await channel.confirm("Write worker.count", "to 10", 1000)).toBe(false);
		expect(text()).toContain("Allow? [y/N]");
		channel.close();
	});
});
