// The wire framing and the discovery descriptors.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	assertSocketPathLength,
	attachCappedLineReader,
	DEFAULT_MAX_LINE_BYTES,
	defaultSocketPath,
	descriptorPath,
	ensureRunDir,
	isPidAlive,
	isSocketFile,
	pruneDescriptors,
	readDescriptors,
	removeDescriptor,
	type WireDescriptor,
	writeDescriptor,
} from "../src/wire/index.ts";

describe("attachCappedLineReader", () => {
	test("splits lines across chunks, strips CR and keeps a partial line pending", () => {
		const stream = new PassThrough();
		const lines: string[] = [];
		attachCappedLineReader(
			stream,
			1024,
			(line) => lines.push(line),
			() => lines.push("OVERFLOW"),
		);
		stream.write('{"a":');
		stream.write('1}\n{"b"');
		stream.write(":2}\r\nthird");
		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
		stream.write(Buffer.from("\n"));
		expect(lines).toEqual(['{"a":1}', '{"b":2}', "third"]);
	});

	test("a multi-byte character split across chunks survives", () => {
		const stream = new PassThrough();
		const lines: string[] = [];
		attachCappedLineReader(
			stream,
			1024,
			(line) => lines.push(line),
			() => {},
		);
		const bytes = Buffer.from("é\n", "utf8");
		stream.write(bytes.subarray(0, 1));
		stream.write(bytes.subarray(1));
		expect(lines).toEqual(["é"]);
	});

	test("a pending line over the cap calls onOverflow and is dropped", () => {
		const stream = new PassThrough();
		const lines: string[] = [];
		let overflows = 0;
		attachCappedLineReader(
			stream,
			8,
			(line) => lines.push(line),
			() => {
				overflows += 1;
			},
		);
		stream.write("12345678");
		expect(overflows).toBe(0);
		stream.write("9");
		expect(overflows).toBe(1);
		stream.write("ok\n");
		expect(lines).toEqual(["ok"]);
		expect(DEFAULT_MAX_LINE_BYTES).toBe(64 * 1024 * 1024);
	});

	test("detach stops delivery", () => {
		const stream = new PassThrough();
		const lines: string[] = [];
		const detach = attachCappedLineReader(
			stream,
			1024,
			(line) => lines.push(line),
			() => {},
		);
		stream.write("one\n");
		detach();
		stream.write("two\n");
		expect(lines).toEqual(["one"]);
	});

	test("stops reading the chunk when onLine destroys the stream", () => {
		const stream = new PassThrough();
		const lines: string[] = [];
		attachCappedLineReader(
			stream,
			1024,
			(line) => {
				lines.push(line);
				stream.destroy();
			},
			() => {},
		);
		stream.write("one\ntwo\n");
		expect(lines).toEqual(["one"]);
	});
});

function makeDescriptor(pid: number, socket: string): WireDescriptor {
	return { pid, socket, cwd: "/work", name: "demo", mode: "turns", startedAt: "2026-10-14T00:00:00.000Z" };
}

function deadPid(): number {
	const result = spawnSync(process.execPath, ["-e", ""]);
	return result.pid as number;
}

describe("wire descriptors", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "w-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("paths compose <runDir>/<pid>.json|.sock", () => {
		expect(descriptorPath("/r", 42)).toBe(join("/r", "42.json"));
		expect(defaultSocketPath("/r", 42)).toBe(join("/r", "42.sock"));
	});

	test("assertSocketPathLength accepts 103 bytes and refuses 104", () => {
		expect(() => assertSocketPathLength(`/${"a".repeat(102)}`)).not.toThrow();
		expect(() => assertSocketPathLength(`/${"a".repeat(103)}`)).toThrow(/too long/);
	});

	test.skipIf(process.platform === "win32")("ensureRunDir creates 0o700 and tightens an existing dir", () => {
		const a = join(dir, "a");
		expect(ensureRunDir(a)).toBe(a);
		expect(statSync(a).mode & 0o777).toBe(0o700);
		const b = join(dir, "b");
		mkdirSync(b);
		chmodSync(b, 0o755);
		ensureRunDir(b);
		expect(statSync(b).mode & 0o777).toBe(0o700);
	});

	test("writeDescriptor then readDescriptors round-trips, 0600, no temp file left", () => {
		const descriptor = makeDescriptor(1234, defaultSocketPath(dir, 1234));
		writeDescriptor(dir, descriptor);
		expect(readDescriptors(dir)).toEqual([descriptor]);
		if (process.platform !== "win32") expect(statSync(descriptorPath(dir, 1234)).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});

	test("readDescriptors: missing dir is empty, malformed skipped, extra fields kept, missing name is unknown", () => {
		expect(readDescriptors(join(dir, "missing"))).toEqual([]);
		writeFileSync(join(dir, "bad.json"), "{not json");
		writeFileSync(join(dir, "nopid.json"), '{"socket":"/x"}');
		const foreign = {
			pid: 9,
			socket: "/tmp/9.sock",
			cwd: "/",
			agentDir: "/home/a",
			mode: "rpc",
			version: "0.87.1",
			startedAt: "",
			sessionId: null,
		};
		writeFileSync(descriptorPath(dir, 9), JSON.stringify(foreign));
		const good = makeDescriptor(77, "/tmp/77.sock");
		writeDescriptor(dir, good);
		expect(readDescriptors(dir)).toEqual([good, { ...foreign, name: "unknown" }]);
	});

	test("removeDescriptor removes the file and tolerates a missing one", () => {
		writeDescriptor(dir, makeDescriptor(5, "/tmp/5.sock"));
		removeDescriptor(dir, 5);
		expect(existsSync(descriptorPath(dir, 5))).toBe(false);
		expect(() => removeDescriptor(dir, 5)).not.toThrow();
	});

	test("isPidAlive: own pid is alive, an exited child is not", () => {
		expect(isPidAlive(process.pid)).toBe(true);
		expect(isPidAlive(deadPid())).toBe(false);
	});

	test("pruneDescriptors keeps live ones and removes dead ones and their default sockets", async () => {
		const dead1 = deadPid();
		const dead2 = deadPid();
		const dead3 = deadPid();
		const defaultSocket = defaultSocketPath(dir, dead1);
		const plainAtDefaultPath = defaultSocketPath(dir, dead2);
		const customSocket = join(dir, "s.sock");
		writeFileSync(plainAtDefaultPath, "");
		const servers = [createServer(), createServer()];
		await new Promise<void>((resolve) => servers[0].listen(defaultSocket, () => resolve()));
		await new Promise<void>((resolve) => servers[1].listen(customSocket, () => resolve()));
		try {
			expect(isSocketFile(defaultSocket)).toBe(true);
			expect(isSocketFile(plainAtDefaultPath)).toBe(false);
			const live = makeDescriptor(process.pid, defaultSocketPath(dir, process.pid));
			writeDescriptor(dir, live);
			writeDescriptor(dir, makeDescriptor(dead1, defaultSocket));
			writeDescriptor(dir, makeDescriptor(dead2, plainAtDefaultPath));
			writeDescriptor(dir, makeDescriptor(dead3, customSocket));
			expect(pruneDescriptors(dir)).toEqual([live]);
			for (const pid of [dead1, dead2, dead3]) expect(existsSync(descriptorPath(dir, pid))).toBe(false);
			expect(existsSync(defaultSocket)).toBe(false);
			// a regular file is never unlinked, even at a default path
			expect(existsSync(plainAtDefaultPath)).toBe(true);
			// an explicit path may belong to a live process by now: prune never touches it
			expect(existsSync(customSocket)).toBe(true);
		} finally {
			for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
