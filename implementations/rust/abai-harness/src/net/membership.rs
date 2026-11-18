//! A run's network (abaigrammar section 7, `network`): the daemon it talks
//! to and the memberships it holds. The harness connects it at attach: the
//! state directory for the run, the binary, the daemon found or started, a
//! join when the environment hands the run an invite, then the memberships.
//! `required` turns every failure into a refusal to attach; otherwise the
//! run goes on without a network and the prompt says why. abai decides none
//! of the meaning: which network, who joins and how members relate to the
//! program's own names are the program's (its `doc`) and its operator's.
//!
//! Who stops the daemon: a run owns its state directory only when
//! `ABAI_NET_DIR` names it (the arena gives each ship one); then the daemon
//! this run started goes with the run. The shared per-program directory
//! keeps its daemon for the next run, as the aiip CLI leaves its daemons,
//! so two runs of one program never end each other's daemon.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use super::client::{AiipClient, AiipError, AiipMembership, is_already_member};
use super::daemon::{AiipDaemon, EnsureOptions, SpawnFn, ensure_aiip_daemon, socket_path_for};
use super::dir::{ENV_NET_DIR, ENV_NET_TOKEN, aiip_binary_for, network_dir_for};
use super::mail::{MailHandler, MailLoop, MailLoopOptions, Note, OnDropped};
use crate::config::{self, Config};

pub type NetworkDeclaration = abai_stub::manifest::NetworkDecl;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NetworkMembership {
    /// The network's name, as the authority named it.
    pub network: String,
    pub id: String,
    /// This run's member name on it, issued by the authority.
    pub member: String,
    pub addr: String,
    pub authority: bool,
    /// Slots the authority issued besides this one.
    pub peers: u32,
}

/// Whether the daemon answering was started by this run or found running.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DaemonOrigin {
    Spawned,
    Found,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    pub dir: PathBuf,
    pub daemon: DaemonOrigin,
    /// This run ends the daemon it started at shutdown: the directory is the run's own (`ABAI_NET_DIR`).
    pub owned: bool,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_skew: Option<String>,
    pub memberships: Vec<NetworkMembership>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkMemberView {
    /// The name the network's authority issued; absent for a peer the roster does not list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// A name the member declared about itself, not issued by the authority: a display hint that does not route.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_name: Option<String>,
    pub addr: String,
    /// An authenticated frame from this member has been seen: by the authority when the roster came from it
    /// (`source: "authority"`), else by this run's own daemon.
    pub enrolled: bool,
    #[serde(rename = "self")]
    pub self_: bool,
    /// A tunnel from this run to the member exists now.
    pub established: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NetworkPeers {
    pub network: String,
    pub member: String,
    pub addr: String,
    /// `authority` when the roster came fresh from the authority, `cached` otherwise, `unavailable` when it could not be read.
    pub source: String,
    pub members: Vec<NetworkMemberView>,
    /// Why the roster or the live view could not be read, when it could not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn to_membership(m: &AiipMembership) -> NetworkMembership {
    NetworkMembership {
        network: m.network_name.clone(),
        id: m.network_id.clone(),
        member: m.self_name.clone(),
        addr: m.self_addr.clone(),
        authority: m.authority,
        peers: m.peers,
    }
}

/// How long a roster read for naming a sender may take, and how long a roster serves before an unknown address makes it fetch again.
pub const ROSTER_LOOKUP_TIMEOUT_MS: u64 = 5_000;
pub const ROSTER_REFRESH_MIN_MS: u64 = 10_000;

/// The clock a run's network reads.
pub type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

#[derive(Clone, Default)]
pub struct RunNetworkOptions {
    pub mail: MailLoopOptions,
    /// Default `Instant::now`.
    pub now: Option<Clock>,
}

impl std::fmt::Debug for RunNetworkOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunNetworkOptions")
            .field("mail", &self.mail)
            .field("now", &self.now.as_ref().map(|_| "(given)"))
            .finish()
    }
}

struct Roster {
    at: Instant,
    by_addr: HashMap<String, String>,
}

/// What the mail threads share with the owner.
struct NetState {
    memberships: Vec<NetworkMembership>,
    snapshot: Vec<NetworkMembership>,
    rosters: HashMap<String, Roster>,
}

fn lock(state: &Mutex<NetState>) -> MutexGuard<'_, NetState> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

/// List the memberships again; the mail loops follow.
fn refresh_with(
    client: &AiipClient,
    state: &Mutex<NetState>,
    mail: &MailLoop,
) -> Result<Vec<NetworkMembership>, AiipError> {
    let list: Vec<NetworkMembership> = client.networks()?.iter().map(to_membership).collect();
    lock(state).memberships = list.clone();
    mail.sync(&list);
    Ok(list)
}

/// This run's network: the daemon, the memberships as last listed, the
/// snapshot the prompt was composed from, and the mail loops that read the
/// memberships' mailboxes while a harness is attached.
pub struct RunNetwork {
    pub daemon: AiipDaemon,
    pub owned: bool,
    pub mail: MailLoop,
    state: Arc<Mutex<NetState>>,
    now: Clock,
}

impl std::fmt::Debug for RunNetwork {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunNetwork")
            .field("daemon", &self.daemon)
            .field("owned", &self.owned)
            .field("memberships", &lock(&self.state).memberships)
            .finish_non_exhaustive()
    }
}

