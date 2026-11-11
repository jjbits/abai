// `abai config login` against scripted providers and a scripted terminal:
// the library's flow asks and tells, the verb answers from the terminal and
// shows only what is safe to show. The real readline path is driven over
// in-memory streams.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ApiKeyCredential, LoginOptions, OAuthCredential, Provider, ProviderAuthInteraction } from "@arx-06/ai";
import { afterEach, describe, expect, test } from "vitest";
import { type CliIo, type ConfigContext, runConfig } from "../src/cli.ts";
import { CREDENTIALS_FILE, FileCredentialStore, readConfig, writeConfig } from "../src/config.ts";
import { clean, httpUrl, type LoginTerminal, NOT_HTTP_URL, openerFor, openUrl, readLine } from "../src/login.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
	const dir = mkdtempSync(`${tmpdir()}/abai-login-`);
	dirs.push(dir);
	return dir;
}

function capture(dir: string) {
	const out: string[] = [];
	const err: string[] = [];
	const cli: CliIo = { out: (t) => out.push(t), err: (t) => err.push(t), env: { ABAI_HOME: dir } };
	return { cli, out, err };
}

/** The answer that makes the scripted terminal wait until its prompt's signal aborts. */
const WAIT = "<wait for the signal>";

/** A terminal that answers from a script, honors its signal, and records what it was asked and told to open. */
function scriptedTerminal(answers: string[], isTTY = true) {
	const prompts: string[] = [];
	const secrets: string[] = [];
	const opened: string[] = [];
	const aborted: string[] = [];
	const next = (signal: AbortSignal): Promise<string> => {
		const answer = answers.shift();
		if (answer === undefined) throw new Error("no answer scripted");
		if (answer !== WAIT) return Promise.resolve(answer);
		return new Promise((_resolve, reject) => {
			signal.addEventListener(
				"abort",
				() => {
					aborted.push(String((signal.reason as Error).message));
					reject(signal.reason);
				},
				{ once: true },
			);
		});
	};
	const terminal: LoginTerminal = {
		isTTY,
		question: (prompt, signal) => {
			prompts.push(prompt);
			return next(signal);
		},
		secret: (prompt, signal) => {
			secrets.push(prompt);
			return next(signal);
		},
		open: async (url) => {
			opened.push(url);
		},
	};
	return { terminal, prompts, secrets, opened, aborted };
}

type OAuthFlow = (interaction: ProviderAuthInteraction, options?: LoginOptions) => Promise<OAuthCredential>;
type KeyFlow = (interaction: ProviderAuthInteraction) => Promise<ApiKeyCredential>;

const oauthCredential = (access = "access-token"): OAuthCredential => ({
	type: "oauth",
	access,
	refresh: "refresh-token",
	expires: Date.now() + 3_600_000,
});

/** A provider with the logins given: an account flow, a key flow, or an ambient key method without a login. */
function scripted(flows: { oauth?: OAuthFlow; key?: KeyFlow; ambient?: string }, id = "scripted"): Provider {
	const provider = {
		id,
		name: "Scripted Cloud",
		auth: {
			...(flows.oauth
				? {
						oauth: {
							name: "Scripted (account)",
							login: flows.oauth,
							refresh: async (credential: OAuthCredential) => credential,
							toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
						},
					}
				: {}),
			...(flows.key
				? {
						apiKey: {
							name: "Scripted API key",
							login: flows.key,
							resolve: async () => undefined,
						},
					}
				: flows.ambient
					? { apiKey: { name: flows.ambient, resolve: async () => undefined } }
					: {}),
		},
		getModels: () => [],
	};
	return provider as unknown as Provider;
}

function context(providers: Provider[], terminal: LoginTerminal, signal?: AbortSignal): ConfigContext {
	return { providers, terminal, signal: signal ?? new AbortController().signal };
}

