// A small MCP client for tests: JSON-RPC 2.0 lines over a pair of streams,
// responses matched by id, tool calls answering their text.
import type { PassThrough } from "node:stream";

export type Line = Record<string, unknown>;

export interface McpClient {
	/** Send a request and await its response. */
	request(method: string, params?: unknown, id?: string | number): Promise<Line>;
	/** A tool call, answering the text of its result and whether it was an error. */
	call(
		name: string,
		args?: Record<string, unknown>,
		id?: string | number,
	): Promise<{ text: string; isError: boolean }>;
	send(message: unknown): void;
	/** Every response in order. */
	all: Line[];
}

export function mcpClient(input: PassThrough, output: PassThrough): McpClient {
	const all: Line[] = [];
	const waiters: Array<{ id: string | number | null; resolve: (line: Line) => void }> = [];
	let buffer = "";
	let nextId = 1;
	output.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let at = buffer.indexOf("\n");
		while (at >= 0) {
			const text = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			at = buffer.indexOf("\n");
			const line = JSON.parse(text) as Line;
			all.push(line);
			const id = (line.id ?? null) as string | number | null;
			for (const waiter of waiters.splice(0)) {
				if (waiter.id === id) waiter.resolve(line);
				else waiters.push(waiter);
			}
		}
	});
	const send = (message: unknown): void => {
		input.write(`${JSON.stringify(message)}\n`);
	};
	const request = (method: string, params?: unknown, id: string | number = nextId++): Promise<Line> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no response to ${method} (${String(id)}) in time`)), 10_000);
			waiters.push({
				id,
				resolve: (line) => {
					clearTimeout(timer);
					resolve(line);
				},
			});
			send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
		});
	return {
		request,
		send,
		all,
		call: async (name, args = {}, id) => {
			const response = await request("tools/call", { name, arguments: args }, id);
			const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
			return { text: result.content[0].text, isError: result.isError === true };
		},
	};
}
