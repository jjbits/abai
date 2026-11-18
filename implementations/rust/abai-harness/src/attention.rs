//! Attention: what wakes the agent (contract section 5.6).
//!
//! The conditions an event's `wakes` declares (section 5.1), the watches the
//! agent sets on cells (section 5.2), its timers, and the attention budget.
//! Everything here is pure logic: the clock is passed in.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

/// A parsed `wakes` condition on an event's payload: `<field> <op> <json literal>`.
#[derive(Debug, Clone, PartialEq)]
pub struct WakeCondition {
    pub field: String,
    pub op: CompareOp,
    pub value: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompareOp {
    Eq,
    Ne,
    Gt,
    Lt,
}

fn is_field_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Parse a condition such as `attempt gt 2` or `reason eq "quota"`. None when it is not one.
pub fn parse_wake_condition(wakes: &str) -> Option<WakeCondition> {
    let text = wakes.trim();
    let (field, rest) = text.split_once(char::is_whitespace)?;
    let rest = rest.trim_start();
    let (op, literal) = rest.split_once(char::is_whitespace)?;
    if !is_field_name(field) {
        return None;
    }
    let op = match op {
        "eq" => CompareOp::Eq,
        "ne" => CompareOp::Ne,
        "gt" => CompareOp::Gt,
        "lt" => CompareOp::Lt,
        _ => return None,
    };
    let literal = literal.trim();
    if literal.is_empty() {
        return None;
    }
    let value = serde_json::from_str(literal).ok()?;
    Some(WakeCondition {
        field: field.to_string(),
        op,
        value,
    })
}

/// Whether two JSON values are equal, with numbers compared by value (1 equals 1.0).
fn json_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => match (x.as_f64(), y.as_f64()) {
            (Some(x), Some(y)) => x == y,
            _ => x == y,
        },
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| json_equal(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| json_equal(v, w)))
        }
        _ => a == b,
    }
}

/// `a - b` as a number, when both are numbers.
fn number_difference(a: &Value, b: &Value) -> Option<f64> {
    Some(a.as_f64()? - b.as_f64()?)
}

fn compare_holds(op: CompareOp, actual: &Value, value: &Value) -> bool {
    match op {
        CompareOp::Eq => json_equal(actual, value),
        CompareOp::Ne => !json_equal(actual, value),
        CompareOp::Gt => number_difference(actual, value).is_some_and(|d| d > 0.0),
        CompareOp::Lt => number_difference(actual, value).is_some_and(|d| d < 0.0),
    }
}

/// Whether an event with this payload wakes the agent under its declared `wakes`.
/// None or "never": false. "always": true. A condition: its truth; an unparsable condition or a missing field: false.
/// eq/ne compare JSON values, with numbers compared by value (1 equals 1.0); gt/lt hold only between two numbers.
pub fn event_wakes(wakes: Option<&str>, payload: &Map<String, Value>) -> bool {
    let wakes = match wakes {
        None => return false,
        Some(w) => w,
    };
    match wakes.trim() {
        "never" => return false,
        "always" => return true,
        _ => {}
    }
    let condition = match parse_wake_condition(wakes) {
        Some(c) => c,
        None => return false,
    };
    match payload.get(&condition.field) {
        Some(actual) => compare_holds(condition.op, actual, &condition.value),
        None => false,
    }
}

/// What a watch looks for in a cell (contract section 5.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchOp {
    Changed,
    Eq,
    Ne,
    Gt,
    Lt,
    Crossed,
}

impl WatchOp {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "changed" => Some(WatchOp::Changed),
            "eq" => Some(WatchOp::Eq),
            "ne" => Some(WatchOp::Ne),
            "gt" => Some(WatchOp::Gt),
            "lt" => Some(WatchOp::Lt),
            "crossed" => Some(WatchOp::Crossed),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            WatchOp::Changed => "changed",
            WatchOp::Eq => "eq",
            WatchOp::Ne => "ne",
            WatchOp::Gt => "gt",
            WatchOp::Lt => "lt",
            WatchOp::Crossed => "crossed",
        }
    }
}

