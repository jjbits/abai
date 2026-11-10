// The harness's own verbs of the standard entry (abaigrammar section 4.4):
// `config` edits the machine-level configuration and `doctor`'s online
// half checks the model. The stub delegates these to the installed harness
// package; the sidecar binary offers them too. Never throws; resolves to
// the exit code.
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { Manifest } from "@abaigram/abai-stub";
import type { Credential } from "@arx-06/ai";
import { type AbaiConfig, abaiHome, FileCredentialStore, readConfig, writeConfig } from "./config.ts";
import { createModelSetup, FREETOKEN_PROVIDER_ID, ModelNotConfigured, resolveConfiguredModel } from "./model/index.ts";
import { AiipClient, type AiipStatus, KNOWN_AIIP_API } from "./net/client.ts";
import { ensureAiipDaemon, type SpawnFn, socketPathFor } from "./net/daemon.ts";
import { aiipBinaryFor, ENV_NET_DIR, ENV_NET_TOKEN, networkDirFor } from "./net/dir.ts";
import { membershipsOnDisk, type NetworkMembership, NO_BINARY, noMembership } from "./net/membership.ts";

/** What the entry tells `config`: the program it runs for, so `config net` finds its network directory; tests inject a spawn. */
export interface ConfigContext {
	program?: string;
	spawn?: SpawnFn;
}

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
	"       abai config set aiip-bin <path>            the aiip binary that runs this machine's network identities",
	"       abai config unset key <provider>",
	"       abai config unset aiip-bin",
	"       abai config net                           this program's network: the state dir, the daemon, the memberships",
	"       abai config net join --token <blob|->      join a network with an invite (- reads it from stdin, keeping it out of argv)",
	"       abai config net leave <net>               leave a network, by name or id (local; the authority is not told)",
	"       abai config net create <name> --as <member> [--lighthouse]  create a network, this run as its authority",
	"       abai config net invite <net> --for <member>  mint an invite for a new member (authority only); prints the token alone",
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
	io.out(`aiip: ${config.aiip?.bin ?? "(aiip on the PATH)"}\n`);
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
		case "aiip-bin":
			if (!a) return usage(io, "set aiip-bin needs a path");
			return update({ aiip: { bin: a } });
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
	if (what === "aiip-bin") {
		const home = abaiHome(io.env);
		const { aiip: _aiip, ...rest } = readConfig(home);
		writeConfig(home, rest);
		io.out("aiip is aiip on the PATH again\n");
		return 0;
	}
	if (what !== "key" || !a) return usage(io, "unset takes: key <provider>, or aiip-bin");
	await new FileCredentialStore(abaiHome(io.env)).delete(a);
	io.out(`removed the credential for ${a}\n`);
	return 0;
}

function usage(io: CliIo, problem?: string): number {
	if (problem !== undefined) io.err(`abai config: ${problem}`);
	for (const line of CONFIG_USAGE) io.err(line);
	return 2;
}

/** `abai config [show|set ...|unset ...|net ...]`. */
export async function runConfig(args: string[], io: CliIo = processIo, context: ConfigContext = {}): Promise<number> {
	try {
		switch (args[0]) {
			case undefined:
			case "show":
				return await showConfig(io);
			case "set":
				return await setConfig(args.slice(1), io);
			case "unset":
				return await unsetConfig(args.slice(1), io);
			case "net":
				return await netConfig(args.slice(1), io, context);
			default:
				return usage(io, `unknown subcommand ${args[0]}`);
		}
	} catch (error) {
		io.err(`abai config: ${errorMessage(error)}`);
		return 2;
	}
}

// ---------------------------------------------------------------------------
// The network (abaigrammar section 7, `network`): this program's identity on
// an aiip network, kept in a state directory of its own.
// ---------------------------------------------------------------------------

/** The value after `name`; undefined when the flag is absent, empty when it has no value (a value never starts with `--`). */
function flag(args: string[], name: string): string | undefined {
	const at = args.indexOf(name);
	if (at < 0) return undefined;
	const value = args[at + 1];
	return value === undefined || value.startsWith("--") ? "" : value;
}

/**
 * Run one operation against the directory's daemon, started when none answers. A daemon started in a
 * directory the run owns (`ABAI_NET_DIR`) is ended after; one in the shared per-program directory stays, as
 * the aiip CLI leaves its daemons, so a program running beside this command keeps its network.
 */
