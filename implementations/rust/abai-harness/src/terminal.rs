//! The default user channel: the terminal (contract section 4.5).
//!
//! Input is read one line at a time, and only when the harness has asked
//! for one, so a program that reads its own stdin is not robbed of it.
//! Every line is stamped with when it arrived: a `confirm` takes only an
//! answer typed after its question was shown, never one typed ahead.

use std::io::{BufRead, Write};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use crate::core::UserChannel;

/// A line and when it arrived; None is the end of the input.
type Stamped = (Instant, Option<String>);

/// Lines read on request by a thread of their own.
struct Lines {
    want: Sender<()>,
    got: Receiver<Stamped>,
    /// Whether a line has been asked for and has not arrived yet.
    waiting: bool,
    ended: bool,
}

impl Lines {
    fn new(mut input: impl BufRead + Send + 'static) -> Self {
        let (want, wanted) = channel::<()>();
        let (give, got) = channel::<Stamped>();
        std::thread::spawn(move || {
            while wanted.recv().is_ok() {
                let mut line = String::new();
                let read = input.read_line(&mut line);
                let text = match read {
                    Ok(bytes) if bytes > 0 => Some(line.trim_end_matches(['\n', '\r']).to_string()),
                    _ => None,
                };
                let ended = text.is_none();
                if give.send((Instant::now(), text)).is_err() || ended {
                    break;
                }
            }
        });
        Self {
            want,
            got,
            waiting: false,
            ended: false,
        }
    }

    /// The next line that arrived at or after `since`, waiting up to
    /// `limit` for it. Ok(None) is the end of the input; Err is no line
    /// in time.
    fn next(
        &mut self,
        since: Option<Instant>,
        limit: Option<Duration>,
    ) -> Result<Option<String>, ()> {
        let deadline = limit.map(|limit| Instant::now() + limit);
        loop {
            if self.ended {
                return Ok(None);
            }
            if !self.waiting {
                if self.want.send(()).is_err() {
                    self.ended = true;
                    return Ok(None);
                }
                self.waiting = true;
            }
            let arrived = match deadline {
                None => self.got.recv().map_err(|_| RecvTimeoutError::Disconnected),
                Some(deadline) => self
                    .got
                    .recv_timeout(deadline.saturating_duration_since(Instant::now())),
            };
            match arrived {
                Err(RecvTimeoutError::Timeout) => return Err(()),
                Err(RecvTimeoutError::Disconnected) | Ok((_, None)) => {
                    self.ended = true;
                    return Ok(None);
                }
                Ok((at, Some(line))) => {
                    self.waiting = false;
                    // a line from before the question is not its answer
                    if since.is_none_or(|since| at >= since) {
                        return Ok(Some(line));
                    }
                }
            }
        }
    }
}

/// The process's stdin, read by one thread however many terminals there
/// have been: a harness that detaches and attaches again keeps its place
/// in the input.
fn stdin_lines() -> Arc<Mutex<Lines>> {
    static STDIN: OnceLock<Arc<Mutex<Lines>>> = OnceLock::new();
    STDIN
        .get_or_init(|| {
            Arc::new(Mutex::new(Lines::new(std::io::BufReader::new(
                std::io::stdin(),
            ))))
        })
        .clone()
}

/// A user at a terminal.
pub struct Terminal {
    lines: Arc<Mutex<Lines>>,
    out: Box<dyn Write + Send>,
}

impl std::fmt::Debug for Terminal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Terminal").finish_non_exhaustive()
    }
}

impl Terminal {
    /// A channel over any input and output.
    pub fn new(input: impl BufRead + Send + 'static, out: impl Write + Send + 'static) -> Self {
        Self {
            lines: Arc::new(Mutex::new(Lines::new(input))),
            out: Box::new(out),
        }
    }

    /// The process's own terminal: lines from stdin, text to stdout.
    pub fn stdio() -> Self {
        Self {
            lines: stdin_lines(),
            out: Box::new(std::io::stdout()),
        }
    }

    fn write(&mut self, text: &str) {
        let _ = self.out.write_all(text.as_bytes());
        let _ = self.out.flush();
    }

    fn next(
        &mut self,
        since: Option<Instant>,
        limit: Option<Duration>,
    ) -> Result<Option<String>, ()> {
        self.lines
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .next(since, limit)
    }
}

impl UserChannel for Terminal {
    fn say(&mut self, text: &str) {
        self.write(&format!("{}\n", text.trim_end()));
    }

