// The harness's own verbs of the standard entry (abaigrammar section 4.4):
// `config` edits the machine-level configuration and `doctor`'s online
// half checks the model. The stub delegates these to the installed harness
// package; the sidecar binary offers them too. Never throws; resolves to
// the exit code.
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { Manifest } from "@abaigram/stub";
import type { Credential } from "@arx-06/ai";
import { type AbaiConfig, abaiHome, FileCredentialStore, readConfig, writeConfig } from "./config.ts";
import { createModelSetup, FREETOKEN_PROVIDER_ID, ModelNotConfigured, resolveConfiguredModel } from "./model/index.ts";

export interface CliIo {
	out(text: string): void;
	err(text: string): void;
	env: NodeJS.ProcessEnv;
}

export const processIo: CliIo = {
	out: (text) => {
		process.stdout.write(text);
	},
	err: (text) => {
		process.stderr.write(`${text}\n`);
	},
	env: process.env,
};

export interface OnlineCheck {
	name: string;
	status: "ok" | "fail" | "skip";
	detail: string;
}

const CONFIG_USAGE = [
	"usage: abai config                               show the configuration",
	"       abai config set provider <anthropic|freetoken>",
	"       abai config set model <id>",
	"       abai config set key <provider>            store a credential, read without echo (or from a pipe)",
	"       abai config set key <provider> <api key>  the same, from the command line (lands in shell history)",
	"       abai config set url <provider> <base url>  freetoken's server, or a proxy for anthropic",
	"       abai config set connect-timeout <ms>",
	"       abai config unset key <provider>",
];

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function showConfig(io: CliIo): Promise<number> {
	const home = abaiHome(io.env);
	const config = readConfig(home);
	const credentials = await new FileCredentialStore(home).list();
	io.out(`home: ${home}\n`);
	io.out(`provider: ${config.provider ?? "(none)"}\n`);
	io.out(`model: ${config.model ?? "(none)"}\n`);
	io.out(`connect timeout: ${config.connectTimeoutMs} ms\n`);
	for (const [provider, settings] of Object.entries(config.providers ?? {})) {
		for (const [key, value] of Object.entries(settings)) io.out(`${provider}.${key}: ${value}\n`);
	}
	io.out(
		`credentials: ${credentials.length === 0 ? "(none)" : credentials.map((c) => `${c.providerId} (${c.type})`).join(", ")}\n`,
	);
	return 0;
}

/** A secret from the terminal without echo, or the first line of a pipe. */
async function readSecret(prompt: string): Promise<string | undefined> {
	const input = process.stdin;
	if (!input.isTTY) {
		const chunks: Buffer[] = [];
		for await (const chunk of input) chunks.push(Buffer.from(chunk));
		return Buffer.concat(chunks).toString("utf8").split("\n")[0]?.trim() || undefined;
	}
	process.stderr.write(prompt);
	const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
	const rl = createInterface({ input, output: muted, terminal: true });
	try {
		const line = await new Promise<string | undefined>((resolve) => {
			rl.once("close", () => resolve(undefined));
			rl.question("", (answer) => resolve(answer));
		});
		process.stderr.write("\n");
		return line?.trim() || undefined;
	} finally {
		rl.close();
	}
}

async function setConfig(args: string[], io: CliIo): Promise<number> {
	const home = abaiHome(io.env);
	const config = readConfig(home);
	const [what, a, b] = args;
	const update = (patch: Partial<AbaiConfig>): number => {
		writeConfig(home, { ...config, ...patch });
		return 0;
	};
	switch (what) {
		case "provider":
			if (!a) return usage(io, "set provider needs a name");
			return update({ provider: a });
		case "model":
			if (!a) return usage(io, "set model needs an id");
			return update({ model: a });
		case "connect-timeout": {
			const ms = Number(a);
			if (!Number.isInteger(ms) || ms <= 0)
				return usage(io, "set connect-timeout needs a positive number of milliseconds");
			return update({ connectTimeoutMs: ms });
		}
		case "url": {
			if (!a || !b) return usage(io, "set url takes: <provider> <base url>");
			const key = `${a.toUpperCase()}_BASE_URL`;
			const providers = { ...(config.providers ?? {}), [a]: { ...(config.providers?.[a] ?? {}), [key]: b } };
			return update({ providers });
		}
		case "key": {
			if (!a) return usage(io, "set key takes: <provider> [<api key>]");
			const key = b ?? (await readSecret(`API key for ${a}: `));
			if (!key) return usage(io, "no key given");
			const credential: Credential = { type: "api_key", key };
			await new FileCredentialStore(home).modify(a, async () => credential);
			io.out(`stored a credential for ${a} in ${home}\n`);
			return 0;
		}
		default:
			return usage(io, what === undefined ? "set needs a setting" : `unknown setting ${what}`);
	}
}

