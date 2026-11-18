//! Calls from the harness to the program's handlers (contract sections
//! 5.2 and 5.3): capability calls, sized-knob deliveries and the stop
//! handler. Parameters arrive through the region and the result goes back
//! through a reply area in the same slot.
//!
//! A slot's state word says who holds it:
//!
//! ```text
//! FREE -> FILLING -> PENDING -> RUNNING -> DONE -> FREE
//!   harness posts      program serves        harness polls
//! ```
//!
//! A call the harness gives up on goes `PENDING -> FREE` when the program
//! never took it, or `RUNNING -> ABANDONED -> FREE` when it had: the
//! program frees the slot when its handler returns.
//!
//! The state word also carries a generation, one more for every call
//! posted into the slot. Every step is a compare-and-swap on the whole
//! word, so a thread that looked at one call can never act on the next
//! one in the same slot, and a ticket is good for its own call only.
//!
//! The program's side, [`serve`], allocates nothing of its own: the
//! parameters are copied to the stack and handed to the handler as JSON
//! text, and the handler's result is encoded straight into the reply area.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde::de::DeserializeOwned;

use super::{Region, SAFEPOINT_QUEUED, WordWriter, header, load_bytes, store_bytes};

/// How many calls can be open at once.
pub const CALL_SLOTS: usize = 4;
/// The most bytes of parameters, and of result, one call carries.
pub const CALL_BYTES: usize = 16 * 1024;
const AREA_WORDS: usize = CALL_BYTES / 8;
/// A slot: five words, the parameters, the reply.
pub const CALL_SLOT_WORDS: usize = HEAD + 2 * AREA_WORDS;

const STATE: usize = 0;
const TARGET: usize = 1;
const PARAMS_LEN: usize = 2;
const REPLY_STATUS: usize = 3;
const REPLY_LEN: usize = 4;
const HEAD: usize = 5;

const FREE: u64 = 0;
const FILLING: u64 = 1;
const PENDING: u64 = 2;
const RUNNING: u64 = 3;
const DONE: u64 = 4;
const ABANDONED: u64 = 5;
/// The low bits of a state word are the phase; the rest is the generation.
const PHASE_BITS: u32 = 3;
const PHASE: u64 = (1 << PHASE_BITS) - 1;

fn state(generation: u64, phase: u64) -> u64 {
    (generation << PHASE_BITS) | phase
}

/// Move a slot from one phase to another within a generation.
fn step(word: &AtomicU64, generation: u64, from: u64, to: u64) -> bool {
    word.compare_exchange(
        state(generation, from),
        state(generation, to),
        Ordering::SeqCst,
        Ordering::Relaxed,
    )
    .is_ok()
}

const REPLY_OK: u64 = 1;
const REPLY_ERROR: u64 = 2;

const KIND_SHIFT: u32 = 32;
const KIND_CAPABILITY: u64 = 0;
const KIND_KNOB: u64 = 1;
const KIND_STOP: u64 = 2;
const IMMEDIATE: u64 = 1 << 40;

/// What a call is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// The capability of this index in the manifest.
    Capability { index: usize, immediate: bool },
    /// A sized knob, by its cell's index: deliver a value to its handler.
    Knob { index: usize },
    /// The stop handler.
    Stop,
}

impl Target {
    fn word(self) -> u64 {
        match self {
            Self::Capability { index, immediate } => {
                index as u64
                    | (KIND_CAPABILITY << KIND_SHIFT)
                    | if immediate { IMMEDIATE } else { 0 }
            }
            Self::Knob { index } => index as u64 | (KIND_KNOB << KIND_SHIFT),
            Self::Stop => KIND_STOP << KIND_SHIFT,
        }
    }

    fn of(word: u64) -> Option<Self> {
        let index = (word & 0xffff_ffff) as usize;
        match (word >> KIND_SHIFT) & 0xff {
            KIND_CAPABILITY => Some(Self::Capability {
                index,
                immediate: word & IMMEDIATE != 0,
            }),
            KIND_KNOB => Some(Self::Knob { index }),
            KIND_STOP => Some(Self::Stop),
            _ => None,
        }
    }

