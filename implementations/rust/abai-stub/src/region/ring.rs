//! The event ring (contract section 5.1).
//!
//! Many producers, one reader, and the oldest unread event is overwritten
//! when the ring wraps. An emit never blocks, allocates or locks: one load
//! of the attached flag, one atomic increment that claims a position, a
//! bounded copy into the slot between two stores of its sequence word, and
//! at most one wake.
//!
//! A slot's sequence word says who holds it. `busy(p)` is a producer
//! writing position `p`; `published(p)` is the finished event of position
//! `p`. A producer takes its slot with one compare-and-swap from a
//! not-busy word. If the slot is still busy, a producer one whole ring
//! behind has not finished: this emit is dropped and counted, which the
//! contract allows, so no slot ever has two writers and no reader ever
//! takes a torn payload for a whole one.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering, fence};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};

use super::cells::HandleError;
use super::{EventSlot, FieldSlot, Kind, Region, WordWriter, header, store_bytes};
use crate::manifest::cut_utf8;

/// A sized field in the slot was cut to its `max`.
const FLAG_TRUNCATED: u64 = 1 << 32;
/// The slot holds no event: its producer gave up after claiming it.
const FLAG_VOID: u64 = 1 << 33;

/// How long the reader waits for a claimed position to be published
/// before it counts the position as dropped.
pub const STALL: Duration = Duration::from_millis(100);

fn busy(position: u64) -> u64 {
    (position << 1) | 1
}

fn published(position: u64) -> u64 {
    (position + 1) << 1
}

/// The position a slot's sequence word speaks of, if any.
fn position_of(sequence: u64) -> Option<u64> {
    if sequence & 1 == 1 {
        Some(sequence >> 1)
    } else if sequence == 0 {
        None
    } else {
        Some((sequence >> 1) - 1)
    }
}

/// An event the program emits.
#[derive(Debug, Clone)]
pub struct Event {
    region: Arc<Region>,
    index: usize,
}

/// Publishes the slot when the producer is done with it, however it ends.
struct Claim<'a> {
    sequence: &'a AtomicU64,
    about: &'a AtomicU64,
    position: u64,
    word: u64,
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        self.about.store(self.word, Ordering::Relaxed);
        self.sequence
            .store(published(self.position), Ordering::Release);
    }
}

impl Event {
    pub fn new(region: &Arc<Region>, name: &str) -> Result<Self, HandleError> {
        let (index, _) = region
            .layout
            .event(name)
            .ok_or_else(|| HandleError::Unknown(name.to_string()))?;
        Ok(Self {
            region: region.clone(),
            index,
        })
    }

    /// Emit the event. `fill` writes the payload's fields, straight into
    /// the event's slot; a field it does not write is absent. With no
    /// harness attached this is one load and `fill` is not called.
    pub fn emit(&self, fill: impl FnOnce(&mut Payload<'_>)) {
        let region = &*self.region;
        if region[header::ATTACHED].load(Ordering::Relaxed) == 0 {
            return;
        }
        let layout = &region.layout;
        let event = &layout.events[self.index];
        if event.large {
            // the arena is not built yet: a large payload has nowhere to go
            region[header::ARENA_DROPPED].fetch_add(1, Ordering::Relaxed);
            return;
        }

        let position = region[header::RING_HEAD].fetch_add(1, Ordering::SeqCst);
        let slot = (position as usize) & (layout.ring_slots - 1);
        let base = layout.ring_at + slot * layout.slot_words;
        let sequence = &region[base];
        let seen = sequence.load(Ordering::Relaxed);
        // busy: a producer a ring behind has not finished. A later position:
        // this producer was itself overtaken by a whole ring between its
        // claim and now, and must not put the slot's sequence back.
        if seen & 1 == 1
            || position_of(seen).is_some_and(|held| held > position)
            || sequence
                .compare_exchange(seen, busy(position), Ordering::Acquire, Ordering::Relaxed)
                .is_err()
        {
            region[header::EVENTS_LAPPED].fetch_add(1, Ordering::Relaxed);
            return;
        }

        // the busy word must be visible before any payload word is, or a
        // reader could copy new words under the old sequence
        fence(Ordering::Release);

        let mut claim = Claim {
            sequence,
            about: &region[base + 1],
            position,
            word: self.index as u64 | FLAG_VOID,
        };
        let words = &region[base + 2..base + 2 + event.words];
        for mask in &words[..event.mask_words] {
            mask.store(0, Ordering::Relaxed);
        }
        let mut payload = Payload {
            words,
            event,
            truncated: false,
            misused: false,
        };
        fill(&mut payload);
        if payload.misused {
            region[header::MISUSE].fetch_add(1, Ordering::Relaxed);
        }
        claim.word = self.index as u64 | if payload.truncated { FLAG_TRUNCATED } else { 0 };
        drop(claim);

        if event.wakes {
            region.wake_if_parked();
        }
    }
}

/// The payload of an event being emitted. Each method writes one declared
/// field by name. A name the event lacks, or a method of the wrong type,
/// writes nothing and is counted; it never panics.
#[derive(Debug)]
pub struct Payload<'a> {
    words: &'a [AtomicU64],
    event: &'a EventSlot,
    truncated: bool,
    misused: bool,
}

