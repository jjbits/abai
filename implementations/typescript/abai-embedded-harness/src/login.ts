// The login verb's terminal side (abaigrammar section 9): the library runs
// a provider's own sign-in and stores what it returns; this module answers
// the flow's prompts from the terminal and shows its events. A URL is
// printed, and handed to the browser only when the person asked
// (`--browser`): abaigrams often run on boxes with no desktop, and a
// provider's URL is its own to choose. Only http(s) URLs are ever shown
// or opened, normalized; provider text loses its control characters.
// Nothing here knows a provider.
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { AuthInteraction, AuthPrompt } from "@arx-06/ai";
import type { CliIo } from "./cli.ts";

/** What a login needs from the terminal; tests script one. */
export interface LoginTerminal {
	/** A person is at the other end; a pipe cannot answer a sign-in. */
	readonly isTTY: boolean;
	/** One line, echoed. Rejects when `signal` aborts or the input ends. */
	question(prompt: string, signal: AbortSignal): Promise<string>;
	/** One line, not echoed. */
	secret(prompt: string, signal: AbortSignal): Promise<string>;
	/** Hand an http(s) URL to the platform's opener; rejects when it could not start. */
	open(url: string): Promise<void>;
}

export interface InteractionOptions {
	io: CliIo;
	terminal: LoginTerminal;
	/** Cancels the whole login. */
	signal: AbortSignal;
	/** Also hand sign-in URLs to the browser. */
	browser: boolean;
}

export const NOT_HTTP_URL = "(the provider gave a URL that is not http or https)";

/** The http(s) URL `value` names, normalized (control characters percent-encoded or dropped), else undefined. */
export function httpUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/** Provider text for the terminal: control characters removed. */
export function clean(text: unknown): string {
	return String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, "");
}

/** The flow's prompts answered from the terminal, its events shown there. */
export function terminalInteraction(options: InteractionOptions): AuthInteraction {
	const { io, terminal, signal, browser } = options;
	const show = (url: unknown): string => httpUrl(url) ?? NOT_HTTP_URL;
	const openIfAsked = (url: unknown): void => {
		const target = httpUrl(url);
		if (!browser || target === undefined) return;
		void terminal.open(target).catch((error: unknown) => {
			io.err(`abai config: the browser could not be opened: ${errorMessage(error)}`);
		});
	};

	async function select(prompt: Extract<AuthPrompt, { type: "select" }>, promptSignal: AbortSignal): Promise<string> {
		io.err(clean(prompt.message));
		prompt.options.forEach((option, index) => {
			const description = option.description ? `: ${clean(option.description)}` : "";
			io.err(`  ${index + 1}. ${clean(option.label)}${description}`);
		});
		for (let attempt = 0; attempt < 3; attempt++) {
			const answer = (await terminal.question(`choice [1-${prompt.options.length}]: `, promptSignal)).trim();
			const byNumber = /^\d+$/.test(answer) ? prompt.options[Number(answer) - 1] : undefined;
			if (byNumber) return byNumber.id;
			const byId = prompt.options.find((option) => option.id === answer);
			if (byId) return byId.id;
			io.err(`not a choice: ${clean(answer)}`);
		}
		throw new Error("no choice made");
	}

	return {
		signal,
		async prompt(prompt) {
			// a flow may settle a step another way (its callback server heard the browser) and cancel just this prompt
			const promptSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
			if (prompt.type === "select") return select(prompt, promptSignal);
			const placeholder = prompt.placeholder ? ` (${clean(prompt.placeholder)})` : "";
			const text = `${clean(prompt.message)}${placeholder}: `;
			const answer =
				prompt.type === "secret"
					? await terminal.secret(text, promptSignal)
					: await terminal.question(text, promptSignal);
			return answer.trim();
		},
		notify(event) {
			switch (event.type) {
				case "auth_url":
					io.err("open this URL to sign in:");
					io.err(`  ${show(event.url)}`);
					if (event.instructions) io.err(clean(event.instructions));
					openIfAsked(event.url);
					break;
				case "device_code":
					io.err(`open ${show(event.verificationUri)} and enter the code ${clean(event.userCode)}`);
					io.err("waiting for the sign-in to complete");
					openIfAsked(event.verificationUri);
					break;
				case "info":
					io.err(clean(event.message));
					for (const link of event.links ?? []) {
						io.err(`  ${link.label ? `${clean(link.label)}: ` : ""}${show(link.url)}`);
					}
					break;
				default:
					io.err(clean(event.message));
			}
		},
	};
}

/**
 * The process's terminal: stdin for answers, stderr for prompts, the
 * platform's opener for URLs. `cancel` is called for Ctrl+C or the end of
 * input while a prompt is open; the caller cancels the login with it.
 */
export function processTerminal(cancel: () => void): LoginTerminal {
	const streams = { input: process.stdin, output: process.stderr };
	return {
		isTTY: process.stdin.isTTY === true,
		question: (prompt, signal) => readLine({ ...streams, prompt, signal, muted: false, cancel }),
		secret: (prompt, signal) => readLine({ ...streams, prompt, signal, muted: true, cancel }),
		open: (url) => openUrl(url),
	};
}

export interface ReadLineOptions {
	input: NodeJS.ReadableStream;
	output: NodeJS.WritableStream;
	prompt: string;
	/** Aborting rejects the read: the login's cancel, or a step the flow settled another way. */
	signal: AbortSignal;
	/** No echo: the prompt is written once and the answer stays off the screen. */
	muted: boolean;
	/** Ctrl+C or the end of input while the prompt is open. */
	cancel: () => void;
}

/**
 * One line from a terminal through readline, which owns the line editing
 * (and, on a TTY, raw mode: Ctrl+C reaches readline, not the process, so
 * it is forwarded as `cancel`). Resolves with the answer, rejects when the
 * signal aborts or the input ends; a prompt left open gets its newline so
 * the next line starts clean.
 */
export function readLine(options: ReadLineOptions): Promise<string> {
	const { input, output, prompt, signal, muted, cancel } = options;
	const rl = createInterface({
		input,
		output: muted ? new Writable({ write: (_chunk, _encoding, done) => done() }) : output,
		terminal: true,
	});
	if (muted) output.write(prompt);
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			rl.close();
			fn();
		};
		const onAbort = (): void => {
			output.write("\n");
			finish(() => reject(signal.reason ?? new Error("login cancelled")));
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		rl.on("SIGINT", cancel);
		rl.once("close", () => {
			if (settled) return;
			cancel();
			output.write("\n");
			finish(() => reject(new Error("the terminal closed")));
		});
		rl.question(muted ? "" : prompt, (answer) => {
			if (muted) output.write("\n");
			finish(() => resolve(answer));
		});
	});
}

/**
 * The platform's URL opener as argv, no shell: cmd.exe would read a query's
 * `&` as a command separator, so Windows gets rundll32's protocol handler.
 */
export function openerFor(platform: NodeJS.Platform, url: string): [string, string[]] {
	if (platform === "darwin") return ["open", [url]];
	if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
	return ["xdg-open", [url]];
}

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** The opener started detached; resolves once it started, rejects when it could not (no `xdg-open`, say). */
export function openUrl(
	url: string,
	spawnFn: SpawnFn = spawn,
	platform: NodeJS.Platform = process.platform,
): Promise<void> {
	const [command, args] = openerFor(platform, url);
	return new Promise((resolve, reject) => {
		// cwd "/": on WSL xdg-open starts explorer.exe, which fails on a long \\wsl.localhost cwd; a URL needs no cwd
		const child = spawnFn(command, args, { stdio: "ignore", detached: true, cwd: "/" });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
