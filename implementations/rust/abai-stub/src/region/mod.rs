//! The region: the memory the stub and the harness share (contract
//! sections 2, 5 and 14).
//!
//! The region is one block of 64-bit words, every one of them an atomic.
//! In turns and thread modes the block is ordinary process memory; in
//! sidecar mode it is a mapped shared segment. Both halves compute the
//! same [`Layout`] from the manifest, so nothing but values crosses.
//!
//! Bytes (sized cells, event payloads) are packed into words, eight to a
//! word, little end first. A copy is therefore a bounded run of plain
//! word stores, and a reader that races a writer reads stale or mixed
//! words but never undefined memory; the sequence numbers beside the data
//! tell it to try again.

pub mod calls;
pub mod cells;
pub mod ring;
#[cfg(unix)]
pub(crate) mod shm;

use std::ops::Deref;
use std::sync::Arc;
use std::sync::atomic::{AtomicPtr, AtomicU64, Ordering};

use crate::manifest::{CellDecl, EventDecl, Field, Manifest, ValueType};

/// `ABAIRGN1`, little end first.
pub const MAGIC: u64 = u64::from_le_bytes(*b"ABAIRGN1");
/// The layout's version; a harness refuses a region of another.
pub const LAYOUT_VERSION: u64 = 1;

/// Word indices of the header.
pub mod header {
    pub const MAGIC: usize = 0;
    pub const VERSION: usize = 1;
    /// The region's length in words.
    pub const WORDS: usize = 2;
    /// A hash of the manifest the layout was computed from.
    pub const MANIFEST: usize = 3;
    /// 1 while a harness is attached.
    pub const ATTACHED: usize = 4;
    /// 1 while the attached harness is blocked waiting.
    pub const PARKED: usize = 5;
    /// What a safepoint has to look at: the `SAFEPOINT_*` bits.
    pub const SAFEPOINT: usize = 6;
    /// The next event's position in the ring.
    pub const RING_HEAD: usize = 7;
    /// Emits dropped because their slot was still being written.
    pub const EVENTS_LAPPED: usize = 8;
    /// `large` emits dropped for want of arena space.
    pub const ARENA_DROPPED: usize = 9;
    /// Runs that fell back to the default mode, since the last attach.
    pub const MODE_FALLBACK: usize = 10;
    /// Wake calls the program has made.
    pub const WAKES: usize = 11;
    /// Payload writes that named a field the event lacks, or the wrong type.
    pub const MISUSE: usize = 12;
    /// The number of slots in the event ring.
    pub const RING_SLOTS: usize = 13;
    /// The header's length in words.
    pub const LEN: usize = 16;
}

/// A call or a delivery is queued for the next safepoint.
pub const SAFEPOINT_QUEUED: u64 = 1;
/// A cooperative pause is in effect.
pub const SAFEPOINT_PAUSED: u64 = 2;

/// Default number of event slots in the ring. A power of two.
pub const DEFAULT_RING_SLOTS: usize = 256;

/// How a value sits in the region.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Bool,
    Int,
    Float,
    /// The index of the value among the declared ones.
    Enum,
    /// A `string`: UTF-8 bytes.
    Text,
    /// An `object` or a `list`: JSON text.
    Json,
}

impl Kind {
    fn of(ty: ValueType) -> Self {
        match ty {
            ValueType::Bool => Self::Bool,
            ValueType::Int => Self::Int,
            ValueType::Float => Self::Float,
            ValueType::Enum => Self::Enum,
            ValueType::String => Self::Text,
            ValueType::Object | ValueType::List => Self::Json,
        }
    }

    /// Whether the value is one word.
    pub fn is_scalar(self) -> bool {
        !matches!(self, Self::Text | Self::Json)
    }
}

/// Where a cell is.
///
/// A scalar cell is two words: the value, then the version. A sized cell
/// is a version, a length in bytes, then the bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct CellSlot {
    pub name: String,
    pub kind: Kind,
    /// The first word.
    pub at: usize,
    /// Sized cells: the most bytes the slot holds.
    pub max: usize,
    pub knob: bool,
    /// `enum` cells: the values, in declared order.
    pub values: Vec<String>,
}

/// Where a payload field is, counted in words from the payload's start.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldSlot {
    pub name: String,
    pub kind: Kind,
    /// A scalar's word; a sized field's length word, with the bytes after.
    pub at: usize,
    pub max: usize,
    pub values: Vec<String>,
}

