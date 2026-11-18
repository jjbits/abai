//! Cells in the region (contract section 5.2).
//!
//! The program's side is the handles: [`Cell`], [`Knob`], [`EnumCell`],
//! [`EnumKnob`], [`TextCell`], [`JsonCell`]. A write is one or two word
//! stores, or a bounded copy between two version stores; a knob read is
//! one load. Nothing here allocates, locks or blocks.
//!
//! The harness's side is [`read`], [`write_scalar_knob`] and
//! [`write_mirror`].

use std::fmt;
use std::marker::PhantomData;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering, fence};

use serde::Serialize;
use serde_json::Value;

use super::{CellSlot, Kind, Region, WordWriter, load_bytes, store_bytes};
use crate::manifest::cut_utf8;

/// A length word that says the value is null.
const NULL_LEN: u64 = u64::MAX;
/// How often a reader retries a sized cell that a writer keeps changing.
const READ_TRIES: usize = 1000;

/// A handle could not be made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandleError {
    /// No cell or event of that name is declared.
    Unknown(String),
    /// The declaration is of another type or access than the handle.
    Mismatch { name: String, declared: String },
}

impl fmt::Display for HandleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unknown(name) => write!(f, "{name} is not declared"),
            Self::Mismatch { name, declared } => {
                write!(f, "{name} is declared as {declared}")
            }
        }
    }
}

impl std::error::Error for HandleError {}

fn describe(slot: &CellSlot) -> String {
    let kind = match slot.kind {
        Kind::Bool => "bool",
        Kind::Int => "int",
        Kind::Float => "float",
        Kind::Enum => "enum",
        Kind::Text => "string",
        Kind::Json => "object or list",
    };
    let access = if slot.knob { "knob" } else { "read cell" };
    format!("a {kind} {access}")
}

fn find(region: &Region, name: &str, kind: Kind, knob: bool) -> Result<usize, HandleError> {
    let (_, slot) = region
        .layout
        .cell(name)
        .ok_or_else(|| HandleError::Unknown(name.to_string()))?;
    if slot.kind != kind || slot.knob != knob {
        return Err(HandleError::Mismatch {
            name: name.to_string(),
            declared: describe(slot),
        });
    }
    Ok(slot.at)
}

/// A value that is one word in the region.
pub trait Scalar: Copy {
    #[doc(hidden)]
    const KIND: Kind;
    #[doc(hidden)]
    fn to_word(self) -> u64;
    #[doc(hidden)]
    fn from_word(word: u64) -> Self;
}

impl Scalar for bool {
    const KIND: Kind = Kind::Bool;
    fn to_word(self) -> u64 {
        u64::from(self)
    }
    fn from_word(word: u64) -> Self {
        word != 0
    }
}

impl Scalar for i64 {
    const KIND: Kind = Kind::Int;
    fn to_word(self) -> u64 {
        self as u64
    }
    fn from_word(word: u64) -> Self {
        word as i64
    }
}

impl Scalar for f64 {
    const KIND: Kind = Kind::Float;
    fn to_word(self) -> u64 {
        self.to_bits()
    }
    fn from_word(word: u64) -> Self {
        f64::from_bits(word)
    }
}

fn store_scalar(region: &Region, at: usize, word: u64) {
    region[at].store(word, Ordering::Relaxed);
    region[at + 1].fetch_add(1, Ordering::Relaxed);
}

/// A `bool`, `int` or `float` cell the program writes.
#[derive(Debug, Clone)]
pub struct Cell<T: Scalar> {
    region: Arc<Region>,
    at: usize,
    value: PhantomData<T>,
}

impl<T: Scalar> Cell<T> {
    pub fn new(region: &Arc<Region>, name: &str) -> Result<Self, HandleError> {
        Ok(Self {
            region: region.clone(),
            at: find(region, name, T::KIND, false)?,
            value: PhantomData,
        })
    }

