/** The abai stub: the library a TypeScript program includes to become an abaigram. See spec/abaigrammar.md. */
export const ABAI_STUB_VERSION = "0.1.0";

export { type AuditAct, AuditLog, type AuditOutcome, type AuditRecord, capValue, summarizeAnswer } from "./audit.ts";
export { fitValue, validateKnobValue } from "./cells/fit.ts";
export { type ContentSlots, createContent, findRoot, MANIFEST_FILE } from "./content.ts";
export {
	CONSECUTIVE_TIMEOUTS_LIMIT,
	DEFAULT_MAX_BUFFERED,
	Endpoint,
	type EndpointOptions,
	shortSocketPath,
} from "./endpoint.ts";
export { type DoctorCheck, type DoctorReport, type EntryIo, runDoctor, runEntry } from "./entry.ts";
export {
	attachWaitMsFrom,
	DEFAULT_ATTACH_WAIT_MS,
	ENV_ATTACH_WAIT_MS,
	ENV_HARNESS,
	ENV_HARNESS_BIN,
	ENV_LAUNCH_SOCKET,
	ENV_MODE,
	ENV_RUN_DIR,
	expandHome,
	type HarnessSelection,
	runDirFrom,
	selectHarness,
	selectMode,
} from "./env.ts";
export {
	type BindingEvents,
	CallError,
	type CallErrorCode,
	type CellReading,
	type Consent,
	type DecisionRequest,
	DirectBinding,
	type EventBatch,
	type HarnessBinding,
	type KnobWriteOutcome,
	type LiveEvent,
	schemaProblem,
	type TouchpointKind,
	type TouchpointRequest,
	type TurnRequest,
} from "./harness-binding.ts";
export * from "./manifest/index.ts";
export { attachNullHarness, type NullForm, type NullHarness, type NullHarnessReport } from "./null-harness.ts";
export {
	Abaigram,
	AbaigramAbort,
	type AbaigramExtras,
	type AttachedHarness,
	type CellHandle,
	type CounterSnapshot,
	createAbaigram,
	ENV_HARNESS_MODULE,
	type EventHandle,
	type HarnessFactory,
	type KnobHandle,
} from "./program.ts";
export {
	type EventSlot,
	FLAG_ATTACHED,
	FLAG_PARKED,
	FLAG_PAUSED,
	FLAG_QUEUE,
	Region,
	RING_CAPACITY,
} from "./region.ts";
export {
	type AbaigramOptions,
	buildManifest,
	type CapabilityHandler,
	type CapabilityOptions,
	type CellOptions,
	type DecisionOptions,
	type EventOptions,
	INSTANTIATION_DEVIATIONS,
	type KnobHandler,
	SIDECAR_DEVIATION,
	type StopHandler,
	type TurnOptions,
} from "./registry.ts";
export { MAX_SOCKET_PATH_BYTES } from "./wire/descriptor.ts";
export * from "./wire/index.ts";
