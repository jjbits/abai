// abaikit check: conformance as section 12 defines it, with no model.
// Level 1 is reached through the subject's entry alone (what `manifest`
// prints, byte for byte the checked-in file, and `doctor --offline --json`); levels 2 to 4 through its `check.run`
// under the exercise null harness, once per declared mode, read from the
// report the stub prints at exit; the overhead of 11.6 by the same command
// under `ABAI_HARNESS=off` and `ABAI_HARNESS=null`, interleaved, side by
// side. The subject's environment is constructed, never inherited: each
// run gets exactly the `ABAI_HARNESS` and `ABAI_MODE` it means, the entry
// runs get neither. A level is the one reached under every checked mode,
// and passing means that level with no violation.
import { readFileSync } from "node:fs";
import type { Abaigram, DoctorCheck, Manifest, Mode } from "abai";
import { parseManifestYaml, validateManifest } from "abai";
import type { ParsedArgs } from "./bin.ts";
import {
	type CommandRun,
	jsonDocument,
	lastJsonLine,
	lastPlainLine,
	median,
	runCommand,
	subjectEnv,
	tailOf,
} from "./command.ts";
import { type AbaikitIo, errorMessage, UsageError } from "./io.ts";
import { entryCommand, loadSubject, type Subject } from "./subject.ts";

export const DEFAULT_RUNS = 3;
export const DEFAULT_TIMEOUT_MS = 120_000;
/** How long an entry verb (manifest, doctor) may take. */
export const ENTRY_TIMEOUT_MS = 60_000;
/** Below this median for the off run, startup noise is most of the number. */
export const NOISE_FLOOR_MS = 500;
/** Characters of a run's output the JSON report carries. */
const REPORT_TAIL_CHARS = 4096;
export const LEVEL_NAMES = ["none", "reachable", "observable", "steerable", "deliberative"] as const;

export interface CheckOptions {
	repo: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	level?: number;
	mode?: Mode;
	entry?: string;
	runs?: number;
	timeoutMs?: number;
}

/** What the stub's exercise harness reports at exit (abai's NullHarnessReport, as JSON on stderr). */
export interface ExerciseReport {
	form: string;
	events: number;
	dropped: number;
	decisions: number;
	turns: number;
	touchpoints: number;
	cellsWritten: string[];
	/** The program's own events, by name; absent in a report from an older stub. */
	eventsEmitted?: string[];
	knobsWritten: string[];
	capabilitiesCalled: string[];
	unexercised: Array<{ kind: string; name: string; why: string }>;
}

export interface Measurement {
	runs: number;
	off: number[];
	null: number[];
	offMedianMs: number;
	nullMedianMs: number;
	/** null over off, minus one; NaN when either side has no run. */
	slowdown: number;
	limit?: number;
	/** The runs that did not exit 0 or timed out, by harness. */
	failed: string[];
	/** The numbers are within startup noise or the two ranges overlap. */
	withinNoise: boolean;
}

export interface ModeResult {
	mode: Mode;
	/** The highest level this mode demonstrated, 1 to 4. */
	level: number;
	exercise?: { run: CommandRun; report?: ExerciseReport };
	evidence: { l2: string; l3: string; l4: string };
	measurement?: Measurement;
}

export interface Violation {
	where: string;
	what: string;
}

export interface CheckReport {
	root: string;
	name: string;
	abaigrammar: string;
	entry: string;
	declaredModes: Mode[];
	checkedModes: Mode[];
	checkRun?: string;
	overheadLimit?: string;
	/** This instantiation offers no build with the stub compiled out, and builds nothing: the command runs as is. */
	compiledOut: "not offered";
	built: "no";
	l1: { ok: boolean; manifestAgrees: boolean; doctor: DoctorCheck[]; ran: string[]; detail: string };
	perMode: ModeResult[];
	level: number;
	requested?: number;
	passed: boolean;
	unexercised: Array<{ mode: Mode; kind: string; name: string; why: string }>;
	violations: Violation[];
	notes: string[];
}

