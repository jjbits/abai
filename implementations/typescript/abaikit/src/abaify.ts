// abaikit abaify: the agent-driven retrofit (section 13). abaikit's own
// agent, with the configured model, works through the repo.* capabilities
// and nothing else: no source line the repository had is ever removed or
// reordered, and the three files structured tools rewrite (package.json,
// abaigram.yaml, the lock file) are named as such. The person's invocation
// is the consent for its writes, said at the start and in the report. Each
// round the agent works until it stops, then abaikit runs check itself;
// the level reached ends the loop, anything short of it is the next
// prompt, up to the abaify.max_rounds knob. A model that cannot be reached
// ends the run at once, and the report of what changed and why is left in
// the repository whatever happened.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentModel, SessionForm, UserChannel } from "@abaigram/embedded-harness";
import type { Mode } from "@abaigram/stub";
import type { AbaikitApp } from "./app.ts";
import type { ParsedArgs } from "./bin.ts";
import { type CheckReport, checkRepository, recordCheck, renderReport } from "./check.ts";
import { type AbaikitIo, errorMessage, UsageError } from "./io.ts";
import { findSection, loadGuide } from "./learnabai.ts";
import { type Change, readRepo, summarizeRepo } from "./repo.ts";

export const REPORT_FILE = "abai/abaify-report.md";
/** Lines of the entry file the brief quotes: enough to see where a launcher checks or imports its build. */
const HEAD_LINES = 80;
/** The brief is thousands of tokens: the model's first answer may take minutes, which is not unreachability. */
export const FIRST_CONTACT_MS = 180_000;
/** Scripts a brief names first, when the package has them. */
const KNOWN_SCRIPTS = ["start", "build", "compile", "dev", "test", "check", "lint", "typecheck"];

export interface AbaifyOptions {
	repo: string;
	level?: number;
	mode?: Mode;
	rounds?: number;
	dryRun: boolean;
	/** A model for the agent; the machine's configured one otherwise. */
	model?: AgentModel;
}

export interface Round {
	number: number;
	answer: string;
	check: CheckReport | undefined;
	/** When check could not run: why (no abaigram.yaml yet, for one). */
	checkError?: string;
}

export interface AbaifyResult {
	root: string;
	requested: number;
	level: number;
	passed: boolean;
	dryRun: boolean;
	rounds: Round[];
	changes: Change[];
	/** Why the run ended short, when it did: the model gone, an error. */
	failure?: string;
	reportPath?: string;
	report: string;
}

interface Inventory {
	packageJson: Record<string, unknown> | undefined;
	entryFile?: { path: string; head: string; to: number; total: number };
	guidelines?: { path: string; head: string };
	summary: string;
	total: number;
	/** Build output present at the root (`dist/`, `build/`, `out/`), so the agent knows whether built paths run. */
	buildOutput: string[];
}

function inventory(root: string): Inventory {
	let packageJson: Record<string, unknown> | undefined;
	try {
		packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
	} catch {
		packageJson = undefined;
	}
	const { total, summary } = summarizeRepo(root);
	const buildOutput = ["dist", "build", "out"].filter(
		(d) => existsSync(join(root, d)) && statSync(join(root, d)).isDirectory(),
	);
	const result: Inventory = { packageJson, summary, total, buildOutput };
	const bin = packageJson?.bin;
	const binTarget =
		typeof bin === "string"
			? bin
			: bin && typeof bin === "object"
				? (Object.values(bin as Record<string, string>)[0] ?? undefined)
				: undefined;
	const main = typeof packageJson?.main === "string" ? packageJson.main : undefined;
	for (const candidate of [
		binTarget,
		main,
		"src/main.ts",
		"src/main.js",
		"src/index.ts",
		"src/index.js",
		"index.js",
	]) {
		if (candidate && existsSync(join(root, candidate))) {
			const { text, to, total_lines } = readRepo(root, candidate, 1, HEAD_LINES);
			result.entryFile = { path: candidate, head: text, to, total: total_lines };
			break;
		}
	}
	for (const candidate of ["AGENTS.md", "CONTRIBUTING.md", "CLAUDE.md"]) {
		if (existsSync(join(root, candidate))) {
			const { text } = readRepo(root, candidate, 1, 40);
			result.guidelines = { path: candidate, head: text };
			break;
		}
	}
	return result;
}

function pickedScripts(scripts: Record<string, string>): Record<string, string> {
	const picked: Record<string, string> = {};
	for (const name of KNOWN_SCRIPTS) if (scripts[name] !== undefined) picked[name] = scripts[name];
	for (const [name, value] of Object.entries(scripts)) {
		if (Object.keys(picked).length >= 15) break;
		if (picked[name] === undefined) picked[name] = value;
	}
	return picked;
}

