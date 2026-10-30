// createAbaigram: the program-facing API of the stub (abaigrammar sections 4
// and 5). The program declares its manifest in code, obtains cell, knob and
// event handles once, and then writes cells, emits events, serves
// capabilities and calls touchpoints. With no harness attached, every
// operation here costs what section 11.1 says: cell writes store, emits and
// safepoints load one flag, decisions and turns load the flag and count.
//
// Touchpoints are awaited promises (see the instantiation's deviations in
// registry.ts). The attached paths arrive with the harness binding; this
// file carries the detached behaviour and the seams the binding fills.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fitValue } from "./cells/fit.ts";
import { type ContentSlots, createContent, findRoot } from "./content.ts";
import { Endpoint } from "./endpoint.ts";
import {
	attachWaitMsFrom,
	ENV_HARNESS,
	ENV_HARNESS_BIN,
	ENV_LAUNCH_SOCKET,
	type HarnessSelection,
	runDirFrom,
	selectHarness,
	selectMode,
} from "./env.ts";
import { DirectBinding, type HarnessBinding, type TouchpointKind } from "./harness-binding.ts";
import {
	type CellDecl,
	cutUtf8,
	type DecisionDecl,
	durationMs,
	type EventDecl,
	encodedBytes,
	fieldOf,
	LIBRARY_EVENTS,
	type Manifest,
	type Mode,
	type TurnDecl,
} from "./manifest/manifest.ts";
import { attachNullHarness, type NullHarness } from "./null-harness.ts";
import { FLAG_ATTACHED, FLAG_PAUSED, FLAG_QUEUE, FLAG_WORK, LIBRARY_EVENT_BASE, Region } from "./region.ts";
import {
	type AbaigramOptions,
	buildManifest,
	type CapabilityHandler,
	type KnobHandler,
	type StopHandler,
} from "./registry.ts";

/** Thrown by `decide` when the applied default is `abort` (section 5.4). */
export class AbaigramAbort extends Error {
	readonly decision: string;
	constructor(decision: string, cause: string) {
		super(`decision ${decision} applied its default, abort (${cause})`);
		this.name = "AbaigramAbort";
		this.decision = decision;
	}
}

export interface CellHandle<T = unknown> {
	readonly name: string;
	get(): T;
	/** One store to the value and one to the version. Enum values must be declared; nothing else is checked. */
	set(value: T): void;
}

export interface KnobHandle<T = unknown> extends CellHandle<T> {
	/** Back to the declared default; a sized knob's reset reaches the harness as `abai.knob.reset`. */
	reset(): void;
	/** Sized knobs only: the handler that receives a delivered value at a safepoint. */
	onChange(handler: KnobHandler): void;
}

export interface EventHandle {
	readonly name: string;
	/** One load of the attached flag when no harness is attached. */
	emit(payload?: Record<string, unknown>): void;
}

export interface CounterSnapshot {
	[name: string]: number;
}

/** What a harness binding supplies once attached; undefined while detached. */
export interface AttachedHarness {
	/** Ask the harness; resolves to the answer, or rejects with the cause of a default. */
	decide(decision: DecisionDecl, context: Record<string, unknown>, deadlineMs: number): Promise<unknown>;
	/** Give the harness a turn; resolves when it is done or the timeout passes. */
	turn(turn: TurnDecl, deadlineMs: number): Promise<void>;
	/** An event was published; `seq` is its sequence number. */
	emitted(seq: number): void;
	/** The program detaches it. */
	detach(reason: string): void;
}

interface CellEntry {
	decl: CellDecl;
	/** Position in `manifest.cells`: the index into `versions`. */
	ordinal: number;
	/** Index into `values` (scalar) or `sized`. */
	slot: number;
	scalar: boolean;
	enumIndex?: Map<string, number>;
	/** Built once per cell: the typed store and load (section 11.2 rows). */
	set: (value: unknown) => void;
	get: () => unknown;
}

interface EventEntry {
	decl: EventDecl;
	ordinal: number;
	fields: Array<{ key: string; type: string; max: number | undefined }>;
}

/** Attaches an in-process harness to the binding the stub hands it. */
export type HarnessFactory = (binding: HarnessBinding) => void | Promise<void>;

export interface AbaigramExtras {
	/** The program's root, where abaigram.yaml and the content live. Default: found from the cwd on first use, else the cwd. */
	root?: string;
	env?: NodeJS.ProcessEnv;
	/** Injectable clock. */
	now?: () => number;
	/** The in-process harness for turns mode; overrides the dynamic import of the harness package. */
	harness?: HarnessFactory;
	/** Where the audit log goes; default: the manifest's path. */
	auditPath?: string;
	/** For the exercise form: where its report goes at exit. Default: stderr. */
	report?: (text: string) => void;
}