describe("abai config login", () => {
	test("an account sign-in: the URL is printed, the code answered, the credential stored, the next step named", async () => {
		const dir = home();
		const { cli, out, err } = capture(dir);
		const { terminal, prompts, opened } = scriptedTerminal(["  THE-CODE "]);
		let codeSeen = "";
		const provider = scripted({
			oauth: async (interaction) => {
				interaction.notify({
					type: "info",
					message: "Signing in to Scripted",
					links: [{ url: "https://docs.example/", label: "docs" }],
				});
				interaction.notify({
					type: "auth_url",
					url: "https://auth.example/start?x=1",
					instructions: "Approve, then paste the code.",
				});
				codeSeen = await interaction.prompt({
					type: "manual_code",
					message: "Paste the code",
					placeholder: "xxxx",
				});
				interaction.notify({ type: "progress", message: "Exchanging the code" });
				return oauthCredential();
			},
		});
		expect(await runConfig(["login", "scripted"], cli, context([provider], terminal))).toBe(0);
		expect(codeSeen).toBe("THE-CODE");
		expect(prompts).toEqual(["Paste the code (xxxx): "]);
		expect(opened).toEqual([]);
		expect(err).toEqual([
			"Signing in to Scripted",
			"  docs: https://docs.example/",
			"open this URL to sign in:",
			"  https://auth.example/start?x=1",
			"Approve, then paste the code.",
			"Exchanging the code",
		]);
		expect(out.join("")).toBe(
			`signed in to Scripted Cloud; credential in ${join(dir, CREDENTIALS_FILE)}\nto use it: abai config set provider scripted\n`,
		);
		expect(await new FileCredentialStore(dir).read("scripted")).toMatchObject({
			type: "oauth",
			access: "access-token",
		});
	});

	test("no next step when the provider is already the configured one", async () => {
		const dir = home();
		writeConfig(dir, { provider: "scripted", model: "m", connectTimeoutMs: 1000 });
		const { cli, out } = capture(dir);
		const provider = scripted({ oauth: async () => oauthCredential() });
		expect(await runConfig(["login", "scripted"], cli, context([provider], scriptedTerminal([]).terminal))).toBe(0);
		expect(out.join("")).not.toContain("to use it");
	});

	test("a step the flow settles another way cancels only that prompt, not the login", async () => {
		const dir = home();
		const { cli } = capture(dir);
		const { terminal, aborted } = scriptedTerminal([WAIT, "second"]);
		let seen = "";
		const provider = scripted({
			oauth: async (interaction) => {
				const step = new AbortController();
				const pasted = interaction.prompt({
					type: "manual_code",
					message: "Paste the redirect URL",
					signal: step.signal,
				});
				setTimeout(() => step.abort(new Error("the callback heard the browser")), 0);
				await expect(pasted).rejects.toThrow("the callback heard the browser");
				seen = await interaction.prompt({ type: "text", message: "One more thing" });
				return oauthCredential();
			},
		});
		expect(await runConfig(["login", "scripted"], cli, context([provider], terminal))).toBe(0);
		expect(aborted).toEqual(["the callback heard the browser"]);
		expect(seen).toBe("second");
		expect(await new FileCredentialStore(dir).read("scripted")).toMatchObject({ type: "oauth" });
	});

	test("a select prompt is answered by number or by id, a wrong answer asked again", async () => {
		const dir = home();
		const { cli, err } = capture(dir);
		const { terminal, prompts } = scriptedTerminal(["nope", "2", "alpha"]);
		const chosen: string[] = [];
		const provider = scripted({
			oauth: async (interaction) => {
				const options = [
					{ id: "alpha", label: "Browser sign-in", description: "opens a page" },
					{ id: "beta", label: "Paste a token" },
				];
				chosen.push(await interaction.prompt({ type: "select", message: "How do you want to sign in?", options }));
				chosen.push(await interaction.prompt({ type: "select", message: "Again?", options }));
				return oauthCredential();
			},
		});
		expect(await runConfig(["login", "scripted"], cli, context([provider], terminal))).toBe(0);
		expect(chosen).toEqual(["beta", "alpha"]);
		expect(prompts).toEqual(["choice [1-2]: ", "choice [1-2]: ", "choice [1-2]: "]);
		expect(err.slice(0, 4)).toEqual([
			"How do you want to sign in?",
			"  1. Browser sign-in: opens a page",
			"  2. Paste a token",
			"not a choice: nope",
		]);
	});

	test("--api-key on a provider with both logins stores a key through the secret prompt, trimmed", async () => {
		const dir = home();
		const { cli, out } = capture(dir);
		const { terminal, secrets } = scriptedTerminal([" sk-scripted\t"]);
		const provider = scripted({
			oauth: async () => {
				throw new Error("the account flow must not run");
			},
			key: async (interaction) => ({
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "API key" }),
			}),
		});
		expect(await runConfig(["login", "scripted", "--api-key"], cli, context([provider], terminal))).toBe(0);
		expect(secrets).toEqual(["API key: "]);
		expect(out.join("")).toContain("stored a key for Scripted Cloud");
		expect(await new FileCredentialStore(dir).read("scripted")).toEqual({ type: "api_key", key: "sk-scripted" });
	});

	test("a provider with only a key login gets it without --api-key", async () => {
		const dir = home();
		const { cli } = capture(dir);
		const provider = scripted({ key: async () => ({ type: "api_key", key: "k" }) });
		expect(await runConfig(["login", "scripted"], cli, context([provider], scriptedTerminal([]).terminal))).toBe(0);
		expect(await new FileCredentialStore(dir).read("scripted")).toEqual({ type: "api_key", key: "k" });
	});

	test("refusals: no such login, no provider, no terminal, bad arguments", async () => {
		const dir = home();
		const { cli, err } = capture(dir);
		const tty = scriptedTerminal([]).terminal;
		const oauthOnly = scripted({ oauth: async () => oauthCredential() }, "account-only");
		const ambient = scripted({ ambient: "AWS credentials" }, "ambient");
		expect(await runConfig(["login", "account-only", "--api-key"], cli, context([oauthOnly, ambient], tty))).toBe(2);
		expect(err.at(-1)).toBe("abai config: Scripted Cloud has no API key login; omit --api-key to sign in");
		expect(await runConfig(["login", "ambient"], cli, context([oauthOnly, ambient], tty))).toBe(2);
		expect(err.at(-1)).toBe("abai config: Scripted Cloud is configured outside abai (AWS credentials)");
		expect(await runConfig(["login", "nope"], cli, context([], tty))).toBe(2);
		expect(err.at(-1)).toBe("abai config: no provider nope; config providers lists them");
		const pipe = scriptedTerminal([], false).terminal;
		expect(await runConfig(["login", "account-only"], cli, context([oauthOnly], pipe))).toBe(2);
		expect(err.at(-1)).toBe("abai config: login needs a terminal; a key can be piped to config set key");
		expect(await runConfig(["login"], cli, context([], tty))).toBe(2);
		expect(err.join("\n")).toContain("login needs a provider");
		expect(await runConfig(["login", "a", "b"], cli, context([], tty))).toBe(2);
		expect(await runConfig(["login", "--nope", "a"], cli, context([], tty))).toBe(2);
		expect(err.join("\n")).toContain("login takes: <provider> [--api-key] [--browser]");
		expect(await new FileCredentialStore(dir).list()).toEqual([]);
	});

	test("URLs: only http(s) is shown or opened, normalized; --browser opens each once; provider text loses control characters", async () => {
		const dir = home();
		const { cli, err } = capture(dir);
		const { terminal, opened } = scriptedTerminal([]);
		const provider = scripted({
			oauth: async (interaction) => {
				interaction.notify({ type: "auth_url", url: "file:///etc/passwd" });
				interaction.notify({ type: "auth_url", url: "javascript:alert(1)" });
				interaction.notify({ type: "auth_url", url: "HTTPS://Auth.Example/a b\u001b[31m?q=1" });
				interaction.notify({
					type: "device_code",
					userCode: "ABCD\u0007-1234",
					verificationUri: "https://device.example/",
				});
				interaction.notify({ type: "info", message: "done\u001b[0m" });
				return oauthCredential();
			},
		});
		expect(await runConfig(["login", "scripted", "--browser"], cli, context([provider], terminal))).toBe(0);
		expect(err).toEqual([
			"open this URL to sign in:",
			`  ${NOT_HTTP_URL}`,
			"open this URL to sign in:",
			`  ${NOT_HTTP_URL}`,
			"open this URL to sign in:",
			"  https://auth.example/a%20b%1B[31m?q=1",
			"open https://device.example/ and enter the code ABCD-1234",
			"waiting for the sign-in to complete",
			"done[0m",
		]);
		expect(opened).toEqual(["https://auth.example/a%20b%1B[31m?q=1", "https://device.example/"]);
		expect(err.join("\n")).not.toContain("file:");
		expect(err.join("\n")).not.toContain("javascript:");
	});

	test("without --browser nothing is opened, and an opener that fails is one line, not a failed login", async () => {
		const dir = home();
		const { cli, err } = capture(dir);
		const quiet = scriptedTerminal([]);
		const provider = scripted({
			oauth: async (interaction) => {
				interaction.notify({ type: "auth_url", url: "https://auth.example/" });
				return oauthCredential();
			},
		});
		expect(await runConfig(["login", "scripted"], cli, context([provider], quiet.terminal))).toBe(0);
		expect(quiet.opened).toEqual([]);
		const failing: LoginTerminal = {
			...quiet.terminal,
			open: async () => {
				throw new Error("no opener here");
			},
		};
		err.length = 0;
		expect(await runConfig(["login", "scripted", "--browser"], cli, context([provider], failing))).toBe(0);
		await new Promise((done) => setTimeout(done, 0));
		expect(err).toContain("abai config: the browser could not be opened: no opener here");
	});

	test("the device id is made once, kept in the configuration and handed to every login", async () => {
		const dir = home();
		const { cli } = capture(dir);
		const seen: string[] = [];
		const provider = scripted({
			oauth: async (_interaction, options) => {
				seen.push(options?.getDeviceId?.() ?? "none");
				seen.push(options?.getDeviceId?.() ?? "none");
				return oauthCredential(options?.agentName ?? "no-name");
			},
		});
		const tty = scriptedTerminal([]).terminal;
		expect(await runConfig(["login", "scripted"], cli, context([provider], tty))).toBe(0);
		expect(await runConfig(["login", "scripted"], cli, context([provider], tty))).toBe(0);
		expect(seen).toHaveLength(4);
		expect(new Set(seen).size).toBe(1);
		expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(readConfig(dir).deviceId).toBe(seen[0]);
		expect(await new FileCredentialStore(dir).read("scripted")).toMatchObject({ access: "abai" });
	});

	test("a failing flow is one cleaned line and exit 1; a cancelled one says so", async () => {
		const dir = home();
		const { cli, err } = capture(dir);
		const tty = scriptedTerminal([]).terminal;
		const failing = scripted({
			oauth: async () => {
				throw new Error("the provider said no\u001b[31m body=<html>\nstack=at somewhere\nmore");
			},
		});
		expect(await runConfig(["login", "scripted"], cli, context([failing], tty))).toBe(1);
		expect(err.at(-1)).toBe("abai config: could not sign in to Scripted Cloud: the provider said no[31m body=<html>");
		const cancelled = new AbortController();
		cancelled.abort(new Error("login cancelled"));
		const never = scripted({ oauth: async () => oauthCredential() });
		expect(await runConfig(["login", "scripted"], cli, context([never], tty, cancelled.signal))).toBe(1);
		expect(err.at(-1)).toBe("abai config: login cancelled");
		expect(await new FileCredentialStore(dir).list()).toEqual([]);
	});

	test("Ctrl+C inside a prompt cancels the login through the terminal's cancel", async () => {
		const dir = home();
		const { cli, err } = capture(dir);
		const interrupt = new AbortController();
		// a terminal whose prompt is interrupted the way readline reports it: cancel, then the signal rejects the read
		const terminal: LoginTerminal = {
			isTTY: true,
			question: (_prompt, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					interrupt.abort(new Error("login cancelled"));
				}),
			secret: async () => "",
			open: async () => {},
		};
		const provider = scripted({
			oauth: async (interaction) => {
				await interaction.prompt({ type: "text", message: "Paste" });
				return oauthCredential();
			},
		});
		expect(await runConfig(["login", "scripted"], cli, context([provider], terminal, interrupt.signal))).toBe(1);
		expect(err.at(-1)).toBe("abai config: login cancelled");
	});
});

