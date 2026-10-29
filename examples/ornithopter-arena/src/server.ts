// The arena's one door: the page and its streams for people, Fly for a new
// pilot, and the MCP bridge for the pilots' agents. Bound to the loopback
// address outside a container, to every interface inside one, and in
// front of it a reverse proxy that terminates TLS.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { World } from "ornithopter/src/world.ts";
import { BridgeClosed, type JsonRpcMessage } from "./bridge.ts";
import type { ArenaConfig } from "./config.ts";
import { Refused, type Sessions, TOKEN_PATTERN } from "./sessions.ts";

export interface ArenaServer {
	readonly port: number;
	readonly url: string;
	close(): Promise<void>;
}

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const THREE_MODULE = fileURLToPath(import.meta.resolve("three"));
const MAX_BODY = 64 * 1024;
const REQUEST_TIMEOUT_MS = 70_000;
const SHIPS_INTERVAL_MS = 200;
/** Requests a session may have awaiting the harness at once: a parked wait and a few reads. */
const MAX_IN_FLIGHT = 8;
/** Spectator connections, in all and per followed ship. */
const MAX_VIEWERS = 200;
const MAX_FOLLOWERS = 40;
/** The header the page sends with Fly: a cross-site form or fetch cannot, without a preflight this server refuses. */
export const FLY_HEADER = "x-arena";

interface Static {
	body: Buffer;
	type: string;
}

/** The static files, read once; the page's import map is hashed into the policy so no other inline script runs. */
function loadStatic(): { files: Map<string, Static>; csp: string } {
	const html = readFileSync(join(PUBLIC_DIR, "index.html"));
	const importMap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html.toString("utf8"))?.[1] ?? "";
	const hash = createHash("sha256").update(importMap).digest("base64");
	const files = new Map<string, Static>([
		["/", { body: html, type: "text/html; charset=utf-8" }],
		["/app.js", { body: readFileSync(join(PUBLIC_DIR, "app.js")), type: "text/javascript; charset=utf-8" }],
		["/style.css", { body: readFileSync(join(PUBLIC_DIR, "style.css")), type: "text/css; charset=utf-8" }],
		["/vendor/three.module.js", { body: readFileSync(THREE_MODULE), type: "text/javascript; charset=utf-8" }],
	]);
	const csp = [
		"default-src 'none'",
		`script-src 'self' 'sha256-${hash}'`,
		"style-src 'self'",
		"connect-src 'self'",
		"img-src 'self' data:",
		"font-src 'self'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join("; ");
	return { files, csp };
}

/** A token bucket per key: `rate` a second, a burst of twice that. */
class Buckets {
	private readonly buckets = new Map<string, { tokens: number; at: number }>();
	private readonly rate: number;
	constructor(rate: number) {
		this.rate = rate;
	}
	take(key: string, now: number): boolean {
		const b = this.buckets.get(key) ?? { tokens: this.rate * 2, at: now };
		b.tokens = Math.min(this.rate * 2, b.tokens + ((now - b.at) / 1000) * this.rate);
		b.at = now;
		this.buckets.set(key, b);
		if (b.tokens < 1) return false;
		b.tokens -= 1;
		return true;
	}
	forget(key: string): void {
		this.buckets.delete(key);
	}
}

function isPrivate(address: string | undefined): boolean {
	if (!address) return false;
	const a = address.replace(/^::ffff:/, "");
	return (
		a === "127.0.0.1" ||
		a === "::1" ||
		/^10\./.test(a) ||
		/^192\.168\./.test(a) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(a)
	);
}