export class Abaigram {
	readonly manifest: Manifest;
	readonly mode: Mode;
	readonly modeFallback: boolean;
	readonly harnessSelection: HarnessSelection;
	/** A problem with the environment's harness selection, reported by doctor, never thrown. */
	readonly harnessSelectionError: string | undefined;
	readonly content: ContentSlots;
	/**
	 * The sidecar endpoint, listening from startup when the selected mode is
	 * sidecar and a real harness is wanted (section 6.3). A check run under
	 * `ABAI_HARNESS` keeps its null harness in-process and opens no socket.
	 */
	readonly endpoint: Endpoint | undefined;
	/** A launcher handed this program its connection (section 6.3): the full lifecycle is available to it. */
	readonly launched: boolean = false;
	readonly startedAt: string = new Date().toISOString();
	/** The root given at construction, if any; otherwise the root is found lazily. */
	readonly explicitRoot: string | undefined;
	/** @internal The region; tests and the binding reach it, programs do not. */
	readonly region: Region;
	readonly now: () => number;

	private readonly cellEntries = new Map<string, CellEntry>();
	private readonly eventEntries = new Map<string, EventEntry>();
	private readonly libraryEvents = new Map<string, number>();
	private readonly cellHandles = new Map<string, CellHandle>();
	private readonly eventHandles = new Map<string, EventHandle>();
	private readonly knobHandlers = new Map<string, KnobHandler>();
	private readonly capabilityHandlers = new Map<string, CapabilityHandler>();
	private readonly decisionIndex = new Map<string, number>();
	private readonly turnIndex = new Map<string, number>();
	private readonly queue: Array<() => void> = [];
	private harness: AttachedHarness | undefined;
	private binding: DirectBinding | undefined;
	private nullHarness: NullHarness | undefined;
	private lastAttachError: string | undefined;
	private readonly harnessFactory: HarnessFactory | undefined;
	private readonly auditPathOverride: string | undefined;
	private readonly report: (text: string) => void;
	private readonly env: NodeJS.ProcessEnv;
	readonly stopHandler: StopHandler | undefined;
	/** Who waits for a cooperative pause to lift, and the ref'd timer that keeps a paused program alive. */
	private resumeWaiters: Array<() => void> = [];
	private pauseKeepAlive: NodeJS.Timeout | undefined;
	/** Under launch: the launcher connected at least once, so nothing waits for it a second time. */
	private launcherSeen = false;

	constructor(options: AbaigramOptions, extras: AbaigramExtras = {}) {
		this.manifest = buildManifest(options);
		this.now = extras.now ?? Date.now;
		const env = extras.env ?? process.env;
		this.env = env;
		const selection = selectMode(this.manifest.modes, env);
		this.mode = selection.mode;
		this.modeFallback = selection.fallback;
		const harness = selectHarness(env);
		this.harnessSelection = harness.selection;
		this.harnessSelectionError = harness.error;
		this.stopHandler = options.lifecycle?.stop?.handler;
		this.explicitRoot = extras.root;
		this.harnessFactory = extras.harness;
		this.auditPathOverride = extras.auditPath;
		this.report =
			extras.report ??
			((text) => {
				process.stderr.write(`${text}\n`);
			});

		let scalars = 0;
		let sized = 0;
		const pending: Array<[CellDecl, number, number, boolean]> = [];
		this.manifest.cells.forEach((decl, ordinal) => {
			const scalar = decl.type !== "string" && decl.type !== "object" && decl.type !== "list";
			pending.push([decl, ordinal, scalar ? scalars++ : sized++, scalar]);
		});
		this.manifest.decisions.forEach((decl, i) => {
			this.decisionIndex.set(decl.name, i);
		});
		this.manifest.turns.forEach((decl, i) => {
			this.turnIndex.set(decl.name, i);
		});
		this.region = new Region({
			scalars,
			sized,
			counters: this.manifest.decisions.length + this.manifest.turns.length + 1,
		});
		if (this.modeFallback) this.region.counters[this.region.counters.length - 1] += 1;
		for (const [decl, ordinal, slot, scalar] of pending)
			this.cellEntries.set(decl.name, this.makeEntry(decl, ordinal, slot, scalar));

		this.manifest.events.forEach((decl, ordinal) => {
			const fields = Object.entries(decl.payload).map(([key, field]) => {
				const f = fieldOf(field);
				return { key, type: f.type, max: f.max };
			});
			this.eventEntries.set(decl.name, { decl, ordinal, fields });
		});
		LIBRARY_EVENTS.forEach((name, i) => {
			this.libraryEvents.set(name, LIBRARY_EVENT_BASE - i);
		});

		for (const [name, cell] of Object.entries(options.cells ?? {})) {
			if (cell.access === "readwrite") {
				this.cellEntries.get(name)?.set(cell.default);
				if (cell.onChange) this.knobHandlers.set(name, cell.onChange);
			}
		}
		for (const [name, capability] of Object.entries(options.capabilities ?? {})) {
			if (capability.handler) this.capabilityHandlers.set(name, capability.handler);
		}
		// the root is found on first use, so a program that never attaches never touches the filesystem
		this.content = createContent(this.manifest, () => extras.root ?? findRoot(this.manifest.name) ?? process.cwd());
		// startup is one of the five places (section 4.3): a null harness attaches here
		if (this.harnessSelection === "null" || this.harnessSelection === "exercise")
			this.attachNull(this.harnessSelection);
		// sidecar: the receiving end waits from startup (section 6.3); its failure to listen is a reason
		// the next attach reports, never a throw into the program
		const launchSocket = env[ENV_LAUNCH_SOCKET]?.trim();
		if (this.mode === "sidecar" && this.harnessSelection === "real") {
			// launched: the parent chose the socket and is waiting on it. Read once and removed, so a program
			// that spawns a copy of itself never hands it this very socket
			this.launched = launchSocket !== undefined && launchSocket !== "";
			if (this.launched && env === process.env) delete process.env[ENV_LAUNCH_SOCKET];
			this.endpoint = new Endpoint(this, {
				runDir: this.launched ? dirname(launchSocket as string) : runDirFrom(env),
				...(this.launched ? { socketPath: launchSocket as string } : {}),
			});
			this.endpoint.ready.catch((error: unknown) => {
				this.lastAttachError = `the endpoint could not listen: ${error instanceof Error ? error.message : String(error)}`;
			});
		} else if (launchSocket !== undefined && launchSocket !== "") {
			// a launcher is waiting, but this program cannot take the connection up: it runs as itself, observed
			// from outside only (section 5.7), and says why when asked
			if (env === process.env) delete process.env[ENV_LAUNCH_SOCKET];
			this.lastAttachError =
				this.harnessSelection === "real"
					? `launched, but ${this.manifest.name} declares no sidecar mode (declared: ${this.manifest.modes.join(", ")})`
					: `launched under ${ENV_HARNESS}=${this.harnessSelection}`;
		}
	}

