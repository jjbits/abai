//! The aiip daemon for a state directory: found if one answers, started if
//! none does. Mirrors the aiip CLI's own spawn (`aiip --state-dir <dir>
//! daemon`, a readiness poll of GET /v1/status every 50 ms for up to 10 s).
//! The CLI detaches the daemon and leaves it for the next command; so does
//! a run whose state dir is the shared per-program one. A run with a state
//! dir of its own (ABAI_NET_DIR set, as the arena sets for each ship) ends
//! at `stop()` the daemon it started. A daemon somebody else started is
//! never signalled, and a child that lost aiipd's single-instance lock to
//! one is not counted as ours.

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use super::client::{
    AIIP_SOCKET_NAME, AIIP_SOCKET_PATH_MAX, AiipClient, AiipStatus, KNOWN_AIIP_API,
};
use super::dir::{ENV_NET_TOKEN, without_invite_token};

pub const DEFAULT_READY_TIMEOUT_MS: u64 = 10_000;
pub const DEFAULT_POLL_MS: u64 = 50;
pub const DEFAULT_STOP_TIMEOUT_MS: u64 = 7_000;

/// How often a stopping child is asked whether it has exited.
const EXIT_POLL: Duration = Duration::from_millis(10);
/// How long a child gets to go after SIGKILL.
const KILL_WAIT: Duration = Duration::from_millis(1_000);

/// How a child ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChildExit {
    Code(i32),
    /// The signal's name, such as `SIGTERM`.
    Signal(String),
}

impl std::fmt::Display for ChildExit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Code(code) => write!(f, "code {code}"),
            Self::Signal(signal) => write!(f, "signal {signal}"),
        }
    }
}

/// The two signals a stop sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillSignal {
    Term,
    Kill,
}

/// What `ensure_aiip_daemon` needs of a spawned child; a real child process
/// satisfies it, tests bring their own.
pub trait ChildLike: Send {
    fn id(&self) -> u32;
    /// How the child ended, or `None` while it runs.
    fn try_wait(&mut self) -> Option<ChildExit>;
    fn kill(&mut self, signal: KillSignal);
}

/// What a spawn is asked to start.
#[derive(Debug)]
pub struct SpawnRequest<'a> {
    pub bin: &'a Path,
    pub args: &'a [String],
    /// The child's whole environment, already without the invite token; `None`
    /// means this process's environment, less the invite token.
    pub env: Option<&'a [(String, String)]>,
    /// The log the child's output goes to; its input is nothing.
    pub log: &'a File,
}

/// The spawn to use; tests inject one that serves a fake on the socket.
pub type SpawnFn =
    Arc<dyn Fn(&SpawnRequest<'_>) -> std::io::Result<Box<dyn ChildLike>> + Send + Sync>;

pub struct EnsureOptions {
    /// The aiip binary.
    pub bin: PathBuf,
    /// The spawn to use; default a child process.
    pub spawn: Option<SpawnFn>,
    /// The environment a daemon started here runs in; default this process's.
    /// The invite token is left out either way: the daemon joins through its
    /// API and never reads it.
    pub env: Option<Vec<(String, String)>>,
    /// How long a started daemon may take to answer; default 10 s, as the aiip CLI.
    pub ready_timeout_ms: Option<u64>,
    pub poll_ms: Option<u64>,
    /// How long `stop()` waits after SIGTERM before SIGKILL; aiip's own shutdown grace is 5 s.
    pub stop_timeout_ms: Option<u64>,
}

impl EnsureOptions {
    pub fn new(bin: impl Into<PathBuf>) -> Self {
        Self {
            bin: bin.into(),
            spawn: None,
            env: None,
            ready_timeout_ms: None,
            poll_ms: None,
            stop_timeout_ms: None,
        }
    }
}

impl std::fmt::Debug for EnsureOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EnsureOptions")
            .field("bin", &self.bin)
            .field("spawn", &self.spawn.as_ref().map(|_| "(given)"))
            .field("ready_timeout_ms", &self.ready_timeout_ms)
            .field("poll_ms", &self.poll_ms)
            .field("stop_timeout_ms", &self.stop_timeout_ms)
            .finish_non_exhaustive()
    }
}

