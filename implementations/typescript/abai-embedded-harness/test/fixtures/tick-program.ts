// A program for launch.test.ts: it prints a line on each stream at a steady
// rate and reaches a safepoint on every tick. `N` prints N lines and exits 3;
// `flood` prints many lines at once; `forever` ticks until ended, declares
// os pause and no stop handler, and does nothing on SIGTERM, so the
// launcher's own steps are what end it; `graceful` ticks until ended and
// declares a stop handler, which ends it; `stop-ignored` declares a handler
// that does nothing; `forbid` forbids stop by policy; `coop` declares a
// cooperative pause and gives a turn on every tick.
import { createAbaigram } from "../../../abai/src/index.ts";

const what = process.argv[2] ?? "forever";
const app = createAbaigram(
	{
		name: "ticky",
		modes: ["sidecar"],
		cells: { ticks: { type: "int", access: "read", doc: "Ticks so far." } },
		...(what === "coop" ? { turns: { tick: { timeout: "100ms", doc: "A tick." } } } : {}),
		lifecycle:
			what === "graceful"
				? {
						pause: "os",
						stop: {
							graceful: "2s",
							handler: () => {
								console.log("stopping");
								setTimeout(() => process.exit(0), 20);
							},
						},
					}
				: what === "stop-ignored"
					? {
							pause: "os",
							stop: {
								graceful: "300ms",
								handler: () => {
									console.log("stop ignored");
								},
							},
						}
					: what === "forbid"
						? { pause: "os", policy: { stop: "forbid" } }
						: what === "coop"
							? { pause: "cooperative" }
							: { pause: "os" },
	},
	{ root: `${import.meta.dirname}/sidecar-root`, auditPath: process.env.TICK_AUDIT as string },
);
if (what === "forever" || what === "flood" || /^\d+$/.test(what)) process.on("SIGTERM", () => {});
await app.attach();
const ticks = app.cell<number>("ticks");
if (what === "flood") {
	for (let i = 1; i <= 1000; i++) console.log(`flood ${i}`);
	process.exit(0);
}
if (what === "coop") {
	// a turn on every tick: a cooperative pause holds the program in the next one (abai.pause.blocked)
	for (let i = 1; ; i++) {
		ticks.set(i);
		console.log(`tick ${i}`);
		await app.turn("tick");
	}
}
const limit = what === "forever" || what === "graceful" ? Number.POSITIVE_INFINITY : Number(what);
let n = 0;
const timer = setInterval(() => {
	n += 1;
	ticks.set(n);
	app.safepoint();
	console.log(`tick ${n}`);
	if (n % 2 === 0) console.error(`err ${n}`);
	if (n >= limit) {
		clearInterval(timer);
		process.exit(3);
	}
}, 50);