	get name(): string {
		return this.manifest.name;
	}

	get attached(): boolean {
		return this.region.flags[FLAG_ATTACHED] !== 0;
	}

	/** Why the last attach did not happen, if it did not. */
	get attachError(): string | undefined {
		return this.lastAttachError;
	}

	// -----------------------------------------------------------------------
	// Cells and knobs (section 5.2)
	// -----------------------------------------------------------------------

	/** The typed store and load of one cell, built once so the hot path is the store alone. */
	private makeEntry(decl: CellDecl, ordinal: number, slot: number, scalar: boolean): CellEntry {
		const { values, versions, sized } = this.region;
		const entry: CellEntry = { decl, ordinal, slot, scalar, set: () => {}, get: () => undefined };
		if (!scalar) {
			entry.set = (value) => {
				sized[slot] = fitValue(value, decl);
				versions[ordinal] += 1;
			};
			entry.get = () => sized[slot];
			return entry;
		}
		switch (decl.type) {
			case "bool":
				entry.set = (value) => {
					values[slot] = value ? 1 : 0;
					versions[ordinal] += 1;
				};
				entry.get = () => values[slot] !== 0;
				break;
			case "enum": {
				const index = new Map((decl.enum ?? []).map((value, i) => [value, i]));
				const names = decl.enum ?? [];
				entry.enumIndex = index;
				entry.set = (value) => {
					const i = index.get(value as string);
					if (i === undefined) throw new Error(`${decl.name}: ${String(value)} is not a declared value`);
					values[slot] = i;
					versions[ordinal] += 1;
				};
				entry.get = () => names[values[slot]];
				break;
			}
			default:
				entry.set = (value) => {
					values[slot] = value as number;
					versions[ordinal] += 1;
				};
				entry.get = () => values[slot];
		}
		return entry;
	}

	private entry(name: string): CellEntry {
		const entry = this.cellEntries.get(name);
		if (!entry) throw new Error(`${this.name} declares no cell ${name}`);
		return entry;
	}

	/** A handle, created once per cell and cached. */
	cell<T = unknown>(name: string): CellHandle<T> {
		const cached = this.cellHandles.get(name);
		if (cached) return cached as CellHandle<T>;
		const entry = this.entry(name);
		const handle: CellHandle = { name, get: entry.get, set: entry.set };
		this.cellHandles.set(name, handle);
		return handle as CellHandle<T>;
	}

