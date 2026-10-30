// The harness's tools (abaigrammar section 4.2): the agent's end of the
// channels, one specification list for every front end. The session form
// registers them with the agent loop; the MCP form lists them as MCP tools.
// A tool returns text and throws on failure. Ported from arx-06-0 and
// generalized: decisions and targets are the manifest's, not arx's.
import type { Consent } from "@abaigram/abai-stub";
import { type Static, type TSchema, Type } from "typebox";
import type { Harness } from "./harness.ts";
import { WATCH_OPS } from "./scheduler.ts";

export type ToolForm = "session" | "mcp";

export interface ToolFront {
	form: ToolForm;
	hasUI: boolean;
	/** Ask the person; resolves false when there is no one to ask. */
	confirm(title: string, message: string): Promise<boolean>;
	/** Sidecar front ends: connect to a program by target. Undefined in-process. */
	attach?(target: string | number | undefined): Promise<string>;
}

export interface HarnessToolSpec<T extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: T;
	/** Front ends that offer this tool. */
	forms: readonly ToolForm[];
	run(harness: Harness, params: Static<T>, front: ToolFront): Promise<string>;
}

export const RESULT_CAP = 16 * 1024;

/** Cut a text result at the cap with a marker. */
export function capResult(text: string): string {
	if (text.length <= RESULT_CAP) return text;
	return `${text.slice(0, RESULT_CAP)}\n… (${text.length - RESULT_CAP} more characters)`;
}

function spec<T extends TSchema>(definition: HarnessToolSpec<T>): HarnessToolSpec {
	return definition as unknown as HarnessToolSpec;
}

function pretty(value: unknown): string {
	return capResult(JSON.stringify(value, null, 2));
}

/**
 * Consent for an act whose policy is `confirm` (section 10): auto mode or
 * the MCP form approves without asking; the session form asks through the
 * user channel; no channel, a refusal or a timeout is a denial. The denial
 * is stated to the stub, which refuses the act and audits it as denied.
 * Under MCP the client's permission decision is the person's consent
 * (section 4.5), whether it asked the person for this call or runs it
 * under an allowance the person gave beforehand; the harness cannot tell
 * the two apart and states `auto` either way, which is what the audit
 * shows.
 */
async function consentFor(harness: Harness, front: ToolFront, title: string, message: string): Promise<Consent> {
	if (harness.options.auto || front.form === "mcp") return "auto";
	if (!front.hasUI) return "denied";
	return (await front.confirm(title, message)) ? "approved" : "denied";
}

const BOTH: readonly ToolForm[] = ["session", "mcp"];
const MCP_ONLY: readonly ToolForm[] = ["mcp"];