/// How an event's payload is laid out in a slot: presence bits first, one
/// per field, then the fields in declared order.
#[derive(Debug, Clone, PartialEq)]
pub struct EventSlot {
    pub name: String,
    pub fields: Vec<FieldSlot>,
    /// Words of presence bits.
    pub mask_words: usize,
    /// The payload's whole length in words.
    pub words: usize,
    /// Whether an emit may wake a parked harness (`wakes` is not `never`).
    pub wakes: bool,
    pub large: bool,
}

/// Where everything is. Computed from the manifest alone.
#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    /// One counter per decision, then one per turn, from here.
    pub counters_at: usize,
    pub decisions: Vec<String>,
    pub turns: Vec<String>,
    pub cells: Vec<CellSlot>,
    pub events: Vec<EventSlot>,
    pub ring_at: usize,
    /// A power of two.
    pub ring_slots: usize,
    /// A slot is a sequence word, a word naming the event, and the payload.
    pub slot_words: usize,
    /// The call slots, `calls::CALL_SLOTS` of them.
    pub calls_at: usize,
    /// The region's length.
    pub words: usize,
    pub manifest_hash: u64,
}

fn words_for(bytes: usize) -> usize {
    bytes.div_ceil(8)
}

fn cell_slot(cell: &CellDecl, at: usize) -> (CellSlot, usize) {
    let kind = Kind::of(cell.ty);
    let max = if kind.is_scalar() {
        0
    } else {
        cell.slot_bytes() as usize
    };
    let len = if kind.is_scalar() {
        2
    } else {
        2 + words_for(max)
    };
    let slot = CellSlot {
        name: cell.name.clone(),
        kind,
        at,
        max,
        knob: cell.is_knob(),
        values: cell.values.clone().unwrap_or_default(),
    };
    (slot, len)
}

fn field_slot(name: &str, field: &Field, at: usize) -> (FieldSlot, usize) {
    let kind = Kind::of(field.ty);
    let max = if kind.is_scalar() {
        0
    } else {
        field.slot_bytes() as usize
    };
    let len = if kind.is_scalar() {
        1
    } else {
        1 + words_for(max)
    };
    let slot = FieldSlot {
        name: name.to_string(),
        kind,
        at,
        max,
        values: field.values.clone().unwrap_or_default(),
    };
    (slot, len)
}

fn event_slot(event: &EventDecl) -> EventSlot {
    let mask_words = event.payload.0.len().div_ceil(64).max(1);
    let mut at = mask_words;
    let mut fields = Vec::with_capacity(event.payload.0.len());
    for (name, field) in &event.payload.0 {
        let (slot, len) = field_slot(name, field, at);
        fields.push(slot);
        at += len;
    }
    EventSlot {
        name: event.name.clone(),
        fields,
        mask_words,
        words: at,
        wakes: event.wakes.as_deref().is_some_and(|w| w != "never"),
        large: event.large == Some(true),
    }
}

/// FNV-1a, 64 bits.
fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

impl Layout {
    /// The layout of a manifest's region. `ring_slots` is rounded up to a
    /// power of two.
    pub fn of(manifest: &Manifest, ring_slots: usize) -> Self {
        let counters_at = header::LEN;
        let decisions: Vec<String> = manifest.decisions.iter().map(|d| d.name.clone()).collect();
        let turns: Vec<String> = manifest.turns.iter().map(|t| t.name.clone()).collect();
        let mut at = counters_at + decisions.len() + turns.len();

        let mut cells = Vec::with_capacity(manifest.cells.len());
        for cell in &manifest.cells {
            let (slot, len) = cell_slot(cell, at);
            cells.push(slot);
            at += len;
        }

        let events: Vec<EventSlot> = manifest.events.iter().map(event_slot).collect();
        let payload_words = events
            .iter()
            .filter(|e| !e.large)
            .map(|e| e.words)
            .max()
            .unwrap_or(1);
        let ring_slots = ring_slots.max(2).next_power_of_two();
        let slot_words = 2 + payload_words;
        let ring_at = at;
        at += ring_slots * slot_words;
        let calls_at = at;
        at += calls::CALL_SLOTS * calls::CALL_SLOT_WORDS;

        let json = serde_json::to_vec(manifest).expect("a manifest serializes");
        Self {
            counters_at,
            decisions,
            turns,
            cells,
            events,
            ring_at,
            ring_slots,
            slot_words,
            calls_at,
            words: at,
            manifest_hash: fnv(&json),
        }
    }

