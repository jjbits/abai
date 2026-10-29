// Mode and harness selection from the environment (abaigrammar section 4.4).
// `ABAI_MODE` overrides the manifest's default mode; a value the manifest
// does not declare falls back to the default and is counted. `ABAI_HARNESS`
// is read only by check runs: unset means the real harness, `off` makes
// every attach fail at once, `null` and `exercise` select the null harness
// in its passive and active forms.
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mode } from "./manifest/manifest.ts";

export const ENV_MODE = "ABAI_MODE";
export const ENV_HARNESS = "ABAI_HARNESS";
/**
 * Set by a harness that launched this program (section 6.3): the socket its
 * endpoint must listen on, where the launcher is already waiting. Its
 * presence is also what makes the full lifecycle channel available (5.5).
 */
export const ENV_LAUNCH_SOCKET = "ABAI_LAUNCH_SOCKET";
/** Where a sidecar endpoint puts its socket and descriptor; default `<ABAI_HOME or ~/.abai>/run`, the harness's own default. */
export const ENV_RUN_DIR = "ABAI_RUN_DIR";
/** The harness binary the stub spawns at a touchpoint under sidecar; default: the program's `node_modules/.bin`, else PATH. */
export const ENV_HARNESS_BIN = "ABAI_HARNESS_BIN";
/** How long a sidecar attach waits for the spawned harness to connect, in milliseconds. */
export const ENV_ATTACH_WAIT_MS = "ABAI_ATTACH_WAIT_MS";
export const DEFAULT_ATTACH_WAIT_MS = 30_000;

/** The run directory for this environment. With no home at all, a private directory under the machine's temp dir. */
export function runDirFrom(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env[ENV_RUN_DIR]?.trim();
	if (explicit) return explicit;
	const home = env.ABAI_HOME?.trim();
	if (home) return join(home, "run");
	const user = env.HOME?.trim();
	return user ? join(user, ".abai", "run") : join(tmpdir(), "abai-run");
}

/** The attach wait for this environment; an unusable value means the default. */
export function attachWaitMsFrom(env: NodeJS.ProcessEnv = process.env): number {
	const value = Number(env[ENV_ATTACH_WAIT_MS]);
	return Number.isInteger(value) && value > 0 ? value : DEFAULT_ATTACH_WAIT_MS;
}

export type HarnessSelection = "real" | "off" | "null" | "exercise";

export interface ModeSelection {
	mode: Mode;
	/** The requested mode was not declared; the default applies and is counted. */
	fallback: boolean;
	/** What `ABAI_MODE` asked for, when set. */
	requested?: string;
}

/** The mode for this run: the first declared, unless `ABAI_MODE` names a declared one. */
export function selectMode(modes: readonly Mode[], env: NodeJS.ProcessEnv = process.env): ModeSelection {
	const requested = env[ENV_MODE]?.trim();
	const first = modes[0];
	if (first === undefined) throw new Error("the manifest declares no modes");
	if (requested === undefined || requested === "") return { mode: first, fallback: false };
	if ((modes as readonly string[]).includes(requested)) return { mode: requested as Mode, fallback: false, requested };
	return { mode: first, fallback: true, requested };
}

/** The harness for this run. An unknown value selects the real harness and is reported, never thrown: the program runs. */
export function selectHarness(env: NodeJS.ProcessEnv = process.env): { selection: HarnessSelection; error?: string } {
	const value = env[ENV_HARNESS]?.trim();
	if (value === undefined || value === "") return { selection: "real" };
	if (value === "off" || value === "null" || value === "exercise") return { selection: value };
	return { selection: "real", error: `${ENV_HARNESS} must be unset, off, null or exercise (got ${value})` };
}

/** `~` at the start of a path means the home directory. */
export function expandHome(path: string, home = process.env.HOME ?? ""): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
	return path;
}
