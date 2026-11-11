import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinProviders } from "@arx-06/ai/providers/all";
import { afterEach, describe, expect, test } from "vitest";
import {
	abaiHome,
	CONFIG_FILE,
	DEFAULT_CONNECT_TIMEOUT_MS,
	FileCredentialStore,
	readConfig,
	writeConfig,
} from "../src/config.ts";
import { authContextFor, createModelSetup, ModelNotConfigured, resolveConfiguredModel } from "../src/model/index.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
	const dir = mkdtempSync(`${tmpdir()}/abai-home-`);
	dirs.push(dir);
	return dir;
}

describe("the configuration directory", () => {
	test("ABAI_HOME wins, then ~/.abai", () => {
		expect(abaiHome({ ABAI_HOME: "/x/y" })).toBe("/x/y");
		expect(abaiHome({ HOME: "/home/me" })).toBe("/home/me/.abai");
	});

	test("config.json round-trips and defaults the connect timeout", () => {
		const dir = home();
		expect(readConfig(dir)).toEqual({ connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS });
		writeConfig(dir, {
			provider: "anthropic",
			model: "claude-opus-5",
			connectTimeoutMs: 1000,
			providers: { freetoken: { FREETOKEN_BASE_URL: "http://127.0.0.1:1919" } },
		});
		expect(readConfig(dir)).toEqual({
			provider: "anthropic",
			model: "claude-opus-5",
			connectTimeoutMs: 1000,
			providers: { freetoken: { FREETOKEN_BASE_URL: "http://127.0.0.1:1919" } },
		});
		expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
	});

	test("the aiip binary setting is kept when it is a string and dropped otherwise", () => {
		const dir = home();
		writeConfig(dir, { connectTimeoutMs: 1, aiip: { bin: "/opt/aiip" } });
		expect(readConfig(dir).aiip).toEqual({ bin: "/opt/aiip" });
		writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ connectTimeoutMs: 1, aiip: { bin: 5 } }));
		expect(readConfig(dir).aiip).toBeUndefined();
		writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ connectTimeoutMs: 1, aiip: null }));
		expect(readConfig(dir).aiip).toBeUndefined();
	});

	test("credentials live in a private file, read fresh, written through modify", async () => {
		const dir = home();
		const store = new FileCredentialStore(dir);
		expect(await store.read("anthropic")).toBeUndefined();
		expect(await store.list()).toEqual([]);
		await store.modify("anthropic", async () => ({ type: "api_key", key: "sk-test" }));
		expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-test" });
		expect(statSync(store.path).mode & 0o777).toBe(0o600);
		// another process's write is seen at once
		const other = new FileCredentialStore(dir);
		await other.modify("freetoken", async () => ({ type: "api_key", env: { FREETOKEN_BASE_URL: "http://h" } }));
		expect((await store.list()).map((c) => c.providerId).sort()).toEqual(["anthropic", "freetoken"]);
		// modify returning undefined leaves the entry; delete removes it
		await store.modify("anthropic", async (current) => {
			expect(current).toEqual({ type: "api_key", key: "sk-test" });
			return undefined;
		});
		expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-test" });
		await store.delete("anthropic");
		expect(await store.read("anthropic")).toBeUndefined();
		expect(JSON.parse(readFileSync(store.path, "utf8"))).toEqual({
			freetoken: { type: "api_key", env: { FREETOKEN_BASE_URL: "http://h" } },
		});
	});

	test("concurrent writes to different providers never lose each other", async () => {
		const dir = home();
		const store = new FileCredentialStore(dir);
		const other = new FileCredentialStore(dir); // another process, another chain
		await Promise.all([
			store.modify("anthropic", async () => {
				await new Promise((done) => setTimeout(done, 10));
				return { type: "api_key", key: "a" };
			}),
			other.modify("freetoken", async () => ({ type: "api_key", env: { FREETOKEN_BASE_URL: "http://h" } })),
		]);
		expect((await store.list()).map((c) => c.providerId).sort()).toEqual(["anthropic", "freetoken"]);
	});

	test("concurrent modifies of one provider are serialized", async () => {
		const store = new FileCredentialStore(home());
		await Promise.all(
			[1, 2, 3].map((n) =>
				store.modify("p", async (current) => {
					await new Promise((done) => setTimeout(done, 5));
					const key = current?.type === "api_key" ? `${current.key ?? ""}${n}` : `${n}`;
					return { type: "api_key", key };
				}),
			),
		);
		const final = await store.read("p");
		expect(final?.type === "api_key" ? final.key : "").toBe("123");
	});
});