	/** A knob handle; the cell must be `readwrite`. */
	knob<T = unknown>(name: string): KnobHandle<T> {
		const entry = this.entry(name);
		if (entry.decl.access !== "readwrite") throw new Error(`${name} is a read cell, not a knob`);
		const handle = this.cell<T>(name) as KnobHandle<T>;
		if (handle.reset === undefined) {
			handle.reset = () => {
				entry.set(entry.decl.default);
				if (!entry.scalar) this.emitLibrary("abai.knob.reset", { cell: name, value: entry.get() });
			};
			handle.onChange = (handler) => {
				if (entry.scalar) throw new Error(`${name} is a scalar knob; the program reads it, nothing is delivered`);
				this.knobHandlers.set(name, handler);
			};
		}
		return handle;
	}

	/** @internal The handler a sized knob delivers to, for the binding. */
	knobHandler(name: string): KnobHandler | undefined {
		return this.knobHandlers.get(name);
	}

	/** @internal Every cell's current value, keyed by name, for the binding. */
	readCells(): Record<string, unknown> {
		const cells: Record<string, unknown> = {};
		for (const [name, entry] of this.cellEntries) cells[name] = entry.get();
		return cells;
	}

	/** @internal A cell's version counter. */
	version(name: string): number {
		return this.region.versions[this.entry(name).ordinal];
	}

	// -----------------------------------------------------------------------
	// Lifecycle (section 5.5): what the program itself can do
	// -----------------------------------------------------------------------

	/** A cooperative pause is in effect. */
	get paused(): boolean {
		return this.region.flags[FLAG_PAUSED] !== 0;
	}

	/**
	 * @internal A cooperative pause: the flag is set, and the program is held
	 * at its next touchpoint (this instantiation's deviation: a safepoint
	 * cannot block the loop the resume arrives on). A ref'd timer keeps a
	 * paused program alive, since nothing else of its own may be pending.
	 */
	requestPause(): void {
		if (this.paused) return;
		this.region.flags[FLAG_PAUSED] = 1;
		this.region.flags[FLAG_WORK] = 1;
		this.pauseKeepAlive = setInterval(() => {}, 2 ** 31 - 1);
	}

	/** @internal Lift the pause: whoever is held at a touchpoint goes on, their clocks starting now. */
	resumeFromPause(): void {
		if (!this.paused) return;
		this.region.flags[FLAG_PAUSED] = 0;
		this.region.flags[FLAG_WORK] = this.queue.length > 0 ? 1 : 0;
		if (this.pauseKeepAlive !== undefined) clearInterval(this.pauseKeepAlive);
		this.pauseKeepAlive = undefined;
		for (const waiter of this.resumeWaiters.splice(0)) waiter();
	}

	/** Hold here while a cooperative pause is in effect; the agent is told what the pause holds (4.3). */
	private awaitResume(touchpoint: string): Promise<void> {
		if (!this.paused) return Promise.resolve();
		this.emitLibrary("abai.pause.blocked", { touchpoint });
		return new Promise<void>((resolve) => {
			this.resumeWaiters.push(resolve);
		});
	}

	/** @internal What the stub knows of its own process, for `lifecycle status`. */
	lifecycleStatus(): {
		pid: number;
		name: string;
		mode: string;
		cwd: string;
		startedAt: string;
		connections: number;
		paused: boolean;
		launched: boolean;
	} {
		return {
			pid: process.pid,
			name: this.manifest.name,
			mode: this.mode,
			cwd: process.cwd(),
			startedAt: this.startedAt,
			connections: this.endpoint?.connectionCount ?? (this.attached ? 1 : 0),
			paused: this.paused,
			launched: this.launched,
		};
	}

	// -----------------------------------------------------------------------
	// Events (section 5.1)
	// -----------------------------------------------------------------------

	/** A handle for a declared event, created once and cached; the name is checked here, never on the hot path. */
	event(name: string): EventHandle {
		const cached = this.eventHandles.get(name);
		if (cached) return cached;
		const entry = this.eventEntries.get(name);
		if (!entry) throw new Error(`${this.name} declares no event ${name}`);
		const flags = this.region.flags;
		const handle: EventHandle = {
			name,
			emit: (payload = {}) => {
				if (flags[FLAG_ATTACHED] === 0) return;
				this.publish(entry, payload);
			},
		};
		this.eventHandles.set(name, handle);
		return handle;
	}

	/** Copy the declared fields, cut sized ones to their max, publish, and tell the harness. */
	private publish(entry: EventEntry, payload: Record<string, unknown>): void {
		let truncated = false;
		const copy: Record<string, unknown> = {};
		for (const field of entry.fields) {
			const value = payload[field.key];
			if (value === undefined) continue;
			switch (field.type) {
				case "string": {
					const text = String(value);
					const cut = cutUtf8(text, field.max ?? 256);
					if (cut !== text) truncated = true;
					copy[field.key] = cut;
					break;
				}
				case "object":
				case "list": {
					const bytes = encodedBytes(value);
					if (bytes > (field.max ?? 1024)) {
						truncated = true;
						copy[field.key] = { truncated: true, bytes };
					} else {
						copy[field.key] = JSON.parse(JSON.stringify(value));
					}
					break;
				}
				default:
					copy[field.key] = value;
			}
		}
		const seq = this.region.emit(entry.ordinal, copy, truncated, this.now());
		this.harness?.emitted(seq);
	}

