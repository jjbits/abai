import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { type CliIo, doctorOnline, runConfig } from "../src/cli.ts";
import { FileCredentialStore, readConfig } from "../src/config.ts";
import { createModelSetup } from "../src/model/index.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
	const dir = mkdtempSync(`${tmpdir()}/abai-cli-`);
	dirs.push(dir);
	return dir;
}

function capture(home: string) {
	const out: string[] = [];
	const err: string[] = [];
	const cli: CliIo = { out: (t) => out.push(t), err: (t) => err.push(t), env: { ABAI_HOME: home } };
	return { cli, out, err };
}

describe("abai config", () => {
	test("shows, sets and unsets", async () => {
		const dir = home();
		const { cli, out, err } = capture(dir);
		expect(await runConfig([], cli)).toBe(0);
		expect(out.join("")).toContain("provider: (none)");
		expect(await runConfig(["set", "provider", "anthropic"], cli)).toBe(0);
		expect(await runConfig(["set", "model", "claude-opus-5"], cli)).toBe(0);
		expect(await runConfig(["set", "connect-timeout", "5000"], cli)).toBe(0);
		expect(await runConfig(["set", "url", "freetoken", "http://127.0.0.1:1919"], cli)).toBe(0);
		expect(await runConfig(["set", "url", "nope"], cli)).toBe(2);
		expect(await runConfig(["set", "key", "anthropic", "sk-test"], cli)).toBe(0);
		expect(readConfig(dir)).toEqual({
			provider: "anthropic",
			model: "claude-opus-5",
			connectTimeoutMs: 5000,
			providers: { freetoken: { FREETOKEN_BASE_URL: "http://127.0.0.1:1919" } },
		});
		expect(await new FileCredentialStore(dir).read("anthropic")).toEqual({ type: "api_key", key: "sk-test" });
		out.length = 0;
		expect(await runConfig(["show"], cli)).toBe(0);
		expect(out.join("")).toContain("credentials: anthropic (api_key)");
		expect(out.join("")).not.toContain("sk-test");
		expect(await runConfig(["unset", "key", "anthropic"], cli)).toBe(0);
		expect(await new FileCredentialStore(dir).read("anthropic")).toBeUndefined();
		expect(await runConfig(["set", "bogus", "1"], cli)).toBe(2);
		expect(await runConfig(["set", "connect-timeout", "-1"], cli)).toBe(2);
		expect(err.join("\n")).toMatch(/usage: abai config/);
	});
});

describe("doctor's online half", () => {
	test("fails with nothing configured, resolves a configured static model, probes its endpoint", async () => {
		const dir = home();
		const manifest = { model: { tools: true } } as never;
		expect(await doctorOnline(manifest, { ABAI_HOME: dir })).toMatchObject([{ name: "online", status: "fail" }]);
		const { cli } = capture(dir);
		await runConfig(["set", "provider", "anthropic"], cli);
		await runConfig(["set", "key", "anthropic", "sk-test"], cli);
		await runConfig(["set", "model", "no-such-model"], cli);
		expect(await doctorOnline(manifest, { ABAI_HOME: dir })).toMatchObject([
			{ name: "online", status: "fail", detail: expect.stringContaining("no model no-such-model") },
		]);
		const known = createModelSetup({ ABAI_HOME: dir }, dir).models.getModels("anthropic")[0].id;
		await runConfig(["set", "model", known], cli);
		// the reachability probe goes to the configured base URL: a closed local port, never the network
		await runConfig(["set", "url", "anthropic", "http://127.0.0.1:9"], cli);
		const checks = await doctorOnline(manifest, { ABAI_HOME: dir });
		expect(checks).toMatchObject([
			{ name: "online", status: "ok" },
			{ name: "reachable", status: "fail", detail: expect.stringContaining("could not be reached") },
			{ name: "model.tools", status: "skip" },
		]);
	});
});
