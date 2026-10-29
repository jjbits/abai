// The stub's sidecar endpoint (abaigrammar section 6.3): the receiving end a
// harness in another process connects to. Wire protocol v1 over a Unix
// socket, listening from startup so an outside harness reaches a running
// program that never calls a touchpoint, and so a lost connection is
// restored by the harness connecting again.
//
// One binding, many connections. The first connection attaches the program
// (one DirectBinding, which every channel runs through); the last one
// leaving detaches it, so what was open settles as detached. Every act is
// audited under the connection that made it. Decisions go to the one
// connection that claimed them; turns and touchpoints are broadcast, and
// the first end settles one.
//
// Nothing here keeps the program alive, and nothing here lets it die
// mid-touchpoint: the server and its sockets are unref'd, so a program whose
// work is done exits with a harness still connected, while a pending
// decision, turn or touchpoint holds a ref'd timer of its own in the binding.
import { Buffer } from "node:buffer";
import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	CallError,
	type CallErrorCode,
	type Consent,
	type DecisionRequest,
	type DirectBinding,
	type LiveEvent,
	type TouchpointRequest,
	type TurnRequest,
} from "./harness-binding.ts";
import { durationMs } from "./manifest/manifest.ts";
import type { Abaigram } from "./program.ts";
import {
	assertSocketPathLength,
	attachCappedLineReader,
	DEFAULT_MAX_LINE_BYTES,
	defaultSocketPath,
	EXTENSIONS,
	ensureRunDir,
	type HelloMessage,
	MAX_SOCKET_PATH_BYTES,
	PROTOCOL_VERSION,
	removeDescriptor,
	type WireErrorCode,
	type WireResponse,
	writeDescriptor,
} from "./wire/index.ts";

/**
 * Where the socket goes when the run directory's own path is too long for
 * one (103 bytes on macOS, and a run directory under a deep project path
 * gets there): a private directory under the machine's temp dir. The
 * descriptor in the run directory names the socket wherever it is, which is
 * what its `socket` field is for, so discovery is unchanged.
 */
export function shortSocketPath(pid: number): string {
	// per user: the temp dir is shared on Linux, and the directory is made private to whoever creates it
	const uid = typeof process.getuid === "function" ? String(process.getuid()) : "u";
	return join(tmpdir(), `abai-sockets-${uid}`, `${pid}.sock`);
}

export interface EndpointOptions {
	/** Where the socket and the descriptor go. */
	runDir: string;
	/** The socket path; default `<runDir>/<pid>.sock`. */
	socketPath?: string;
	/** A connection whose unsent output exceeds this many bytes is dropped whole. Default 16 MiB. */
	maxBuffered?: number;
	/** An input line past this many bytes drops the connection. Default 64 MiB. */
	maxLineBytes?: number;
}

/** Unsent bytes a connection may hold before it is dropped: a harness that cannot keep up is not the program's problem. */
export const DEFAULT_MAX_BUFFERED = 16 * 1024 * 1024;
/** Consecutive claim timeouts after which a connection's claims are released: a harness that never answers holds nothing. */
export const CONSECUTIVE_TIMEOUTS_LIMIT = 3;
/** How long a socket gets to flush when the endpoint closes it. */
const CLOSE_GRACE_MS = 200;

interface Connection {
	id: string;
	socket: Socket;
	/** The event filter: `include` restricts to the listed types; `exclude` drops them. */
	include: Set<string> | undefined;
	exclude: Set<string>;
	claims: Set<string>;
	/** A claim's own wait, never longer than the manifest's. */
	claimTimeoutMs: number | undefined;
	consecutiveTimeouts: number;
	/** Bumped on every timeout; a hook sent before the last timeout counts once with its batch. */
	timeoutEpoch: number;
	detachReader: () => void;
}