impl<'a> Payload<'a> {
    fn field(&mut self, name: &str, kind: Kind) -> Option<(usize, &'a FieldSlot)> {
        let event: &'a EventSlot = self.event;
        let found = event
            .fields
            .iter()
            .enumerate()
            .find(|(_, f)| f.name == name && f.kind == kind);
        if found.is_none() {
            self.misused = true;
        }
        found
    }

    fn mark(&self, index: usize) {
        let mask = &self.words[index / 64];
        mask.store(
            mask.load(Ordering::Relaxed) | (1 << (index % 64)),
            Ordering::Relaxed,
        );
    }

    fn unmark(&self, index: usize) {
        let mask = &self.words[index / 64];
        mask.store(
            mask.load(Ordering::Relaxed) & !(1 << (index % 64)),
            Ordering::Relaxed,
        );
    }

    fn scalar(&mut self, name: &str, kind: Kind, word: u64) {
        if let Some((index, field)) = self.field(name, kind) {
            self.words[field.at].store(word, Ordering::Relaxed);
            self.mark(index);
        }
    }

    pub fn bool(&mut self, name: &str, value: bool) {
        self.scalar(name, Kind::Bool, u64::from(value));
    }

    pub fn int(&mut self, name: &str, value: i64) {
        self.scalar(name, Kind::Int, value as u64);
    }

    pub fn float(&mut self, name: &str, value: f64) {
        self.scalar(name, Kind::Float, value.to_bits());
    }

    /// Write an `enum` field by one of its declared values.
    pub fn symbol(&mut self, name: &str, value: &str) {
        let Some((index, field)) = self.field(name, Kind::Enum) else {
            return;
        };
        match field.values.iter().position(|v| v == value) {
            Some(word) => {
                self.words[field.at].store(word as u64, Ordering::Relaxed);
                self.mark(index);
            }
            None => self.misused = true,
        }
    }

    /// Write a `string` field, cut to its `max` on a character boundary.
    pub fn text(&mut self, name: &str, value: &str) {
        let Some((index, field)) = self.field(name, Kind::Text) else {
            return;
        };
        let bytes = cut_utf8(value, field.max).as_bytes();
        let cut = bytes.len() < value.len();
        self.words[field.at].store(bytes.len() as u64, Ordering::Relaxed);
        store_bytes(&self.words[field.at + 1..], bytes);
        self.mark(index);
        self.truncated |= cut;
    }

    /// Write an `object` or `list` field as JSON, straight into the slot.
    /// A value whose JSON is longer than the field's `max` cannot be cut:
    /// the field is left absent and the event is marked truncated.
    pub fn json<T: Serialize + ?Sized>(&mut self, name: &str, value: &T) {
        let Some((index, field)) = self.field(name, Kind::Json) else {
            return;
        };
        let mut writer = WordWriter::new(&self.words[field.at + 1..], field.max);
        let written = serde_json::to_writer(&mut writer, value).is_ok();
        match writer.finish() {
            Some(len) if written => {
                self.words[field.at].store(len as u64, Ordering::Relaxed);
                self.mark(index);
            }
            _ => {
                self.unmark(index);
                self.truncated = true;
            }
        }
    }
}

/// What the reader takes from the ring.
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    Event {
        /// The event's position in the stream, dense from the attach.
        position: u64,
        /// The index of the event's declaration.
        event: usize,
        payload: Map<String, Value>,
        /// A sized field was cut or left out for want of room.
        truncated: bool,
    },
    /// This many events were lost at this place in the stream.
    Dropped(u64),
}

/// The harness's end of the ring. There is one reader.
#[derive(Debug)]
pub struct Reader {
    region: Arc<Region>,
    tail: u64,
    stalled: Option<Instant>,
    copy: Vec<u64>,
}