/** The first prompt: the task, the repository as it is, the procedure mapped onto the capabilities, the API, the rules. */
export function brief(root: string, level: number, mode: Mode | undefined, inv: Inventory, dryRun: boolean): string {
	const guide = loadGuide();
	const pkg = inv.packageJson;
	const picked = pkg
		? JSON.stringify(
				{
					name: pkg.name,
					type: pkg.type,
					bin: pkg.bin,
					main: pkg.main,
					scripts: pickedScripts((pkg.scripts as Record<string, string>) ?? {}),
				},
				null,
				2,
			)
		: "(no package.json)";
	const lines = [
		`Retrofit the repository at ${root} into an abaigram at level ${level}${mode ? ` in ${mode} mode` : ""}.`,
		"",
		"You work only through abaikit's capabilities (the abai_call tool), with `repo` set to exactly the path above:",
		"- repo.list (glob narrows: `*.json` by name anywhere, `src/**` or `scripts/*.mjs` by path; the listing is bounded and says so first), repo.read (a window of lines; the result says `from` and `to`).",
		"- repo.write makes a new file only. repo.insert puts text before or after one unique anchor line of an existing file; no line the repository had is ever removed or reordered. repo.add_dependency adds to package.json (a structured edit that re-serializes the file). repo.manifest runs the entry's `manifest` and writes abaigram.yaml: never write that file yourself. repo.install runs npm install (the lock file and node_modules are rewritten). check gives the conformance report.",
		"- You cannot run shell commands or build the repository. Where the procedure below says `npm install`, call repo.add_dependency for both `@abaigram/stub` and `@abaigram/embedded-harness`, then repo.install once. Where it says `<entry> manifest > abaigram.yaml`, call repo.manifest with the entry. Where it says `abaikit check`, call check. Where it says build: " +
			(inv.buildOutput.length > 0
				? `the build output is present (${inv.buildOutput.map((d) => `${d}/`).join(", ")}), so the built program runs; prefer a cell or event at a real boundary of the program and a check.run that is a real command of it, over a synthetic mode.`
				: "there is no build output, so choose a path that needs no build: a plain `.mjs` module beside a launcher, a cell or event set in code that runs unbuilt."),
		"- The `entry` you declare must end with the word `abai` (such as `node scripts/x.mjs abai` or `node dist/main.js abai`): the tools append `manifest`, `doctor` and `run` to it, and the stub's runEntry answers only when `abai` comes first. A file you wrote in this run you may write again with repo.write; a file the repository had you may only insert into.",
		"- You have the person's consent for this run; do not ask them.",
		dryRun
			? "- This is a dry run: call the capabilities as you would; nothing is written, repo.manifest and check cannot succeed on files that are not on disk, so propose the whole retrofit and stop."
			: "",
		"",
		`Repository shape (${inv.total} files after skipping dependencies, build output and ignored trees; directories with their counts, use repo.list with a glob to see inside one):`,
		"```",
		inv.summary,
		"```",
		"package.json (the known scripts first):",
		"```json",
		picked,
		"```",
	];
	if (inv.entryFile) {
		lines.push(
			`The entry file ${inv.entryFile.path}, lines 1 to ${inv.entryFile.to} of ${inv.entryFile.total}:`,
			"```",
			inv.entryFile.head,
			"```",
		);
	}
	if (inv.guidelines) {
		lines.push(`The repository's own guidelines, ${inv.guidelines.path}, head:`, "```", inv.guidelines.head, "```");
	}
	lines.push(
		"",
		"The procedure, from abaikit learnabai (read it with the mapping above):",
		findSection(guide, "retrofit").text,
		"",
		"The declaration API:",
		findSection(guide, "declare").text,
		"",
		"What never to do:",
		findSection(guide, "never").text,
		"",
		`When you believe level ${level} is reached, call check once; when it reports level ${level} with no violation, answer with the word DONE on its own line followed by a short summary of what you added and why. If you cannot go on, say why.`,
	);
	return lines.filter((l) => l !== undefined).join("\n");
}

function followUp(round: Round, level: number): string {
	const status = round.check ? renderReport(round.check) : `check could not run: ${round.checkError}`;
	return `abaikit ran check after your last round. Level ${level} is not reached yet. The report:\n\n${status}\nFix what it names, through the capabilities, then call check again. Answer DONE with a summary when level ${level} holds with no violation.`;
}

