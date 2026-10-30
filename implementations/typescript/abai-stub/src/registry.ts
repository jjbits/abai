// Declarations in code become the manifest (abaigrammar section 7). The
// program hands `createAbaigram` keyed records; this module turns them into
// the manifest's lists in insertion order, fills the grammar's defaults so
// the rendered abaigram.yaml is explicit and byte-stable, appends the
// deviations this TypeScript instantiation declares, and validates. An
// invalid declaration throws at startup: declared, not discovered.
import {
	ABAIGRAMMAR_VERSION,
	type CapabilityDecl,
	type CellDecl,
	type DecisionDecl,
	type EventDecl,
	type Manifest,
	type Mode,
	type Policy,
	type TurnDecl,
	validateManifest,
} from "./manifest/manifest.ts";

/** A capability's handler: parameters in, a result out; a throw is an error result. */
export type CapabilityHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>;
/** A sized knob's handler: the delivered value, at a safepoint, on the thread that reached it. */
export type KnobHandler = (value: unknown) => void;
/** The stop handler, run at a safepoint on a graceful stop (section 5.5). */
export type StopHandler = () => void | Promise<void>;

export type CellOptions = Omit<CellDecl, "name"> & { onChange?: KnobHandler };
export type EventOptions = Omit<EventDecl, "name">;
export type CapabilityOptions = Omit<CapabilityDecl, "name" | "dispatch" | "policy" | "timeout"> & {
	dispatch?: CapabilityDecl["dispatch"];
	policy?: Policy;
	timeout?: string;
	handler?: CapabilityHandler;
};
export type DecisionOptions = Omit<DecisionDecl, "name" | "policy"> & { policy?: Policy };
export type TurnOptions = Omit<TurnDecl, "name">;

export interface AbaigramOptions {
	name: string;
	/** Default `<name> abai`. */
	entry?: string;
	modes: Mode[];
	/** Paths relative to the program's root; `identity` defaults to `abai/identity.md`. */
	content?: Partial<Manifest["content"]>;
	/** Default `~/.abai/audit/<name>.jsonl`. */
	audit?: Manifest["audit"];
	harness?: Manifest["harness"];
	model?: Manifest["model"];
	check?: Manifest["check"];
	lifecycle?: Omit<NonNullable<Manifest["lifecycle"]>, "stop"> & {
		stop?: { graceful: string; handler: StopHandler };
	};
	attention?: Manifest["attention"];
	policy?: Manifest["policy"];
	/** The program's own deviations; the instantiation's are appended. */
	deviations?: string[];
	cells?: Record<string, CellOptions>;
	events?: Record<string, EventOptions>;
	capabilities?: Record<string, CapabilityOptions>;
	decisions?: Record<string, DecisionOptions>;
	turns?: Record<string, TurnOptions>;
}

/** Where this TypeScript instantiation departs from the grammar, in every manifest it renders. */
export const INSTANTIATION_DEVIATIONS: readonly string[] = [
	"Touchpoints are awaited promises: Node cannot block its only thread while the agent loop runs on it, so the program's logic pauses at the await while its own timers and I/O callbacks keep running (section 4.3).",
	"Sized cell writes and event payload copies allocate: JavaScript has no copy into a preallocated byte slot; scalar rows meet section 11.2, sized rows are measured and reported.",
	"A cooperative pause holds the program at its next touchpoint, not inside safepoint(): a safepoint cannot block, since the resume arrives on the same event loop that would be blocked. The flag is still one load at a safepoint, and os pause (the launcher's signal) holds the program anywhere (section 5.5).",
	"Under launch the child is attached as soon as its endpoint is accepted, a moment after its first statement rather than before it: Node cannot listen in a constructor. A program that wants the agent present from its first line awaits attach() (section 6.3).",
];
export const SIDECAR_DEVIATION =
	"In sidecar mode the region is not shared memory: cells are read by request and events cross the socket, so observation costs the program one serialization per connected harness (section 11.3). Under ABAI_HARNESS=null or exercise the null harness stays in the program's process and no endpoint opens, so a check run's measured overhead leaves that serialization out.";

export const DEFAULT_CAPABILITY_TIMEOUT = "30s";
export const DEFAULT_KNOB_TIMEOUT = "30s";

function isSized(type: CellDecl["type"]): boolean {
	return type === "string" || type === "object" || type === "list";
}

/** Build the explicit, validated manifest from the program's declarations. Throws on a violation. */
export function buildManifest(options: AbaigramOptions): Manifest {
	const cells: CellDecl[] = [];
	for (const [name, cell] of Object.entries(options.cells ?? {})) {
		const { onChange: _onChange, ...decl } = cell;
		const full: CellDecl = { name, ...decl };
		if (full.access === "readwrite") {
			full.policy ??= "auto";
			if (isSized(full.type)) full.timeout ??= DEFAULT_KNOB_TIMEOUT;
		}
		cells.push(full);
	}
	const events: EventDecl[] = [];
	for (const [name, event] of Object.entries(options.events ?? {})) {
		const full: EventDecl = { name, ...event };
		full.wakes ??= "never";
		events.push(full);
	}
	const capabilities: CapabilityDecl[] = [];
	for (const [name, capability] of Object.entries(options.capabilities ?? {})) {
		const { handler: _handler, ...decl } = capability;
		capabilities.push({
			name,
			...decl,
			dispatch: decl.dispatch ?? "safepoint",
			timeout: decl.timeout ?? DEFAULT_CAPABILITY_TIMEOUT,
			policy: decl.policy ?? (decl.effect === "mutate" ? "confirm" : "auto"),
		});
	}
	const decisions: DecisionDecl[] = [];
	for (const [name, decision] of Object.entries(options.decisions ?? {})) {
		decisions.push({ name, ...decision, policy: decision.policy ?? "auto" });
	}
	const turns: TurnDecl[] = [];
	for (const [name, turn] of Object.entries(options.turns ?? {})) {
		if (options.decisions?.[name] !== undefined) {
			throw new Error(`the declarations of ${options.name} do not validate: ${name} is both a decision and a turn`);
		}
		turns.push({ name, ...turn });
	}
	const deviations = [...(options.deviations ?? []), ...INSTANTIATION_DEVIATIONS];
	if (options.modes.includes("sidecar")) deviations.push(SIDECAR_DEVIATION);

	const manifest: Manifest = {
		abaigrammar: ABAIGRAMMAR_VERSION,
		name: options.name,
		entry: options.entry ?? `${options.name} abai`,
		modes: [...options.modes],
		...(options.harness === undefined ? {} : { harness: options.harness }),
		...(options.model === undefined ? {} : { model: options.model }),
		...(options.check === undefined ? {} : { check: options.check }),
		content: { identity: "abai/identity.md", ...(options.content ?? {}) },
		audit: options.audit ?? { path: `~/.abai/audit/${options.name}.jsonl` },
		...(options.lifecycle === undefined
			? {}
			: {
					lifecycle: {
						pause: options.lifecycle.pause,
						...(options.lifecycle.stop === undefined
							? {}
							: { stop: { graceful: options.lifecycle.stop.graceful, handler: "stop" } }),
						...(options.lifecycle.policy === undefined ? {} : { policy: options.lifecycle.policy }),
					},
				}),
		...(options.attention === undefined ? {} : { attention: options.attention }),
		...(options.policy === undefined ? {} : { policy: options.policy }),
		deviations,
		cells,
		events,
		capabilities,
		decisions,
		turns,
	};
	const violations = validateManifest(manifest);
	if (violations.length > 0) {
		throw new Error(`the declarations of ${options.name} do not validate: ${violations.join("; ")}`);
	}
	return manifest;
}
