//! Sidecar mode on the program's side (contract section 6.3).
//!
//! At startup the stub makes three files in the run directory: the
//! region, as a segment both processes map; a Unix socket it listens on;
//! and a descriptor that says where the other two are. One receiving
//! thread waits on the socket from then on.
//!
//! A harness process connects twice. The first connection is the control
//! connection: JSON lines, for the hello, touchpoints and their outcomes.
//! The second carries wakes only: one byte each, written without
//! blocking. Everything else crosses in the region.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::{AsRawFd, IntoRawFd};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicI32, AtomicU8, AtomicU32, Ordering};
use std::sync::mpsc::{RecvTimeoutError, SyncSender, sync_channel};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::env::EnvFn;
use crate::link::{Harness, Outcome, StubCore, Touch};
use crate::manifest::Manifest;
use crate::region::calls::{self, Which};
use crate::region::{DEFAULT_RING_SLOTS, Region, SAFEPOINT_PAUSED, Wake, header};

/// The version of the lines the two halves exchange.
pub const PROTOCOL: u64 = 1;
/// Names the machine directory; default `~/.abai`.
pub const ENV_HOME: &str = "ABAI_HOME";
/// Names the harness binary, before every other place it is looked for.
pub const ENV_HARNESS_BIN: &str = "ABAI_HARNESS_BIN";
/// Sidecar launch: the descriptor of the connection the harness handed
/// this process, and the harness's pid, as `FD:PID`.
pub const ENV_LAUNCH_FD: &str = "ABAI_LAUNCH_FD";
/// The harness binary's name on the PATH.
pub const HARNESS_BIN: &str = "abai-harness";

/// How long one side waits for the other's line while they greet.
const HANDSHAKE: Duration = Duration::from_secs(2);
/// How long a new connection may take to say what it is. Both of a
/// harness's connections say it as they connect.
const STRAY: Duration = Duration::from_millis(200);
/// The longest line of a greeting.
const GREETING_BYTES: usize = 4096;
/// How long a control line may take to be written. A harness that does
/// not read for this long is treated as gone.
const WRITE_WAIT: Duration = Duration::from_secs(1);
/// How long an attach the program asked for waits for the harness it
/// started.
/// A harness that joins a network with an invite may take a minute over
/// it; one that has ended is noticed at once, whatever this says.
const ATTACH_WAIT: Duration = Duration::from_secs(75);
/// How often a program thread waiting at a touchpoint looks for work
/// queued for a safepoint.
const TOUCH_POLL: Duration = Duration::from_millis(2);
/// How long past its timeout a program thread waits for a decision or a
/// turn before it takes the default by itself.
const GRACE: Duration = Duration::from_millis(500);

/// How long a launched program waits, as it starts, for the harness that
/// launched it to say it is attached.
const LAUNCH_WAIT: Duration = Duration::from_secs(10);
/// How often a thread held by a cooperative pause looks for work queued
/// for it, and for the pause's end if the word of it was lost.
const PAUSE_POLL: Duration = Duration::from_millis(20);

const WAITING: u8 = 0;
const SERVED: u8 = 1;
const GIVEN_UP: u8 = 2;

/// The machine directory: `ABAI_HOME`, else `~/.abai`.
pub fn abai_home(env: EnvFn) -> Option<PathBuf> {
    if let Some(explicit) = env(ENV_HOME) {
        let explicit = explicit.trim();
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }
    match env("HOME") {
        Some(user_home) if !user_home.is_empty() => Some(Path::new(&user_home).join(".abai")),
        _ => None,
    }
}

/// Where running Rust abaigrams are listed, under the machine directory.
pub fn run_dir(home: &Path) -> PathBuf {
    home.join("run-rust")
}

/// Whether a process with this pid exists.
pub fn alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 sends nothing; it only asks whether the pid exists.
    let sent = unsafe { libc::kill(pid, 0) };
    // a process of another user exists too
    sent == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// What a running program says about itself, as a file in the run
/// directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Descriptor {
    pub pid: u32,
    pub name: String,
    pub entry: String,
    pub socket: PathBuf,
    pub region: PathBuf,
    /// Seconds since the epoch.
    pub started: u64,
}

/// The programs listed in a run directory, oldest first. A descriptor
/// whose process has gone is removed, with its socket and its region.
pub fn descriptors(run_dir: &Path) -> Vec<Descriptor> {
    let Ok(entries) = std::fs::read_dir(run_dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let Some(descriptor) = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Descriptor>(&bytes).ok())
        else {
            continue;
        };
        if alive(descriptor.pid) {
            found.push(descriptor);
        } else {
            // only what is inside the run directory is ours to remove
            for file in [&descriptor.socket, &descriptor.region] {
                if file.parent() == Some(run_dir) {
                    let _ = std::fs::remove_file(file);
                }
            }
            let _ = std::fs::remove_file(&path);
        }
    }
    found.sort_by_key(|descriptor| (descriptor.started, descriptor.pid));
    found
}

