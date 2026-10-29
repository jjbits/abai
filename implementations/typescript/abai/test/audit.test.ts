// The audit log (abaigrammar section 10): capping values, summarizing
// decision answers, reading the log back, and a log that cannot be written
// latching off and reporting once.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AuditLog, capValue, summarizeAnswer } from "../src/audit.ts";
import { FIXTURE_MANIFEST } from "./fixtures/manifest.ts";

type Rec = Record<string, any>;

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

describe("audit", () => {
	test("a log that cannot be written latches off and is reported once", () => {
		const blocker = join(tempDir("abai-audit-blk-"), "blocker");
		writeFileSync(blocker, "not a directory");
		const failures: string[] = [];
		const log = new AuditLog(join(blocker, "audit.jsonl"), (error) => failures.push(error));
		log.append({ act: "capability", name: "job.retry", outcome: "ok" });
		expect(typeof log.failed).toBe("string");
		expect(failures).toHaveLength(1);
		expect(failures[0]).toBe(log.failed);
		log.append({ act: "capability", name: "job.retry", outcome: "ok" });
		expect(failures).toHaveLength(1);
		expect(readFileSync(blocker, "utf8")).toBe("not a directory");
		expect(log.tail(10)).toEqual({ records: [], truncated: false });
	});

	test("capValue, summarizeAnswer and AuditLog.tail", () => {
		expect(capValue({ a: 1 })).toEqual({ a: 1 });
		expect(capValue(undefined)).toBeUndefined();
		const capped = capValue("x".repeat(600)) as Rec;
		expect(capped).toMatchObject({ truncated: true, bytes: 602 });
		expect(capped.head).toHaveLength(512);
		expect(capped.head.startsWith('"x')).toBe(true);
		expect(typeof capValue(1n)).toBe("string");

		const onBacklog = FIXTURE_MANIFEST.decisions[0];
		expect(summarizeAnswer(onBacklog, "scale_up")).toEqual({ option: "scale_up" });
		expect(summarizeAnswer(onBacklog, undefined)).toBeUndefined();
		expect(summarizeAnswer(undefined, {})).toEqual({ changed: false });
		expect(summarizeAnswer(undefined, { messages: [] })).toEqual({ changed: true });
		expect(summarizeAnswer(undefined, "scale_up")).toEqual({ changed: false });
		expect(summarizeAnswer(undefined, undefined)).toBeUndefined();

		const dir = tempDir("abai-audit-tail-");
		const log = new AuditLog(join(dir, "a.jsonl"));
		expect(log.tail(5)).toEqual({ records: [], truncated: false });
		for (const n of [1, 2, 3]) log.append({ act: "capability", name: `c${n}`, outcome: "ok" });
		log.close();
		expect(log.tail(2).records.map((record) => (record as Rec).name)).toEqual(["c2", "c3"]);
		expect(log.tail(2).truncated).toBe(true);
		expect(log.tail(3).truncated).toBe(false);
		// closed: appends are dropped, not reopened
		log.append({ act: "capability", name: "c4", outcome: "ok" });
		expect(log.tail(10).records).toHaveLength(3);
	});
});
