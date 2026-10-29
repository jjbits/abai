// The default user channel (abaigrammar section 4.5): the terminal. Lines
// in, text out, consent as a y/n question with a timeout. The interface is
// paused while nothing is asked, so an attached program still exits when
// its own work ends, and a question that times out is withdrawn from
// readline so the next one is not dropped. Output does not depend on the
// input: a piped line whose pipe then ends still gets its answer printed.
import { createInterface, type Interface } from "node:readline";
import type { UserChannel } from "./user-channel.ts";

export function terminalChannel(
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stdout,
): UserChannel {
	let rl: Interface | undefined = createInterface({ input, output, terminal: false });
	/** The input is still open: readline has not closed (end of input, or our close). */
	let inputOpen = true;
	/** The channel has not been closed by its owner; output is written until then. */
	let channelOpen = true;
	rl.on("close", () => {
		inputOpen = false;
		rl = undefined;
	});
	rl.pause();
	const question = (prompt: string, timeoutMs?: number): Promise<string | undefined> =>
		new Promise((resolve) => {
			const current = rl;
			if (!current || !inputOpen) {
				resolve(undefined);
				return;
			}
			let settled = false;
			const done = (answer: string | undefined): void => {
				if (settled) return;
				settled = true;
				current.off("close", onClose);
				// a closed interface cannot be paused (Node throws on use after close)
				if (inputOpen) current.pause();
				resolve(answer);
			};
			const onClose = (): void => done(undefined);
			current.once("close", onClose);
			current.resume();
			const options = timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) };
			try {
				current.question(prompt, options, (answer) => done(answer));
				if (timeoutMs !== undefined) {
					options.signal?.addEventListener("abort", () => done(undefined), { once: true });
				}
			} catch (error) {
				done(undefined);
				void error;
			}
		});
	return {
		say: (text) => {
			if (channelOpen) output.write(`${text}\n`);
		},
		ask: (prompt) => question(prompt),
		confirm: async (title, message, timeoutMs) => {
			if (!channelOpen || !inputOpen) return false;
			output.write(`${title}\n${message}\n`);
			const answer = await question("Allow? [y/N] ", timeoutMs);
			return answer !== undefined && /^y(es)?$/i.test(answer.trim());
		},
		close: () => {
			if (!channelOpen) return;
			channelOpen = false;
			rl?.close();
			rl = undefined;
		},
	};
}
