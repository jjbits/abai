// The MCP front end (abaigrammar section 4.4, `<prog> abai mcp`): the harness
// as an MCP server, so the agent inside an MCP client such as Claude Code is
// the program's agent. Newline-delimited JSON-RPC 2.0 on an input and an
// output stream (the MCP stdio transport); the output carries nothing else,
// diagnostics go to stderr. No model is configured here: the client brings
// its own.
//
// Nothing can wake an MCP client, so the agent parks by calling `abai_wait`,
// which returns the next wake. A wake hands the agent decisions, turns and
// touchpoints by id, and the step that received them ends when the agent
// parks again: that next `abai_wait` first settles what the last delivery
// carried, the way the session form settles a run's deliveries when the run
// ends. One rule, in `Harness.settleDelivered`.
//
// Consent under this form is the client's: an MCP client that puts each tool
// call to the person before it runs is the user channel (section 4.5), so a
// `confirm` act is stated as `auto` and audited so. Ported in shape from
// arx-06's harness and generalized: the manifest comes from the attach.
import type { Readable, Writable } from "node:stream";
import { type JsonObject, validateToolArguments } from "@arx-06/ai";
import { attachCappedLineReader } from "abai";
import type { Harness } from "./harness.ts";
import { type HarnessToolSpec, type ToolFront, toolsFor } from "./tools.ts";
import { ABAI_HARNESS_VERSION } from "./version.ts";

export const MCP_SERVER_NAME = "abai-embedded-harness";
/**
 * Protocol revisions this server speaks; the client's is echoed when it is
 * one of them. `2025-03-26` is left out: it requires JSON-RPC batches, which
 * this server does not accept.
 */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2024-11-05"];
export const MCP_MAX_LINE_BYTES = 16 * 1024 * 1024;
/** How long an input that ended waits for the requests still in flight before the server goes. */
export const MCP_DRAIN_MS = 5000;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** What the agent is told when it parks again without having decided. */
export const PARKED_UNDECIDED = "the agent parked without deciding";

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
	jsonrpc?: unknown;
	id?: JsonRpcId;
	method?: unknown;
	params?: unknown;
}