async function withDaemon(
	dir: string,
	io: CliIo,
	context: ConfigContext,
	operation: (client: AiipClient) => Promise<void>,
): Promise<number> {
	const bin = aiipBinaryFor(io.env, readConfig(abaiHome(io.env)));
	if (bin === undefined) {
		io.err(`abai config net: ${NO_BINARY}`);
		return 1;
	}
	let daemon: Awaited<ReturnType<typeof ensureAiipDaemon>>;
	try {
		daemon = await ensureAiipDaemon(dir, { bin, spawn: context.spawn, env: io.env });
	} catch (error) {
		io.err(`abai config net: ${errorMessage(error)}`);
		return 1;
	}
	try {
		await operation(daemon.client);
		return 0;
	} catch (error) {
		io.err(`abai config net: ${errorMessage(error)}`);
		return 1;
	} finally {
		if (io.env[ENV_NET_DIR]?.trim()) await daemon.stop();
	}
}

async function daemonStatus(dir: string): Promise<{ socket: string; status: AiipStatus | undefined }> {
	const socket = socketPathFor(dir);
	try {
		return { socket, status: await new AiipClient(socket).status() };
	} catch {
		return { socket, status: undefined };
	}
}

function membershipLine(m: NetworkMembership): string {
	return `  ${m.member} on ${m.network} (${m.addr})${m.authority ? ", authority" : ""}`;
}

async function showNet(dir: string, io: CliIo): Promise<number> {
	try {
		return await showNetOrThrow(dir, io);
	} catch (error) {
		io.err(`abai config net: ${errorMessage(error)}`);
		return 1;
	}
}

async function showNetOrThrow(dir: string, io: CliIo): Promise<number> {
	const config = readConfig(abaiHome(io.env));
	io.out(`network dir: ${dir}\n`);
	io.out(`aiip: ${aiipBinaryFor(io.env, config) ?? "(none found)"}\n`);
	const { socket, status } = await daemonStatus(dir);
	let memberships: NetworkMembership[];
	if (status) {
		io.out(`daemon: running (${status.version}, pid ${status.pid}) at ${socket}\n`);
		memberships = (await new AiipClient(socket).networks()).map((m) => ({
			network: m.networkName,
			id: m.networkID,
			member: m.selfName,
			addr: m.selfAddr,
			authority: m.authority,
			peers: m.peers,
		}));
	} else {
		io.out("daemon: not running (it starts with the harness)\n");
		memberships = membershipsOnDisk(dir);
	}
	io.out(
		memberships.length === 0
			? "memberships: (none)\n"
			: `memberships:\n${memberships.map(membershipLine).join("\n")}\n`,
	);
	return 0;
}

/** `abai config net [show|join|leave|create|invite]`. */
async function netConfig(args: string[], io: CliIo, context: ConfigContext): Promise<number> {
	let dir: string | undefined;
	try {
		dir = networkDirFor(io.env, context.program);
	} catch (error) {
		io.err(`abai config net: ${errorMessage(error)}`);
		return 1;
	}
	if (dir === undefined) {
		return usage(io, `config net needs the program (run it as <prog> abai config net ...) or ${ENV_NET_DIR}`);
	}
	const [what, ...rest] = args;
	switch (what) {
		case undefined:
		case "show":
			return await showNet(dir, io);
		case "join": {
			let token = flag(rest, "--token");
			if (token === undefined || token === "") return usage(io, "net join takes: --token <blob|->");
			if (token === "-") token = await readSecret("Invite token: ");
			if (!token) return usage(io, "no token given");
			const blob = token;
			return await withDaemon(dir, io, context, async (client) => {
				const m = await client.join(blob);
				io.out(`joined ${m.networkName} as ${m.selfName} (${m.selfAddr})\n`);
			});
		}
		case "leave": {
			const net = rest[0];
			if (!net) return usage(io, "net leave takes: <net>");
			return await withDaemon(dir, io, context, async (client) => {
				await client.leave(net);
				io.out(`left ${net}\n`);
			});
		}
		case "create": {
			const name = rest[0];
			const as = flag(rest, "--as");
			if (!name || name.startsWith("--") || !as)
				return usage(io, "net create takes: <name> --as <member> [--lighthouse]");
			const lighthouse = rest.includes("--lighthouse");
			return await withDaemon(dir, io, context, async (client) => {
				const m = await client.create({ name, as, lighthouse });
				io.out(
					`created ${m.networkName} as ${m.selfName} (${m.selfAddr}), the authority${m.lighthouse ? " and lighthouse" : ""}\n`,
				);
			});
		}
		case "invite": {
			const net = rest[0];
			const forName = flag(rest, "--for");
			if (!net || net.startsWith("--") || !forName) return usage(io, "net invite takes: <net> --for <member>");
			return await withDaemon(dir, io, context, async (client) => {
				const invite = await client.invite(net, forName);
				// the token alone on stdout, so it can be piped; what it is on stderr
				io.out(`${invite.token}\n`);
				io.err(
					`invite for ${invite.name} (${invite.addr}) on ${net}: a bearer secret, hand it to that member's run as ${ENV_NET_TOKEN}`,
				);
			});
		}
		default:
			return usage(io, `unknown net subcommand ${what}`);
	}
}

