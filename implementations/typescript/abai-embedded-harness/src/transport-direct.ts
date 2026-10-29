// The direct binding: the harness in the program's process, driving the
// stub's HarnessBinding (abaigrammar section 6.1 and 6.2). Every channel is
// a function call; nothing crosses a boundary. Claims are a no-op: the stub
// asks the harness every declared decision.
import type { Consent, HarnessBinding } from "abai";
import type {
	AuditData,
	StubTransport,
	TransportCells,
	TransportContent,
	TransportEvents,
	TransportHello,
	TransportKnobOutcome,
	TransportListeners,
} from "./transport.ts";
import { TransportCallError } from "./transport.ts";

export class DirectTransport implements StubTransport {
	readonly hello: TransportHello;
	readonly denseSeq = true;
	private readonly binding: HarnessBinding;
	private readonly unsubscribe: Array<() => void> = [];
	private readonly listeners: { [K in keyof TransportListeners]: Set<TransportListeners[K]> } = {
		event: new Set(),
		decision: new Set(),
		decision_timeout: new Set(),
		decision_rejected: new Set(),
		turn: new Set(),
		touchpoint: new Set(),
		claims_released: new Set(),
		close: new Set(),
	};
	private _open = true;

	constructor(binding: HarnessBinding) {
		this.binding = binding;
		this.hello = {
			name: binding.name,
			abaigrammar: binding.manifest.abaigrammar,
			modes: [...binding.manifest.modes],
			pid: process.pid,
			cwd: process.cwd(),
			connection: binding.connection,
			extensions: [],
		};
		this.unsubscribe.push(
			binding.on("event", (event) => this.notify("event", event)),
			binding.on("decision", (request) =>
				this.notify("decision", {
					id: request.id,
					name: request.name,
					context: request.context,
					deadline: request.deadline,
				}),
			),
			binding.on("decision_timeout", (id, name) => this.notify("decision_timeout", id, name)),
			binding.on("turn", (request) =>
				this.notify("turn", {
					id: request.id,
					name: request.name,
					deadline: request.deadline,
					content: request.content,
				}),
			),
			binding.on("touchpoint", (request) => this.notify("touchpoint", request)),
			binding.on("detach", (reason) => {
				this._open = false;
				this.notify("close", reason);
			}),
		);
	}

	get open(): boolean {
		return this._open && this.binding.attached;
	}

	private notify<K extends keyof TransportListeners>(type: K, ...args: Parameters<TransportListeners[K]>): void {
		for (const listener of this.listeners[type]) {
			try {
				(listener as (...a: Parameters<TransportListeners[K]>) => void)(...args);
			} catch {
				// a harness listener's failure stays with the harness
			}
		}
	}

	private assertOpen(): void {
		if (!this.open) throw new TransportCallError("detached", "not attached to a program");
	}

	async manifest() {
		this.assertOpen();
		return this.binding.manifest;
	}

	async content(): Promise<TransportContent> {
		this.assertOpen();
		return this.binding.content();
	}

	async cells(names?: string[]): Promise<TransportCells> {
		this.assertOpen();
		return this.binding.readCells(names);
	}

	async events(after: number): Promise<TransportEvents> {
		this.assertOpen();
		return this.binding.readEvents(after);
	}

	async setCell(name: string, value: unknown, reason: string, consent?: Consent): Promise<TransportKnobOutcome> {
		this.assertOpen();
		return this.binding.writeKnob(name, value, reason, consent);
	}

	async call(
		name: string,
		params: Record<string, unknown> | undefined,
		reason: string,
		_timeoutMs: number,
		consent?: Consent,
	): Promise<unknown> {
		this.assertOpen();
		try {
			return await this.binding.call(name, params, reason, consent);
		} catch (error) {
			if (error instanceof Error && "code" in error) {
				throw new TransportCallError((error as { code: TransportCallError["code"] }).code, error.message);
			}
			throw error;
		}
	}

	async audit(limit = 100): Promise<AuditData> {
		this.assertOpen();
		return this.binding.auditTail(limit);
	}

	async claim(decisions: string[]): Promise<string[]> {
		this.assertOpen();
		return decisions;
	}

	async release(): Promise<string[]> {
		return [];
	}

	answer(id: string, result: unknown, reason: string, consent?: Consent): void {
		this.binding.answerDecision(id, result, reason, consent);
	}

	endTurn(id: string, cause?: string): void {
		this.binding.endTurn(id, undefined, cause);
	}

	/** In-process modes have no lifecycle channel (section 5.5): `status` is answered, nothing else. */
	async lifecycle(op: string, reason: string, consent?: Consent): Promise<unknown> {
		this.assertOpen();
		if (op !== "status") {
			throw new TransportCallError(
				"invalid",
				`no lifecycle channel in ${this.hello.modes[0] ?? "this"} mode (section 5.5)`,
			);
		}
		const outcome = this.binding.lifecycle(op, reason, consent);
		if (!outcome.ok) throw new TransportCallError(outcome.code, outcome.error);
		return outcome.data;
	}

	endTouchpoint(id: string): void {
		this.binding.endTouchpoint(id);
	}

	on<K extends keyof TransportListeners>(type: K, listener: TransportListeners[K]): () => void {
		const set = this.listeners[type] as Set<TransportListeners[K]>;
		set.add(listener);
		return () => {
			set.delete(listener);
		};
	}

	close(reason: string): void {
		if (!this._open) return;
		this._open = false;
		for (const off of this.unsubscribe.splice(0)) off();
		this.binding.detach(reason);
		this.notify("close", reason);
	}
}