function parseOverhead(limit: string | undefined): number | undefined {
	if (limit === undefined) return undefined;
	const match = /^(\d+(?:\.\d+)?)\s*%$/.exec(limit.trim());
	return match ? Number(match[1]) / 100 : undefined;
}

function firstDifferingLine(a: string, b: string): number {
	const al = a.split("\n");
	const bl = b.split("\n");
	for (let i = 0; i < Math.max(al.length, bl.length); i++) if (al[i] !== bl[i]) return i + 1;
	return 0;
}

function isExerciseReport(
	value: Record<string, unknown> | undefined,
): value is ExerciseReport & Record<string, unknown> {
	return value !== undefined && value.form === "exercise" && Array.isArray(value.unexercised);
}

function describeRun(run: CommandRun): string {
	if (run.timedOut) return "did not finish within the timeout and was ended";
	if (run.code !== 0) return `exited ${run.code ?? run.signal ?? "?"}`;
	return "exited 0";
}

function lastWords(run: CommandRun): string {
	return lastPlainLine(run.stderr) || lastPlainLine(run.stdout) || "no output";
}

/** A run as the JSON report carries it: the newest part of each stream, not a whole log. */
function trimmed(run: CommandRun): CommandRun {
	return { ...run, stdout: tailOf(run.stdout, REPORT_TAIL_CHARS), stderr: tailOf(run.stderr, REPORT_TAIL_CHARS) };
}

/** Level 1 through the entry: the effective manifest, the checked-in file, the offline doctor. */
async function checkLevelOne(
	subject: Subject,
	entry: string,
	env: NodeJS.ProcessEnv,
	violations: Violation[],
): Promise<CheckReport["l1"]> {
	const manifest = subject.manifest;
	const fileText = readFileSync(subject.manifestPath, "utf8");
	let manifestAgrees = false;
	const details: string[] = [];
	const ran: string[] = [];
	// what the entry prints is the manifest: byte for byte the checked-in file (section 12), and valid
	const manifestCommand = entryCommand(manifest, "manifest");
	ran.push(manifestCommand);
	const shown = await runCommand(manifestCommand, { cwd: subject.root, env, timeoutMs: ENTRY_TIMEOUT_MS });
	if (shown.code !== 0) {
		violations.push({ where: manifestCommand, what: `${describeRun(shown)}: ${lastWords(shown)}` });
	} else {
		let effective: unknown;
		try {
			effective = parseManifestYaml(shown.stdout);
		} catch (error) {
			violations.push({ where: manifestCommand, what: `did not print a manifest: ${errorMessage(error)}` });
		}
		if (effective !== undefined) {
			const problems = validateManifest(effective);
			if (problems.length > 0) {
				violations.push({
					where: manifestCommand,
					what: `the printed manifest does not validate: ${problems.join("; ")}`,
				});
			} else if ((effective as Manifest).name !== manifest.name) {
				violations.push({
					where: subject.manifestPath,
					what: `names ${manifest.name}, but the entry's program is ${(effective as Manifest).name}`,
				});
			} else if (shown.stdout === fileText) {
				manifestAgrees = true;
				details.push("abaigram.yaml is what the entry prints");
			} else {
				violations.push({
					where: subject.manifestPath,
					what: `is stale: first difference at line ${firstDifferingLine(fileText, shown.stdout)}; run: ${entry} manifest > abaigram.yaml`,
				});
			}
		}
	}
	let doctor: DoctorCheck[] = [];
	const doctorCommand = entryCommand(manifest, "doctor", "--offline", "--json");
	ran.push(doctorCommand);
	const examined = await runCommand(doctorCommand, { cwd: subject.root, env, timeoutMs: ENTRY_TIMEOUT_MS });
	const parsed = jsonDocument(examined.stdout);
	if (parsed && Array.isArray(parsed.checks)) {
		doctor = parsed.checks as DoctorCheck[];
		for (const check of doctor) {
			// the manifest file is judged above, with the hint for this entry; the doctor's word on it would repeat it
			if (check.status === "fail" && check.name !== "abaigram.yaml") {
				violations.push({ where: `doctor: ${check.name}`, what: check.detail });
			}
		}
		const failed = doctor.filter((c) => c.status === "fail").length;
		details.push(`doctor: ${doctor.filter((c) => c.status === "ok").length} ok, ${failed} failed`);
	} else {
		violations.push({
			where: doctorCommand,
			what: `${describeRun(examined)} and printed no report: ${lastWords(examined)}`,
		});
	}
	const ok = manifestAgrees && doctor.length > 0 && doctor.every((c) => c.status !== "fail");
	return { ok, manifestAgrees, doctor, ran, detail: details.join("; ") };
}

