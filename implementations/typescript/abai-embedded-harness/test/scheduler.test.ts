// The attention machinery without a program: the transcript ring, the wake
// scheduler (coalescing, budget, folding, decisions exempt), the watch
// operators, decision summaries and answer validation.
import type { DecisionDecl } from "@abaigram/stub";
import { describe, expect, test } from "vitest";
import { FIXTURE_MANIFEST } from "../../abai/test/fixtures/manifest.ts";
import {
	MAX_DELIVERY_LINES,
	MAX_WAKE_LINES,
	RING_CAPACITY,
	SUMMARY_CAP,
	summarizeDecision,
	TranscriptRing,
	validateAnswer,
	WakeScheduler,
	watchHolds,
} from "../src/scheduler.ts";

/** A renderer like a program's: a user message is one line marked with "> ". */
const render = (message: unknown): string[] => [`> ${(message as { text: string }).text}`];
const userMessage = (seq: number, text: string) => ({ seq, text });

describe("TranscriptRing", () => {
	test("renders lines with sequence numbers and bounds itself", () => {
		const ring = new TranscriptRing(render);
		ring.push(userMessage(5, "hello"));
		expect(ring.last(10)).toEqual([{ seq: 5, text: "> hello" }]);
		ring.push(userMessage(7, "partial"));
		expect(ring.size).toBe(2);
		expect(ring.last(1)[0].text.endsWith("partial")).toBe(true);
		expect(ring.lastSeq).toBe(7);
		ring.push(userMessage(8, "open"));
		ring.flush();
		expect(ring.size).toBe(3);
		expect(ring.after(5).map((line) => line.seq)).toEqual([7, 8]);
		ring.note("# a note");
		expect(ring.last(1)[0]).toEqual({ seq: 8, text: "# a note" });
		for (let i = 0; i < RING_CAPACITY + 50; i++) ring.note(`line ${i}`);
		expect(ring.size).toBe(RING_CAPACITY);
	});

	test("the default renderer writes one JSON line, cut to 400 characters", () => {
		const ring = new TranscriptRing();
		ring.push({ seq: 3, kind: "x" });
		expect(ring.last(1)).toEqual([{ seq: 3, text: '{"seq":3,"kind":"x"}' }]);
		ring.push({ text: "y".repeat(1000) });
		expect(ring.last(1)[0]).toMatchObject({ seq: 3 });
		expect(ring.last(1)[0].text).toHaveLength(400);
		expect(ring.sinceAdded(1)).toHaveLength(1);
		expect(ring.totalAdded).toBe(2);
	});
});

describe("WakeScheduler", () => {
	test("coalesces notes into one delivery with the transcript since the last one", () => {
		let now = 1000;
		const scheduler = new WakeScheduler(undefined, () => now);
		const ring = new TranscriptRing(render);
		expect(scheduler.due()).toBe(false);
		ring.push(userMessage(1, "first"));
		scheduler.note("event", "agent_end");
		scheduler.note("event", "auto_retry_end success=true");
		expect(scheduler.pendingNotes).toBe(2);
		expect(scheduler.due()).toBe(true);
		const delivery = scheduler.take(ring);
		expect(delivery).toBeDefined();
		expect(delivery?.text).toBe(
			"[abai wake] 2 wakes\n- agent_end\n- auto_retry_end success=true\nTranscript since the last wake (1 line):\n> first\n",
		);
		expect(delivery).toMatchObject({ notes: 2, folded: 0, decisions: 0 });
		expect(scheduler.due()).toBe(false);
		expect(scheduler.take(ring)).toBeUndefined();
		now += 10;
		ring.push(userMessage(2, "second"));
		scheduler.note("timer", "timer 1: check");
		expect(scheduler.take(ring)?.text).toBe(
			"[abai wake] 1 wake\n- timer 1: check\nTranscript since the last wake (1 line):\n> second\n",
		);
	});

	test("keeps the budget: beyond the window's deliveries event wakes wait, decisions never do", () => {
		let now = 0;
		const scheduler = new WakeScheduler(2, () => now);
		const ring = new TranscriptRing(render);
		for (let i = 0; i < 2; i++) {
			scheduler.note("event", `agent_end ${i}`);
			expect(scheduler.take(ring)).toBeDefined();
		}
		expect(scheduler.used()).toBe(2);
		scheduler.note("event", "agent_end 2");
		expect(scheduler.due()).toBe(false);
		expect(scheduler.take(ring)).toBeUndefined();
		scheduler.note("decision", "decision h1 on_backlog due in 5s: on_backlog depth=20 workers=4");
		expect(scheduler.due()).toBe(true);
		const delivery = scheduler.take(ring);
		expect(delivery?.text).toContain("- agent_end 2\n- decision h1");
		expect(delivery?.decisions).toBe(1);
		scheduler.note("watch", "watch 1");
		expect(scheduler.due()).toBe(false);
		now = 60_001;
		expect(scheduler.due()).toBe(true);
		expect(scheduler.take(ring)?.text).toContain("- watch 1");
		scheduler.budget = undefined;
		scheduler.note("event", "x");
		expect(scheduler.due()).toBe(true);
	});

	test("folds beyond the line cap and caps the transcript", () => {
		const scheduler = new WakeScheduler(undefined, () => 0);
		const ring = new TranscriptRing(render);
		for (let i = 0; i < MAX_WAKE_LINES + 5; i++) scheduler.note("event", `e${i}`);
		expect(scheduler.pendingNotes).toBe(MAX_WAKE_LINES + 5);
		for (let i = 0; i < 100; i++) ring.push(userMessage(i + 1, `m${i}`));
		const delivery = scheduler.take(ring);
		expect(delivery).toMatchObject({ notes: MAX_WAKE_LINES, folded: 5 });
		expect(delivery?.text).toContain("- 5 more wakes (folded; the transcript has them)");
		expect(delivery?.text).toContain(
			`Transcript since the last wake (100 lines, the last ${MAX_DELIVERY_LINES}; abai_transcript has the rest):`,
		);
		expect(delivery?.text.split("\n").filter((line) => line.startsWith("> m"))).toHaveLength(MAX_DELIVERY_LINES);
		expect(delivery?.text).toContain("> m99\n");
		scheduler.note("event", "x");
		scheduler.clear();
		expect(scheduler.due()).toBe(false);
	});
});

