//! Reading the run's mailboxes: one long-poll per membership, each on a
//! thread of its own, for as long as a harness is attached to a program that
//! can record what arrives. aiipd hands each message to exactly one reader
//! and forgets it, so the loop is the owner of what it takes: it gives every
//! message to the handler, and a handler that fails loses only that message,
//! never the loop. A daemon that stops answering is retried with a growing
//! wait (half a second doubling to thirty, with jitter, as aiap's own daemon
//! does) and the transcript hears once when the reading fails and once when
//! it resumes. A membership the daemon no longer holds (410, 404) ends its
//! loop and asks the owner to list memberships again. Known and accepted:
//! `stop` ends the poll in flight, and aiipd pops with a Go select, so a
//! message it dequeued at that very instant is gone; the harness stops the
//! mail only at detach and shutdown.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::client::{AiipClient, AiipMessage};
use super::envelope::random_bytes;
use super::membership::NetworkMembership;

pub const MAIL_BACKOFF_MIN_MS: u64 = 500;
pub const MAIL_BACKOFF_MAX_MS: u64 = 30_000;
pub const MAIL_STOP_TIMEOUT_MS: u64 = 5_000;

/// How often a retry wait looks at the stop flag.
const SLEEP_SLICE: Duration = Duration::from_millis(25);

/// What the handler receives: the message, and the membership whose mailbox it came from.
#[derive(Debug, Clone, PartialEq)]
pub struct MailDelivery {
    pub message: AiipMessage,
    pub membership: NetworkMembership,
}

/// Takes each message; an `Err` (or a panic) loses that message only, and the transcript hears why.
pub type MailHandler = Arc<dyn Fn(MailDelivery) -> Result<(), String> + Send + Sync>;
/// Called after a loop ends because the daemon no longer holds the membership.
pub type OnDropped = Arc<dyn Fn(&NetworkMembership) + Send + Sync>;
/// A line for the harness's transcript.
pub type Note = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone, Default)]
pub struct MailLoopOptions {
    /// One long-poll's wait in milliseconds; default 45 s, the daemon caps a wait at 60 s.
    pub wait_ms: Option<u64>,
    /// How long `stop` waits for a handler still running before it lets go; default 5 s.
    pub stop_timeout_ms: Option<u64>,
    /// The retry wait after a failed read: first and largest, in ms. Default 500 and 30 000.
    pub backoff_min_ms: Option<u64>,
    pub backoff_max_ms: Option<u64>,
    /// Called after a loop ends because the daemon no longer holds the membership.
    pub on_dropped: Option<OnDropped>,
}

impl std::fmt::Debug for MailLoopOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MailLoopOptions")
            .field("wait_ms", &self.wait_ms)
            .field("stop_timeout_ms", &self.stop_timeout_ms)
            .field("backoff_min_ms", &self.backoff_min_ms)
            .field("backoff_max_ms", &self.backoff_max_ms)
            .field("on_dropped", &self.on_dropped.as_ref().map(|_| "(given)"))
            .finish()
    }
}

/// A loop's end, which `stop` waits for.
#[derive(Default)]
struct Done {
    finished: Mutex<bool>,
    signal: Condvar,
}

impl Done {
    fn finish(&self) {
        *self.finished.lock().unwrap_or_else(PoisonError::into_inner) = true;
        self.signal.notify_all();
    }

    /// Waits until the loop ends or the deadline passes; true when it ended.
    fn wait_until(&self, deadline: Instant) -> bool {
        let mut finished = self.finished.lock().unwrap_or_else(PoisonError::into_inner);
        while !*finished {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            finished = self
                .signal
                .wait_timeout(finished, left)
                .map(|(guard, _)| guard)
                .unwrap_or_else(|poisoned| poisoned.into_inner().0);
        }
        true
    }
}

/// Marks the loop done however its thread ends.
struct DoneOnExit(Arc<Done>);

impl Drop for DoneOnExit {
    fn drop(&mut self) {
        self.0.finish();
    }
}

