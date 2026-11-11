// The model layer (abaigrammar section 9): every provider arx-06 carries
// and FreeToken, registered on a Models instance over the machine's
// credentials, and the configured default model resolved into what the
// agent loop needs. Provider-neutral in the grammar's sense: nothing is
// bundled, and a program without a configured model attaches nothing.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AuthContext, createModels, type Model, type MutableModels, type Provider } from "@arx-06/ai";
import { builtinProviders } from "@arx-06/ai/providers/all";
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

/**
 * What the providers ask about the machine: environment lookups routed
 * through the configuration first, and whether a credentials file exists
 * (Google's application-default credentials, AWS profiles), `~` expanded
 * the way `ABAI_HOME` defaults.
 */
export function authContextFor(config: AbaiConfig, env: NodeJS.ProcessEnv): AuthContext {
	const configured: Record<string, string> = {};
	for (const settings of Object.values(config.providers ?? {})) Object.assign(configured, settings);
	return {
		env: async (name) => {
			const value = configured[name] ?? env[name];
			return value === undefined || value === "" ? undefined : value;
		},
		fileExists: async (path) => existsSync(expandHome(path, env)),
	};
}

function expandHome(path: string, env: NodeJS.ProcessEnv): string {
	if (path !== "~" && !path.startsWith("~/")) return path;
	const home = env.HOME && env.HOME !== "" ? env.HOME : homedir();
	return join(home, path.slice(1));
}

/**
 * Build the Models instance for this machine: the configuration, the
 * credential file, every provider arx-06 carries, FreeToken, and any the
 * caller adds (tests register a scripted one).
 */
export function createModelSetup(
	env: NodeJS.ProcessEnv = process.env,
	home = abaiHome(env),
	extraProviders: readonly Provider[] = [],
): ModelSetup {
	const config = readConfig(home);
	const credentials = new FileCredentialStore(home);
	const models = createModels({ credentials, authContext: authContextFor(config, env) });
	for (const provider of builtinProviders()) models.setProvider(provider);
	models.setProvider(createFreeTokenProvider().provider);
	for (const provider of extraProviders) models.setProvider(provider);
	return { home, config, credentials, models };
}

/** The ids a configuration may name as its provider, sorted. */
export function knownProviderIds(models: MutableModels): string[] {
	return models
		.getProviders()
		.map((p) => p.id)
		.sort();
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
