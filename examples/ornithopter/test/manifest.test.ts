import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const entry = (...args: string[]) =>
	run(process.execPath, ["src/main.ts", "abai", ...args], { cwd: root, env: { ...process.env, ABAI_HARNESS: "off" } });

describe("the standard entry", () => {
	it("prints the manifest that is checked in", async () => {
		const { stdout } = await entry("manifest");
		expect(stdout).toBe(readFileSync(new URL("../abaigram.yaml", import.meta.url), "utf8"));
	});

	it("passes the offline doctor", async () => {
		const { stdout } = await entry("doctor", "--offline");
		expect(stdout).toContain("doctor: ok");
		expect(stdout).not.toMatch(/^fail/m);
	});

	it("leaves the program's own arguments alone", async () => {
		const { stdout } = await run(process.execPath, ["src/main.ts", "--help"], { cwd: root });
		expect(stdout).toContain("--demo");
	});
});
