// The aiap v1 envelope: ids, encoding, the caps, and how an inbound payload
// sorts into an envelope, a foreign aiap payload or raw bytes.
import { describe, expect, test } from "vitest";
import { classify, encodeMessage, newMessageId, validate } from "../src/net/envelope.ts";

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const TS = "2026-01-01T00:00:00Z";

describe("aiap envelope", () => {
	test("ids are 26 Crockford characters with the time in front", () => {
		const a = newMessageId();
		expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(newMessageId()).not.toBe(a);
		expect(newMessageId(0).slice(0, 10)).toBe("0000000000");
		expect(newMessageId(1).slice(0, 10)).toBe("0000000001");
		expect(newMessageId(32).slice(0, 10)).toBe("0000000010");
	});

	test("a message encodes to a v1 envelope that classifies back", () => {
		const { id, ts, bytes } = encodeMessage({
			body: "hi there",
			thread: "T1",
			re: "R1",
			now: Date.UTC(2026, 10, 5, 12, 0, 0),
		});
		expect(ts).toBe("2026-11-05T12:00:00Z");
		expect(id).toHaveLength(26);
		expect(JSON.parse(Buffer.from(bytes).toString())).toEqual({
			aiap: 1,
			type: "msg",
			id,
			ts,
			thread: "T1",
			re: "R1",
			body: "hi there",
		});
		expect(classify(bytes)).toMatchObject({
			kind: "msg",
			envelope: { id, body: "hi there", thread: "T1", re: "R1" },
		});
	});

	test("the caps refuse what aiap refuses", () => {
		expect(() => encodeMessage({ body: "" })).toThrow(/a msg needs a body/);
		expect(() => encodeMessage({ body: "x".repeat(65537) })).toThrow(/body exceeds 65536 bytes/);
		expect(() => encodeMessage({ body: "x", thread: "t".repeat(65) })).toThrow(/thread exceeds 64 bytes/);
		expect(() => encodeMessage({ body: "x", id: "raw-1" })).toThrow(/reserved prefix raw-/);
		expect(() => encodeMessage({ body: "x".repeat(65536) })).not.toThrow();
	});

	test("raw payloads", () => {
		const text = (s: string) => new TextEncoder().encode(s);
		expect(classify(text("hello"))).toEqual({ kind: "raw", body: "hello" });
		expect(classify(text("[1,2]"))).toEqual({ kind: "raw", body: "[1,2]" });
		expect(classify(text('{"x":1}'))).toEqual({ kind: "raw", body: '{"x":1}' });
		expect(classify(text('{"aiap":"1","type":"msg"}')).kind).toBe("raw");
		expect(classify(new Uint8Array([0xff, 0xfe]))).toEqual({ kind: "raw", body: "binary payload, 2 bytes" });
		expect(classify(text("y".repeat(70000)))).toEqual({ kind: "raw", body: "payload too large: 70000 bytes" });
		expect(classify(new Uint8Array(262145))).toEqual({ kind: "raw", body: "payload too large: 262145 bytes" });
	});

	test("foreign payloads", () => {
		expect(classify(enc({ aiap: 2, type: "msg", id: "A", ts: TS, body: "x" }))).toEqual({
			kind: "foreign",
			note: "aiap v2 envelope",
			version: 2,
		});
		expect(classify(enc({ aiap: 1, type: "nope", id: "A", ts: TS }))).toMatchObject({
			kind: "foreign",
			version: 1,
			note: expect.stringMatching(/unknown type/),
		});
		expect(classify(enc({ aiap: 1, type: "msg", id: "A", ts: TS }))).toMatchObject({
			kind: "foreign",
			note: expect.stringMatching(/needs a body/),
		});
		expect(classify(enc({ aiap: 1, type: "msg", id: "raw-7", ts: TS, body: "x" }))).toMatchObject({
			kind: "foreign",
			note: expect.stringMatching(/reserved prefix/),
		});
		expect(classify(enc({ aiap: 1, type: "msg", id: "A", ts: "yesterday", body: "x" }))).toMatchObject({
			kind: "foreign",
			note: expect.stringMatching(/RFC 3339/),
		});
		expect(
			classify(enc({ aiap: 1, type: "receipt", id: "A", ts: TS, receipt: { of: "B", status: "read" } })),
		).toMatchObject({ kind: "foreign", note: expect.stringMatching(/not delivered/) });
	});

	test("the other envelope types classify by type", () => {
		expect(classify(enc({ aiap: 1, type: "profile-query", id: "Q", ts: TS })).kind).toBe("profile-query");
		expect(
			classify(enc({ aiap: 1, type: "profile", id: "P", ts: TS, profile: { agent: "beta", project: "abai" } })).kind,
		).toBe("profile");
		expect(classify(enc({ aiap: 1, type: "profile", id: "P", ts: TS, profile: { agent: "Beta!" } }))).toMatchObject({
			kind: "foreign",
			note: expect.stringMatching(/not an agent name/),
		});
		expect(
			classify(enc({ aiap: 1, type: "receipt", id: "R", ts: TS, receipt: { of: "B", status: "delivered" } })).kind,
		).toBe("receipt");
	});

	test("validate names the first problem", () => {
		expect(validate({ aiap: 1, type: "msg", id: "", ts: TS, body: "x" })).toBe("id is required");
		expect(validate({ aiap: 1, type: "msg", id: "A", ts: TS, body: "x" })).toBeUndefined();
	});
});

