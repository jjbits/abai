// Where a run's network identity lives and which aiip binary runs it.
// The identity is the aiip state directory: certificates, memberships and
// the daemon's socket. Default: one per program per machine under abai's
// home, so two runs of one program on one machine are one member; a
// realization that wants one identity per run points `ABAI_NET_DIR` at
// the run (the arena points each ship at its run directory).
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { type AbaiConfig, abaiHome } from "../config.ts";

/** The aiip state directory for this run; default `<ABAI_HOME>/net/<program>/`. */
export const ENV_NET_DIR = "ABAI_NET_DIR";
/** An invite token: the run joins with it at attach when its state dir has no membership of that network yet. */
export const ENV_NET_TOKEN = "ABAI_NET_TOKEN";
/** The aiip binary; default the configuration's `aiip.bin`, else `aiip` on the PATH. */
export const ENV_AIIP_BIN = "ABAI_AIIP_BIN";
export const AIIP_BINARY_NAME = "aiip";

/**
 * An environment without the invite token. The token holds the member's
 * private key and only the harness reads it, at attach: a child of the
 * harness, the aiip daemon or a launched program, has no use for it, so none
 * carries it. Everything else passes through; this strips the one key abai owns.
 */
export function withoutInviteToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const { [ENV_NET_TOKEN]: _token, ...rest } = env;
	return rest;
}

/** A program name that can be one directory segment: letters, digits, dot, underscore, hyphen; not `.` or `..`. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * The state directory for a run: `ABAI_NET_DIR`, else the program's place under abai's home, else none.
 * Throws for a relative `ABAI_NET_DIR` (a run and a `config net` command in another directory would reach
 * different places) and for a program name that cannot be a directory segment. Two programs of one name on
 * one machine share the default place, so they are one identity unless a run is given a directory of its own.
 */
export function networkDirFor(env: NodeJS.ProcessEnv, program?: string): string | undefined {
	const explicit = env[ENV_NET_DIR]?.trim();
	if (explicit) {
		if (!isAbsolute(explicit)) throw new Error(`${ENV_NET_DIR} must be an absolute path (got ${explicit})`);
		return explicit;
	}
	if (program === undefined || program === "") return undefined;
	if (!SAFE_SEGMENT.test(program) || program === "." || program === "..") {
		throw new Error(`the program's name ${JSON.stringify(program)} cannot name a directory; set ${ENV_NET_DIR}`);
	}
	return join(abaiHome(env), "net", program);
}

/** The aiip binary: `ABAI_AIIP_BIN`, else the configuration's `aiip.bin`, else `aiip` on the PATH; undefined when none is found. */
export function aiipBinaryFor(env: NodeJS.ProcessEnv, config: AbaiConfig): string | undefined {
	const explicit = env[ENV_AIIP_BIN]?.trim();
	if (explicit) return explicit;
	const configured = config.aiip?.bin?.trim();
	if (configured) return configured;
	return findOnPath(AIIP_BINARY_NAME, env);
}

/** The first executable of that name on `PATH`. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, name);
		try {
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// not here
		}
	}
	return undefined;
}
