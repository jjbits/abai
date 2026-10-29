import { Agent } from "@arx-06/agent";
import { createModels, fauxAssistantMessage, fauxProvider } from "@arx-06/ai";
import { anthropicProvider } from "@arx-06/ai/providers/anthropic";
import { ABAI_STUB_VERSION } from "abai";
import { expect, test } from "vitest";
import { ABAI_HARNESS_VERSION } from "../src/index.ts";

test("the harness package loads and sees the stub", () => {
	expect(ABAI_HARNESS_VERSION).toBe("0.1.0");
	expect(ABAI_STUB_VERSION).toBe("0.1.0");
});

test("the pinned agent loop runs one scripted faux reply to completion", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage("hello from the faux model")]);
	const agent = new Agent({
		initialState: { model: faux.getModel(), systemPrompt: "smoke test" },
		streamFn: (model, context, options) => models.streamSimple(model, context, options),
	});
	await agent.prompt("hi");
	const last = agent.state.messages.at(-1);
	expect(last?.role).toBe("assistant");
	const text =
		last && last.role === "assistant" ? last.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
	expect(text).toBe("hello from the faux model");
});

test("the ai package's subpath exports resolve", () => {
	expect(typeof anthropicProvider).toBe("function");
});