/// A touchpoint as a control line.
pub fn touch_line(id: u64, touch: &Touch) -> Value {
    let millis = |timeout: &Duration| u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX);
    match touch {
        Touch::Decide {
            name,
            context,
            timeout,
        } => json!({"op": "touch", "id": id, "kind": "decide", "name": name,
            "context": context, "timeout_ms": millis(timeout)}),
        Touch::Turn { name, timeout } => json!({"op": "touch", "id": id, "kind": "turn",
            "name": name, "timeout_ms": millis(timeout)}),
        Touch::Install => json!({"op": "touch", "id": id, "kind": "install"}),
        Touch::Session => json!({"op": "touch", "id": id, "kind": "session"}),
    }
}

/// The touchpoint a control line carries.
pub fn line_touch(line: &Value) -> Option<(u64, Touch)> {
    let id = line["id"].as_u64()?;
    let name = || line["name"].as_str().map(str::to_string);
    let timeout = || line["timeout_ms"].as_u64().map(Duration::from_millis);
    let touch = match line["kind"].as_str()? {
        "decide" => Touch::Decide {
            name: name()?,
            context: line["context"].clone(),
            timeout: timeout()?,
        },
        "turn" => Touch::Turn {
            name: name()?,
            timeout: timeout()?,
        },
        "install" => Touch::Install,
        "session" => Touch::Session,
        _ => return None,
    };
    Some((id, touch))
}

/// A touchpoint's outcome as a control line.
pub fn outcome_line(id: u64, outcome: &Outcome) -> Value {
    match outcome {
        Outcome::Answer(value) => {
            json!({"op": "outcome", "id": id, "outcome": "answer", "value": value})
        }
        Outcome::Default => json!({"op": "outcome", "id": id, "outcome": "default"}),
        Outcome::Done => json!({"op": "outcome", "id": id, "outcome": "done"}),
        Outcome::Detached => json!({"op": "outcome", "id": id, "outcome": "detached"}),
        Outcome::Refused(reason) => {
            json!({"op": "outcome", "id": id, "outcome": "refused", "reason": reason})
        }
        Outcome::Unserved => json!({"op": "outcome", "id": id, "outcome": "unserved"}),
    }
}

/// The outcome a control line carries.
pub fn line_outcome(line: &Value) -> Option<(u64, Outcome)> {
    let id = line["id"].as_u64()?;
    let outcome = match line["outcome"].as_str()? {
        "answer" => Outcome::Answer(line.get("value")?.clone()),
        "default" => Outcome::Default,
        "done" => Outcome::Done,
        "detached" => Outcome::Detached,
        "refused" => Outcome::Refused(line["reason"].as_str().unwrap_or("").to_string()),
        "unserved" => Outcome::Unserved,
        _ => return None,
    };
    Some((id, outcome))
}

/// Write one control line.
pub fn send_line(stream: &mut UnixStream, line: &Value) -> std::io::Result<()> {
    let mut text = line.to_string();
    text.push('\n');
    stream.write_all(text.as_bytes())
}

/// Read one control line. None at the end of the stream, on an error, or
/// when the line is not JSON.
pub fn read_line(reader: &mut BufReader<UnixStream>) -> Option<Value> {
    let mut text = String::new();
    match reader.read_line(&mut text) {
        Ok(read) if read > 0 => serde_json::from_str(&text).ok(),
        _ => None,
    }
}

/// Read a greeting's line, one byte at a time so nothing past it is
/// taken, and no later than `deadline` however slowly it comes.
fn greeting(stream: &mut UnixStream, deadline: Instant) -> Option<Value> {
    use std::io::Read;
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || line.len() > GREETING_BYTES {
            return None;
        }
        stream.set_read_timeout(Some(left)).ok()?;
        match stream.read(&mut byte) {
            Ok(1) if byte[0] == b'\n' => return serde_json::from_slice(&line).ok(),
            Ok(1) => line.push(byte[0]),
            _ => return None,
        }
    }
}

