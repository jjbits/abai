// The harness against a live arx-06 (abaigrammar section 6.3, sidecar
// attach): arx-06's supervisor speaks wire protocol v1's core, so it is a
// target as it is. Skipped unless ABAI_ARX06_DIR names an arx-06 checkout
// with a built bundle; never part of the default gate.
//
//   ABAI_ARX06_DIR=~/projects/arx-06-0 npx vitest --run test/live-arx.test.ts
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { descriptorPath, validateManifest } from "abai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Harness } from "../src/harness.ts";
import { defaultOptions } from "../src/options.ts";
import { SocketTransport } from "../src/transport-socket.ts";

const arxDir = process.env.ABAI_ARX06_DIR
	? resolve(process.env.ABAI_ARX06_DIR.replace(/^~/, process.env.HOME ?? ""))
	: "";
const bundle = arxDir ? join(arxDir, "packages/coding-agent/dist/bundle/cli.js") : "";
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

async function waitUntil(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

describe.skipIf(!arxDir)("a live arx-06 as the sidecar target", () => {
	let root = "";
	let runDir = "";
	let child: ChildProcess | undefined;
	let pid = 0;
	const stderr: string[] = [];

	beforeAll(async () => {
		if (!existsSync(bundle)) throw new Error(`no arx-06 bundle at ${bundle}; build it first`);
		root = mkdtempSync(join(tmpdir(), "la-"));
		const agentDir = join(root, "agent");
		const home = join(root, "home");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(home, { recursive: true });
		// a model that resolves offline and is never contacted: the input decision is answered "handled"
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					stub: { baseUrl: "http://127.0.0.1:9", api: "openai-completions", apiKey: "x", models: [{ id: "m" }] },
				},
			}),
		);
		runDir = join(agentDir, "supervisor");
		const env = { ...process.env, HOME: home, [AGENT_DIR_ENV]: agentDir, PI_OFFLINE: "1", PI_SUPERVISOR: "1" };
		child = spawn(process.execPath, [bundle, "--mode", "rpc", "--model", "stub/m"], {
			cwd: root,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout?.resume();
		child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
		if (child.pid === undefined) throw new Error("arx-06 did not start");
		pid = child.pid;
		await waitUntil(
			() => existsSync(descriptorPath(runDir, pid)),
			20_000,
			`arx-06's descriptor (stderr: ${stderr.join("")})`,
		);
	}, 30_000);

	afterAll(async () => {
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			await new Promise((r) => setTimeout(r, 300));
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it(
		"attaches by pid, reads the program, writes a knob, is asked the input decision and answers it",
		{ timeout: 30_000 },
		async () => {
			const transport = await SocketTransport.connect(pid, { runDir });
			expect(transport.hello).toMatchObject({
				name: "arx-06",
				abaigrammar: "0.1",
				modes: ["sidecar"],
				pid,
				extensions: [],
			});

			const harness = new Harness(defaultOptions("session", { claims: ["input"] }));
			const hello = await harness.attach(transport);
			expect(hello.connection).toMatch(/^k\d+$/);
			const manifest = harness.manifest;
			expect(manifest).toBeDefined();
			expect(validateManifest(manifest as never)).toEqual([]);
			expect(manifest?.decisions.map((d) => d.name)).toContain("input");
			expect(harness.currentClaims()).toEqual(["input"]);
			expect(harness.identity.length).toBeGreaterThan(0);

			const cells = await harness.cells(["retry.auto", "model.id"]);
			expect(cells["model.id"]).toBe("m");
			expect(typeof cells["retry.auto"]).toBe("boolean");
			expect(await harness.setCell("retry.auto", false, "the live test flips a knob")).toBe(false);
			expect((await harness.cells(["retry.auto"]))["retry.auto"]).toBe(false);

			// a prompt through the capability makes arx-06 ask the claimed input decision on this connection
			const prompting = harness
				.call("prompt", { message: "hello from the live test" }, "drive the input decision")
				.catch((error: unknown) => error);
			const wake = await harness.nextDelivery(10_000);
			expect(wake?.text).toContain("input");
			const pending = harness.pendingDecisions();
			expect(pending).toHaveLength(1);
			expect(pending[0].hook).toBe("input");
			expect(pending[0].payload).toMatchObject({ text: "hello from the live test" });
			// arx-06 declares text and images on the input answer; "handled" needs neither, and a declared field may
			// be absent (2026-10-14)
			harness.decide(pending[0].id, { action: "handled" }, "the live test consumes the prompt");
			const outcome = await prompting;
			expect(outcome).not.toBeInstanceOf(Error);
			expect(harness.pendingDecisions()).toEqual([]);

			const audit = (await harness.audit(50)) as { records: Array<Record<string, unknown>> };
			expect(audit.records.some((r) => r.act === "knob" && r.name === "retry.auto")).toBe(true);
			expect(
				audit.records.some((r) => r.name === "input" && typeof r.reason === "string" && /live test/.test(r.reason)),
			).toBe(true);

			harness.shutdown("the live test is done");
			expect(transport.open).toBe(false);
		},
	);
});