impl RunNetwork {
    pub fn new(
        daemon: AiipDaemon,
        memberships: Vec<AiipMembership>,
        owned: bool,
        note: Note,
        options: RunNetworkOptions,
    ) -> Self {
        let listed: Vec<NetworkMembership> = memberships.iter().map(to_membership).collect();
        let state = Arc::new(Mutex::new(NetState {
            snapshot: listed.clone(),
            memberships: listed,
            rosters: HashMap::new(),
        }));
        let now = options.now.unwrap_or_else(|| Arc::new(Instant::now));
        // a loop the daemon dropped asks for the list again; it holds the mail loop weakly, so dropping the run ends all
        let mail_slot: Arc<std::sync::OnceLock<std::sync::Weak<super::mail::Shared>>> =
            Arc::default();
        let user_dropped = options.mail.on_dropped.clone();
        let (client, shared_state, slot) =
            (daemon.client.clone(), state.clone(), mail_slot.clone());
        let on_dropped: OnDropped = Arc::new(move |m: &NetworkMembership| {
            if let Some(user) = &user_dropped {
                user(m);
            }
            if let Some(shared) = slot.get().and_then(std::sync::Weak::upgrade) {
                let mail = MailLoop::from_shared(shared);
                let _ = refresh_with(&client, &shared_state, &mail);
            }
        });
        let mail = MailLoop::new(
            daemon.client.clone(),
            note,
            MailLoopOptions {
                on_dropped: Some(on_dropped),
                ..options.mail
            },
        );
        let _ = mail_slot.set(mail.downgrade());
        Self {
            daemon,
            owned,
            mail,
            state,
            now,
        }
    }

    /// Read every membership's mailbox, handing each message to `handler`, until `stop_mail` or `stop`.
    pub fn start_mail(&self, handler: MailHandler) {
        let memberships = lock(&self.state).memberships.clone();
        self.mail.start(handler, &memberships);
    }

    /// Stop reading the mailboxes; what arrives next waits in the daemon.
    pub fn stop_mail(&self) {
        self.mail.stop();
    }

    /// The name the network's authority issued to an address, from the roster
    /// (fetched again when an address is unknown and the roster, or the last
    /// try for it, is older than `ROSTER_REFRESH_MIN_MS`); `None` when none
    /// is known, so the caller shows the address.
    pub fn name_for(&self, network_id: &str, addr: &str) -> Option<String> {
        {
            let state = lock(&self.state);
            if let Some(own) = state.memberships.iter().find(|m| m.id == network_id)
                && own.addr == addr
            {
                return Some(own.member.clone());
            }
            let roster = state.rosters.get(network_id);
            let known = roster.is_some_and(|r| r.by_addr.contains_key(addr));
            let fresh = roster.is_some_and(|r| {
                (self.now)().saturating_duration_since(r.at)
                    < Duration::from_millis(ROSTER_REFRESH_MIN_MS)
            });
            if known || fresh {
                return roster.and_then(|r| r.by_addr.get(addr).cloned());
            }
        }
        let read = self
            .daemon
            .client
            .members_with(network_id, ROSTER_LOOKUP_TIMEOUT_MS, None);
        let mut state = lock(&self.state);
        let by_addr = match read {
            Ok(read) => read
                .members
                .into_iter()
                .filter_map(|s| s.name.filter(|n| !n.is_empty()).map(|n| (s.addr, n)))
                .collect(),
            // the last roster, or none, stands; the failed try counts as the last, so an authority that is down
            // costs one wait per refresh period, not one per message
            Err(_) => state
                .rosters
                .remove(network_id)
                .map(|r| r.by_addr)
                .unwrap_or_default(),
        };
        let name = by_addr.get(addr).cloned();
        state.rosters.insert(
            network_id.to_string(),
            Roster {
                at: (self.now)(),
                by_addr,
            },
        );
        name
    }

    pub fn status(&self) -> NetworkStatus {
        NetworkStatus {
            dir: self.daemon.dir.clone(),
            daemon: if self.daemon.spawned {
                DaemonOrigin::Spawned
            } else {
                DaemonOrigin::Found
            },
            owned: self.owned,
            version: self.daemon.version.clone(),
            version_skew: self.daemon.version_skew.clone(),
            memberships: lock(&self.state).memberships.clone(),
        }
    }

    /// The memberships at attach: what the prompt names, byte-stable for the run.
    pub fn prompt_memberships(&self) -> Vec<NetworkMembership> {
        lock(&self.state).snapshot.clone()
    }

    /// List the memberships again (a `config net` run in another process may have changed them); the mail loops follow.
    pub fn refresh(&self) -> Result<Vec<NetworkMembership>, AiipError> {
        refresh_with(&self.daemon.client, &self.state, &self.mail)
    }

    /// A reattach took this network up again: the prompt's snapshot follows the current list.
    pub fn retake(&self) -> Result<(), AiipError> {
        let list = self.refresh()?;
        lock(&self.state).snapshot = list;
        Ok(())
    }

    /// Every member of every network this run is on, with whether each is enrolled and reachable now. The
    /// memberships are listed afresh first; a network whose roster cannot be read is reported with its error.
    pub fn peers(&self) -> Vec<NetworkPeers> {
        self.peers_within(crate::net::client::AIIP_MEMBERS_TIMEOUT_MS)
    }

    /// [`RunNetwork::peers`], with each roster read given at most `timeout_ms`.
    pub fn peers_within(&self, timeout_ms: u64) -> Vec<NetworkPeers> {
        // when the list cannot be read, the last list stands
        let _ = self.refresh();
        let memberships = lock(&self.state).memberships.clone();
        memberships
            .iter()
            .map(|m| {
                self.peers_of(m, timeout_ms)
                    .unwrap_or_else(|error| NetworkPeers {
                        network: m.network.clone(),
                        member: m.member.clone(),
                        addr: m.addr.clone(),
                        source: "unavailable".to_string(),
                        members: Vec::new(),
                        error: Some(error.message),
                    })
            })
            .collect()
    }