/// The shortest cadence a watch may have.
const MIN_CADENCE: Duration = Duration::from_millis(100);

/// A watch the agent registered on a cell.
#[derive(Debug, Clone, PartialEq)]
pub struct Watch {
    pub cell: String,
    pub op: WatchOp,
    /// The value compared with; unused by `Changed`.
    pub value: Value,
    /// How often the cell is looked at.
    pub cadence: Duration,
    /// Whether the condition held at the last look. A watch fires on the edge: when it starts to hold.
    held: bool,
    /// The last value and version seen, once the cell has been looked at.
    last: Option<(Value, u64)>,
    /// When the cell is next due to be looked at.
    due: Instant,
}

impl Watch {
    /// A new watch, due at once. `cadence` below 100 ms is raised to 100 ms.
    pub fn new(cell: &str, op: WatchOp, value: Value, cadence: Duration, now: Instant) -> Self {
        Watch {
            cell: cell.to_string(),
            op,
            value,
            cadence: cadence.max(MIN_CADENCE),
            held: false,
            last: None,
            due: now,
        }
    }

    /// Put the next look off by one cadence, when the cell could not be
    /// read this time.
    pub fn postpone(&mut self, now: Instant) {
        self.due = now + self.cadence;
    }

    pub fn due(&self) -> Instant {
        self.due
    }

    /// Look at the cell's current value and version. Returns Some(line) when the watch fires,
    /// None otherwise; sets the next due time to `now + cadence`.
    pub fn look(&mut self, current: &Value, version: u64, now: Instant) -> Option<String> {
        self.due = now + self.cadence;
        let fires = match self.op {
            WatchOp::Changed => match &self.last {
                Some((_, last_version)) => *last_version != version,
                None => false,
            },
            WatchOp::Eq | WatchOp::Ne | WatchOp::Gt | WatchOp::Lt => {
                let op = match self.op {
                    WatchOp::Eq => CompareOp::Eq,
                    WatchOp::Ne => CompareOp::Ne,
                    WatchOp::Gt => CompareOp::Gt,
                    _ => CompareOp::Lt,
                };
                let holds = compare_holds(op, current, &self.value);
                let fires = holds && !self.held;
                self.held = holds;
                fires
            }
            WatchOp::Crossed => match &self.last {
                Some((last, _)) => crossed(last, current, &self.value),
                None => false,
            },
        };
        self.last = Some((current.clone(), version));
        if !fires {
            return None;
        }
        let line = match self.op {
            WatchOp::Changed => format!("watch {} changed: now {}", self.cell, current),
            op => format!(
                "watch {} {} {}: now {}",
                self.cell,
                op.as_str(),
                self.value,
                current
            ),
        };
        Some(line)
    }
}

/// Whether a number moved across `value` between `last` and `current`: from one strict
/// side to the other, or onto `value` from either side.
fn crossed(last: &Value, current: &Value, value: &Value) -> bool {
    let (before, after) = match (
        number_difference(last, value),
        number_difference(current, value),
    ) {
        (Some(b), Some(a)) => (b, a),
        _ => return false,
    };
    (before < 0.0 && after > 0.0)
        || (before > 0.0 && after < 0.0)
        || (after == 0.0 && before != 0.0)
}

/// A timer the agent set for itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Timer {
    pub due: Instant,
    pub note: String,
}

const WAKE_WINDOW: Duration = Duration::from_secs(60);
const TOKEN_WINDOW: Duration = Duration::from_secs(3600);

/// The attention budget (contract section 5.6): the most wakes in any 60 seconds, and the most model tokens in any hour.
#[derive(Debug, Clone)]
pub struct Budget {
    wakes_per_minute: Option<u32>,
    tokens_per_hour: Option<u64>,
    /// The instants of the wakes delivered in the last minute, oldest first.
    wakes: VecDeque<Instant>,
    /// The tokens spent in the last hour, oldest first.
    spends: VecDeque<(Instant, u64)>,
    /// Wakes held back since the last delivery's summary.
    held: u64,
}