    /// Whether the call runs as soon as it is posted, not at a safepoint.
    pub fn immediate(self) -> bool {
        matches!(
            self,
            Self::Capability {
                immediate: true,
                ..
            }
        )
    }
}

/// The parameters of a call, or a delivered knob value, as JSON text.
#[derive(Debug, Clone, Copy)]
pub struct Params<'a>(&'a str);

impl<'a> Params<'a> {
    /// The JSON text as it arrived.
    pub fn json(&self) -> &'a str {
        self.0
    }

    /// The parameters as a type of the program's. Parsing is the
    /// handler's own cost.
    pub fn get<T: DeserializeOwned>(&self) -> Result<T, String> {
        serde_json::from_str(self.0).map_err(|error| error.to_string())
    }
}

/// Where a handler's result goes: straight into the call's reply area.
#[derive(Debug)]
pub struct Reply<'a> {
    words: &'a [AtomicU64],
    status: u64,
    len: usize,
}

impl Reply<'_> {
    /// The call succeeded with this result.
    pub fn ok<T: Serialize + ?Sized>(&mut self, result: &T) {
        let mut writer = WordWriter::new(self.words, CALL_BYTES);
        let written = serde_json::to_writer(&mut writer, result).is_ok();
        match writer.finish() {
            Some(len) if written => {
                self.status = REPLY_OK;
                self.len = len;
            }
            _ => self.error("the result is larger than a call carries"),
        }
    }

    /// The call failed, with the program's own words.
    pub fn error(&mut self, message: &str) {
        let bytes = crate::manifest::cut_utf8(message, CALL_BYTES).as_bytes();
        store_bytes(self.words, bytes);
        self.status = REPLY_ERROR;
        self.len = bytes.len();
    }
}

/// A capability's handler, as the stub keeps it.
pub type CallHandler = Arc<dyn Fn(Params<'_>, &mut Reply<'_>) + Send + Sync>;
/// A sized knob's handler: the delivered value, taken or refused.
pub type KnobHandler = Arc<dyn Fn(Params<'_>) -> Result<(), String> + Send + Sync>;
/// The stop handler.
pub type StopHandler = Arc<dyn Fn() + Send + Sync>;

/// The program's handlers, by the index of their declaration.
#[derive(Default, Clone)]
pub struct Handlers {
    pub capabilities: Vec<Option<CallHandler>>,
    /// By cell index; only sized knobs have one.
    pub knobs: Vec<Option<KnobHandler>>,
    pub stop: Option<StopHandler>,
}

impl std::fmt::Debug for Handlers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let count = |list: &[Option<_>]| list.iter().filter(|h| h.is_some()).count();
        f.debug_struct("Handlers")
            .field("capabilities", &self.capabilities.iter().flatten().count())
            .field("knobs", &count(&self.knobs))
            .field("stop", &self.stop.is_some())
            .finish()
    }
}

/// Which pending calls a thread serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Which {
    /// Calls dispatched at a safepoint.
    Safepoint,
    /// Calls dispatched as soon as they arrive.
    Immediate,
    /// Both: inside a touchpoint on the program's thread in turns mode.
    All,
}

fn slot(region: &Region, index: usize) -> &[AtomicU64] {
    let base = region.layout.calls_at + index * CALL_SLOT_WORDS;
    &region[base..base + CALL_SLOT_WORDS]
}

fn run(handlers: &Handlers, target: Option<Target>, params: Params<'_>, reply: &mut Reply<'_>) {
    match target {
        Some(Target::Capability { index, .. }) => match handlers.capabilities.get(index) {
            Some(Some(handler)) => handler(params, reply),
            _ => reply.error("the program registered no handler for this capability"),
        },
        Some(Target::Knob { index }) => match handlers.knobs.get(index) {
            Some(Some(handler)) => match handler(params) {
                Ok(()) => reply.ok(&()),
                Err(refusal) => reply.error(&refusal),
            },
            _ => reply.error("the program registered no handler for this knob"),
        },
        Some(Target::Stop) => match &handlers.stop {
            Some(handler) => {
                handler();
                reply.ok(&());
            }
            None => reply.error("the program registered no stop handler"),
        },
        None => reply.error("the call names nothing this program has"),
    }
}