/** The network's checks for `doctor`: the binary, the daemon, the memberships. Never starts a daemon; silent when no network is declared or configured. */
async function networkChecks(manifest: Manifest, env: NodeJS.ProcessEnv): Promise<OnlineCheck[]> {
	const checks: OnlineCheck[] = [];
	const declared = manifest.network;
	const required = declared?.required === true;
	const configured = Boolean(env[ENV_NET_DIR]?.trim() || env[ENV_NET_TOKEN]?.trim());
	// a program with no network and a run with none configured: nothing to check, and nothing to say
	if (declared === undefined && !configured) return checks;
	// a problem with a network the program does not require is a skip, never a fail
	const problem = required ? "fail" : "skip";
	const bin = aiipBinaryFor(env, readConfig(abaiHome(env)));
	checks.push(
		bin === undefined
			? { name: "aiip.binary", status: problem, detail: NO_BINARY }
			: { name: "aiip.binary", status: "ok", detail: bin },
	);
	let dir: string | undefined;
	try {
		dir = networkDirFor(env, manifest.name);
	} catch (error) {
		checks.push({ name: "aiip.daemon", status: problem, detail: errorMessage(error) });
		return checks;
	}
	if (dir === undefined) {
		checks.push({ name: "aiip.daemon", status: "skip", detail: `no program named and ${ENV_NET_DIR} unset` });
		return checks;
	}
	let probe: { socket: string; status: AiipStatus | undefined };
	try {
		probe = await daemonStatus(dir);
	} catch (error) {
		checks.push({ name: "aiip.daemon", status: problem, detail: errorMessage(error) });
		return checks;
	}
	let memberships: NetworkMembership[];
	if (probe.status) {
		if (!probe.status.version.startsWith("aiip-")) {
			checks.push({
				name: "aiip.daemon",
				status: problem,
				detail: `what answers at ${probe.socket} is not aiipd (version ${JSON.stringify(probe.status.version)})`,
			});
			return checks;
		}
		const skew = probe.status.version === KNOWN_AIIP_API ? "" : ` (this harness knows ${KNOWN_AIIP_API})`;
		checks.push({ name: "aiip.daemon", status: "ok", detail: `${probe.status.version} at ${probe.socket}${skew}` });
		try {
			memberships = (await new AiipClient(probe.socket).networks()).map((m) => ({
				network: m.networkName,
				id: m.networkID,
				member: m.selfName,
				addr: m.selfAddr,
				authority: m.authority,
				peers: m.peers,
			}));
		} catch (error) {
			checks.push({
				name: "aiip.network",
				status: problem,
				detail: `memberships could not be listed: ${errorMessage(error)}`,
			});
			return checks;
		}
	} else {
		checks.push({
			name: "aiip.daemon",
			status: "skip",
			detail: `not running at ${dir} (it starts with the harness)`,
		});
		memberships = membershipsOnDisk(dir);
	}
	checks.push(
		memberships.length === 0
			? { name: "aiip.network", status: problem, detail: noMembership(dir) }
			: {
					name: "aiip.network",
					status: "ok",
					detail: memberships.map((m) => `${m.member} on ${m.network}`).join(", "),
				},
	);
	return checks;
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
	return [...(await modelChecks(manifest, env)), ...(await networkChecks(manifest, env))];
}

/** The model's checks: configured, resolves, its endpoint answers, the manifest's constraints. */
async function modelChecks(manifest: Manifest, env: NodeJS.ProcessEnv): Promise<OnlineCheck[]> {
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