	/** @internal A library event under the reserved prefix. */
	emitLibrary(name: string, payload: Record<string, unknown>): void {
		if (this.region.flags[FLAG_ATTACHED] === 0) return;
		const ordinal = this.libraryEvents.get(name);
		if (ordinal === undefined) throw new Error(`${name} is not a library event`);
		const seq = this.region.emit(ordinal, payload, false, this.now());
		this.harness?.emitted(seq);
	}

	/** @internal The declared event for a ring slot's ordinal, or the library event's name. */
	eventName(ordinal: number): string {
		if (ordinal < 0) return LIBRARY_EVENTS[LIBRARY_EVENT_BASE - ordinal] ?? `abai.unknown.${ordinal}`;
		return this.manifest.events[ordinal]?.name ?? `unknown.${ordinal}`;
	}

	// -----------------------------------------------------------------------
	// Capabilities and safepoints (section 5.3)
	// -----------------------------------------------------------------------

	/** Register the handler of a declared capability (or replace one given at declaration). */
	capability(name: string, handler: CapabilityHandler): void {
		if (!this.manifest.capabilities.some((c) => c.name === name)) {
			throw new Error(`${this.name} declares no capability ${name}`);
		}
		this.capabilityHandlers.set(name, handler);
	}

	/** @internal */
	capabilityHandler(name: string): CapabilityHandler | undefined {
		return this.capabilityHandlers.get(name);
	}

	/** @internal Queue work for the next safepoint; the binding uses it for safepoint dispatch. */
	enqueue(work: () => void): void {
		this.queue.push(work);
		this.region.flags[FLAG_QUEUE] = this.queue.length;
		this.region.flags[FLAG_WORK] = 1;
	}

	/** One load of a flag when nothing is queued and no pause is in effect. */
	safepoint(): void {
		if (this.region.flags[FLAG_WORK] === 0) return;
		this.drain();
	}

	/** @internal Remove queued work that will not run (a timed-out dispatch). */
	dequeue(work: () => void): void {
		const index = this.queue.indexOf(work);
		if (index === -1) return;
		this.queue.splice(index, 1);
		const flags = this.region.flags;
		flags[FLAG_QUEUE] = this.queue.length;
		if (this.queue.length === 0 && flags[FLAG_PAUSED] === 0) flags[FLAG_WORK] = 0;
	}

	/** @internal Run everything queued, now, on this thread: a touchpoint holds the program at a safepoint. */
	drain(): void {
		const flags = this.region.flags;
		while (this.queue.length > 0) {
			const work = this.queue.shift() as () => void;
			flags[FLAG_QUEUE] = this.queue.length;
			try {
				work();
			} catch {
				// a handler's failure is reported through its reply, never through the program's safepoint
			}
		}
		flags[FLAG_WORK] = flags[FLAG_PAUSED] !== 0 ? 1 : 0;
	}

	// -----------------------------------------------------------------------
	// Decisions and turns (sections 5.4, 4.3)
	// -----------------------------------------------------------------------

	private applyDefault(decl: DecisionDecl, cause: string): unknown {
		if (decl.default === "abort") throw new AbaigramAbort(decl.name, cause);
		return decl.default;
	}

	/** Ask which way to go. With no harness attached the default applies at once and is counted. */
	async decide<T = unknown>(name: string, context: Record<string, unknown> = {}): Promise<T> {
		const index = this.decisionIndex.get(name);
		if (index === undefined) throw new Error(`${this.name} declares no decision ${name}`);
		const decl = this.manifest.decisions[index];
		const harness = this.harness;
		if (this.region.flags[FLAG_ATTACHED] === 0 || harness === undefined) {
			this.region.counters[index] += 1;
			return this.applyDefault(decl, "no_harness") as T;
		}
		// a cooperative pause holds the decision here; its own clock starts when the pause lifts (4.3)
		if (this.paused) await this.awaitResume(name);
		if (this.region.flags[FLAG_ATTACHED] === 0 || this.harness === undefined) {
			this.region.counters[index] += 1;
			return this.applyDefault(decl, "no_harness") as T;
		}
		this.drain();
		try {
			return (await this.harness.decide(decl, context, this.now() + durationMs(decl.timeout))) as T;
		} catch (error) {
			return this.applyDefault(decl, error instanceof Error ? error.message : String(error)) as T;
		}
	}

