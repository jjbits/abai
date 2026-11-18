//! Running a subject's commands: its entry's verbs and its `check.run`,
//! by the shell in its root, with a constructed environment and a bound
//! on time.
//!
//! The command runs in a process group of its own, so a compound
//! command's children end with it: a run that outlives its bound is
//! ended by that group, SIGTERM and then SIGKILL, and a signal that ends
//! this tool ends the group too. Nothing on the machine is looked for by
//! name.

use std::io::Read;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};

/// One finished run of a command.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CommandRun {
    pub command: String,
    /// The exit code; None when a signal ended the run or it never started.
    pub code: Option<i32>,
    /// The signal that ended the run, by number.
    pub signal: Option<i32>,
    /// The newest bytes of each stream; what came before is counted in `dropped`.
    pub stdout: String,
    pub stderr: String,
    pub dropped: Dropped,
    /// Wall clock, from the start to the exit.
    pub ms: f64,
    #[serde(rename = "timedOut")]
    pub timed_out: bool,
}

/// How many bytes of each stream were let go.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct Dropped {
    pub stdout: u64,
    pub stderr: u64,
}

#[derive(Debug, Clone)]
pub struct CommandOptions<'a> {
    pub cwd: &'a Path,
    /// The whole environment of the run.
    pub env: &'a [(String, String)],
    pub timeout: Duration,
    /// Bytes of each stream kept, the newest.
    pub max_output_bytes: usize,
}

/// The bytes of each stream a run keeps unless told otherwise.
pub const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

/// Variables that tell the stub what to do. A subject inherits only
/// where things are (`ABAI_HOME`, `ABAI_HARNESS_BIN`), never these.
pub const BEHAVIOUR_VARIABLES: [&str; 3] = ["ABAI_MODE", "ABAI_HARNESS", "ABAI_LAUNCH_FD"];

/// The environment a subject's run gets: ours without the behaviour
/// variables, plus exactly what this run means.
pub fn subject_env(base: &[(String, String)], set: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = base
        .iter()
        .filter(|(name, _)| {
            !BEHAVIOUR_VARIABLES.contains(&name.as_str()) && !set.iter().any(|(s, _)| s == name)
        })
        .cloned()
        .collect();
    env.extend(
        set.iter()
            .map(|(name, value)| (name.to_string(), value.to_string())),
    );
    env
}

/// After the timeout's SIGTERM, how long before the group is killed.
pub const FORCE_AFTER: Duration = Duration::from_millis(2000);
/// After the shell has exited, how long a survivor may hold the pipes
/// before the group is killed and the run ends.
pub const CLOSE_GRACE: Duration = Duration::from_millis(1500);
/// How often the run is looked at.
const LOOK_EVERY: Duration = Duration::from_millis(1);

/// The newest `max` bytes of a stream, as chunks arrive.
#[derive(Debug, Default)]
struct Tail {
    chunks: std::collections::VecDeque<Vec<u8>>,
    kept: usize,
    dropped: u64,
    closed: bool,
}

impl Tail {
    fn push(&mut self, chunk: &[u8], max: usize) {
        self.chunks.push_back(chunk.to_vec());
        self.kept += chunk.len();
        while self.kept > max && self.chunks.len() > 1 {
            let oldest = self.chunks.pop_front().unwrap_or_default();
            self.kept -= oldest.len();
            self.dropped += oldest.len() as u64;
        }
    }

    fn text(&self) -> String {
        let bytes: Vec<u8> = self.chunks.iter().flatten().copied().collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

type Shared = Arc<Mutex<Tail>>;

fn locked(tail: &Shared) -> std::sync::MutexGuard<'_, Tail> {
    tail.lock().unwrap_or_else(PoisonError::into_inner)
}

fn read_into(mut stream: impl Read + Send + 'static, max: usize) -> Shared {
    let tail = Shared::default();
    let theirs = tail.clone();
    std::thread::spawn(move || {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => locked(&theirs).push(&buffer[..n], max),
            }
        }
        locked(&theirs).closed = true;
    });
    tail
}

/// The signal this tool was sent while a run was going, or zero. Once
/// set it stays: the tool is ending.
static SENT: AtomicI32 = AtomicI32::new(0);

