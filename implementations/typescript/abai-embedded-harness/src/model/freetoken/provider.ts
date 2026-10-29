// abai: a dynamic provider for a FreeToken (ft2) server. The served model id
// and context window come from the server; the per-family compat flags below
// are what pi-recon verified against ft2.
import type {
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Model,
	OpenAICompletionsCompat,
	Provider,
	ProviderStreamOptions,
	RefreshModelsContext,
	ThinkingLevelMap,
} from "@arx-06/ai";
import { openAICompletionsApi } from "@arx-06/ai/api/openai-completions.lazy";
import {
	FreeTokenClient,
	type FreeTokenHealth,
	type FreeTokenServedModel,
	freetokenInferenceUrl,
	normalizeFreeTokenServerUrl,
} from "./client.ts";

export const FREETOKEN_PROVIDER_ID = "freetoken";
export const FREETOKEN_BASE_URL_ENV = "FREETOKEN_BASE_URL";
export const FREETOKEN_API_KEY_ENV = "FREETOKEN_API_KEY";
export const DEFAULT_FREETOKEN_SERVER_URL = "http://127.0.0.1:1919";
/** Used only when /v1/models reports no context length. */
export const DEFAULT_FREETOKEN_CONTEXT_WINDOW = 65_536;

interface ModelFamily {
	match: RegExp;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	compat: Partial<OpenAICompletionsCompat>;
}

// The V4.1 encoder accepts only low / high / max, so pi's levels fold onto those
// three. "off" is not offered (null): ft2 forces thinking whenever tools are
// present, so an off request would only pretend.
const DEEPSEEK_V41_THINKING_LEVELS: ThinkingLevelMap = {
	off: null,
	minimal: "low",
	low: "low",
	medium: "low",
	high: "high",
	xhigh: "max",
	max: "max",
};

const FAMILIES: readonly ModelFamily[] = [
	{
		// deepseek-v41-flash, deepseek-v4.1-flash, deepseek-v4-1-flash, deepseek-ai/DeepSeek-V4.1-Flash
		match: /(?:^|\/)deepseek[-_]?v4[-._]?1(?![0-9])/i,
		reasoning: true,
		thinkingLevelMap: DEEPSEEK_V41_THINKING_LEVELS,
		compat: { thinkingFormat: "deepseek", supportsReasoningEffort: true },
	},
	{ match: /(?:^|\/)deepseek/i, reasoning: false, compat: { thinkingFormat: "deepseek" } },
];

export function toFreeTokenModel(served: FreeTokenServedModel, serverUrl: string): Model<"openai-completions"> {
	const family = FAMILIES.find((candidate) => candidate.match.test(served.id));
	const contextWindow =
		served.contextLength && served.contextLength > 0 ? served.contextLength : DEFAULT_FREETOKEN_CONTEXT_WINDOW;
	// A quarter of the window, between 4k and 32k, and never more than half the window.
	const maxTokens = Math.min(
		Math.min(32_768, Math.max(4_096, Math.floor(contextWindow / 4))),
		Math.floor(contextWindow / 2),
	);
	return {
		id: served.id,
		name: `${served.id} (FreeToken)`,
		api: "openai-completions",
		provider: FREETOKEN_PROVIDER_ID,
		baseUrl: freetokenInferenceUrl(serverUrl),
		reasoning: family?.reasoning ?? false,
		...(family?.thinkingLevelMap && { thinkingLevelMap: family.thinkingLevelMap }),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
		compat: {
			supportsStore: false,
			// The system prompt must go out as `system`; ft2 does not know the developer role.
			supportsDeveloperRole: false,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
			...family?.compat,
		},
	};
}

export function describeFreeTokenHealth(serverUrl: string, health: FreeTokenHealth): string {
	switch (health.status) {
		case "ok":
			return `FreeToken server at ${serverUrl} is ready`;
		case "loading":
			return `FreeToken server at ${serverUrl} is still loading${health.phase ? ` (${health.phase})` : ""}`;
		case "error":
			return `FreeToken server at ${serverUrl} reported an error${health.message ? `: ${health.message}` : ""}`;
		case "unreachable":
			return `FreeToken server at ${serverUrl} is unreachable: ${health.message}`;
	}
}

/** An unparsable URL counts as "not configured" so one bad variable cannot break every provider's availability. */
function safeServerUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		return normalizeFreeTokenServerUrl(value);
	} catch {
		return undefined;
	}
}