describe("the configured model", () => {
	test("every provider arx-06 carries is registered, FreeToken beside them, nothing else", () => {
		const dir = home();
		const ids = createModelSetup({ ABAI_HOME: dir }, dir)
			.models.getProviders()
			.map((p) => p.id);
		const expected = [...builtinProviders().map((p) => p.id), "freetoken"];
		expect(expected.length).toBeGreaterThanOrEqual(43);
		expect([...ids].sort()).toEqual([...expected].sort());
	});

	test("a caller's extra provider is registered after the built-in ones", () => {
		const dir = home();
		const base = createModelSetup({ ABAI_HOME: dir }, dir).models.getProviders().length;
		const scripted = { id: "scripted", name: "Scripted", auth: {}, getModels: () => [] };
		const ids = createModelSetup({ ABAI_HOME: dir }, dir, [scripted as never])
			.models.getProviders()
			.map((p) => p.id);
		expect(ids.length).toBe(base + 1);
		expect(ids.at(-1)).toBe("scripted");
	});

	test("the providers' auth context: configuration before environment, files checked with ~ expanded", async () => {
		const dir = home();
		writeFileSync(join(dir, "adc.json"), "{}");
		const ctx = authContextFor(
			{ connectTimeoutMs: 1, providers: { x: { X_KEY: "from-config" } } },
			{ HOME: dir, X_KEY: "from-env", Y_KEY: "env", EMPTY: "" },
		);
		expect(await ctx.env("X_KEY")).toBe("from-config");
		expect(await ctx.env("Y_KEY")).toBe("env");
		expect(await ctx.env("EMPTY")).toBeUndefined();
		expect(await ctx.env("Z_KEY")).toBeUndefined();
		expect(await ctx.fileExists("~/adc.json")).toBe(true);
		expect(await ctx.fileExists("~/missing.json")).toBe(false);
		expect(await ctx.fileExists(join(dir, "adc.json"))).toBe(true);
		expect(await ctx.fileExists("~")).toBe(true);
	});

	test("nothing configured: attach would fail at once, without network", async () => {
		const dir = home();
		await expect(resolveConfiguredModel(createModelSetup({ ABAI_HOME: dir }, dir))).rejects.toBeInstanceOf(
			ModelNotConfigured,
		);
	});

	test("a provider with no credential fails; with one, a known static model resolves offline", async () => {
		const dir = home();
		writeConfig(dir, { provider: "anthropic", model: "claude-opus-5", connectTimeoutMs: 1000 });
		await expect(resolveConfiguredModel(createModelSetup({ ABAI_HOME: dir }, dir))).rejects.toThrow(
			/no complete configuration/,
		);
		await new FileCredentialStore(dir).modify("anthropic", async () => ({ type: "api_key", key: "sk-test" }));
		const setup = createModelSetup({ ABAI_HOME: dir }, dir);
		const known = setup.models.getModels("anthropic").map((m) => m.id);
		expect(known.length).toBeGreaterThan(0);
		writeConfig(dir, { provider: "anthropic", model: known[0], connectTimeoutMs: 1000 });
		const resolved = await resolveConfiguredModel(createModelSetup({ ABAI_HOME: dir }, dir));
		expect(resolved.model.id).toBe(known[0]);
		expect(typeof resolved.streamFn).toBe("function");
		writeConfig(dir, { provider: "anthropic", model: "no-such-model", connectTimeoutMs: 1000 });
		await expect(resolveConfiguredModel(createModelSetup({ ABAI_HOME: dir }, dir))).rejects.toThrow(
			/no model no-such-model \(known: /,
		);
	});

	test("an environment variable satisfies a provider's auth through the configuration's context", async () => {
		const dir = home();
		writeConfig(dir, { provider: "anthropic", model: "x", connectTimeoutMs: 1000 });
		const setup = createModelSetup({ ABAI_HOME: dir, ANTHROPIC_API_KEY: "sk-env" }, dir);
		expect(await setup.models.checkAuth("anthropic")).toBeTruthy();
	});
});
