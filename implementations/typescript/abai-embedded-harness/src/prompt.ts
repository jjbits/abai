// Composes the agent's system prompt from the identity and the manifest
// (abaigrammar section 8): byte-stable while its inputs are.
import {
	type CapabilityDecl,
	type CellDecl,
	type DecisionDecl,
	EVENT_SLOT_BYTES,
	type FieldSchema,
	fieldOf,
	type Manifest,
	payloadBytes,
	type Schema,
} from "@abaigram/stub";

export type HarnessForm = "session" | "mcp";

export interface ComposeInput {
	identity: string;
	manifest: Manifest;
	options: { form: HarnessForm; auto: boolean; denyMutate: boolean; wakes: string[] };
	/**
	 * Text the owner appended when the harness was started. It ends the
	 * prompt and wins over the rules where they conflict.
	 */
	addendum?: string;
}

function schemaLine(schema: Schema): string {
	const parts = Object.entries(schema).map(([key, field]) => `${key}: ${typeOf(field)}`);
	return parts.length === 0 ? "none" : parts.join(", ");
}

function typeOf(field: FieldSchema): string {
	const f = fieldOf(field);
	if (f.type === "enum" && f.enum) return f.enum.join("|");
	return f.nullable ? `${f.type}?` : f.type;
}

function cellLine(cell: CellDecl): string {
	const kind = cell.access === "readwrite" ? "knob" : "read";
	const type = cell.type === "enum" && cell.enum ? cell.enum.join("|") : cell.type;
	const dflt = cell.access === "readwrite" ? `, default ${JSON.stringify(cell.default)}` : "";
	return `- ${cell.name} (${kind}, ${type}${dflt}): ${cell.doc}`;
}

function capabilityLine(cap: CapabilityDecl, confirmMark: boolean): string {
	const mark = cap.effect === "mutate" ? (confirmMark ? " [mutate, confirmed by the person]" : " [mutate]") : "";
	const writes = cap.writes ? ` (writes ${cap.writes})` : "";
	return `- ${cap.name}${mark}${writes}: ${cap.doc} Params: ${schemaLine(cap.params)}.`;
}

function decisionLine(decision: DecisionDecl): string {
	const answer = decision.answer
		? `answer fields: ${schemaLine(decision.answer)}`
		: `options: ${decision.options?.join(", ")}`;
	const cost = payloadBytes(decision.context) > EVENT_SLOT_BYTES ? " Expensive: its context is large." : "";
	return `- ${decision.name}: ${decision.doc} ${answer}; default ${JSON.stringify(decision.default)}.${cost}`;
}

function policyParagraph(options: ComposeInput["options"]): string {
	if (options.denyMutate) {
		return "Mutate capabilities are refused in this harness: you may observe, write knobs and answer decisions, but abai_call only serves read capabilities.";
	}
	if (options.form === "mcp") {
		return "Every abai_call of a mutate capability is shown to the person by your own client before it runs, unless they chose to allow the tool without asking; that is their consent. Do not repeat a refused call.";
	}
	return options.auto
		? "Mutate capabilities run without asking (this harness runs in auto mode); be conservative."
		: "Every abai_call of a mutate capability asks the person at this terminal for consent first; when there is no one to ask, the call is denied. Do not repeat a denied call.";
}

function attachmentParagraph(form: HarnessForm, name: string): string {
	if (form === "mcp") {
		return [
			`You are attached to the running program ${name}, in sidecar mode, from an MCP client.`,
			"Nothing can wake you: you park by calling abai_wait, which returns the next wake (program events, watches, timers, pending decisions) or 'no wake' after its timeout, and you call it again.",
			"A wake is not a message from the person; act on it, then park again. Answer the person when they speak to you.",
		].join(" ");
	}
	return [
		`You are attached to the running program ${name}, in sidecar mode.`,
		"This session is your user channel: the person at this terminal supervises you and can see everything you do.",
		"Messages that begin with [abai wake] are not from the person: the harness delivers the program's events, watches, timers and pending decisions to you that way, coalesced, with the transcript lines since the last wake.",
		"Act on a wake with tools when something needs doing, answer briefly, and stop; the next wake comes on its own.",
	].join(" ");
}