extern "C" fn note_signal(signal: libc::c_int) {
    SENT.store(signal, Ordering::SeqCst);
}

/// The signal that told this tool to end during a run, if one did. A
/// caller that makes several runs stops when this is set, and ends with
/// 128 plus the signal.
pub fn interrupted() -> Option<i32> {
    match SENT.load(Ordering::SeqCst) {
        0 => None,
        signal => Some(signal),
    }
}

const WATCHED: [libc::c_int; 3] = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP];

/// How many runs are going, and what each watched signal did before the
/// first of them started.
static WATCHING: Mutex<(usize, [libc::sighandler_t; 3])> = Mutex::new((0, [0; 3]));

/// While a run is going, a signal that would end this tool is noted
/// instead, so the run can pass it to its group: the group is outside
/// the terminal's foreground group and would not get it. A signal the
/// process was started to ignore stays ignored. When the last run ends,
/// each signal does again what it did before.
struct Watch;

impl Watch {
    fn start() -> Self {
        let mut watching = WATCHING.lock().unwrap_or_else(PoisonError::into_inner);
        if watching.0 == 0 {
            for (at, signal) in WATCHED.into_iter().enumerate() {
                let handler = note_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
                // SAFETY: `note_signal` only stores to an atomic, which
                // a signal handler may do.
                let before = unsafe { libc::signal(signal, handler) };
                if before == libc::SIG_IGN {
                    // SAFETY: puts back the disposition just replaced.
                    unsafe { libc::signal(signal, libc::SIG_IGN) };
                }
                watching.1[at] = before;
            }
        }
        watching.0 += 1;
        Self
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        let mut watching = WATCHING.lock().unwrap_or_else(PoisonError::into_inner);
        watching.0 -= 1;
        if watching.0 == 0 {
            for (at, signal) in WATCHED.into_iter().enumerate() {
                let before = watching.1[at];
                if before != libc::SIG_ERR {
                    // SAFETY: puts back the disposition `start` replaced.
                    unsafe { libc::signal(signal, before) };
                }
            }
        }
    }
}

/// A signal's name, for saying how a run ended.
pub fn signal_name(signal: i32) -> String {
    match signal {
        libc::SIGHUP => "SIGHUP".to_string(),
        libc::SIGINT => "SIGINT".to_string(),
        libc::SIGQUIT => "SIGQUIT".to_string(),
        libc::SIGABRT => "SIGABRT".to_string(),
        libc::SIGKILL => "SIGKILL".to_string(),
        libc::SIGSEGV => "SIGSEGV".to_string(),
        libc::SIGPIPE => "SIGPIPE".to_string(),
        libc::SIGTERM => "SIGTERM".to_string(),
        other => format!("signal {other}"),
    }
}

/// Signal the whole group, by the pid this run was given. The shell is
/// the group's leader, and the group keeps its id while any member lives.
fn signal_group(pid: u32, signal: libc::c_int) {
    // SAFETY: `kill` with a negative pid signals a process group; it
    // reads no memory of ours.
    unsafe {
        libc::kill(-(pid as libc::pid_t), signal);
    }
}

