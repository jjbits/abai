// abaify with a faux model: a scripted agent retrofits the plain-cli fixture
// to level 1 through the capabilities, abaikit's own check judges each
// round, the report says what changed; an agent that never fixes stops at
// the knob; a dry run writes nothing; no model fails before any read.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type JsonObject } from "@arx-06/ai";
import { afterEach, describe, expect, test } from "vitest";
import { brief, runAbaify } from "../src/abaify.ts";
import { createApp } from "../src/app.ts";
import { type AbaikitIo, main, parseArgs } from "../src/bin.ts";
import { subjectEnv } from "../src/command.ts";

const root = resolve(import.meta.dirname, "..");
const plainCli = join(root, "test/fixtures/plain-cli");
const stubIndex = resolve(root, "../abai/src/index.ts");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function world(prefix: string) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	const repo = join(dir, "plain-cli");
	cpSync(plainCli, repo, { recursive: true });
	const env: NodeJS.ProcessEnv = {
		...subjectEnv(process.env),
		HOME: join(dir, "home"),
		ABAI_HOME: join(dir, "home", ".abai"),
		ABAI_RUN_DIR: join(dir, "run"),
		ABAI_HARNESS_BIN: join(dir, "no-such-harness"),
	};
	const out: string[] = [];
	const err: string[] = [];
	const io: AbaikitIo = { out: (t) => out.push(t), err: (t) => err.push(`${t}\n`), env, cwd: dir };
	return { dir, repo, env, io, out: () => out.join(""), err: () => err.join("") };
}

function fauxModel() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return {
		faux,
		model: { model: faux.getModel(), streamFn: (m: any, c: any, o: any) => models.streamSimple(m, c, o) },
	};
}

const call = (capability: string, params: JsonObject) =>
	fauxAssistantMessage([fauxToolCall("abai_call", { capability, params, reason: `abaify: ${capability}` })], {
		stopReason: "toolUse",
	});

/** The retrofit a careful agent makes of plain-cli, as scripted calls. */
function retrofit(repo: string) {
	const declaration = [
		'import { fileURLToPath } from "node:url";',
		`import { createAbaigram } from ${JSON.stringify(stubIndex)};`,
		"",
		"export const app = createAbaigram(",
		'\t{ name: "plain_cli", entry: "node src/main.js abai", modes: ["turns"], content: { identity: "abai/identity.md" }, audit: { path: "./abai-audit.log" } },',
		'\t{ root: fileURLToPath(new URL("..", import.meta.url)) },',
		");",
		"",
	].join("\n");
	const hook = [
		`import { runEntry } from ${JSON.stringify(stubIndex)};`,
		'import { app } from "./abai.mjs";',
		"const abaiCode = await runEntry(app, process.argv.slice(2));",
		"if (abaiCode >= 0) process.exit(abaiCode);",
		"",
	].join("\n");
	return [
		call("repo.list", { repo }),
		call("repo.read", { repo, path: "src/main.js" }),
		call("repo.add_dependency", { repo, name: "abai", why: "the stub" }),
		call("repo.write", { repo, path: "src/abai.mjs", content: declaration, why: "the declaration module" }),
		call("repo.insert", {
			repo,
			path: "src/main.js",
			anchor: "const arg = process.argv[2];",
			where: "before",
			text: hook,
			why: "the entry hook",
		}),
		call("repo.write", {
			repo,
			path: "abai/identity.md",
			content: "You are the agent fused into plain-cli, which counts items.\n",
			why: "the identity",
		}),
		call("repo.manifest", { repo, entry: "node src/main.js abai", why: "the manifest, from the program" }),
		call("check", { repo }),
		fauxAssistantMessage(
			"DONE\nAdded the stub, the declaration module, the entry hook, the identity and the manifest.",
			{ stopReason: "stop" },
		),
	];
}