describe("watchHolds", () => {
	test("every operator, with the first sample never firing changed or crossed", () => {
		expect(watchHolds("changed", 1, undefined, undefined, false)).toBe(false);
		expect(watchHolds("changed", 1, undefined, 1, true)).toBe(false);
		expect(watchHolds("changed", 2, undefined, 1, true)).toBe(true);
		expect(watchHolds("eq", true, true, undefined, false)).toBe(true);
		expect(watchHolds("eq", "a", "b", undefined, true)).toBe(false);
		expect(watchHolds("ne", "a", "b", undefined, true)).toBe(true);
		expect(watchHolds("gt", 5, 3, undefined, true)).toBe(true);
		expect(watchHolds("gt", 3, 3, undefined, true)).toBe(false);
		expect(watchHolds("lt", 2, 3, undefined, true)).toBe(true);
		expect(watchHolds("lt", "a", 3, undefined, true)).toBe(false);
		expect(watchHolds("crossed", 5, 3, 1, true)).toBe(true);
		expect(watchHolds("crossed", 1, 3, 5, true)).toBe(true);
		expect(watchHolds("crossed", 4, 3, 5, true)).toBe(false);
		expect(watchHolds("crossed", 5, 3, undefined, false)).toBe(false);
	});
});

describe("summarizeDecision and validateAnswer", () => {
	test("summaries carry the name and the context's fields, never the transcript", () => {
		expect(summarizeDecision("on_backlog", { depth: 20, workers: 4 })).toBe("on_backlog depth=20 workers=4");
		expect(summarizeDecision("on_backlog", undefined)).toBe("on_backlog");
		const field = summarizeDecision("pick", { text: "x".repeat(5000) });
		expect(field.length).toBeLessThan(120);
		expect(field).toContain("more)");
		const many: Record<string, string> = {};
		for (let i = 0; i < 100; i++) many[`f${i}`] = "y".repeat(100);
		const long = summarizeDecision("pick", many);
		expect(long.length).toBeLessThan(SUMMARY_CAP + 50);
		expect(long.endsWith("more)")).toBe(true);
	});

	test("an options decision takes one of its options", () => {
		const onBacklog = FIXTURE_MANIFEST.decisions.find((d) => d.name === "on_backlog");
		if (!onBacklog) throw new Error("no on_backlog");
		expect(validateAnswer(onBacklog, "scale_up")).toBeUndefined();
		expect(validateAnswer(onBacklog, "wait")).toBeUndefined();
		expect(validateAnswer(onBacklog, "panic")).toBe("answer must be one of: scale_up, shed_oldest, wait");
		expect(validateAnswer(onBacklog, { choice: "wait" })).toBe("answer must be one of: scale_up, shed_oldest, wait");
	});

	test("an answer-schema decision takes an object of declared, well-typed fields", () => {
		const pick: DecisionDecl = {
			name: "pick",
			doc: "Pick a number.",
			context: {},
			answer: { n: "int" },
			default: {},
			timeout: "5s",
			policy: "auto",
		};
		// a declared field may be absent; a present one must match; an undeclared one is refused
		expect(validateAnswer(pick, {})).toBeUndefined();
		expect(validateAnswer(pick, { n: 3 })).toBeUndefined();
		expect(validateAnswer(pick, { n: 1.5 })).toBe("answer.n must be a int");
		expect(validateAnswer(pick, { n: null })).toBe("answer.n must be a int");
		expect(validateAnswer(pick, { nope: 1 })).toBe("answer has an undeclared field nope");
		expect(validateAnswer(pick, { n: 3, nope: 1 })).toBe("answer has an undeclared field nope");
		expect(validateAnswer(pick, "n")).toBe("answer must be an object");
	});
});