impl Budget {
    pub fn new(wakes_per_minute: Option<u32>, tokens_per_hour: Option<u64>) -> Self {
        Budget {
            wakes_per_minute,
            tokens_per_hour,
            wakes: VecDeque::new(),
            spends: VecDeque::new(),
            held: 0,
        }
    }

    /// Drop the entries that have left their windows.
    fn expire(&mut self, now: Instant) {
        while let Some(&t) = self.wakes.front() {
            if now.saturating_duration_since(t) >= WAKE_WINDOW {
                self.wakes.pop_front();
            } else {
                break;
            }
        }
        while let Some(&(t, _)) = self.spends.front() {
            if now.saturating_duration_since(t) >= TOKEN_WINDOW {
                self.spends.pop_front();
            } else {
                break;
            }
        }
    }

    fn tokens_in_window(&self) -> u64 {
        self.spends.iter().map(|(_, n)| *n).sum()
    }

    fn wakes_blocked(&self) -> bool {
        self.wakes_per_minute
            .is_some_and(|limit| self.wakes.len() as u64 >= u64::from(limit))
    }

    fn tokens_blocked(&self) -> bool {
        self.tokens_per_hour
            .is_some_and(|limit| self.tokens_in_window() >= limit)
    }

    /// Whether a wake may be delivered now. A limit that is None never holds anything back.
    pub fn allows(&mut self, now: Instant) -> bool {
        self.expire(now);
        !self.wakes_blocked() && !self.tokens_blocked()
    }

    /// Record that a wake was delivered at `now`.
    pub fn delivered(&mut self, now: Instant) {
        self.expire(now);
        self.wakes.push_back(now);
    }

    /// Record tokens the model used at `now`.
    pub fn spent(&mut self, tokens: u64, now: Instant) {
        self.expire(now);
        self.spends.push_back((now, tokens));
    }

    /// Count a wake that was held back, to be told in the next delivery's summary.
    pub fn hold(&mut self) {
        self.held += 1;
    }

    /// The number of wakes held back since this was last asked, which it resets.
    pub fn take_held(&mut self) -> u64 {
        std::mem::take(&mut self.held)
    }

