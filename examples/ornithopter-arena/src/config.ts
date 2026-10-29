// Every limit and address the arena runs with, from the environment, with
// defaults for a laptop. The deployment sets them in the compose file.
export interface ArenaConfig {
	/** The port to listen on, all interfaces inside the container, loopback outside it. */
	port: number;
	host: string;
	/** The world every ship is given. */
	seed: number;
	/** Live sessions at most; also the number of spawn slots on the pad's ring. */
	maxSessions: number;
	/** Live sessions per visitor address, and session creations per minute per address. */
	perAddress: number;
	createsPerMinute: number;
	/** Milliseconds without an MCP request before a session ends. */
	idleMs: number;
	/** Milliseconds a session may live at most. */
	lifetimeMs: number;
	/** Milliseconds a crashed ship stays as a wreck before its session ends. */
	wreckMs: number;
	/** Milliseconds an ended session's audit log is kept. */
	auditKeepMs: number;
	/** Where sessions' run directories and audit logs go; short, for the socket path limit. */
	runRoot: string;
	/** The address visitors are given, without a trailing slash. */
	publicUrl: string;
	/** Trust X-Forwarded-For from a loopback or private peer (the reverse proxy). */
	trustProxy: boolean;
	/** The ornithopter program's entry file and the harness binary. */
	shipEntry: string;
	harnessBin: string;
	/** MCP requests per second per session, with a burst of twice that. */
	requestsPerSecond: number;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const v = Number(raw);
	if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number, not ${raw}`);
	return v;
}

export function configFrom(env: NodeJS.ProcessEnv, defaults: { shipEntry: string; harnessBin: string }): ArenaConfig {
	const port = integer(env, "ARENA_PORT", 8093);
	return {
		port,
		host: env.ARENA_HOST ?? "127.0.0.1",
		seed: integer(env, "ARENA_SEED", 7),
		maxSessions: integer(env, "ARENA_MAX_SESSIONS", 18),
		perAddress: integer(env, "ARENA_PER_ADDRESS", 3),
		createsPerMinute: integer(env, "ARENA_CREATES_PER_MINUTE", 5),
		idleMs: integer(env, "ARENA_IDLE_MS", 10 * 60_000),
		lifetimeMs: integer(env, "ARENA_LIFETIME_MS", 3 * 3_600_000),
		wreckMs: integer(env, "ARENA_WRECK_MS", 10 * 60_000),
		auditKeepMs: integer(env, "ARENA_AUDIT_KEEP_MS", 3_600_000),
		runRoot: env.ARENA_RUN_ROOT ?? "/tmp/orni",
		// empty until the server listens, when the bound address stands in for it
		publicUrl: (env.ARENA_PUBLIC_URL ?? "").replace(/\/+$/, ""),
		trustProxy: env.ARENA_TRUST_PROXY === "1",
		shipEntry: env.ARENA_SHIP_ENTRY ?? defaults.shipEntry,
		harnessBin: env.ARENA_HARNESS_BIN ?? defaults.harnessBin,
		requestsPerSecond: integer(env, "ARENA_REQUESTS_PER_SECOND", 30),
	};
}
