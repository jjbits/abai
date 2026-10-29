// abaikit on itself: the first abaigram checked by its own tool. Its entry
// `abaikit abai` is runnable only once the bin is installed, so the check
// is told `--entry "node dist/bin.js abai"`; its own check.run spawns
// `node dist/bin.js check examples/hello`, so the workspace is built first,
// as the seam test does.
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, expect, test } from "vitest";
import { type AbaikitIo, main } from "../src/bin.ts";
import type { CheckReport } from "../src/check.ts";

const root = resolve(import.meta.dirname, "..");
const workspace = resolve(root, "..");
const dirs: string[] = [];
beforeAll(() => {
	try {
		execSync("npm run build", { cwd: workspace, stdio: "pipe" });
	} catch (error) {
		const failed = error as { stdout?: Buffer; stderr?: Buffer; message: string };
		throw new Error(`the build failed: ${failed.message}\n${failed.stdout ?? ""}\n${failed.stderr ?? ""}`);
	}
}, 120_000);
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("abaikit is level 3 on itself: learnabai and check called, the write capabilities named unexercised", async () => {
	const dir = mkdtempSync(join(tmpdir(), "check-self-"));
	dirs.push(dir);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: join(dir, "home"),
		ABAI_HOME: join(dir, "home", ".abai"),
		ABAI_RUN_DIR: join(dir, "run"),
	};
	const out: string[] = [];
	const err: string[] = [];
	const io: AbaikitIo = { out: (t) => out.push(t), err: (t) => err.push(`${t}\n`), env, cwd: root };
	const code = await main(["check", ".", "--entry", "node dist/bin.js abai", "--runs", "1", "--json"], io);
	expect(err.join("")).toBe("");
	const report = JSON.parse(out.join("")) as CheckReport;
	expect(report).toMatchObject({ name: "abaikit", level: 3, passed: true, declaredModes: ["turns", "sidecar"] });
	expect(code).toBe(0);
	for (const m of report.perMode) {
		expect(m.level).toBe(3);
		expect(m.evidence.l2).toContain("check.runs");
		expect(m.evidence.l2).toContain("check.last_level");
		expect(m.evidence.l3).toContain("learnabai");
		expect(m.evidence.l3).toContain("check");
		expect(m.evidence.l3).toContain("abaify.max_rounds");
	}
	// the write capabilities declare no example, by design, and the event only abaify emits is not reached here
	const unexercised = report.unexercised.filter((u) => u.mode === "turns").map((u) => `${u.name}: ${u.why}`);
	expect(unexercised).toEqual(
		expect.arrayContaining([
			"new: no example declared",
			"repo.write: no example declared",
			"repo.insert: no example declared",
			"repo.add_dependency: no example declared",
			"repo.manifest: no example declared",
			"repo.install: no example declared",
			"repo.changed: not emitted during the exercise run",
		]),
	);
	expect(unexercised.some((u) => u.startsWith("repo.list") || u.startsWith("repo.read"))).toBe(false);
	for (const m of report.perMode) {
		expect(m.evidence.l3).toContain("repo.list");
		expect(m.evidence.l3).toContain("repo.read");
	}
	expect(report.violations).toEqual([]);
}, 180_000);