/// Where the harness binary is: `ABAI_HARNESS_BIN`, the manifest's
/// `harness.path`, the machine configuration's `rust_harness.bin`, then
/// `abai-harness` on the PATH.
pub fn find_harness(
    manifest: &Manifest,
    root: Option<&Path>,
    env: EnvFn,
) -> Result<PathBuf, String> {
    let named = |from: &str, path: PathBuf| {
        if path.is_file() {
            Ok(path)
        } else {
            Err(format!(
                "the harness binary {from} names is not a file: {}",
                path.display()
            ))
        }
    };
    if let Some(path) = env(ENV_HARNESS_BIN).filter(|path| !path.trim().is_empty()) {
        return named(ENV_HARNESS_BIN, PathBuf::from(path.trim()));
    }
    if let Some(path) = manifest.harness.as_ref().and_then(|h| h.path.as_deref()) {
        let path = Path::new(path);
        let path = match root {
            Some(root) if path.is_relative() => root.join(path),
            _ => path.to_path_buf(),
        };
        return named("the manifest", path);
    }
    let configured = abai_home(env)
        .and_then(|home| std::fs::read(home.join("config.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|config| config["rust_harness"]["bin"].as_str().map(PathBuf::from));
    if let Some(path) = configured {
        return named("the machine configuration", path);
    }
    let on_path = env("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(HARNESS_BIN))
            .find(|candidate| candidate.is_file())
    });
    on_path.ok_or_else(|| {
        format!(
            "the harness binary was not found: set {ENV_HARNESS_BIN}, or put {HARNESS_BIN} on the PATH"
        )
    })
}

/// The files of one running program.
#[derive(Debug)]
struct Files {
    descriptor: PathBuf,
    socket: PathBuf,
    region: PathBuf,
}

impl Files {
    fn remove(&self) {
        for file in [&self.descriptor, &self.socket, &self.region] {
            let _ = std::fs::remove_file(file);
        }
    }
}

/// What startup made, before the program's core exists.
#[derive(Debug)]
pub(crate) struct Setup {
    pub(crate) region: Arc<Region>,
    files: Files,
    listener: UnixListener,
}

/// Make the region, the socket and the descriptor of this program.
pub(crate) fn setup(manifest: &Manifest, env: EnvFn) -> Result<Setup, String> {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let home =
        abai_home(env).ok_or("neither ABAI_HOME nor HOME is set, so there is no run directory")?;
    let dir = run_dir(&home);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .map_err(|error| format!("{} could not be made: {error}", dir.display()))?;
    // what programs that have gone left behind
    descriptors(&dir);

    let pid = std::process::id();
    // a process may hold more than one program: the first is named for
    // the pid alone
    let stem = match NEXT.fetch_add(1, Ordering::SeqCst) {
        0 => pid.to_string(),
        more => format!("{pid}-{more}"),
    };
    let files = Files {
        descriptor: dir.join(format!("{stem}.json")),
        socket: dir.join(format!("{stem}.sock")),
        region: dir.join(format!("{stem}.region")),
    };
    // a socket's path has a small limit, and a bind past it says little
    // SAFETY: an all-zero `sockaddr_un` is a valid value; only the
    // length of its path field is read.
    let limit = unsafe { std::mem::zeroed::<libc::sockaddr_un>() }
        .sun_path
        .len();
    if files.socket.as_os_str().len() >= limit {
        return Err(format!(
            "{} is too long for a socket ({limit} bytes at most): set ABAI_HOME to a shorter path",
            files.socket.display()
        ));
    }
    let made = (|| -> std::io::Result<(Arc<Region>, UnixListener)> {
        let region = Region::create_shared(manifest, DEFAULT_RING_SLOTS, &files.region)?;
        let _ = std::fs::remove_file(&files.socket);
        let listener = UnixListener::bind(&files.socket)?;
        std::fs::set_permissions(&files.socket, std::fs::Permissions::from_mode(0o600))?;
        let descriptor = Descriptor {
            pid,
            name: manifest.name.clone(),
            entry: manifest.entry.clone(),
            socket: files.socket.clone(),
            region: files.region.clone(),
            started: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |since| since.as_secs()),
        };
        // written whole, then named: a reader never sees half of it
        let draft = files.descriptor.with_extension("tmp");
        std::fs::write(
            &draft,
            serde_json::to_vec(&descriptor).expect("a descriptor serializes"),
        )?;
        std::fs::rename(&draft, &files.descriptor)?;
        Ok((region, listener))
    })();
    match made {
        Ok((region, listener)) => Ok(Setup {
            region,
            files,
            listener,
        }),
        Err(error) => {
            files.remove();
            Err(format!(
                "the sidecar endpoint could not be made in {}: {error}",
                dir.display()
            ))
        }
    }
}

/// A program thread blocked at a touchpoint.
struct Waiter {
    state: Arc<AtomicU8>,
    send: SyncSender<Outcome>,
}

#[derive(Default)]
struct Link {
    /// The control connection's writing end, while a harness is connected.
    control: Option<UnixStream>,
    /// The connected harness has said it is attached.
    attached: bool,
    waiters: HashMap<u64, Waiter>,
    next_id: u64,
    /// Why the last harness left, when it said.
    left: Option<String>,
    /// The harness this program started, if it started one.
    child: Option<Child>,
    /// Sidecar launch: the connection the harness handed over has been
    /// greeted, or has failed.
    launch_over: bool,
}

impl Link {
    /// Write a control line. A line that cannot be written whole, in
    /// time, leaves the stream broken: the connection is shut, and the
    /// receiving thread then finds the harness gone.
    fn send(&mut self, line: &Value) -> bool {
        let Some(control) = &mut self.control else {
            return false;
        };
        if send_line(control, line).is_ok() {
            return true;
        }
        let _ = control.shutdown(std::net::Shutdown::Both);
        self.attached = false;
        false
    }
}

/// Wakes the harness process: one byte on the wake connection, never
/// blocking. The descriptor number stays the same for the life of the
/// process; a new harness's connection is put under the same number.
struct SocketWake(Arc<AtomicI32>);

impl Wake for SocketWake {
    fn wake(&self) {
        let fd = self.0.load(Ordering::Relaxed);
        if fd < 0 {
            return;
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let flags = libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        let flags = libc::MSG_DONTWAIT;
        let byte = [1u8];
        // SAFETY: one byte from a live buffer to a descriptor this
        // process owns and never closes. A full buffer or a harness that
        // has gone is an error that needs nothing done.
        unsafe {
            libc::send(fd, byte.as_ptr().cast(), 1, flags);
        }
    }
}

thread_local! {
    /// Whether this thread is a stub's receiving thread.
    static ON_RECEIVING_THREAD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// The program's end of sidecar mode: the listening socket, the
/// receiving thread, and the harness that is connected, if one is.
pub(crate) struct Endpoint {
    stub: Arc<StubCore>,
    files: Files,
    listener: UnixListener,
    link: Mutex<Link>,
    changed: Condvar,
    wake_fd: Arc<AtomicI32>,
}

impl std::fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Endpoint")
            .field("socket", &self.files.socket)
            .finish_non_exhaustive()
    }
}

/// Start the receiving thread. It waits on the socket until the process
/// ends.
///
/// `launched` is the connection a harness that launched this process
/// handed it. This returns once that harness is attached, or cannot be.
pub(crate) fn start(
    setup: Setup,
    stub: Arc<StubCore>,
    launched: Option<UnixStream>,
) -> Result<Arc<Endpoint>, String> {
    let wake_fd = Arc::new(AtomicI32::new(-1));
    stub.region.set_waker(Box::new(SocketWake(wake_fd.clone())));
    let endpoint = Arc::new(Endpoint {
        stub,
        files: setup.files,
        listener: setup.listener,
        link: Mutex::new(Link::default()),
        changed: Condvar::new(),
        wake_fd,
    });
    let receiving = endpoint.clone();
    let under_launch = launched.is_some();
    std::thread::Builder::new()
        .name("abai-receive".to_string())
        .spawn(move || receiving.receive(launched))
        .map_err(|error| {
            endpoint.files.remove();
            format!("the receiving thread could not be started: {error}")
        })?;
    if under_launch {
        // the program is attached before its own work begins
        let deadline = Instant::now() + LAUNCH_WAIT;
        let mut link = endpoint.link();
        loop {
            // attached, or the connection was greeted and has ended
            let settled = link.attached || (link.launch_over && link.control.is_none());
            let left = deadline.saturating_duration_since(Instant::now());
            if settled || left.is_zero() {
                break;
            }
            link = endpoint
                .changed
                .wait_timeout(link, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
    Ok(endpoint)
}

/// The connection a harness that launched this process handed it, when
/// one did. The variable names a descriptor and the harness's pid; a
/// process further down, which inherited the variable and not the
/// descriptor, finds another parent and takes nothing.
pub(crate) fn launch_stream(env: EnvFn) -> Option<UnixStream> {
    use std::os::fd::FromRawFd;
    // the descriptor has one owner: the first program this process makes
    static TAKEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let value = env(ENV_LAUNCH_FD)?;
    let (fd, parent) = value.trim().split_once(':')?;
    let fd: i32 = fd.parse().ok().filter(|fd| *fd > 2)?;
    let parent: libc::pid_t = parent.parse().ok()?;
    // SAFETY: `getppid` only reads; `fstat` writes into a live, zeroed
    // buffer of its own type and fails cleanly on a number that is not
    // an open descriptor.
    let ours = unsafe {
        if libc::getppid() != parent {
            return None;
        }
        let mut stat: libc::stat = std::mem::zeroed();
        libc::fstat(fd, &mut stat) == 0 && (stat.st_mode & libc::S_IFMT) == libc::S_IFSOCK
    };
    if !ours || TAKEN.swap(true, Ordering::SeqCst) {
        return None;
    }
    // SAFETY: the parent opened this descriptor for this process and
    // named it; nothing else here owns it. It is kept out of the
    // processes this program starts.
    unsafe {
        libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        Some(UnixStream::from_raw_fd(fd))
    }
}

/// Wait until a descriptor is readable, at most `wait`; forever when
/// `wait` is None. Returns which of the two are.
fn readable(first: i32, second: Option<i32>, wait: Option<Duration>) -> (bool, bool) {
    let events = libc::POLLIN;
    let mut fds = [
        libc::pollfd {
            fd: first,
            events,
            revents: 0,
        },
        libc::pollfd {
            // a negative descriptor is skipped
            fd: second.unwrap_or(-1),
            events,
            revents: 0,
        },
    ];
    let millis = wait.map_or(-1, |wait| {
        i32::try_from(wait.as_millis()).unwrap_or(i32::MAX)
    });
    // SAFETY: `fds` is a live array of two entries, and its length is
    // what is passed.
    let ready = unsafe { libc::poll(fds.as_mut_ptr(), 2, millis) };
    if ready <= 0 {
        return (false, false);
    }
    (fds[0].revents != 0, fds[1].revents != 0)
}

impl Endpoint {
    fn link(&self) -> MutexGuard<'_, Link> {
        self.link.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The socket a harness connects to.
    pub(crate) fn socket(&self) -> &Path {
        &self.files.socket
    }

    /// Whether a harness is connected and has said it is attached.
    pub(crate) fn attached(&self) -> bool {
        self.link().attached && self.stub.region.attached()
    }

    /// The process is ending, or the program is dropped: its files go.
    pub(crate) fn close(&self) {
        self.files.remove();
        if let Some(child) = &mut self.link().child {
            let _ = child.try_wait();
        }
    }

    /// The receiving thread: new connections, and the connected
    /// harness's lines.
    fn receive(&self, launched: Option<UnixStream>) {
        ON_RECEIVING_THREAD.with(|on| on.set(true));
        let mut control: Option<BufReader<UnixStream>> = None;
        if let Some(stream) = launched {
            control = self.greet(stream, false);
            self.link().launch_over = true;
            self.changed.notify_all();
        }
        loop {
            let control_fd = control.as_ref().map(|reader| reader.get_ref().as_raw_fd());
            let (connecting, speaking) = readable(self.listener.as_raw_fd(), control_fd, None);
            // the connected harness first: when it has just gone, the
            // one that is connecting is not refused for its sake
            if speaking && let Some(reader) = &mut control {
                loop {
                    match read_line(reader) {
                        Some(line) => self.handle(&line),
                        None => {
                            control = None;
                            self.disconnect();
                            break;
                        }
                    }
                    // a line already read into the buffer raises no
                    // readable event: take it now. And what has arrived
                    // since is read before a new connection is looked
                    // at, so a harness that has just gone is seen to be
                    // gone before the next one is greeted.
                    let more = reader.buffer().contains(&b'\n')
                        || readable(reader.get_ref().as_raw_fd(), None, Some(Duration::ZERO)).0;
                    if !more {
                        break;
                    }
                }
            }
            if connecting {
                match self.listener.accept() {
                    Ok((stream, _)) => {
                        if let Some(reader) = self.greet(stream, control.is_some()) {
                            control = Some(reader);
                        }
                    }
                    // out of descriptors, say: the socket stays readable,
                    // so wait before looking again
                    Err(_) => std::thread::sleep(Duration::from_millis(50)),
                }
            }
        }
    }

    /// Greet a new connection. Returns the control connection's reading
    /// end when a harness is now connected.
    fn greet(&self, mut stream: UnixStream, busy: bool) -> Option<BufReader<UnixStream>> {
        let refuse = |stream: &mut UnixStream, reason: &str| {
            let _ = send_line(stream, &json!({"abai": "refused", "reason": reason}));
        };
        // a harness writes its hello as it connects; one that waits its
        // turn behind a silent connection must not time out meanwhile
        let mut hello = greeting(&mut stream, Instant::now() + STRAY)?;
        // more than one harness may be greeted here: one that left as
        // soon as it had said hello gives way to the one behind it
        let wake = 'harness: loop {
            if hello["abai"] != "hello" {
                return None;
            }
            if hello["protocol"] != PROTOCOL {
                refuse(
                    &mut stream,
                    &format!("this program's stub speaks protocol {PROTOCOL}"),
                );
                return None;
            }
            if busy {
                refuse(&mut stream, "a harness is attached already");
                return None;
            }
            let stub = &self.stub;
            // the token ties the wake connection to this one; who may
            // connect at all is settled by the socket's permissions
            let token = format!(
                "{:x}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |since| since.as_nanos())
                    ^ u128::from(std::process::id())
            );
            let reply = json!({
                "abai": "hello",
                "protocol": PROTOCOL,
                "pid": std::process::id(),
                "region": self.files.region,
                "socket": self.files.socket,
                "root": stub.root(),
                "manifest": stub.manifest,
                "token": token,
            });
            send_line(&mut stream, &reply).ok()?;

            // the harness's second connection, for wakes
            let deadline = Instant::now() + HANDSHAKE;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return None;
                }
                // A harness makes its second connection before it says
                // anything more. One that has said more, or has gone,
                // with no second connection to be seen has left: a
                // connection closed before it is accepted is not kept by
                // every system.
                let (connecting, speaking) = readable(
                    self.listener.as_raw_fd(),
                    Some(stream.as_raw_fd()),
                    Some(left),
                );
                if !connecting {
                    if speaking && !readable(self.listener.as_raw_fd(), None, Some(STRAY / 10)).0 {
                        return None;
                    }
                    continue;
                }
                let Ok((mut other, _)) = self.listener.accept() else {
                    continue;
                };
                // the harness writes its wake line as it connects; a
                // connection that says nothing does not hold the attach up
                match greeting(&mut other, Instant::now() + left.min(STRAY)) {
                    Some(line) if line["abai"] == "wake" && line["token"] == token.as_str() => {
                        break 'harness other;
                    }
                    Some(line) if line["abai"] == "hello" => {
                        if readable(stream.as_raw_fd(), None, Some(Duration::ZERO)).0 {
                            // the harness being greeted has left: this
                            // one is greeted in its place
                            stream = other;
                            hello = line;
                            continue 'harness;
                        }
                        refuse(&mut other, "a harness is attaching");
                    }
                    _ => {}
                }
            }
        };
        self.take_wake(wake)?;
        stream.set_read_timeout(None).ok()?;
        // a harness that has stopped reading must not hold a program
        // thread in a write
        stream.set_write_timeout(Some(WRITE_WAIT)).ok()?;
        let reader = BufReader::new(stream.try_clone().ok()?);

        let mut link = self.link();
        link.control = Some(stream);
        link.attached = false;
        link.left = None;
        Some(reader)
    }

    /// Make a connection the one wakes are written to.
    fn take_wake(&self, wake: UnixStream) -> Option<()> {
        wake.set_nonblocking(true).ok()?;
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            let on: libc::c_int = 1;
            // SAFETY: a socket option set from a live integer of the
            // size given, on a socket this function owns.
            unsafe {
                libc::setsockopt(
                    wake.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_NOSIGPIPE,
                    std::ptr::from_ref(&on).cast(),
                    std::mem::size_of::<libc::c_int>() as libc::socklen_t,
                );
            }
        }
        let fresh = wake.into_raw_fd();
        let current = self.wake_fd.load(Ordering::SeqCst);
        if current < 0 {
            self.wake_fd.store(fresh, Ordering::SeqCst);
            return Some(());
        }
        // an emitter may be writing to the number in use: the new
        // connection takes that number over in one step, and the number
        // is never closed
        // SAFETY: both are open descriptors this process owns; `fresh`
        // is closed only after it has been duplicated.
        let moved = unsafe {
            let moved = libc::dup2(fresh, current);
            libc::close(fresh);
            // the copy does not keep the mark that keeps it out of the
            // processes this program starts
            libc::fcntl(current, libc::F_SETFD, libc::FD_CLOEXEC);
            moved
        };
        (moved >= 0).then_some(())
    }

    /// One line from the connected harness.
    fn handle(&self, line: &Value) {
        match line["op"].as_str() {
            Some("attached") => {
                self.link().attached = true;
                self.changed.notify_all();
            }
            Some("outcome") => {
                let Some((id, outcome)) = line_outcome(line) else {
                    return;
                };
                let waiter = self.link().waiters.remove(&id);
                if let Some(waiter) = waiter {
                    let _ = waiter.send.send(outcome);
                }
            }
            Some("claim") => {
                // the harness is about to put a touchpoint on the record
                // as served: it is, unless its thread has stopped waiting
                let Some(id) = line["id"].as_u64() else {
                    return;
                };
                let mut link = self.link();
                let held = link.waiters.get(&id).is_some_and(|waiter| {
                    waiter
                        .state
                        .compare_exchange(WAITING, SERVED, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                        || waiter.state.load(Ordering::SeqCst) == SERVED
                });
                link.send(&json!({"op": "claimed", "id": id, "ok": held}));
            }
            Some("serve") => {
                // an immediate call runs here, on the receiving thread
                self.stub.serve(Which::Immediate);
            }
            Some("detach") => {
                self.link().left = line["reason"].as_str().map(str::to_string);
            }
            Some("resume") => {
                // the pause flag is down in the region: wake who it held
                self.changed.notify_all();
            }
            _ => {}
        }
    }

    /// The control connection has ended: the harness is gone, whatever it
    /// managed to say first.
    fn disconnect(&self) {
        let region = &self.stub.region;
        region[header::ATTACHED].store(0, Ordering::SeqCst);
        region[header::PARKED].store(0, Ordering::SeqCst);
        // a pause ends with the harness that asked for it
        region[header::SAFEPOINT].fetch_and(!SAFEPOINT_PAUSED, Ordering::SeqCst);
        calls::orphan(region);
        let waiters = {
            let mut link = self.link();
            link.control = None;
            link.attached = false;
            std::mem::take(&mut link.waiters)
        };
        // their threads hear that nobody served them
        drop(waiters);
        self.changed.notify_all();
        // a harness this program started may be the one ending: wait a
        // moment for its exit, so it does not stay behind as a dead
        // process. The handle stays where an attach looks for it.
        for _ in 0..10 {
            {
                let mut link = self.link();
                match link.child.as_mut().map(Child::try_wait) {
                    Some(Ok(None)) => {}
                    Some(_) => {
                        link.child = None;
                        self.changed.notify_all();
                        return;
                    }
                    None => return,
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// A safepoint or a touchpoint reached during a cooperative pause:
    /// block here until the harness resumes the program or goes. Work
    /// queued for a safepoint is still served, so a stop asked during a
    /// pause runs. `touchpoint` names the touchpoint, when it is one: the
    /// agent is told what its pause is holding.
    pub(crate) fn pause_point(&self, touchpoint: Option<&str>) {
        let region = &self.stub.region;
        let paused = || region[header::SAFEPOINT].load(Ordering::SeqCst) & SAFEPOINT_PAUSED != 0;
        // the receiving thread is never held: it is the one that hears
        // of the resume, and of the harness going
        if !paused() || ON_RECEIVING_THREAD.with(std::cell::Cell::get) {
            return;
        }
        if let Some(name) = touchpoint {
            self.link()
                .send(&json!({"op": "event", "name": "abai.pause.blocked",
                "payload": {"touchpoint": name}}));
        }
        let mut link = self.link();
        while paused() {
            if calls::take_queued(region) {
                drop(link);
                self.stub.serve(Which::Safepoint);
                link = self.link();
                continue;
            }
            link = self
                .changed
                .wait_timeout(link, PAUSE_POLL)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    /// The stub initiates an attach: it starts a harness, which connects
    /// to the socket, and waits until that harness says it is attached.
    pub(crate) fn attach(&self, env: EnvFn) -> Result<(), String> {
        if self.attached() {
            return Ok(());
        }
        let bin = find_harness(&self.stub.manifest, self.stub.root(), env)?;
        let child = Command::new(&bin)
            .arg("attach")
            .arg("--socket")
            .arg(&self.files.socket)
            .spawn()
            .map_err(|error| format!("{} could not be started: {error}", bin.display()))?;
        let mut link = self.link();
        if let Some(mut old) = link.child.replace(child) {
            let _ = old.try_wait();
        }
        link.left = None;
        let deadline = Instant::now() + ATTACH_WAIT;
        let mut exited_at = None;
        loop {
            if link.attached {
                return Ok(());
            }
            let now = Instant::now();
            let status = match &mut link.child {
                Some(child) => child.try_wait().ok().flatten(),
                None => None,
            };
            if let Some(status) = status {
                // what it said before it went is read first, for a moment
                let exited = *exited_at.get_or_insert(now);
                if link.control.is_none() || now.duration_since(exited) > Duration::from_millis(500)
                {
                    link.child = None;
                    return Err(link.left.take().unwrap_or_else(|| {
                        format!("the harness ended before it attached ({status})")
                    }));
                }
            } else if link.child.is_none() && link.control.is_none() {
                // the receiving thread saw it go and took its exit
                return Err(link
                    .left
                    .take()
                    .unwrap_or_else(|| "the harness ended before it attached".to_string()));
            }
            if now >= deadline {
                if let Some(mut child) = link.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                return Err(format!(
                    "the harness did not attach in {} s",
                    ATTACH_WAIT.as_secs()
                ));
            }
            link = self
                .changed
                .wait_timeout(link, Duration::from_millis(20))
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
}

impl Harness for Endpoint {
    fn touch(&self, touch: Touch) -> Outcome {
        let limit = match &touch {
            Touch::Decide { timeout, .. } | Touch::Turn { timeout, .. } => Some(*timeout + GRACE),
            Touch::Install | Touch::Session => None,
        };
        let asked = Instant::now();
        let state = Arc::new(AtomicU8::new(WAITING));
        let (send, answer) = sync_channel(1);
        let id = {
            let mut link = self.link();
            if !link.attached {
                return Outcome::Unserved;
            }
            let id = link.next_id;
            link.next_id += 1;
            if !link.send(&touch_line(id, &touch)) {
                return Outcome::Unserved;
            }
            link.waiters.insert(
                id,
                Waiter {
                    state: state.clone(),
                    send,
                },
            );
            id
        };
        let region = &self.stub.region;
        loop {
            match answer.recv_timeout(TOUCH_POLL) {
                Ok(outcome) => return outcome,
                // the harness went without serving this
                Err(RecvTimeoutError::Disconnected) => return Outcome::Unserved,
                Err(RecvTimeoutError::Timeout) => {}
            }
            // a touchpoint is a safepoint: what the agent queued for one
            // runs here, on the thread that is waiting
            if region[header::SAFEPOINT].load(Ordering::Relaxed) != 0 && calls::take_queued(region)
            {
                self.stub.serve(Which::Safepoint);
            }
            // past its time the program takes the default, unless the
            // harness has just claimed the touchpoint: then its outcome
            // is on the way and is what the program takes
            if limit.is_some_and(|limit| asked.elapsed() >= limit)
                && state
                    .compare_exchange(WAITING, GIVEN_UP, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
            {
                self.link().waiters.remove(&id);
                return Outcome::Default;
            }
        }
    }
}

/// Run the harness binary with a verb of the standard entry, on this
/// process's terminal, and return its exit code.
pub(crate) fn run_binary(
    manifest: &Manifest,
    root: Option<&Path>,
    env: EnvFn,
    args: &[String],
    meanwhile: Option<&dyn Fn()>,
) -> Result<i32, String> {
    let bin = find_harness(manifest, root, env)?;
    let started =
        |error: std::io::Error| format!("{} could not be started: {error}", bin.display());
    let Some(meanwhile) = meanwhile else {
        let status = Command::new(&bin).args(args).status().map_err(started)?;
        return Ok(status.code().unwrap_or(1));
    };
    // while the harness runs, `meanwhile` is called again and again: the
    // caller's safepoint
    let mut child = Command::new(&bin).args(args).spawn().map_err(started)?;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.code().unwrap_or(1)),
            Ok(None) => {}
            Err(error) => return Err(format!("{} was lost: {error}", bin.display())),
        }
        meanwhile();
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_touchpoint_and_its_outcome_cross_as_lines() {
        let touches = [
            Touch::Decide {
                name: "on_limit".to_string(),
                context: json!({"count": 3}),
                timeout: Duration::from_millis(1500),
            },
            Touch::Turn {
                name: "each_lap".to_string(),
                timeout: Duration::from_secs(5),
            },
            Touch::Install,
            Touch::Session,
        ];
        for (id, touch) in touches.into_iter().enumerate() {
            let line: Value =
                serde_json::from_str(&touch_line(id as u64, &touch).to_string()).unwrap();
            assert_eq!(line_touch(&line), Some((id as u64, touch)));
        }
        let outcomes = [
            Outcome::Answer(json!("wrap")),
            Outcome::Answer(Value::Null),
            Outcome::Default,
            Outcome::Done,
            Outcome::Detached,
            Outcome::Refused("nobody to talk to".to_string()),
            Outcome::Unserved,
        ];
        for outcome in outcomes {
            let line: Value = serde_json::from_str(&outcome_line(7, &outcome).to_string()).unwrap();
            assert_eq!(line_outcome(&line), Some((7, outcome)));
        }
        assert_eq!(line_touch(&json!({"id": 1, "kind": "nap"})), None);
        assert_eq!(line_outcome(&json!({"id": 1, "outcome": "maybe"})), None);
    }

    #[test]
    fn the_machine_directory_is_abai_home_or_under_home() {
        let both = |name: &str| match name {
            "ABAI_HOME" => Some("/a".to_string()),
            "HOME" => Some("/h".to_string()),
            _ => None,
        };
        assert_eq!(abai_home(&both), Some(PathBuf::from("/a")));
        let home = |name: &str| (name == "HOME").then(|| "/h".to_string());
        assert_eq!(abai_home(&home), Some(PathBuf::from("/h/.abai")));
        assert_eq!(abai_home(&|_| None), None);
        assert_eq!(run_dir(Path::new("/a")), PathBuf::from("/a/run-rust"));
    }

    #[test]
    fn this_process_is_alive_and_pid_zero_is_not() {
        assert!(alive(std::process::id()));
        assert!(!alive(0));
        assert!(!alive(u32::MAX));
    }

    #[test]
    fn a_descriptor_whose_process_has_gone_is_removed_with_its_files() {
        let dir = std::env::temp_dir().join(format!("abai-run-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let write = |stem: &str, pid: u32, started: u64| {
            let descriptor = Descriptor {
                pid,
                name: stem.to_string(),
                entry: format!("{stem} abai"),
                socket: dir.join(format!("{stem}.sock")),
                region: dir.join(format!("{stem}.region")),
                started,
            };
            std::fs::write(&descriptor.socket, b"").unwrap();
            std::fs::write(&descriptor.region, b"").unwrap();
            std::fs::write(
                dir.join(format!("{stem}.json")),
                serde_json::to_vec(&descriptor).unwrap(),
            )
            .unwrap();
        };
        write("late", std::process::id(), 20);
        write("early", std::process::id(), 10);
        // a pid no process has
        write("gone", 0x7fff_fff0, 5);
        std::fs::write(dir.join("junk.json"), b"not json").unwrap();

        let names: Vec<String> = descriptors(&dir).into_iter().map(|d| d.name).collect();
        assert_eq!(names, ["early", "late"]);
        assert!(!dir.join("gone.json").exists());
        assert!(!dir.join("gone.sock").exists());
        assert!(!dir.join("gone.region").exists());
        assert!(dir.join("late.region").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_harness_binary_is_looked_for_in_order() {
        let dir = std::env::temp_dir().join(format!("abai-find-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::create_dir_all(dir.join("home")).unwrap();
        for file in ["named", "configured", "bin/abai-harness", "shipped"] {
            std::fs::write(dir.join(file), b"").unwrap();
        }
        std::fs::write(
            dir.join("home/config.json"),
            json!({"rust_harness": {"bin": dir.join("configured")}}).to_string(),
        )
        .unwrap();
        let text = |path: PathBuf| path.display().to_string();
        let mut manifest = crate::declare::Declarations::new("p", [crate::manifest::Mode::Sidecar])
            .manifest()
            .unwrap();

        let all = |name: &str| match name {
            "ABAI_HARNESS_BIN" => Some(text(dir.join("named"))),
            "ABAI_HOME" => Some(text(dir.join("home"))),
            "PATH" => Some(text(dir.join("bin"))),
            _ => None,
        };
        assert_eq!(find_harness(&manifest, None, &all), Ok(dir.join("named")));

        let configured = |name: &str| match name {
            "ABAI_HOME" => Some(text(dir.join("home"))),
            "PATH" => Some(text(dir.join("bin"))),
            _ => None,
        };
        assert_eq!(
            find_harness(&manifest, None, &configured),
            Ok(dir.join("configured"))
        );

        let path = |name: &str| (name == "PATH").then(|| text(dir.join("bin")));
        assert_eq!(
            find_harness(&manifest, None, &path),
            Ok(dir.join("bin/abai-harness"))
        );

        // the manifest's path is relative to the root, and goes before
        // the machine configuration
        manifest.harness = Some(crate::manifest::HarnessDecl {
            path: Some("shipped".to_string()),
        });
        assert_eq!(
            find_harness(&manifest, Some(&dir), &configured),
            Ok(dir.join("shipped"))
        );

        // a place that names a file that is not there is an error, not a
        // reason to look further
        let missing = |name: &str| (name == "ABAI_HARNESS_BIN").then(|| text(dir.join("nope")));
        assert!(
            find_harness(&manifest, None, &missing)
                .unwrap_err()
                .contains("ABAI_HARNESS_BIN")
        );
        manifest.harness = None;
        assert!(
            find_harness(&manifest, None, &|_| None)
                .unwrap_err()
                .contains("was not found")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
