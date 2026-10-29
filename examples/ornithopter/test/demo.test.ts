import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

async function demo(env: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
	return run(process.execPath, ["src/main.ts", "--demo"], {
		cwd: root,
		env: { ...process.env, ...env },
		timeout: 20000,
	});
}

describe("the demo flight", () => {
	it("lands on the pad, crashes on purpose, and resets, with nothing attached", async () => {
		const { stdout } = await demo({ ABAI_HARNESS: "off" });
		// leg one landed on the pad (the touchdown), leg two crashed and reset: the ship is back on the pad
		expect(stdout).toMatch(/^ornithopter demo: leg 2, grounded after \d+ s at \(0, 0\)/);
		for (const event of [
			"flight.takeoff x2",
			"flight.touchdown x1",
			"flight.crash x1",
			"threat.warning x",
			"terrain.warning x",
			"stall.warning x1",
			"power.low x1",
			"boundary.warning x1",
		]) {
			expect(stdout).toContain(event);
		}
	});

	it("exits 0 under the exercise harness in both modes, every declaration exercised", async () => {
		for (const mode of ["sidecar", "turns"]) {
			const { stdout, stderr } = await demo({ ABAI_HARNESS: "exercise", ABAI_MODE: mode });
			expect(stdout).toContain("ornithopter demo:");
			const report = JSON.parse(stderr.trim().split("\n").at(-1) ?? "{}") as {
				unexercised: unknown[];
				capabilitiesCalled: string[];
				knobsWritten: string[];
				eventsEmitted: string[];
				cellsWritten: string[];
			};
			// the report lists knobs, capabilities, decisions and turns; cells and events are checked by name here
			expect(report.unexercised).toEqual([]);
			expect(report.capabilitiesCalled.sort()).toEqual([
				"flight.go_around",
				"flight.land",
				"flight.reset",
				"flight.takeoff",
				"world.describe",
			]);
			expect(report.knobsWritten.sort()).toEqual(["target.altitude_m", "target.heading_deg", "target.speed_mps"]);
			const manifest = await import("../src/abai.ts").then((m) => m.app.manifest);
			for (const event of manifest.events) expect(report.eventsEmitted).toContain(event.name);
			for (const cell of manifest.cells)
				if (cell.access === "read") expect(report.cellsWritten).toContain(cell.name);
		}
	});
});