function credentialServerUrl(credential: ApiKeyCredential | undefined): string | undefined {
	return safeServerUrl(credential?.env?.[FREETOKEN_BASE_URL_ENV]);
}

async function resolveServerUrl(
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<string | undefined> {
	return credentialServerUrl(credential) ?? safeServerUrl(await ctx.env(FREETOKEN_BASE_URL_ENV));
}

export interface FreeTokenProviderController {
	provider: Provider<"openai-completions">;
	setCatalog(models: readonly FreeTokenServedModel[], serverUrl: string): void;
}

export function createFreeTokenProvider(): FreeTokenProviderController {
	// The lazy wrapper loads the openai-completions implementation on first stream, without the compat registry.
	const api = openAICompletionsApi();
	let models: readonly Model<"openai-completions">[] = [];

	const setCatalog = (catalog: readonly FreeTokenServedModel[], serverUrl: string): void => {
		models = catalog.map((served) => toFreeTokenModel(served, serverUrl));
	};

	const provider: Provider<"openai-completions"> = {
		id: FREETOKEN_PROVIDER_ID,
		name: "FreeToken (ft2)",
		baseUrl: freetokenInferenceUrl(DEFAULT_FREETOKEN_SERVER_URL),
		auth: {
			apiKey: {
				name: "FreeToken server",
				login: async (interaction): Promise<ApiKeyCredential> => {
					const enteredUrl = await interaction.prompt({
						type: "text",
						message: "FreeToken server URL",
						placeholder: process.env[FREETOKEN_BASE_URL_ENV] ?? DEFAULT_FREETOKEN_SERVER_URL,
					});
					const serverUrl = normalizeFreeTokenServerUrl(
						enteredUrl.trim() || process.env[FREETOKEN_BASE_URL_ENV] || DEFAULT_FREETOKEN_SERVER_URL,
					);
					const apiKey = (await interaction.prompt({ type: "secret", message: "API key (optional)" })).trim();
					const health = await new FreeTokenClient(serverUrl, apiKey || undefined).health({
						signal: interaction.signal,
					});
					if (health.status === "unreachable" || health.status === "error") {
						throw new Error(describeFreeTokenHealth(serverUrl, health));
					}
					return {
						type: "api_key",
						key: apiKey || undefined,
						env: { [FREETOKEN_BASE_URL_ENV]: serverUrl },
					};
				},
				check: async ({ ctx, credential }) => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					return serverUrl
						? { type: "api_key", source: credential ? "stored credential" : FREETOKEN_BASE_URL_ENV }
						: undefined;
				},
				resolve: async ({ ctx, credential }): Promise<AuthResult | undefined> => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					if (!serverUrl) return undefined;
					// ft2 does not check keys; "local" only satisfies pi's configured-provider rule.
					const apiKey = credential?.key ?? (await ctx.env(FREETOKEN_API_KEY_ENV)) ?? "local";
					return {
						auth: { apiKey, baseUrl: freetokenInferenceUrl(serverUrl) },
						env: { ...credential?.env, [FREETOKEN_BASE_URL_ENV]: serverUrl },
						source: credential ? "stored credential" : FREETOKEN_BASE_URL_ENV,
					};
				},
			},
		},
		getModels: () => models,
		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			if (context.stored) {
				const restored = context.stored.models.filter(
					(model): model is Model<"openai-completions"> =>
						model.provider === FREETOKEN_PROVIDER_ID && model.api === "openai-completions",
				);
				if (
					!(await context.publish({
						update: () => {
							models = restored;
						},
					}))
				) {
					return;
				}
			}

			if (!context.allowNetwork || context.signal.aborted || context.credential?.type !== "api_key") return;
			const serverUrl = credentialServerUrl(context.credential);
			if (!serverUrl) return;
			const client = new FreeTokenClient(serverUrl, context.credential.key);
			const health = await client.health({ signal: context.signal });
			if (context.signal.aborted) return;
			if (health.status !== "ok") throw new Error(describeFreeTokenHealth(serverUrl, health));
			const served = await client.models({ signal: context.signal });
			if (context.signal.aborted) return;
			const refreshed = served.map((model) => toFreeTokenModel(model, serverUrl));
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					models = refreshed;
				},
			});
		},
		stream: (model, context, options) => api.stream(model, context, options as ProviderStreamOptions | undefined),
		streamSimple: (model, context, options) => api.streamSimple(model, context, options),
	};

	return { provider, setCatalog };
}