/// The program serves the pending calls it is asked for and returns how
/// many it ran. Each runs its handler on the calling thread; a handler
/// that panics is an error reply, not a lost slot.
pub fn serve(region: &Region, handlers: &Handlers, which: Which) -> usize {
    let mut served = 0;
    for index in 0..CALL_SLOTS {
        let words = slot(region, index);
        let seen = words[STATE].load(Ordering::SeqCst);
        if seen & PHASE != PENDING {
            continue;
        }
        let generation = seen >> PHASE_BITS;
        let target = Target::of(words[TARGET].load(Ordering::Relaxed));
        let immediate = target.is_some_and(Target::immediate);
        let wanted = match which {
            Which::Safepoint => !immediate,
            Which::Immediate => immediate,
            Which::All => true,
        };
        // the claim is on the generation that was looked at: if the slot
        // has moved on to another call, this one is not ours to run
        if !wanted || !step(&words[STATE], generation, PENDING, RUNNING) {
            continue;
        }
        // another call may be waiting for a safepoint while this handler
        // runs: leave the flag up so another thread's safepoint takes it
        let more = (index + 1..CALL_SLOTS).any(|other| {
            let other = slot(region, other);
            other[STATE].load(Ordering::SeqCst) & PHASE == PENDING
                && !Target::of(other[TARGET].load(Ordering::Relaxed)).is_some_and(Target::immediate)
        });
        if more {
            region[header::SAFEPOINT].fetch_or(SAFEPOINT_QUEUED, Ordering::SeqCst);
        }

        let len = (words[PARAMS_LEN].load(Ordering::Relaxed) as usize).min(CALL_BYTES);
        let mut buffer = [0u8; CALL_BYTES];
        for (chunk, word) in buffer[..len.div_ceil(8) * 8]
            .chunks_mut(8)
            .zip(&words[HEAD..])
        {
            chunk.copy_from_slice(&word.load(Ordering::Relaxed).to_le_bytes());
        }

        let mut reply = Reply {
            words: &words[HEAD + AREA_WORDS..],
            status: 0,
            len: 0,
        };
        match std::str::from_utf8(&buffer[..len]) {
            Err(_) => reply.error("the parameters are not UTF-8"),
            Ok(text) => {
                let params = Params(text);
                let ran = catch_unwind(AssertUnwindSafe(|| {
                    run(handlers, target, params, &mut reply)
                }));
                if ran.is_err() {
                    reply.error("the handler panicked");
                }
            }
        }
        if reply.status == 0 {
            reply.ok(&());
        }
        words[REPLY_STATUS].store(reply.status, Ordering::Relaxed);
        words[REPLY_LEN].store(reply.len as u64, Ordering::Relaxed);
        if !step(&words[STATE], generation, RUNNING, DONE) {
            // the harness gave the call up while it ran
            step(&words[STATE], generation, ABANDONED, FREE);
        }
        region.wake_if_parked();
        served += 1;
    }
    served
}

/// A posted call, held by the harness until it is polled done or
/// abandoned. It names its slot and the slot's generation.
#[derive(Debug, PartialEq, Eq)]
pub struct Ticket {
    slot: usize,
    generation: u64,
}

/// A call could not be posted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostError {
    /// Every slot holds a call that has not finished.
    Busy,
    /// The parameters are longer than a call carries; this many bytes.
    TooLarge(usize),
}