function consentLine(root: string, level: number, dryRun: boolean): string {
	return dryRun
		? `abaify: dry run on ${root}: the agent proposes a retrofit to level ${level}; nothing is written, though the repository's entry may be run read-only`
		: `abaify: ${root} to level ${level}, with your consent for this run: the agent may add files, insert lines, add dependencies, run npm install (network, the repository's own install scripts), run the repository's entry and its check.run under the null harness`;
}

/** The report left in the repository: every change with its why, the rounds, the last check. */
export function renderAbaifyReport(result: AbaifyResult, run: number): string {
	const lines = [
		`# abaify report: ${result.root} (run ${run}, ${new Date().toISOString()})`,
		"",
		result.dryRun
			? `Dry run to level ${result.requested}: ${result.changes.length} change${result.changes.length === 1 ? "" : "s"} proposed, nothing written, no check run.`
			: `Requested level ${result.requested}; reached level ${result.level}; ${result.passed ? "passed" : "not passed"} after ${result.rounds.length} round${result.rounds.length === 1 ? "" : "s"}.`,
		consentLine(result.root, result.requested, result.dryRun).replace(/^abaify: /, "Consent: "),
		"",
	];
	if (result.failure) lines.push(`The run ended short: ${result.failure}`, "");
	const added = result.changes.filter((c) => c.kind === "added");
	const rewritten = result.changes.filter((c) => c.kind === "rewritten");
	lines.push("## Added (new files and inserted lines; nothing the repository had was removed or reordered)", "");
	lines.push(
		...(added.length === 0 ? ["(none)"] : added.map((c) => `- ${c.how} ${c.path}: ${c.detail}. Why: ${c.why}`)),
	);
	lines.push("", "## Rewritten in place by a structured tool", "");
	lines.push(
		...(rewritten.length === 0
			? ["(none)"]
			: rewritten.map((c) => `- ${c.how} ${c.path}: ${c.detail}. Why: ${c.why}`)),
	);
	lines.push("", "## Rounds", "");
	for (const r of result.rounds) {
		lines.push(`### Round ${r.number}`, "", "The agent said:", "", r.answer.trim() || "(nothing)", "");
		if (!result.dryRun) {
			lines.push(
				r.check
					? `check after the round: level ${r.check.level}, ${r.check.passed ? "passed" : "not passed"}`
					: `check could not run: ${r.checkError ?? "unknown"}`,
				"",
			);
		}
	}
	const last = result.rounds.at(-1)?.check;
	if (last) lines.push("## The last check report", "", "```", renderReport(last).trimEnd(), "```", "");
	return `${lines.join("\n")}\n`;
}