export interface McpDeps {
	input?: Readable;
	output?: Writable;
	stderr?: Writable;
	/** Signals that end the server; default SIGINT and SIGTERM. */
	signals?: NodeJS.Signals[];
	/** Sidecar front ends: how `abai_attach` connects to a program by target. Absent in-process. */
	attach?: (target: string | number | undefined) => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** An MCP tool description from a spec: the TypeBox schema is JSON Schema. */
export function toolDescriptor(spec: HarnessToolSpec): { name: string; description: string; inputSchema: unknown } {
	return { name: spec.name, description: spec.description, inputSchema: JSON.parse(JSON.stringify(spec.parameters)) };
}

/** Validate a call's arguments against the tool's schema, the way the agent loop does. */
export function validateArguments(spec: HarnessToolSpec, args: Record<string, unknown>): Record<string, unknown> {
	return validateToolArguments(
		{ name: spec.name, description: spec.description, parameters: spec.parameters },
		{ type: "toolCall", id: "mcp", name: spec.name, arguments: args as JsonObject },
	) as Record<string, unknown>;
}

/** The instructions an unattached server can give: how to get attached. */
const DETACHED_INSTRUCTIONS =
	"This abai harness is not attached to a program yet. Call abai_attach with a socket path or a pid, or with no target when one program is running; then abai_prompt for the program's identity and manifest.";

/**
 * Serve the harness to an MCP client until the input ends, the output fails
 * or a signal arrives. The harness may be attached already (the sidecar verb
 * with a target, the in-process entry) or not (`abai_attach` attaches it).
 * Resolves to the exit code.
 */
export function serveMcp(harness: Harness, deps: McpDeps = {}): Promise<number> {
	const input = deps.input ?? process.stdin;
	const output = deps.output ?? process.stdout;
	const stderr = deps.stderr ?? process.stderr;
	const log = (text: string): void => {
		try {
			stderr.write(`abai mcp: ${text}\n`);
		} catch {
			// nobody is listening
		}
	};
	const tools = new Map(toolsFor("mcp").map((spec) => [spec.name, spec]));
	const front: ToolFront = {
		form: "mcp",
		hasUI: false,
		confirm: () => Promise.resolve(false),
		...(deps.attach === undefined ? {} : { attach: deps.attach }),
	};
	let closed = false;
	// a session touchpoint is a step of the agent here: there is no person's loop to open. One the harness
	// already holds (a program inside its attach wait at session(), attached before this server existed)
	// is delivered now, the way the session form sweeps what was held when it is built
	harness.onSession = (touchpoint) => harness.noteTouchpoint(touchpoint);
	for (const touchpoint of harness.pendingTouchpointList()) {
		if (touchpoint.kind === "session") harness.noteTouchpoint(touchpoint);
	}
	harness.onDetach = (reason) => {
		if (!closed) log(`detached: ${reason} (abai_attach reattaches)`);
	};

	const write = (message: object): void => {
		if (closed || !output.writable) return;
		output.write(`${JSON.stringify(message)}\n`);
	};
	const respond = (id: JsonRpcId, result: unknown): void => write({ jsonrpc: "2.0", id, result });
	const fail = (id: JsonRpcId, code: number, message: string): void =>
		write({ jsonrpc: "2.0", id, error: { code, message } });
	const textResult = (text: string, isError = false): unknown => ({
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
	});

	/** Requests being answered, so an input that ends right after a request still gets it answered. */
	const inFlight = new Set<Promise<void>>();
	/** What the wakes since the last park handed the agent; settled at the next park. Several waits may be in flight. */
	let delivered: string[] = [];
	/** Parked waits by request id, so `notifications/cancelled` can cut one short. */
	const waits = new Map<JsonRpcId, AbortController>();

	const wait = async (id: JsonRpcId, args: Record<string, unknown>): Promise<string> => {
		harness.settleDelivered(delivered, PARKED_UNDECIDED);
		delivered = [];
		const asked = typeof args.wait_s === "number" ? args.wait_s : 25;
		const seconds = Math.min(asked, harness.options.waitMaxMs / 1000);
		const controller = new AbortController();
		waits.set(id, controller);
		try {
			const delivery = await harness.nextDelivery(seconds * 1000, controller.signal);
			if (delivery) {
				// accumulated, not replaced: a second wait in flight must not lose the first one's ids
				delivered.push(...delivery.ids);
				return delivery.text;
			}
			return controller.signal.aborted
				? `cancelled; ${harness.statusLine()}`
				: `no wake in ${seconds}s; ${harness.statusLine()}`;
		} finally {
			waits.delete(id);
		}
	};

	const callTool = async (id: JsonRpcId, params: unknown): Promise<void> => {
		if (!isRecord(params) || typeof params.name !== "string") {
			fail(id, INVALID_PARAMS, "tools/call needs a tool name");
			return;
		}
		const spec = tools.get(params.name);
		if (!spec) {
			fail(id, INVALID_PARAMS, `unknown tool ${params.name}`);
			return;
		}
		let args: Record<string, unknown>;
		try {
			args = validateArguments(spec, isRecord(params.arguments) ? params.arguments : {});
		} catch (error) {
			respond(id, textResult(`invalid arguments: ${errorMessage(error)}`, true));
			return;
		}
		try {
			// the park is the server's own: it settles the last delivery and remembers this one's ids
			const text = spec.name === "abai_wait" ? await wait(id, args) : await spec.run(harness, args as never, front);
			respond(id, textResult(text));
		} catch (error) {
			// a tool failure is a result the model can read, not a protocol error
			respond(id, textResult(errorMessage(error), true));
		}
	};

	const handle = async (message: JsonRpcMessage): Promise<void> => {
		const isNotification = message.id === undefined;
		if (
			message.id !== undefined &&
			message.id !== null &&
			typeof message.id !== "string" &&
			typeof message.id !== "number"
		) {
			fail(null, INVALID_REQUEST, "a request id must be a string, a number or null");
			return;
		}
		const id = message.id ?? null;
		if (typeof message.method !== "string") {
			// a message with an id and no method is a client's response to something: not ours to answer
			return;
		}
		if (isNotification) {
			// the one notification acted on: a client that cancelled a parked wait gets it back at once
			if (message.method === "notifications/cancelled" && isRecord(message.params)) {
				const requestId = message.params.requestId;
				if (typeof requestId === "string" || typeof requestId === "number") waits.get(requestId)?.abort();
			}
			return;
		}
		switch (message.method) {
			case "initialize": {
				const requested = isRecord(message.params) ? message.params.protocolVersion : undefined;
				const protocolVersion =
					typeof requested === "string" && MCP_PROTOCOL_VERSIONS.includes(requested)
						? requested
						: MCP_PROTOCOL_VERSIONS[0];
				respond(id, {
					protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: MCP_SERVER_NAME, version: ABAI_HARNESS_VERSION },
					instructions: harness.manifest ? harness.instructions() : DETACHED_INSTRUCTIONS,
				});
				return;
			}
			case "ping":
				respond(id, {});
				return;
			case "tools/list":
				respond(id, { tools: [...tools.values()].map(toolDescriptor) });
				return;
			case "tools/call":
				await callTool(id, message.params);
				return;
			default:
				fail(id, METHOD_NOT_FOUND, `method not found: ${message.method}`);
		}
	};