describe("the terminal's line reader", () => {
	function streams() {
		const input = new PassThrough();
		const output = new PassThrough();
		const written: string[] = [];
		output.on("data", (chunk: Buffer) => written.push(chunk.toString()));
		return { input, output, written, text: () => written.join("") };
	}

	test("an echoed question is readline's own prompt; the answer comes back as typed", async () => {
		const { input, output, text } = streams();
		const cancel = () => {
			throw new Error("not cancelled");
		};
		const pending = readLine({
			input,
			output,
			prompt: "Paste the code: ",
			signal: new AbortController().signal,
			muted: false,
			cancel,
		});
		await new Promise((done) => setTimeout(done, 5));
		expect(text()).toContain("Paste the code: ");
		input.write("abc-123\r");
		expect(await pending).toBe("abc-123");
	});

	test("a secret is written once as a prompt, the answer never, and a newline closes the line", async () => {
		const { input, output, text } = streams();
		const cancel = () => {
			throw new Error("not cancelled");
		};
		const pending = readLine({
			input,
			output,
			prompt: "API key: ",
			signal: new AbortController().signal,
			muted: true,
			cancel,
		});
		input.write("sk-secret\r");
		expect(await pending).toBe("sk-secret");
		expect(text()).toBe("API key: \n");
	});

	test("Ctrl+C inside the prompt is the terminal's cancel, and the aborted read gets its newline", async () => {
		const { input, output, text } = streams();
		const interrupt = new AbortController();
		let cancelled = 0;
		const cancel = () => {
			cancelled++;
			interrupt.abort(new Error("login cancelled"));
		};
		const pending = readLine({ input, output, prompt: "Paste: ", signal: interrupt.signal, muted: false, cancel });
		await new Promise((done) => setTimeout(done, 5));
		input.write("\u0003");
		await expect(pending).rejects.toThrow("login cancelled");
		expect(cancelled).toBe(1);
		expect(text().endsWith("\n")).toBe(true);
	});

	test("the end of input cancels too, and an already aborted signal rejects at once", async () => {
		const { input, output } = streams();
		let cancelled = 0;
		const cancel = () => {
			cancelled++;
		};
		const pending = readLine({
			input,
			output,
			prompt: "Paste: ",
			signal: new AbortController().signal,
			muted: false,
			cancel,
		});
		await new Promise((done) => setTimeout(done, 5));
		input.end();
		await expect(pending).rejects.toThrow("the terminal closed");
		expect(cancelled).toBe(1);
		const gone = new AbortController();
		gone.abort(new Error("already"));
		const other = streams();
		await expect(
			readLine({
				input: other.input,
				output: other.output,
				prompt: "x: ",
				signal: gone.signal,
				muted: true,
				cancel,
			}),
		).rejects.toThrow("already");
	});
});

