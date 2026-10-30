// The in-process entry the stub reaches by dynamic import (abaigrammar
// section 4.3, "finding the in-process harness"): a program that installs
// the stub and this package needs no wiring. `attachEmbedded` builds the
// harness over the direct transport and the session form over the agent
// loop, with the model from the machine configuration unless the caller
// supplies one. Attaching fails at once, without contacting any model,
// when none is configured (section 4.3).
import type { HarnessBinding } from "@abaigram/abai-stub";
import { type AgentModel, SessionForm } from "./agent.ts";
import { abaiHome, readConfig } from "./config.ts";
import { Harness } from "./harness.ts";
import { serveMcp } from "./mcp.ts";
import { createModelSetup, resolveConfiguredModel } from "./model/index.ts";
import { defaultOptions, type HarnessOptions } from "./options.ts";
import { terminalChannel } from "./terminal-channel.ts";
import { DirectTransport } from "./transport-direct.ts";
import type { UserChannel } from "./user-channel.ts";

export interface EmbeddedOptions {
	model?: AgentModel;
	/** The person's channel; default: the terminal when stdin is a TTY, else none. */
	channel?: UserChannel | null;
	harness?: Partial<HarnessOptions>;
	addendum?: string;
	env?: NodeJS.ProcessEnv;
	/** How long the first contact with the model may take; default the machine configuration's (a long first prompt needs more). */
	connectTimeoutMs?: number;
}

export interface Embedded {
	harness: Harness;
	form: SessionForm;
}

/**
 * `<prog> abai mcp` in-process: the harness over the direct transport, served
 * to the MCP client on this process's stdin and stdout. No model: the client's
 * agent is the program's. Resolves to the exit code when the client goes.
 */
export async function serveMcpEmbedded(binding: HarnessBinding): Promise<number> {
	const harness = new Harness(defaultOptions("mcp"));
	await harness.attach(new DirectTransport(binding));
	return serveMcp(harness);
}

/** Attach the embedded harness to a program's binding. Throws, attaching nothing, when there is no model. */
export async function attachEmbedded(binding: HarnessBinding, options: EmbeddedOptions = {}): Promise<Embedded> {
	const env = options.env ?? process.env;
	let model = options.model;
	let connectTimeoutMs = readConfig(abaiHome(env)).connectTimeoutMs;
	if (!model) {
		const setup = createModelSetup(env);
		connectTimeoutMs = setup.config.connectTimeoutMs;
		model = await resolveConfiguredModel(setup, {
			allowNetwork: true,
			signal: AbortSignal.timeout(connectTimeoutMs),
		});
	}
	if (options.connectTimeoutMs !== undefined) connectTimeoutMs = Math.max(connectTimeoutMs, options.connectTimeoutMs);
	const harness = new Harness(defaultOptions("session", options.harness ?? {}));
	await harness.attach(new DirectTransport(binding));
	try {
		// the terminal is the person's channel on a TTY; ABAI_CHANNEL=terminal|none overrides (a piped hand check, a daemon)
		const wanted = env.ABAI_CHANNEL?.trim();
		const useTerminal = wanted === "terminal" ? true : wanted === "none" ? false : process.stdin.isTTY === true;
		const channel =
			options.channel === undefined ? (useTerminal ? terminalChannel() : undefined) : (options.channel ?? undefined);
		const form = new SessionForm({ harness, model, channel, addendum: options.addendum, connectTimeoutMs });
		// when the program detaches the harness (a timeout, a close), the form and its channel go with it
		harness.onDetach = (reason) => form.shutdown(reason);
		return { harness, form };
	} catch (error) {
		harness.shutdown(error instanceof Error ? error.message : String(error));
		throw error;
	}
}