/// What ends a daemon at `stop()`: run once, by the first caller; a later
/// caller waits for it to finish.
pub struct DaemonStop(Mutex<Option<Box<dyn FnOnce() + Send>>>);

impl DaemonStop {
    /// Nothing to end: a daemon found, not started.
    pub fn none() -> Self {
        Self(Mutex::new(None))
    }

    pub fn new(stop: Box<dyn FnOnce() + Send>) -> Self {
        Self(Mutex::new(Some(stop)))
    }

    fn run(&self) {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(stop) = slot.take() {
            stop();
        }
    }
}

impl std::fmt::Debug for DaemonStop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DaemonStop")
    }
}

#[derive(Debug)]
pub struct AiipDaemon {
    pub dir: PathBuf,
    pub socket_path: PathBuf,
    pub client: AiipClient,
    /// The API version the daemon reports.
    pub version: String,
    /// Set when the daemon speaks another `aiip-*` version than this harness knows.
    pub version_skew: Option<String>,
    /// The daemon answering is the process this call started, so `stop()` ends it.
    pub spawned: bool,
    pub pid: Option<u32>,
    pub stopper: DaemonStop,
}

impl AiipDaemon {
    /// End the daemon this call started; a found daemon is left alone. Idempotent.
    pub fn stop(&self) {
        self.stopper.run();
    }
}

/// The socket a state directory's daemon listens on, or why it cannot.
pub fn socket_path_for(dir: &Path) -> Result<PathBuf, String> {
    let path = dir.join(AIIP_SOCKET_NAME);
    let bytes = path.as_os_str().len();
    if bytes > AIIP_SOCKET_PATH_MAX {
        return Err(format!(
            "the network state directory is too deep: its socket path {} is {bytes} bytes and the daemon allows {AIIP_SOCKET_PATH_MAX}; set ABAI_NET_DIR to a shorter path",
            path.display()
        ));
    }
    Ok(path)
}

/// The daemon's version string is `aiip-<milestone>`; anything else is not aiipd.
fn check_version(status: &AiipStatus, socket_path: &Path) -> Result<Option<String>, String> {
    if !status.version.starts_with("aiip-") {
        let quoted =
            serde_json::to_string(&status.version).unwrap_or_else(|_| status.version.clone());
        return Err(format!(
            "what answers at {} is not aiipd (version {quoted})",
            socket_path.display()
        ));
    }
    Ok(if status.version == KNOWN_AIIP_API {
        None
    } else {
        Some(format!(
            "the daemon speaks {}; this harness was written against {KNOWN_AIIP_API}",
            status.version
        ))
    })
}

fn last_log_line(path: &Path) -> Option<String> {
    let text = fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&text);
    text.split('\n')
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("---"))
        .map(str::to_string)
}

fn found(
    dir: &Path,
    socket_path: &Path,
    client: AiipClient,
    status: &AiipStatus,
) -> Result<AiipDaemon, String> {
    Ok(AiipDaemon {
        dir: dir.to_path_buf(),
        socket_path: socket_path.to_path_buf(),
        client,
        version: status.version.clone(),
        version_skew: check_version(status, socket_path)?,
        spawned: false,
        pid: Some(status.pid),
        stopper: DaemonStop::none(),
    })
}

/// A real child process.
struct SpawnedChild(Child);

impl ChildLike for SpawnedChild {
    fn id(&self) -> u32 {
        self.0.id()
    }

    fn try_wait(&mut self) -> Option<ChildExit> {
        let status = self.0.try_wait().ok()??;
        Some(match (status.code(), status.signal()) {
            (Some(code), _) => ChildExit::Code(code),
            (None, Some(signal)) => ChildExit::Signal(signal_name(signal)),
            (None, None) => ChildExit::Signal("unknown".to_string()),
        })
    }