describe("aiap envelope, as Go decodes it", () => {
	const valid = { aiap: 1, type: "msg", id: "A", ts: "2026-01-01T00:00:00Z", body: "x" };
	const raw = (s: string) => new TextEncoder().encode(s);

	test("aiap must be an integer literal", () => {
		expect(classify(raw('{"aiap":1.0,"type":"msg","id":"A","ts":"2026-01-01T00:00:00Z","body":"x"}')).kind).toBe(
			"raw",
		);
		expect(classify(raw('{"aiap":1e0,"type":"msg","id":"A","ts":"2026-01-01T00:00:00Z","body":"x"}')).kind).toBe(
			"raw",
		);
		expect(classify(raw('{"aiap":true,"type":"msg"}')).kind).toBe("raw");
		expect(classify(enc(valid)).kind).toBe("msg");
	});

	test("a null field is a field not given", () => {
		expect(classify(enc({ ...valid, thread: null, re: null })).kind).toBe("msg");
		expect(
			classify(
				enc({
					aiap: 1,
					type: "profile",
					id: "P",
					ts: "2026-01-01T00:00:00Z",
					profile: { agent: null, project: "abai" },
				}),
			).kind,
		).toBe("profile");
		expect(
			classify(enc({ aiap: 1, type: "profile", id: "P", ts: "2026-01-01T00:00:00Z", profile: [] })),
		).toMatchObject({
			kind: "foreign",
		});
		expect(classify(enc({ ...valid, body: null }))).toMatchObject({ kind: "foreign", note: "a msg needs a body" });
	});

	test("the JSON is read before the bytes are judged", () => {
		const bytes = new TextEncoder().encode(JSON.stringify({ ...valid, body: "aQ" }));
		bytes[bytes.indexOf(0x51)] = 0xff; // the Q becomes a byte no UTF-8 text has
		expect(classify(bytes)).toMatchObject({ kind: "msg", envelope: { body: "a�" } });
		const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(valid)]);
		const sorted = classify(bom);
		expect(sorted.kind).toBe("raw");
		expect(sorted.kind === "raw" && sorted.body.startsWith("﻿{")).toBe(true);
		const big = new Uint8Array(70000).fill(0xff);
		expect(classify(big)).toEqual({ kind: "raw", body: "payload too large: 70000 bytes" });
	});

	test("a time out of range is not RFC 3339", () => {
		expect(classify(enc({ ...valid, ts: "2026-02-30T00:00:00Z" }))).toMatchObject({
			kind: "foreign",
			note: expect.stringMatching(/RFC 3339/),
		});
		expect(classify(enc({ ...valid, ts: "2026-01-01T24:00:00Z" }))).toMatchObject({ kind: "foreign" });
		expect(classify(enc({ ...valid, ts: "2026-01-01T00:00:00+05:30" })).kind).toBe("msg");
		expect(classify(enc({ ...valid, ts: "2026-12-31T23:59:59.123Z" })).kind).toBe("msg");
	});
});
