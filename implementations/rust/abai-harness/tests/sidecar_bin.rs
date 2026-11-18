//! Sidecar mode with two real processes: a program that links only the
//! stub, and the harness binary. The model is a local server with
//! scripted answers.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use abai_harness::agent::anthropic_reply;
use abai_harness::model::fake::{Answer, FakeProvider};
use serde_json::{Value, json};

const HARNESS: &str = env!("CARGO_BIN_EXE_abai-harness");

/// The test program: an example of this package, which links only the
/// stub. Cargo builds a package's own binary for its tests, and not
/// always its examples, so the example is built here, once.
fn program() -> PathBuf {
    static BUILT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    BUILT
        .get_or_init(|| {
            let mut build = Command::new(env!("CARGO"));
            build
                .args(["build", "--quiet", "--offline", "-p", "abai-harness"])
                .args(["--example", "sidecar_program"])
                .current_dir(env!("CARGO_MANIFEST_DIR"));
            // what cargo set for this test binary is not passed on: a
            // dependency's build script would see it as a change, and
            // every run would rebuild that dependency twice
            for (name, _) in std::env::vars_os() {
                let name = name.to_string_lossy().into_owned();
                let per_crate = [
                    "CARGO_MANIFEST_",
                    "CARGO_PKG_",
                    "CARGO_BIN_",
                    "CARGO_CRATE_",
                ];
                if per_crate.iter().any(|prefix| name.starts_with(prefix))
                    || name == "CARGO_PRIMARY_PACKAGE"
                    || name == "CARGO_TARGET_TMPDIR"
                {
                    build.env_remove(&name);
                }
            }
            let built = build.status().unwrap();
            assert!(built.success(), "the test program did not build");
            let path = Path::new(HARNESS)
                .parent()
                .unwrap()
                .join("examples/sidecar_program");
            assert!(path.is_file(), "{} is missing", path.display());
            path
        })
        .clone()
}

fn say(text: &str) -> Answer {
    Answer::ok(anthropic_reply(text, &[], "end_turn"))
}

fn tool(id: &str, name: &str, input: Value) -> Answer {
    Answer::ok(anthropic_reply("", &[(id, name, input)], "tool_use"))
}

struct Fixture {
    dir: PathBuf,
    provider: FakeProvider,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Fixture {
    /// A command with the machine directory, the model and the root set.
    fn command(&self, bin: &Path) -> Command {
        let mut command = Command::new(bin);
        command
            .env("ABAI_HOME", self.dir.join("h"))
            .env("ABAI_HARNESS_BIN", HARNESS)
            .env("ABAI_TEST_ROOT", &self.dir)
            .env("ABAI_CHANNEL", "none")
            .env("ANTHROPIC_BASE_URL", &self.provider.url)
            .env("ANTHROPIC_API_KEY", "sk-test")
            .env_remove("ABAI_MODE")
            .env_remove("ABAI_HARNESS")
            .stdin(Stdio::null());
        command
    }

    fn configure(&self) {
        std::fs::write(
            self.dir.join("h/config.json"),
            json!({"provider": "anthropic", "model": "claude-haiku-5-5"}).to_string(),
        )
        .unwrap();
    }

    fn audit(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.join("audit.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| {
                let line: Value = serde_json::from_str(line).unwrap();
                format!("{} {} {}", line["act"], line["name"], line["outcome"]).replace('"', "")
            })
            .collect()
    }
}