/// The harness posts a call. A call for a safepoint also raises the flag
/// the program's `safepoint()` loads.
pub fn post(region: &Region, target: Target, params: &[u8]) -> Result<Ticket, PostError> {
    if params.len() > CALL_BYTES {
        return Err(PostError::TooLarge(params.len()));
    }
    for index in 0..CALL_SLOTS {
        let words = slot(region, index);
        let seen = words[STATE].load(Ordering::SeqCst);
        let generation = (seen >> PHASE_BITS) + 1;
        if seen & PHASE != FREE
            || words[STATE]
                .compare_exchange(
                    seen,
                    state(generation, FILLING),
                    Ordering::SeqCst,
                    Ordering::Relaxed,
                )
                .is_err()
        {
            continue;
        }
        words[TARGET].store(target.word(), Ordering::Relaxed);
        words[PARAMS_LEN].store(params.len() as u64, Ordering::Relaxed);
        store_bytes(&words[HEAD..], params);
        words[REPLY_STATUS].store(0, Ordering::Relaxed);
        words[STATE].store(state(generation, PENDING), Ordering::SeqCst);
        if !target.immediate() {
            region[header::SAFEPOINT].fetch_or(SAFEPOINT_QUEUED, Ordering::SeqCst);
        }
        return Ok(Ticket {
            slot: index,
            generation,
        });
    }
    Err(PostError::Busy)
}

/// The result of a call that finished: the JSON of its result, or the
/// program's error.
pub type CallResult = Result<Vec<u8>, String>;

/// The harness asks whether a call has finished. A finished call frees
/// its slot, so a ticket is polled done once.
///
/// A harness that parks while a call is open sets the parked flag first
/// and polls once more before it blocks, as it does for the ring.
pub fn poll(region: &Region, ticket: &Ticket) -> Option<CallResult> {
    let words = slot(region, ticket.slot);
    if words[STATE].load(Ordering::SeqCst) != state(ticket.generation, DONE) {
        return None;
    }
    let result = read_reply(words);
    step(&words[STATE], ticket.generation, DONE, FREE);
    Some(result)
}

/// Whether a call has finished, without taking its result.
pub fn finished(region: &Region, ticket: &Ticket) -> bool {
    slot(region, ticket.slot)[STATE].load(Ordering::SeqCst) == state(ticket.generation, DONE)
}

/// What giving a call up found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Abandoned {
    /// The program never took the call: the handler did not run and
    /// never will.
    Discarded,
    /// The handler is running. It will finish, and its result is thrown
    /// away.
    Running,
    /// The call finished just before it was given up: here is its result.
    Finished(CallResult),
}

fn read_reply(words: &[AtomicU64]) -> CallResult {
    let len = (words[REPLY_LEN].load(Ordering::Relaxed) as usize).min(CALL_BYTES);
    let bytes = load_bytes(&words[HEAD + AREA_WORDS..], len);
    if words[REPLY_STATUS].load(Ordering::Relaxed) == REPLY_OK {
        Ok(bytes)
    } else {
        Err(String::from_utf8_lossy(&bytes).into_owned())
    }
}

/// The harness gives a call up, at its timeout.
pub fn abandon(region: &Region, ticket: Ticket) -> Abandoned {
    let words = slot(region, ticket.slot);
    if step(&words[STATE], ticket.generation, PENDING, FREE) {
        return Abandoned::Discarded;
    }
    if step(&words[STATE], ticket.generation, RUNNING, ABANDONED) {
        return Abandoned::Running;
    }
    if words[STATE].load(Ordering::SeqCst) == state(ticket.generation, DONE) {
        let result = read_reply(words);
        step(&words[STATE], ticket.generation, DONE, FREE);
        return Abandoned::Finished(result);
    }
    // the ticket is not this slot's call any more
    Abandoned::Discarded
}

/// The harness has gone, and nobody will read a result: a call not taken
/// yet is discarded, so its handler never runs for nobody; a finished one
/// is freed; a running one's result will be thrown away.
pub fn orphan(region: &Region) {
    for index in 0..CALL_SLOTS {
        let state = &slot(region, index)[STATE];
        // a program thread may move the slot on between the look and
        // the step: look again until a step holds
        loop {
            let seen = state.load(Ordering::SeqCst);
            let generation = seen >> PHASE_BITS;
            let settled = match seen & PHASE {
                FILLING | PENDING | DONE => step(state, generation, seen & PHASE, FREE),
                RUNNING => step(state, generation, RUNNING, ABANDONED),
                _ => true,
            };
            if settled {
                break;
            }
        }
    }
}

