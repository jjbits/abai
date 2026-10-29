// A program with an endpoint, run as a child by endpoint.test.ts to prove
// two things about the event loop: a program whose work is done exits with
// a harness still connected (the server and its sockets are unref'd), and a
// program awaiting a touchpoint over the socket stays alive until the
// harness ends it (the binding's ref'd keep-alive).

import { createInterface } from "node:readline";
import { createAbaigram } from "../../src/index.ts";

const what = process.argv[2] ?? "exit";
const app = createAbaigram(
	{
		name: "fixture",
		modes: ["sidecar"],
		cells: { "queue.depth": { type: "int", access: "read", doc: "Depth." } },
		events: { ping: { payload: {}, wakes: "never", doc: "A ping." } },
		lifecycle: {
			pause: "cooperative",
			stop: {
				graceful: "1s",
				handler: () => {
					console.log("stopping");
					setTimeout(() => process.exit(0), 20);
				},
			},
		},
	},
	{
		env: {
			ABAI_HARNESS: "",
			ABAI_MODE: "sidecar",
			ABAI_RUN_DIR: process.env.FIXTURE_RUN_DIR as string,
			ABAI_HARNESS_BIN: "/nonexistent/abai-harness",
		},
		root: import.meta.dirname,
		auditPath: process.env.FIXTURE_AUDIT as string,
	},
);
const endpoint = app.endpoint;
if (!endpoint) throw new Error("no endpoint under sidecar");
await endpoint.ready;
console.log(`ready ${endpoint.socketPath}`);
const connected = await endpoint.waitForConnection(5000);
console.log(`connected ${connected}`);
if (what === "session" || what === "paused-session") {
	// paused-session: the test pauses the program first, then says go; the session must then hold until resume
	if (what === "paused-session") {
		const lines = createInterface({ input: process.stdin });
		await new Promise<void>((resolve) => lines.once("line", () => resolve()));
		lines.close();
		process.stdin.pause();
		console.log(`going paused=${app.paused}`);
	}
	await app.session();
	console.log(`session ended attached=${app.attached}`);
} else if (what === "stop") {
	// wait to be stopped: the handler above ends the process; nothing else of the program's is pending
	await app.session();
	console.log("session ended without a stop");
} else {
	app.event("ping").emit();
}
// nothing else is pending: the process should end here, connection or not