	/** Give the agent a turn. With no harness attached it returns at once and is counted. */
	async turn(name: string): Promise<void> {
		const index = this.turnIndex.get(name);
		if (index === undefined) throw new Error(`${this.name} declares no turn ${name}`);
		const decl = this.manifest.turns[index];
		const harness = this.harness;
		if (this.region.flags[FLAG_ATTACHED] === 0 || harness === undefined) {
			this.region.counters[this.manifest.decisions.length + index] += 1;
			return;
		}
		if (this.paused) await this.awaitResume(name);
		if (this.region.flags[FLAG_ATTACHED] === 0 || this.harness === undefined) {
			this.region.counters[this.manifest.decisions.length + index] += 1;
			return;
		}
		this.drain();
		try {
			await this.harness.turn(decl, this.now() + durationMs(decl.timeout));
		} catch {
			// a turn that fails is a turn that ended
		}
		this.drain();
	}

	/** The counters, by kind and name: defaulted decisions, skipped turns, and the mode fallback. */
	counters(): CounterSnapshot {
		const snapshot: CounterSnapshot = {};
		this.manifest.decisions.forEach((decl, i) => {
			snapshot[`decision:${decl.name}`] = this.region.counters[i];
		});
		this.manifest.turns.forEach((decl, i) => {
			snapshot[`turn:${decl.name}`] = this.region.counters[this.manifest.decisions.length + i];
		});
		snapshot["abai.mode_fallback"] = this.region.counters[this.region.counters.length - 1];
		return snapshot;
	}

	/** @internal Read and reset the counters, for the harness that attaches. */
	takeCounters(): CounterSnapshot {
		const snapshot = this.counters();
		this.region.counters.fill(0);
		return snapshot;
	}

	// -----------------------------------------------------------------------
	// Attaching (section 4.3)
	// -----------------------------------------------------------------------

	/** @internal The binding attaches a harness. */
	setHarness(harness: AttachedHarness): void {
		this.harness = harness;
		this.region.flags[FLAG_ATTACHED] = 1;
		this.lastAttachError = undefined;
	}

	/** @internal The binding detaches it; a decision in flight takes its default with `reason`. */
	clearHarness(reason: string): void {
		const harness = this.harness;
		this.harness = undefined;
		this.binding = undefined;
		this.nullHarness = undefined;
		this.region.flags[FLAG_ATTACHED] = 0;
		this.lastAttachError = reason;
		// a pause is the attached harness's: when the harness goes the program runs as itself again (6.3)
		this.resumeFromPause();
		harness?.detach(reason);
	}

	/** The direct binding, while an in-process harness is attached. */
	get directBinding(): HarnessBinding | undefined {
		return this.binding;
	}

	/** The null harness, while one is attached. */
	get attachedNullHarness(): NullHarness | undefined {
		return this.nullHarness;
	}

	private createBinding(connection?: string): DirectBinding {
		const binding = new DirectBinding(this, {
			...(this.auditPathOverride === undefined ? {} : { auditPath: this.auditPathOverride }),
			...(connection === undefined ? {} : { connection }),
		});
		this.binding = binding;
		this.setHarness(binding);
		binding.flushCounters();
		return binding;
	}

	/**
	 * @internal A front end of the library's own (the sidecar endpoint)
	 * attaches the program through a binding it then drives; the connection's
	 * id labels its acts in the audit. Refused while something else is
	 * attached: a second harness would take the program over silently.
	 */
	bind(connection: string): DirectBinding {
		if (this.attached) {
			throw new Error(`${this.name} already has a harness attached; this connection cannot take it over`);
		}
		if (this.launched) this.launcherSeen = true;
		return this.createBinding(connection);
	}

	private attachNull(form: "null" | "exercise"): void {
		const binding = this.createBinding();
		this.nullHarness = attachNullHarness(binding, form);
		if (form === "exercise") {
			const harness = this.nullHarness;
			process.once("exit", () => {
				if (this.nullHarness === harness) this.report(JSON.stringify(harness.report()));
			});
		}
	}

	/**
	 * Connect or spawn a harness (one of the five places). Resolves true when
	 * attached. The real harness arrives through the `harness` extra, or the
	 * harness package's dynamic import once it exists; until then the reason
	 * is recorded.
	 */
	async attach(): Promise<boolean> {
		if (this.attached) return true;
		switch (this.harnessSelection) {
			case "off":
				this.lastAttachError = `${ENV_HARNESS}=off`;
				return false;
			case "null":
			case "exercise":
				this.attachNull(this.harnessSelection);
				return true;
			default:
				if (this.harnessSelectionError !== undefined) {
					this.lastAttachError = this.harnessSelectionError;
					return false;
				}
				if (this.endpoint) {
					// launched: the parent is already connecting; the program never spawns anything itself
					return this.launched ? this.awaitLauncher(this.endpoint) : this.attachSidecar(this.endpoint);
				}
				try {
					const factory =
						this.harnessFactory ??
						(await installedHarness(
							this.env[ENV_HARNESS_MODULE] || this.manifest.harness?.path || "@abaigram/abai-embedded-harness",
						));
					if (factory === undefined) {
						this.lastAttachError =
							"no harness is installed (the @abaigram/abai-embedded-harness package is not resolvable)";
						return false;
					}
					const binding = this.createBinding();
					await factory(binding);
					return this.attached;
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					this.binding?.detach(reason);
					this.lastAttachError = reason;
					return false;
				}
		}
	}