    /// Write the value: one store to the value, one to the version.
    pub fn set(&self, value: T) {
        store_scalar(&self.region, self.at, value.to_word());
    }
}

/// A `bool`, `int` or `float` knob: the agent writes it, the program reads it.
#[derive(Debug, Clone)]
pub struct Knob<T: Scalar> {
    region: Arc<Region>,
    at: usize,
    value: PhantomData<T>,
}

impl<T: Scalar> Knob<T> {
    pub fn new(region: &Arc<Region>, name: &str) -> Result<Self, HandleError> {
        Ok(Self {
            region: region.clone(),
            at: find(region, name, T::KIND, true)?,
            value: PhantomData,
        })
    }

    /// The current value: one load.
    pub fn get(&self) -> T {
        T::from_word(self.region[self.at].load(Ordering::Relaxed))
    }

    /// Set the knob from the program's side, for example back to its default.
    pub fn reset(&self, value: T) {
        store_scalar(&self.region, self.at, value.to_word());
    }
}

fn value_index(values: &[String], value: &str) -> Option<u64> {
    values.iter().position(|v| v == value).map(|i| i as u64)
}

/// An `enum` cell the program writes.
#[derive(Debug, Clone)]
pub struct EnumCell {
    region: Arc<Region>,
    index: usize,
    at: usize,
}

impl EnumCell {
    pub fn new(region: &Arc<Region>, name: &str) -> Result<Self, HandleError> {
        let at = find(region, name, Kind::Enum, false)?;
        let (index, _) = region.layout.cell(name).expect("found above");
        Ok(Self {
            region: region.clone(),
            index,
            at,
        })
    }

    /// Write one of the declared values. Returns false, and writes
    /// nothing, when the value is not one of them.
    pub fn set(&self, value: &str) -> bool {
        let values = &self.region.layout.cells[self.index].values;
        match value_index(values, value) {
            Some(word) => {
                store_scalar(&self.region, self.at, word);
                true
            }
            None => false,
        }
    }
}

/// An `enum` knob.
#[derive(Debug, Clone)]
pub struct EnumKnob {
    region: Arc<Region>,
    index: usize,
    at: usize,
}

impl EnumKnob {
    pub fn new(region: &Arc<Region>, name: &str) -> Result<Self, HandleError> {
        let at = find(region, name, Kind::Enum, true)?;
        let (index, _) = region.layout.cell(name).expect("found above");
        Ok(Self {
            region: region.clone(),
            index,
            at,
        })
    }

    /// The current value: one load.
    pub fn get(&self) -> &str {
        let values = &self.region.layout.cells[self.index].values;
        let word = self.region[self.at].load(Ordering::Relaxed) as usize;
        values
            .get(word)
            .or(values.first())
            .map_or("", String::as_str)
    }

    /// Set the knob from the program's side. Returns false when the value
    /// is not one of the declared ones.
    pub fn reset(&self, value: &str) -> bool {
        let values = &self.region.layout.cells[self.index].values;
        match value_index(values, value) {
            Some(word) => {
                store_scalar(&self.region, self.at, word);
                true
            }
            None => false,
        }
    }
}

/// Ends a sized write however it ends: the length is stored and the
/// version goes even. A writer that panics leaves the cell null.
struct SizedWrite<'a> {
    slot: &'a [AtomicU64],
    odd: u64,
    len: u64,
}

impl Drop for SizedWrite<'_> {
    fn drop(&mut self) {
        self.slot[1].store(self.len, Ordering::Relaxed);
        self.slot[0].store(self.odd.wrapping_add(1), Ordering::Release);
    }
}

/// Write a sized slot under its sequence lock: the version goes odd, the
/// bytes and the length are copied, the version goes even. One writer.
fn write_sized(slot: &[AtomicU64], fill: impl FnOnce(&[AtomicU64]) -> u64) {
    let odd = slot[0].load(Ordering::Relaxed) | 1;
    slot[0].store(odd, Ordering::Relaxed);
    // the odd version must be visible before any byte is, or a reader
    // could copy new bytes under the old version
    fence(Ordering::Release);
    let mut write = SizedWrite {
        slot,
        odd,
        len: NULL_LEN,
    };
    write.len = fill(&slot[2..]);
}