async function unsetConfig(args: string[], io: CliIo): Promise<number> {
	const [what, a] = args;
	if (what !== "key" || !a) return usage(io, "unset takes: key <provider>");
	await new FileCredentialStore(abaiHome(io.env)).delete(a);
	io.out(`removed the credential for ${a}\n`);
	return 0;
}

function usage(io: CliIo, problem?: string): number {
	if (problem !== undefined) io.err(`abai config: ${problem}`);
	for (const line of CONFIG_USAGE) io.err(line);
	return 2;
}

/** `abai config [show|set ...|unset ...]`. */
export async function runConfig(args: string[], io: CliIo = processIo): Promise<number> {
	try {
		switch (args[0]) {
			case undefined:
			case "show":
				return await showConfig(io);
			case "set":
				return await setConfig(args.slice(1), io);
			case "unset":
				return await unsetConfig(args.slice(1), io);
			default:
				return usage(io, `unknown subcommand ${args[0]}`);
		}
	} catch (error) {
		io.err(`abai config: ${errorMessage(error)}`);
		return 2;
	}
}

/** One cheap authenticated request to a static provider: the key and the endpoint are real. A dynamic provider was already reached. */
async function probe(
	setup: ReturnType<typeof createModelSetup>,
	provider: string,
	baseUrl: string,
	timeoutMs: number,
): Promise<OnlineCheck> {
	if (provider === FREETOKEN_PROVIDER_ID)
		return { name: "reachable", status: "ok", detail: "the FreeToken catalog was read" };
	if (provider !== "anthropic")
		return { name: "reachable", status: "skip", detail: `no reachability probe for ${provider}` };
	try {
		const auth = await setup.models.getAuth(provider);
		if (!auth) return { name: "reachable", status: "fail", detail: "no auth resolved" };
		const base = (auth.auth.baseUrl ?? baseUrl).replace(/\/$/, "");
		const headers: Record<string, string> = { "anthropic-version": "2023-06-01", ...(auth.auth.headers ?? {}) };
		if (auth.auth.apiKey && !headers.Authorization && !headers["x-api-key"]) headers["x-api-key"] = auth.auth.apiKey;
		const response = await fetch(`${base}/v1/models?limit=1`, { headers, signal: AbortSignal.timeout(timeoutMs) });
		if (response.ok) return { name: "reachable", status: "ok", detail: `${base} answered ${response.status}` };
		return {
			name: "reachable",
			status: "fail",
			detail: `${base} answered ${response.status} ${response.statusText}`,
		};
	} catch (error) {
		return { name: "reachable", status: "fail", detail: `${provider} could not be reached: ${errorMessage(error)}` };
	}
}

/**
 * The online half of `doctor` (section 4.4): the configured model is
 * reachable and meets the manifest's constraints. Network is used for a
 * dynamic provider's catalog and for one cheap authenticated request to a
 * static provider; no model call is made.
 */
export async function doctorOnline(manifest: Manifest, env: NodeJS.ProcessEnv = process.env): Promise<OnlineCheck[]> {
	const checks: OnlineCheck[] = [];
	const setup = createModelSetup(env);
	const { config } = setup;
	if (!config.provider || !config.model) {
		checks.push({
			name: "online",
			status: "fail",
			detail: `no model configured in ${setup.home} (run: abai config set provider|model)`,
		});
		return checks;
	}
	try {
		const resolved = await resolveConfiguredModel(setup, {
			allowNetwork: true,
			signal: AbortSignal.timeout(config.connectTimeoutMs),
		});
		checks.push({
			name: "online",
			status: "ok",
			detail: `${config.provider}/${resolved.model.id} is configured and resolves`,
		});
		checks.push(await probe(setup, resolved.model.provider, resolved.model.baseUrl, config.connectTimeoutMs));
	} catch (error) {
		checks.push({
			name: "online",
			status: "fail",
			detail:
				error instanceof ModelNotConfigured
					? error.message
					: `the model could not be resolved: ${errorMessage(error)}`,
		});
		return checks;
	}
	const constraints = manifest.model ?? {};
	if (constraints.tools === true) {
		checks.push({
			name: "model.tools",
			status: "skip",
			detail: "tool use is assumed for every provider the harness knows",
		});
	}
	return checks;
}