    fn peers_of(&self, m: &NetworkMembership, timeout_ms: u64) -> Result<NetworkPeers, AiipError> {
        let client = &self.daemon.client;
        // the roster and the live view are read side by side
        let (roster, live) = std::thread::scope(|scope| {
            let roster = scope.spawn(|| client.members_with(&m.id, timeout_ms, None));
            let live = client.peers(&m.id);
            let roster = roster
                .join()
                .unwrap_or_else(|_| Err(AiipError::new(0, "the roster read failed", None)));
            (roster, live)
        });
        let (roster, live) = (roster?, live?);
        // the roster's names are the authority's: issued, never claimed
        let mut members: Vec<NetworkMemberView> = roster
            .members
            .iter()
            .map(|slot| NetworkMemberView {
                name: slot.name.clone(),
                claimed_name: None,
                addr: slot.addr.clone(),
                enrolled: slot.enrolled,
                self_: slot.self_ == Some(true) || slot.addr == m.addr,
                established: live
                    .peers
                    .iter()
                    .find(|p| p.peer.addr == slot.addr)
                    .is_some_and(|p| p.established),
            })
            .collect();
        // a peer this daemon knows that the roster does not list (a roster read from cache): its name, if any,
        // is what it said about itself
        for peer in &live.peers {
            if members.iter().any(|x| x.addr == peer.peer.addr) {
                continue;
            }
            let claimed = peer.peer.name_claimed == Some(true);
            members.push(NetworkMemberView {
                name: peer.peer.name.clone().filter(|_| !claimed),
                claimed_name: peer.peer.name.clone().filter(|_| claimed),
                addr: peer.peer.addr.clone(),
                enrolled: peer.peer.enrolled == Some(true),
                self_: false,
                established: peer.established,
            });
        }
        Ok(NetworkPeers {
            network: m.network.clone(),
            member: m.member.clone(),
            addr: m.addr.clone(),
            source: roster.source,
            members,
            error: None,
        })
    }

    /// Stop reading mail; end the daemon when this run started it and owns the directory, else it stays for the next run.
    pub fn stop(&self) {
        self.mail.stop();
        if self.owned {
            self.daemon.stop();
        }
    }
}

/// The memberships a state directory holds, read from its records without a daemon (names and addresses only),
/// in file name order.
pub fn memberships_on_disk(dir: &Path) -> Vec<NetworkMembership> {
    let Ok(entries) = std::fs::read_dir(dir.join("memberships")) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    let mut out = Vec::new();
    for file in files {
        // a record this harness cannot read is not a membership it can name
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let (Some(Value::String(id)), Some(Value::String(name))) = (
            record.get("networkID"),
            record.get("identity").and_then(|i| i.get("name")),
        ) else {
            continue;
        };
        out.push(NetworkMembership {
            network: record
                .get("networkName")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_string(),
            id: id.clone(),
            member: name.clone(),
            addr: record
                .get("identity")
                .and_then(|i| i.get("addr"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            authority: !matches!(record.get("authority"), None | Some(Value::Null)),
            peers: record
                .get("peers")
                .and_then(Value::as_array)
                .map_or(0, |p| u32::try_from(p.len()).unwrap_or(u32::MAX)),
        });
    }
    out
}

pub struct ConnectNetworkInput<'a> {
    pub env: &'a dyn Fn(&str) -> Option<String>,
    /// The environment a daemon started here runs in; `None` for this process's. The invite token is never passed.
    pub daemon_env: Option<Vec<(String, String)>>,
    /// The program's name: its place under abai's home when `ABAI_NET_DIR` is unset.
    pub program: &'a str,
    pub declared: Option<&'a NetworkDeclaration>,
    /// The network of the previous attach, reused when its directory is the same, stopped otherwise.
    pub current: Option<RunNetwork>,
    pub spawn: Option<SpawnFn>,
    /// A line for the harness's transcript.
    pub note: Note,
}

impl std::fmt::Debug for ConnectNetworkInput<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectNetworkInput")
            .field("program", &self.program)
            .field("declared", &self.declared)
            .field("current", &self.current)
            .finish_non_exhaustive()
    }
}

/// The network, or the reason there is none (`absent`; `None` when nothing asked for one).
#[derive(Debug)]
pub struct ConnectNetworkOutcome {
    pub network: Option<RunNetwork>,
    pub absent: Option<String>,
    pub declared: bool,
}

pub const NO_BINARY: &str = "no aiip binary found: set ABAI_AIIP_BIN, run \"abai config set aiip-bin <path>\", or put aiip on the PATH";

pub fn no_membership(dir: &Path) -> String {
    format!(
        "no membership in {} (set {ENV_NET_TOKEN} to an invite, or run: <prog> abai config net join --token -)",
        dir.display()
    )
}

/// What a failure needs to know.
struct Attempt<'a> {
    owned: bool,
    required: bool,
    declared: bool,
    note: &'a Note,
}

impl Attempt<'_> {
    /// What this run started and owns goes with the failure; a shared directory's daemon stays.
    fn fail(
        &self,
        reason: impl Into<String>,
        daemon: Option<&AiipDaemon>,
    ) -> Result<ConnectNetworkOutcome, String> {
        let reason = reason.into();
        if self.owned
            && let Some(daemon) = daemon.filter(|d| d.spawned)
        {
            daemon.stop();
        }
        if self.required {
            return Err(format!("the program requires a network: {reason}"));
        }
        (self.note)(&format!("# network: none ({reason})"));
        Ok(ConnectNetworkOutcome {
            network: None,
            absent: Some(reason),
            declared: self.declared,
        })
    }
}