/// A `string` cell the program writes. It has one writer thread, which
/// the program guarantees.
#[derive(Debug, Clone)]
pub struct TextCell {
    region: Arc<Region>,
    at: usize,
    max: usize,
}

impl TextCell {
    pub fn new(region: &Arc<Region>, name: &str) -> Result<Self, HandleError> {
        let at = find(region, name, Kind::Text, false)?;
        let (_, slot) = region.layout.cell(name).expect("found above");
        Ok(Self {
            region: region.clone(),
            at,
            max: slot.max,
        })
    }

    /// Write the value, cut to the cell's `max` on a character boundary.
    pub fn set(&self, value: &str) {
        let bytes = cut_utf8(value, self.max).as_bytes();
        write_sized(&self.region[self.at..], |data| {
            store_bytes(data, bytes);
            bytes.len() as u64
        });
    }
}

/// An `object` or `list` cell the program writes. It has one writer
/// thread, which the program guarantees.
#[derive(Debug, Clone)]
pub struct JsonCell {
    region: Arc<Region>,
    at: usize,
    max: usize,
}

impl JsonCell {
    pub fn new(region: &Arc<Region>, name: &str) -> Result<Self, HandleError> {
        let at = find(region, name, Kind::Json, false)?;
        let (_, slot) = region.layout.cell(name).expect("found above");
        Ok(Self {
            region: region.clone(),
            at,
            max: slot.max,
        })
    }

    /// Write the value as JSON, straight into the slot. A value whose
    /// JSON is longer than the cell's `max` cannot be cut, so the cell
    /// becomes null and the call returns false.
    pub fn set<T: Serialize + ?Sized>(&self, value: &T) -> bool {
        let mut fits = true;
        write_sized(&self.region[self.at..], |data| {
            let mut writer = WordWriter::new(data, self.max);
            let written = serde_json::to_writer(&mut writer, value).is_ok();
            match writer.finish() {
                Some(len) if written => len as u64,
                _ => {
                    fits = false;
                    NULL_LEN
                }
            }
        });
        fits
    }
}

/// Write a cell's default into a fresh region.
pub(super) fn write_default(region: &Region, index: usize, default: &Value) {
    let slot = &region.layout.cells[index];
    if slot.kind.is_scalar() {
        if let Some(word) = scalar_word(slot, default) {
            region[slot.at].store(word, Ordering::Relaxed);
        }
    } else {
        write_mirror(region, index, default);
        // a default is not a write
        region[slot.at].store(0, Ordering::Relaxed);
    }
}

fn scalar_word(slot: &CellSlot, value: &Value) -> Option<u64> {
    match slot.kind {
        Kind::Bool => value.as_bool().map(u64::from),
        Kind::Int => value
            .as_i64()
            .or_else(|| {
                // a whole number written as a float, within what a float
                // holds exactly
                let float = value.as_f64().filter(|_| value.is_f64())?;
                let exact = float.fract() == 0.0 && float.abs() <= 9_007_199_254_740_992.0;
                exact.then_some(float as i64)
            })
            .map(|i| i as u64),
        Kind::Float => value.as_f64().map(f64::to_bits),
        Kind::Enum => value_index(&slot.values, value.as_str()?),
        Kind::Text | Kind::Json => None,
    }
}

fn scalar_value(slot: &CellSlot, word: u64) -> Value {
    match slot.kind {
        Kind::Bool => Value::Bool(word != 0),
        Kind::Int => Value::from(word as i64),
        Kind::Float => {
            serde_json::Number::from_f64(f64::from_bits(word)).map_or(Value::Null, Value::Number)
        }
        Kind::Enum => slot
            .values
            .get(word as usize)
            .map_or(Value::Null, |v| Value::String(v.clone())),
        Kind::Text | Kind::Json => Value::Null,
    }
}

