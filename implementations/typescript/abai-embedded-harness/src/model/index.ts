// The model layer (abaigrammar section 9): the providers the harness
// knows, registered on a Models instance over the machine's credentials,
// and the configured default model resolved into what the agent loop
// needs. Provider-neutral in the grammar's sense: nothing is bundled, and a
// program without a configured model attaches nothing.
import { type AuthContext, createModels, type Model, type MutableModels } from "@arx-06/ai";
import { anthropicProvider } from "@arx-06/ai/providers/anthropic";
import type { AgentModel } from "../agent.ts";
import { type AbaiConfig, abaiHome, FileCredentialStore, readConfig } from "../config.ts";
import { createFreeTokenProvider, FREETOKEN_PROVIDER_ID } from "./freetoken/provider.ts";

export { FREETOKEN_PROVIDER_ID } from "./freetoken/provider.ts";

export interface ModelSetup {
	home: string;
	config: AbaiConfig;
	credentials: FileCredentialStore;
	models: MutableModels;
}

/** Environment lookups the providers make, routed through the configuration first. */
function authContext(config: AbaiConfig, env: NodeJS.ProcessEnv): AuthContext {
	const configured: Record<string, string> = {};
	for (const settings of Object.values(config.providers ?? {})) Object.assign(configured, settings);
	return {
		env: async (name) => {
			const value = configured[name] ?? env[name];
			return value === undefined || value === "" ? undefined : value;
		},
		fileExists: async () => false,
	};
}

/** Build the Models instance for this machine: the configuration, the credential file, every known provider. */
export function createModelSetup(env: NodeJS.ProcessEnv = process.env, home = abaiHome(env)): ModelSetup {
	const config = readConfig(home);
	const credentials = new FileCredentialStore(home);
	const models = createModels({ credentials, authContext: authContext(config, env) });
	models.setProvider(anthropicProvider());
	models.setProvider(createFreeTokenProvider().provider);
	return { home, config, credentials, models };
}

export class ModelNotConfigured extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelNotConfigured";
	}
}

/**
 * The configured model, ready for the agent loop. Throws ModelNotConfigured
 * when the configuration names none, when its provider has no complete
 * auth, or when the model is unknown. A dynamic provider (FreeToken) is
 * refreshed over the network only when `allowNetwork` is set.
 */
export async function resolveConfiguredModel(
	setup: ModelSetup,
	options: { allowNetwork?: boolean; signal?: AbortSignal } = {},
): Promise<AgentModel> {
	const { config, models } = setup;
	if (!config.provider || !config.model) {
		throw new ModelNotConfigured("no model configured for the embedded harness (run: <prog> abai config)");
	}
	const check = await models.checkAuth(config.provider);
	if (!check) {
		throw new ModelNotConfigured(
			`provider ${config.provider} has no complete configuration (run: <prog> abai config)`,
		);
	}
	let refreshed = false;
	if (config.provider === FREETOKEN_PROVIDER_ID && options.allowNetwork) {
		const result = await models.refresh({
			providers: [FREETOKEN_PROVIDER_ID],
			allowNetwork: true,
			signal: options.signal,
		});
		if (result.aborted)
			throw new ModelNotConfigured("the FreeToken catalog did not arrive within the connect timeout");
		const failure = result.errors.get(FREETOKEN_PROVIDER_ID);
		if (failure) throw new ModelNotConfigured(`the FreeToken catalog could not be read: ${failure.message}`);
		refreshed = true;
	}
	const model = models.getModel(config.provider, config.model) as Model<any> | undefined;
	if (!model) {
		const known = models
			.getModels(config.provider)
			.map((m) => m.id)
			.join(", ");
		const none = refreshed || config.provider !== FREETOKEN_PROVIDER_ID ? "none" : "none until a refresh";
		throw new ModelNotConfigured(`${config.provider} has no model ${config.model} (known: ${known || none})`);
	}
	// a configured base URL (a proxy, a test server) replaces the catalog's
	const baseUrl = config.providers?.[config.provider]?.[`${config.provider.toUpperCase()}_BASE_URL`];
	const chosen = baseUrl ? ({ ...model, baseUrl } as Model<any>) : model;
	return { model: chosen, streamFn: (m, context, streamOptions) => models.streamSimple(m, context, streamOptions) };
}
