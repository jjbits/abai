//! The harness on a thread of its own inside the program: thread mode
//! (contract section 6.2).
//!
//! The harness thread owns the core and the front. It reads the region
//! directly, is woken by the program through the region's waker, and
//! polls watched cells and timers while it is parked. A program thread
//! at a touchpoint hands the touchpoint over and blocks, alone, until it
//! is served; while it waits it serves what the agent queued for a
//! safepoint.

use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{RecvTimeoutError, sync_channel};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::thread::Thread;
use std::time::{Duration, Instant};

use abai_stub::link::{Harness, Outcome, StubCore, Touch};
use abai_stub::region::calls::{self, Which};
use abai_stub::region::{Wake as RegionWake, header};

use crate::core::Core;
use crate::embedded::{
    Front, RunEnd, Step, Typed, Wake, end_touchpoint, no_session, run_front, serve_touch, typed,
};
use crate::model::Cancel;

/// How often a program thread waiting at a touchpoint looks for work
/// queued for a safepoint.
const TOUCH_POLL: Duration = Duration::from_millis(2);
/// How long past its timeout a program thread waits for a decision or a
/// turn before it takes the default by itself.
const GRACE: Duration = Duration::from_millis(500);
/// The longest the harness thread stays parked without looking around.
/// Events that do not wake are read into the transcript at this pace.
const LONGEST_PARK: Duration = Duration::from_millis(250);
/// How long the harness waits for the user's line before it looks at the
/// program again, while a session is open.
const LINE_WAIT: Duration = Duration::from_millis(50);
/// How long the harness waits for a ring position that is claimed and
/// not published yet, before it looks again.
const PUBLISH_WAIT: Duration = Duration::from_millis(1);
/// The most wake reasons kept while the budget holds wakes back; past
/// it they are a count.
const HELD_REASONS: usize = 20;

/// The state of a touchpoint handed to the harness.
const WAITING: u8 = 0;
/// The harness has put its outcome on the record: the program takes it.
const SERVED: u8 = 1;
/// The program stopped waiting and took the default.
const GIVEN_UP: u8 = 2;

/// A touchpoint a program thread is blocked at.
pub(crate) struct Job {
    pub(crate) touch: Touch,
    pub(crate) asked: Instant,
    /// Claims the touchpoint for the harness, just before its outcome
    /// goes on the record. False when the program has stopped waiting:
    /// who settles it first, the harness or the program, settles it.
    pub(crate) claim: Box<dyn Fn() -> bool + Send>,
    /// Sends the outcome to whoever waits. Dropping it unsent tells them
    /// that nobody served the touchpoint.
    pub(crate) reply: Box<dyn FnOnce(Outcome) + Send>,
    /// The harness's own: not asked by a program thread, so it does not
    /// go when the program does.
    pub(crate) own: bool,
}

impl Job {
    /// Claim the touchpoint for the harness, unless the program has
    /// stopped waiting for it.
    fn claim(state: &AtomicU8) -> bool {
        state
            .compare_exchange(WAITING, SERVED, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
            || state.load(Ordering::SeqCst) == SERVED
    }
}

#[derive(Default)]
struct Inbox {
    jobs: VecDeque<Job>,
    /// The harness has ended: nothing pushed from now on is served.
    gone: bool,
    /// The harness is to detach, for this reason.
    stop: Option<String>,
}

/// What the harness's loop shares with whoever hands it touchpoints.
pub(crate) struct Shared {
    inbox: Mutex<Inbox>,
    thread: OnceLock<Thread>,
    /// Raised with the stop, and by a signal to end: a model request in
    /// flight is left at once.
    cancel: Cancel,
}

impl Shared {
    pub(crate) fn new() -> Self {
        Self {
            inbox: Mutex::new(Inbox::default()),
            thread: OnceLock::new(),
            cancel: Cancel::new(),
        }
    }

    fn inbox(&self) -> MutexGuard<'_, Inbox> {
        self.inbox.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Hand a touchpoint to the harness. False when the harness has
    /// ended: the job is not taken.
    pub(crate) fn push(&self, job: Job) -> bool {
        {
            let mut inbox = self.inbox();
            if inbox.gone {
                return false;
            }
            inbox.jobs.push_back(job);
        }
        self.unpark();
        true
    }

    /// The loop runs on the calling thread.
    pub(crate) fn on_this_thread(&self) {
        let _ = self.thread.set(std::thread::current());
    }