/// A cell as the harness read it.
#[derive(Debug, Clone, PartialEq)]
pub struct CellValue {
    pub value: Value,
    /// Advances on every write; for a sized cell, by two.
    pub version: u64,
}

/// Read a cell. Each read is consistent by itself: a scalar is a value
/// that was current at some instant, a sized cell is one whole write.
/// Returns None for a sized cell whose writer never let a read through.
pub fn read(region: &Region, index: usize) -> Option<CellValue> {
    let slot = &region.layout.cells[index];
    if slot.kind.is_scalar() {
        // the version first: read the other way round, a write between
        // the two loads would show its version without its value, and a
        // watch on the version would never see that write
        let version = region[slot.at + 1].load(Ordering::Relaxed);
        let word = region[slot.at].load(Ordering::Relaxed);
        return Some(CellValue {
            value: scalar_value(slot, word),
            version,
        });
    }
    let words = &region[slot.at..];
    for _ in 0..READ_TRIES {
        let before = words[0].load(Ordering::Acquire);
        if before & 1 == 1 {
            std::hint::spin_loop();
            continue;
        }
        let len = words[1].load(Ordering::Relaxed);
        let bytes = if len == NULL_LEN {
            None
        } else {
            Some(load_bytes(&words[2..], (len as usize).min(slot.max)))
        };
        fence(Ordering::Acquire);
        if words[0].load(Ordering::Relaxed) != before {
            continue;
        }
        let value = match (bytes, slot.kind) {
            (None, _) => Value::Null,
            (Some(bytes), Kind::Text) => {
                Value::String(String::from_utf8_lossy(&bytes).into_owned())
            }
            // a list or an object nobody has written yet is null
            (Some(bytes), _) => serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        };
        return Some(CellValue {
            value,
            version: before,
        });
    }
    None
}

/// The harness writes a scalar knob, directly into the region. Returns
/// false when the value is not of the knob's type.
pub fn write_scalar_knob(region: &Region, index: usize, value: &Value) -> bool {
    let slot = &region.layout.cells[index];
    match scalar_word(slot, value) {
        Some(word) => {
            store_scalar(region, slot.at, word);
            true
        }
        None => false,
    }
}