    /// The index and slot of a cell.
    pub fn cell(&self, name: &str) -> Option<(usize, &CellSlot)> {
        self.cells.iter().enumerate().find(|(_, c)| c.name == name)
    }

    /// The index and slot of an event.
    pub fn event(&self, name: &str) -> Option<(usize, &EventSlot)> {
        self.events.iter().enumerate().find(|(_, e)| e.name == name)
    }

    /// The word of a decision's counter.
    pub fn decision_counter(&self, name: &str) -> Option<usize> {
        let index = self.decisions.iter().position(|d| d == name)?;
        Some(self.counters_at + index)
    }

    /// The word of a turn's counter.
    pub fn turn_counter(&self, name: &str) -> Option<usize> {
        let index = self.turns.iter().position(|t| t == name)?;
        Some(self.counters_at + self.decisions.len() + index)
    }
}

/// What wakes a parked harness. One call is at most one system call.
pub trait Wake: Send + Sync {
    fn wake(&self);
}

/// The waker in force, replaceable without a lock. A replaced waker is
/// never freed, since an emitter may be inside it; attaches are rare.
struct WakeSlot(AtomicPtr<Box<dyn Wake>>);

impl WakeSlot {
    fn set(&self, waker: Box<dyn Wake>) {
        let fresh = Box::into_raw(Box::new(waker));
        self.0.store(fresh, Ordering::Release);
    }

    fn wake(&self) {
        let current = self.0.load(Ordering::Acquire);
        if !current.is_null() {
            // SAFETY: a non-null pointer here came from `Box::into_raw` in
            // `set` and is never freed, so it points to a live waker.
            unsafe { (*current).wake() }
        }
    }
}

/// Where a region's words are.
enum Words {
    /// Ordinary process memory.
    Owned(Box<[AtomicU64]>),
    /// A segment another process maps too.
    #[cfg(unix)]
    Mapped(shm::Mapping),
}

impl Words {
    fn get(&self) -> &[AtomicU64] {
        match self {
            Self::Owned(words) => words,
            #[cfg(unix)]
            Self::Mapped(mapping) => mapping.words(),
        }
    }
}

/// The region of one program: its words, their layout, and this process's
/// way of waking the harness.
pub struct Region {
    words: Words,
    pub layout: Layout,
    waker: WakeSlot,
}

impl std::fmt::Debug for Region {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Region")
            .field("words", &self.words.get().len())
            .finish_non_exhaustive()
    }
}

impl Deref for Region {
    type Target = [AtomicU64];

    fn deref(&self) -> &[AtomicU64] {
        self.words.get()
    }
}

impl Region {
    /// A region in process memory, with every knob at its default.
    pub fn in_process(manifest: &Manifest, ring_slots: usize) -> Arc<Self> {
        let layout = Layout::of(manifest, ring_slots);
        // zeroed memory from the allocator is not touched until it is
        // used, so a large ring costs nothing at startup
        let zeroed: Box<[u64]> = vec![0u64; layout.words].into_boxed_slice();
        // SAFETY: `AtomicU64` has the same size, alignment and bit
        // validity as `u64`, so the allocation can change its element
        // type in place; the box is the allocation's only owner.
        let words: Box<[AtomicU64]> =
            unsafe { Box::from_raw(Box::into_raw(zeroed) as *mut [AtomicU64]) };
        let region = Self {
            words: Words::Owned(words),
            layout,
            waker: WakeSlot(AtomicPtr::new(std::ptr::null_mut())),
        };
        region.stamp(manifest);
        Arc::new(region)
    }

    /// Write the header and every knob's default into fresh, zeroed words.
    fn stamp(&self, manifest: &Manifest) {
        self[header::VERSION].store(LAYOUT_VERSION, Ordering::Relaxed);
        self[header::WORDS].store(self.layout.words as u64, Ordering::Relaxed);
        self[header::MANIFEST].store(self.layout.manifest_hash, Ordering::Relaxed);
        self[header::RING_SLOTS].store(self.layout.ring_slots as u64, Ordering::Relaxed);
        for (index, cell) in manifest.cells.iter().enumerate() {
            if let Some(default) = &cell.default {
                cells::write_default(self, index, default);
            }
        }
        // the magic goes in last: a process that maps the segment early
        // does not take a half-written region for a whole one
        self[header::MAGIC].store(MAGIC, Ordering::SeqCst);
    }