impl Reader {
    /// A reader that starts at the ring's head: events are for an attached
    /// harness, so nothing emitted before now is read.
    pub fn new(region: &Arc<Region>) -> Self {
        let slot_words = region.layout.slot_words;
        Self {
            region: region.clone(),
            tail: region[header::RING_HEAD].load(Ordering::SeqCst),
            stalled: None,
            copy: vec![0; slot_words],
        }
    }

    /// The position of the next event to read.
    pub fn tail(&self) -> u64 {
        self.tail
    }

    /// The next position a producer will claim.
    pub fn head(&self) -> u64 {
        self.region[header::RING_HEAD].load(Ordering::SeqCst)
    }

    /// Whether a position past the tail has been claimed.
    pub fn pending(&self) -> bool {
        self.region[header::RING_HEAD].load(Ordering::SeqCst) > self.tail
    }

    fn skip(&mut self, count: u64) -> Option<Item> {
        self.tail += count;
        self.stalled = None;
        Some(Item::Dropped(count))
    }

    /// The next item, in order, or None when nothing is ready. `now` is
    /// the caller's clock; a claimed position that stays unpublished for
    /// [`STALL`] is given up as dropped.
    pub fn next(&mut self, now: Instant) -> Option<Item> {
        let region = self.region.clone();
        let layout = &region.layout;
        let head = region[header::RING_HEAD].load(Ordering::SeqCst);
        if head <= self.tail {
            self.stalled = None;
            return None;
        }
        let slots = layout.ring_slots as u64;
        if head - self.tail > slots {
            // the ring wrapped past the tail: what was overwritten is gone
            return self.skip(head - self.tail - slots);
        }

        let slot = (self.tail as usize) & (layout.ring_slots - 1);
        let base = layout.ring_at + slot * layout.slot_words;
        let words = &region[base..base + layout.slot_words];
        let before = words[0].load(Ordering::Acquire);
        if before == published(self.tail) {
            for (copy, word) in self.copy.iter_mut().zip(words) {
                *copy = word.load(Ordering::Relaxed);
            }
            fence(Ordering::Acquire);
            if words[0].load(Ordering::Relaxed) != before {
                // a producer a ring ahead took the slot while it was read
                return self.skip(1);
            }
            let about = self.copy[1];
            let position = self.tail;
            self.tail += 1;
            self.stalled = None;
            let index = (about & 0xffff_ffff) as usize;
            // a word naming no event, or one that never sits in a slot, is
            // not this program's writing: count it and go on
            let known = layout.events.get(index).is_some_and(|e| !e.large);
            if about & FLAG_VOID != 0 || !known {
                return Some(Item::Dropped(1));
            }
            return Some(Item::Event {
                position,
                event: index,
                payload: decode(&layout.events[index], &self.copy[2..]),
                truncated: about & FLAG_TRUNCATED != 0,
            });
        }
        if position_of(before).is_some_and(|p| p > self.tail) {
            // the slot already belongs to a later position
            return self.skip(1);
        }
        // claimed and not yet published: its producer is still writing, or
        // was dropped because the slot was busy
        match self.stalled {
            None => {
                self.stalled = Some(now);
                None
            }
            Some(since) if now.duration_since(since) >= STALL => self.skip(1),
            Some(_) => None,
        }
    }
}