/// Whether the program has been asked to look at its call slots at the
/// next safepoint. Clearing the flag is the program's first step there.
pub fn take_queued(region: &Region) -> bool {
    region[header::SAFEPOINT].fetch_and(!SAFEPOINT_QUEUED, Ordering::SeqCst) & SAFEPOINT_QUEUED != 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::region::tests::manifest;
    use serde_json::{Value, json};
    use std::sync::Mutex;

    #[derive(serde::Deserialize)]
    struct Add {
        a: i64,
        b: i64,
    }

    fn handlers(seen: Arc<Mutex<Vec<String>>>) -> Handlers {
        let add: CallHandler = Arc::new(|params, reply| match params.get::<Add>() {
            Ok(add) => reply.ok(&json!({"sum": add.a + add.b})),
            Err(error) => reply.error(&error),
        });
        let panics: CallHandler = Arc::new(|_, _| panic!("the program's bug"));
        let silent: CallHandler = Arc::new(|_, _| {});
        let knob_seen = seen.clone();
        let knob: KnobHandler = Arc::new(move |value| {
            if value.json() == r#""no""# {
                return Err("the program will not take that".to_string());
            }
            knob_seen.lock().unwrap().push(value.json().to_string());
            Ok(())
        });
        let stop: StopHandler = Arc::new(move || seen.lock().unwrap().push("stop".to_string()));
        Handlers {
            capabilities: vec![Some(add), Some(panics), Some(silent), None],
            knobs: vec![None, Some(knob)],
            stop: Some(stop),
        }
    }

    fn region() -> Arc<Region> {
        Region::in_process(&manifest(), 4)
    }

    fn capability(index: usize) -> Target {
        Target::Capability {
            index,
            immediate: false,
        }
    }

    fn result(region: &Region, ticket: &Ticket) -> Result<Value, String> {
        poll(region, ticket)
            .expect("the call finished")
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }

    #[test]
    fn a_call_goes_to_its_handler_and_comes_back() {
        let region = region();
        let handlers = handlers(Arc::default());
        let ticket = post(&region, capability(0), br#"{"a": 2, "b": 40}"#).unwrap();
        assert_eq!(poll(&region, &ticket), None);
        assert!(take_queued(&region));
        assert!(!take_queued(&region));
        assert_eq!(serve(&region, &handlers, Which::Safepoint), 1);
        assert_eq!(result(&region, &ticket), Ok(json!({"sum": 42})));
        // the slot is free again
        assert_eq!(poll(&region, &ticket), None);
        assert_eq!(serve(&region, &handlers, Which::All), 0);
    }

    #[test]
    fn errors_come_back_in_the_programs_words() {
        let region = region();
        let handlers = handlers(Arc::default());
        let bad = post(&region, capability(0), b"{}").unwrap();
        let panics = post(&region, capability(1), b"{}").unwrap();
        let missing = post(&region, capability(3), b"{}").unwrap();
        let unknown = post(&region, capability(9), b"{}").unwrap();
        assert_eq!(serve(&region, &handlers, Which::Safepoint), 4);
        assert!(result(&region, &bad).unwrap_err().contains("missing field"));
        assert_eq!(
            result(&region, &panics).unwrap_err(),
            "the handler panicked"
        );
        assert!(
            result(&region, &missing)
                .unwrap_err()
                .contains("no handler")
        );
        assert!(
            result(&region, &unknown)
                .unwrap_err()
                .contains("no handler")
        );
    }

    #[test]
    fn a_handler_that_says_nothing_succeeds_with_null() {
        let region = region();
        let ticket = post(&region, capability(2), b"{}").unwrap();
        serve(&region, &handlers(Arc::default()), Which::All);
        assert_eq!(result(&region, &ticket), Ok(Value::Null));
    }

    #[test]
    fn a_knob_delivery_and_a_stop_reach_their_handlers() {
        let region = region();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handlers = handlers(seen.clone());
        let knob = post(&region, Target::Knob { index: 1 }, br#""onward""#).unwrap();
        let stop = post(&region, Target::Stop, b"").unwrap();
        let no_handler = post(&region, Target::Knob { index: 0 }, b"1").unwrap();
        assert_eq!(serve(&region, &handlers, Which::Safepoint), 3);
        assert_eq!(*seen.lock().unwrap(), [r#""onward""#, "stop"]);
        assert_eq!(result(&region, &knob), Ok(Value::Null));
        assert_eq!(result(&region, &stop), Ok(Value::Null));
        assert!(result(&region, &no_handler).is_err());
    }

    #[test]
    fn immediate_and_safepoint_calls_are_served_apart() {
        let region = region();
        let handlers = handlers(Arc::default());
        let now = Target::Capability {
            index: 0,
            immediate: true,
        };
        let first = post(&region, now, br#"{"a": 1, "b": 1}"#).unwrap();
        // an immediate call does not ask for a safepoint
        assert!(!take_queued(&region));
        let later = post(&region, capability(0), br#"{"a": 2, "b": 2}"#).unwrap();
        assert_eq!(serve(&region, &handlers, Which::Immediate), 1);
        assert_eq!(result(&region, &first), Ok(json!({"sum": 2})));
        assert_eq!(poll(&region, &later), None);
        assert_eq!(serve(&region, &handlers, Which::Safepoint), 1);
        assert_eq!(result(&region, &later), Ok(json!({"sum": 4})));
    }

    #[test]
    fn the_slots_fill_up_and_free_again() {
        let region = region();
        let handlers = handlers(Arc::default());
        let tickets: Vec<Ticket> = (0..CALL_SLOTS)
            .map(|_| post(&region, capability(2), b"{}").unwrap())
            .collect();
        assert_eq!(post(&region, capability(2), b"{}"), Err(PostError::Busy));
        let big = vec![b' '; CALL_BYTES + 1];
        assert_eq!(
            post(&region, capability(2), &big),
            Err(PostError::TooLarge(CALL_BYTES + 1))
        );
        serve(&region, &handlers, Which::All);
        for ticket in &tickets {
            assert!(poll(&region, ticket).is_some());
        }
        assert!(post(&region, capability(2), b"{}").is_ok());
    }

    #[test]
    fn when_the_harness_has_gone_its_calls_are_cleared_away() {
        let region = region();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handlers = handlers(seen.clone());
        // one that ran and was never read, one never taken
        let done = post(&region, Target::Stop, b"").unwrap();
        assert_eq!(serve(&region, &handlers, Which::All), 1);
        assert!(finished(&region, &done));
        let pending = post(&region, Target::Stop, b"").unwrap();
        orphan(&region);
        // neither runs for nobody, and every slot can be posted to again
        assert_eq!(serve(&region, &handlers, Which::All), 0);
        assert_eq!(poll(&region, &done), None);
        assert_eq!(poll(&region, &pending), None);
        let fresh: Vec<_> = (0..CALL_SLOTS)
            .map(|_| post(&region, Target::Stop, b"").unwrap())
            .collect();
        assert_eq!(fresh.len(), CALL_SLOTS);
    }

    #[test]
    fn a_call_given_up_before_it_ran_never_runs() {
        let region = region();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handlers = handlers(seen.clone());
        let ticket = post(&region, Target::Stop, b"").unwrap();
        assert_eq!(abandon(&region, ticket), Abandoned::Discarded);
        assert_eq!(serve(&region, &handlers, Which::All), 0);
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn a_call_given_up_while_it_runs_frees_its_slot_when_it_ends() {
        let region = region();
        let inside = Arc::new(std::sync::Barrier::new(2));
        let leave = Arc::new(std::sync::Barrier::new(2));
        let (enter, exit) = (inside.clone(), leave.clone());
        let slow: CallHandler = Arc::new(move |_, reply| {
            enter.wait();
            exit.wait();
            reply.ok(&1);
        });
        let handlers = Handlers {
            capabilities: vec![Some(slow)],
            ..Handlers::default()
        };
        let ticket = post(&region, capability(0), b"{}").unwrap();
        let program = {
            let region = region.clone();
            std::thread::spawn(move || serve(&region, &handlers, Which::All))
        };
        inside.wait();
        assert_eq!(abandon(&region, ticket), Abandoned::Running);
        leave.wait();
        assert_eq!(program.join().unwrap(), 1);
        let words = slot(&region, 0);
        assert_eq!(words[STATE].load(Ordering::SeqCst) & PHASE, FREE);
    }

    #[test]
    fn a_call_that_finished_just_before_it_was_given_up_keeps_its_result() {
        let region = region();
        let handlers = handlers(Arc::default());
        let ticket = post(&region, capability(0), br#"{"a": 3, "b": 4}"#).unwrap();
        serve(&region, &handlers, Which::All);
        let Abandoned::Finished(result) = abandon(&region, ticket) else {
            panic!("the call had finished");
        };
        assert_eq!(
            serde_json::from_slice::<Value>(&result.unwrap()).unwrap(),
            json!({"sum": 7})
        );
        // and its slot is free
        assert!(post(&region, capability(0), b"{}").is_ok());
        assert_eq!(
            slot(&region, 0)[STATE].load(Ordering::SeqCst) & PHASE,
            PENDING
        );
    }

    #[test]
    fn a_knob_handler_can_refuse_a_value() {
        let region = region();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handlers = handlers(seen.clone());
        let ticket = post(&region, Target::Knob { index: 1 }, br#""no""#).unwrap();
        serve(&region, &handlers, Which::All);
        assert_eq!(
            result(&region, &ticket).unwrap_err(),
            "the program will not take that"
        );
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn a_ticket_is_good_for_its_own_call_only() {
        let region = region();
        let handlers = handlers(Arc::default());
        let first = post(&region, capability(0), br#"{"a": 1, "b": 1}"#).unwrap();
        let stale = Ticket {
            slot: first.slot,
            generation: first.generation,
        };
        assert_eq!(abandon(&region, first), Abandoned::Discarded);
        // the next call takes the same slot
        let second = post(&region, capability(0), br#"{"a": 2, "b": 2}"#).unwrap();
        assert_eq!(second.slot, stale.slot);
        assert_ne!(second.generation, stale.generation);
        serve(&region, &handlers, Which::All);
        assert_eq!(poll(&region, &stale), None);
        assert_eq!(abandon(&region, stale), Abandoned::Discarded);
        // the stale ticket took nothing from the call that owns the slot
        assert_eq!(result(&region, &second), Ok(json!({"sum": 4})));
    }

    #[test]
    fn parameters_that_are_not_text_are_refused_before_the_handler() {
        let region = region();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handlers = handlers(seen.clone());
        let ticket = post(&region, Target::Knob { index: 1 }, &[0xff, 0xfe]).unwrap();
        serve(&region, &handlers, Which::All);
        assert!(result(&region, &ticket).unwrap_err().contains("UTF-8"));
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn a_second_pending_call_keeps_the_safepoint_flag_up() {
        let region = region();
        let flag_inside = Arc::new(Mutex::new(None));
        let (shared, inner) = (flag_inside.clone(), region.clone());
        let looks: CallHandler = Arc::new(move |_, _| {
            let up = inner[header::SAFEPOINT].load(Ordering::SeqCst) & SAFEPOINT_QUEUED != 0;
            shared.lock().unwrap().get_or_insert(up);
        });
        let handlers = Handlers {
            capabilities: vec![Some(looks)],
            ..Handlers::default()
        };
        post(&region, capability(0), b"{}").unwrap();
        post(&region, capability(0), b"{}").unwrap();
        assert!(take_queued(&region));
        assert_eq!(serve(&region, &handlers, Which::Safepoint), 2);
        // while the first handler ran, the flag was up for other threads
        assert_eq!(*flag_inside.lock().unwrap(), Some(true));
    }

    #[test]
    fn a_result_too_large_is_an_error() {
        let region = region();
        let huge: CallHandler = Arc::new(|_, reply| reply.ok(&vec![7u64; CALL_BYTES]));
        let handlers = Handlers {
            capabilities: vec![Some(huge)],
            ..Handlers::default()
        };
        let ticket = post(&region, capability(0), b"{}").unwrap();
        serve(&region, &handlers, Which::All);
        assert!(result(&region, &ticket).unwrap_err().contains("larger"));
    }
}