/// Run a command by the shell and wait for it, at most `timeout` and the
/// time it takes to end it. When the shell has exited, whatever is left
/// of its group is killed: nothing a run started outlives the run.
///
/// A signal that tells this tool to end (SIGINT, SIGTERM, SIGHUP) is
/// passed to the run's group, and to a group that does not end within
/// [`FORCE_AFTER`] a SIGKILL follows. The run then returns as any other,
/// and [`interrupted`] says the tool is ending; once it is, no further
/// command is started.
pub fn run_command(command: &str, options: &CommandOptions<'_>) -> CommandRun {
    let started = Instant::now();
    let not_run = |why: String, signal: Option<i32>| CommandRun {
        command: command.to_string(),
        code: None,
        signal,
        stdout: String::new(),
        stderr: why,
        dropped: Dropped::default(),
        ms: started.elapsed().as_secs_f64() * 1000.0,
        timed_out: false,
    };
    let _watch = Watch::start();
    if let Some(signal) = interrupted() {
        return not_run(
            format!(
                "not run: this tool was told to end ({})\n",
                signal_name(signal)
            ),
            Some(signal),
        );
    }
    let spawned = Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(options.cwd)
        .env_clear()
        .envs(options.env.iter().map(|(name, value)| (name, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => return not_run(format!("{error}\n"), None),
    };
    let pid = child.id();
    let out = read_into(
        child.stdout.take().expect("a piped stdout"),
        options.max_output_bytes,
    );
    let err = read_into(
        child.stderr.take().expect("a piped stderr"),
        options.max_output_bytes,
    );

    let mut timed_out = false;
    // when the group was first told to end, by the timeout or a signal
    let mut told: Option<Instant> = None;
    let mut forced = false;
    let mut passed_on = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if let Some(sent) = interrupted()
            && !passed_on
        {
            passed_on = true;
            told.get_or_insert_with(Instant::now);
            signal_group(pid, sent);
        }
        if started.elapsed() >= options.timeout && !timed_out {
            timed_out = true;
            told.get_or_insert_with(Instant::now);
            signal_group(pid, libc::SIGTERM);
        }
        if told.is_some_and(|told| told.elapsed() >= FORCE_AFTER) && !forced {
            forced = true;
            signal_group(pid, libc::SIGKILL);
        }
        std::thread::sleep(LOOK_EVERY);
    };
    let ms = started.elapsed().as_secs_f64() * 1000.0;

    // the shell has exited. A survivor of its group that still writes
    // gets a bounded wait to finish; then whatever is left of the group
    // is killed, holding the pipes or not. A group with nobody left has
    // no such process, and the kill finds none.
    let closed = |tail: &Shared| locked(tail).closed;
    let exited = Instant::now();
    while !(closed(&out) && closed(&err)) && exited.elapsed() < CLOSE_GRACE {
        std::thread::sleep(LOOK_EVERY);
    }
    signal_group(pid, libc::SIGKILL);
    // the pipes close as the killed members go; what a process that left
    // the group still holds is left to it
    let killed = Instant::now();
    while !(closed(&out) && closed(&err)) && killed.elapsed() < Duration::from_millis(200) {
        std::thread::sleep(LOOK_EVERY);
    }
    let (out, err) = (locked(&out), locked(&err));
    CommandRun {
        command: command.to_string(),
        code: status.and_then(|status| status.code()),
        signal: status.and_then(|status| status.signal()),
        stdout: out.text(),
        stderr: err.text(),
        dropped: Dropped {
            stdout: out.dropped,
            stderr: err.dropped,
        },
        ms,
        timed_out,
    }
}

fn object(text: &str) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// A stream that is one JSON object, pretty or not, else its last line
/// that is one.
pub fn json_document(text: &str) -> Option<Map<String, Value>> {
    object(text).or_else(|| last_json_line(text, |_| true))
}

/// The last line of a stream that is a JSON object and satisfies `accept`.
pub fn last_json_line(
    text: &str,
    accept: impl Fn(&Map<String, Value>) -> bool,
) -> Option<Map<String, Value>> {
    text.lines()
        .rev()
        .map(str::trim)
        .filter(|line| line.starts_with('{'))
        .filter_map(object)
        .find(|map| accept(map))
}

/// The last line with something on it that is not a JSON object, for
/// saying how a run failed.
pub fn last_plain_line(text: &str) -> &str {
    text.lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('{'))
        .unwrap_or("")
}

/// The newest `chars` characters of a text, for a report that should not
/// carry a whole log.
pub fn tail_of(text: &str, chars: usize) -> String {
    let count = text.chars().count();
    if count <= chars {
        return text.to_string();
    }
    let kept: String = text.chars().skip(count - chars).collect();
    format!("[{} earlier characters omitted]\n{kept}", count - chars)
}