    /// A region in a shared segment this process creates at `path`, for
    /// sidecar mode (contract section 6.3).
    #[cfg(unix)]
    pub fn create_shared(
        manifest: &Manifest,
        ring_slots: usize,
        path: &std::path::Path,
    ) -> std::io::Result<Arc<Self>> {
        let layout = Layout::of(manifest, ring_slots);
        let region = Self {
            words: Words::Mapped(shm::Mapping::create(path, layout.words)?),
            layout,
            waker: WakeSlot(AtomicPtr::new(std::ptr::null_mut())),
        };
        region.stamp(manifest);
        Ok(Arc::new(region))
    }

    /// The region of another process, mapped from the segment at `path`.
    /// `manifest` is the one that process gave: a segment that is not the
    /// region of that manifest, in this build's layout, is refused.
    #[cfg(unix)]
    pub fn open_shared(manifest: &Manifest, path: &std::path::Path) -> Result<Arc<Self>, String> {
        let mapping = shm::Mapping::open(path).map_err(|error| {
            format!(
                "the region at {} could not be mapped: {error}",
                path.display()
            )
        })?;
        let words = mapping.words();
        let refuse =
            |why: String| format!("{} is not this program's region: {why}", path.display());
        if words.len() < header::LEN {
            return Err(refuse(format!("{} words", words.len())));
        }
        let word = |index: usize| words[index].load(Ordering::SeqCst);
        if word(header::MAGIC) != MAGIC {
            return Err(refuse("no magic".to_string()));
        }
        if word(header::VERSION) != LAYOUT_VERSION {
            return Err(refuse(format!(
                "layout version {}, and this harness reads version {LAYOUT_VERSION}",
                word(header::VERSION)
            )));
        }
        let ring_slots = usize::try_from(word(header::RING_SLOTS)).unwrap_or(usize::MAX);
        if ring_slots > words.len() {
            return Err(refuse(format!("{ring_slots} ring slots")));
        }
        let layout = Layout::of(manifest, ring_slots);
        if layout.ring_slots != ring_slots
            || layout.words != words.len()
            || word(header::WORDS) != layout.words as u64
            || word(header::MANIFEST) != layout.manifest_hash
        {
            return Err(refuse("the manifest does not match it".to_string()));
        }
        Ok(Arc::new(Self {
            words: Words::Mapped(mapping),
            layout,
            waker: WakeSlot(AtomicPtr::new(std::ptr::null_mut())),
        }))
    }

    /// Whether a harness is attached. One load.
    pub fn attached(&self) -> bool {
        self[header::ATTACHED].load(Ordering::Relaxed) != 0
    }

    /// Set the way this process wakes the harness.
    pub fn set_waker(&self, waker: Box<dyn Wake>) {
        self.waker.set(waker);
    }

    /// Wake the harness if it is parked: one swap of the parked flag, and
    /// one wake call when the flag was set.
    ///
    /// For no wake to be lost the harness parks like this: it sets its
    /// waker before it first parks; it stores 1 to the parked flag; it
    /// then asks whether a position past its tail has been claimed
    /// (`ring::Reader::pending`), and blocks without a time limit only
    /// when none has. A claimed position that is not published yet is
    /// waited for with a time limit. The wake must be one that is kept if
    /// it comes before the harness blocks.
    pub fn wake_if_parked(&self) {
        let parked = &self[header::PARKED];
        if parked.load(Ordering::SeqCst) == 1
            && parked
                .compare_exchange(1, 0, Ordering::SeqCst, Ordering::Relaxed)
                .is_ok()
        {
            self[header::WAKES].fetch_add(1, Ordering::Relaxed);
            self.waker.wake();
        }
    }
}

/// Pack bytes into words, eight to a word, little end first.
pub(crate) fn store_bytes(words: &[AtomicU64], bytes: &[u8]) {
    for (word, chunk) in words.iter().zip(bytes.chunks(8)) {
        let mut eight = [0u8; 8];
        eight[..chunk.len()].copy_from_slice(chunk);
        word.store(u64::from_le_bytes(eight), Ordering::Relaxed);
    }
}