struct Loop {
    id: String,
    stop: Arc<AtomicBool>,
    done: Arc<Done>,
    thread: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct LoopState {
    loops: Vec<Loop>,
    handler: Option<MailHandler>,
}

pub(crate) struct Shared {
    client: AiipClient,
    note: Note,
    options: MailLoopOptions,
    state: Mutex<LoopState>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, LoopState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// When the last owner lets go, every loop is told to end.
impl Drop for Shared {
    fn drop(&mut self) {
        let state = self.state.get_mut().unwrap_or_else(PoisonError::into_inner);
        for running in &state.loops {
            running.stop.store(true, Ordering::SeqCst);
        }
    }
}

/// The mail loops of one daemon's memberships.
pub struct MailLoop {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for MailLoop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MailLoop")
            .field("socket_path", &self.shared.client.socket_path)
            .field("active", &self.active())
            .finish_non_exhaustive()
    }
}

impl MailLoop {
    pub fn new(client: AiipClient, note: Note, options: MailLoopOptions) -> Self {
        Self {
            shared: Arc::new(Shared {
                client,
                note,
                options,
                state: Mutex::new(LoopState::default()),
            }),
        }
    }

    pub(crate) fn downgrade(&self) -> Weak<Shared> {
        Arc::downgrade(&self.shared)
    }

    pub(crate) fn from_shared(shared: Arc<Shared>) -> Self {
        Self { shared }
    }

    /// The network ids being read now.
    pub fn active(&self) -> Vec<String> {
        self.shared
            .lock()
            .loops
            .iter()
            .map(|l| l.id.clone())
            .collect()
    }

    pub fn running(&self) -> bool {
        self.shared.lock().handler.is_some()
    }

    /// Start reading these memberships' mailboxes, handing every message to `handler`. A second start replaces the handler for new loops only.
    pub fn start(&self, handler: MailHandler, memberships: &[NetworkMembership]) {
        self.shared.lock().handler = Some(handler);
        self.sync(memberships);
    }

    /// Follow the membership list: a loop per membership, none for one that is gone. A no-op before `start`.
    pub fn sync(&self, memberships: &[NetworkMembership]) {
        let mut state = self.shared.lock();
        let Some(handler) = state.handler.clone() else {
            return;
        };
        let mut wanted: Vec<NetworkMembership> = Vec::new();
        for m in memberships {
            match wanted.iter_mut().find(|w| w.id == m.id) {
                Some(slot) => *slot = m.clone(),
                None => wanted.push(m.clone()),
            }
        }
        state.loops.retain(|running| {
            let keep = wanted.iter().any(|m| m.id == running.id);
            if !keep {
                running.stop.store(true, Ordering::SeqCst);
            }
            keep
        });
        for membership in wanted {
            if state.loops.iter().any(|l| l.id == membership.id) {
                continue;
            }
            let stop = Arc::new(AtomicBool::new(false));
            let done = Arc::new(Done::default());
            // the loop keeps its handler: a message the daemon has already handed over is delivered even when `stop`
            // clears the current handler meanwhile; the daemon has forgotten it, so nobody else could
            let context = Context {
                client: self.shared.client.clone(),
                note: self.shared.note.clone(),
                options: self.shared.options.clone(),
                shared: Arc::downgrade(&self.shared),
                membership: membership.clone(),
                stop: stop.clone(),
                handler: handler.clone(),
            };
            let exit = DoneOnExit(done.clone());
            let spawned = thread::Builder::new()
                .name("abai-mail".to_string())
                .spawn(move || {
                    let _exit = exit;
                    context.run();
                });
            match spawned {
                Ok(thread) => state.loops.push(Loop {
                    id: membership.id.clone(),
                    stop,
                    done,
                    thread: Some(thread),
                }),
                Err(error) => (self.shared.note)(&format!(
                    "# network: the mailbox of {} cannot be read: {error}",
                    membership.network
                )),
            }
        }
    }

