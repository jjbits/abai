//! The harness's network layer: an aiipd client, the daemon for a state
//! directory, where a run's identity lives, the aiap envelope, the mail
//! loops, and a run's network. Exported for realizations too: the arena
//! creates a world's network and mints an invite per ship through the same
//! client.

pub mod client;
pub mod daemon;
pub mod dir;
pub mod envelope;
#[doc(hidden)]
pub mod fake;
pub mod mail;
pub mod membership;

pub use client::{
    AIIP_BODY_CAP, AIIP_JOIN_TIMEOUT_MS, AIIP_MEMBERS_TIMEOUT_MS, AIIP_PAYLOAD_CAP,
    AIIP_RECV_WAIT_MAX_MS, AIIP_RECV_WAIT_MS, AIIP_REQUEST_TIMEOUT_MS, AIIP_SEND_TIMEOUT_MS,
    AIIP_SOCKET_NAME, AIIP_SOCKET_PATH_MAX, AIIP_STATUS_TIMEOUT_MS, AiipClient, AiipError,
    AiipInvite, AiipJoinResult, AiipMember, AiipMembers, AiipMembership, AiipMessage, AiipPeer,
    AiipPeerDetail, AiipPeers, AiipSendResult, AiipSender, AiipStatus, CreateNetworkRequest,
    KNOWN_AIIP_API, is_already_member,
};
pub use daemon::{
    AiipDaemon, ChildExit, ChildLike, DEFAULT_POLL_MS, DEFAULT_READY_TIMEOUT_MS,
    DEFAULT_STOP_TIMEOUT_MS, DaemonStop, EnsureOptions, KillSignal, SpawnFn, SpawnRequest,
    ensure_aiip_daemon, socket_path_for,
};
pub use dir::{
    AIIP_BINARY_NAME, ENV_AIIP_BIN, ENV_NET_DIR, ENV_NET_TOKEN, aiip_binary_for, find_on_path,
    network_dir_for, without_invite_token,
};
pub use envelope::{
    Classified, EncodedMessage, Envelope, EnvelopeType, MessageInput, classify, encode_message,
    new_message_id, validate,
};
pub use mail::{MailDelivery, MailHandler, MailLoop, MailLoopOptions, Note, OnDropped};
pub use membership::{
    ConnectNetworkInput, ConnectNetworkOutcome, DaemonOrigin, NO_BINARY, NetworkDeclaration,
    NetworkMemberView, NetworkMembership, NetworkPeers, NetworkStatus, RunNetwork,
    RunNetworkOptions, connect_network, memberships_on_disk, no_membership,
};