/** The body, or `undefined` past the limit: the rest is drained, so the 413 can be sent on an open connection. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
	return new Promise((resolve) => {
		const declared = Number(req.headers["content-length"]);
		let chunks: Buffer[] = [];
		let size = 0;
		let tooLarge = Number.isFinite(declared) && declared > limit;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) tooLarge = true;
			if (tooLarge) chunks = [];
			else chunks.push(chunk);
		});
		req.on("end", () => resolve(tooLarge ? undefined : Buffer.concat(chunks)));
		req.on("error", () => resolve(undefined));
	});
}

export async function startArenaServer(config: ArenaConfig, sessions: Sessions, world: World): Promise<ArenaServer> {
	const { files, csp } = loadStatic();
	const worldJson = JSON.stringify({
		...world.describe(),
		grid: world.grid,
		cell: world.cell,
		spires: world.spires,
		slots: sessions.slots,
		limits: { maxSessions: config.maxSessions, idleMinutes: config.idleMs / 60_000 },
	});
	const heights = Buffer.from(world.heights.buffer, world.heights.byteOffset, world.heights.byteLength);
	const mcpBuckets = new Buckets(config.requestsPerSecond);
	const log = (line: string): void => console.error(`arena: ${line}`);

	// the spectator streams: every viewer, and the viewers following one ship
	const viewers = new Set<ServerResponse>();
	const followers = new Map<string, Set<ServerResponse>>();
	const send = (res: ServerResponse, event: string, data: unknown): void => {
		if (res.writableNeedDrain || res.destroyed) return;
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};
	const broadcast = (event: string, data: unknown): void => {
		for (const res of viewers) send(res, event, data);
	};
	const toFollowers = (callsign: string, event: string, data: unknown): void => {
		for (const res of followers.get(callsign) ?? []) send(res, event, data);
	};
	const shipsTimer = setInterval(() => {
		if (viewers.size > 0) broadcast("ships", sessions.summaries());
	}, SHIPS_INTERVAL_MS);
	shipsTimer.unref();
	sessions.on("joined", (d) => broadcast("game", { kind: "joined", ...d, at: Date.now() }));
	sessions.on("left", (d) => {
		broadcast("game", { kind: "left", callsign: d.callsign, reason: d.reason, at: Date.now() });
		for (const res of followers.get(d.callsign) ?? []) send(res, "gone", { callsign: d.callsign });
		if (typeof d.token === "string") mcpBuckets.forget(d.token);
	});
	sessions.on("crashed", (d) => broadcast("game", { kind: "crashed", ...d, at: Date.now() }));
	sessions.on("collision", (d) => broadcast("game", { kind: "collision", ...d, at: Date.now() }));
	sessions.on("frame", (d) => toFollowers(d.callsign, "state", d.frame));
	sessions.on("event", (d) => toFollowers(d.callsign, "game", { name: d.name, payload: d.payload, at: Date.now() }));

	const headers = (res: ServerResponse, type: string, extra: Record<string, string> = {}): void => {
		res.setHeader("content-type", type);
		res.setHeader("cache-control", "no-store");
		res.setHeader("x-content-type-options", "nosniff");
		res.setHeader("referrer-policy", "no-referrer");
		res.setHeader("x-frame-options", "DENY");
		if (type.startsWith("text/html")) res.setHeader("content-security-policy", csp);
		for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
	};
	const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
		headers(res, "application/json", extra);
		res.writeHead(status).end(JSON.stringify(body));
	};
	const addressOf = (req: IncomingMessage): string => {
		const peer = req.socket.remoteAddress ?? "unknown";
		if (config.trustProxy && isPrivate(peer)) {
			// one trusted hop: the entry it appended is the last; anything before it is the client's own claim
			const forwarded = req.headers["x-forwarded-for"];
			const list = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? ""))
				.split(",")
				.map((a) => a.trim());
			const last = list.at(-1);
			if (last) return last;
		}
		return peer;
	};

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const url = new URL(req.url ?? "/", "http://arena");
		const path = url.pathname;
		const method = req.method ?? "GET";

		// --- the pilots' agents
		const mcp = /^\/mcp\/([0-9a-f]+)$/.exec(path);
		if (mcp) {
			const token = mcp[1] as string;
			if (!TOKEN_PATTERN.test(token)) return json(res, 404, { error: "no such session" });
			const session = sessions.get(token);
			if (!session?.bridge) return json(res, 404, { error: "no such session" });
			if (method === "GET") {
				headers(res, "text/plain", { allow: "POST, DELETE" });
				res.writeHead(405).end("this server sends nothing on its own; POST your messages");
				return;
			}
			if (method === "DELETE") return json(res, 200, { ok: true });
			if (method !== "POST") return json(res, 405, { error: "POST only" });
			if (!mcpBuckets.take(token, Date.now())) return json(res, 429, { error: "slow down" });
			if (session.bridge.inFlight >= MAX_IN_FLIGHT)
				return json(res, 429, { error: "too many requests awaiting the ship" });
			sessions.touch(token);
			const body = await readBody(req, MAX_BODY);
			if (body === undefined) return json(res, 413, { error: "too large" });
			let message: JsonRpcMessage;
			try {
				message = JSON.parse(body.toString("utf8")) as JsonRpcMessage;
			} catch {
				return json(res, 400, { error: "not JSON" });
			}
			if (
				typeof message !== "object" ||
				message === null ||
				Array.isArray(message) ||
				message.jsonrpc !== "2.0" ||
				typeof message.method !== "string" ||
				message.method === ""
			) {
				return json(res, 400, { error: "one JSON-RPC 2.0 request or notification per request, with a method" });
			}
			if (message.id === undefined || message.id === null) {
				session.bridge.notify(message);
				headers(res, "application/json");
				res.writeHead(202).end();
				return;
			}
			try {
				const answer = await session.bridge.request(message, REQUEST_TIMEOUT_MS);
				const extra: Record<string, string> = {};
				if (message.method === "initialize") extra["mcp-session-id"] = token;
				return json(res, 200, answer, extra);
			} catch (error) {
				if (error instanceof BridgeClosed) return json(res, 410, { error: "the session has ended" });
				return json(res, 504, {
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32000, message: "no answer from the ship in time" },
				});
			}
		}

		// --- a new pilot
		if (path === "/fly") {
			if (method !== "POST") return json(res, 405, { error: "POST to fly" });
			// the page's own fetch carries the header; a cross-site request cannot without a preflight, which gets no answer here
			if (req.headers[FLY_HEADER] !== "fly")
				return json(res, 403, { error: `fly with the header ${FLY_HEADER}: fly` });
			const address = addressOf(req);
			try {
				const session = await sessions.create(address);
				const mcpUrl = `${config.publicUrl}/mcp/${session.token}`;
				const pageUrl = `${config.publicUrl}/?follow=${session.callsign}`;
				log(`fly: ${session.callsign} on slot ${session.slot} for ${address}`);
				return json(res, 200, {
					callsign: session.callsign,
					mcpUrl,
					pageUrl,
					commands: {
						claude: `claude mcp add --transport http ornithopter ${mcpUrl}`,
						codex: `codex mcp add ornithopter --url ${mcpUrl}`,
					},
					ask: "Read abai_prompt, then fly: you are the pilot.",
				});
			} catch (error) {
				if (error instanceof Refused) return json(res, error.status, { error: error.message });
				log(`fly failed: ${error instanceof Error ? error.message : String(error)}`);
				return json(res, 500, { error: "the ship could not be started" });
			}
		}

		if (method !== "GET" && method !== "HEAD") return json(res, 405, { error: "GET only" });

		// --- the world and the streams
		if (path === "/world") {
			headers(res, "application/json");
			res.writeHead(200).end(worldJson);
			return;
		}
		if (path === "/heights") {
			headers(res, "application/octet-stream");
			res.writeHead(200).end(heights);
			return;
		}
		if (path === "/stream") {
			if (viewers.size >= MAX_VIEWERS) return json(res, 503, { error: "too many viewers" });
			headers(res, "text/event-stream", { connection: "keep-alive" });
			res.writeHead(200);
			res.write(": ornithopter arena\n\n");
			send(res, "hello", { seed: world.seed, ships: sessions.summaries(), at: Date.now() });
			viewers.add(res);
			req.on("close", () => viewers.delete(res));
			return;
		}
		const follow = /^\/follow\/([a-z0-9-]{1,40})$/.exec(path);
		if (follow) {
			const callsign = follow[1] as string;
			const session = sessions.live().find((s) => s.callsign === callsign);
			const set = followers.get(callsign) ?? new Set<ServerResponse>();
			if (session && set.size >= MAX_FOLLOWERS) return json(res, 503, { error: "too many followers" });
			headers(res, "text/event-stream", { connection: "keep-alive" });
			res.writeHead(200);
			res.write(": following\n\n");
			if (!session) {
				// nobody of that name: say so and close, keeping nothing
				send(res, "gone", { callsign });
				res.end();
				return;
			}
			if (session.frame) send(res, "state", session.frame);
			set.add(res);
			followers.set(callsign, set);
			req.on("close", () => {
				set.delete(res);
				if (set.size === 0) followers.delete(callsign);
			});
			return;
		}
		const file = files.get(path);
		if (!file) return json(res, 404, { error: "not found" });
		headers(res, file.type);
		res.writeHead(200).end(file.body);
	};

	const server: Server = createServer((req, res) => {
		handle(req, res).catch((error) => {
			log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
			if (!res.headersSent) res.writeHead(500);
			res.end();
		});
	});
	server.requestTimeout = REQUEST_TIMEOUT_MS + 10_000;
	server.headersTimeout = 15_000;
	// a ceiling on sockets, under the proxy's own; a session's in-flight cap and the viewer caps bound the rest
	server.maxConnections = 1000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : config.port;
	return {
		port,
		url: `http://${config.host}:${port}`,
		close(): Promise<void> {
			clearInterval(shipsTimer);
			for (const res of viewers) res.end();
			for (const set of followers.values()) for (const res of set) res.end();
			viewers.clear();
			followers.clear();
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}