/** The report appended to the repository's; the run number counts the reports already there. */
function writeReport(root: string, result: AbaifyResult): string {
	const path = join(root, REPORT_FILE);
	mkdirSync(join(root, "abai"), { recursive: true });
	const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
	const run = (previous.match(/^# abaify report:/gm) ?? []).length + 1;
	result.report = renderAbaifyReport(result, run);
	writeFileSync(path, (previous === "" ? "" : `${previous.trimEnd()}\n\n---\n\n`) + result.report);
	return path;
}

export async function abaify(options: AbaifyOptions, io: AbaikitIo, bundle: AbaikitApp): Promise<AbaifyResult> {
	const { app, embedding, repo: ctx } = bundle;
	const root = resolve(io.cwd, options.repo);
	if (!existsSync(join(root, "package.json"))) {
		throw new UsageError(
			`${options.repo}: no package.json; abaify retrofits Node repositories (TypeScript or JavaScript) for now`,
		);
	}
	if (app.mode !== "turns")
		throw new UsageError(`abaify runs its agent in-process; unset ABAI_MODE (it is ${app.mode})`);
	const level = options.level ?? 1;
	const rounds = app.knob<number>("abaify.max_rounds");
	const range = app.manifest.cells.find((c) => c.name === "abaify.max_rounds")?.range ?? [1, 20];
	if (options.rounds !== undefined) {
		if (options.rounds < range[0] || options.rounds > range[1])
			throw new UsageError(`--rounds must be ${range[0]} to ${range[1]}`);
		rounds.set(options.rounds);
	}
	const say = (text: string) => io.err(text);
	say(consentLine(root, level, options.dryRun));
	ctx.dryRun = options.dryRun;
	ctx.cwd = io.cwd;
	ctx.onChange = (change) => say(`abaify: ${change.how} ${change.path}: ${change.detail}`);
	const changesBefore = ctx.changes.length;
	const result: AbaifyResult = {
		root,
		requested: level,
		level: 0,
		passed: false,
		dryRun: options.dryRun,
		rounds: [],
		changes: [],
		report: "",
	};

	// the agent: abaikit's own embedded harness, auto consent (the invocation is the person's), a channel that only speaks
	const channel: UserChannel = { say, ask: async () => undefined, confirm: async () => false, close: () => {} };
	embedding.options = {
		model: options.model,
		channel,
		harness: { auto: true },
		connectTimeoutMs: FIRST_CONTACT_MS,
		addendum: `You are retrofitting ${root} for a person who asked abaikit to do it; every write is theirs to approve and they approved this run.`,
	};
	let form: SessionForm | undefined;
	try {
		if (!(await app.attach()) || !embedding.current) {
			throw new Error(
				`no agent could be attached: ${app.attachError ?? "unknown"} (configure one with \`abaikit abai config\`, or follow \`abaikit learnabai\` with your own agent)`,
			);
		}
		form = embedding.current.form;
		const harness = embedding.current.harness;
		const inv = inventory(root);
		let prompt = brief(root, level, options.mode, inv, options.dryRun);
		// read once: an agent setting its own knob mid-run changes the next run, not this one
		const max = options.dryRun ? 1 : rounds.get();
		for (let n = 1; n <= max; n++) {
			say(`abaify: round ${n} of ${max}`);
			const answer = await form.prompt(prompt);
			const round: Round = { number: n, answer, check: undefined };
			result.rounds.push(round);
			// a run the model could not finish ends the loop: before first contact the form detaches; after it the
			// agent's last message carries the error, and another round would only spend the person's time
			const last = [...form.agent.state.messages].reverse().find((m) => m.role === "assistant");
			const stop = last && last.role === "assistant" ? last.stopReason : undefined;
			if (form.modelFailure !== undefined || !harness.attached) {
				result.failure = `the model could not be reached: ${form.modelFailure ?? "the harness detached"}`;
				break;
			}
			if (stop === "error" || stop === "aborted") {
				const why =
					last && last.role === "assistant" && "errorMessage" in last ? String(last.errorMessage ?? stop) : stop;
				result.failure = `the model could not be reached: the request ${stop === "aborted" ? "was aborted" : "failed"} (${why}); run abaify again when it is back`;
				break;
			}
			if (!options.dryRun) {
				say(`abaify: check after round ${n}`);
				try {
					round.check = await checkRepository({ repo: root, cwd: io.cwd, env: io.env, level, mode: options.mode });
					recordCheck(app, round.check);
					result.level = round.check.level;
					result.passed = round.check.passed;
				} catch (error) {
					round.checkError = errorMessage(error);
				}
			}
			if (result.passed) break;
			prompt = followUp(round, level);
		}
	} catch (error) {
		result.failure = result.failure ?? errorMessage(error);
		throw error;
	} finally {
		form?.shutdown("abaify ended");
		ctx.dryRun = false;
		ctx.onChange = undefined;
		result.changes = ctx.changes.slice(changesBefore);
		// the report is written whatever happened once the agent was at work, so nothing done goes unrecorded
		if (options.dryRun) result.report = renderAbaifyReport(result, 1);
		else if (result.rounds.length > 0 || result.changes.length > 0) result.reportPath = writeReport(root, result);
	}
	if (options.dryRun) result.passed = true;
	return result;
}

export async function runAbaify(
	parsed: Extract<ParsedArgs, { verb: "abaify" }>,
	io: AbaikitIo,
	bundle: AbaikitApp,
	deps: { model?: AgentModel } = {},
): Promise<number> {
	const result = await abaify(
		{
			repo: parsed.repo,
			level: parsed.level,
			mode: parsed.mode,
			rounds: parsed.rounds,
			dryRun: parsed.dryRun,
			model: deps.model,
		},
		io,
		bundle,
	);
	io.out(result.report);
	if (result.reportPath) io.out(`report: ${result.reportPath}\n`);
	if (result.failure) {
		io.out(
			`abaify: ended short after ${result.rounds.length} round${result.rounds.length === 1 ? "" : "s"}: ${result.failure}\n`,
		);
		return 1;
	}
	io.out(
		result.dryRun
			? `dry run: ${result.changes.length} change${result.changes.length === 1 ? "" : "s"} proposed, nothing written\n`
			: result.passed
				? `abaify: level ${result.level} reached in ${result.rounds.length} round${result.rounds.length === 1 ? "" : "s"}\n`
				: `abaify: level ${result.requested} not reached after ${result.rounds.length} round${result.rounds.length === 1 ? "" : "s"} (reached ${result.level}); the report says what remains\n`,
	);
	return result.passed ? 0 : 1;
}
