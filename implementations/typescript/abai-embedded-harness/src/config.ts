// Machine-level configuration (abaigrammar section 9): one place per user,
// shared by every abaigram on the machine. `config.json` names the default
// provider and model and the connect timeout; `credentials.json`, mode
// 0600, holds one credential per provider in the shape the model layer
// stores. `ABAI_HOME` relocates the directory (tests, several setups).
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@arx-06/ai";

export const ENV_HOME = "ABAI_HOME";
export const CONFIG_FILE = "config.json";
export const CREDENTIALS_FILE = "credentials.json";
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export interface AbaiConfig {
	/** The default provider, such as `anthropic` or `freetoken`. */
	provider?: string;
	/** The default model id within the provider. */
	model?: string;
	/** How long the first contact with the model may take before the harness detaches (section 4.3). */
	connectTimeoutMs: number;
	/** Provider settings that are not secrets. */
	providers?: Record<string, Record<string, string>>;
}

/** The configuration directory: `ABAI_HOME`, else `~/.abai`. */
export function abaiHome(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env[ENV_HOME]?.trim();
	if (explicit) return explicit;
	return join(env.HOME && env.HOME !== "" ? env.HOME : homedir(), ".abai");
}

/** Parse a private file; a corrupt one is reported by name only, never by a window of its text. */
function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`${basename(path)} is not valid JSON`);
	}
}

/** The directory exists and is private, whether it was created now or earlier by something looser. */
function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** Write a file atomically with a private mode. */
function writePrivate(path: string, text: string): void {
	ensurePrivateDir(dirname(path));
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, text, { mode: 0o600 });
	renameSync(temp, path);
}

/** A lock file taken with O_EXCL around a read-modify-write, with a bounded wait; stale locks are reclaimed. */
async function withFileLock<T>(path: string, task: () => Promise<T>): Promise<T> {
	const lock = `${path}.lock`;
	ensurePrivateDir(dirname(path));
	const deadline = Date.now() + 5_000;
	while (true) {
		try {
			closeSync(openSync(lock, "wx", 0o600));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lock).mtimeMs > 10_000) unlinkSync(lock); // a crashed writer's lock
			} catch {
				// gone already
			}
			if (Date.now() > deadline) throw new Error(`${basename(path)} is locked by another writer`);
			await new Promise((done) => setTimeout(done, 10));
		}
	}
	try {
		return await task();
	} finally {
		try {
			unlinkSync(lock);
		} catch {
			// already released
		}
	}
}

export function readConfig(home: string): AbaiConfig {
	const raw = readJson(join(home, CONFIG_FILE));
	const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const timeout = record.connectTimeoutMs;
	return {
		...(typeof record.provider === "string" ? { provider: record.provider } : {}),
		...(typeof record.model === "string" ? { model: record.model } : {}),
		connectTimeoutMs: typeof timeout === "number" && timeout > 0 ? timeout : DEFAULT_CONNECT_TIMEOUT_MS,
		...(typeof record.providers === "object" && record.providers !== null
			? { providers: record.providers as Record<string, Record<string, string>> }
			: {}),
	};
}

export function writeConfig(home: string, config: AbaiConfig): void {
	writePrivate(join(home, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Credentials in a private file, read fresh on every access so another
 * process's `config` command is seen at once, written atomically. Every
 * write goes through one chain in this process and a lock file across
 * processes, and re-reads the file right before writing, so a write to
 * one provider never loses another's.
 */
export class FileCredentialStore implements CredentialStore {
	readonly path: string;
	private chain: Promise<unknown> = Promise.resolve();

	constructor(home: string) {
		this.path = join(home, CREDENTIALS_FILE);
	}

	private load(): Record<string, Credential> {
		const raw = readJson(this.path);
		return typeof raw === "object" && raw !== null ? (raw as Record<string, Credential>) : {};
	}

	private save(all: Record<string, Credential>): void {
		writePrivate(this.path, `${JSON.stringify(all, null, 2)}\n`);
	}

	private serialize<T>(task: () => Promise<T>): Promise<T> {
		const run = (): Promise<T> => withFileLock(this.path, task);
		const next = this.chain.then(run, run);
		this.chain = next.catch(() => undefined);
		return next;
	}

	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		return this.load()[providerId];
	}

	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.serialize(async () => {
			const current = this.load()[providerId];
			const next = await fn(current);
			if (next === undefined) return current;
			const all = this.load(); // re-read: another provider's write may have landed while fn ran
			all[providerId] = next;
			this.save(all);
			return next;
		});
	}

	delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
		return this.serialize(async () => {
			const all = this.load();
			if (!(providerId in all)) return;
			delete all[providerId];
			this.save(all);
		});
	}
}
