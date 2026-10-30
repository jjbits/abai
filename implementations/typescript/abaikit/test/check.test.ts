// abaikit check: level 1 through a subject's entry, levels 2 to 4 through
// its check.run under the exercise harness in each mode, the measurement
// side by side, the violations with their locations. Subjects run from
// temporary copies with their imports pointed at the stub's source; no
// model, no network.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createAbaikit } from "../src/abaigram.ts";
import { type AbaikitIo, main } from "../src/bin.ts";
import { type CheckReport, checkHandler } from "../src/check.ts";
import { lastJsonLine, median, subjectEnv } from "../src/command.ts";

const root = resolve(import.meta.dirname, "..");
const counterExample = resolve(root, "../abai-stub/examples/counter");
const helloExample = join(root, "examples/hello");
const stubSrc = resolve(root, "../abai-stub/src");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary directory with a home, a run directory and the environment a subject's runs get. */
function world(prefix: string) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	// what a subject's runs get, built from ours without the behaviour variables (a developer's ABAI_HARNESS must not
	// attach a null harness inside this process or the subjects)
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
	return { dir, env, io, out: () => out.join(""), err: () => err.join("") };
}

function copyCounter(dir: string): string {
	const copy = join(dir, "counter");
	cpSync(counterExample, copy, { recursive: true });
	const program = join(copy, "counter.ts");
	writeFileSync(program, readFileSync(program, "utf8").replaceAll("../../src/", `${stubSrc}/`));
	return copy;
}

function copyHello(dir: string): string {
	const copy = join(dir, "hello");
	cpSync(helloExample, copy, { recursive: true });
	const program = join(copy, "hello.ts");
	writeFileSync(
		program,
		readFileSync(program, "utf8").replace('from "@abaigram/abai-stub"', `from "${stubSrc}/index.ts"`),
	);
	return copy;
}

/** Regenerate a copy's abaigram.yaml from its code, as the abaigrammer would after a change. */
function regenerate(copy: string, program: string, env: NodeJS.ProcessEnv): void {
	const result = spawnSync(process.execPath, [join(copy, program), "abai", "manifest"], {
		cwd: copy,
		env: subjectEnv(env),
		encoding: "utf8",
		timeout: 20_000,
	});
	if (result.status !== 0) throw new Error(`manifest failed: ${result.stderr}`);
	writeFileSync(join(copy, "abaigram.yaml"), result.stdout);
}

async function checkJson(io: AbaikitIo, args: string[]): Promise<{ code: number; report: CheckReport }> {
	const out: string[] = [];
	const code = await main(["check", ...args, "--json"], { ...io, out: (t) => out.push(t) });
	return { code, report: JSON.parse(out.join("")) as CheckReport };
}