	/** Under launch: the launcher connects to the socket it chose; the program waits for it once, bounded. */
	private async awaitLauncher(endpoint: Endpoint): Promise<boolean> {
		try {
			await endpoint.ready;
		} catch (error) {
			this.lastAttachError = `the endpoint could not listen: ${error instanceof Error ? error.message : String(error)}`;
			return false;
		}
		if (this.attached) return true;
		if (this.launcherSeen) {
			// it was here and went: a later attach place returns at once, as 4.3 says of every touchpoint after a detach
			this.lastAttachError = this.lastAttachError ?? "the launcher disconnected";
			return false;
		}
		const waitMs = attachWaitMsFrom(this.env);
		if (await endpoint.waitForConnection(waitMs)) {
			this.launcherSeen = true;
			return true;
		}
		this.lastAttachError = `launched, but the launcher did not connect within ${waitMs} ms`;
		return false;
	}

	/**
	 * Sidecar attach (section 6.3): a harness already connected to the
	 * endpoint means attached; otherwise the harness binary is spawned with
	 * the terminal inherited and given `ABAI_ATTACH_WAIT_MS` to connect. A
	 * child that exits first fails the attach at once with its code, so an
	 * unconfigured machine costs well under a second (section 4.3); a child
	 * that never connects is ended at the wait and the attach fails with the
	 * reason. The child is unref'd: a program whose work is done exits, and
	 * the closing socket tells the harness.
	 */
	private async attachSidecar(endpoint: Endpoint): Promise<boolean> {
		try {
			await endpoint.ready;
		} catch {
			// spawnHarness reports it
		}
		// a harness that connected while the endpoint came up, or at any time before: attached already
		if (this.attached) return true;
		const spawned = await this.spawnHarness(endpoint, "attach");
		return spawned !== undefined;
	}

	/**
	 * Spawn the harness binary with a verb against this program's endpoint
	 * and wait for it to connect. Resolves to the child once attached, or to
	 * undefined with the reason in `attachError`: the endpoint could not
	 * listen, the child exited first (its code), it never connected within
	 * the wait (it is ended), or it could not be started at all.
	 */
	private async spawnHarness(endpoint: Endpoint, verb: "attach" | "mcp"): Promise<ChildProcess | undefined> {
		try {
			await endpoint.ready;
		} catch (error) {
			this.lastAttachError = `the endpoint could not listen: ${error instanceof Error ? error.message : String(error)}`;
			return undefined;
		}
		const waitMs = attachWaitMsFrom(this.env);
		const binary = harnessBinary(this.env, this.content.root);
		const args = [...binary.args, verb, "--target", endpoint.socketPath, "--run-dir", endpoint.runDir];
		let child: ChildProcess;
		try {
			child = spawn(binary.command, args, { stdio: "inherit", env: { ...process.env, ...this.env } });
		} catch (error) {
			this.lastAttachError = `the harness binary could not be started: ${error instanceof Error ? error.message : String(error)}`;
			return undefined;
		}
		child.unref();
		// a ChildProcess with no error listener throws into the program; one stays for the child's whole life
		child.on("error", () => {});
		const outcome = await new Promise<string>((resolve) => {
			let settled = false;
			const settle = (result: string): void => {
				if (settled) return;
				settled = true;
				child.off("exit", onExit);
				child.off("error", onError);
				resolve(result);
			};
			const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
				settle(`exited:${code === null ? `signal ${signal ?? "unknown"}` : String(code)}`);
			const onError = (error: NodeJS.ErrnoException): void => settle(`error:${error.code ?? error.message}`);
			child.once("exit", onExit);
			child.once("error", onError);
			void endpoint.waitForConnection(waitMs).then((connected) => settle(connected ? "connected" : "timeout"));
		});
		if (outcome === "connected") return child;
		if (outcome === "timeout") {
			// the one process this program started, by its own handle: nothing else is touched
			child.kill();
			this.lastAttachError = `the harness binary did not connect within ${waitMs} ms (${binary.command})`;
			return undefined;
		}
		if (outcome.startsWith("exited:")) {
			this.lastAttachError = `the harness binary exited with ${outcome.slice("exited:".length)} before connecting`;
			return undefined;
		}
		this.lastAttachError = `the harness binary could not be started: ${outcome.slice("error:".length)} (${binary.command})`;
		return undefined;
	}