function spread(values: number[]): { min: number; max: number } {
	return { min: Math.min(...values), max: Math.max(...values) };
}

/** Levels 2 to 4 and the measurement, under one mode. */
async function checkMode(
	subject: Subject,
	mode: Mode,
	options: { runs: number; timeoutMs: number; env: NodeJS.ProcessEnv },
	violations: Violation[],
	unexercised: CheckReport["unexercised"],
	notes: string[],
): Promise<ModeResult> {
	const manifest = subject.manifest;
	const check = manifest.check as { run: string; overhead?: string };
	const result: ModeResult = { mode, level: 1, evidence: { l2: "", l3: "", l4: "" } };
	const where = (harness: string) => `check.run under ${mode} with ABAI_HARNESS=${harness}`;
	const run = await runCommand(check.run, {
		cwd: subject.root,
		env: subjectEnv(options.env, { ABAI_HARNESS: "exercise", ABAI_MODE: mode }),
		timeoutMs: options.timeoutMs,
	});
	result.exercise = { run: trimmed(run) };
	// the report is the stub's exit hook: it is there even when the program failed, and says what was reached
	const report = lastJsonLine(run.stderr, (v) => v.form === "exercise");
	if (isExerciseReport(report)) {
		result.exercise.report = report;
		for (const u of report.unexercised) unexercised.push({ mode, ...u });
		for (const cell of manifest.cells) {
			if (cell.access === "read" && !report.cellsWritten.includes(cell.name)) {
				unexercised.push({ mode, kind: "cell", name: cell.name, why: "not written during the exercise run" });
			}
		}
		if (report.eventsEmitted) {
			for (const event of manifest.events) {
				if (!report.eventsEmitted.includes(event.name)) {
					unexercised.push({ mode, kind: "event", name: event.name, why: "not emitted during the exercise run" });
				}
			}
		}
	}
	if (run.timedOut || run.code !== 0) {
		violations.push({ where: where("exercise"), what: `${describeRun(run)}: ${lastWords(run)}` });
		return result;
	}
	if (!isExerciseReport(report)) {
		violations.push({
			where: where("exercise"),
			what: `printed no exercise report at exit${run.dropped.stderr > 0 ? ` in the ${run.stderr.length} newest bytes of stderr kept` : ""}: the stub did not attach its null harness (is the entry hook in main, and the program built?)`,
		});
		return result;
	}
	// the program's own events, by name; a report that names none (an older stub) shows none: the library's do not count
	const emitted = report.eventsEmitted ?? [];
	const l2 = report.cellsWritten.length > 0 || emitted.length > 0;
	result.evidence.l2 = l2
		? `cells written: ${report.cellsWritten.join(", ") || "none"}; events: ${emitted.join(", ") || "none"}`
		: "no cell written and no event emitted during the exercise run";
	const l3 = report.capabilitiesCalled.length > 0 || report.knobsWritten.length > 0;
	result.evidence.l3 = l3
		? `capabilities called: ${report.capabilitiesCalled.join(", ") || "none"}; knobs landed: ${report.knobsWritten.join(", ") || "none"}`
		: "no capability called and no knob landed";
	const l4 = report.decisions > 0;
	result.evidence.l4 = l4 ? `decisions reached: ${report.decisions}` : "no decision reached";
	result.level = l2 ? (l3 ? (l4 ? 4 : 3) : 2) : 1;

	// the measurement (11.6): off and null, interleaved so drift lands on both, K runs each, the medians side by side
	const measurement: Measurement = {
		runs: options.runs,
		off: [],
		null: [],
		offMedianMs: Number.NaN,
		nullMedianMs: Number.NaN,
		slowdown: Number.NaN,
		failed: [],
		withinNoise: false,
	};
	for (let i = 0; i < options.runs; i++) {
		for (const harness of ["off", "null"] as const) {
			const timed = await runCommand(check.run, {
				cwd: subject.root,
				env: subjectEnv(options.env, { ABAI_HARNESS: harness, ABAI_MODE: mode }),
				timeoutMs: options.timeoutMs,
			});
			if (timed.timedOut || timed.code !== 0) measurement.failed.push(`${harness}: ${describeRun(timed)}`);
			else measurement[harness].push(timed.ms);
		}
	}
	if (measurement.failed.length > 0) {
		violations.push({
			where: `check.run under ${mode} with ABAI_HARNESS=off and null`,
			what: `measurement runs failed: ${measurement.failed.join("; ")}`,
		});
	}
	if (measurement.off.length > 0 && measurement.null.length > 0) {
		measurement.offMedianMs = median(measurement.off);
		measurement.nullMedianMs = median(measurement.null);
		measurement.slowdown =
			measurement.offMedianMs > 0 ? measurement.nullMedianMs / measurement.offMedianMs - 1 : Number.NaN;
		const off = spread(measurement.off);
		const nul = spread(measurement.null);
		measurement.withinNoise = measurement.offMedianMs < NOISE_FLOOR_MS || (nul.min <= off.max && off.min <= nul.max);
		if (measurement.withinNoise) {
			notes.push(
				`under ${mode} the overhead numbers are within noise (off ${off.min.toFixed(0)}..${off.max.toFixed(0)} ms, null ${nul.min.toFixed(0)}..${nul.max.toFixed(0)} ms, ${options.runs} runs each): raise --runs or give check.run more work before reading the slowdown`,
			);
		}
		const limit = parseOverhead(check.overhead);
		if (check.overhead !== undefined && limit === undefined) {
			violations.push({
				where: "check.overhead",
				what: `${JSON.stringify(check.overhead)} is not a percentage such as "5%"`,
			});
		} else if (limit !== undefined) {
			measurement.limit = limit;
			if (measurement.slowdown > limit) {
				violations.push({
					where: where("null"),
					what: `the null-harness run is ${(measurement.slowdown * 100).toFixed(1)}% slower than the off run (medians of ${options.runs}${measurement.withinNoise ? ", within noise" : ""}); check.overhead allows ${check.overhead}`,
				});
			}
		}
	}
	result.measurement = measurement;
	return result;
}