export const HARNESS_TOOLS: readonly HarnessToolSpec[] = [
	spec({
		name: "abai_status",
		description:
			"The harness's state: the program you are attached to, pending decisions with their deadlines, turns in progress, watches, timers and the wake budget. Works when detached.",
		parameters: Type.Object({}),
		forms: BOTH,
		run: async (harness) => pretty(harness.status()),
	}),
	spec({
		name: "abai_transcript",
		description:
			"The program's transcript as rendered lines (one per event), newest last: the last `lines` lines, or only those after sequence `since`. Each line is `<seq>\t<text>`; a line of the harness's own (a note, a launched program's output) carries the sequence of the last event before it.",
		parameters: Type.Object({
			lines: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 500,
					default: 60,
					description: "How many lines, newest last (default 60)",
				}),
			),
			since: Type.Optional(Type.Integer({ minimum: 0, description: "Only lines after this sequence number" })),
		}),
		forms: BOTH,
		run: async (harness, { lines, since }) => {
			harness.ring.flush();
			const picked = harness.ring.last(lines ?? 60, since);
			if (picked.length === 0) return "(no transcript lines)";
			return capResult(picked.map((line) => `${line.seq}\t${line.text}`).join("\n"));
		},
	}),
	spec({
		name: "abai_cells",
		description:
			"Read the program's cells (its declared state), all of them or the named ones. Knobs are the readwrite cells; write them with abai_set.",
		parameters: Type.Object({
			names: Type.Optional(
				Type.Array(Type.String(), { description: "Cell names to read; all cells when omitted or empty" }),
			),
		}),
		forms: BOTH,
		run: async (harness, { names }) => pretty(await harness.cells(names)),
	}),
	spec({
		name: "abai_set",
		description:
			"Write a knob (a readwrite cell) with your reason; the reason is audited. Answers the value that landed, which the program may have clamped or cut.",
		parameters: Type.Object({
			cell: Type.String({ description: "The readwrite cell to write" }),
			value: Type.Unknown({ description: "The value to write" }),
			reason: Type.String({ minLength: 1, description: "Why you write it (audited)" }),
		}),
		forms: BOTH,
		run: async (harness, { cell, value, reason }, front) => {
			const knob = harness.knob(cell);
			const consent =
				knob?.policy === "confirm"
					? await consentFor(
							harness,
							front,
							`abai: write ${cell}`,
							`${knob.doc}\nValue: ${JSON.stringify(value)}\nReason: ${reason}`,
						)
					: undefined;
			const landed = await harness.setCell(cell, value, reason, consent);
			const result = `${cell} = ${JSON.stringify(landed)}`;
			if (JSON.stringify(landed) !== JSON.stringify(value)) {
				return `${result} (asked for ${JSON.stringify(value)}; the program clamped it)`;
			}
			return result;
		},
	}),
	spec({
		name: "abai_call",
		description:
			"Call one of the program's capabilities with parameters and your reason; the reason is audited. Mutate capabilities need the person's consent where a user channel exists. The result is the capability's result.",
		parameters: Type.Object({
			capability: Type.String({ description: "The capability's name" }),
			params: Type.Optional(
				Type.Object({}, { additionalProperties: true, description: "The capability's parameters" }),
			),
			reason: Type.String({ minLength: 1, description: "Why you call it (audited)" }),
		}),
		forms: BOTH,
		run: async (harness, params, front) => {
			const capability = harness.capability(params.capability);
			if (!capability) {
				throw new Error(
					`${params.capability} is not a capability of the program (see abai_prompt or the manifest)`,
				);
			}
			if (harness.options.denyMutate && capability.effect === "mutate") {
				throw new Error(`mutate capabilities are refused in this harness (${params.capability})`);
			}
			const consent =
				capability.policy === "confirm"
					? await consentFor(
							harness,
							front,
							`abai: ${params.capability}`,
							`${capability.doc}\nParams: ${JSON.stringify(params.params ?? {})}\nReason: ${params.reason}`,
						)
					: undefined;
			const result = await harness.call(
				params.capability,
				params.params as Record<string, unknown> | undefined,
				params.reason,
				consent,
			);
			return result === undefined ? "ok" : pretty(result);
		},
	}),
	spec({
		name: "abai_claim",
		description:
			"Claim decisions so they are asked of you, or release them with release: true. By default every declared decision is claimed at attach.",
		parameters: Type.Object({
			decisions: Type.Array(Type.String(), { minItems: 1, description: "The decisions to claim or release" }),
			timeout_s: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 600,
					description: "Seconds the program waits for your answer, where the program allows a shorter wait",
				}),
			),
			release: Type.Optional(Type.Boolean({ description: "Release the decisions instead of claiming them" })),
		}),
		forms: BOTH,
		run: async (harness, { decisions, timeout_s, release }) => {
			if (release === true) {
				const released = await harness.release(decisions);
				return `released: ${released.join(", ") || "(none)"}`;
			}
			const claimed = await harness.claim(decisions, timeout_s === undefined ? undefined : timeout_s * 1000);
			return `claimed: ${claimed.join(", ")}`;
		},
	}),
	spec({
		name: "abai_decide",
		description:
			"Answer a pending decision by its id, with one of its options (as a string) or the answer object its schema allows, and your reason; the reason is audited. An expired decision cannot be answered.",
		parameters: Type.Object({
			id: Type.String({ description: "The pending decision's id" }),
			answer: Type.Unknown({ description: "One of the decision's options, or its answer object" }),
			reason: Type.String({ minLength: 1, description: "Why you answer so (audited)" }),
		}),
		forms: BOTH,
		run: async (harness, { id, answer, reason }, front) => {
			const decision = harness.decisionFor(id);
			const consent =
				decision?.policy === "confirm"
					? await consentFor(
							harness,
							front,
							`abai: decide ${decision.name}`,
							`${decision.doc}\nAnswer: ${JSON.stringify(answer)}\nReason: ${reason}`,
						)
					: undefined;
			const info = harness.decide(id, answer, reason, consent);
			if (consent === "denied")
				return `decision ${info.id} ${info.hook} was not consented; the program applied its default`;
			return `decision ${info.id} ${info.hook} answered`;
		},
	}),
	spec({
		name: "abai_watch",
		description:
			"Watch a cell and be woken when its condition holds: changed, eq, ne, gt, lt or crossed (against value), polled at cadence_ms. Or remove a watch by id with remove.",
		parameters: Type.Object({
			cell: Type.Optional(Type.String({ description: "The cell to watch" })),
			op: Type.Optional(
				Type.Union(
					WATCH_OPS.map((op) => Type.Literal(op)),
					{ description: "The condition" },
				),
			),
			value: Type.Optional(Type.Unknown({ description: "The value the condition compares against" })),
			cadence_ms: Type.Optional(Type.Integer({ minimum: 100, description: "Polling cadence in milliseconds" })),
			remove: Type.Optional(Type.Integer({ minimum: 1, description: "Remove the watch with this id" })),
		}),
		forms: BOTH,
		run: async (harness, { cell, op, value, cadence_ms, remove }) => {
			if (remove !== undefined) {
				if (harness.removeWatch(remove)) return `watch ${remove} removed`;
				throw new Error(`no watch ${remove}`);
			}
			if (cell === undefined || op === undefined) throw new Error("abai_watch needs cell and op (or remove)");
			const watch = harness.addWatch(cell, op, value, cadence_ms);
			return `watch ${watch.id} on ${watch.cell} ${watch.op}${value === undefined ? "" : ` ${JSON.stringify(value)}`} every ${watch.cadenceMs} ms`;
		},
	}),
	spec({
		name: "abai_timer",
		description: "Wake yourself after a delay, with a note to remember why.",
		parameters: Type.Object({
			seconds: Type.Number({ exclusiveMinimum: 0, description: "Seconds until the wake" }),
			note: Type.Optional(Type.String({ description: "Why you set it" })),
		}),
		forms: BOTH,
		run: async (harness, { seconds, note }) => {
			const timer = harness.addTimer(seconds, note ?? "");
			return `timer ${timer.id} in ${seconds}s${note ? `: ${note}` : ""}`;
		},
	}),
	spec({
		name: "abai_audit",
		description:
			"Read the program's audit log back: the last records of every act of control, yours included, with their reasons.",
		parameters: Type.Object({
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 1000, description: "How many records, newest last" }),
			),
		}),
		forms: BOTH,
		run: async (harness, { limit }) => pretty(await harness.audit(limit)),
	}),
	spec({
		name: "abai_lifecycle",
		description:
			"The program's lifecycle (status, pause, resume, stop, restart) with your reason; the reason is audited. Attached to a program you did not launch, only status and a graceful stop are available. stop and restart ask the person where a user channel exists.",
		parameters: Type.Object({
			op: Type.Union(
				[
					Type.Literal("status"),
					Type.Literal("pause"),
					Type.Literal("resume"),
					Type.Literal("stop"),
					Type.Literal("start"),
					Type.Literal("restart"),
				],
				{ description: "The operation" },
			),
			reason: Type.String({ minLength: 1, description: "Why (audited)" }),
		}),
		forms: BOTH,
		run: async (harness, { op, reason }, front) => {
			// section 10: stop and restart are confirm acts, pause and resume auto, unless the manifest's policy says otherwise
			const declared = op === "status" || op === "start" ? undefined : harness.manifest?.lifecycle?.policy?.[op];
			const policy: "auto" | "confirm" | "forbid" =
				declared ?? (op === "stop" || op === "restart" ? "confirm" : "auto");
			if (policy === "forbid") return `lifecycle ${op} is forbidden by the program's policy; nothing was done`;
			const consent =
				policy === "confirm"
					? await consentFor(harness, front, `abai: lifecycle ${op}`, `${op} the program.\nReason: ${reason}`)
					: undefined;
			if (consent === "denied") return `lifecycle ${op} was not consented; nothing was done`;
			const result = await harness.lifecycle(op, reason, consent);
			return typeof result === "string" ? result : pretty(result);
		},
	}),
	spec({
		name: "abai_attach",
		description:
			"Attach to a running program by socket path or pid, or to the one running program when no target is given; also reattaches after a disconnect.",
		parameters: Type.Object({
			target: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "A socket path or a pid" })),
		}),
		forms: BOTH,
		run: async (harness, { target }, front) => {
			if (harness.attached && harness.hello)
				return `already attached to ${harness.hello.name} as ${harness.hello.connection}`;
			if (!front.attach) throw new Error("this harness runs inside the program; there is nothing else to attach to");
			return front.attach(target);
		},
	}),
	spec({
		name: "abai_wait",
		description:
			"Park until the next wake (program events that wake you, watches, timers, pending decisions, turns) and return it, or 'no wake' after wait_s seconds (default 25). Call it again after acting.",
		parameters: Type.Object({
			wait_s: Type.Optional(
				Type.Number({ exclusiveMinimum: 0, description: "Seconds to wait at most (default 25)" }),
			),
		}),
		forms: MCP_ONLY,
		// the park is the MCP server's own (it settles the last delivery, keeps the new one's ids, and can be
		// cancelled); this spec is its description and schema, and nothing else runs it
		run: async () => {
			throw new Error("abai_wait is served by the MCP server itself");
		},
	}),
	spec({
		name: "abai_prompt",
		description:
			"Your full instructions: the program's identity content and its manifest (cells, capabilities, decisions, waking events) with the rules. Read it once at the start.",
		parameters: Type.Object({}),
		forms: MCP_ONLY,
		run: async (harness) => harness.systemPrompt(),
	}),
];

/** The tools a front end offers. */
export function toolsFor(form: ToolForm): HarnessToolSpec[] {
	return HARNESS_TOOLS.filter((tool) => tool.forms.includes(form));
}
