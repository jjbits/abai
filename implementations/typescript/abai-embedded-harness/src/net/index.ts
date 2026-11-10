// The harness's network layer: an aiipd client, the daemon for a state
// directory, and where a run's identity lives. Exported for realizations
// too: the arena creates a world's network and mints an invite per ship
// through the same client.
export {
	AIIP_BODY_CAP,
	AIIP_JOIN_TIMEOUT_MS,
	AIIP_MEMBERS_TIMEOUT_MS,
	AIIP_REQUEST_TIMEOUT_MS,
	AIIP_SOCKET_NAME,
	AIIP_SOCKET_PATH_MAX,
	AiipClient,
	AiipError,
	type AiipInvite,
	type AiipJoinResult,
	type AiipMember,
	type AiipMembers,
	type AiipMembership,
	type AiipPeer,
	type AiipPeerDetail,
	type AiipPeers,
	type AiipStatus,
	type CreateNetworkRequest,
	isAlreadyMember,
	KNOWN_AIIP_API,
} from "./client.ts";
export {
	type AiipDaemon,
	type ChildLike,
	DEFAULT_POLL_MS,
	DEFAULT_READY_TIMEOUT_MS,
	DEFAULT_STOP_TIMEOUT_MS,
	type EnsureOptions,
	ensureAiipDaemon,
	type SpawnFn,
	socketPathFor,
} from "./daemon.ts";
export {
	AIIP_BINARY_NAME,
	aiipBinaryFor,
	ENV_AIIP_BIN,
	ENV_NET_DIR,
	ENV_NET_TOKEN,
	networkDirFor,
} from "./dir.ts";
export {
	type ConnectNetworkInput,
	type ConnectNetworkOutcome,
	connectNetwork,
	membershipsOnDisk,
	type NetworkDeclaration,
	type NetworkMembership,
	type NetworkMemberView,
	type NetworkPeers,
	type NetworkStatus,
	NO_BINARY,
	noMembership,
	RunNetwork,
} from "./membership.ts";