    fn kill(&mut self, signal: KillSignal) {
        match signal {
            KillSignal::Term => {
                if let Ok(pid) = libc::pid_t::try_from(self.0.id()) {
                    // SAFETY: a plain kill(2) of this process's own child, not yet reaped.
                    unsafe {
                        libc::kill(pid, libc::SIGTERM);
                    }
                }
            }
            KillSignal::Kill => {
                let _ = self.0.kill();
            }
        }
    }
}

fn signal_name(signal: i32) -> String {
    let name = match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGABRT => "SIGABRT",
        libc::SIGKILL => "SIGKILL",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGTERM => "SIGTERM",
        _ => return signal.to_string(),
    };
    name.to_string()
}

/// The command the default spawn runs: no input, output to the log, the
/// given environment or this process's, never the invite token.
pub fn daemon_command(request: &SpawnRequest<'_>) -> std::io::Result<Command> {
    let mut command = Command::new(request.bin);
    command
        .args(request.args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(request.log.try_clone()?))
        .stderr(Stdio::from(request.log.try_clone()?));
    match request.env {
        Some(env) => {
            command.env_clear();
            command.envs(env.iter().map(|(k, v)| (k, v)));
        }
        None => {
            command.env_remove(ENV_NET_TOKEN);
        }
    }
    Ok(command)
}

fn default_spawn(request: &SpawnRequest<'_>) -> std::io::Result<Box<dyn ChildLike>> {
    let child = daemon_command(request)?.spawn()?;
    Ok(Box::new(SpawnedChild(child)))
}

/// The daemon for `dir`: the one answering at its socket, else one started
/// now from `bin`. An error when the socket path is too long, when nothing
/// answers within the readiness timeout, when the child exits first with no
/// daemon behind it, or when what answers is not aiipd (a started one is
/// ended first).
pub fn ensure_aiip_daemon(dir: &Path, options: EnsureOptions) -> Result<AiipDaemon, String> {
    let socket_path = socket_path_for(dir)?;
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|error| format!("{}: {error}", dir.display()))?;
    let client = AiipClient::new(&socket_path);
    let spawn: SpawnFn = options
        .spawn
        .clone()
        .unwrap_or_else(|| Arc::new(default_spawn));
    let ready_timeout_ms = options.ready_timeout_ms.unwrap_or(DEFAULT_READY_TIMEOUT_MS);
    let poll = Duration::from_millis(options.poll_ms.unwrap_or(DEFAULT_POLL_MS));
    let stop_timeout =
        Duration::from_millis(options.stop_timeout_ms.unwrap_or(DEFAULT_STOP_TIMEOUT_MS));

    if let Some(present) = ping(&client) {
        return found(dir, &socket_path, client, &present);
    }

    // the child's output goes to the dir's log; the child holds its own copy of the descriptor, so ours closes at once
    let log_path = dir.join("daemon.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&log_path)
        .and_then(|mut log| {
            let stamp = crate::time::rfc3339(crate::time::now_ms());
            log.write_all(format!("--- abai starting aiipd {stamp} ---\n").as_bytes())?;
            Ok(log)
        })
        .map_err(|error| format!("{}: {error}", log_path.display()))?;
    let args = vec![
        "--state-dir".to_string(),
        dir.display().to_string(),
        "daemon".to_string(),
    ];
    let env = options.env.as_deref().map(without_invite_token);
    let spawned = spawn(&SpawnRequest {
        bin: &options.bin,
        args: &args,
        env: env.as_deref(),
        log: &log,
    });
    drop(log);
    let mut child = spawned.map_err(|error| {
        format!(
            "the aiip binary could not be started ({}): {error}",
            options.bin.display()
        )
    })?;

    let deadline = Instant::now() + Duration::from_millis(ready_timeout_ms);
    let mut status = None;
    let mut exited = None;
    while Instant::now() < deadline {
        status = ping(&client);
        if status.is_some() {
            break;
        }
        exited = child.try_wait();
        if exited.is_some() {
            break;
        }
        thread::sleep(poll);
    }
    if status.is_none() && exited.is_some() {
        // the child lost aiipd's lock to a daemon that came up meanwhile: that one answers, and is not ours
        if let Some(status) = ping(&client) {
            return found(dir, &socket_path, client, &status);
        }
    }
    let Some(status) = status else {
        let detail = last_log_line(&log_path)
            .map(|tail| format!("; last log line: {tail}"))
            .unwrap_or_default();
        if let Some(exited) = exited {
            return Err(format!(
                "aiipd exited with {exited} before answering at {}{detail}",
                socket_path.display()
            ));
        }
        // the one process this call started, by its own handle
        end_child(child.as_mut(), stop_timeout);
        return Err(format!(
            "aiipd did not answer at {} within {ready_timeout_ms} ms{detail}",
            socket_path.display()
        ));
    };
    // another run's daemon won the lock while ours was booting: it answers, ours is gone or going
    if status.pid != child.id() {
        end_child(child.as_mut(), stop_timeout);
        return found(dir, &socket_path, client, &status);
    }
    let version_skew = match check_version(&status, &socket_path) {
        Ok(skew) => skew,
        Err(error) => {
            end_child(child.as_mut(), stop_timeout);
            return Err(error);
        }
    };
    let pid = child.id();
    Ok(AiipDaemon {
        dir: dir.to_path_buf(),
        socket_path,
        client,
        version: status.version,
        version_skew,
        spawned: true,
        pid: Some(pid),
        stopper: DaemonStop::new(Box::new(move || end_child(child.as_mut(), stop_timeout))),
    })
}