    /// End every loop, ending the poll in flight, and wait for them to
    /// return: a handler still running gets `stop_timeout_ms` to finish,
    /// then the stop goes on without it. Idempotent. Called from inside a
    /// handler, it does not wait for that handler's own loop.
    pub fn stop(&self) {
        let loops = {
            let mut state = self.shared.lock();
            state.handler = None;
            std::mem::take(&mut state.loops)
        };
        for running in &loops {
            running.stop.store(true, Ordering::SeqCst);
        }
        let limit = self
            .shared
            .options
            .stop_timeout_ms
            .unwrap_or(MAIL_STOP_TIMEOUT_MS);
        let deadline = Instant::now() + Duration::from_millis(limit);
        let me = thread::current().id();
        for mut running in loops {
            let Some(thread) = running.thread.take() else {
                continue;
            };
            if thread.thread().id() == me {
                continue;
            }
            if running.done.wait_until(deadline) {
                let _ = thread.join();
            }
        }
    }
}

/// What one loop's thread holds.
struct Context {
    client: AiipClient,
    note: Note,
    options: MailLoopOptions,
    shared: Weak<Shared>,
    membership: NetworkMembership,
    stop: Arc<AtomicBool>,
    handler: MailHandler,
}

impl Context {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn run(&self) {
        let m = &self.membership;
        let min = self.options.backoff_min_ms.unwrap_or(MAIL_BACKOFF_MIN_MS);
        let max = self.options.backoff_max_ms.unwrap_or(MAIL_BACKOFF_MAX_MS);
        let mut backoff = 0;
        let mut failing: Option<String> = None;
        while !self.stopped() {
            let message = match self
                .client
                .recv(&m.id, self.options.wait_ms, Some(&self.stop))
            {
                Ok(message) => message,
                Err(error) => {
                    if self.stopped() {
                        return;
                    }
                    if error.status == 410 || error.status == 404 {
                        (self.note)(&format!(
                            "# network: no longer a member of {} ({}); its mailbox is not read",
                            m.network, error.message
                        ));
                        if let Some(shared) = self.shared.upgrade() {
                            shared
                                .lock()
                                .loops
                                .retain(|l| !Arc::ptr_eq(&l.stop, &self.stop));
                        }
                        if let Some(on_dropped) = &self.options.on_dropped {
                            on_dropped(m);
                        }
                        return;
                    }
                    if failing.is_none() {
                        (self.note)(&format!(
                            "# network: the mailbox of {} cannot be read: {}",
                            m.network, error.message
                        ));
                        failing = Some(error.message);
                    }
                    backoff = if backoff == 0 {
                        min
                    } else {
                        (backoff * 2).min(max)
                    };
                    self.sleep(jitter(backoff));
                    continue;
                }
            };
            if failing.take().is_some() {
                (self.note)(&format!(
                    "# network: the mailbox of {} is read again",
                    m.network
                ));
            }
            backoff = 0;
            let Some(message) = message else {
                continue;
            };
            let from = message.from.addr.clone();
            let delivery = MailDelivery {
                message,
                membership: m.clone(),
            };
            let outcome = catch_unwind(AssertUnwindSafe(|| (self.handler)(delivery)))
                .unwrap_or_else(|_| Err("the handler panicked".to_string()));
            if let Err(error) = outcome {
                (self.note)(&format!(
                    "# network: a message from {from} on {} was not handled: {error}",
                    m.network
                ));
            }
        }
    }

    /// Sleeps `ms`, or less when the stop flag is raised.
    fn sleep(&self, ms: u64) {
        let deadline = Instant::now() + Duration::from_millis(ms);
        while !self.stopped() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            thread::sleep(left.min(SLEEP_SLICE));
        }
    }
}