describe("abaify", () => {
	test("a scripted agent retrofits plain-cli to level 1 through the capabilities; check judges it; the report says what changed", async () => {
		const w = world("abaify-ok-");
		const { faux, model } = fauxModel();
		faux.setResponses(retrofit(w.repo));
		const bundle = createApp(w.io);
		const code = await runAbaify(parseArgs(["abaify", "plain-cli", "--level", "1"]) as any, w.io, bundle, { model });
		expect(w.err()).toMatch(/^abaify: .* to level 1, with your consent for this run: the agent may add files/m);
		expect(w.err()).toContain("abaify: round 1 of 5");
		expect(w.err()).toMatch(/^abaify: write src\/abai.mjs: \d+ lines$/m);
		expect(code).toBe(0);
		expect(w.out()).toMatch(/^abaify: level 1 reached in 1 round$/m);
		// the files the agent added, and the program still runs as itself
		expect(existsSync(join(w.repo, "src/abai.mjs"))).toBe(true);
		expect(existsSync(join(w.repo, "abaigram.yaml"))).toBe(true);
		expect(readFileSync(join(w.repo, "src/main.js"), "utf8")).toContain("const abaiCode = await runEntry");
		expect(JSON.parse(readFileSync(join(w.repo, "package.json"), "utf8")).dependencies.abai).toMatch(/^file:/);
		const report = readFileSync(join(w.repo, "abai/abaify-report.md"), "utf8");
		expect(report).toMatch(/^# abaify report: .* \(run 1, /m);
		expect(report).toContain("Requested level 1; reached level 1; passed after 1 round");
		expect(report).toContain("## Added (new files and inserted lines");
		expect(report).toMatch(
			/## Rewritten in place by a structured tool\n\n- add_dependency package.json: abai: file:/,
		);
		expect(report).toMatch(/- write src\/abai.mjs: \d+ lines. Why: the declaration module/);
		expect(report).toMatch(/- insert src\/main.js: 4 lines before line \d+. Why: the entry hook/);
		expect(report).toContain("- manifest abaigram.yaml:");
		expect(report).toContain("DONE");
		expect(bundle.app.cell<number>("check.runs").get()).toBeGreaterThanOrEqual(2);
	}, 60_000);

	test("an agent that never fixes anything stops at the rounds knob, and the report says what remained", async () => {
		const w = world("abaify-stuck-");
		const { faux, model } = fauxModel();
		faux.setResponses([
			fauxAssistantMessage("I looked around and will get to it.", { stopReason: "stop" }),
			fauxAssistantMessage("Still looking.", { stopReason: "stop" }),
			fauxAssistantMessage("Not this time either.", { stopReason: "stop" }),
		]);
		const bundle = createApp(w.io);
		const code = await runAbaify(parseArgs(["abaify", "plain-cli", "--rounds", "2"]) as any, w.io, bundle, { model });
		expect(code).toBe(1);
		expect(w.out()).toMatch(/^abaify: level 1 not reached after 2 rounds \(reached 0\)/m);
		expect(bundle.app.knob<number>("abaify.max_rounds").get()).toBe(2);
		const report = readFileSync(join(w.repo, "abai/abaify-report.md"), "utf8");
		expect(report).toContain("### Round 2");
		expect(report).toMatch(/check could not run: .*no abaigram.yaml/);
		expect(report).toContain("(none)");
	}, 60_000);

	test("a dry run proposes the same changes and writes nothing", async () => {
		const w = world("abaify-dry-");
		const { faux, model } = fauxModel();
		faux.setResponses(retrofit(w.repo));
		const bundle = createApp(w.io);
		const code = await runAbaify(parseArgs(["abaify", "plain-cli", "--dry-run"]) as any, w.io, bundle, { model });
		expect(code).toBe(0);
		expect(w.out()).toMatch(/^dry run: \d+ changes proposed, nothing written$/m);
		expect(w.out()).toContain("dry run: would write");
		expect(w.out()).toMatch(/^Dry run to level 1: \d+ changes proposed, nothing written, no check run\.$/m);
		expect(existsSync(join(w.repo, "src/abai.mjs"))).toBe(false);
		expect(existsSync(join(w.repo, "abai"))).toBe(false);
		expect(readFileSync(join(w.repo, "src/main.js"), "utf8")).toBe(
			readFileSync(join(plainCli, "src/main.js"), "utf8"),
		);
	}, 60_000);

	test("a model that fails mid-run ends the loop at once, with the reason in the report", async () => {
		const w = world("abaify-dead-");
		const { faux, model } = fauxModel();
		const steps = retrofit(w.repo);
		faux.setResponses([
			steps[0],
			steps[1],
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "the model is down" }),
		]);
		const bundle = createApp(w.io);
		const code = await runAbaify(parseArgs(["abaify", "plain-cli"]) as any, w.io, bundle, { model });
		expect(code).toBe(1);
		expect(w.out()).toMatch(/^abaify: ended short after 1 round: the model could not be reached: /m);
		const report = readFileSync(join(w.repo, "abai/abaify-report.md"), "utf8");
		expect(report).toContain("The run ended short: the model could not be reached");
		expect(report).toContain("### Round 1");
	}, 60_000);

	test("a second run appends to the report with its own number; --rounds outside the knob's range is refused", async () => {
		const w = world("abaify-again-");
		const { faux, model } = fauxModel();
		faux.setResponses([
			fauxAssistantMessage("Nothing yet.", { stopReason: "stop" }),
			fauxAssistantMessage("Nothing again.", { stopReason: "stop" }),
		]);
		const bundle = createApp(w.io);
		await runAbaify(parseArgs(["abaify", "plain-cli", "--rounds", "1"]) as any, w.io, bundle, { model });
		await runAbaify(parseArgs(["abaify", "plain-cli", "--rounds", "1"]) as any, w.io, createApp(w.io), { model });
		const report = readFileSync(join(w.repo, "abai/abaify-report.md"), "utf8");
		expect(report.match(/^# abaify report: .* \(run 1, /gm)).toHaveLength(1);
		expect(report.match(/^# abaify report: .* \(run 2, /gm)).toHaveLength(1);
		await expect(
			runAbaify(parseArgs(["abaify", "plain-cli", "--rounds", "50"]) as any, w.io, createApp(w.io), { model }),
		).rejects.toThrow(/--rounds must be 1 to 20/);
	}, 60_000);

	test("the brief says the entry's form and whether the build output is there", () => {
		const w = world("abaify-brief-");
		const inv = {
			packageJson: { name: "x", bin: { x: "src/main.js" } },
			summary: "src/ (1 file)",
			total: 1,
			buildOutput: [] as string[],
		};
		const unbuilt = brief(w.repo, 2, undefined, inv, false);
		expect(unbuilt).toContain("must end with the word `abai`");
		expect(unbuilt).toContain("there is no build output, so choose a path that needs no build");
		const built = brief(w.repo, 2, undefined, { ...inv, buildOutput: ["dist"] }, false);
		expect(built).toContain("the build output is present (dist/)");
		expect(built).toContain("prefer a cell or event at a real boundary");
	});

	test("no model configured fails before any read, and a repository without package.json is refused", async () => {
		const w = world("abaify-nomodel-");
		expect(await main(["abaify", "plain-cli"], w.io)).toBe(1);
		expect(w.err()).toMatch(/no agent could be attached: .*(no model configured|model)/);
		expect(existsSync(join(w.repo, "abai"))).toBe(false);
		const bare = world("abaify-bare-");
		rmSync(join(bare.repo, "package.json"));
		expect(await main(["abaify", "plain-cli"], bare.io)).toBe(2);
		expect(bare.err()).toMatch(/no package.json; abaify retrofits Node repositories/);
	}, 30_000);
});