/// The harness writes its mirror of a sized knob's current value. The
/// harness is the mirror's only writer. Returns false when the value does
/// not fit, and the mirror keeps what it had.
pub fn write_mirror(region: &Region, index: usize, value: &Value) -> bool {
    let slot = &region.layout.cells[index];
    let bytes = match (slot.kind, value) {
        (_, Value::Null) => None,
        (Kind::Text, Value::String(text)) => Some(text.as_bytes().to_vec()),
        (Kind::Json, value) => Some(serde_json::to_vec(value).unwrap_or_default()),
        _ => return false,
    };
    if bytes.as_ref().is_some_and(|b| b.len() > slot.max) {
        return false;
    }
    write_sized(&region[slot.at..], |data| match &bytes {
        None => NULL_LEN,
        Some(bytes) => {
            store_bytes(data, bytes);
            bytes.len() as u64
        }
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::region::tests::manifest;
    use serde_json::json;
    use std::sync::atomic::AtomicBool;

    fn region() -> Arc<Region> {
        Region::in_process(&manifest(), 8)
    }

    fn get(region: &Region, name: &str) -> CellValue {
        let (index, _) = region.layout.cell(name).unwrap();
        read(region, index).unwrap()
    }

    #[test]
    fn scalar_cells_store_a_value_and_advance_a_version() {
        let region = region();
        let count = Cell::<i64>::new(&region, "count").unwrap();
        let ratio = Cell::<f64>::new(&region, "ratio").unwrap();
        let busy = Cell::<bool>::new(&region, "busy").unwrap();
        assert_eq!(
            get(&region, "count"),
            CellValue {
                value: json!(0),
                version: 0
            }
        );

        count.set(-7);
        count.set(41);
        ratio.set(0.25);
        busy.set(true);
        assert_eq!(
            get(&region, "count"),
            CellValue {
                value: json!(41),
                version: 2
            }
        );
        assert_eq!(get(&region, "ratio").value, json!(0.25));
        assert_eq!(get(&region, "busy").value, json!(true));

        ratio.set(f64::NAN);
        assert_eq!(get(&region, "ratio").value, Value::Null);
    }

    #[test]
    fn enum_cells_take_only_their_values() {
        let region = region();
        let phase = EnumCell::new(&region, "phase").unwrap();
        assert_eq!(get(&region, "phase").value, json!("idle"));
        assert!(phase.set("done"));
        assert!(!phase.set("lost"));
        assert_eq!(
            get(&region, "phase"),
            CellValue {
                value: json!("done"),
                version: 1
            }
        );
    }

    #[test]
    fn a_handle_must_match_the_declaration() {
        let region = region();
        assert_eq!(
            Cell::<i64>::new(&region, "nothing").unwrap_err(),
            HandleError::Unknown("nothing".to_string())
        );
        let wrong_type = Cell::<f64>::new(&region, "count").unwrap_err();
        assert_eq!(
            wrong_type.to_string(),
            "count is declared as a int read cell"
        );
        assert!(Cell::<i64>::new(&region, "step").is_err());
        assert!(Knob::<i64>::new(&region, "count").is_err());
        assert!(TextCell::new(&region, "motto").is_err());
        assert!(JsonCell::new(&region, "label").is_err());
        assert!(EnumKnob::new(&region, "phase").is_err());
    }

    #[test]
    fn knobs_start_at_their_defaults() {
        let region = region();
        let step = Knob::<i64>::new(&region, "step").unwrap();
        let speed = EnumKnob::new(&region, "speed").unwrap();
        assert_eq!(step.get(), 3);
        assert_eq!(speed.get(), "fast");
        assert_eq!(
            get(&region, "motto"),
            CellValue {
                value: json!("steady"),
                version: 0
            }
        );
        // a default is not a write
        assert_eq!(get(&region, "step").version, 0);
    }

    #[test]
    fn the_harness_writes_a_scalar_knob_and_the_program_reads_it() {
        let region = region();
        let step = Knob::<i64>::new(&region, "step").unwrap();
        let speed = EnumKnob::new(&region, "speed").unwrap();
        let (step_index, _) = region.layout.cell("step").unwrap();
        let (speed_index, _) = region.layout.cell("speed").unwrap();

        assert!(write_scalar_knob(&region, step_index, &json!(12)));
        assert!(write_scalar_knob(&region, speed_index, &json!("slow")));
        assert!(!write_scalar_knob(&region, speed_index, &json!("warp")));
        assert!(!write_scalar_knob(&region, step_index, &json!("twelve")));
        assert_eq!(step.get(), 12);
        assert_eq!(speed.get(), "slow");

        step.reset(3);
        assert!(speed.reset("fast"));
        assert!(!speed.reset("warp"));
        assert_eq!(
            get(&region, "step"),
            CellValue {
                value: json!(3),
                version: 2
            }
        );
        assert_eq!(speed.get(), "fast");
    }

    #[test]
    fn a_text_cell_is_cut_to_its_max() {
        let region = region();
        let label = TextCell::new(&region, "label").unwrap();
        assert_eq!(
            get(&region, "label"),
            CellValue {
                value: json!(""),
                version: 0
            }
        );
        label.set("short");
        assert_eq!(
            get(&region, "label"),
            CellValue {
                value: json!("short"),
                version: 2
            }
        );
        // twenty bytes hold nineteen letters and not half of the é after them
        label.set("abcdefghijklmnopqrsé and more");
        assert_eq!(get(&region, "label").value, json!("abcdefghijklmnopqrs"));
        label.set("");
        assert_eq!(
            get(&region, "label"),
            CellValue {
                value: json!(""),
                version: 6
            }
        );
    }

    #[test]
    fn a_json_cell_holds_what_fits() {
        let region = region();
        let recent = JsonCell::new(&region, "recent").unwrap();
        assert_eq!(get(&region, "recent").value, Value::Null);
        assert!(recent.set(&[1, 2, 3]));
        assert_eq!(get(&region, "recent").value, json!([1, 2, 3]));
        let long: Vec<i64> = (0..100).collect();
        assert!(!recent.set(&long));
        assert_eq!(get(&region, "recent").value, Value::Null);
        assert!(recent.set(&[9]));
        assert_eq!(get(&region, "recent").value, json!([9]));
    }

    struct Broken;
    impl Serialize for Broken {
        fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            panic!("the program's bug")
        }
    }

    #[test]
    fn a_writer_that_panics_leaves_the_cell_null_and_readable() {
        let region = region();
        let recent = JsonCell::new(&region, "recent").unwrap();
        assert!(recent.set(&[1]));
        let broken = recent.clone();
        assert!(
            std::thread::spawn(move || broken.set(&Broken))
                .join()
                .is_err()
        );
        let after = get(&region, "recent");
        assert_eq!((after.value, after.version % 2), (Value::Null, 0));
        assert!(recent.set(&[2]));
        assert_eq!(get(&region, "recent").value, json!([2]));
    }

    #[test]
    fn an_int_knob_takes_whole_numbers_only() {
        let region = region();
        let step = Knob::<i64>::new(&region, "step").unwrap();
        let (index, _) = region.layout.cell("step").unwrap();
        assert!(write_scalar_knob(&region, index, &json!(5.0)));
        assert_eq!(step.get(), 5);
        for bad in [json!(3.7), json!(1e300), json!(u64::MAX), json!(true)] {
            assert!(!write_scalar_knob(&region, index, &bad), "{bad}");
        }
        assert_eq!(step.get(), 5);
        assert!(write_scalar_knob(&region, index, &json!(-2)));
        assert_eq!(step.get(), -2);
    }

    #[test]
    fn the_mirror_of_a_sized_knob_takes_what_fits() {
        let region = region();
        let (index, _) = region.layout.cell("motto").unwrap();
        assert!(write_mirror(&region, index, &json!("onward")));
        assert_eq!(get(&region, "motto").value, json!("onward"));
        assert!(!write_mirror(&region, index, &json!("x".repeat(33))));
        assert!(!write_mirror(&region, index, &json!(5)));
        assert_eq!(get(&region, "motto").value, json!("onward"));
    }

    #[test]
    fn a_reader_never_sees_half_a_write() {
        let region = region();
        let label = TextCell::new(&region, "label").unwrap();
        let (index, _) = region.layout.cell("label").unwrap();
        let stop = Arc::new(AtomicBool::new(false));

        let writer = {
            let stop = stop.clone();
            std::thread::spawn(move || {
                let texts = [
                    "aaaaaaaaaaaaaaaaaaaa",
                    "bbbbbbbbbb",
                    "c",
                    "dddddddddddddddd",
                ];
                let mut round = 0usize;
                while !stop.load(Ordering::Relaxed) {
                    label.set(texts[round % texts.len()]);
                    round += 1;
                }
            })
        };

        let mut seen = 0;
        for _ in 0..20_000 {
            if let Some(cell) = read(&region, index) {
                let text = cell.value.as_str().unwrap().to_string();
                let first = text.chars().next();
                assert!(text.chars().all(|c| Some(c) == first), "torn read: {text}");
                assert!(
                    matches!(text.len(), 0 | 1 | 10 | 16 | 20),
                    "torn length: {text}"
                );
                assert_eq!(cell.version % 2, 0);
                seen += 1;
            }
        }
        stop.store(true, Ordering::Relaxed);
        writer.join().unwrap();
        assert!(seen > 0);
    }
}
