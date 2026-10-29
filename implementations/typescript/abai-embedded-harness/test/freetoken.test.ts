import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createModels } from "@arx-06/ai";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { createFreeTokenProvider } from "../src/model/freetoken/provider.ts";

const REPLY_PARTS = ["hello ", "from fake ", "freetoken"];

function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
	const body = {
		id: "chatcmpl-fake",
		object: "chat.completion.chunk",
		created: 0,
		model: "test-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	return `data: ${JSON.stringify(body)}\n\n`;
}

let server: Server;
let serverUrl: string;

beforeAll(async () => {
	server = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "ok" }));
			return;
		}
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model", context_length: 8192 }] }),
			);
			return;
		}
		if (req.method === "POST" && req.url === "/v1/chat/completions") {
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				res.write(chunk({ role: "assistant", content: "" }, null));
				for (const part of REPLY_PARTS) res.write(chunk({ content: part }, null));
				res.write(chunk({}, "stop"));
				res.end("data: [DONE]\n\n");
			});
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	serverUrl = `http://127.0.0.1:${port}`;
});

afterEach(() => {
	vi.unstubAllEnvs();
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test("the FreeToken provider lists the served model and streams a completion", async () => {
	vi.stubEnv("FREETOKEN_BASE_URL", serverUrl);
	const ft = createFreeTokenProvider();
	const models = createModels();
	models.setProvider(ft.provider);

	const result = await models.refresh({ providers: ["freetoken"], allowNetwork: true });
	expect(result.errors.size).toBe(0);
	expect(models.getModels("freetoken").map((m) => m.id)).toContain("test-model");

	const model = models.getModel("freetoken", "test-model")!;
	const events = models.streamSimple(model, {
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
	});
	const types: string[] = [];
	for await (const event of events) types.push(event.type);
	const message = await events.result();
	expect(types.at(-1)).toBe("done");
	const text = message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	expect(text).toBe("hello from fake freetoken");
	expect(message.stopReason).toBe("stop");
});