    /// Tell the harness to detach, for this reason: the program has
    /// gone, or the session it was started for has ended.
    pub(crate) fn stop(&self, reason: &str) {
        self.inbox().stop.get_or_insert_with(|| reason.to_string());
        self.cancel.raise();
        self.unpark();
    }

    /// Whether the process was sent a signal to end, where the harness
    /// watches for one.
    pub(crate) fn interrupted(&self) -> bool {
        self.cancel.signalled()
    }

    /// Watch a flag a signal handler raises.
    pub(crate) fn watch_interrupt(&self, flag: &'static AtomicBool) {
        self.cancel.watch(flag);
    }

    /// Wake the harness's loop.
    pub(crate) fn unpark(&self) {
        if let Some(thread) = self.thread.get() {
            thread.unpark();
        }
    }

    /// The harness has ended: what waits is dropped, so its waiters hear
    /// that nobody served it, and nothing more is taken.
    pub(crate) fn end(&self) {
        let dropped: Vec<Job> = {
            let mut inbox = self.inbox();
            inbox.gone = true;
            inbox.jobs.drain(..).collect()
        };
        drop(dropped);
    }

    fn is_gone(&self) -> bool {
        self.inbox().gone
    }
}

/// The session a harness opens by itself once it is attached. When it
/// ends, the harness leaves.
///
/// `launched`: the harness is the program's parent. A session that ends
/// because the agent went does not end the harness then: it stays for
/// the program.
pub(crate) fn own_session(shared: &Arc<Shared>, launched: bool) -> Job {
    let leaving = shared.clone();
    Job {
        touch: Touch::Session,
        asked: Instant::now(),
        claim: Box::new(|| true),
        reply: Box::new(move |outcome| match outcome {
            Outcome::Refused(why) => leaving.stop(&why),
            Outcome::Detached if launched => {}
            _ => leaving.stop(SESSION_ENDED),
        }),
        own: true,
    }
}

/// Why a harness started for a session detaches when the user ends it.
pub const SESSION_ENDED: &str = "the session ended";

/// Make the calling thread the one a region's wakes go to.
pub(crate) fn wake_this_thread(region: &abai_stub::region::Region) {
    region.set_waker(Box::new(Unpark(std::thread::current())));
}

/// Wakes the harness thread: one unpark.
struct Unpark(Thread);

impl RegionWake for Unpark {
    fn wake(&self) {
        self.0.unpark();
    }
}

/// The attached harness of thread mode, as the stub holds it.
struct ThreadHarness {
    stub: Arc<StubCore>,
    shared: Arc<Shared>,
}

impl Harness for ThreadHarness {
    fn touch(&self, touch: Touch) -> Outcome {
        let limit = match &touch {
            Touch::Decide { timeout, .. } | Touch::Turn { timeout, .. } => Some(*timeout + GRACE),
            Touch::Install | Touch::Session => None,
        };
        let asked = Instant::now();
        let state = Arc::new(AtomicU8::new(WAITING));
        let (send, answer) = sync_channel(1);
        let claimed = state.clone();
        let job = Job {
            touch,
            asked,
            claim: Box::new(move || Job::claim(&claimed)),
            reply: Box::new(move |outcome| {
                let _ = send.send(outcome);
            }),
            own: false,
        };
        if !self.shared.push(job) {
            return Outcome::Unserved;
        }
        let region = &self.stub.region;
        loop {
            match answer.recv_timeout(TOUCH_POLL) {
                Ok(outcome) => return outcome,
                // the harness ended without serving this
                Err(RecvTimeoutError::Disconnected) => return Outcome::Unserved,
                Err(RecvTimeoutError::Timeout) => {}
            }
            // a touchpoint is a safepoint: what the agent queued for one
            // runs here, on the thread that is waiting
            if region[header::SAFEPOINT].load(Ordering::Relaxed) != 0 && calls::take_queued(region)
            {
                self.stub.serve(Which::Safepoint);
            }
            // past its time, the program takes the default, unless the
            // harness has just put an outcome on the record: then that
            // outcome is on its way and is what the program takes
            if limit.is_some_and(|limit| asked.elapsed() >= limit)
                && state
                    .compare_exchange(WAITING, GIVEN_UP, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
            {
                return Outcome::Default;
            }
        }
    }
}

/// The person's loop while it is open: how its opener is told the end,
/// and whether the prompt is showing.
struct OpenSession {
    reply: Box<dyn FnOnce(Outcome) + Send>,
    prompted: bool,
}

/// The harness's loop: touchpoints from the program first, then what the
/// program emitted, the watched cells and the timers, then the user.
/// It ends when the core detaches, and returns why it did.
///
/// A harness that launched its program (sidecar launch) goes on while
/// that program runs, attached or not, and after its exit for as long as
/// the agent or the user has something to do about it.
pub(crate) fn run(shared: &Shared, mut core: Core, mut front: Box<dyn Front>) -> Option<String> {
    let mut session: Option<OpenSession> = None;
    let mut reasons: Vec<String> = Vec::new();
    let mut holding = false;
    core.set_cancel(shared.cancel.clone());
    loop {
        let stop = shared.inbox().stop.take();
        if let Some(reason) = stop {
            // a program this harness launched ends with it
            core.end_launch();
            core.poll_events();
            core.detach(&reason);
            break;
        }
        // what the program emitted before now is read first, so a step
        // that follows sees it
        let events = core.poll_events();
        reasons.extend(core.waking(&events));

        // a program in another process may simply have gone
        if core.is_attached() && !core.program_alive() {
            core.detach("the program has gone");
        }
        if !core.is_attached() {
            if !core.launched() && !core.stays() {
                break;
            }
            // nothing a program thread asked of the program that has gone
            // can be served: those threads have their answer already
            let stale: VecDeque<Job> = {
                let mut inbox = shared.inbox();
                let (own, stale) = inbox.jobs.drain(..).partition(|job| job.own);
                inbox.jobs = own;
                stale
            };
            drop(stale);
            if core.agent_lost() {
                // the agent is gone: the program has been let go, and the
                // harness stays only as the parent that reads its output,
                // so the program is never blocked on a pipe nobody reads
                core.release();
                if !core.program_running() {
                    break;
                }
                reasons.clear();
                if session.take().is_some()
                    && let Some(channel) = core.channel()
                {
                    channel.say("(the program runs on without its agent; this session is over)");
                }
                // told to end: the program is stopped first, as with an agent
                if shared.interrupted() {
                    shared.stop("the harness was told to end");
                    continue;
                }
                std::thread::park_timeout(LONGEST_PARK);
                continue;
            }
            // the program has exited, or was started and did not take up
            // its connection: the agent hears of it, and a user in a
            // session decides what comes next
            if !core.program_running()
                && reasons.is_empty()
                && session.is_none()
                && !core.outside_pending()
            {
                break;
            }
        }
        if shared.interrupted() {
            shared.stop("the harness was told to end");
            continue;
        }

        // a program thread at a touchpoint goes before any other wake
        let job = shared.inbox().jobs.pop_front();
        if let Some(job) = job {
            // the job may have come after this round read the events:
            // what its thread emitted before the touchpoint is read now,
            // so the step sees it
            let events = core.poll_events();
            reasons.extend(core.waking(&events));
            if let Some(open) = &mut session {
                open.prompted = false;
            }
            if job.touch != Touch::Session {
                let outcome =
                    serve_touch(&mut core, front.as_mut(), job.touch, job.asked, &job.claim);
                // whatever the outcome, it is on the record now
                (job.claim)();
                (job.reply)(outcome);
                continue;
            }
            let refusal = if session.is_some() {
                Some("a session is open already".to_string())
            } else {
                no_session(&mut core)
            };
            match refusal {
                Some(why) => {
                    core.record_touch("touchpoint", "session", "failed", Some(&why));
                    (job.reply)(Outcome::Refused(why));
                }
                None => {
                    let hello = front.greeting(&core);
                    if let Some(channel) = core.channel() {
                        channel.say(&hello);
                    }
                    session = Some(OpenSession {
                        reply: job.reply,
                        prompted: false,
                    });
                }
            }
            continue;
        }

        // the cells being watched, the timers
        reasons.extend(core.due(Instant::now()));

        let mut budget_frees = None;
        if !reasons.is_empty() {
            let now = Instant::now();
            if core.budget().allows(now) {
                holding = false;
                let wake = Wake::Attention {
                    reasons: std::mem::take(&mut reasons),
                    held: core.budget().take_held(),
                };
                if let RunEnd::Unreachable(reason) =
                    run_front(&mut core, front.as_mut(), Step::Wake(&wake, None))
                {
                    core.lose_agent(&reason);
                }
                if let Some(open) = &mut session {
                    open.prompted = false;
                }
                continue;
            }
            // beyond the budget the wakes wait for it to free; the oldest
            // past a number are folded into a count
            if !holding {
                holding = true;
                core.transcript
                    .push("# attention: wakes are being held back by the budget");
            }
            while reasons.len() > HELD_REASONS {
                reasons.remove(0);
                core.budget().hold();
            }
            budget_frees = core.budget().free_at(now);
        }

        let now = Instant::now();
        let until = |when: Option<Instant>| {
            when.map_or(LONGEST_PARK, |when| when.saturating_duration_since(now))
        };
        let next = until(core.next_due())
            .min(until(budget_frees))
            .min(LONGEST_PARK);

        // with a session open, the wait is for the user's line
        if let Some(open) = &mut session {
            if !open.prompted {
                if let Some(channel) = core.channel() {
                    channel.prompt("> ");
                }
                open.prompted = true;
            }
            let line = core
                .channel()
                .and_then(|channel| channel.try_line(next.min(LINE_WAIT)));
            let end = match line {
                None => continue,
                Some(None) => Some(RunEnd::Done),
                Some(Some(line)) => {
                    open.prompted = false;
                    match typed(&line) {
                        Typed::Quit => Some(RunEnd::Done),
                        Typed::Empty => None,
                        Typed::Line(line) => {
                            // what the program emitted is read before the
                            // agent answers, and still wakes it afterwards
                            let events = core.poll_events();
                            reasons.extend(core.waking(&events));
                            match run_front(&mut core, front.as_mut(), Step::Line(line)) {
                                RunEnd::Unreachable(reason) => Some(RunEnd::Unreachable(reason)),
                                _ => None,
                            }
                        }
                    }
                }
            };
            if let Some(end) = end {
                let outcome = end_touchpoint(&mut core, "session", end);
                if let Some(open) = session.take() {
                    (open.reply)(outcome);
                }
            }
            continue;
        }

        // park: the flag goes up, then one more look, then the wait. A
        // ring position that is claimed and not published yet is waited
        // for a moment at a time, not spun on.
        let region = core.region().clone();
        region[header::PARKED].store(1, Ordering::SeqCst);
        if shared.inbox().jobs.is_empty() && !core.outside_pending() {
            let wait = if core.events_pending() {
                PUBLISH_WAIT
            } else {
                next
            };
            std::thread::park_timeout(wait);
        }
        region[header::PARKED].store(0, Ordering::SeqCst);
    }

    if let Some(open) = session.take() {
        // the session ends with the harness, and the record says so
        core.record_touch("touchpoint", "session", "default", Some("detached"));
        (open.reply)(Outcome::Detached);
    }
    core.end_launch();
    core.detach_reason().map(str::to_string)
}

/// Start the harness thread. `make` attaches the core on that thread,
/// after the region's waker is in place; this returns once the core is
/// attached, so the attached flag is up, or says why there is no harness.
pub(crate) fn start<F>(stub: Arc<StubCore>, make: F) -> Result<Arc<dyn Harness>, String>
where
    F: FnOnce() -> (Core, Box<dyn Front>) + Send + 'static,
{
    let shared = Arc::new(Shared::new());
    let (ready, attached) = sync_channel::<()>(1);
    let (on_thread, region) = (shared.clone(), stub.region.clone());
    std::thread::Builder::new()
        .name("abai-harness".to_string())
        .spawn(move || {
            let shared = on_thread;
            let _ = shared.thread.set(std::thread::current());
            region.set_waker(Box::new(Unpark(std::thread::current())));
            // a panic on this thread is the harness's fault, not the
            // program's: it ends the harness, and the program runs on
            let ended = catch_unwind(AssertUnwindSafe(|| {
                let (core, front) = make();
                let _ = ready.send(());
                run(&shared, core, front);
            }));
            if ended.is_err() {
                region[header::ATTACHED].store(0, Ordering::SeqCst);
            }
            shared.end();
        })
        .map_err(|error| format!("the harness thread could not be started: {error}"))?;
    // wait until the core is attached, or the thread has ended without it
    if attached.recv().is_err() || shared.is_gone() {
        return Err("the harness failed as it started".to_string());
    }
    Ok(Arc::new(ThreadHarness { stub, shared }))
}