describe("the browser opener", () => {
	test("argv per platform, the URL one argument and never through a shell", () => {
		const url = "https://auth.example/?a=1&b=2";
		expect(openerFor("darwin", url)).toEqual(["open", [url]]);
		expect(openerFor("linux", url)).toEqual(["xdg-open", [url]]);
		expect(openerFor("win32", url)).toEqual(["rundll32", ["url.dll,FileProtocolHandler", url]]);
	});

	test("resolves once the opener started and is unreferenced; rejects when it could not start", async () => {
		class FakeChild extends EventEmitter {
			unrefs = 0;
			unref() {
				this.unrefs++;
			}
		}
		const started = new FakeChild();
		const calls: unknown[] = [];
		const spawnOk = (command: string, args: readonly string[], options: unknown) => {
			calls.push([command, args, options]);
			setTimeout(() => started.emit("spawn"), 0);
			return started as never;
		};
		await openUrl("https://x.example/", spawnOk, "linux");
		expect(calls).toEqual([["xdg-open", ["https://x.example/"], { stdio: "ignore", detached: true, cwd: "/" }]]);
		expect(started.unrefs).toBe(1);
		const missing = new FakeChild();
		const spawnMissing = () => {
			setTimeout(() => missing.emit("error", new Error("spawn xdg-open ENOENT")), 0);
			return missing as never;
		};
		await expect(openUrl("https://x.example/", spawnMissing, "linux")).rejects.toThrow("ENOENT");
	});
});

describe("the URL and text rules", () => {
	test("httpUrl keeps http and https only, normalized", () => {
		expect(httpUrl("HTTPS://Example.com/a")).toBe("https://example.com/a");
		expect(httpUrl("http://x/a\u0001b")).toBe("http://x/a%01b");
		// the URL parser drops leading and trailing control characters, and tabs and newlines anywhere
		expect(httpUrl("http://x/\u0001")).toBe("http://x/");
		expect(httpUrl("http://x/a\tb\nc")).toBe("http://x/abc");
		expect(httpUrl("ftp://x/")).toBeUndefined();
		expect(httpUrl("file:///etc/passwd")).toBeUndefined();
		expect(httpUrl("not a url")).toBeUndefined();
		expect(httpUrl(42)).toBeUndefined();
		expect(httpUrl(undefined)).toBeUndefined();
	});

	test("clean removes control characters and nothing else", () => {
		expect(clean("a\u001b[31mb\u0000c\u007f")).toBe("a[31mbc");
		expect(clean("plain ünïcödé")).toBe("plain ünïcödé");
		expect(clean(undefined)).toBe("");
	});
});
