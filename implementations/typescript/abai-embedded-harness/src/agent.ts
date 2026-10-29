// The session form (abaigrammar section 6.1): the harness's own agent, an
// @arx-06/agent Agent with the abai tools, running in the program's process.
// In turns mode the agent runs only while a touchpoint is open: a wake that
// arrives outside one waits in the scheduler and is coalesced into the next
// touchpoint's delivery. A delivery names the decisions, turns and
// touchpoints it carries; when the run that received them ends, exactly
// those are settled: turns end, install returns, and a decision the run did
// not answer takes its default with the reason recorded. Nothing is injected
// into a run in progress: a wake that arrives during one waits for its end
// and starts the next run, the person's waiting prompt going first, so a
// stream of wakes and a slow model can never chain one run forever. Each
// answer is said to the person as it is produced.
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@arx-06/agent";
import type { Model, TextContent } from "@arx-06/ai";
import type { TSchema } from "typebox";
import type { Harness } from "./harness.ts";
import { type HarnessToolSpec, type ToolFront, toolsFor } from "./tools.ts";
import type { UserChannel } from "./user-channel.ts";

export interface AgentModel {
	model: Model<any>;
	streamFn: StreamFn;
}

export type SessionMode = "turns" | "live";

export interface SessionFormOptions {
	harness: Harness;
	model: AgentModel;
	/** The person; undefined for a headless run. */
	channel?: UserChannel;
	/** The owner's appended text, which ends the composed prompt. */
	addendum?: string;
	/** Consent timeout for `confirm` (the manifest's `confirm_timeout`); default 60 s. */
	confirmTimeoutMs?: number;
	/** `turns`: the agent runs only inside touchpoints. Default: from the program's first declared mode. */
	mode?: SessionMode;
	/** How long the first contact with the model may take; past it the harness detaches (section 4.3). Default 30 s. */
	connectTimeoutMs?: number;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

/** An abai tool as the agent loop's tool. */
export function toAgentTool(spec: HarnessToolSpec, harness: Harness, front: ToolFront): AgentTool<TSchema> {
	return {
		name: spec.name,
		label: spec.name,
		description: spec.description,
		parameters: spec.parameters,
		async execute(_toolCallId, params) {
			const text = await spec.run(harness, params as never, front);
			return { content: [{ type: "text", text } as TextContent], details: {} };
		},
	};
}

export class SessionForm {
	readonly agent: Agent;
	readonly harness: Harness;
	readonly mode: SessionMode;
	private readonly channel: UserChannel | undefined;
	/** Ids the current run has received: settled when it ends. */
	private delivered = new Set<string>();
	/** A run this form started is in flight. */
	private running = false;
	/** The person's prompt is waiting for a wake run to end; no new wake run starts before it. */
	private personWaiting = false;
	private closed = false;
	/** The model has answered once; before that, the connect timeout bounds a run. */
	private contacted = false;
	/** The person's loop while it runs (the sidecar session, or a session touchpoint); callers join it. */
	private conversation: Promise<void> | undefined;
	/** Why the model could not be reached, once the form has detached for it. */
	modelFailure: string | undefined;
	private readonly connectTimeoutMs: number;
	private connectTimer: NodeJS.Timeout | undefined;