export async function checkRepository(options: CheckOptions): Promise<CheckReport> {
	const violations: Violation[] = [];
	const unexercised: CheckReport["unexercised"] = [];
	const notes: string[] = [];
	const subject = loadSubject(options.repo, options.cwd);
	const manifest = subject.manifest;
	const entry = options.entry ?? manifest.entry;
	const subjectForEntry: Subject = options.entry
		? { ...subject, manifest: { ...manifest, entry: options.entry } }
		: subject;
	const runs = options.runs ?? DEFAULT_RUNS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const l1 = await checkLevelOne(subjectForEntry, entry, subjectEnv(options.env), violations);

	let checkedModes: Mode[] = manifest.modes;
	if (options.mode !== undefined) {
		if (!manifest.modes.includes(options.mode)) {
			violations.push({
				where: "--mode",
				what: `${manifest.name} declares ${manifest.modes.join(", ")}, not ${options.mode}`,
			});
			checkedModes = [];
		} else checkedModes = [options.mode];
	}
	if (!/\babai$/.test(entry.trim())) {
		notes.push(
			`the entry "${entry}" does not end in the word abai: the stub's runEntry answers only "abai ...", so the verbs reach the program only if it translates them itself`,
		);
	}
	if (checkedModes.includes("sidecar") && manifest.check?.run) {
		notes.push(
			"under sidecar this instantiation keeps the null harness in the program's process and opens no socket for it, so the measured overhead leaves out the serialization sidecar observation costs (a deviation every manifest it writes declares)",
		);
	}

	const perMode: ModeResult[] = [];
	if (l1.ok && manifest.check?.run) {
		for (const mode of checkedModes) {
			perMode.push(
				await checkMode(subject, mode, { runs, timeoutMs, env: options.env }, violations, unexercised, notes),
			);
		}
	} else if (l1.ok) {
		notes.push(
			"check.run is not declared, so nothing above level 1 can be shown and nothing is measured (section 12)",
		);
	}

	let level = 0;
	if (l1.ok) level = perMode.length > 0 ? Math.min(...perMode.map((m) => m.level)) : 1;
	const requested = options.level;
	const passed = level >= (requested ?? 1) && violations.length === 0;
	return {
		root: subject.root,
		name: manifest.name,
		abaigrammar: manifest.abaigrammar,
		entry,
		declaredModes: manifest.modes,
		checkedModes,
		checkRun: manifest.check?.run,
		overheadLimit: manifest.check?.overhead,
		compiledOut: "not offered",
		built: "no",
		l1,
		perMode,
		level,
		requested,
		passed,
		unexercised,
		violations,
		notes,
	};
}