fn decode(event: &EventSlot, words: &[u64]) -> Map<String, Value> {
    let mut payload = Map::new();
    for (index, field) in event.fields.iter().enumerate() {
        if words[index / 64] & (1 << (index % 64)) == 0 {
            continue;
        }
        let word = words[field.at];
        let value = match field.kind {
            Kind::Bool => Value::Bool(word != 0),
            Kind::Int => Value::from(word as i64),
            Kind::Float => serde_json::Number::from_f64(f64::from_bits(word))
                .map_or(Value::Null, Value::Number),
            Kind::Enum => field
                .values
                .get(word as usize)
                .map_or(Value::Null, |v| Value::String(v.clone())),
            Kind::Text | Kind::Json => {
                let len = (word as usize).min(field.max);
                let mut bytes = Vec::with_capacity(len.div_ceil(8) * 8);
                for word in &words[field.at + 1..field.at + 1 + len.div_ceil(8)] {
                    bytes.extend_from_slice(&word.to_le_bytes());
                }
                bytes.truncate(len);
                if field.kind == Kind::Text {
                    Value::String(String::from_utf8_lossy(&bytes).into_owned())
                } else {
                    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
                }
            }
        };
        payload.insert(field.name.clone(), value);
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::region::Wake;
    use crate::region::tests::manifest;
    use serde_json::json;

    fn attached(slots: usize) -> Arc<Region> {
        let region = Region::in_process(&manifest(), slots);
        region[header::ATTACHED].store(1, Ordering::SeqCst);
        region
    }

    fn drain(reader: &mut Reader) -> Vec<Item> {
        let now = Instant::now();
        std::iter::from_fn(|| reader.next(now)).collect()
    }

    fn tick(event: &Event, n: i64) {
        event.emit(|p| {
            p.int("n", n);
            p.int("triple", n * 3);
        });
    }

    fn numbers(items: &[Item]) -> Vec<i64> {
        items
            .iter()
            .filter_map(|item| match item {
                Item::Event { payload, .. } => payload.get("n").and_then(Value::as_i64),
                Item::Dropped(_) => None,
            })
            .collect()
    }

    #[test]
    fn an_emit_with_no_harness_does_nothing() {
        let region = Region::in_process(&manifest(), 8);
        let event = Event::new(&region, "tick").unwrap();
        let mut called = false;
        event.emit(|_| called = true);
        assert!(!called);
        assert_eq!(region[header::RING_HEAD].load(Ordering::SeqCst), 0);
        assert!(Event::new(&region, "nothing").is_err());
    }

    #[test]
    fn events_arrive_in_order_with_their_fields() {
        let region = attached(8);
        let tick_event = Event::new(&region, "tick").unwrap();
        let alarm = Event::new(&region, "alarm").unwrap();
        let mut reader = Reader::new(&region);
        assert_eq!(reader.next(Instant::now()), None);

        tick(&tick_event, 1);
        alarm.emit(|p| {
            p.symbol("level", "high");
            p.bool("ok", false);
            p.float("ratio", 0.5);
            p.json("tags", &["a", "b"]);
        });
        tick_event.emit(|p| p.text("text", "only text"));

        let items = drain(&mut reader);
        let (_, alarm_slot) = region.layout.event("alarm").unwrap();
        assert_eq!(alarm_slot.fields.len(), 4);
        assert_eq!(
            items,
            [
                Item::Event {
                    position: 0,
                    event: 0,
                    payload: json!({"n": 1, "triple": 3}).as_object().unwrap().clone(),
                    truncated: false,
                },
                Item::Event {
                    position: 1,
                    event: 1,
                    payload:
                        json!({"level": "high", "ok": false, "ratio": 0.5, "tags": ["a", "b"]})
                            .as_object()
                            .unwrap()
                            .clone(),
                    truncated: false,
                },
                Item::Event {
                    position: 2,
                    event: 0,
                    payload: json!({"text": "only text"}).as_object().unwrap().clone(),
                    truncated: false,
                },
            ]
        );
        assert!(!reader.pending());
    }

    #[test]
    fn a_reader_starts_at_the_attach() {
        let region = attached(8);
        let event = Event::new(&region, "tick").unwrap();
        tick(&event, 1);
        tick(&event, 2);
        let mut reader = Reader::new(&region);
        tick(&event, 3);
        assert_eq!(numbers(&drain(&mut reader)), [3]);
        assert_eq!(reader.tail(), 3);
    }

    #[test]
    fn sized_fields_are_cut_and_the_event_says_so() {
        let region = attached(8);
        let tick_event = Event::new(&region, "tick").unwrap();
        let alarm = Event::new(&region, "alarm").unwrap();
        let mut reader = Reader::new(&region);
        tick_event.emit(|p| p.text("text", "a text of more than twenty-four bytes"));
        alarm.emit(|p| {
            p.bool("ok", true);
            p.json("tags", &vec!["a long tag"; 20]);
        });
        let items = drain(&mut reader);
        let Item::Event {
            payload, truncated, ..
        } = &items[0]
        else {
            panic!("an event");
        };
        assert_eq!(payload["text"], json!("a text of more than twen"));
        assert!(truncated);
        let Item::Event {
            payload, truncated, ..
        } = &items[1]
        else {
            panic!("an event");
        };
        assert_eq!(payload.len(), 1);
        assert_eq!(payload["ok"], json!(true));
        assert!(truncated);
    }

    #[test]
    fn a_wrong_field_is_counted_and_not_written() {
        let region = attached(8);
        let event = Event::new(&region, "tick").unwrap();
        let alarm = Event::new(&region, "alarm").unwrap();
        let mut reader = Reader::new(&region);
        event.emit(|p| {
            p.int("n", 1);
            p.int("nothing", 2);
            p.text("n", "not a string");
        });
        alarm.emit(|p| p.symbol("level", "medium"));
        let items = drain(&mut reader);
        assert_eq!(numbers(&items), [1]);
        let Item::Event { payload, .. } = &items[1] else {
            panic!("an event");
        };
        assert!(payload.is_empty());
        assert_eq!(region[header::MISUSE].load(Ordering::Relaxed), 2);
    }

    #[test]
    fn a_wrapped_ring_reports_what_was_lost() {
        let region = attached(4);
        let event = Event::new(&region, "tick").unwrap();
        let mut reader = Reader::new(&region);
        for n in 0..10 {
            tick(&event, n);
        }
        let items = drain(&mut reader);
        assert_eq!(items[0], Item::Dropped(6));
        assert_eq!(numbers(&items), [6, 7, 8, 9]);
        tick(&event, 10);
        assert_eq!(numbers(&drain(&mut reader)), [10]);
    }

    #[test]
    fn a_large_event_is_dropped_and_counted_for_now() {
        let region = attached(4);
        let dump = Event::new(&region, "dump").unwrap();
        dump.emit(|p| p.text("body", "big"));
        assert_eq!(region[header::ARENA_DROPPED].load(Ordering::Relaxed), 1);
        assert_eq!(region[header::RING_HEAD].load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_slot_that_is_still_busy_drops_the_emit_that_laps_it() {
        let region = attached(4);
        let event = Event::new(&region, "tick").unwrap();
        let mut reader = Reader::new(&region);
        // a producer that claimed position 0 and has not finished
        let layout = &region.layout;
        region[header::RING_HEAD].store(1, Ordering::SeqCst);
        region[layout.ring_at].store(busy(0), Ordering::SeqCst);

        let start = Instant::now();
        assert_eq!(reader.next(start), None);
        assert_eq!(reader.next(start + STALL / 2), None);
        for n in 1..=4 {
            tick(&event, n);
        }
        // position 4 wanted the busy slot
        assert_eq!(region[header::EVENTS_LAPPED].load(Ordering::Relaxed), 1);
        assert_eq!(region[layout.ring_at].load(Ordering::SeqCst), busy(0));

        // the reader gives position 0 up after the stall, reads 1 to 3, then waits on 4
        assert_eq!(reader.next(start + STALL), Some(Item::Dropped(1)));
        let later = start + STALL;
        let mut items = Vec::new();
        while let Some(item) = reader.next(later) {
            items.push(item);
        }
        assert_eq!(numbers(&items), [1, 2, 3]);
        assert_eq!(reader.tail(), 4);
        assert_eq!(reader.next(later + STALL), Some(Item::Dropped(1)));
        assert!(!reader.pending());
    }

    #[test]
    fn a_producer_overtaken_by_a_whole_ring_leaves_the_newer_event() {
        let region = attached(4);
        let event = Event::new(&region, "tick").unwrap();
        let layout = &region.layout;
        // the producer of position 0 is about to look at its slot, and
        // position 4 has been published there meanwhile
        region[layout.ring_at].store(published(4), Ordering::SeqCst);
        tick(&event, 0);
        assert_eq!(region[header::EVENTS_LAPPED].load(Ordering::Relaxed), 1);
        assert_eq!(region[layout.ring_at].load(Ordering::SeqCst), published(4));
    }

    #[test]
    fn a_second_write_that_does_not_fit_leaves_the_field_absent() {
        let region = attached(4);
        let alarm = Event::new(&region, "alarm").unwrap();
        let mut reader = Reader::new(&region);
        alarm.emit(|p| {
            p.json("tags", &["first"]);
            p.json("tags", &vec!["a long tag"; 20]);
        });
        let items = drain(&mut reader);
        let Item::Event {
            payload, truncated, ..
        } = &items[0]
        else {
            panic!("an event");
        };
        assert!(payload.is_empty());
        assert!(truncated);
    }

    #[test]
    fn a_slot_that_names_no_slot_event_is_counted_as_lost() {
        let region = attached(4);
        let event = Event::new(&region, "tick").unwrap();
        let mut reader = Reader::new(&region);
        tick(&event, 1);
        tick(&event, 2);
        let layout = &region.layout;
        let (dump, _) = layout.event("dump").unwrap();
        region[layout.ring_at + 1].store(dump as u64, Ordering::SeqCst);
        region[layout.ring_at + layout.slot_words + 1].store(99, Ordering::SeqCst);
        assert_eq!(drain(&mut reader), [Item::Dropped(1), Item::Dropped(1)]);
    }

    #[test]
    fn a_producer_that_panics_leaves_no_busy_slot() {
        let region = attached(4);
        let event = Event::new(&region, "tick").unwrap();
        let mut reader = Reader::new(&region);
        let broken = event.clone();
        let result = std::thread::spawn(move || broken.emit(|_| panic!("the program's bug")));
        assert!(result.join().is_err());
        tick(&event, 2);
        let items = drain(&mut reader);
        assert_eq!(items[0], Item::Dropped(1));
        assert_eq!(numbers(&items), [2]);
    }

    struct Count(Arc<AtomicU64>);
    impl Wake for Count {
        fn wake(&self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn only_a_waking_event_wakes_and_only_a_parked_harness() {
        let region = attached(8);
        let calls = Arc::new(AtomicU64::new(0));
        region.set_waker(Box::new(Count(calls.clone())));
        let tick_event = Event::new(&region, "tick").unwrap();
        let alarm = Event::new(&region, "alarm").unwrap();

        alarm.emit(|p| p.bool("ok", true));
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        region[header::PARKED].store(1, Ordering::SeqCst);
        tick(&tick_event, 1);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        alarm.emit(|p| p.bool("ok", true));
        alarm.emit(|p| p.bool("ok", true));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn the_text_sits_in_the_slot_as_bytes() {
        let region = attached(4);
        let event = Event::new(&region, "tick").unwrap();
        event.emit(|p| p.text("text", "abc"));
        let layout = &region.layout;
        let (_, slot) = layout.event("tick").unwrap();
        let text = &slot.fields[2];
        let payload = layout.ring_at + 2;
        assert_eq!(region[payload + text.at].load(Ordering::Relaxed), 3);
        assert_eq!(
            crate::region::load_bytes(&region[payload + text.at + 1..], 3),
            b"abc"
        );
    }

    #[test]
    fn many_producers_and_a_reader_lose_nothing_unseen() {
        const PRODUCERS: i64 = 4;
        const EACH: i64 = 20_000;
        let region = attached(64);
        let mut reader = Reader::new(&region);

        let threads: Vec<_> = (0..PRODUCERS)
            .map(|producer| {
                let event = Event::new(&region, "tick").unwrap();
                std::thread::spawn(move || {
                    for i in 0..EACH {
                        let n = producer * 1_000_000 + i;
                        event.emit(|p| {
                            p.int("n", n);
                            p.int("triple", n * 3);
                            p.text("text", itoa(n, &mut [0u8; 24]));
                        });
                    }
                })
            })
            .collect();

        let mut delivered = 0u64;
        let mut dropped = 0u64;
        let mut last = vec![-1i64; PRODUCERS as usize];
        let mut take = |item: Item| match item {
            Item::Dropped(count) => dropped += count,
            Item::Event { payload, .. } => {
                let n = payload["n"].as_i64().unwrap();
                assert_eq!(payload["triple"].as_i64().unwrap(), n * 3, "a torn event");
                assert_eq!(
                    payload["text"].as_str().unwrap(),
                    n.to_string(),
                    "a torn event"
                );
                let producer = (n / 1_000_000) as usize;
                assert!(n > last[producer], "out of order within a producer");
                last[producer] = n;
                delivered += 1;
            }
        };
        while threads.iter().any(|t| !t.is_finished()) {
            while let Some(item) = reader.next(Instant::now()) {
                take(item);
            }
        }
        for thread in threads {
            thread.join().unwrap();
        }
        let end = Instant::now() + STALL * 2;
        while let Some(item) = reader.next(end) {
            take(item);
        }
        assert_eq!(delivered + dropped, (PRODUCERS * EACH) as u64);
        assert!(delivered > 0);
        assert!(!reader.pending());
    }

    /// Decimal digits without allocating, so the producers above test the
    /// path a program would take.
    fn itoa(n: i64, buffer: &mut [u8; 24]) -> &str {
        let mut at = buffer.len();
        let mut rest = n;
        loop {
            at -= 1;
            buffer[at] = b'0' + (rest % 10) as u8;
            rest /= 10;
            if rest == 0 {
                break;
            }
        }
        std::str::from_utf8(&buffer[at..]).unwrap()
    }
}