interface PendingHook {
	id: string;
	name: string;
	connection: Connection;
	epochAtSend: number;
	/** The claim's shorter wait, when it has one. */
	timer: NodeJS.Timeout | undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function line(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

export class Endpoint {
	readonly runDir: string;
	readonly socketPath: string;
	/** Resolves once the socket listens and the descriptor is written; rejects with why it could not. */
	readonly ready: Promise<void>;
	private readonly app: Abaigram;
	private readonly maxBuffered: number;
	private readonly maxLineBytes: number;
	private server: Server | undefined;
	private readonly connections = new Set<Connection>();
	private readonly claimants = new Map<string, Connection>();
	private readonly hooks = new Map<string, PendingHook>();
	/** Open turns and touchpoints, replayed to a connection that arrives while they are open. */
	private readonly openTurns = new Map<string, TurnRequest>();
	private readonly openTouchpoints = new Map<string, TouchpointRequest>();
	private readonly connectionWaiters: Array<() => void> = [];
	private binding: DirectBinding | undefined;
	private unsubscribe: Array<() => void> = [];
	private nextConnectionId = 1;
	private closed = false;
	private readonly onExit: () => void;
	private settleReady: { resolve: () => void; reject: (error: Error) => void } | undefined;

	constructor(app: Abaigram, options: EndpointOptions) {
		this.app = app;
		this.runDir = options.runDir;
		const preferred = options.socketPath ?? defaultSocketPath(options.runDir, process.pid);
		// an explicit path is used as given; the default falls back to a short one when it does not fit
		this.socketPath =
			options.socketPath === undefined && Buffer.byteLength(preferred) > MAX_SOCKET_PATH_BYTES
				? shortSocketPath(process.pid)
				: preferred;
		this.maxBuffered = options.maxBuffered ?? DEFAULT_MAX_BUFFERED;
		this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
		this.onExit = () => this.removeFiles();
		this.ready = new Promise<void>((resolve, reject) => {
			this.settleReady = { resolve, reject };
		});
		this.listen();
	}

	private resolveReady(): void {
		const settle = this.settleReady;
		this.settleReady = undefined;
		settle?.resolve();
	}

	private rejectReady(error: unknown): void {
		const settle = this.settleReady;
		this.settleReady = undefined;
		settle?.reject(error instanceof Error ? error : new Error(String(error)));
	}

	get connectionCount(): number {
		return this.connections.size;
	}

	/** The ids of the open connections, in order of arrival. */
	connectionIds(): string[] {
		return [...this.connections].map((connection) => connection.id);
	}

	private listen(): void {
		try {
			assertSocketPathLength(this.socketPath);
			ensureRunDir(this.runDir);
			if (this.socketPath !== defaultSocketPath(this.runDir, process.pid)) ensureRunDir(dirname(this.socketPath));
			// a socket file left by an earlier life of this very pid number: nobody else writes to this name.
			// (A second Abaigram under sidecar in the same process would take over the first one's socket here;
			// one program is one endpoint, and a test suite that builds several keeps them in turns mode.)
			if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
		} catch (error) {
			this.rejectReady(error);
			return;
		}
		const server = createServer((socket) => this.accept(socket));
		this.server = server;
		server.once("error", (error) => this.rejectReady(error));
		server.listen(this.socketPath, () => {
			server.unref();
			try {
				writeDescriptor(this.runDir, {
					pid: process.pid,
					socket: this.socketPath,
					cwd: process.cwd(),
					name: this.app.name,
					mode: this.app.mode,
					startedAt: new Date().toISOString(),
				});
			} catch (error) {
				server.close();
				this.rejectReady(error);
				return;
			}
			process.once("exit", this.onExit);
			this.resolveReady();
		});
	}

	/** Resolves true as soon as a connection is open, or when one arrives within `timeoutMs`; false when none does. */
	waitForConnection(timeoutMs: number): Promise<boolean> {
		if (this.connections.size > 0) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				const index = this.connectionWaiters.indexOf(waiter);
				if (index !== -1) this.connectionWaiters.splice(index, 1);
				resolve(false);
			}, timeoutMs);
			const waiter = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(true);
			};
			this.connectionWaiters.push(waiter);
		});
	}

	/** Stop listening, drop every connection, remove the socket and the descriptor. */
	close(reason = "the endpoint closed"): void {
		if (this.closed) return;
		this.closed = true;
		// closed before it listened: whoever awaits `ready` is told, rather than left waiting
		this.rejectReady(new Error(reason));
		for (const connection of [...this.connections]) this.drop(connection, reason);
		this.server?.close();
		this.removeFiles();
		process.off("exit", this.onExit);
	}

	private removeFiles(): void {
		try {
			removeDescriptor(this.runDir, process.pid);
		} catch {
			// nothing to remove
		}
		try {
			if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
		} catch {
			// a socket file that cannot be removed is pruned by the next listing
		}
	}

	// -----------------------------------------------------------------------
	// Connections
	// -----------------------------------------------------------------------

	private accept(socket: Socket): void {
		if (this.closed) {
			socket.destroy();
			return;
		}
		// a connected harness never holds the program open; what holds it is the program's own pending work
		socket.unref();
		socket.setNoDelay?.(true);
		const connection: Connection = {
			id: `k${this.nextConnectionId++}`,
			socket,
			include: undefined,
			exclude: new Set(),
			claims: new Set(),
			claimTimeoutMs: undefined,
			consecutiveTimeouts: 0,
			timeoutEpoch: 0,
			detachReader: () => {},
		};
		let binding: DirectBinding;
		try {
			binding = this.bindingFor(connection);
		} catch (error) {
			// the program is attached some other way (an in-process harness): this connection cannot be served,
			// and the one line saying so is flushed before the socket ends
			socket.end(
				line({ type: "response", command: "hello", success: false, error: errorMessage(error), code: "error" }),
			);
			return;
		}
		socket.on("error", () => this.drop(connection, "the connection failed"));
		socket.on("close", () => this.drop(connection, "the connection closed"));
		connection.detachReader = attachCappedLineReader(
			socket,
			this.maxLineBytes,
			(text) => this.onLine(connection, text),
			() => this.drop(connection, `a line exceeded ${this.maxLineBytes} bytes`),
		);
		this.connections.add(connection);
		this.write(connection, line(this.hello(connection, binding)));
		// a harness that connects while the program waits at a touchpoint or a turn is told at once
		for (const turn of this.openTurns.values()) this.write(connection, line(this.turnMessage(turn)));
		for (const touchpoint of this.openTouchpoints.values()) {
			this.write(connection, line(this.touchpointMessage(touchpoint)));
		}
		for (const waiter of this.connectionWaiters.splice(0)) waiter();
	}

	/** The one binding every connection shares, created by the first. Its own label is for acts no connection made. */
	private bindingFor(_connection: Connection): DirectBinding {
		if (this.binding) return this.binding;
		const binding = this.app.bind("endpoint");
		this.binding = binding;
		this.unsubscribe = [
			binding.on("event", (event) => this.broadcastEvent(event)),
			binding.on("decision", (request) => this.onDecision(request)),
			binding.on("decision_timeout", (id, name) => this.onDecisionTimeout(id, name)),
			binding.on("turn", (request) => this.onTurn(request)),
			binding.on("touchpoint", (request) => this.onTouchpoint(request)),
			binding.on("detach", (reason) => this.onDetach(reason)),
		];
		return binding;
	}

	private hello(connection: Connection, binding: DirectBinding): HelloMessage {
		const { manifest } = this.app;
		return {
			type: "hello",
			protocol: PROTOCOL_VERSION,
			pid: process.pid,
			cwd: process.cwd(),
			mode: this.app.mode,
			capabilities: {
				hooks: manifest.decisions.filter((d) => d.policy !== "forbid").map((d) => d.name),
				commands: manifest.capabilities.filter((c) => c.policy !== "forbid").map((c) => c.name),
			},
			lastSeq: this.app.region.lastSeq,
			connection: connection.id,
			abai: {
				name: manifest.name,
				abaigrammar: manifest.abaigrammar,
				modes: [...manifest.modes],
				audit: binding.auditInfo(),
				extensions: [...EXTENSIONS],
			},
		};
	}

	private write(connection: Connection, text: string): void {
		const { socket } = connection;
		if (socket.destroyed || !socket.writable) return;
		socket.write(text);
		if (socket.writableLength > this.maxBuffered) this.drop(connection, "the connection fell too far behind");
	}

	private drop(connection: Connection, reason: string): void {
		if (!this.connections.delete(connection)) return;
		connection.detachReader();
		for (const name of connection.claims) {
			if (this.claimants.get(name) === connection) this.claimants.delete(name);
		}
		connection.claims.clear();
		// what this connection was asked, nobody will answer now
		for (const hook of [...this.hooks.values()]) {
			if (hook.connection !== connection) continue;
			this.forget(hook);
			this.binding?.defaultDecision(hook.id, "detached", connection.id);
		}
		if (!connection.socket.destroyed) {
			connection.socket.end();
			const timer = setTimeout(() => connection.socket.destroy(), CLOSE_GRACE_MS);
			timer.unref();
		}
		if (this.connections.size === 0 && this.binding) {
			const binding = this.binding;
			this.releaseBinding();
			binding.detach(`the last harness connection closed (${reason})`);
		}
	}

	/** Forget the binding and everything pending on it, every timer included: a finished program must be free to exit. */
	private releaseBinding(): void {
		this.binding = undefined;
		for (const off of this.unsubscribe.splice(0)) off();
		for (const hook of [...this.hooks.values()]) this.forget(hook);
		this.openTurns.clear();
		this.openTouchpoints.clear();
	}

	/** The program detached the binding itself: whoever is still connected is told by the close. */
	private onDetach(_reason: string): void {
		if (!this.binding) return;
		this.releaseBinding();
		for (const connection of [...this.connections]) this.drop(connection, "the program detached");
	}

	// -----------------------------------------------------------------------
	// Lines in
	// -----------------------------------------------------------------------

	private onLine(connection: Connection, text: string): void {
		if (text.trim() === "") return;
		let message: unknown;
		try {
			message = JSON.parse(text);
		} catch {
			this.respond(connection, { type: "response", command: "unknown", success: false, error: "invalid json" });
			return;
		}
		if (!isRecord(message)) {
			this.respond(connection, { type: "response", command: "unknown", success: false, error: "invalid message" });
			return;
		}
		const reason = typeof message.reason === "string" ? message.reason : undefined;
		const consent = isConsent(message.consent) ? message.consent : undefined;
		switch (message.type) {
			case "request": {
				const id = message.id;
				if (typeof id !== "string" || id === "") {
					this.respond(connection, {
						type: "response",
						command: "request",
						success: false,
						error: "request id must be a non-empty string",
						code: "invalid",
					});
					return;
				}
				void this.dispatch(connection, id, message.command, reason, consent);
				return;
			}
			case "hook_response":
				this.onHookResponse(connection, message.id, message.result, reason, consent);
				return;
			case "turn_end":
				if (typeof message.id === "string") {
					this.openTurns.delete(message.id);
					this.binding?.endTurn(
						message.id,
						connection.id,
						typeof message.cause === "string" ? message.cause : undefined,
					);
				}
				return;
			case "touchpoint_end":
				if (typeof message.id === "string") {
					this.openTouchpoints.delete(message.id);
					this.binding?.endTouchpoint(message.id);
				}
				return;
			default:
				this.respond(connection, {
					type: "response",
					...(typeof message.id === "string" ? { id: message.id } : {}),
					command: "unknown",
					success: false,
					error: `unknown message type: ${String(message.type)}`,
					code: "unknown",
				});
		}
	}

	private respond(connection: Connection, response: WireResponse): void {
		try {
			this.write(connection, line(response));
		} catch (error) {
			// a result that cannot be serialized becomes an error response; the connection stays
			const failed: WireResponse = {
				type: "response",
				...(response.id === undefined ? {} : { id: response.id }),
				command: response.command,
				success: false,
				error: `the response could not be serialized: ${errorMessage(error)}`,
				code: "error",
			};
			this.write(connection, line(failed));
		}
	}

	private failure(id: string, command: string, error: string, code: WireErrorCode): WireResponse {
		return { type: "response", id, command, success: false, error, code };
	}

	/** Run one request, answer it when it settles. Never rejects. */
	private async dispatch(
		connection: Connection,
		id: string,
		command: unknown,
		reason: string | undefined,
		consent: Consent | undefined,
	): Promise<void> {
		if (!isRecord(command) || typeof command.type !== "string") {
			this.respond(connection, this.failure(id, "unknown", "command must be an object with a type", "invalid"));
			return;
		}
		const type = command.type;
		const binding = this.binding;
		if (!binding) {
			this.respond(connection, this.failure(id, type, "the program is no longer attached", "error"));
			return;
		}
		let response: WireResponse;
		try {
			switch (type) {
				case "ping":
					response = {
						type: "response",
						id,
						command: type,
						success: true,
						data: { pid: process.pid, ts: Date.now() },
					};
					break;
				case "subscribe":
					response = this.subscribe(connection, id, command);
					break;
				case "claim_hooks":
					response = this.claim(connection, id, command);
					break;
				case "release_hooks":
					response = this.release(connection, id, command);
					break;
				case "get_manifest":
					response = { type: "response", id, command: type, success: true, data: { manifest: this.app.manifest } };
					break;
				case "get_content": {
					const content = binding.content();
					const turns: Record<string, string> = {};
					for (const turn of this.app.manifest.turns) {
						const text = content.turn(turn.name);
						if (text !== undefined) turns[turn.name] = text;
					}
					response = {
						type: "response",
						id,
						command: type,
						success: true,
						data: {
							identity: content.identity,
							...(content.install === undefined ? {} : { install: content.install }),
							...(content.use === undefined ? {} : { use: content.use }),
							turns,
						},
					};
					break;
				}
				case "get_audit": {
					const limit = typeof command.limit === "number" && command.limit > 0 ? Math.floor(command.limit) : 100;
					response = {
						type: "response",
						id,
						command: type,
						success: true,
						data: { ...binding.auditInfo(), ...binding.auditTail(limit) },
					};
					break;
				}
				case "get_cells": {
					const reading = binding.readCells();
					const cells: Record<string, unknown> = {};
					for (const [name, cell] of Object.entries(reading.cells)) cells[name] = cell.value;
					response = { type: "response", id, command: type, success: true, data: { seq: reading.seq, cells } };
					break;
				}
				case "lifecycle": {
					if (typeof command.op !== "string") {
						response = this.failure(id, type, "lifecycle needs an op", "invalid");
						break;
					}
					const outcome = binding.lifecycle(command.op, reason ?? "", consent, connection.id);
					response = outcome.ok
						? {
								type: "response",
								id,
								command: type,
								success: true,
								data: outcome.data ?? { op: command.op, done: true },
							}
						: this.failure(id, type, outcome.error, outcome.code);
					break;
				}
				case "set_cell": {
					if (typeof command.name !== "string") {
						response = this.failure(id, type, "set_cell needs a cell name", "invalid");
						break;
					}
					const outcome = await binding.writeKnob(
						command.name,
						command.value,
						reason ?? "",
						consent,
						connection.id,
					);
					response =
						outcome.outcome === "done"
							? {
									type: "response",
									id,
									command: type,
									success: true,
									data: { name: command.name, value: outcome.value },
								}
							: this.failure(
									id,
									type,
									outcome.error ?? `${command.name} was not written`,
									outcome.code ?? "error",
								);
					break;
				}
				default: {
					const { type: _type, ...params } = command;
					const result = await binding.call(type, params, reason ?? "", consent, connection.id);
					response = { type: "response", id, command: type, success: true, data: result };
				}
			}
		} catch (error) {
			const code: CallErrorCode = error instanceof CallError ? error.code : "error";
			response = this.failure(id, type, errorMessage(error), code);
		}
		this.respond(connection, response);
	}

	private subscribe(connection: Connection, id: string, command: Record<string, unknown>): WireResponse {
		const names = (value: unknown): string[] | undefined =>
			Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
		const include = command.include === undefined ? undefined : names(command.include);
		const exclude = command.exclude === undefined ? [] : names(command.exclude);
		if ((command.include !== undefined && include === undefined) || exclude === undefined) {
			return this.failure(id, "subscribe", "include and exclude must be arrays of event names", "invalid");
		}
		connection.include = include === undefined ? undefined : new Set(include);
		connection.exclude = new Set(exclude);
		return {
			type: "response",
			id,
			command: "subscribe",
			success: true,
			data: { ...(include === undefined ? {} : { include }), exclude },
		};
	}

	// -----------------------------------------------------------------------
	// Events
	// -----------------------------------------------------------------------

	private accepts(connection: Connection, name: string): boolean {
		if (connection.include !== undefined && !connection.include.has(name)) return false;
		return !connection.exclude.has(name);
	}

	private broadcastEvent(event: LiveEvent): void {
		const targets = [...this.connections].filter((connection) => this.accepts(connection, event.name));
		if (targets.length === 0) return;
		let text: string;
		try {
			text = line({
				type: "event",
				seq: event.seq,
				ts: event.ts,
				event: { type: event.name, ...(event.payload ?? {}) },
				...(event.truncated ? { truncated: true } : {}),
			});
		} catch (error) {
			text = line({
				type: "serialize_error",
				seq: event.seq,
				ts: event.ts,
				eventType: event.name,
				error: errorMessage(error),
			});
		}
		for (const connection of targets) this.write(connection, text);
	}

	// -----------------------------------------------------------------------
	// Decisions as hooks
	// -----------------------------------------------------------------------

	private claim(connection: Connection, id: string, command: Record<string, unknown>): WireResponse {
		const hooks = command.hooks;
		const declared = new Map(this.app.manifest.decisions.map((d) => [d.name, d]));
		if (!Array.isArray(hooks) || hooks.length === 0 || !hooks.every((h) => typeof h === "string")) {
			return this.failure(id, "claim_hooks", "hooks must be a non-empty array of decision names", "invalid");
		}
		const timeoutMs = command.timeoutMs;
		if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1)) {
			return this.failure(id, "claim_hooks", "timeoutMs must be a positive integer", "invalid");
		}
		// all or nothing: every name is checked before any is taken
		for (const name of hooks as string[]) {
			const decl = declared.get(name);
			if (!decl) return this.failure(id, "claim_hooks", `unknown decision: ${name}`, "unknown");
			if (decl.policy === "forbid") {
				return this.failure(id, "claim_hooks", `decision ${name} is forbidden by policy`, "forbidden");
			}
			const holder = this.claimants.get(name);
			if (holder !== undefined && holder !== connection) {
				return this.failure(id, "claim_hooks", `decision ${name} is held by connection ${holder.id}`, "denied");
			}
		}
		for (const name of hooks as string[]) {
			this.claimants.set(name, connection);
			connection.claims.add(name);
		}
		// the wait in force: the claim's own, which may only shorten the shortest declared among what it holds
		const shortest = Math.min(
			...[...connection.claims].map((name) => durationMs(declared.get(name)?.timeout ?? "30s")),
		);
		if (timeoutMs !== undefined) connection.claimTimeoutMs = Math.min(timeoutMs, shortest);
		return {
			type: "response",
			id,
			command: "claim_hooks",
			success: true,
			data: { hooks: [...connection.claims], timeoutMs: Math.min(connection.claimTimeoutMs ?? shortest, shortest) },
		};
	}

	private release(connection: Connection, id: string, command: Record<string, unknown>): WireResponse {
		let names: string[];
		if (command.hooks === undefined) names = [...connection.claims];
		else if (Array.isArray(command.hooks) && command.hooks.every((h) => typeof h === "string")) {
			names = command.hooks as string[];
		} else return this.failure(id, "release_hooks", "hooks must be an array of decision names", "invalid");
		const released = this.releaseClaims(connection, names);
		return { type: "response", id, command: "release_hooks", success: true, data: { released } };
	}

	/** Free some of a connection's claims; what it was asked under them takes the default now. */
	private releaseClaims(connection: Connection, names: string[]): string[] {
		const released: string[] = [];
		for (const name of names) {
			if (!connection.claims.has(name)) continue;
			connection.claims.delete(name);
			if (this.claimants.get(name) === connection) this.claimants.delete(name);
			released.push(name);
		}
		for (const hook of [...this.hooks.values()]) {
			if (hook.connection !== connection || !released.includes(hook.name)) continue;
			this.forget(hook);
			// for this decision its claimant is gone, which is what detached means (section 5.4)
			this.binding?.defaultDecision(hook.id, "detached", connection.id);
		}
		return released;
	}

	private forget(hook: PendingHook): void {
		this.hooks.delete(hook.id);
		if (hook.timer !== undefined) clearTimeout(hook.timer);
	}

	/** The program asked a decision: it goes to the claimant, or takes its default now. */
	private onDecision(request: DecisionRequest): void {
		const binding = this.binding;
		if (!binding) return;
		const connection = this.claimants.get(request.name);
		if (!connection) {
			binding.defaultDecision(request.id, "no_harness");
			return;
		}
		binding.assignDecision(request.id, connection.id);
		const remaining = Math.max(0, request.deadline - this.app.now());
		const timeoutMs =
			connection.claimTimeoutMs === undefined ? remaining : Math.min(remaining, connection.claimTimeoutMs);
		let text: string;
		try {
			text = line({ type: "hook", id: request.id, hook: request.name, timeoutMs, payload: request.context });
		} catch (error) {
			// the context cannot cross: the claimant is told, and the program goes on with the default
			const message = `payload could not be serialized: ${errorMessage(error)}`;
			this.write(connection, line({ type: "hook_rejected", id: request.id, hook: request.name, error: message }));
			binding.defaultDecision(request.id, "invalid", connection.id);
			return;
		}
		const hook: PendingHook = {
			id: request.id,
			name: request.name,
			connection,
			epochAtSend: connection.timeoutEpoch,
			timer: undefined,
		};
		if (timeoutMs < remaining) {
			// the claim's own wait, shorter than the manifest's: the default is applied then, through the one path
			hook.timer = setTimeout(() => binding.defaultDecision(request.id, "timeout", connection.id), timeoutMs);
		}
		this.hooks.set(request.id, hook);
		this.write(connection, text);
	}

	/** The binding settled a decision by timeout (its deadline, or the claim's wait through `defaultDecision`). */
	private onDecisionTimeout(id: string, name: string): void {
		const hook = this.hooks.get(id);
		if (!hook) return;
		this.forget(hook);
		const { connection } = hook;
		this.write(connection, line({ type: "hook_timeout", id, hook: name }));
		// a batch that timed out together counts once
		if (hook.epochAtSend === connection.timeoutEpoch) connection.consecutiveTimeouts += 1;
		connection.timeoutEpoch += 1;
		if (connection.consecutiveTimeouts >= CONSECUTIVE_TIMEOUTS_LIMIT) {
			connection.consecutiveTimeouts = 0;
			const released = this.releaseClaims(connection, [...connection.claims]);
			this.write(connection, line({ type: "hook_claims_released", reason: "timeouts", hooks: released }));
		}
	}

	private onHookResponse(
		connection: Connection,
		id: unknown,
		result: unknown,
		reason: string | undefined,
		consent: Consent | undefined,
	): void {
		if (typeof id !== "string") return;
		const hook = this.hooks.get(id);
		// ignored unless this very connection was asked: a late or a stray answer writes nothing
		if (!hook || hook.connection !== connection) return;
		this.forget(hook);
		try {
			this.binding?.answerDecision(
				id,
				result ?? null,
				reason ?? "no reason stated by the harness",
				consent,
				connection.id,
			);
			// only an accepted answer resets the streak
			connection.consecutiveTimeouts = 0;
		} catch (error) {
			this.write(connection, line({ type: "hook_rejected", id, hook: hook.name, error: errorMessage(error) }));
		}
	}

	// -----------------------------------------------------------------------
	// Turns and touchpoints, broadcast
	// -----------------------------------------------------------------------

	private turnMessage(request: TurnRequest) {
		return {
			type: "turn",
			id: request.id,
			name: request.name,
			timeoutMs: Math.max(0, request.deadline - this.app.now()),
			...(request.content === undefined ? {} : { content: request.content }),
		};
	}

	private touchpointMessage(request: TouchpointRequest) {
		return {
			type: "touchpoint",
			id: request.id,
			kind: request.kind,
			...(request.content === undefined ? {} : { content: request.content }),
		};
	}

	private onTurn(request: TurnRequest): void {
		this.openTurns.set(request.id, request);
		// a turn ends on its own at its deadline, and this map must not remember it past that
		const timer = setTimeout(
			() => this.openTurns.delete(request.id),
			Math.max(0, request.deadline - this.app.now()) + 1,
		);
		timer.unref();
		const text = line(this.turnMessage(request));
		for (const connection of [...this.connections]) this.write(connection, text);
	}

	private onTouchpoint(request: TouchpointRequest): void {
		this.openTouchpoints.set(request.id, request);
		const text = line(this.touchpointMessage(request));
		for (const connection of [...this.connections]) this.write(connection, text);
	}
}

function isConsent(value: unknown): value is Consent {
	return value === "approved" || value === "auto" || value === "denied";
}