/// Unpack `len` bytes from words.
pub(crate) fn load_bytes(words: &[AtomicU64], len: usize) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(words_for(len) * 8);
    for word in &words[..words_for(len)] {
        bytes.extend_from_slice(&word.load(Ordering::Relaxed).to_le_bytes());
    }
    bytes.truncate(len);
    bytes
}

/// Writes bytes into words as they come, up to a cap, without allocating.
///
/// Past the cap it keeps nothing and remembers that it overflowed. It
/// reports no error while writing, because the JSON encoder would box
/// one, and a write on the program's thread must not allocate.
pub(crate) struct WordWriter<'a> {
    words: &'a [AtomicU64],
    cap: usize,
    len: usize,
    pending: [u8; 8],
    overflowed: bool,
}

impl<'a> WordWriter<'a> {
    pub(crate) fn new(words: &'a [AtomicU64], cap: usize) -> Self {
        Self {
            words,
            cap,
            len: 0,
            pending: [0; 8],
            overflowed: false,
        }
    }

    /// Store the last partial word and return the length written, or None
    /// when the bytes did not fit.
    pub(crate) fn finish(self) -> Option<usize> {
        if self.overflowed {
            return None;
        }
        let rest = self.len % 8;
        if rest != 0 {
            let mut eight = [0u8; 8];
            eight[..rest].copy_from_slice(&self.pending[..rest]);
            self.words[self.len / 8].store(u64::from_le_bytes(eight), Ordering::Relaxed);
        }
        Some(self.len)
    }
}