fn ping(client: &AiipClient) -> Option<AiipStatus> {
    client.status().ok()
}

/// Waits up to `limit` for the child to exit; true when it did.
fn wait_exit(child: &mut dyn ChildLike, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    loop {
        if child.try_wait().is_some() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(EXIT_POLL);
    }
}

/// SIGTERM the child, wait for its exit, SIGKILL when it will not go.
fn end_child(child: &mut dyn ChildLike, timeout: Duration) {
    if child.try_wait().is_some() {
        return;
    }
    child.kill(KillSignal::Term);
    if !wait_exit(child, timeout) {
        child.kill(KillSignal::Kill);
        wait_exit(child, KILL_WAIT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::fake::{FakeAiipd, FakeOverlay, Scratch};
    use std::ffi::OsStr;

    #[derive(Debug, Clone, Copy, PartialEq)]
    enum Behaviour {
        Serves,
        Inert,
        IgnoresTerm,
    }

    /// What a test sees of a fake child: the signals it got and how it ended.
    #[derive(Debug, Clone, Default)]
    struct Seen {
        kills: Arc<Mutex<Vec<KillSignal>>>,
        exit: Arc<Mutex<Option<ChildExit>>>,
    }

    impl Seen {
        fn kills(&self) -> Vec<KillSignal> {
            self.kills.lock().unwrap().clone()
        }
    }

    /// A child whose life is a fake daemon on the state dir's socket.
    struct FakeChild {
        pid: u32,
        fake: Option<FakeAiipd>,
        behaviour: Behaviour,
        seen: Seen,
    }

    impl ChildLike for FakeChild {
        fn id(&self) -> u32 {
            self.pid
        }
        fn try_wait(&mut self) -> Option<ChildExit> {
            self.seen.exit.lock().unwrap().clone()
        }
        fn kill(&mut self, signal: KillSignal) {
            self.seen.kills.lock().unwrap().push(signal);
            if self.behaviour == Behaviour::IgnoresTerm && signal == KillSignal::Term {
                return;
            }
            if let Some(fake) = &self.fake {
                fake.stop();
            }
            let name = match signal {
                KillSignal::Term => "SIGTERM",
                KillSignal::Kill => "SIGKILL",
            };
            *self.seen.exit.lock().unwrap() = Some(ChildExit::Signal(name.to_string()));
        }
    }

    #[derive(Debug)]
    struct Call {
        bin: PathBuf,
        args: Vec<String>,
        env: Option<Vec<(String, String)>>,
    }

    fn state_dir_of(args: &[String]) -> PathBuf {
        let at = args.iter().position(|a| a == "--state-dir").unwrap();
        PathBuf::from(&args[at + 1])
    }

    type Calls = Arc<Mutex<Vec<Call>>>;
    type Children = Arc<Mutex<Vec<(Seen, Option<FakeAiipd>)>>>;

    /// A spawn that reads `--state-dir` and serves the fake there; records what it was asked.
    fn fake_spawn(overlay: &FakeOverlay, behaviour: Behaviour) -> (SpawnFn, Calls, Children) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let children = Arc::new(Mutex::new(Vec::new()));
        let (overlay, seen_calls, seen_children) =
            (overlay.clone(), calls.clone(), children.clone());
        let spawn: SpawnFn = Arc::new(move |request: &SpawnRequest<'_>| {
            seen_calls.lock().unwrap().push(Call {
                bin: request.bin.to_path_buf(),
                args: request.args.to_vec(),
                env: request.env.map(<[(String, String)]>::to_vec),
            });
            let dir = state_dir_of(request.args);
            let fake = match behaviour {
                Behaviour::Serves | Behaviour::IgnoresTerm => {
                    let fake = overlay.fake_at(&dir.join("aiipd.sock"));
                    fake.start().unwrap();
                    Some(fake)
                }
                Behaviour::Inert => None,
            };
            let seen = Seen::default();
            seen_children
                .lock()
                .unwrap()
                .push((seen.clone(), fake.clone()));
            Ok(Box::new(FakeChild {
                pid: std::process::id(),
                fake,
                behaviour,
                seen,
            }) as Box<dyn ChildLike>)
        });
        (spawn, calls, children)
    }

    fn no_spawn() -> SpawnFn {
        Arc::new(|_: &SpawnRequest<'_>| panic!("spawn must not be reached"))
    }

    fn with_spawn(bin: &str, spawn: SpawnFn) -> EnsureOptions {
        let mut options = EnsureOptions::new(bin);
        options.spawn = Some(spawn);
        options
    }

    fn pairs(vars: &[(&str, &str)]) -> Vec<(String, String)> {
        vars.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn a_daemon_started_here_gets_the_callers_environment_without_the_invite_token() {
        let scratch = Scratch::new();
        let dir = scratch.path().join("net");
        let overlay = FakeOverlay::new();
        let (spawn, calls, children) = fake_spawn(&overlay, Behaviour::Serves);
        let dir_text = dir.display().to_string();
        let env = pairs(&[
            ("PATH", "/usr/bin"),
            ("HOME", "/home/x"),
            ("ABAI_NET_TOKEN", "aiip-invite.secret"),
            ("ABAI_NET_DIR", &dir_text),
        ]);
        let mut options = with_spawn("/opt/aiip", spawn.clone());
        options.env = Some(env.clone());
        ensure_aiip_daemon(&dir, options).unwrap();
        assert_eq!(
            calls.lock().unwrap()[0].env,
            Some(pairs(&[
                ("PATH", "/usr/bin"),
                ("HOME", "/home/x"),
                ("ABAI_NET_DIR", &dir_text)
            ]))
        );
        // the caller keeps its own copy
        assert!(env.iter().any(|(k, _)| k == "ABAI_NET_TOKEN"));
        // with no environment given, the process's own, less the token: the spawn hears None
        let other = scratch.path().join("net2");
        ensure_aiip_daemon(&other, with_spawn("/opt/aiip", spawn)).unwrap();
        assert_eq!(calls.lock().unwrap()[1].env, None);
        for (_, fake) in children.lock().unwrap().iter() {
            fake.as_ref().unwrap().stop();
        }
    }

    #[test]
    fn the_default_spawn_leaves_the_token_out_of_the_childs_environment() {
        let scratch = Scratch::new();
        let log = File::create(scratch.path().join("log")).unwrap();
        let args = vec![
            "--state-dir".to_string(),
            "/d".to_string(),
            "daemon".to_string(),
        ];
        let inherited = daemon_command(&SpawnRequest {
            bin: Path::new("/opt/aiip"),
            args: &args,
            env: None,
            log: &log,
        })
        .unwrap();
        assert_eq!(inherited.get_program(), OsStr::new("/opt/aiip"));
        assert_eq!(
            inherited.get_args().collect::<Vec<_>>(),
            vec![
                OsStr::new("--state-dir"),
                OsStr::new("/d"),
                OsStr::new("daemon")
            ]
        );
        assert_eq!(
            inherited.get_envs().collect::<Vec<_>>(),
            vec![(OsStr::new("ABAI_NET_TOKEN"), None)]
        );
        let given = pairs(&[("PATH", "/p")]);
        let exact = daemon_command(&SpawnRequest {
            bin: Path::new("/opt/aiip"),
            args: &args,
            env: Some(&given),
            log: &log,
        })
        .unwrap();
        assert_eq!(
            exact.get_envs().collect::<Vec<_>>(),
            vec![(OsStr::new("PATH"), Some(OsStr::new("/p")))]
        );
    }

    #[test]
    fn starts_a_daemon_for_the_dir_finds_it_on_the_next_call_and_stops_only_what_it_started() {
        let scratch = Scratch::new();
        let dir = scratch.path().join("net");
        let overlay = FakeOverlay::new();
        let (spawn, calls, children) = fake_spawn(&overlay, Behaviour::Serves);

        let first = ensure_aiip_daemon(&dir, with_spawn("/opt/aiip", spawn.clone())).unwrap();
        assert!(first.spawned);
        assert_eq!(first.version, KNOWN_AIIP_API);
        assert_eq!(first.version_skew, None);
        assert_eq!(first.pid, Some(std::process::id()));
        assert_eq!(first.socket_path, dir.join("aiipd.sock"));
        {
            let calls = calls.lock().unwrap();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].bin, PathBuf::from("/opt/aiip"));
            assert_eq!(
                calls[0].args,
                vec![
                    "--state-dir".to_string(),
                    dir.display().to_string(),
                    "daemon".to_string()
                ]
            );
        }
        let log = fs::read_to_string(dir.join("daemon.log")).unwrap();
        assert!(log.starts_with("--- abai starting aiipd "), "{log}");
        assert!(log.ends_with(" ---\n") && log.lines().count() == 1, "{log}");

        let second = ensure_aiip_daemon(&dir, with_spawn("/opt/aiip", spawn)).unwrap();
        assert!(!second.spawned);
        assert_eq!(second.pid, Some(std::process::id())); // the fake reports its own pid
        assert_eq!(calls.lock().unwrap().len(), 1);
        second.stop();
        let seen = children.lock().unwrap()[0].0.clone();
        assert_eq!(seen.kills(), vec![]);
        assert_eq!(second.client.status().unwrap().version, KNOWN_AIIP_API);

        first.stop();
        assert_eq!(seen.kills(), vec![KillSignal::Term]);
        assert!(!first.socket_path.exists());
        assert!(first.client.status().unwrap_err().unreachable());
        first.stop(); // idempotent
        assert_eq!(seen.kills(), vec![KillSignal::Term]);
    }

    #[test]
    fn a_child_that_exits_before_answering_fails_with_the_logs_last_line() {
        let scratch = Scratch::new();
        let dir = scratch.path().join("net");
        let spawn: SpawnFn = Arc::new(|request: &SpawnRequest<'_>| {
            let mut log = request.log.try_clone()?;
            log.write_all(b"daemon: state dir is not writable\n")?;
            let seen = Seen::default();
            *seen.exit.lock().unwrap() = Some(ChildExit::Code(1));
            Ok(Box::new(FakeChild {
                pid: 1,
                fake: None,
                behaviour: Behaviour::Inert,
                seen,
            }) as Box<dyn ChildLike>)
        });
        let error = ensure_aiip_daemon(&dir, with_spawn("/opt/aiip", spawn)).unwrap_err();
        assert!(
            error.starts_with("aiipd exited with code 1 before answering "),
            "{error}"
        );
        assert!(
            error.ends_with("; last log line: daemon: state dir is not writable"),
            "{error}"
        );
    }

    #[test]
    fn a_daemon_that_never_answers_is_ended_by_its_own_handle_and_reported() {
        let scratch = Scratch::new();
        let dir = scratch.path().join("net");
        let (spawn, _, children) = fake_spawn(&FakeOverlay::new(), Behaviour::Inert);
        let mut options = with_spawn("/opt/aiip", spawn);
        options.ready_timeout_ms = Some(150);
        options.poll_ms = Some(20);
        let error = ensure_aiip_daemon(&dir, options).unwrap_err();
        assert!(error.starts_with("aiipd did not answer at "), "{error}");
        assert!(error.contains(" within 150 ms"), "{error}");
        assert_eq!(
            children.lock().unwrap()[0].0.kills(),
            vec![KillSignal::Term]
        );
    }

    #[test]
    fn a_daemon_that_ignores_sigterm_gets_sigkill_after_the_stop_timeout() {
        let scratch = Scratch::new();
        let dir = scratch.path().join("net");
        let (spawn, _, children) = fake_spawn(&FakeOverlay::new(), Behaviour::IgnoresTerm);
        let mut options = with_spawn("/opt/aiip", spawn);
        options.stop_timeout_ms = Some(50);
        let daemon = ensure_aiip_daemon(&dir, options).unwrap();
        daemon.stop();
        assert_eq!(
            children.lock().unwrap()[0].0.kills(),
            vec![KillSignal::Term, KillSignal::Kill]
        );
    }

    #[test]
    fn version_skew_is_noted_and_what_is_not_aiipd_is_refused() {
        let scratch = Scratch::new();
        let overlay = FakeOverlay::new();
        let dir = scratch.path().join("net");
        fs::create_dir_all(&dir).unwrap();
        let old = overlay.new_outsider(&dir.join("aiipd.sock")).unwrap();
        old.set_version("aiip-m7");
        let found = ensure_aiip_daemon(&dir, with_spawn("/opt/aiip", no_spawn())).unwrap();
        assert!(!found.spawned);
        assert_eq!(
            found.version_skew.as_deref(),
            Some("the daemon speaks aiip-m7; this harness was written against aiip-m8")
        );
        old.set_version("something-else");
        let error = ensure_aiip_daemon(&dir, with_spawn("/opt/aiip", no_spawn())).unwrap_err();
        assert!(
            error.ends_with("is not aiipd (version \"something-else\")"),
            "{error}"
        );
        old.stop();
    }

    #[test]
    fn a_started_daemon_that_is_not_aiipd_is_ended_before_the_refusal() {
        let scratch = Scratch::new();
        let overlay = FakeOverlay::new();
        let dir = scratch.path().join("net");
        let children: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let (inner_overlay, seen_children) = (overlay.clone(), children.clone());
        let spawn: SpawnFn = Arc::new(move |request: &SpawnRequest<'_>| {
            let fake = inner_overlay.fake_at(&state_dir_of(request.args).join("aiipd.sock"));
            fake.set_version("something-else");
            fake.start().unwrap();
            let seen = Seen::default();
            seen_children.lock().unwrap().push(seen.clone());
            Ok(Box::new(FakeChild {
                pid: std::process::id(),
                fake: Some(fake),
                behaviour: Behaviour::Serves,
                seen,
            }) as Box<dyn ChildLike>)
        });
        let error = ensure_aiip_daemon(&dir, with_spawn("/opt/aiip", spawn)).unwrap_err();
        assert!(error.contains("is not aiipd"), "{error}");
        assert_eq!(children.lock().unwrap()[0].kills(), vec![KillSignal::Term]);
        assert!(!dir.join("aiipd.sock").exists());
    }

    #[test]
    fn a_child_that_loses_the_lock_to_a_daemon_that_came_up_meanwhile_is_not_ours() {
        let scratch = Scratch::new();
        let overlay = FakeOverlay::new();
        let dir = scratch.path().join("net");
        fs::create_dir_all(&dir).unwrap();
        let children: Arc<Mutex<Vec<(Seen, FakeAiipd)>>> = Arc::default();
        let (inner_overlay, seen_children, socket) =
            (overlay.clone(), children.clone(), dir.join("aiipd.sock"));
        let spawn: SpawnFn = Arc::new(move |_: &SpawnRequest<'_>| {
            // another run's daemon takes the socket while our child boots; our child exits as the lock's loser
            let other = inner_overlay.fake_at(&socket);
            other.start().unwrap();
            let seen = Seen::default();
            *seen.exit.lock().unwrap() = Some(ChildExit::Code(0));
            seen_children.lock().unwrap().push((seen.clone(), other));
            Ok(Box::new(FakeChild {
                pid: 4243, // not the pid the other daemon reports
                fake: None,
                behaviour: Behaviour::Inert,
                seen,
            }) as Box<dyn ChildLike>)
        });
        let mut options = with_spawn("/opt/aiip", spawn);
        options.poll_ms = Some(10);
        let daemon = ensure_aiip_daemon(&dir, options).unwrap();
        assert!(!daemon.spawned);
        assert_eq!(daemon.pid, Some(std::process::id()));
        daemon.stop();
        let (seen, other) = children.lock().unwrap()[0].clone();
        assert_eq!(seen.kills(), vec![]);
        assert_eq!(daemon.client.status().unwrap().version, KNOWN_AIIP_API);
        other.stop();
    }

    #[test]
    fn a_daemon_answering_with_another_pid_than_our_child_is_found_and_our_child_is_ended() {
        let scratch = Scratch::new();
        let overlay = FakeOverlay::new();
        let dir = scratch.path().join("net");
        fs::create_dir_all(&dir).unwrap();
        let children: Arc<Mutex<Vec<(Seen, FakeAiipd)>>> = Arc::default();
        let (inner_overlay, seen_children, socket) =
            (overlay.clone(), children.clone(), dir.join("aiipd.sock"));
        let spawn: SpawnFn = Arc::new(move |_: &SpawnRequest<'_>| {
            let other = inner_overlay.fake_at(&socket); // reports this process's pid, not 4242
            other.start().unwrap();
            let seen = Seen::default();
            seen_children.lock().unwrap().push((seen.clone(), other));
            Ok(Box::new(FakeChild {
                pid: 4242,
                fake: None,
                behaviour: Behaviour::Inert,
                seen,
            }) as Box<dyn ChildLike>)
        });
        let mut options = with_spawn("/opt/aiip", spawn);
        options.poll_ms = Some(10);
        let daemon = ensure_aiip_daemon(&dir, options).unwrap();
        assert!(!daemon.spawned);
        let (seen, other) = children.lock().unwrap()[0].clone();
        assert_eq!(seen.kills(), vec![KillSignal::Term]);
        daemon.stop();
        assert_eq!(seen.kills(), vec![KillSignal::Term]);
        other.stop();
    }

    #[test]
    fn a_socket_path_over_the_daemons_limit_is_refused_before_anything_starts() {
        let scratch = Scratch::new();
        let dir = scratch.path().join("x".repeat(100));
        let error = socket_path_for(&dir).unwrap_err();
        assert!(
            error.contains(" bytes and the daemon allows 100; set ABAI_NET_DIR"),
            "{error}"
        );
        let error = ensure_aiip_daemon(&dir, with_spawn("/opt/aiip", no_spawn())).unwrap_err();
        assert!(error.contains("daemon allows 100"), "{error}");
        assert!(!dir.exists());
    }

    #[test]
    fn a_binary_that_cannot_be_started_is_reported_as_such() {
        let scratch = Scratch::new();
        let dir = scratch.path().join("net");
        let spawn: SpawnFn =
            Arc::new(|_: &SpawnRequest<'_>| Err(std::io::Error::other("spawn /nope/aiip ENOENT")));
        let error = ensure_aiip_daemon(&dir, with_spawn("/nope/aiip", spawn)).unwrap_err();
        assert_eq!(
            error,
            "the aiip binary could not be started (/nope/aiip): spawn /nope/aiip ENOENT"
        );
        // and the real spawn, for a binary that is not there
        let error = ensure_aiip_daemon(
            &scratch.path().join("net2"),
            EnsureOptions::new("/nope/aiip"),
        )
        .unwrap_err();
        assert!(
            error.starts_with("the aiip binary could not be started (/nope/aiip): "),
            "{error}"
        );
    }
}
