// MCP over the harness's stdio: the arena speaks newline JSON-RPC to one
// harness process per session, and this bridge turns an HTTP request's
// message into a line and the matching line into the response. Ids are
// rewritten on the way through, so two clients of one session can never
// collide, and restored on the way back.
import { createInterface } from "node:readline";

export interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: string | number | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/** The harness's stdio, as the bridge needs it. */
export interface HarnessIo {
	write(line: string): void;
	lines(onLine: (line: string) => void): void;
	onExit(cb: () => void): void;
}

export class BridgeClosed extends Error {
	constructor() {
		super("the harness is gone");
		this.name = "BridgeClosed";
	}
}

export class McpBridge {
	private readonly pending = new Map<
		number,
		{
			id: JsonRpcMessage["id"];
			resolve: (m: JsonRpcMessage) => void;
			reject: (e: Error) => void;
			timer: NodeJS.Timeout;
		}
	>();
	private next = 1;
	private closed = false;

	private readonly io: HarnessIo;

	constructor(io: HarnessIo) {
		this.io = io;
		io.lines((line) => this.receive(line));
		io.onExit(() => this.close());
	}

	/** Forward a request and resolve with the harness's response, the client's id restored. */
	request(message: JsonRpcMessage, timeoutMs: number): Promise<JsonRpcMessage> {
		if (this.closed) return Promise.reject(new BridgeClosed());
		const inner = this.next++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(inner);
				reject(new Error(`no answer from the harness within ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(inner, { id: message.id, resolve, reject, timer });
			this.io.write(`${JSON.stringify({ ...message, id: inner })}\n`);
		});
	}

	/** Requests awaiting the harness. */
	get inFlight(): number {
		return this.pending.size;
	}

	/** Forward a notification; nothing comes back. A cancellation names the request by the client's id, so it is mapped. */
	notify(message: JsonRpcMessage): void {
		if (this.closed) return;
		const { id: _id, ...rest } = message;
		if (rest.method === "notifications/cancelled") {
			const params = rest.params as { requestId?: JsonRpcMessage["id"] } | undefined;
			const inner = [...this.pending].find(([, p]) => p.id === params?.requestId)?.[0];
			if (inner === undefined) return; // nothing of ours to cancel
			this.io.write(`${JSON.stringify({ ...rest, params: { ...params, requestId: inner } })}
`);
			return;
		}
		this.io.write(`${JSON.stringify(rest)}
`);
	}

	get open(): boolean {
		return !this.closed;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const [inner, p] of this.pending) {
			clearTimeout(p.timer);
			this.pending.delete(inner);
			p.reject(new BridgeClosed());
		}
	}

	private receive(line: string): void {
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line) as JsonRpcMessage;
		} catch {
			return; // not JSON: the harness's own noise, never a response
		}
		if (typeof message !== "object" || message === null || typeof message.id !== "number") return;
		const p = this.pending.get(message.id);
		if (!p) return;
		clearTimeout(p.timer);
		this.pending.delete(message.id);
		p.resolve({ ...message, id: p.id ?? null });
	}
}

/** A HarnessIo over a child process's stdin and stdout. */
export function stdioOf(child: {
	stdin: (NodeJS.WritableStream & { on(event: "error", cb: () => void): unknown }) | null;
	stdout: NodeJS.ReadableStream | null;
	once(event: "exit", cb: () => void): unknown;
}): HarnessIo {
	if (!child.stdin || !child.stdout) throw new Error("the harness child has no stdio pipes");
	const stdin = child.stdin;
	// a line written to a harness that has just died fails with EPIPE on the pipe; unheard, that would end the arena
	stdin.on("error", () => {});
	const reader = createInterface({ input: child.stdout });
	return {
		write: (line) => {
			if (stdin.writable) stdin.write(line);
		},
		lines: (onLine) => reader.on("line", onLine),
		onExit: (cb) => child.once("exit", cb),
	};
}
