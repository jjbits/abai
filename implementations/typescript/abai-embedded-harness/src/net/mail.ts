// Reading the run's mailboxes: one long-poll per membership, for as long as
// a harness is attached to a program that can record what arrives. aiipd
// hands each message to exactly one reader and forgets it, so the loop is
// the owner of what it takes: it gives every message to the handler, and a
// handler that throws loses only that message, never the loop. A daemon that
// stops answering is retried with a growing wait (half a second doubling to
// thirty, with jitter, as aiap's own daemon does) and the transcript hears
// once when the reading fails and once when it resumes. A membership the
// daemon no longer holds (410, 404) ends its loop and asks the owner to
// list memberships again. Known and accepted: `stop` aborts the poll in
// flight, and aiipd pops with a Go select, so a message it dequeued at
// that very instant is gone; the harness stops the mail only at detach and
// shutdown.
import { type AiipClient, AiipError, type AiipMessage } from "./client.ts";
import type { NetworkMembership } from "./membership.ts";

export type MailHandler = (message: AiipMessage, membership: NetworkMembership) => void | Promise<void>;

export interface MailLoopOptions {
	/** One long-poll's wait in milliseconds; default 45 s, the daemon caps a wait at 60 s. */
	waitMs?: number;
	/** How long `stop` waits for a handler still running before it lets go; default 5 s. */
	stopTimeoutMs?: number;
	/** The retry wait after a failed read: first and largest, in ms. Default 500 and 30 000. */
	backoffMinMs?: number;
	backoffMaxMs?: number;
	/** Called after a loop ends because the daemon no longer holds the membership. */
	onDropped?: (membership: NetworkMembership) => void;
}

interface Loop {
	membership: NetworkMembership;
	abort: AbortController;
	done: Promise<void>;
}

export const MAIL_BACKOFF_MIN_MS = 500;
export const MAIL_BACKOFF_MAX_MS = 30_000;
export const MAIL_STOP_TIMEOUT_MS = 5_000;

export class MailLoop {
	private readonly client: AiipClient;
	private readonly note: (text: string) => void;
	private readonly options: MailLoopOptions;
	private readonly loops = new Map<string, Loop>();
	private handler: MailHandler | undefined;

	constructor(client: AiipClient, note: (text: string) => void, options: MailLoopOptions = {}) {
		this.client = client;
		this.note = note;
		this.options = options;
	}

	/** The network ids being read now. */
	get active(): string[] {
		return [...this.loops.keys()];
	}

	get running(): boolean {
		return this.handler !== undefined;
	}

	/** Start reading these memberships' mailboxes, handing every message to `handler`. A second start replaces the handler for new loops only. */
	start(handler: MailHandler, memberships: NetworkMembership[]): void {
		this.handler = handler;
		this.sync(memberships);
	}

	/** Follow the membership list: a loop per membership, none for one that is gone. A no-op before `start`. */
	sync(memberships: NetworkMembership[]): void {
		if (this.handler === undefined) return;
		const wanted = new Map(memberships.map((m) => [m.id, m]));
		for (const [id, loop] of this.loops) {
			if (!wanted.has(id)) {
				loop.abort.abort();
				this.loops.delete(id);
			}
		}
		for (const [id, membership] of wanted) {
			if (this.loops.has(id)) continue;
			const abort = new AbortController();
			// the loop keeps its handler: a message the daemon has already handed over is delivered even when `stop`
			// clears the current handler meanwhile; the daemon has forgotten it, so nobody else could
			const done = this.run(membership, abort.signal, this.handler);
			this.loops.set(id, { membership, abort, done });
		}
	}

	/**
	 * End every loop, aborting the poll in flight, and wait for them to
	 * return: a handler still running gets `stopTimeoutMs` to finish, then
	 * the stop goes on without it. Idempotent.
	 */
	async stop(): Promise<void> {
		this.handler = undefined;
		const loops = [...this.loops.values()];
		this.loops.clear();
		for (const loop of loops) loop.abort.abort();
		const limit = this.options.stopTimeoutMs ?? MAIL_STOP_TIMEOUT_MS;
		await Promise.all(loops.map((loop) => Promise.race([loop.done, sleepFor(limit)])));
	}

	private async run(m: NetworkMembership, signal: AbortSignal, handler: MailHandler): Promise<void> {
		const waitMs = this.options.waitMs ?? undefined;
		const min = this.options.backoffMinMs ?? MAIL_BACKOFF_MIN_MS;
		const max = this.options.backoffMaxMs ?? MAIL_BACKOFF_MAX_MS;
		let backoff = 0;
		let failing: string | undefined;
		while (!signal.aborted) {
			let message: AiipMessage | undefined;
			try {
				message = await this.client.recv(m.id, { waitMs, signal });
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof AiipError && (error.status === 410 || error.status === 404)) {
					this.note(`# network: no longer a member of ${m.network} (${error.message}); its mailbox is not read`);
					if (this.loops.get(m.id)?.abort.signal === signal) this.loops.delete(m.id);
					this.options.onDropped?.(m);
					return;
				}
				if (failing === undefined) {
					failing = errorMessage(error);
					this.note(`# network: the mailbox of ${m.network} cannot be read: ${failing}`);
				}
				backoff = backoff === 0 ? min : Math.min(backoff * 2, max);
				await sleep(jitter(backoff), signal);
				continue;
			}
			if (failing !== undefined) {
				this.note(`# network: the mailbox of ${m.network} is read again`);
				failing = undefined;
			}
			backoff = 0;
			if (message === undefined) continue;
			try {
				await handler(message, m);
			} catch (error) {
				this.note(
					`# network: a message from ${message.from.addr} on ${m.network} was not handled: ${errorMessage(error)}`,
				);
			}
		}
	}
}

function sleepFor(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

function jitter(ms: number): number {
	return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		timer.unref?.();
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
