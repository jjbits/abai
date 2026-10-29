// The user channel (abaigrammar section 4.5): how the harness talks with
// the person. The terminal is the default; a program with its own interface
// supplies its own; a headless run has none, and then `confirm` is denied
// (section 10). The scripted channel drives tests.
export interface UserChannel {
	/** Something for the person to read. */
	say(text: string): void;
	/** The next thing the person says, or undefined when they are done. */
	ask(prompt: string): Promise<string | undefined>;
	/** Consent for an act; resolves false when nobody answers within the timeout. */
	confirm(title: string, message: string, timeoutMs: number): Promise<boolean>;
	close(): void;
}

export interface ScriptedChannel extends UserChannel {
	readonly said: string[];
	readonly asked: string[];
	readonly confirmations: Array<{ title: string; message: string }>;
}

/** A channel that answers from a script: inputs in order, then done; confirmations by a rule. */
export function scriptedChannel(inputs: string[], consent: (title: string) => boolean = () => true): ScriptedChannel {
	const queue = [...inputs];
	const said: string[] = [];
	const asked: string[] = [];
	const confirmations: Array<{ title: string; message: string }> = [];
	return {
		said,
		asked,
		confirmations,
		say: (text) => {
			said.push(text);
		},
		ask: async (prompt) => {
			asked.push(prompt);
			return queue.shift();
		},
		confirm: async (title, message) => {
			confirmations.push({ title, message });
			return consent(title);
		},
		close: () => {},
	};
}