/** The full system prompt of the supervising agent. */
export function composeSystemPrompt(input: ComposeInput): string {
	const { identity, manifest, options } = input;
	const confirmMark = options.form === "session" && !options.auto && !options.denyMutate;
	const wakingEvents = manifest.events.filter(
		(event) => (event.wakes !== undefined && event.wakes !== "never") || options.wakes.includes(event.name),
	);
	const knobs = manifest.cells.filter((cell) => cell.access === "readwrite");
	const lines: string[] = [];
	lines.push(identity.trimEnd(), "");
	lines.push(
		"# How you are attached",
		"",
		attachmentParagraph(options.form, manifest.name),
		"",
		policyParagraph(options),
		"",
	);
	lines.push(`# The program: ${manifest.name} (abaigrammar ${manifest.abaigrammar}, mode ${manifest.modes[0]})`, "");
	lines.push("Where this program departs from the grammar:", ...(manifest.deviations?.map((d) => `- ${d}`) ?? []), "");
	lines.push("## Cells (read with abai_cells; knobs written with abai_set)", "", ...manifest.cells.map(cellLine), "");
	lines.push(
		`Knobs: ${knobs.map((cell) => cell.name).join(", ")}. A write lands the value the program accepts and is audited with your reason.`,
		"",
	);
	lines.push(
		"## Capabilities (called with abai_call)",
		"",
		...manifest.capabilities.map((cap) => capabilityLine(cap, confirmMark)),
		"",
	);
	lines.push(
		"## Decisions (claimed with abai_claim, answered with abai_decide)",
		"",
		...manifest.decisions.map(decisionLine),
		"",
		"A pending decision arrives in a wake as 'decision <id> <name> due in <seconds>s: <summary>'. Answer it with abai_decide before the deadline, with one of its options as a string or the full answer object its schema declares; an expired decision took its default and cannot be answered. Every declared decision is claimed at attach; release what you do not need, since each adds your round trip.",
		"",
	);
	lines.push(
		"## Events that wake you",
		"",
		...wakingEvents.map((event) =>
			event.wakes === "always" || options.wakes.includes(event.name)
				? `- ${event.name}: ${event.doc}`
				: `- ${event.name} (when ${event.wakes}): ${event.doc}`,
		),
		"",
	);
	lines.push(
		"Other events are in the transcript (abai_transcript). A watch (abai_watch) wakes you when a cell meets a condition; a timer (abai_timer) wakes you later.",
		"abai_lifecycle asks the program's status, and where this harness launched the program it can pause, resume, stop or restart it; stop and restart ask the person first. The program's own output and its exit arrive as abai.io.stdout, abai.io.stderr and abai.lifecycle.exited.",
		"",
	);
	lines.push(
		"# Rules",
		"",
		"- State a reason with every act of control: abai_set, abai_call and abai_decide require one. It goes to the program's audit log, which the person reads.",
		"- Prefer observation. Read cells and the transcript before acting; most wakes need nothing.",
		"- Prefer the narrowest act: a knob over a capability that mutates, a note to the person over a change they did not ask for.",
		"- Never edit the program's project yourself; your own tools are for looking.",
		"- Keep answers to wakes short. The person is not waiting for prose.",
		"- When you are not attached, the channel tools (abai_cells, abai_set, abai_call, abai_claim, abai_audit) fail; abai_status, abai_attach, the transcript, watches and timers still work. Say so and wait.",
	);
	const addendum = input.addendum?.trim() ?? "";
	if (addendum !== "") {
		lines.push(
			"",
			"# From the owner",
			"",
			"The owner added the text below when this harness was started. Where it conflicts with the rules above, it wins.",
			"",
			addendum,
		);
	}
	return `${lines.join("\n")}\n`;
}

/** The short form an MCP client receives as server instructions. */
export function composeInstructions(input: ComposeInput): string {
	const firstParagraph = input.identity.split("\n\n")[1]?.trim() ?? "";
	return [
		`${input.manifest.name} abai harness (abaigrammar ${input.manifest.abaigrammar}, sidecar).`,
		firstParagraph,
		"Call abai_prompt once for the full instructions, abai_status for the program's state, and abai_wait to park until the next wake; act on wakes with the abai_* tools, stating a reason for every act of control.",
	]
		.filter((part) => part !== "")
		.join("\n\n");
}