	/**
	 * @internal `<prog> abai mcp` under sidecar: the binary's MCP server is
	 * spawned against this program's endpoint with the terminal inherited, so
	 * the MCP client on this process's stdin and stdout talks to it, and the
	 * program waits at its entry, a safepoint it holds open, until the client
	 * goes. Resolves to the child's exit code; -1 when nothing could be
	 * spawned (the reason is in `attachError`).
	 */
	async serveMcpSidecar(endpoint: Endpoint): Promise<number> {
		if (this.attached) {
			this.lastAttachError = `${this.name} already has a harness attached`;
			return -1;
		}
		const child = await this.spawnHarness(endpoint, "mcp");
		if (child === undefined) return -1;
		// the program's whole purpose now is to wait for its server: the child holds the event loop open,
		// where the spawn left it unref'd for the attach case, whose touchpoint holds the loop itself
		child.ref();
		// the MCP client spawned this program and ends it with a signal; the server behind it must go too
		const forward = (signal: NodeJS.Signals): void => {
			if (child.exitCode === null && child.signalCode === null) child.kill(signal);
		};
		const forwarded: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
		for (const signal of forwarded) process.on(signal, forward);
		const binding = this.binding;
		binding?.enterSafepoint();
		try {
			if (child.exitCode !== null) return child.exitCode;
			return await new Promise<number>((resolve) => {
				child.once("exit", (code) => resolve(code ?? 1));
			});
		} finally {
			for (const signal of forwarded) process.off(signal, forward);
			binding?.leaveSafepoint();
		}
	}

	private async touchpoint(kind: TouchpointKind): Promise<void> {
		if (!(await this.attach())) return;
		if (this.paused) await this.awaitResume(kind);
		const binding = this.binding;
		if (!binding) return;
		this.drain();
		await binding.touchpoint(kind);
		this.drain();
	}

	/** Run the install touchpoint; returns when the harness finishes, or at once when none can be attached. */
	install(): Promise<void> {
		return this.touchpoint("install");
	}

	/** Open a session; returns when the harness ends it, or at once when none can be attached. */
	session(): Promise<void> {
		return this.touchpoint("session");
	}
}

/** Overrides where the in-process harness is imported from (a path or a package name). */
export const ENV_HARNESS_MODULE = "ABAI_HARNESS_MODULE";

/**
 * The harness binary to spawn under sidecar: `ABAI_HARNESS_BIN` (a script
 * path runs under this very node), else the program's own
 * `node_modules/.bin/abai-embedded-harness`, else the name on PATH.
 */
export function harnessBinary(env: NodeJS.ProcessEnv, root: string): { command: string; args: string[] } {
	const explicit = env[ENV_HARNESS_BIN]?.trim();
	if (explicit) {
		return /\.(?:[mc]?js|ts)$/.test(explicit)
			? { command: process.execPath, args: [explicit] }
			: { command: explicit, args: [] };
	}
	const local = join(root, "node_modules", ".bin", "abai-embedded-harness");
	if (existsSync(local)) return { command: local, args: [] };
	return { command: "abai-embedded-harness", args: [] };
}

/** What the stub uses of the installed harness package. */
export interface HarnessModule {
	attachEmbedded?: (binding: HarnessBinding) => Promise<unknown>;
	/** `<prog> abai mcp` in-process: serve this binding to the MCP client on the process's stdio; resolves to the exit code. */
	serveMcpEmbedded?: (binding: HarnessBinding) => Promise<number>;
	runConfig?: (
		args: string[],
		io: { out(text: string): void; err(text: string): void; env: NodeJS.ProcessEnv },
	) => Promise<number>;
	doctorOnline?: (
		manifest: Manifest,
		env: NodeJS.ProcessEnv,
	) => Promise<Array<{ name: string; status: "ok" | "fail" | "skip"; detail: string }>>;
}

/** The harness package, found by dynamic import when a program installed it; undefined when it does not resolve. */
export async function importHarnessModule(
	env: NodeJS.ProcessEnv,
	manifest: Manifest,
): Promise<HarnessModule | undefined> {
	const specifier = env[ENV_HARNESS_MODULE] || manifest.harness?.path || "@abaigram/abai-embedded-harness";
	try {
		return (await import(specifier)) as HarnessModule;
	} catch {
		return undefined;
	}
}

/** The harness package's in-process entry. */
async function installedHarness(specifier: string): Promise<HarnessFactory | undefined> {
	let module: HarnessModule;
	try {
		module = (await import(specifier)) as HarnessModule;
	} catch {
		return undefined;
	}
	if (typeof module.attachEmbedded !== "function") return undefined;
	const attach = module.attachEmbedded;
	return async (binding) => {
		await attach(binding);
	};
}

/** The program's one call: declarations in, the abaigram out. Throws when a declaration does not validate. */
export function createAbaigram(options: AbaigramOptions, extras: AbaigramExtras = {}): Abaigram {
	return new Abaigram(options, extras);
}