/// The daemon in hand: the previous attach's network, or one found or started now.
enum Held {
    Reused(RunNetwork),
    Fresh(AiipDaemon),
}

impl Held {
    fn daemon(&self) -> &AiipDaemon {
        match self {
            Self::Reused(network) => &network.daemon,
            Self::Fresh(daemon) => daemon,
        }
    }
}

fn trimmed(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// The network for a run, or the reason it has none. Nothing declared and
/// nothing in the environment means no network and no reason. A declared
/// `required` network turns every failure into an `Err`; the caller then
/// attaches nothing. A daemon this call started is ended on failure only
/// when the run owns the directory.
pub fn connect_network(input: ConnectNetworkInput<'_>) -> Result<ConnectNetworkOutcome, String> {
    let ConnectNetworkInput {
        env,
        daemon_env,
        program,
        declared,
        current,
        spawn,
        note,
    } = input;
    let token = trimmed(env(ENV_NET_TOKEN));
    let explicit_dir = trimmed(env(ENV_NET_DIR));
    let is_declared = declared.is_some();
    if !is_declared && token.is_none() && explicit_dir.is_none() {
        if let Some(current) = current {
            current.stop();
        }
        return Ok(ConnectNetworkOutcome {
            network: None,
            absent: None,
            declared: false,
        });
    }
    let attempt = Attempt {
        owned: explicit_dir.is_some(),
        required: declared.is_some_and(|d| d.required == Some(true)),
        declared: is_declared,
        note: &note,
    };

    let dir = match network_dir_for(env, Some(program)) {
        Ok(Some(dir)) => dir,
        other => {
            if let Some(current) = current {
                current.stop();
            }
            let reason = match other {
                Err(error) => error,
                _ => format!(
                    "the program has no name to keep its network state under; set {ENV_NET_DIR}"
                ),
            };
            return attempt.fail(reason, None);
        }
    };
    let reuse = match current {
        Some(current) if current.daemon.dir == dir => Some(current),
        Some(current) => {
            current.stop();
            None
        }
        None => None,
    };

    // no invite, no membership on disk and no daemon answering: nothing to run a daemon for
    if token.is_none() && reuse.is_none() && memberships_on_disk(&dir).is_empty() {
        // no daemon there, or a socket path the daemon would refuse (ensure_aiip_daemon says which)
        let answering =
            socket_path_for(&dir).is_ok_and(|path| AiipClient::new(path).status().is_ok());
        if !answering {
            return attempt.fail(no_membership(&dir), None);
        }
    }

    let held = match reuse {
        Some(reuse) => Held::Reused(reuse),
        None => {
            let config = match config::home(env) {
                Some(home) => match config::load_config(&home) {
                    Ok(config) => config,
                    Err(error) => return attempt.fail(error, None),
                },
                None => Config::default(),
            };
            let Some(bin) = aiip_binary_for(env, &config) else {
                return attempt.fail(NO_BINARY, None);
            };
            let mut options = EnsureOptions::new(bin);
            options.spawn = spawn;
            options.env = daemon_env;
            let daemon = match ensure_aiip_daemon(&dir, options) {
                Ok(daemon) => daemon,
                Err(error) => return attempt.fail(error, None),
            };
            if let Some(skew) = &daemon.version_skew {
                note(&format!("# network: {skew}"));
            }
            Held::Fresh(daemon)
        }
    };

    if let Some(token) = &token {
        match held.daemon().client.join(token) {
            Ok(joined) => note(&format!(
                "# network: joined {} as {} ({})",
                joined.membership.network_name,
                joined.membership.self_name,
                joined.membership.self_addr
            )),
            Err(error) if !is_already_member(&error) => {
                let reason = format!("the invite could not be used: {error}");
                if attempt.required {
                    return attempt.fail(reason, Some(held.daemon()));
                }
                note(&format!("# network: {reason}"));
            }
            Err(_) => {}
        }
    }

    let memberships = match held.daemon().client.networks() {
        Ok(memberships) => memberships,
        Err(error) => {
            return attempt.fail(
                format!("the daemon could not list memberships: {error}"),
                Some(held.daemon()),
            );
        }
    };
    if memberships.is_empty() {
        return attempt.fail(no_membership(&dir), Some(held.daemon()));
    }

    let network = match held {
        Held::Reused(network) => {
            if let Err(error) = network.retake() {
                return attempt.fail(
                    format!("the daemon could not list memberships: {error}"),
                    Some(&network.daemon),
                );
            }
            network
        }
        Held::Fresh(daemon) => RunNetwork::new(
            daemon,
            memberships.clone(),
            attempt.owned,
            note.clone(),
            RunNetworkOptions::default(),
        ),
    };
    for m in &memberships {
        note(&format!(
            "# network: {} ({}) on {}",
            m.self_name, m.self_addr, m.network_name
        ));
    }
    Ok(ConnectNetworkOutcome {
        network: Some(network),
        absent: None,
        declared: is_declared,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::daemon::{ChildExit, ChildLike, KillSignal, SpawnRequest};
    use crate::net::fake::{FakeAiipd, FakeOverlay, Scratch};

    const DOC: &str = "Members are ships of one world; a member's name is its callsign.";

    /// A child whose life is a fake daemon.
    struct FakeChild {
        fake: FakeAiipd,
        exit: Option<ChildExit>,
    }

    impl ChildLike for FakeChild {
        fn id(&self) -> u32 {
            std::process::id()
        }
        fn try_wait(&mut self) -> Option<ChildExit> {
            self.exit.clone()
        }
        fn kill(&mut self, _signal: KillSignal) {
            self.fake.stop();
            self.exit = Some(ChildExit::Signal("SIGTERM".to_string()));
        }
    }

    /// An overlay with a world created by `alpha`, and a spawn that serves a fake daemon on whatever dir it is asked for.
    struct World {
        scratch: Scratch,
        overlay: FakeOverlay,
        authority: FakeAiipd,
        alpha: AiipClient,
        spawn: SpawnFn,
        spawned: Arc<Mutex<Vec<FakeAiipd>>>,
        others: Mutex<Vec<FakeAiipd>>,
    }

    impl World {
        fn spawned(&self) -> Vec<FakeAiipd> {
            self.spawned.lock().unwrap().clone()
        }

        /// A fresh directory for a run's state.
        fn dir(&self, name: &str) -> PathBuf {
            let dir = self.scratch.path().join(name);
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn member_at(&self, name: &str, dir: &Path) -> FakeAiipd {
            let fake = self
                .overlay
                .new_member(name, &dir.join("aiipd.sock"))
                .unwrap();
            self.others.lock().unwrap().push(fake.clone());
            fake
        }
    }

    impl Drop for World {
        fn drop(&mut self) {
            for fake in self.spawned() {
                fake.stop();
            }
            for fake in self.others.lock().unwrap().iter() {
                fake.stop();
            }
            self.authority.stop();
        }
    }

    fn world() -> World {
        let scratch = Scratch::new();
        let overlay = FakeOverlay::new();
        let authority = overlay
            .new_outsider(&scratch.path().join("alpha.sock"))
            .unwrap();
        let alpha = AiipClient::new(authority.socket_path());
        alpha
            .create(&crate::net::client::CreateNetworkRequest {
                name: "world".to_string(),
                as_: "alpha".to_string(),
                lighthouse: false,
            })
            .unwrap();
        let spawned: Arc<Mutex<Vec<FakeAiipd>>> = Arc::default();
        let (inner, list) = (overlay.clone(), spawned.clone());
        let spawn: SpawnFn = Arc::new(move |request: &SpawnRequest<'_>| {
            let at = request
                .args
                .iter()
                .position(|a| a == "--state-dir")
                .unwrap();
            let dir = PathBuf::from(&request.args[at + 1]);
            let fake = inner.fake_at(&dir.join("aiipd.sock"));
            fake.start()?;
            list.lock().unwrap().push(fake.clone());
            Ok(Box::new(FakeChild { fake, exit: None }) as Box<dyn ChildLike>)
        });
        World {
            scratch,
            overlay,
            authority,
            alpha,
            spawn,
            spawned,
            others: Mutex::default(),
        }
    }

    type Notes = Arc<Mutex<Vec<String>>>;

    fn notes() -> (Note, Notes) {
        let notes: Notes = Arc::default();
        let sink = notes.clone();
        (
            Arc::new(move |t: &str| sink.lock().unwrap().push(t.to_string())),
            notes,
        )
    }

    fn has(notes: &Notes, needle: &str) -> bool {
        notes.lock().unwrap().iter().any(|n| n.contains(needle))
    }

    fn declaration(required: bool) -> NetworkDeclaration {
        NetworkDeclaration {
            required: required.then_some(true),
            doc: DOC.to_string(),
        }
    }

    fn env_of(vars: &[(&str, String)]) -> impl Fn(&str) -> Option<String> + use<> {
        let map: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        move |name: &str| map.get(name).cloned()
    }

    fn connect(
        env: &dyn Fn(&str) -> Option<String>,
        declared: Option<&NetworkDeclaration>,
        current: Option<RunNetwork>,
        spawn: SpawnFn,
        note: Note,
    ) -> Result<ConnectNetworkOutcome, String> {
        connect_network(ConnectNetworkInput {
            env,
            daemon_env: Some(Vec::new()),
            program: "netty",
            declared,
            current,
            spawn: Some(spawn),
            note,
        })
    }

    fn text(path: &Path) -> String {
        path.display().to_string()
    }

    #[test]
    fn joins_at_attach_with_the_environments_invite_and_the_status_and_peers_say_where_it_is() {
        let w = world();
        let invite = w.alpha.invite("world", "beta").unwrap();
        let dir = w.scratch.path().join("net");
        let env = env_of(&[
            ("ABAI_NET_DIR", text(&dir)),
            ("ABAI_NET_TOKEN", invite.token.clone()),
            ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
            ("HOME", text(&dir)),
        ]);
        let (note, notes) = notes();
        let declared = declaration(false);
        let outcome = connect(&env, Some(&declared), None, w.spawn.clone(), note).unwrap();
        assert!(outcome.declared);
        assert_eq!(outcome.absent, None);
        let network = outcome.network.unwrap();
        let status = network.status();
        assert_eq!(status.dir, dir);
        assert_eq!(status.daemon, DaemonOrigin::Spawned);
        assert!(status.owned);
        assert_eq!(status.memberships.len(), 1);
        assert_eq!(status.memberships[0].network, "world");
        assert_eq!(status.memberships[0].member, "beta");
        assert_eq!(status.memberships[0].addr, invite.addr);
        assert!(!status.memberships[0].authority);

        let peers = network.peers();
        assert_eq!(peers.len(), 1);
        assert_eq!(
            (
                peers[0].network.as_str(),
                peers[0].member.as_str(),
                peers[0].source.as_str()
            ),
            ("world", "beta", "authority")
        );
        assert_eq!(peers[0].addr, invite.addr);
        assert_eq!(peers[0].error, None);
        let view: Vec<(Option<&str>, bool, bool, bool)> = peers[0]
            .members
            .iter()
            .map(|m| (m.name.as_deref(), m.enrolled, m.self_, m.established))
            .collect();
        assert_eq!(
            view,
            vec![
                (Some("alpha"), true, false, true),
                (Some("beta"), true, true, false)
            ]
        );
        assert_eq!(peers[0].members[1].addr, invite.addr);
        assert!(has(&notes, "# network: joined world as beta"));
        assert!(
            notes
                .lock()
                .unwrap()
                .iter()
                .any(|t| t.starts_with("# network: beta") && t.contains("on world"))
        );

        // the run's own dir: its daemon goes with it
        let spawned = w.spawned();
        assert_eq!(spawned.len(), 1);
        network.stop();
        assert!(!spawned[0].running());
        assert!(w.authority.running());
    }

    #[test]
    fn in_the_shared_per_program_directory_the_daemon_stays_for_the_next_run() {
        let w = world();
        let invite = w.alpha.invite("world", "beta").unwrap();
        let home = w.dir("home");
        let env = env_of(&[
            ("ABAI_HOME", text(&home)),
            ("ABAI_NET_TOKEN", invite.token.clone()),
            ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
        ]);
        let (note, _) = notes();
        let declared = declaration(false);
        let network = connect(&env, Some(&declared), None, w.spawn.clone(), note)
            .unwrap()
            .network
            .unwrap();
        let status = network.status();
        assert_eq!(status.dir, home.join("net").join("netty"));
        assert_eq!(status.daemon, DaemonOrigin::Spawned);
        assert!(!status.owned);
        network.stop();
        let spawned = w.spawned();
        assert_eq!(spawned.len(), 1);
        assert!(spawned[0].running());
    }

    #[test]
    fn a_run_that_is_already_a_member_finds_its_daemon_joins_nothing_again_and_leaves_it_running() {
        let w = world();
        let dir = w.dir("net");
        let mine = w.member_at("beta", &dir);
        // a token for somebody else: not used, since the run is a member
        let invite = w.alpha.invite("world", "gamma").unwrap();
        let env = env_of(&[
            ("ABAI_NET_DIR", text(&dir)),
            ("ABAI_NET_TOKEN", invite.token.clone()),
            ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
            ("HOME", text(&dir)),
        ]);
        let (note, notes) = notes();
        let declared = declaration(false);
        let network = connect(&env, Some(&declared), None, w.spawn.clone(), note)
            .unwrap()
            .network
            .unwrap();
        let status = network.status();
        assert_eq!(status.daemon, DaemonOrigin::Found);
        assert_eq!(status.memberships[0].member, "beta");
        assert_eq!(status.memberships[0].network, "world");
        // the token did not fit a membership this run holds: the daemon answered 409, which is not a failure
        assert!(!has(&notes, "# network: joined"));
        network.stop();
        assert!(mine.running());
    }

    #[test]
    fn the_authoritys_own_run_sees_itself_as_self_and_the_others_around_it() {
        let w = world();
        let invite = w.alpha.invite("world", "beta").unwrap();
        let other = w
            .overlay
            .new_outsider(&w.scratch.path().join("beta.sock"))
            .unwrap();
        w.others.lock().unwrap().push(other.clone());
        AiipClient::new(other.socket_path())
            .join(&invite.token)
            .unwrap();
        let dir = w.dir("net");
        w.member_at("gamma", &dir);
        let env = env_of(&[
            ("ABAI_NET_DIR", text(&dir)),
            ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
            ("HOME", text(&dir)),
        ]);
        let (note, _) = notes();
        let declared = declaration(false);
        let network = connect(&env, Some(&declared), None, w.spawn.clone(), note)
            .unwrap()
            .network
            .unwrap();
        let peers = network.peers();
        let view: Vec<(Option<&str>, bool, bool)> = peers[0]
            .members
            .iter()
            .map(|m| (m.name.as_deref(), m.self_, m.established))
            .collect();
        assert_eq!(
            view,
            vec![
                (Some("alpha"), false, true),
                (Some("beta"), false, true),
                (Some("gamma"), true, false)
            ]
        );
    }

    #[test]
    fn a_required_network_that_cannot_be_had_refuses_with_the_reason() {
        let w = world();
        let dir = w.scratch.path().join("net");
        let invite = w.alpha.invite("world", "beta").unwrap();
        // an invite in hand but no binary to use it with
        let env = env_of(&[
            ("ABAI_NET_DIR", text(&dir)),
            ("ABAI_NET_TOKEN", invite.token.clone()),
            ("PATH", String::new()),
            ("HOME", text(&dir)),
        ]);
        let (note, _) = notes();
        let declared = declaration(true);
        let error = connect(&env, Some(&declared), None, w.spawn.clone(), note).unwrap_err();
        assert!(
            error.starts_with("the program requires a network: no aiip binary found"),
            "{error}"
        );
    }

    #[test]
    fn a_required_network_whose_invite_is_refused_fails_and_the_daemon_this_run_started_goes() {
        let w = world();
        let dir = w.scratch.path().join("net");
        let env = env_of(&[
            ("ABAI_NET_DIR", text(&dir)),
            ("ABAI_NET_TOKEN", "fake-invite-bogus".to_string()),
            ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
            ("HOME", text(&dir)),
        ]);
        let (note, _) = notes();
        let declared = declaration(true);
        let error = connect(&env, Some(&declared), None, w.spawn.clone(), note).unwrap_err();
        assert!(
            error.starts_with(
                "the program requires a network: the invite could not be used: token: "
            ),
            "{error}"
        );
        let spawned = w.spawned();
        assert_eq!(spawned.len(), 1);
        assert!(!spawned[0].running());
    }

    #[test]
    fn a_declared_network_not_required_with_no_membership_and_no_invite_goes_on_and_says_why() {
        let w = world();
        let dir = w.scratch.path().join("net");
        let env = env_of(&[
            ("ABAI_NET_DIR", text(&dir)),
            ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
            ("HOME", text(&dir)),
        ]);
        let (note, notes) = notes();
        let declared = declaration(false);
        let outcome = connect(&env, Some(&declared), None, w.spawn.clone(), note).unwrap();
        assert!(outcome.network.is_none());
        assert!(outcome.declared);
        let absent = outcome.absent.unwrap();
        assert!(absent.starts_with("no membership in "), "{absent}");
        assert!(absent.contains("net (set ABAI_NET_TOKEN"), "{absent}");
        assert!(has(&notes, "# network: none (no membership in"));
        // nothing to run a daemon for
        assert!(w.spawned().is_empty());
    }

    #[test]
    fn a_not_required_network_whose_invite_is_refused_goes_on_and_the_daemon_it_started_goes() {
        let w = world();
        let dir = w.scratch.path().join("net");
        let env = env_of(&[
            ("ABAI_NET_DIR", text(&dir)),
            ("ABAI_NET_TOKEN", "fake-invite-bogus".to_string()),
            ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
            ("HOME", text(&dir)),
        ]);
        let (note, notes) = notes();
        let declared = declaration(false);
        let outcome = connect(&env, Some(&declared), None, w.spawn.clone(), note).unwrap();
        assert!(outcome.network.is_none());
        assert!(outcome.absent.unwrap().starts_with("no membership in"));
        assert!(has(
            &notes,
            "# network: the invite could not be used: token: "
        ));
        assert!(!w.spawned()[0].running());
    }

    #[test]
    fn nothing_declared_and_nothing_in_the_environment_means_no_network_and_no_reason() {
        let w = world();
        let env = env_of(&[("HOME", text(w.scratch.path()))]);
        let (note, notes) = notes();
        let outcome = connect(&env, None, None, w.spawn.clone(), note).unwrap();
        assert!(outcome.network.is_none());
        assert_eq!(outcome.absent, None);
        assert!(!outcome.declared);
        assert!(notes.lock().unwrap().is_empty());
        assert!(w.spawned().is_empty());
    }

    #[test]
    fn nothing_declared_but_a_network_asked_for_in_the_environment_that_cannot_be_had_says_why() {
        let scratch = Scratch::new();
        let env = env_of(&[
            ("ABAI_NET_DIR", text(&scratch.path().join("net"))),
            ("ABAI_NET_TOKEN", "fake-invite-x".to_string()),
            ("PATH", String::new()),
            ("HOME", text(scratch.path())),
        ]);
        let (note, _) = notes();
        let spawn: SpawnFn = Arc::new(|_: &SpawnRequest<'_>| panic!("spawn must not be reached"));
        let outcome = connect(&env, None, None, spawn, note).unwrap();
        assert!(!outcome.declared);
        assert!(outcome.absent.unwrap().starts_with("no aiip binary found"));
    }

    #[test]
    fn a_declared_network_whose_daemon_cannot_start_is_absent_with_the_daemons_reason() {
        let scratch = Scratch::new();
        let dir = scratch.path().join("net");
        std::fs::create_dir_all(dir.join("memberships")).unwrap();
        std::fs::write(
            dir.join("memberships").join("x.json"),
            serde_json::json!({
                "networkID": "x".repeat(32),
                "networkName": "world",
                "identity": { "name": "beta", "addr": "100.107.0.9" },
            })
            .to_string(),
        )
        .unwrap();
        let env = env_of(&[
            ("ABAI_NET_DIR", text(&dir)),
            ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
            ("HOME", text(&dir)),
        ]);
        let spawn: SpawnFn =
            Arc::new(|_: &SpawnRequest<'_>| Err(std::io::Error::other("spawn /opt/aiip ENOENT")));
        let (note, _) = notes();
        let declared = declaration(false);
        let outcome = connect(&env, Some(&declared), None, spawn, note).unwrap();
        assert!(
            outcome
                .absent
                .unwrap()
                .contains("the aiip binary could not be started")
        );
    }

    #[test]
    fn a_relative_abai_net_dir_is_refused_with_a_reason() {
        let w = world();
        let env = env_of(&[
            ("ABAI_NET_DIR", "net".to_string()),
            ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
            ("HOME", text(w.scratch.path())),
        ]);
        let (note, _) = notes();
        let declared = declaration(true);
        let error = connect(&env, Some(&declared), None, w.spawn.clone(), note).unwrap_err();
        assert!(
            error.contains("ABAI_NET_DIR must be an absolute path (got net)"),
            "{error}"
        );
    }

    #[test]
    fn the_same_directory_reuses_the_daemon_and_another_stops_an_owned_one_and_starts_anew() {
        let w = world();
        let a = w.scratch.path().join("a");
        let b = w.scratch.path().join("b");
        let declared = declaration(false);
        let (note, _) = notes();
        let first_env = env_of(&[
            ("ABAI_NET_DIR", text(&a)),
            (
                "ABAI_NET_TOKEN",
                w.alpha.invite("world", "beta").unwrap().token,
            ),
            ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
        ]);
        let run = connect(
            &first_env,
            Some(&declared),
            None,
            w.spawn.clone(),
            note.clone(),
        )
        .unwrap()
        .network
        .unwrap();
        let status = run.status();
        assert_eq!(status.dir, a);
        assert!(status.owned);
        assert_eq!(status.memberships[0].member, "beta");
        assert_eq!(w.spawned().len(), 1);
        let first_mail = run.mail.downgrade();

        let again_env = env_of(&[
            ("ABAI_NET_DIR", text(&a)),
            ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
        ]);
        let again = connect(
            &again_env,
            Some(&declared),
            Some(run),
            w.spawn.clone(),
            note.clone(),
        )
        .unwrap()
        .network
        .unwrap();
        // the same network came back: its mail loop is the one made at the first attach
        assert!(std::sync::Weak::ptr_eq(
            &again.mail.downgrade(),
            &first_mail
        ));
        assert_eq!(w.spawned().len(), 1);
        assert!(w.spawned()[0].running());

        let elsewhere_env = env_of(&[
            ("ABAI_NET_DIR", text(&b)),
            (
                "ABAI_NET_TOKEN",
                w.alpha.invite("world", "gamma").unwrap().token,
            ),
            ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
        ]);
        let elsewhere = connect(
            &elsewhere_env,
            Some(&declared),
            Some(again),
            w.spawn.clone(),
            note,
        )
        .unwrap()
        .network
        .unwrap();
        let status = elsewhere.status();
        assert_eq!(status.dir, b);
        assert_eq!(status.memberships[0].member, "gamma");
        let spawned = w.spawned();
        assert_eq!(spawned.len(), 2);
        assert!(!spawned[0].running());
        assert!(spawned[1].running());
        elsewhere.stop();
        assert!(!spawned[1].running());
    }

    #[test]
    fn a_reused_daemon_is_not_orphaned_when_the_reattach_fails_and_an_owned_one_is_stopped() {
        let w = world();
        let a = w.scratch.path().join("a");
        let (note, _) = notes();
        let first_env = env_of(&[
            ("ABAI_NET_DIR", text(&a)),
            (
                "ABAI_NET_TOKEN",
                w.alpha.invite("world", "beta").unwrap().token,
            ),
            ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
        ]);
        let declared = declaration(false);
        let run = connect(
            &first_env,
            Some(&declared),
            None,
            w.spawn.clone(),
            note.clone(),
        )
        .unwrap()
        .network
        .unwrap();
        run.daemon.client.leave("world").unwrap();
        let again_env = env_of(&[
            ("ABAI_NET_DIR", text(&a)),
            ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
        ]);
        let required = declaration(true);
        let error = connect(
            &again_env,
            Some(&required),
            Some(run),
            w.spawn.clone(),
            note,
        )
        .unwrap_err();
        assert!(
            error.starts_with("the program requires a network: no membership in"),
            "{error}"
        );
        assert!(!w.spawned()[0].running());
    }

    #[test]
    fn peers_follow_a_membership_change_made_outside_the_run_and_the_prompts_snapshot_stands() {
        let w = world();
        let a = w.scratch.path().join("a");
        let (note, _) = notes();
        let env = env_of(&[
            ("ABAI_NET_DIR", text(&a)),
            (
                "ABAI_NET_TOKEN",
                w.alpha.invite("world", "beta").unwrap().token,
            ),
            ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
        ]);
        let declared = declaration(false);
        let run = connect(&env, Some(&declared), None, w.spawn.clone(), note)
            .unwrap()
            .network
            .unwrap();
        let names: Vec<String> = run.peers().into_iter().map(|p| p.network).collect();
        assert_eq!(names, vec!["world".to_string()]);
        run.daemon.client.leave("world").unwrap(); // what `config net leave` does in another process
        assert!(run.peers().is_empty());
        let snapshot: Vec<String> = run
            .prompt_memberships()
            .into_iter()
            .map(|m| m.network)
            .collect();
        assert_eq!(snapshot, vec!["world".to_string()]);
        run.stop();
    }

    #[test]
    fn memberships_on_disk_reads_the_records_a_state_directory_holds() {
        let scratch = Scratch::new();
        let dir = scratch.path();
        assert!(memberships_on_disk(dir).is_empty());
        let records = dir.join("memberships");
        std::fs::create_dir_all(&records).unwrap();
        std::fs::write(
            records.join("a.json"),
            serde_json::json!({
                "networkID": "n1", "networkName": "world",
                "identity": { "name": "beta", "addr": "100.107.0.9" },
                "authority": { "key": "k" }, "peers": [1, 2],
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            records.join("b.json"),
            serde_json::json!({ "networkID": "n2", "identity": { "name": "gamma" } }).to_string(),
        )
        .unwrap();
        std::fs::write(records.join("c.json"), "not json").unwrap();
        std::fs::write(records.join("d.txt"), "{}").unwrap();
        assert_eq!(
            memberships_on_disk(dir),
            vec![
                NetworkMembership {
                    network: "world".to_string(),
                    id: "n1".to_string(),
                    member: "beta".to_string(),
                    addr: "100.107.0.9".to_string(),
                    authority: true,
                    peers: 2,
                },
                NetworkMembership {
                    network: "n2".to_string(),
                    id: "n2".to_string(),
                    member: "gamma".to_string(),
                    addr: String::new(),
                    authority: false,
                    peers: 0,
                },
            ]
        );
    }
}
