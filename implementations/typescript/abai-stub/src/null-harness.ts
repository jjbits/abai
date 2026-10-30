// The null harness (abaigrammar section 2): a harness that attaches, drains
// every channel, answers every decision with its default, and calls no
// model. Passive (`ABAI_HARNESS=null`) it touches no control and exists to
// measure overhead. Active (`ABAI_HARNESS=exercise`) it writes each knob's
// default, calls each capability with its example, and reports what went
// unexercised, so conformance (section 12) is demonstrable without a model.
// It lives in the stub so a check run needs no harness package installed.
import type { HarnessBinding } from "./harness-binding.ts";

export type NullForm = "null" | "exercise";

export interface NullHarnessReport {
	form: NullForm;
	events: number;
	dropped: number;
	decisions: number;
	turns: number;
	touchpoints: number;
	/** Cells the program wrote while the harness was attached: a cell whose version moved, a knob's beyond the harness's own write. */
	cellsWritten: string[];
	/** The program's own events emitted while attached, by name, each once; the library's `abai.*` are not the program's. */
	eventsEmitted: string[];
	/** The active form only. */
	knobsWritten: string[];
	capabilitiesCalled: string[];
	/** Declarations the run did not exercise, with the reason. */
	unexercised: Array<{ kind: "capability" | "decision" | "turn" | "knob"; name: string; why: string }>;
}

export interface NullHarness {
	readonly form: NullForm;
	report(): NullHarnessReport;
	/** The active form's exercise, once it has run (resolves at once for the passive form). */
	readonly exercised: Promise<void>;
	detach(reason: string): void;
}

const REASON = "null harness";

export function attachNullHarness(binding: HarnessBinding, form: NullForm): NullHarness {
	let events = 0;
	let dropped = 0;
	let decisions = 0;
	let turns = 0;
	let touchpoints = 0;
	let cursor = 0;
	const reached = { decisions: new Set<string>(), turns: new Set<string>() };
	const knobsWritten: string[] = [];
	const capabilitiesCalled: string[] = [];
	const eventsEmitted: string[] = [];
	const failed: NullHarnessReport["unexercised"] = [];
	// the versions at attach: a cell whose version moved past them was written by the program, a knob's once
	// more than the exercise's own write of it, so level 2's "a cell the program writes" is told from the
	// harness's doing (section 12); one readCells() at attach and one at the report, none on a measured row
	const versions = (): Record<string, number> => {
		const seen: Record<string, number> = {};
		for (const [name, reading] of Object.entries(binding.readCells().cells)) seen[name] = reading.version;
		return seen;
	};
	const baseline = versions();
	const cellsWritten = (): string[] =>
		Object.entries(versions())
			.filter(([name, version]) => version - (baseline[name] ?? 0) - (knobsWritten.includes(name) ? 1 : 0) > 0)
			.map(([name]) => name);

	// the exercise starts at the program's first activity, or on the next macrotask, whichever comes first:
	// a program that never yields to the macrotask queue would otherwise finish before it began
	let activity: () => void = () => {};
	const firstActivity = new Promise<void>((done) => {
		activity = done;
	});

	binding.on("event", () => {
		activity();
		// drain through the ring so lapped events are counted as dropped, as a real harness would
		const batch = binding.readEvents(cursor);
		events += batch.events.length;
		for (const event of batch.events) {
			if (!event.name.startsWith("abai.") && !eventsEmitted.includes(event.name)) eventsEmitted.push(event.name);
		}
		dropped += batch.dropped;
		cursor = batch.next;
	});
	binding.on("decision", (request) => {
		activity();
		decisions += 1;
		reached.decisions.add(request.name);
		binding.answerDecision(request.id, null, `${REASON}: the default`);
	});
	binding.on("turn", (request) => {
		activity();
		turns += 1;
		reached.turns.add(request.name);
		// the exercise's calls run inside this turn when they are queued by now (section 5.3)
		binding.endTurn(request.id);
	});
	binding.on("touchpoint", (request) => {
		activity();
		touchpoints += 1;
		binding.endTouchpoint(request.id);
	});

	const attempted = { knobs: new Set<string>(), capabilities: new Set<string>() };
	const exercise = async (): Promise<void> => {
		if (form !== "exercise") return;
		// after the program's own startup code, so handlers registered after createAbaigram are in place
		await Promise.race([new Promise<void>((done) => setImmediate(done)), firstActivity]);
		const { manifest } = binding;
		const work: Promise<void>[] = [];
		for (const cell of manifest.cells) {
			if (cell.access !== "readwrite") continue;
			attempted.knobs.add(cell.name);
			work.push(
				binding
					.writeKnob(cell.name, cell.default, `${REASON}: exercise writes the default`, "auto")
					.then((outcome) => {
						if (outcome.outcome === "done") knobsWritten.push(cell.name);
						else failed.push({ kind: "knob", name: cell.name, why: outcome.error ?? "failed" });
					}),
			);
		}
		for (const capability of manifest.capabilities) {
			if (capability.policy === "forbid") {
				failed.push({ kind: "capability", name: capability.name, why: "policy forbids it" });
				continue;
			}
			if (capability.example === undefined) {
				failed.push({ kind: "capability", name: capability.name, why: "no example declared" });
				continue;
			}
			attempted.capabilities.add(capability.name);
			work.push(
				binding.call(capability.name, capability.example, `${REASON}: exercise calls the example`, "auto").then(
					() => {
						capabilitiesCalled.push(capability.name);
					},
					(error) => {
						failed.push({
							kind: "capability",
							name: capability.name,
							why: error instanceof Error ? error.message : String(error),
						});
					},
				),
			);
		}
		// concurrently, so one stalled delivery does not starve the rest
		await Promise.allSettled(work);
	};
	const exercised = exercise();

	const report = (): NullHarnessReport => {
		const unexercised = [...failed];
		if (form === "exercise") {
			for (const cell of binding.manifest.cells) {
				if (
					cell.access !== "readwrite" ||
					knobsWritten.includes(cell.name) ||
					failed.some((f) => f.kind === "knob" && f.name === cell.name)
				)
					continue;
				unexercised.push({
					kind: "knob",
					name: cell.name,
					why: attempted.knobs.has(cell.name) ? "still pending at exit" : "not attempted",
				});
			}
			for (const capability of binding.manifest.capabilities) {
				if (
					capabilitiesCalled.includes(capability.name) ||
					failed.some((f) => f.kind === "capability" && f.name === capability.name)
				)
					continue;
				unexercised.push({
					kind: "capability",
					name: capability.name,
					why: attempted.capabilities.has(capability.name) ? "still pending at exit" : "not attempted",
				});
			}
			for (const decision of binding.manifest.decisions) {
				if (!reached.decisions.has(decision.name))
					unexercised.push({ kind: "decision", name: decision.name, why: "not reached" });
			}
			for (const turn of binding.manifest.turns) {
				if (!reached.turns.has(turn.name)) unexercised.push({ kind: "turn", name: turn.name, why: "not reached" });
			}
		}
		return {
			form,
			events,
			dropped,
			decisions,
			turns,
			touchpoints,
			cellsWritten: cellsWritten(),
			eventsEmitted,
			knobsWritten,
			capabilitiesCalled,
			unexercised,
		};
	};

	return {
		form,
		report,
		exercised,
		detach: (reason) => binding.detach(reason),
	};
}