/// `ms` scaled by a random factor in [0.75, 1.25).
fn jitter(ms: u64) -> u64 {
    let bytes = random_bytes(4);
    let r = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    let unit = f64::from(r) / (f64::from(u32::MAX) + 1.0);
    (ms as f64 * (0.75 + unit * 0.5)).round() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::daemon::{AiipDaemon, DaemonStop};
    use crate::net::fake::{FakeAiipd, FakeOverlay, Fault, Scratch};
    use crate::net::membership::{RunNetwork, RunNetworkOptions};
    use std::sync::OnceLock;
    use std::sync::atomic::AtomicU64;

    fn wait_for(cond: impl Fn() -> bool, ms: u64) {
        let deadline = Instant::now() + Duration::from_millis(ms);
        while !cond() {
            assert!(
                Instant::now() < deadline,
                "condition not met within {ms} ms"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn fast() -> MailLoopOptions {
        MailLoopOptions {
            wait_ms: Some(200),
            backoff_min_ms: Some(10),
            backoff_max_ms: Some(50),
            ..MailLoopOptions::default()
        }
    }

    /// An overlay with two members, alpha the authority and beta, each on its own socket.
    struct Two {
        _scratch: Scratch,
        alpha_fake: FakeAiipd,
        beta_fake: FakeAiipd,
        alpha: AiipClient,
        beta: AiipClient,
        net: String,
        alpha_addr: String,
        beta_addr: String,
        beta_membership: NetworkMembership,
    }

    impl Drop for Two {
        fn drop(&mut self) {
            self.alpha_fake.stop();
            self.beta_fake.stop();
        }
    }

    fn two_members() -> Two {
        let scratch = Scratch::new();
        let overlay = FakeOverlay::new();
        let alpha_fake = overlay
            .new_member("alpha", &scratch.path().join("alpha.sock"))
            .unwrap();
        let beta_fake = overlay
            .new_member("beta", &scratch.path().join("beta.sock"))
            .unwrap();
        let beta_addr = beta_fake.addr();
        Two {
            alpha: AiipClient::new(alpha_fake.socket_path()),
            beta: AiipClient::new(beta_fake.socket_path()),
            alpha_addr: alpha_fake.addr(),
            net: overlay.network_id(),
            beta_membership: NetworkMembership {
                network: overlay.network_name(),
                id: overlay.network_id(),
                member: "beta".to_string(),
                addr: beta_addr.clone(),
                authority: false,
                peers: 1,
            },
            beta_addr,
            alpha_fake,
            beta_fake,
            _scratch: scratch,
        }
    }

    type Notes = Arc<Mutex<Vec<String>>>;
    type Got = Arc<Mutex<Vec<MailDelivery>>>;

    fn new_loop(client: &AiipClient, options: MailLoopOptions) -> (MailLoop, Notes) {
        let notes: Notes = Arc::default();
        let sink = notes.clone();
        let mail = MailLoop::new(
            client.clone(),
            Arc::new(move |t: &str| sink.lock().unwrap().push(t.to_string())),
            options,
        );
        (mail, notes)
    }

    fn collector() -> (MailHandler, Got) {
        let got: Got = Arc::default();
        let sink = got.clone();
        let handler: MailHandler = Arc::new(move |d| {
            sink.lock().unwrap().push(d);
            Ok(())
        });
        (handler, got)
    }

    fn text(bytes: &[u8]) -> String {
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    fn count(notes: &Notes, needle: &str) -> usize {
        notes
            .lock()
            .unwrap()
            .iter()
            .filter(|n| n.contains(needle))
            .count()
    }

    #[test]
    fn a_message_reaches_the_handler_once_with_its_membership() {
        let t = two_members();
        let (mail, _) = new_loop(&t.beta, fast());
        let (handler, got) = collector();
        mail.start(handler, std::slice::from_ref(&t.beta_membership));
        t.alpha.send(&t.net, "beta", b"hi", None).unwrap();
        wait_for(|| got.lock().unwrap().len() == 1, 3000);
        {
            let got = got.lock().unwrap();
            assert_eq!(text(&got[0].message.payload), "hi");
            assert_eq!(got[0].message.from.addr, t.alpha_addr);
            assert_eq!(got[0].membership.member, "beta");
        }
        assert_eq!(mail.active(), vec![t.net.clone()]);
        assert!(mail.running());
        mail.stop();
        assert!(mail.active().is_empty());
        assert!(!mail.running());
        thread::sleep(Duration::from_millis(300));
        assert_eq!(got.lock().unwrap().len(), 1);
    }

    #[test]
    fn sync_follows_the_membership_list() {
        let t = two_members();
        let (mail, _) = new_loop(&t.beta, fast());
        let (handler, got) = collector();
        mail.start(handler, &[]);
        assert!(mail.active().is_empty());
        mail.sync(std::slice::from_ref(&t.beta_membership));
        assert_eq!(mail.active(), vec![t.net.clone()]);
        mail.sync(&[]);
        assert!(mail.active().is_empty());
        t.alpha.send(&t.net, "beta", b"hi", None).unwrap();
        thread::sleep(Duration::from_millis(300));
        assert_eq!(t.beta_fake.mailbox_len(), 1);
        assert!(got.lock().unwrap().is_empty());
        mail.sync(std::slice::from_ref(&t.beta_membership));
        wait_for(|| got.lock().unwrap().len() == 1, 3000);
        assert_eq!(t.beta_fake.mailbox_len(), 0);
        mail.stop();
    }

    #[test]
    fn a_handler_that_fails_loses_only_that_message() {
        let t = two_members();
        let (mail, notes) = new_loop(&t.beta, fast());
        let got: Got = Arc::default();
        let calls = Arc::new(AtomicU64::new(0));
        let (sink, counter) = (got.clone(), calls.clone());
        mail.start(
            Arc::new(move |d| {
                if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Err("no thanks".to_string());
                }
                sink.lock().unwrap().push(d);
                Ok(())
            }),
            std::slice::from_ref(&t.beta_membership),
        );
        t.alpha.send(&t.net, "beta", b"first", None).unwrap();
        t.alpha.send(&t.net, "beta", b"second", None).unwrap();
        wait_for(|| got.lock().unwrap().len() == 1, 3000);
        assert_eq!(text(&got.lock().unwrap()[0].message.payload), "second");
        assert_eq!(count(&notes, "was not handled: no thanks"), 1);
        mail.stop();
    }

    #[test]
    fn a_handler_that_panics_loses_only_that_message() {
        let t = two_members();
        let (mail, notes) = new_loop(&t.beta, fast());
        let got: Got = Arc::default();
        let calls = Arc::new(AtomicU64::new(0));
        let (sink, counter) = (got.clone(), calls.clone());
        mail.start(
            Arc::new(move |d| {
                if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                    panic!("boom");
                }
                sink.lock().unwrap().push(d);
                Ok(())
            }),
            std::slice::from_ref(&t.beta_membership),
        );
        t.alpha.send(&t.net, "beta", b"first", None).unwrap();
        t.alpha.send(&t.net, "beta", b"second", None).unwrap();
        wait_for(|| got.lock().unwrap().len() == 1, 3000);
        assert_eq!(count(&notes, "was not handled: the handler panicked"), 1);
        mail.stop();
    }

    #[test]
    fn a_daemon_that_stops_answering_is_retried_and_the_transcript_hears_once_each_way() {
        let t = two_members();
        t.beta_fake.set_fault(Some(Fault::new(500, "boom")));
        let (mail, notes) = new_loop(&t.beta, fast());
        let (handler, got) = collector();
        mail.start(handler, std::slice::from_ref(&t.beta_membership));
        thread::sleep(Duration::from_millis(150));
        assert_eq!(count(&notes, "cannot be read: boom"), 1);
        t.beta_fake.set_fault(None);
        t.alpha.send(&t.net, "beta", b"hi", None).unwrap();
        wait_for(|| got.lock().unwrap().len() == 1, 3000);
        assert_eq!(count(&notes, "is read again"), 1);
        mail.stop();
    }

    #[test]
    fn a_membership_the_daemon_no_longer_holds_ends_its_loop_and_reports_it() {
        let t = two_members();
        let dropped: Arc<Mutex<Vec<NetworkMembership>>> = Arc::default();
        let sink = dropped.clone();
        let options = MailLoopOptions {
            on_dropped: Some(Arc::new(move |m: &NetworkMembership| {
                sink.lock().unwrap().push(m.clone())
            })),
            ..fast()
        };
        let (mail, notes) = new_loop(&t.beta, options);
        mail.start(
            Arc::new(|_| Ok(())),
            std::slice::from_ref(&t.beta_membership),
        );
        thread::sleep(Duration::from_millis(30));
        t.beta.leave(&t.net).unwrap();
        wait_for(|| mail.active().is_empty(), 3000);
        wait_for(|| dropped.lock().unwrap().len() == 1, 3000);
        assert_eq!(dropped.lock().unwrap()[0].member, "beta");
        assert_eq!(count(&notes, "no longer a member of"), 1);
        assert!(mail.running());
        mail.stop();
    }

    #[test]
    fn stop_ends_a_poll_in_flight_at_once() {
        let t = two_members();
        let options = MailLoopOptions {
            wait_ms: Some(5000),
            ..fast()
        };
        let (mail, _) = new_loop(&t.beta, options);
        mail.start(
            Arc::new(|_| Ok(())),
            std::slice::from_ref(&t.beta_membership),
        );
        thread::sleep(Duration::from_millis(30));
        let started = Instant::now();
        mail.stop();
        assert!(started.elapsed() < Duration::from_millis(1000));
    }

    #[test]
    fn stop_is_idempotent_and_a_stopped_loop_ignores_sync() {
        let t = two_members();
        let (mail, _) = new_loop(&t.beta, fast());
        mail.start(
            Arc::new(|_| Ok(())),
            std::slice::from_ref(&t.beta_membership),
        );
        mail.stop();
        mail.stop();
        mail.sync(std::slice::from_ref(&t.beta_membership));
        assert!(mail.active().is_empty());
    }

    #[test]
    fn a_stop_from_inside_the_handler_delivers_nothing_more_and_loses_nothing() {
        let t = two_members();
        let (mail, _) = new_loop(&t.beta, fast());
        let mail = Arc::new(mail);
        // two messages wait before the loop reads; the handler stops the loop on the first
        t.alpha.send(&t.net, "beta", b"one", None).unwrap();
        t.alpha.send(&t.net, "beta", b"two", None).unwrap();
        let got: Got = Arc::default();
        let slot: Arc<OnceLock<Weak<MailLoop>>> = Arc::default();
        let (sink, inner) = (got.clone(), slot.clone());
        slot.set(Arc::downgrade(&mail)).unwrap();
        mail.start(
            Arc::new(move |d| {
                sink.lock().unwrap().push(d);
                if let Some(mail) = inner.get().and_then(Weak::upgrade) {
                    mail.stop();
                }
                Ok(())
            }),
            std::slice::from_ref(&t.beta_membership),
        );
        wait_for(|| got.lock().unwrap().len() == 1 && !mail.running(), 3000);
        thread::sleep(Duration::from_millis(300));
        let bodies: Vec<String> = got
            .lock()
            .unwrap()
            .iter()
            .map(|d| text(&d.message.payload))
            .collect();
        assert_eq!(bodies, vec!["one".to_string()]);
        // the second message is still the daemon's: not taken, so not lost
        assert_eq!(t.beta_fake.mailbox_len(), 1);
    }

    #[test]
    fn stop_lets_go_of_a_handler_that_never_settles_after_its_limit() {
        let t = two_members();
        let options = MailLoopOptions {
            stop_timeout_ms: Some(100),
            ..fast()
        };
        let (mail, _) = new_loop(&t.beta, options);
        let entered = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        let (flag, gate) = (entered.clone(), release.clone());
        mail.start(
            Arc::new(move |_| {
                flag.store(true, Ordering::SeqCst);
                while !gate.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(10));
                }
                Ok(())
            }),
            std::slice::from_ref(&t.beta_membership),
        );
        t.alpha.send(&t.net, "beta", b"hi", None).unwrap();
        wait_for(|| entered.load(Ordering::SeqCst), 3000);
        let started = Instant::now();
        mail.stop();
        assert!(started.elapsed() < Duration::from_millis(1000));
        release.store(true, Ordering::SeqCst);
    }

    /// A run's network over beta's fake, with a stop counter and a clock the test moves.
    struct Run {
        t: Two,
        network: RunNetwork,
        stopped: Arc<AtomicU64>,
        clock: Arc<AtomicU64>,
    }

    fn run_network(owned: bool) -> Run {
        let t = two_members();
        let stopped = Arc::new(AtomicU64::new(0));
        let counter = stopped.clone();
        let daemon = AiipDaemon {
            dir: "(fake)".into(),
            socket_path: t.beta_fake.socket_path(),
            client: t.beta.clone(),
            version: "aiip-m8".to_string(),
            version_skew: None,
            spawned: true,
            pid: Some(1),
            stopper: DaemonStop::new(Box::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            })),
        };
        let clock = Arc::new(AtomicU64::new(0));
        let base = Instant::now();
        let ticks = clock.clone();
        let memberships = t.beta.networks().unwrap();
        let network = RunNetwork::new(
            daemon,
            memberships,
            owned,
            Arc::new(|_: &str| {}),
            RunNetworkOptions {
                mail: fast(),
                now: Some(Arc::new(move || {
                    base + Duration::from_millis(ticks.load(Ordering::SeqCst))
                })),
            },
        );
        Run {
            t,
            network,
            stopped,
            clock,
        }
    }

    #[test]
    fn start_mail_reads_and_stop_stops_the_mail_then_the_owned_daemon() {
        let run = run_network(true);
        let (handler, got) = collector();
        run.network.start_mail(handler);
        run.t.alpha.send(&run.t.net, "beta", b"hi", None).unwrap();
        wait_for(|| got.lock().unwrap().len() == 1, 3000);
        run.network.stop();
        assert!(!run.network.mail.running());
        assert_eq!(run.stopped.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_shared_directorys_daemon_is_left_running() {
        let run = run_network(false);
        let (handler, got) = collector();
        run.network.start_mail(handler);
        run.t.alpha.send(&run.t.net, "beta", b"hi", None).unwrap();
        wait_for(|| got.lock().unwrap().len() == 1, 3000);
        run.network.stop();
        assert_eq!(run.stopped.load(Ordering::SeqCst), 0);
        assert!(!run.network.mail.running());
    }

    #[test]
    fn name_for_names_a_sender_from_the_roster_by_address() {
        let run = run_network(true);
        let (t, network) = (&run.t, &run.network);
        assert_eq!(
            network.name_for(&t.net, &t.alpha_addr).as_deref(),
            Some("alpha")
        );
        assert_eq!(
            network.name_for(&t.net, &t.beta_addr).as_deref(),
            Some("beta")
        );
        assert_eq!(network.name_for(&t.net, "100.107.9.9"), None);
        t.beta_fake.set_fault(Some(Fault::new(500, "down")));
        assert_eq!(
            network.name_for(&t.net, &t.alpha_addr).as_deref(),
            Some("alpha")
        );
        assert_eq!(network.name_for(&t.net, "100.107.9.8"), None);
        run.clock.fetch_add(20_000, Ordering::SeqCst);
        t.beta_fake.set_fault(None);
        let gamma = t.alpha.invite(&t.net, "gamma").unwrap();
        assert_eq!(
            network.name_for(&t.net, &gamma.addr).as_deref(),
            Some("gamma")
        );
    }

    #[test]
    fn refresh_keeps_the_loops_in_step_with_the_daemons_list() {
        let run = run_network(true);
        run.network.start_mail(Arc::new(|_| Ok(())));
        run.t.beta.leave(&run.t.net).unwrap();
        wait_for(|| run.network.mail.active().is_empty(), 3000);
        assert_eq!(run.network.refresh().unwrap(), vec![]);
        run.network.stop();
    }
}