impl std::io::Write for WordWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.overflowed || self.len + bytes.len() > self.cap {
            self.overflowed = true;
            return Ok(bytes.len());
        }
        for byte in bytes {
            self.pending[self.len % 8] = *byte;
            self.len += 1;
            if self.len.is_multiple_of(8) {
                self.words[self.len / 8 - 1]
                    .store(u64::from_le_bytes(self.pending), Ordering::Relaxed);
            }
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::declare::{Cell, Decision, Declarations, Event, Turn};
    use crate::manifest::{Mode, Schema};
    use std::io::Write;

    pub(crate) fn manifest() -> Manifest {
        Declarations::new("region", [Mode::Thread])
            .cell(Cell::int("count", "A count."))
            .cell(Cell::float("ratio", "A ratio."))
            .cell(Cell::bool("busy", "Whether it is busy."))
            .cell(Cell::enumeration(
                "phase",
                ["idle", "running", "done"],
                "The phase.",
            ))
            .cell(Cell::string("label", "A label.").max(20))
            .cell(Cell::list("recent", Field::int(), "The last few counts.").max(64))
            .cell(Cell::int("step", "The step.").knob(3).range_int(1, 100))
            .cell(Cell::enumeration("speed", ["slow", "fast"], "The speed.").knob("fast"))
            .cell(Cell::string("motto", "The motto.").knob("steady").max(32))
            .event(
                Event::new("tick", "One tick.").payload(
                    Schema::new()
                        .field("n", Field::int())
                        .field("triple", Field::int())
                        .field("text", Field::string().max(24)),
                ),
            )
            .event(
                Event::new("alarm", "Something is wrong.")
                    .payload(
                        Schema::new()
                            .field("level", Field::enumeration(["low", "high"]))
                            .field("ok", Field::bool())
                            .field("ratio", Field::float())
                            .field("tags", Field::list(Field::string()).max(40)),
                    )
                    .wakes_always(),
            )
            .event(
                Event::new("dump", "A big one.")
                    .payload(Schema::new().field("body", Field::string().max(100_000)))
                    .large(),
            )
            .decision(Decision::options(
                "on_limit",
                ["wrap", "stop"],
                "stop",
                "5s",
                "At the limit.",
            ))
            .turn(Turn::new("each_lap", "30s", "After a lap."))
            .manifest()
            .unwrap()
    }

    #[test]
    fn the_layout_places_everything_once() {
        let layout = Layout::of(&manifest(), 8);
        assert_eq!(layout.counters_at, header::LEN);
        assert_eq!(layout.decision_counter("on_limit"), Some(header::LEN));
        assert_eq!(layout.turn_counter("each_lap"), Some(header::LEN + 1));
        assert_eq!(layout.decision_counter("each_lap"), None);

        let (_, count) = layout.cell("count").unwrap();
        assert_eq!(
            (count.at, count.kind, count.knob),
            (header::LEN + 2, Kind::Int, false)
        );
        let (_, label) = layout.cell("label").unwrap();
        assert_eq!((label.kind, label.max), (Kind::Text, 20));
        let (_, recent) = layout.cell("recent").unwrap();
        // label: a version, a length and three words of bytes
        assert_eq!(recent.at, label.at + 2 + 3);
        let (_, speed) = layout.cell("speed").unwrap();
        assert_eq!(speed.values, ["slow", "fast"]);
        assert!(speed.knob);

        let (_, tick) = layout.event("tick").unwrap();
        // one word of presence bits, two scalars, a length and three words of text
        assert_eq!(
            (tick.mask_words, tick.words, tick.wakes),
            (1, 1 + 2 + 1 + 3, false)
        );
        assert_eq!(tick.fields[2].at, 3);
        let (_, alarm) = layout.event("alarm").unwrap();
        assert_eq!((alarm.words, alarm.wakes), (1 + 3 + 1 + 5, true));
        // the large event does not size the slot
        assert_eq!(layout.slot_words, 2 + alarm.words);
        assert_eq!(layout.ring_slots, 8);
        assert_eq!(layout.calls_at, layout.ring_at + 8 * layout.slot_words);
        assert_eq!(
            layout.words,
            layout.calls_at + calls::CALL_SLOTS * calls::CALL_SLOT_WORDS
        );
    }

    #[test]
    fn the_layout_is_the_same_for_the_same_manifest() {
        let a = Layout::of(&manifest(), 5);
        let b = Layout::of(&manifest(), 5);
        assert_eq!(a, b);
        assert_eq!(a.ring_slots, 8);
        let mut other = manifest();
        other.cells[0].doc.push('!');
        assert_ne!(Layout::of(&other, 5).manifest_hash, a.manifest_hash);
    }

    #[test]
    fn a_new_region_has_its_header_and_is_detached() {
        let region = Region::in_process(&manifest(), 8);
        assert_eq!(region[header::MAGIC].load(Ordering::Relaxed), MAGIC);
        assert_eq!(
            region[header::VERSION].load(Ordering::Relaxed),
            LAYOUT_VERSION
        );
        assert_eq!(
            region[header::WORDS].load(Ordering::Relaxed) as usize,
            region.len()
        );
        assert_eq!(region[header::RING_SLOTS].load(Ordering::Relaxed), 8);
        assert!(!region.attached());
    }

    #[test]
    fn bytes_pack_into_words_and_back() {
        let words: Vec<AtomicU64> = (0..3).map(|_| AtomicU64::new(u64::MAX)).collect();
        let text = b"hello, region";
        store_bytes(&words, text);
        assert_eq!(load_bytes(&words, text.len()), text);
        assert_eq!(load_bytes(&words, 0), b"");
    }

    #[test]
    fn a_word_writer_stops_at_its_cap() {
        let words: Vec<AtomicU64> = (0..2).map(|_| AtomicU64::new(0)).collect();
        let mut writer = WordWriter::new(&words, 11);
        writer.write_all(b"0123").unwrap();
        writer.write_all(b"4567890").unwrap();
        assert_eq!(writer.finish(), Some(11));
        assert_eq!(load_bytes(&words, 11), b"01234567890");

        // past the cap nothing more is kept, and no error is made
        let mut over = WordWriter::new(&words, 11);
        over.write_all(b"0123456789").unwrap();
        over.write_all(b"ab").unwrap();
        over.write_all(b"c").unwrap();
        assert_eq!(over.finish(), None);
    }

    struct Count(Arc<AtomicU64>);
    impl Wake for Count {
        fn wake(&self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn a_wake_happens_once_per_park() {
        let region = Region::in_process(&manifest(), 8);
        let calls = Arc::new(AtomicU64::new(0));
        region.wake_if_parked();
        region.set_waker(Box::new(Count(calls.clone())));
        region.wake_if_parked();
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        region[header::PARKED].store(1, Ordering::SeqCst);
        region.wake_if_parked();
        region.wake_if_parked();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(region[header::PARKED].load(Ordering::SeqCst), 0);
        assert_eq!(region[header::WAKES].load(Ordering::Relaxed), 1);
    }
}
