// The web page's server: the world once, the ship's state as a stream, and
// the page itself. The browser only watches; nothing comes back up this way.
// Bound to the loopback address: the page is for the person at this machine.
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { frame } from "./frame.ts";
import type { Sim, SimEvent } from "./sim.ts";

export interface GameServer {
	readonly port: number;
	readonly url: string;
	close(): Promise<void>;
}

/** Milliseconds between state frames on the stream. */
export const STREAM_INTERVAL_MS = 100;

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
/** The ES module build of three, wherever npm put it; its exports map points "three" at it. */
const THREE_MODULE = fileURLToPath(import.meta.resolve("three"));

const STATIC: Record<string, { file: string; type: string }> = {
	"/": { file: join(PUBLIC_DIR, "index.html"), type: "text/html; charset=utf-8" },
	"/app.js": { file: join(PUBLIC_DIR, "app.js"), type: "text/javascript; charset=utf-8" },
	"/style.css": { file: join(PUBLIC_DIR, "style.css"), type: "text/css; charset=utf-8" },
	"/vendor/three.module.js": { file: THREE_MODULE, type: "text/javascript; charset=utf-8" },
};

export async function startServer(sim: Sim, port: number): Promise<GameServer> {
	const world = sim.world;
	const worldJson = JSON.stringify({
		...world.describe(),
		grid: world.grid,
		cell: world.cell,
		spires: world.spires,
		pid: process.pid,
	});
	const heights = Buffer.from(world.heights.buffer, world.heights.byteOffset, world.heights.byteLength);
	const clients = new Set<ServerResponse>();

	const send = (res: ServerResponse, event: string, data: unknown): void => {
		// a browser that stops reading gets no more frames buffered on its behalf; it catches up on the next one
		if (res.writableNeedDrain) return;
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};
	const broadcast = (event: string, data: unknown): void => {
		for (const res of clients) send(res, event, data);
	};
	const unsubscribe = sim.onEvent((e: SimEvent) => broadcast("game", { ...e, at: Date.now() }));
	const timer = setInterval(() => {
		if (clients.size > 0) broadcast("state", frame(sim));
	}, STREAM_INTERVAL_MS);
	timer.unref();

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const path = (req.url ?? "/").split("?")[0] ?? "/";
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405).end();
			return;
		}
		if (path === "/world") {
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(worldJson);
			return;
		}
		if (path === "/heights") {
			res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" }).end(heights);
			return;
		}
		if (path === "/stream") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-store",
				connection: "keep-alive",
			});
			res.write(": ornithopter\n\n");
			send(res, "state", frame(sim));
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}
		const file = STATIC[path];
		if (!file) {
			res.writeHead(404, { "content-type": "text/plain" }).end("not found");
			return;
		}
		try {
			const body = await readFile(file.file);
			res.writeHead(200, { "content-type": file.type, "cache-control": "no-store" }).end(body);
		} catch {
			res.writeHead(500, { "content-type": "text/plain" }).end("unreadable");
		}
	};

	const server: Server = createServer((req, res) => {
		handle(req, res).catch(() => {
			if (!res.headersSent) res.writeHead(500);
			res.end();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	const bound = typeof address === "object" && address ? address.port : port;
	return {
		port: bound,
		url: `http://127.0.0.1:${bound}/`,
		close(): Promise<void> {
			clearInterval(timer);
			unsubscribe();
			for (const res of clients) res.end();
			clients.clear();
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}