fn fixture(answers: Vec<Answer>) -> Fixture {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    // short: a socket's path has a small limit
    let dir = std::env::temp_dir().join(format!(
        "abai-sb-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("abai")).unwrap();
    std::fs::create_dir_all(dir.join("h")).unwrap();
    std::fs::write(dir.join("abai/identity.md"), "You are the agent.\n").unwrap();
    Fixture {
        dir,
        provider: FakeProvider::start(answers),
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn the_program_starts_a_harness_that_answers_its_decision() {
    let f = fixture(vec![
        tool(
            "t1",
            "abai_set",
            json!({"cell": "step", "value": 5, "reason": "bigger steps"}),
        ),
        tool(
            "t2",
            "abai_decide",
            json!({"id": "d1", "answer": "wrap", "reason": "there is room"}),
        ),
        say("Wrapping."),
    ]);
    f.configure();
    // `output` returns when the program and the harness it started have
    // both ended: the harness goes when the program does
    let out = f.command(&program()).arg("decide").output().unwrap();
    let (stdout, stderr) = (text(&out.stdout), text(&out.stderr));
    assert_eq!(stdout, "answer wrap agent=true step 5\n", "{stderr}");
    assert!(
        stderr.contains("detached: the program has gone"),
        "{stderr}"
    );
    assert_eq!(f.audit(), ["knob step ok", "decision on_limit ok"]);
    // the model was told about the decision with its context
    let first = &f.provider.requests()[0].body;
    assert!(first.to_string().contains("asks the decision on_limit"));
    // the program took its files with it
    let left: Vec<_> = std::fs::read_dir(f.dir.join("h/run-rust"))
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name())
        .collect();
    assert!(left.is_empty(), "{left:?}");
}

#[test]
fn with_no_model_configured_the_attach_fails_at_once_and_the_program_runs_on() {
    let f = fixture(vec![]);
    let mut command = f.command(&program());
    let started = Instant::now();
    let out = command.arg("decide").output().unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    let stdout = text(&out.stdout);
    assert!(
        stdout.starts_with("no harness: no model is configured"),
        "{stdout}"
    );
    assert!(
        stdout.ends_with("answer stop agent=false step 1\n"),
        "{stdout}"
    );
    assert!(f.provider.requests().is_empty());
}

#[test]
fn with_no_harness_binary_the_attach_says_where_it_looked() {
    let f = fixture(vec![]);
    let out = f
        .command(&program())
        .env("ABAI_HARNESS_BIN", f.dir.join("nowhere"))
        .arg("decide")
        .output()
        .unwrap();
    let stdout = text(&out.stdout);
    assert!(
        stdout.starts_with("no harness: the harness binary ABAI_HARNESS_BIN names is not a file"),
        "{stdout}"
    );
    assert!(
        stdout.ends_with("answer stop agent=false step 1\n"),
        "{stdout}"
    );
}

/// A program running in `wait` form, told what to do by lines.
struct Waiting {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    pid: String,
}

impl Waiting {
    fn start(f: &Fixture) -> Self {
        let mut child = f
            .command(&program())
            .arg("wait")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        let pid = line.trim().strip_prefix("ready ").unwrap().to_string();
        Self {
            child,
            stdin,
            stdout,
            pid,
        }
    }

    /// Send a line and read the program's next line.
    fn ask(&mut self, line: &str) -> String {
        writeln!(self.stdin, "{line}").unwrap();
        let mut answer = String::new();
        self.stdout.read_line(&mut answer).unwrap();
        answer.trim_end().to_string()
    }

    fn wait_attached(&mut self, wanted: bool) {
        let started = Instant::now();
        while self.ask("attached") != format!("attached {wanted}") {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "attached never became {wanted}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[test]
fn a_harness_from_outside_attaches_is_listed_and_can_be_replaced() {
    let f = fixture(vec![
        tool(
            "t1",
            "abai_call",
            json!({"capability": "peek", "reason": "to see where it runs"}),
        ),
        tool(
            "t2",
            "abai_decide",
            json!({"id": "d1", "answer": "wrap", "reason": "there is room"}),
        ),
        say("Wrapping."),
    ]);
    f.configure();
    let mut program = Waiting::start(&f);

    let list = |f: &Fixture| {
        let out = f.command(Path::new(HARNESS)).arg("list").output().unwrap();
        assert!(out.status.success());
        text(&out.stdout)
    };
    let listed = list(&f);
    assert!(
        listed.contains(&program.pid) && listed.contains("sideprog"),
        "{listed}"
    );
    assert!(listed.contains("none"), "{listed}");

    // by name
    let mut first = f
        .command(Path::new(HARNESS))
        .args(["attach", "sideprog"])
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    program.wait_attached(true);
    assert!(list(&f).contains("attached"));
    assert_eq!(program.ask("decide"), "answer wrap agent=true step 1");
    // the immediate call ran on the stub's receiving thread
    let sent = f.provider.requests();
    assert!(
        sent[1].body.to_string().contains("abai-receive"),
        "{}",
        sent[1].body
    );

    // the harness dies: the program notices and is the plain program
    first.kill().unwrap();
    first.wait().unwrap();
    program.wait_attached(false);
    assert_eq!(program.ask("decide"), "answer stop agent=false step 1");

    // another harness, by pid this time, restores the connection
    let pid = program.pid.clone();
    let second = f
        .command(Path::new(HARNESS))
        .args(["attach", &pid])
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    program.wait_attached(true);

    // the program ends: the harness ends by itself
    drop(program.stdin);
    assert!(program.child.wait().unwrap().success());
    let out = second.wait_with_output().unwrap();
    assert!(out.status.success());
    assert!(
        text(&out.stderr).contains("detached: the program has gone"),
        "{}",
        text(&out.stderr)
    );
}

#[test]
fn the_entry_hands_config_and_the_online_doctor_to_the_harness_binary() {
    let f = fixture(vec![]);
    let out = f
        .command(&program())
        .args(["abai", "config", "set", "provider", "anthropic"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out.stderr));
    let config = std::fs::read_to_string(f.dir.join("h/config.json")).unwrap();
    assert!(config.contains("anthropic"), "{config}");

    // no model is set yet: the online half of doctor says so
    let out = f
        .command(&program())
        .args(["abai", "doctor"])
        .output()
        .unwrap();
    let stdout = text(&out.stdout);
    assert_eq!(out.status.code(), Some(1), "{stdout}");
    assert!(stdout.contains("fail model:"), "{stdout}");
    assert!(stdout.contains("doctor: failed"), "{stdout}");
}

#[test]
fn run_starts_the_program_attached_and_shows_the_agent_its_output_and_exit() {
    let f = fixture(vec![
        // the decision
        tool(
            "t1",
            "abai_decide",
            json!({"id": "d1", "answer": "wrap", "reason": "there is room"}),
        ),
        say("Wrapping."),
        // the exit
        tool("t2", "abai_transcript", json!({})),
        say("It ended."),
    ]);
    f.configure();
    // through the program's own entry: `<prog> abai run -- ARGS`
    let out = f
        .command(&program())
        .args(["abai", "run", "--", "lines"])
        .output()
        .unwrap();
    let (stdout, stderr) = (text(&out.stdout), text(&out.stderr));
    // the program was attached before its own work began, its output
    // went through, and the run ends with the program's own exit code
    assert_eq!(
        stdout, "line one\nanswer wrap agent=true step 1\nline two\n",
        "{stderr}"
    );
    assert!(stderr.contains("a warning"), "{stderr}");
    assert_eq!(out.status.code(), Some(7), "{stderr}");

    let sent = f.provider.requests();
    assert_eq!(sent.len(), 4, "{stderr}");
    // the exit woke the agent
    let exit_wake = sent[2].body.to_string();
    assert!(exit_wake.contains("abai.lifecycle.exited"), "{exit_wake}");
    assert!(exit_wake.contains(r#"\"code\":7"#), "{exit_wake}");
    // and the program's lines are in the transcript it read
    let transcript = sent[3].body.to_string();
    assert!(transcript.contains("abai.io.stdout"), "{transcript}");
    assert!(transcript.contains("line one"), "{transcript}");
    assert!(transcript.contains("abai.io.stderr"), "{transcript}");
    assert!(transcript.contains("a warning"), "{transcript}");
}

#[test]
fn run_without_a_model_runs_the_plain_program() {
    let f = fixture(vec![]);
    let out = f
        .command(Path::new(HARNESS))
        .args(["run", "--"])
        .arg(program())
        .arg("lines")
        .output()
        .unwrap();
    let (stdout, stderr) = (text(&out.stdout), text(&out.stderr));
    assert_eq!(
        stdout, "line one\nanswer stop agent=false step 1\nline two\n",
        "{stderr}"
    );
    assert!(
        stderr.contains("the program runs without its agent: no model is configured"),
        "{stderr}"
    );
    assert_eq!(out.status.code(), Some(7));
}

#[test]
fn run_of_what_is_no_abaigram_still_runs_it() {
    let f = fixture(vec![]);
    f.configure();
    let out = f
        .command(Path::new(HARNESS))
        .args(["run", "--", "/bin/sh", "-c", "echo plain; exit 3"])
        .output()
        .unwrap();
    assert_eq!(text(&out.stdout), "plain\n");
    assert!(
        text(&out.stderr).contains("the program runs without its agent"),
        "{}",
        text(&out.stderr)
    );
    assert_eq!(out.status.code(), Some(3));

    let out = f
        .command(Path::new(HARNESS))
        .args(["run", "--"])
        .arg(f.dir.join("no-such-program"))
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(text(&out.stderr).contains("could not be started"));
}

#[test]
fn the_agent_restarts_and_stops_the_program_it_was_launched_with() {
    let f = fixture(vec![
        // the first program says it is ready
        tool(
            "t1",
            "abai_lifecycle",
            json!({"op": "restart", "reason": "to see it start again"}),
        ),
        say("Restarted."),
        // the second program says it is ready
        tool(
            "t2",
            "abai_lifecycle",
            json!({"op": "stop", "reason": "seen enough"}),
        ),
        say("Stopped."),
        // its exit
        say("Done."),
    ]);
    f.configure();
    let out = f
        .command(Path::new(HARNESS))
        .args(["run", "--auto", "--"])
        .arg(program())
        .arg("loop")
        .output()
        .unwrap();
    let (stdout, stderr) = (text(&out.stdout), text(&out.stderr));
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines.len(), 4, "{stdout}\n{stderr}");
    assert!(lines[0].starts_with("started "), "{stdout}");
    assert_eq!(lines[1], "stopping");
    assert!(lines[2].starts_with("started "), "{stdout}");
    assert_eq!(lines[3], "stopping");
    // two processes
    assert_ne!(lines[0], lines[2]);
    // the launcher stopped the program: that is not the program's failure
    assert_eq!(out.status.code(), Some(0), "{stderr}");
    assert_eq!(f.audit(), ["lifecycle restart ok", "lifecycle stop ok"]);
    assert_eq!(f.provider.requests().len(), 5, "{stderr}");
}

/// Read from a child's pipe on a thread, so a test can wait for output
/// with a limit.
fn reading(pipe: impl Read + Send + 'static) -> std::sync::mpsc::Receiver<u8> {
    let (send, bytes) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for byte in BufReader::new(pipe).bytes().map_while(Result::ok) {
            if send.send(byte).is_err() {
                break;
            }
        }
    });
    bytes
}

fn read_until(bytes: &std::sync::mpsc::Receiver<u8>, wanted: &str) -> String {
    let mut seen = Vec::new();
    while !String::from_utf8_lossy(&seen).contains(wanted) {
        match bytes.recv_timeout(Duration::from_secs(10)) {
            Ok(byte) => seen.push(byte),
            Err(_) => panic!(
                "{wanted:?} never came; got {:?}",
                String::from_utf8_lossy(&seen)
            ),
        }
    }
    String::from_utf8_lossy(&seen).into_owned()
}

#[test]
fn a_launched_programs_prompt_reaches_the_terminal_before_its_newline() {
    let f = fixture(vec![say("It ended.")]);
    f.configure();
    let mut child = f
        .command(Path::new(HARNESS))
        .args(["run", "--"])
        .arg(program())
        .arg("prompt")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let out = reading(child.stdout.take().unwrap());
    // the prompt has no newline, and is seen all the same
    assert_eq!(read_until(&out, "ready? "), "ready? ");
    // with no user at the harness's terminal, the program reads it
    writeln!(child.stdin.take().unwrap(), "yes").unwrap();
    assert_eq!(read_until(&out, "got yes\n"), "got yes\n");
    assert!(child.wait().unwrap().success());
}

#[test]
fn a_harness_told_to_end_stops_its_program_first() {
    let f = fixture(vec![say("It is ready.")]);
    f.configure();
    let mut child = f
        .command(Path::new(HARNESS))
        .args(["run", "--"])
        .arg(program())
        .arg("loop")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let out = reading(child.stdout.take().unwrap());
    read_until(&out, "started ");
    read_until(&out, "\n");
    // the signal goes to the one process this test started, by its handle
    // SAFETY: `child` is this test's own child and has not been waited for.
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    // the program's stop handler ran: it was not left to a broken pipe
    read_until(&out, "stopping\n");
    assert!(child.wait().unwrap().success());
    assert_eq!(f.audit(), ["lifecycle stop ok"]);
}

#[test]
fn a_harness_told_to_end_does_not_wait_for_the_models_answer() {
    let f = fixture(vec![say("It is ready.")]);
    f.provider.set_delay(Duration::from_secs(20));
    f.configure();
    let mut child = f
        .command(Path::new(HARNESS))
        .args(["run", "--"])
        .arg(program())
        .arg("loop")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let out = reading(child.stdout.take().unwrap());
    read_until(&out, "started ");
    // the agent's request is with the provider, which will not answer soon
    let asked = Instant::now();
    while f.provider.requests().is_empty() {
        assert!(asked.elapsed() < Duration::from_secs(10), "no request came");
        std::thread::sleep(Duration::from_millis(5));
    }
    let told = Instant::now();
    // SAFETY: `child` is this test's own child and has not been waited for.
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    read_until(&out, "stopping\n");
    assert!(child.wait().unwrap().success());
    assert!(
        told.elapsed() < Duration::from_secs(5),
        "{:?}",
        told.elapsed()
    );
    assert_eq!(f.audit(), ["lifecycle stop ok"]);
}

#[test]
fn a_decision_cut_off_by_the_end_of_the_harness_is_not_audited_as_the_agents_choice() {
    let f = fixture(vec![say("Let me think.")]);
    f.provider.set_delay(Duration::from_secs(20));
    f.configure();
    let mut child = f
        .command(Path::new(HARNESS))
        .args(["run", "--"])
        .arg(program())
        .arg("lines")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let out = reading(child.stdout.take().unwrap());
    // the program is at its decision, and the agent's request is out
    let asked = Instant::now();
    while f.provider.requests().is_empty() {
        assert!(asked.elapsed() < Duration::from_secs(10), "no request came");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        f.provider.requests()[0]
            .body
            .to_string()
            .contains("asks the decision on_limit")
    );
    let told = Instant::now();
    // SAFETY: `child` is this test's own child and has not been waited for.
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    // the harness ends now, not after the model's answer, and stops the
    // program on its way
    read_until(&out, "stopping\n");
    assert!(
        told.elapsed() < Duration::from_secs(3),
        "{:?}",
        told.elapsed()
    );
    child.wait().unwrap();
    let text = std::fs::read_to_string(f.dir.join("audit.jsonl")).unwrap();
    let decision: Value = text
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|line| line["act"] == "decision")
        .expect("the decision is audited");
    assert_eq!(decision["outcome"], "default", "{decision}");
    assert_eq!(decision["cause"], "detached", "{decision}");
}

#[test]
fn a_harness_that_lost_its_agent_still_stops_its_program_when_told_to_end() {
    // the provider refuses the key: the agent is lost at its first step
    let f = fixture(vec![Answer::status(
        401,
        json!({"error": {"message": "no"}}),
    )]);
    f.configure();
    let mut child = f
        .command(Path::new(HARNESS))
        .args(["run", "--"])
        .arg(program())
        .arg("loop")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let out = reading(child.stdout.take().unwrap());
    read_until(&out, "started ");
    let asked = Instant::now();
    while f.provider.requests().is_empty() {
        assert!(asked.elapsed() < Duration::from_secs(10), "no request came");
        std::thread::sleep(Duration::from_millis(5));
    }
    // time for the answer to be read and the program to be let go
    std::thread::sleep(Duration::from_millis(600));
    // SAFETY: `child` is this test's own child and has not been waited for.
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let told = Instant::now();
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if told.elapsed() > Duration::from_secs(8) {
            // the harness is this test's own child: ended by its handle
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("the harness did not end when told to");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// An MCP client on a child process's stdio.
struct McpClient {
    child: Child,
    to: Option<ChildStdin>,
    from: std::sync::mpsc::Receiver<Value>,
    next: u64,
}

impl McpClient {
    fn start(mut command: Command) -> Self {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let to = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (send, from) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let message: Value = serde_json::from_str(&line).expect("a JSON line");
                if send.send(message).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            to,
            from,
            next: 1,
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        writeln!(
            self.to.as_mut().unwrap(),
            "{}",
            json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
        )
        .unwrap();
        loop {
            let message = self
                .from
                .recv_timeout(Duration::from_secs(10))
                .expect("the server answers");
            if message["id"] == id {
                return message;
            }
        }
    }

    /// A tool's text, and whether it is an error.
    fn tool(&mut self, name: &str, arguments: Value) -> (String, bool) {
        let answer = self.request("tools/call", json!({"name": name, "arguments": arguments}));
        let result = &answer["result"];
        assert!(result.is_object(), "{answer}");
        (
            result["content"][0]["text"].as_str().unwrap().to_string(),
            result["isError"] == true,
        )
    }

    /// The client goes, and the server with it.
    fn close(mut self) -> std::process::ExitStatus {
        self.to = None;
        self.child.wait().unwrap()
    }
}

#[test]
fn the_entrys_mcp_verb_serves_the_program_through_the_harness_binary() {
    // no model is configured: an MCP server needs none
    let f = fixture(vec![]);
    let mut command = f.command(&program());
    command.args(["abai", "mcp"]).stderr(Stdio::null());
    let mut client = McpClient::start(command);
    let hello = client.request("initialize", json!({"protocolVersion": "2025-06-18"}));
    assert_eq!(hello["result"]["serverInfo"]["name"], "abai-harness");
    assert!(
        hello["result"]["instructions"]
            .as_str()
            .unwrap()
            .starts_with("sideprog abai harness (abaigrammar 0.1, sidecar)."),
        "{hello}"
    );
    let (cells, failed) = client.tool("abai_cells", json!({}));
    assert!(!failed, "{cells}");
    assert_eq!(
        serde_json::from_str::<Value>(&cells).unwrap(),
        json!({"count": 0, "step": 1})
    );
    // an immediate call runs on the entry process's receiving thread
    let (peeked, failed) = client.tool(
        "abai_call",
        json!({"capability": "peek", "reason": "to see where it runs"}),
    );
    assert!(!failed, "{peeked}");
    assert!(peeked.contains("abai-receive"), "{peeked}");
    assert!(client.close().success());
    assert!(f.provider.requests().is_empty());
}

#[test]
fn an_mcp_server_attaches_again_when_the_program_comes_back() {
    let f = fixture(vec![]);
    let mut first = Waiting::start(&f);
    let mut command = f.command(Path::new(HARNESS));
    command.args(["mcp", "sideprog"]).stderr(Stdio::null());
    let mut client = McpClient::start(command);
    first.wait_attached(true);
    let (cells, _) = client.tool("abai_cells", json!({}));
    assert!(cells.contains(r#""count":7"#), "{cells}");
    let (already, _) = client.tool("abai_attach", json!({}));
    assert_eq!(already, "already attached to sideprog");

    // the program ends; the server stays, detached
    drop(first.stdin);
    assert!(first.child.wait().unwrap().success());
    let started = Instant::now();
    loop {
        let (status, _) = client.tool("abai_status", json!({}));
        if status.contains(r#""attached":false"#) {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(5), "{status}");
        std::thread::sleep(Duration::from_millis(20));
    }
    let (refused, failed) = client.tool(
        "abai_set",
        json!({"cell": "step", "value": 2, "reason": "to try"}),
    );
    assert!(
        failed && refused.contains("no program is attached"),
        "{refused}"
    );
    let (nobody, failed) = client.tool("abai_attach", json!({}));
    assert!(
        failed && nobody.contains("no running program is sideprog"),
        "{nobody}"
    );

    // the program comes back: the same server serves it
    let mut second = Waiting::start(&f);
    let (attached, failed) = client.tool("abai_attach", json!({}));
    assert_eq!((attached.as_str(), failed), ("attached to sideprog", false));
    second.wait_attached(true);
    let (set, failed) = client.tool(
        "abai_set",
        json!({"cell": "step", "value": 2, "reason": "to try"}),
    );
    assert!(!failed, "{set}");
    let (cells, _) = client.tool("abai_cells", json!({}));
    assert!(cells.contains(r#""step":2"#), "{cells}");
    assert!(client.close().success());
    second.wait_attached(false);
}

#[test]
fn a_harness_process_given_a_network_answers_a_members_message() {
    use abai_harness::net::fake::FakeOverlay;
    use abai_harness::net::{AiipClient, Classified, MessageInput, classify, encode_message};

    let f = fixture(vec![
        tool(
            "t1",
            "abai_send",
            json!({"to": "bravo", "body": "here", "reason": "to answer"}),
        ),
        say("Answered."),
    ]);
    f.configure();
    // two daemons of one network: this run's, and the other member's,
    // which the test speaks through
    let overlay = FakeOverlay::with_ids("net-1", "world");
    std::fs::create_dir_all(f.dir.join("a")).unwrap();
    std::fs::create_dir_all(f.dir.join("b")).unwrap();
    let _alpha = overlay
        .new_member("alpha", &f.dir.join("a/aiipd.sock"))
        .unwrap();
    let bravo = overlay
        .new_member("bravo", &f.dir.join("b/aiipd.sock"))
        .unwrap();
    let bravo = AiipClient::new(bravo.socket_path());

    let mut program = Waiting::start(&f);
    // the environment hands the harness its network: the directory where
    // a daemon already answers, so the binary is named and never run
    let mut harness = f
        .command(Path::new(HARNESS))
        .args(["attach", "sideprog"])
        .env("ABAI_NET_DIR", f.dir.join("a"))
        .env("ABAI_AIIP_BIN", "/usr/bin/true")
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    program.wait_attached(true);

    let asked = encode_message(MessageInput {
        body: "are you there?".to_string(),
        ..Default::default()
    })
    .unwrap();
    bravo.send("world", "alpha", &asked.bytes, None).unwrap();
    let answer = bravo
        .recv("world", Some(8000), None)
        .unwrap()
        .expect("the agent answers");
    let Classified::Envelope(envelope) = classify(&answer.payload) else {
        panic!("an envelope");
    };
    assert_eq!(envelope.body.as_deref(), Some("here"));
    assert_eq!(answer.from.name.as_deref(), Some("alpha"));

    // the model was woken by the message, and offered the network's tools
    let first = f.provider.requests()[0].body.to_string();
    assert!(
        first.contains("abai.net.message from=bravo network=world: are you there?"),
        "{first}"
    );
    assert!(first.contains("abai_peers") && first.contains("abai_messages"));

    drop(program.stdin);
    assert!(program.child.wait().unwrap().success());
    assert!(harness.wait().unwrap().success());
    let audit = std::fs::read_to_string(f.dir.join("audit.jsonl")).unwrap();
    assert_eq!(audit.matches(r#""act":"message""#).count(), 2, "{audit}");
}