    fn ask(&mut self, prompt: &str) -> Option<String> {
        self.write(prompt);
        self.next(None, None).unwrap_or(None)
    }

    fn confirm(&mut self, question: &str, timeout: Duration) -> bool {
        let asked = Instant::now();
        self.write(&format!("{question} [y/N] "));
        match self.next(Some(asked), Some(timeout)) {
            Ok(Some(line)) => matches!(line.trim(), "y" | "Y" | "yes" | "Yes" | "YES"),
            Ok(None) => false,
            Err(()) => {
                self.write("\n(no answer in time: denied)\n");
                false
            }
        }
    }

    fn try_line(&mut self, wait: Duration) -> Option<Option<String>> {
        self.next(None, Some(wait)).ok()
    }

    fn prompt(&mut self, prompt: &str) {
        self.write(prompt);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::mpsc::sync_channel;

    /// An output a test can read back.
    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Shared {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    /// An input a test types into, a line at a time.
    struct Typed(Receiver<String>);

    impl std::io::Read for Typed {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            match self.0.recv() {
                Ok(line) => {
                    buffer[..line.len()].copy_from_slice(line.as_bytes());
                    Ok(line.len())
                }
                Err(_) => Ok(0),
            }
        }
    }

    fn typed() -> (std::sync::mpsc::SyncSender<String>, Terminal, Shared) {
        let (keys, input) = sync_channel::<String>(8);
        let out = Shared::default();
        let terminal = Terminal::new(std::io::BufReader::new(Typed(input)), out.clone());
        (keys, terminal, out)
    }

    #[test]
    fn lines_are_asked_for_until_the_input_ends() {
        let out = Shared::default();
        let mut terminal = Terminal::new(Cursor::new("first\r\nsecond\n"), out.clone());
        terminal.say("hello  \n");
        assert_eq!(terminal.ask("> ").as_deref(), Some("first"));
        assert_eq!(terminal.ask("> ").as_deref(), Some("second"));
        assert_eq!(terminal.ask("> "), None);
        assert_eq!(terminal.ask("> "), None);
        assert_eq!(out.text(), "hello\n> > > > ");
    }

    #[test]
    fn a_confirm_is_yes_only_when_the_user_says_so() {
        let (keys, mut terminal, out) = typed();
        let wait = Duration::from_secs(5);
        for (answer, expected) in [
            ("y\n", true),
            ("yes\n", true),
            ("no\n", false),
            ("\n", false),
            ("maybe\n", false),
        ] {
            let typist = keys.clone();
            let typing = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(30));
                typist.send(answer.to_string()).unwrap();
            });
            assert_eq!(terminal.confirm("Do it?", wait), expected, "{answer:?}");
            typing.join().unwrap();
        }
        drop(keys);
        // the input has ended
        assert!(!terminal.confirm("Do it?", wait));
        assert!(out.text().starts_with("Do it? [y/N] "));
    }

    #[test]
    fn a_confirm_nobody_answers_is_denied_when_its_time_is_up() {
        let (keys, mut terminal, out) = typed();
        let started = Instant::now();
        assert!(!terminal.confirm("Do it?", Duration::from_millis(50)));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(out.text().contains("no answer in time"));
        drop(keys);
    }

    #[test]
    fn a_line_typed_before_the_question_does_not_answer_it() {
        let (keys, mut terminal, _out) = typed();
        // a line asked for and typed, then not read: it sits in the queue
        assert!(!terminal.confirm("First?", Duration::from_millis(30)));
        keys.send("y\n".to_string()).unwrap();
        std::thread::sleep(Duration::from_millis(60));
        // the late y is not the answer to the next question
        let typist = keys.clone();
        let typing = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            typist.send("no\n".to_string()).unwrap();
        });
        assert!(!terminal.confirm("Second?", Duration::from_secs(5)));
        typing.join().unwrap();

        // and a y typed after the question is
        let typist = keys.clone();
        let typing = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            typist.send("y\n".to_string()).unwrap();
        });
        assert!(terminal.confirm("Third?", Duration::from_secs(5)));
        typing.join().unwrap();
    }

    #[test]
    fn nothing_is_read_until_it_is_asked_for() {
        let (keys, mut terminal, _out) = typed();
        keys.send("for the program\n".to_string()).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        // the reader has not taken the line: it is still there to be asked for
        assert_eq!(terminal.ask("> ").as_deref(), Some("for the program"));
    }
}