    /// When the budget will next allow a wake, if it does not now. None when it allows now,
    /// and None when a limit is 0, since such a budget never allows.
    ///
    /// For wakes, the instant enough of the counted wakes have left the minute to fall below
    /// the limit; for tokens, the instant enough of the spends have left the hour to fall below
    /// the limit. When both limits hold a wake back, the later of the two.
    pub fn free_at(&mut self, now: Instant) -> Option<Instant> {
        self.expire(now);
        if self.wakes_per_minute == Some(0) || self.tokens_per_hour == Some(0) {
            return None;
        }
        let mut free: Option<Instant> = None;
        if self.wakes_blocked() {
            let limit = self.wakes_per_minute.unwrap_or(0) as usize;
            let excess = self.wakes.len() - limit;
            let at = self.wakes[excess] + WAKE_WINDOW;
            free = Some(free.map_or(at, |f| f.max(at)));
        }
        if self.tokens_blocked() {
            let limit = self.tokens_per_hour.unwrap_or(0);
            let mut remaining = self.tokens_in_window();
            for &(t, n) in &self.spends {
                remaining -= n;
                if remaining < limit {
                    let at = t + TOKEN_WINDOW;
                    free = Some(free.map_or(at, |f| f.max(at)));
                    break;
                }
            }
        }
        free
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => panic!("not an object"),
        }
    }

    #[test]
    fn parses_good_conditions() {
        assert_eq!(
            parse_wake_condition("attempt gt 2"),
            Some(WakeCondition {
                field: "attempt".into(),
                op: CompareOp::Gt,
                value: json!(2)
            })
        );
        assert_eq!(
            parse_wake_condition("reason eq \"quota\""),
            Some(WakeCondition {
                field: "reason".into(),
                op: CompareOp::Eq,
                value: json!("quota")
            })
        );
        assert_eq!(
            parse_wake_condition("ok eq true"),
            Some(WakeCondition {
                field: "ok".into(),
                op: CompareOp::Eq,
                value: json!(true)
            })
        );
        assert_eq!(
            parse_wake_condition("x  lt   -1.5"),
            Some(WakeCondition {
                field: "x".into(),
                op: CompareOp::Lt,
                value: json!(-1.5)
            })
        );
        assert_eq!(
            parse_wake_condition("reason ne \"a b\"").map(|c| c.value),
            Some(json!("a b"))
        );
    }

    #[test]
    fn rejects_bad_conditions() {
        for bad in [
            "Attempt gt 2",
            "attempt above 2",
            "attempt gt",
            "attempt gt {",
            "",
            "   ",
            "1x eq 1",
        ] {
            assert_eq!(parse_wake_condition(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn event_wakes_follows_the_declaration() {
        let p = payload(json!({"attempt": 3, "reason": "quota", "count": 1.0, "name": "b"}));
        assert!(event_wakes(Some("always"), &p));
        assert!(!event_wakes(Some("never"), &p));
        assert!(!event_wakes(None, &p));
        assert!(event_wakes(Some("attempt gt 2"), &p));
        assert!(!event_wakes(Some("attempt gt 3"), &p));
        assert!(event_wakes(Some("attempt lt 4"), &p));
        assert!(!event_wakes(Some("attempt lt 3"), &p));
        assert!(event_wakes(Some("reason eq \"quota\""), &p));
        assert!(!event_wakes(Some("reason eq \"other\""), &p));
        assert!(event_wakes(Some("reason ne \"other\""), &p));
        assert!(!event_wakes(Some("reason ne \"quota\""), &p));
        assert!(!event_wakes(Some("missing eq 1"), &p));
        assert!(!event_wakes(Some("missing ne 1"), &p));
        assert!(event_wakes(Some("count eq 1"), &p));
        assert!(event_wakes(Some("attempt eq 3.0"), &p));
        assert!(!event_wakes(Some("name gt \"a\""), &p));
        assert!(!event_wakes(Some("reason lt 5"), &p));
        assert!(!event_wakes(Some("attempt above 2"), &p));
        assert!(!event_wakes(Some("attempt gt {"), &p));
    }

    #[test]
    fn watch_op_names_round_trip() {
        for op in [
            WatchOp::Changed,
            WatchOp::Eq,
            WatchOp::Ne,
            WatchOp::Gt,
            WatchOp::Lt,
            WatchOp::Crossed,
        ] {
            assert_eq!(WatchOp::parse(op.as_str()), Some(op));
        }
        assert_eq!(WatchOp::parse("above"), None);
    }

    #[test]
    fn changed_fires_on_a_new_version() {
        let t0 = Instant::now();
        let mut w = Watch::new(
            "queue",
            WatchOp::Changed,
            Value::Null,
            Duration::from_secs(1),
            t0,
        );
        assert_eq!(w.look(&json!(1), 1, t0), None);
        assert_eq!(w.look(&json!(1), 1, t0 + Duration::from_secs(1)), None);
        assert_eq!(
            w.look(&json!(2), 2, t0 + Duration::from_secs(2)),
            Some("watch queue changed: now 2".to_string())
        );
        assert_eq!(w.look(&json!(2), 2, t0 + Duration::from_secs(3)), None);
        // A new version fires even when the value is the same.
        assert!(w.look(&json!(2), 3, t0 + Duration::from_secs(4)).is_some());
    }

    #[test]
    fn eq_fires_on_the_edge() {
        let t0 = Instant::now();
        let s = Duration::from_secs(1);
        let mut w = Watch::new("mode", WatchOp::Eq, json!("busy"), s, t0);
        assert_eq!(w.look(&json!("idle"), 1, t0), None);
        assert_eq!(
            w.look(&json!("busy"), 2, t0 + s),
            Some("watch mode eq \"busy\": now \"busy\"".to_string())
        );
        assert_eq!(w.look(&json!("busy"), 3, t0 + s * 2), None);
        assert_eq!(w.look(&json!("idle"), 4, t0 + s * 3), None);
        assert!(w.look(&json!("busy"), 5, t0 + s * 4).is_some());
    }

    #[test]
    fn eq_first_look_fires_when_it_holds() {
        let t0 = Instant::now();
        let mut w = Watch::new("n", WatchOp::Eq, json!(1), Duration::from_secs(1), t0);
        assert_eq!(
            w.look(&json!(1.0), 1, t0),
            Some("watch n eq 1: now 1.0".to_string())
        );
    }

    #[test]
    fn ne_fires_on_the_edge() {
        let t0 = Instant::now();
        let s = Duration::from_secs(1);
        let mut w = Watch::new("n", WatchOp::Ne, json!(0), s, t0);
        assert_eq!(w.look(&json!(0), 1, t0), None);
        assert_eq!(
            w.look(&json!(4), 2, t0 + s),
            Some("watch n ne 0: now 4".to_string())
        );
        assert_eq!(w.look(&json!(5), 3, t0 + s * 2), None);
    }

    #[test]
    fn gt_and_lt_compare_numbers_only() {
        let t0 = Instant::now();
        let s = Duration::from_secs(1);
        let mut gt = Watch::new("temp", WatchOp::Gt, json!(10), s, t0);
        assert_eq!(gt.look(&json!(5), 1, t0), None);
        assert_eq!(
            gt.look(&json!(10.5), 2, t0 + s),
            Some("watch temp gt 10: now 10.5".to_string())
        );
        assert_eq!(gt.look(&json!(12), 3, t0 + s * 2), None);

        let mut lt = Watch::new("temp", WatchOp::Lt, json!(0), s, t0);
        assert_eq!(
            lt.look(&json!(-1), 1, t0),
            Some("watch temp lt 0: now -1".to_string())
        );

        let mut text = Watch::new("name", WatchOp::Gt, json!(1), s, t0);
        assert_eq!(text.look(&json!("zzz"), 1, t0), None);
        assert_eq!(text.look(&json!("zzzz"), 2, t0 + s), None);
        let mut text_value = Watch::new("n", WatchOp::Lt, json!("a"), s, t0);
        assert_eq!(text_value.look(&json!(1), 1, t0), None);
    }

    #[test]
    fn crossed_fires_on_each_crossing() {
        let t0 = Instant::now();
        let s = Duration::from_secs(1);
        let mut w = Watch::new("level", WatchOp::Crossed, json!(50), s, t0);
        // The first look only records, even when the value is on the line.
        assert_eq!(w.look(&json!(50), 1, t0), None);
        assert_eq!(w.look(&json!(40), 2, t0 + s), None);
        assert_eq!(w.look(&json!(45), 3, t0 + s * 2), None);
        assert_eq!(
            w.look(&json!(60), 4, t0 + s * 3),
            Some("watch level crossed 50: now 60".to_string())
        );
        assert_eq!(w.look(&json!(70), 5, t0 + s * 4), None);
        assert_eq!(
            w.look(&json!(30), 6, t0 + s * 5),
            Some("watch level crossed 50: now 30".to_string())
        );
        // Landing exactly on the value fires; leaving it does not.
        assert!(w.look(&json!(50), 7, t0 + s * 6).is_some());
        assert_eq!(w.look(&json!(55), 8, t0 + s * 7), None);
        assert!(w.look(&json!(50.0), 9, t0 + s * 8).is_some());
        assert_eq!(w.look(&json!(49), 10, t0 + s * 9), None);

        let mut first = Watch::new("level", WatchOp::Crossed, json!(50), s, t0);
        assert_eq!(first.look(&json!(60), 1, t0), None);
        assert_eq!(first.look(&json!(70), 2, t0 + s), None);

        let mut text = Watch::new("level", WatchOp::Crossed, json!(50), s, t0);
        assert_eq!(text.look(&json!("40"), 1, t0), None);
        assert_eq!(text.look(&json!(60), 2, t0 + s), None);
    }

    #[test]
    fn due_time_follows_the_cadence() {
        let t0 = Instant::now();
        let mut w = Watch::new(
            "n",
            WatchOp::Changed,
            Value::Null,
            Duration::from_secs(5),
            t0,
        );
        assert_eq!(w.due(), t0);
        w.look(&json!(1), 1, t0 + Duration::from_secs(1));
        assert_eq!(w.due(), t0 + Duration::from_secs(6));

        let mut fast = Watch::new(
            "n",
            WatchOp::Changed,
            Value::Null,
            Duration::from_millis(10),
            t0,
        );
        assert_eq!(fast.cadence, Duration::from_millis(100));
        fast.look(&json!(1), 1, t0);
        assert_eq!(fast.due(), t0 + Duration::from_millis(100));
    }

    #[test]
    fn budget_without_limits_always_allows() {
        let t0 = Instant::now();
        let mut b = Budget::new(None, None);
        for n in 0..100 {
            let t = t0 + Duration::from_millis(n);
            assert!(b.allows(t));
            b.delivered(t);
            b.spent(1_000_000, t);
        }
        assert_eq!(b.free_at(t0 + Duration::from_secs(1)), None);
    }

    #[test]
    fn budget_limits_wakes_per_minute() {
        let t0 = Instant::now();
        let s = |n: u64| t0 + Duration::from_secs(n);
        let mut b = Budget::new(Some(3), None);
        for n in 0..3 {
            assert!(b.allows(s(n * 10)));
            assert_eq!(b.free_at(s(n * 10)), None);
            b.delivered(s(n * 10));
        }
        assert!(!b.allows(s(30)));
        assert_eq!(b.free_at(s(30)), Some(s(60)));
        assert!(!b.allows(s(59)));
        assert!(b.allows(s(60)));
        b.delivered(s(60));
        assert!(!b.allows(s(61)));
        assert_eq!(b.free_at(s(61)), Some(s(70)));
    }

    #[test]
    fn budget_limits_tokens_per_hour() {
        let t0 = Instant::now();
        let s = |n: u64| t0 + Duration::from_secs(n);
        let mut b = Budget::new(None, Some(1000));
        b.spent(400, s(0));
        assert!(b.allows(s(1)));
        b.spent(600, s(100));
        assert!(!b.allows(s(101)));
        assert_eq!(b.free_at(s(101)), Some(s(3600)));
        assert!(!b.allows(s(3599)));
        assert!(b.allows(s(3600)));
        assert_eq!(b.free_at(s(3600)), None);
    }

    #[test]
    fn budget_free_at_waits_for_enough_spends_to_leave() {
        let t0 = Instant::now();
        let s = |n: u64| t0 + Duration::from_secs(n);
        let mut b = Budget::new(None, Some(1000));
        b.spent(100, s(0));
        b.spent(1500, s(10));
        // Dropping the oldest spend still leaves 1500, so the second must leave too.
        assert_eq!(b.free_at(s(20)), Some(s(3610)));
    }

    #[test]
    fn budget_counts_held_wakes() {
        let mut b = Budget::new(Some(1), None);
        assert_eq!(b.take_held(), 0);
        b.hold();
        b.hold();
        assert_eq!(b.take_held(), 2);
        assert_eq!(b.take_held(), 0);
    }

    #[test]
    fn budget_limit_zero_never_allows() {
        let t0 = Instant::now();
        let mut wakes = Budget::new(Some(0), None);
        assert!(!wakes.allows(t0));
        assert!(!wakes.allows(t0 + Duration::from_secs(10_000)));
        assert_eq!(wakes.free_at(t0), None);

        let mut tokens = Budget::new(None, Some(0));
        assert!(!tokens.allows(t0));
        assert_eq!(tokens.free_at(t0), None);
    }
}