/// The middle value; for an even count, the mean of the two in the middle.
pub fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len() / 2;
    match sorted.len() {
        0 => f64::NAN,
        n if n % 2 == 1 => sorted[mid],
        _ => (sorted[mid - 1] + sorted[mid]) / 2.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(env: &[(String, String)], timeout_ms: u64) -> CommandOptions<'_> {
        CommandOptions {
            cwd: Path::new("/"),
            env,
            timeout: Duration::from_millis(timeout_ms),
            max_output_bytes: MAX_OUTPUT_BYTES,
        }
    }

    fn path_env() -> Vec<(String, String)> {
        vec![(
            "PATH".to_string(),
            std::env::var("PATH").unwrap_or_default(),
        )]
    }

    #[test]
    fn a_command_runs_in_the_root_with_the_given_environment() {
        let mut env = path_env();
        env.push(("ABAI_T".to_string(), "seen".to_string()));
        let run = run_command(
            "pwd; echo $ABAI_T; echo oops >&2; exit 3",
            &options(&env, 10_000),
        );
        assert_eq!(run.code, Some(3));
        assert_eq!(run.signal, None);
        assert_eq!(run.stdout, "/\nseen\n");
        assert_eq!(run.stderr, "oops\n");
        assert!(!run.timed_out);
        assert!(run.ms > 0.0);
    }

    #[test]
    fn nothing_of_ours_is_inherited_unless_given() {
        // SAFETY: a test of its own variable; no other test reads it.
        unsafe { std::env::set_var("ABAI_T_LEAK", "leaked") };
        let run = run_command("echo [$ABAI_T_LEAK]", &options(&path_env(), 10_000));
        assert_eq!(run.stdout, "[]\n");
    }

    /// A file for a command to write a pid into.
    fn pid_file(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("abaikit-command-{tag}-{}.pid", std::process::id()))
    }

    /// Whether the process whose pid the file holds is gone, within a moment.
    fn gone(file: &Path) -> bool {
        let pid: libc::pid_t = std::fs::read_to_string(file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let _ = std::fs::remove_file(file);
        let asked = Instant::now();
        loop {
            // SAFETY: signal 0 only asks whether the process exists.
            let alive = unsafe { libc::kill(pid, 0) } == 0;
            if !alive {
                return true;
            }
            if asked.elapsed() > Duration::from_secs(2) {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_run_past_its_time_is_ended_with_its_children() {
        let file = pid_file("timeout");
        let started = Instant::now();
        // the shell waits on a child of its own: both are in the group
        let command = format!("sleep 30 & echo $! > {}; wait", file.display());
        let run = run_command(&command, &options(&path_env(), 200));
        assert!(run.timed_out);
        assert_eq!(run.code, None);
        assert_eq!(run.signal, Some(libc::SIGTERM));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        assert!(gone(&file), "the child outlived the run");
    }

    #[test]
    fn a_child_left_behind_with_its_output_elsewhere_is_ended_too() {
        // it holds no pipe of ours, so nothing but the group finds it
        let file = pid_file("behind");
        let command = format!("sleep 30 >/dev/null 2>&1 & echo $! > {}", file.display());
        let run = run_command(&command, &options(&path_env(), 20_000));
        assert_eq!(run.code, Some(0));
        assert!(!run.timed_out);
        assert!(gone(&file), "the child outlived the run");
    }

    #[test]
    fn a_child_that_ignores_the_end_of_a_timed_out_run_is_killed() {
        let file = pid_file("stubborn");
        let command = format!(
            "sh -c 'trap \"\" TERM; sleep 30' >/dev/null 2>&1 & echo $! > {}; wait",
            file.display()
        );
        let run = run_command(&command, &options(&path_env(), 200));
        assert!(run.timed_out);
        assert!(gone(&file), "the child outlived the run");
    }

    #[test]
    fn a_timeout_too_long_to_add_to_is_no_trouble() {
        let run = run_command("echo ok", &options(&path_env(), u64::MAX));
        assert_eq!(run.stdout, "ok\n");
    }

    #[test]
    fn a_signal_this_process_ignores_stays_ignored_and_is_put_back() {
        // SAFETY: reads and restores SIGHUP's disposition around the test.
        unsafe {
            let before = libc::signal(libc::SIGHUP, libc::SIG_IGN);
            let run = run_command("echo ok", &options(&path_env(), 10_000));
            assert_eq!(run.code, Some(0));
            let after = libc::signal(libc::SIGHUP, before);
            // another test's run may be going, with its watch in place;
            // what must not happen is our ignore turning into a default
            assert_ne!(after, libc::SIG_DFL);
        }
        assert_eq!(interrupted(), None);
        assert_eq!(signal_name(libc::SIGTERM), "SIGTERM");
        assert_eq!(signal_name(77), "signal 77");
    }

    #[test]
    fn a_run_that_ignores_the_first_signal_is_killed() {
        let started = Instant::now();
        let run = run_command("trap '' TERM; sleep 30", &options(&path_env(), 100));
        assert!(run.timed_out);
        assert_eq!(run.signal, Some(libc::SIGKILL));
        let took = started.elapsed();
        assert!(
            took >= FORCE_AFTER && took < Duration::from_secs(8),
            "{took:?}"
        );
    }

    #[test]
    fn a_survivor_holding_the_pipes_does_not_hold_the_run() {
        let started = Instant::now();
        // the shell exits at once; its child keeps the pipes open
        let run = run_command("sleep 30 & echo gone", &options(&path_env(), 20_000));
        assert_eq!(run.code, Some(0));
        assert_eq!(run.stdout, "gone\n");
        assert!(!run.timed_out);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        // the measured time is the shell's, not the wait for the pipes
        assert!(run.ms < 1000.0, "{}", run.ms);
    }

    #[test]
    fn only_the_newest_output_is_kept() {
        let env = path_env();
        let mut few = options(&env, 10_000);
        few.max_output_bytes = 16;
        let run = run_command(
            "printf '%s' aaaaaaaaaaaaaaaaaaaa; sleep 0.2; printf '%s' bbbb",
            &few,
        );
        assert_eq!(run.stdout, "bbbb");
        assert_eq!(run.dropped.stdout, 20);
    }

    #[test]
    fn a_command_that_cannot_start_says_so() {
        let env = path_env();
        let mut nowhere = options(&env, 1000);
        nowhere.cwd = Path::new("/no/such/directory/abaikit");
        let run = run_command("true", &nowhere);
        assert_eq!(run.code, None);
        assert!(!run.stderr.is_empty());
    }

    #[test]
    fn the_subject_environment_drops_what_steers_the_stub() {
        let base = vec![
            ("PATH".to_string(), "/bin".to_string()),
            ("ABAI_MODE".to_string(), "thread".to_string()),
            ("ABAI_HARNESS".to_string(), "off".to_string()),
            ("ABAI_LAUNCH_FD".to_string(), "5".to_string()),
            ("ABAI_HOME".to_string(), "/h".to_string()),
        ];
        assert_eq!(
            subject_env(&base, &[]),
            [
                ("PATH".to_string(), "/bin".to_string()),
                ("ABAI_HOME".to_string(), "/h".to_string()),
            ]
        );
        assert_eq!(
            subject_env(&base, &[("ABAI_HARNESS", "null"), ("PATH", "/x")]),
            [
                ("ABAI_HOME".to_string(), "/h".to_string()),
                ("ABAI_HARNESS".to_string(), "null".to_string()),
                ("PATH".to_string(), "/x".to_string()),
            ]
        );
    }

    #[test]
    fn the_last_json_line_is_found_among_others() {
        let text =
            "start\n{\"form\":\"null\"}\nnoise {\n {\"form\":\"exercise\",\"n\":1} \n[1]\nend\n";
        let found = last_json_line(text, |map| {
            map.get("form") == Some(&Value::from("exercise"))
        });
        assert_eq!(found.unwrap()["n"], 1);
        assert_eq!(last_json_line(text, |_| true).unwrap()["form"], "exercise");
        assert!(last_json_line("none\n", |_| true).is_none());
        assert_eq!(json_document("{\n \"a\": 1\n}").unwrap()["a"], 1);
        assert_eq!(json_document("x\n{\"a\":2}\n").unwrap()["a"], 2);
        assert_eq!(last_plain_line("a\n{\"x\":1}\n  b  \n\n"), "b");
        assert_eq!(last_plain_line(""), "");
    }

    #[test]
    fn tails_and_medians() {
        assert_eq!(tail_of("abc", 3), "abc");
        assert_eq!(tail_of("abcdef", 2), "[4 earlier characters omitted]\nef");
        assert_eq!(median(&[3.0, 1.0, 2.0]), 2.0);
        assert_eq!(median(&[4.0, 1.0, 2.0, 3.0]), 2.5);
        assert!(median(&[]).is_nan());
    }
}