	constructor(options: SessionFormOptions) {
		this.harness = options.harness;
		this.channel = options.channel;
		this.mode = options.mode ?? (this.harness.hello?.modes[0] === "turns" ? "turns" : "live");
		this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
		const confirmTimeoutMs = options.confirmTimeoutMs ?? 60_000;
		const front: ToolFront = {
			form: "session",
			hasUI: this.channel !== undefined,
			confirm: (title, message) => this.channel?.confirm(title, message, confirmTimeoutMs) ?? Promise.resolve(false),
		};
		const tools = toolsFor("session").map((spec) => toAgentTool(spec, this.harness, front));
		this.agent = new Agent({
			initialState: { systemPrompt: this.harness.systemPrompt(options.addendum), tools, model: options.model.model },
			streamFn: options.model.streamFn,
		});
		this.agent.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			// every answer reaches the person as it is produced, not at the end of a run the next wake may prolong
			const text = event.message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
			if (text !== "") this.channel?.say(text);
			// contact is a real answer from the model: the loop also announces the user's messages, and turns a
			// failed request into an assistant message whose stopReason is error
			if (this.contacted) return;
			const stop = event.message.stopReason;
			if (stop !== "error" && stop !== "aborted") this.reached();
		});
		this.harness.onWake = () => this.deliver();
		this.harness.onNotice = (text) => this.channel?.say(text);
		this.harness.onSession = (touchpoint) => {
			this.session(touchpoint.id).catch((error: unknown) => {
				this.harness.ring.note(`# the session failed: ${errorMessage(error)}`);
			});
		};
		// a wake that arrived between attach and this form (a decision right after the claim) is delivered now,
		// and a session touchpoint the harness held for a front end gets its loop
		queueMicrotask(() => {
			for (const touchpoint of this.harness.pendingTouchpointList()) {
				if (touchpoint.kind === "session") this.harness.onSession?.(touchpoint);
			}
			this.deliver();
		});
	}

	/** The agent's last assistant text, for the person. */
	lastText(): string {
		const last = [...this.agent.state.messages].reverse().find((m) => m.role === "assistant");
		if (!last || last.role !== "assistant") return "";
		return last.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	}

	/** Whether the agent may run now: always in live mode, only inside a touchpoint in turns mode. */
	private open(): boolean {
		if (this.mode !== "turns") return true;
		return (
			this.harness.pendingDecisions().length > 0 ||
			this.harness.pendingTurnList().length > 0 ||
			this.harness.pendingTouchpointList().some((t) => t.kind === "install")
		);
	}

	/** Hand the next due delivery to the agent as a run of its own; a run in progress, or the person's waiting prompt, goes first. */
	deliver(): void {
		if (this.closed || !this.open() || this.personWaiting) return;
		// nothing is injected into a run: a wake that arrives during one is delivered when it ends (the run's own
		// finally comes back here), so the person's prompt returns when answered and no run is prolonged forever
		if (this.running || this.agent.state.isStreaming) return;
		const delivery = this.harness.takeDelivery();
		if (!delivery) return;
		for (const id of delivery.ids) this.delivered.add(id);
		this.run(userMessage(delivery.text));
	}

	/** The first run's model contact is bounded: past the connect timeout the harness detaches and the run is aborted. */
	private armConnectTimeout(): void {
		if (this.contacted || this.connectTimer !== undefined) return;
		this.connectTimer = setTimeout(() => {
			this.connectTimer = undefined;
			if (this.contacted) return;
			this.unreachable(`the model did not answer within ${this.connectTimeoutMs} ms`);
		}, this.connectTimeoutMs);
		this.connectTimer.unref();
	}

	/** The model cannot be reached: the harness detaches (section 4.3) and the program goes on as itself. */
	private unreachable(reason: string): void {
		if (this.connectTimer !== undefined) {
			clearTimeout(this.connectTimer);
			this.connectTimer = undefined;
		}
		this.modelFailure = reason;
		this.harness.ring.note(`# ${reason}`);
		this.channel?.say(`abai: ${reason}; detaching`);
		this.agent.abort();
		this.harness.detach(reason);
	}

	private reached(): void {
		this.contacted = true;
		if (this.connectTimer !== undefined) {
			clearTimeout(this.connectTimer);
			this.connectTimer = undefined;
		}
	}

	private run(message: AgentMessage): void {
		this.running = true;
		this.armConnectTimeout();
		void this.agent
			.prompt(message)
			.catch((error: unknown) => {
				this.harness.ring.note(`# a wake could not be delivered: ${errorMessage(error)}`);
			})
			.finally(() => {
				this.running = false;
				this.runEnded();
				this.deliver();
			});
	}

	/** A run ended: settle what it received. The run's final text goes to the person. */
	private runEnded(): void {
		if (!this.contacted) {
			// the first run ended without an answer: a failed request is an unreachable model, now, not at the timer
			const last = [...this.agent.state.messages].reverse().find((m) => m.role === "assistant");
			const failed = last && last.role === "assistant" && last.stopReason === "error";
			if (this.connectTimer !== undefined) {
				clearTimeout(this.connectTimer);
				this.connectTimer = undefined;
			}
			if (failed && this.harness.attached) {
				this.unreachable(`the model could not be reached: ${last.errorMessage ?? "request failed"}`);
			}
		}
		const ids = [...this.delivered];
		this.delivered.clear();
		// a session touchpoint is never in a delivery here (onSession takes it), so every id is settled
		this.harness.settleDelivered(ids, "the agent's turn ended without deciding");
	}

	/** Run one prompt from the person and wait for the agent to settle; wakes during it are settled with it. */
	async prompt(text: string): Promise<string> {
		// the person goes first: a wake run in progress is waited for, and no new one starts before this prompt
		this.personWaiting = true;
		try {
			await this.agent.waitForIdle();
		} finally {
			this.personWaiting = false;
		}
		this.running = true;
		this.armConnectTimeout();
		try {
			await this.agent.prompt(userMessage(text));
		} finally {
			this.running = false;
			this.runEnded();
			this.deliver();
		}
		return this.lastText();
	}

	/**
	 * The session touchpoint: the person and the agent take turns until the
	 * person is done, then the touchpoint ends. Headless, it returns at once.
	 */
	async session(touchpointId: string): Promise<void> {
		// the person is already talking to the agent (the sidecar session verb): a second loop on the same
		// channel would interleave, and the program only needs its touchpoint returned
		if (this.conversation !== undefined) {
			this.harness.endTouchpoint(touchpointId);
			return;
		}
		try {
			await this.converse();
		} finally {
			this.harness.endTouchpoint(touchpointId);
		}
	}

	/**
	 * The person's loop: lines from the channel become prompts until the
	 * person is done or the form is shut down. The sidecar session runs this
	 * with no touchpoint, the program being a separate process. Headless, it
	 * returns at once.
	 */
	async converse(): Promise<void> {
		const channel = this.channel;
		if (!channel) return;
		// a second caller joins the loop in progress rather than starting another on the same channel
		if (this.conversation !== undefined) return this.conversation;
		this.conversation = this.loop(channel).finally(() => {
			this.conversation = undefined;
		});
		return this.conversation;
	}

	private async loop(channel: UserChannel): Promise<void> {
		while (!this.closed) {
			let line: string | undefined;
			try {
				line = await channel.ask(`${this.harness.hello?.name ?? "abai"}> `);
			} catch (error) {
				this.harness.ring.note(`# the user channel failed: ${errorMessage(error)}`);
				break;
			}
			if (line === undefined) break;
			if (line.trim() === "") continue;
			try {
				await this.prompt(line);
			} catch (error) {
				channel.say(`abai: ${errorMessage(error)}`);
			}
		}
	}

	shutdown(reason: string): void {
		this.closed = true;
		if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
		this.agent.abort();
		this.harness.shutdown(reason);
		this.channel?.close();
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
