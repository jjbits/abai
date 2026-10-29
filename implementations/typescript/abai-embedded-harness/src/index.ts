/** The abai embedded harness. See spec/abaigrammar.md, section 4. */

export { type AgentModel, SessionForm, type SessionFormOptions, toAgentTool } from "./agent.ts";
export { type CliIo, doctorOnline, type OnlineCheck, runConfig } from "./cli.ts";
export {
	type AbaiConfig,
	abaiHome,
	CONFIG_FILE,
	CREDENTIALS_FILE,
	DEFAULT_CONNECT_TIMEOUT_MS,
	ENV_HOME,
	FileCredentialStore,
	readConfig,
	writeConfig,
} from "./config.ts";
export { attachEmbedded, type Embedded, type EmbeddedOptions, serveMcpEmbedded } from "./embedded.ts";
export { Harness, type HarnessDeps, type HarnessStatus } from "./harness.ts";
export { MCP_MAX_LINE_BYTES, MCP_PROTOCOL_VERSIONS, MCP_SERVER_NAME, type McpDeps, serveMcp } from "./mcp.ts";
export { createModelSetup, ModelNotConfigured, type ModelSetup, resolveConfiguredModel } from "./model/index.ts";
export {
	DEFAULT_WAIT_MAX_S,
	defaultOptions,
	type HarnessForm,
	type HarnessOptions,
	MAX_WAIT_MAX_S,
} from "./options.ts";
export { type ComposeInput, composeInstructions, composeSystemPrompt } from "./prompt.ts";
export * from "./scheduler.ts";
export { terminalChannel } from "./terminal-channel.ts";
export {
	capResult,
	HARNESS_TOOLS,
	type HarnessToolSpec,
	RESULT_CAP,
	type ToolForm,
	type ToolFront,
	toolsFor,
} from "./tools.ts";
export * from "./transport.ts";
export { DirectTransport } from "./transport-direct.ts";
export { SocketTransport, type SocketTransportOptions } from "./transport-socket.ts";
export { type ScriptedChannel, scriptedChannel, type UserChannel } from "./user-channel.ts";
export { ABAI_HARNESS_VERSION } from "./version.ts";
export { parseWakeCondition, type WakeCondition, wakesFor } from "./wakes.ts";
export {
	type ClaimOptions,
	type ClientEvents,
	type ConnectOptions,
	type ConnectTarget,
	type HookHandler,
	type ReasonedResult,
	type RequestOptions,
	type ResolvedTarget,
	resolveTarget,
	WireClient,
	withReason,
} from "./wire/client.ts";