describe("abaikit check", () => {
	test("the smallest abaigram is level 1, says check.run is missing, and fails a requested level 4", async () => {
		const w = world("check-hello-");
		const hello = copyHello(w.dir);
		const { code, report } = await checkJson(w.io, [hello]);
		expect(code).toBe(0);
		expect(report).toMatchObject({
			name: "hello",
			level: 1,
			passed: true,
			declaredModes: ["turns"],
		});
		expect(report.checkRun).toBeUndefined();
		expect(report.l1).toMatchObject({ ok: true, manifestAgrees: true });
		expect(report.l1.doctor.find((c) => c.name === "identity")?.status).toBe("ok");
		expect(report.notes.join(" ")).toContain("check.run is not declared");
		expect(report.perMode).toEqual([]);
		const demanded = await main(["check", hello, "--level", "4"], w.io);
		expect(demanded).toBe(1);
		expect(w.out()).toMatch(/^level: 1 reachable \(requested 4: not reached\)$/m);
		expect(w.out()).toMatch(/^L2 observable: not shown$/m);
	}, 30_000);

	test("the counter is level 4 under both modes: the exercise reaches the decision, calls job.retry, lands the knob, and the overhead is measured", async () => {
		const w = world("check-counter-");
		const counter = copyCounter(w.dir);
		const { code, report } = await checkJson(w.io, [counter, "--runs", "1"]);
		expect(code).toBe(0);
		expect(report).toMatchObject({ name: "counter", level: 4, passed: true, compiledOut: "not offered" });
		expect(report.checkedModes).toEqual(["turns", "sidecar"]);
		expect(report.perMode.map((m) => [m.mode, m.level])).toEqual([
			["turns", 4],
			["sidecar", 4],
		]);
		for (const m of report.perMode) {
			expect(m.evidence.l2).toContain("queue.depth");
			expect(m.evidence.l3).toContain("job.retry");
			expect(m.evidence.l3).toContain("worker.count");
			expect(m.evidence.l4).toBe("decisions reached: 1");
			expect(m.exercise?.report).toMatchObject({ form: "exercise", decisions: 1 });
			expect(m.measurement?.off).toHaveLength(1);
			expect(m.measurement?.null).toHaveLength(1);
			expect(m.measurement?.offMedianMs).toBeGreaterThan(0);
			expect(m.measurement?.failed).toEqual([]);
		}
		expect(report.unexercised).toEqual([]);
		expect(report.violations).toEqual([]);
		// the text form carries the table and the sidecar note
		const text = await main(["check", counter, "--runs", "1", "--mode", "turns"], w.io);
		expect(text).toBe(0);
		expect(w.out()).toMatch(/^level: 4 deliberative \(no violations\)$/m);
		expect(w.out()).toMatch(/^overhead \(check.run: node counter.ts 5; /m);
		expect(w.out()).toMatch(/^ {2}turns +1 +\d+ \(\d+\.\.\d+\) +\d+ \(\d+\.\.\d+\) +([+-]\d+\.\d%|n\/a) +none/m);
	}, 90_000);

	test("a stale abaigram.yaml and a missing identity are violations that keep the level at 0", async () => {
		const w = world("check-stale-");
		const counter = copyCounter(w.dir);
		const manifest = join(counter, "abaigram.yaml");
		writeFileSync(
			manifest,
			readFileSync(manifest, "utf8").replace("doc: Number of jobs waiting.", "doc: Number of jobs."),
		);
		const stale = await checkJson(w.io, [counter, "--runs", "1"]);
		expect(stale.code).toBe(1);
		expect(stale.report.level).toBe(0);
		expect(stale.report.violations.map((v) => v.what)).toEqual(
			expect.arrayContaining([
				expect.stringMatching(
					/is stale: first difference at line \d+; run: node counter.ts abai manifest > abaigram.yaml/,
				),
			]),
		);
		expect(stale.report.perMode).toEqual([]);
		const w2 = world("check-identity-");
		const hello = copyHello(w2.dir);
		unlinkSync(join(hello, "abai", "identity.md"));
		const missing = await checkJson(w2.io, [hello]);
		expect(missing.code).toBe(1);
		expect(missing.report.level).toBe(0);
		expect(missing.report.violations).toEqual(
			expect.arrayContaining([{ where: "doctor: identity", what: expect.stringMatching(/identity.md is missing/) }]),
		);
	}, 60_000);

	test("a declared check.overhead the null-harness run exceeds is a violation; a mode the manifest does not declare is one too", async () => {
		const w = world("check-overhead-");
		const counter = copyCounter(w.dir);
		// a check.run that is slower under the null harness, deterministically, so the limit is exceeded every time
		writeFileSync(
			join(counter, "check.sh"),
			'node counter.ts 5\nif [ "$ABAI_HARNESS" = null ]; then sleep 0.3; fi\n',
		);
		const program = join(counter, "counter.ts");
		writeFileSync(
			program,
			readFileSync(program, "utf8").replace(
				'check: { run: "node counter.ts 5" },',
				'check: { run: "sh check.sh", overhead: "1%" },',
			),
		);
		regenerate(counter, "counter.ts", w.env);
		const { code, report } = await checkJson(w.io, [counter, "--runs", "1", "--mode", "turns"]);
		expect(code).toBe(1);
		expect(report.level).toBe(4);
		expect(report.overheadLimit).toBe("1%");
		expect(report.perMode[0]?.measurement?.limit).toBe(0.01);
		expect(report.violations.map((v) => v.what).join("\n")).toMatch(
			/slower than the off run .*; check.overhead allows 1%/,
		);
		const w2 = world("check-mode-");
		const hello = copyHello(w2.dir);
		const wrong = await checkJson(w2.io, [hello, "--mode", "sidecar"]);
		expect(wrong.code).toBe(1);
		expect(wrong.report.level).toBe(1);
		expect(wrong.report.checkedModes).toEqual([]);
		expect(wrong.report.violations).toEqual([{ where: "--mode", what: "hello declares turns, not sidecar" }]);
	}, 90_000);

	test("a check.run that hangs is ended at the timeout by its own handle and reported; --entry overrides the manifest's", async () => {
		const w = world("check-hang-");
		const counter = copyCounter(w.dir);
		const program = join(counter, "counter.ts");
		// a compound command: the shell stays, the hang is a generation down, and the timeout must still reach it
		writeFileSync(
			program,
			readFileSync(program, "utf8").replace(
				'check: { run: "node counter.ts 5" },',
				'check: { run: "node counter.ts 1; node -e \\"setInterval(() => {}, 1000)\\"; echo after" },',
			),
		);
		regenerate(counter, "counter.ts", w.env);
		const started = Date.now();
		const { code, report } = await checkJson(w.io, [counter, "--runs", "1", "--mode", "turns", "--timeout", "1"]);
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(code).toBe(1);
		expect(report.level).toBe(1);
		expect(report.perMode[0]?.exercise?.run.timedOut).toBe(true);
		expect(report.violations[0]).toMatchObject({
			where: "check.run under turns with ABAI_HARNESS=exercise",
			what: expect.stringMatching(/did not finish within the timeout and was ended/),
		});
		const w2 = world("check-entry-");
		const hello = copyHello(w2.dir);
		const wrongEntry = await checkJson(w2.io, [hello, "--entry", "node nope.js abai"]);
		expect(wrongEntry.code).toBe(1);
		expect(wrongEntry.report.level).toBe(0);
		expect(wrongEntry.report.entry).toBe("node nope.js abai");
		expect(wrongEntry.report.violations.map((v) => v.where)).toEqual(
			expect.arrayContaining(["node nope.js abai manifest", "node nope.js abai doctor --offline --json"]),
		);
	}, 60_000);

	test("the check capability runs the same check and reports into abaikit's own cells and event", async () => {
		const w = world("check-capability-");
		copyHello(w.dir);
		const app = createAbaikit({}, { env: w.env });
		app.capability("check", checkHandler(app, { cwd: w.dir, env: w.env }));
		const handler = app.capabilityHandler("check");
		const result = (await handler?.({ repo: "hello" })) as { level: number; passed: boolean; report: string };
		expect(result).toMatchObject({ level: 1, passed: true });
		expect(result.report).toMatch(/^abaikit check: hello at /);
		expect(app.cell<number>("check.runs").get()).toBe(1);
		expect(app.cell<number>("check.last_level").get()).toBe(1);
		await expect(handler?.({ repo: "hello", level: 9 })).rejects.toThrow(/level must be 1 to 4/);
		await expect(handler?.({})).rejects.toThrow(/check needs a repo/);
	}, 30_000);
});

describe("the command helpers", () => {
	test("the subject's environment keeps where things are and drops what to do; the last JSON line and the median", () => {
		const env = subjectEnv(
			{
				PATH: "/bin",
				ABAI_HOME: "/h",
				ABAI_MODE: "sidecar",
				ABAI_HARNESS: "exercise",
				ABAI_RUN_DIR: "/r",
				ABAI_CHANNEL: "none",
			},
			{ ABAI_HARNESS: "null" },
		);
		expect(env).toEqual({ PATH: "/bin", ABAI_HOME: "/h", ABAI_RUN_DIR: "/r", ABAI_HARNESS: "null" });
		expect(lastJsonLine('noise\n{"a":1}\nmore noise\n{"form":"exercise","n":2}\ntrailing')).toEqual({
			form: "exercise",
			n: 2,
		});
		expect(lastJsonLine("nothing here")).toBeUndefined();
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
	});
});