	return new Promise<number>((resolve) => {
		let done = false;
		const signals = deps.signals ?? (["SIGINT", "SIGTERM"] as NodeJS.Signals[]);
		/** The input ended: what is in flight is answered first, within a bound; a parked wait is cut short. */
		const drainThenFinish = (reason: string): void => {
			for (const controller of waits.values()) controller.abort();
			const pending = [...inFlight];
			if (pending.length === 0) {
				finish(reason);
				return;
			}
			const bound = new Promise<void>((done) => setTimeout(done, MCP_DRAIN_MS).unref());
			void Promise.race([Promise.allSettled(pending), bound]).then(() => finish(reason));
		};
		const finish = (reason: string): void => {
			if (done) return;
			done = true;
			closed = true;
			detachReader();
			for (const signal of signals) process.off(signal, onSignal);
			for (const controller of waits.values()) controller.abort();
			harness.shutdown(reason);
			log(reason);
			// stop consuming the input: a flowing, ref'd stdin would keep the process alive
			try {
				input.pause();
				if (input !== process.stdin) input.destroy();
			} catch {
				// ignore
			}
			resolve(0);
		};
		const onSignal = (): void => finish("signalled; the harness exited");
		for (const signal of signals) process.on(signal, onSignal);
		output.on("error", () => finish("output closed; the harness exited"));
		const detachReader = attachCappedLineReader(
			input,
			MCP_MAX_LINE_BYTES,
			(line) => {
				if (line.trim() === "") return;
				let message: unknown;
				try {
					message = JSON.parse(line);
				} catch {
					fail(null, PARSE_ERROR, "parse error");
					return;
				}
				if (!isRecord(message)) {
					// batches (arrays) are not accepted: the advertised revisions do not require them
					fail(null, INVALID_REQUEST, "invalid request");
					return;
				}
				// requests run concurrently: a parked abai_wait must not block the rest
				const running = handle(message as JsonRpcMessage).finally(() => inFlight.delete(running));
				inFlight.add(running);
			},
			() => finish("input line too long; the harness exited"),
		);
		input.once("end", () => drainThenFinish("input ended; the harness exited"));
		input.once("close", () => drainThenFinish("input closed; the harness exited"));
		input.once("error", () => finish("input failed; the harness exited"));
	});
}