function pct(value: number): string {
	return Number.isNaN(value) ? "n/a" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function range(values: number[]): string {
	if (values.length === 0) return "failed";
	const { min, max } = spread(values);
	return `${median(values).toFixed(0)} (${min.toFixed(0)}..${max.toFixed(0)})`;
}

export function renderReport(report: CheckReport): string {
	const lines: string[] = [];
	lines.push(
		`abaikit check: ${report.name} at ${report.root} (abaigrammar ${report.abaigrammar}, entry: ${report.entry})`,
	);
	let verdict: string;
	if (report.requested === undefined) verdict = report.violations.length === 0 ? "no violations" : "with violations";
	else if (report.level < report.requested) verdict = `requested ${report.requested}: not reached`;
	else
		verdict =
			report.violations.length === 0
				? `requested ${report.requested}: passed`
				: `requested ${report.requested}: reached, with violations`;
	lines.push(
		report.level === 0
			? `level: 0 (L1 not reached; ${verdict})`
			: `level: ${report.level} ${LEVEL_NAMES[report.level]} (${verdict})`,
	);
	lines.push(
		`modes: ${report.declaredModes.join(", ")}${report.checkedModes.length === report.declaredModes.length ? "" : `; checked: ${report.checkedModes.join(", ") || "none"}`}`,
	);
	lines.push(
		`L1 reachable: ${report.l1.ok ? "ok" : "not reached"}${report.l1.detail ? ` (${report.l1.detail})` : ""}; ran: ${report.l1.ran.join("; ")}`,
	);
	for (const n of [2, 3, 4] as const) {
		const key = `l${n}` as const;
		const parts = report.perMode.map((m) => {
			if (m.exercise && !m.exercise.report) return `${m.mode}: exercise run failed`;
			if (!m.evidence[key]) return `${m.mode}: not run`;
			return `${m.mode}: ${m.level >= n ? "ok" : "no"}, ${m.evidence[key]}`;
		});
		lines.push(`L${n} ${LEVEL_NAMES[n]}: ${parts.length > 0 ? parts.join("; ") : "not shown"}`);
	}
	if (report.checkRun !== undefined && report.perMode.some((m) => m.measurement)) {
		lines.push(
			`overhead (check.run: ${report.checkRun}; built: ${report.built}, the command runs as is; compiled out: ${report.compiledOut}; median ms (min..max) of each run set):`,
		);
		lines.push("  mode      runs  off                null               slowdown   limit");
		for (const m of report.perMode) {
			const x = m.measurement;
			if (!x) continue;
			const limit = x.limit === undefined ? "none" : `${(x.limit * 100).toFixed(1)}%`;
			lines.push(
				`  ${m.mode.padEnd(9)} ${String(x.runs).padEnd(5)} ${range(x.off).padEnd(18)} ${range(x.null).padEnd(18)} ${pct(x.slowdown).padEnd(10)} ${limit}${x.withinNoise ? "  (within noise)" : ""}`,
			);
		}
	}
	lines.push(
		report.unexercised.length === 0
			? "unexercised: none"
			: `unexercised:\n${report.unexercised.map((u) => `  ${u.mode}: ${u.kind} ${u.name}: ${u.why}`).join("\n")}`,
	);
	lines.push(
		report.violations.length === 0
			? "violations: none"
			: `violations:\n${report.violations.map((v) => `  ${v.where}: ${v.what}`).join("\n")}`,
	);
	for (const note of report.notes) lines.push(`note: ${note}`);
	return `${lines.join("\n")}\n`;
}

/** abaikit's own channels see every check: two cells and one event, for the agent fused into abaikit. */
export function recordCheck(app: Abaigram | undefined, report: CheckReport): void {
	if (!app) return;
	const runs = app.cell<number>("check.runs");
	runs.set((runs.get() ?? 0) + 1);
	app.cell<number>("check.last_level").set(report.level);
	app.event("check.completed").emit({ repo: report.root, level: report.level });
}

/** The `check` capability: the same check, its report as text, for the agent on any front end. */
export function checkHandler(app: Abaigram, io: Pick<AbaikitIo, "cwd" | "env">) {
	return async (params: Record<string, unknown>): Promise<{ level: number; passed: boolean; report: string }> => {
		if (typeof params.repo !== "string" || params.repo === "") throw new UsageError("check needs a repo");
		const level = typeof params.level === "number" ? params.level : undefined;
		if (level !== undefined && (!Number.isInteger(level) || level < 1 || level > 4)) {
			throw new UsageError("level must be 1 to 4");
		}
		const mode = typeof params.mode === "string" && params.mode !== "" ? params.mode : undefined;
		if (mode !== undefined && mode !== "turns" && mode !== "sidecar")
			throw new UsageError("mode must be turns or sidecar");
		const entry = typeof params.entry === "string" && params.entry !== "" ? params.entry : undefined;
		const runs =
			typeof params.runs === "number" && Number.isInteger(params.runs) && params.runs > 0 ? params.runs : undefined;
		const report = await checkRepository({ repo: params.repo, cwd: io.cwd, env: io.env, level, mode, entry, runs });
		recordCheck(app, report);
		return { level: report.level, passed: report.passed, report: renderReport(report) };
	};
}

export async function runCheck(
	parsed: Extract<ParsedArgs, { verb: "check" }>,
	io: AbaikitIo,
	app?: Abaigram,
): Promise<number> {
	const report = await checkRepository({
		repo: parsed.repo,
		cwd: io.cwd,
		env: io.env,
		level: parsed.level,
		mode: parsed.mode,
		entry: parsed.entry,
		runs: parsed.runs,
		timeoutMs: parsed.timeoutS === undefined ? undefined : parsed.timeoutS * 1000,
	});
	recordCheck(app, report);
	io.out(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
	return report.passed ? 0 : 1;
}
