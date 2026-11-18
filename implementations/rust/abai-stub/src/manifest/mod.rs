//! The abaigrammar 0.1 manifest: types and helpers (contract sections 5 and 7).
//!
//! The manifest exists in two forms that must agree: in code (the program's
//! declarations, the source of truth at runtime) and in the repository
//! (`abaigram.yaml`, rendered by [`render_yaml`]). The types here serialize
//! to both: YAML for the file, JSON for the harness in another process.

#[cfg(test)]
pub(crate) mod testdata;
mod validate;
mod yaml;

use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

pub use validate::validate;
pub use yaml::render_yaml;
pub(crate) use yaml::string_scalar;

/// The version of the contract this crate implements.
pub const ABAIGRAMMAR_VERSION: &str = "0.1";
/// The checked-in form of the manifest, at the repository root.
pub const MANIFEST_FILE: &str = "abaigram.yaml";

/// Default `max` of a `string`, in bytes (section 5, common rules).
pub const DEFAULT_STRING_MAX: u32 = 256;
/// Default `max` of an `object` or a `list`, in encoded bytes.
pub const DEFAULT_SIZED_MAX: u32 = 1024;
/// Payload bytes an event slot holds; a larger declared payload must be `large`.
pub const EVENT_SLOT_BYTES: u32 = 4096;
/// Bytes counted for a scalar field.
pub const SCALAR_BYTES: u32 = 8;

/// Default timeout of a capability call (section 5.3).
pub const DEFAULT_CAPABILITY_TIMEOUT: &str = "30s";
/// Default delivery timeout of a sized knob (section 5.2).
pub const DEFAULT_KNOB_TIMEOUT: &str = "30s";

/// Events the library emits under the reserved `abai.` prefix.
pub const LIBRARY_EVENTS: &[&str] = &[
    "abai.events.dropped",
    "abai.knob.reset",
    "abai.lifecycle.exited",
    "abai.pause.blocked",
    "abai.io.stdout",
    "abai.io.stderr",
    "abai.net.message",
];

/// A value type. Scalars fit one machine word; sized types carry a `max`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ValueType {
    Bool,
    Int,
    Float,
    Enum,
    String,
    Object,
    List,
}

impl ValueType {
    /// Whether the type is `string`, `object` or `list`.
    pub fn is_sized(self) -> bool {
        matches!(self, Self::String | Self::Object | Self::List)
    }

    /// The type's name as the manifest writes it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bool => "bool",
            Self::Int => "int",
            Self::Float => "float",
            Self::Enum => "enum",
            Self::String => "string",
            Self::Object => "object",
            Self::List => "list",
        }
    }
}

/// An execution mode (section 6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Turns,
    Thread,
    Sidecar,
}

impl Mode {
    /// The mode's name as the manifest and `ABAI_MODE` write it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Turns => "turns",
            Self::Thread => "thread",
            Self::Sidecar => "sidecar",
        }
    }

    /// The mode a name stands for.
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "turns" => Some(Self::Turns),
            "thread" => Some(Self::Thread),
            "sidecar" => Some(Self::Sidecar),
            _ => None,
        }
    }
}

/// Who may write a cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    Read,
    Readwrite,
}

/// Whether a capability changes the program.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effect {
    Read,
    Mutate,
}

/// Where a capability's handler runs (section 5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dispatch {
    Immediate,
    Safepoint,
}

/// The rule on an act of control (section 10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    Auto,
    Confirm,
    Forbid,
}

impl Policy {
    /// The policy's name as the manifest writes it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Confirm => "confirm",
            Self::Forbid => "forbid",
        }
    }
}

/// How the program can be paused (section 5.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pause {
    Cooperative,
    Os,
    None,
}

/// One field of a schema.
///
/// In the manifest a field is a bare type name when the defaults suffice
/// (`job_id: string`), or an object with `type` and the rest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(from = "FieldRepr", into = "FieldRepr")]
pub struct Field {
    pub ty: ValueType,
    /// Sized types only: the largest encoded size in bytes.
    pub max: Option<u32>,
    /// `enum` fields: the values.
    pub values: Option<Vec<String>>,
    /// `object` fields: the fields.
    pub fields: Option<Schema>,
    /// `list` fields: the item schema.
    pub items: Option<Box<Field>>,
    /// The value may be null.
    pub nullable: Option<bool>,
    pub doc: Option<String>,
}

impl Field {
    /// A field of a type with every default.
    pub fn of(ty: ValueType) -> Self {
        Self {
            ty,
            max: None,
            values: None,
            fields: None,
            items: None,
            nullable: None,
            doc: None,
        }
    }

    pub fn bool() -> Self {
        Self::of(ValueType::Bool)
    }

    pub fn int() -> Self {
        Self::of(ValueType::Int)
    }

    pub fn float() -> Self {
        Self::of(ValueType::Float)
    }

    pub fn string() -> Self {
        Self::of(ValueType::String)
    }

    /// An `enum` field with its values.
    pub fn enumeration<S: Into<String>>(values: impl IntoIterator<Item = S>) -> Self {
        let mut field = Self::of(ValueType::Enum);
        field.values = Some(values.into_iter().map(Into::into).collect());
        field
    }

    /// An `object` field with its fields.
    pub fn object(fields: Schema) -> Self {
        let mut field = Self::of(ValueType::Object);
        field.fields = Some(fields);
        field
    }

    /// A `list` field with its item schema.
    pub fn list(items: Field) -> Self {
        let mut field = Self::of(ValueType::List);
        field.items = Some(Box::new(items));
        field
    }

    /// Set the largest encoded size in bytes (sized types).
    pub fn max(mut self, bytes: u32) -> Self {
        self.max = Some(bytes);
        self
    }

    /// Let the value be null.
    pub fn nullable(mut self) -> Self {
        self.nullable = Some(true);
        self
    }

    /// Say what the field is, for the agent.
    pub fn doc(mut self, doc: impl Into<String>) -> Self {
        self.doc = Some(doc.into());
        self
    }

    /// Bytes the field counts toward an event slot: scalars 8, sized fields their `max`.
    pub fn slot_bytes(&self) -> u32 {
        match self.ty {
            ValueType::String => self.max.unwrap_or(DEFAULT_STRING_MAX),
            ValueType::Object | ValueType::List => self.max.unwrap_or(DEFAULT_SIZED_MAX),
            _ => SCALAR_BYTES,
        }
    }

    fn is_bare(&self) -> bool {
        self.max.is_none()
            && self.values.is_none()
            && self.fields.is_none()
            && self.items.is_none()
            && self.nullable.is_none()
            && self.doc.is_none()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum FieldRepr {
    Bare(ValueType),
    Full(FieldObject),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FieldObject {
    #[serde(rename = "type")]
    ty: ValueType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max: Option<u32>,
    #[serde(default, rename = "enum", skip_serializing_if = "Option::is_none")]
    values: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fields: Option<Schema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    items: Option<Box<Field>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    nullable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    doc: Option<String>,
}

impl From<FieldRepr> for Field {
    fn from(repr: FieldRepr) -> Self {
        match repr {
            FieldRepr::Bare(ty) => Field::of(ty),
            FieldRepr::Full(o) => Field {
                ty: o.ty,
                max: o.max,
                values: o.values,
                fields: o.fields,
                items: o.items,
                nullable: o.nullable,
                doc: o.doc,
            },
        }
    }
}

impl From<Field> for FieldRepr {
    fn from(field: Field) -> Self {
        if field.is_bare() {
            return FieldRepr::Bare(field.ty);
        }
        FieldRepr::Full(FieldObject {
            ty: field.ty,
            max: field.max,
            values: field.values,
            fields: field.fields,
            items: field.items,
            nullable: field.nullable,
            doc: field.doc,
        })
    }
}

/// The fields of a payload, a context, parameters, a result or an answer,
/// in the order they were declared.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Schema(pub Vec<(String, Field)>);

impl Schema {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a field.
    pub fn field(mut self, name: impl Into<String>, field: Field) -> Self {
        self.0.push((name.into(), field));
        self
    }

    /// The field of a name.
    pub fn get(&self, name: &str) -> Option<&Field> {
        self.0.iter().find(|(key, _)| key == name).map(|(_, f)| f)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Bytes the payload counts toward an event slot (section 5.1).
    pub fn slot_bytes(&self) -> u32 {
        self.0
            .iter()
            .fold(0u32, |sum, (_, f)| sum.saturating_add(f.slot_bytes()))
    }
}

impl Serialize for Schema {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (name, field) in &self.0 {
            map.serialize_entry(name, field)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for Schema {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = Schema;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object of fields")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Schema, A::Error> {
                let mut fields = Vec::with_capacity(map.size_hint().unwrap_or(0));
                while let Some(entry) = map.next_entry::<String, Field>()? {
                    fields.push(entry);
                }
                Ok(Schema(fields))
            }
        }
        deserializer.deserialize_map(Fields)
    }
}

/// A value that is present, null included: `Some(Value::Null)` for an
/// explicit `null`. An absent key is `None` through `#[serde(default)]`.
fn present_value<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// A cell (section 5.2). A `readwrite` cell is a knob.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CellDecl {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: ValueType,
    pub access: Access,
    pub doc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<u32>,
    #[serde(default, rename = "enum", skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    /// `int` and `float` cells: the least and the greatest value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<[serde_json::Number; 2]>,
    /// Required for `readwrite`.
    #[serde(
        default,
        deserialize_with = "present_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub default: Option<Value>,
    /// A hint, in milliseconds, of how often the value is worth reading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cadence: Option<u32>,
    /// `readwrite` only; a knob is never `forbid`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<Policy>,
    /// Sized knobs only: the delivery timeout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<Schema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Box<Field>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nullable: Option<bool>,
}

impl CellDecl {
    /// The cell's value type as a schema field, for checking a value against it.
    pub fn as_field(&self) -> Field {
        Field {
            ty: self.ty,
            max: self.max,
            values: self.values.clone(),
            fields: self.fields.clone(),
            items: self.items.clone(),
            nullable: self.nullable,
            doc: None,
        }
    }

    /// Whether the agent may write the cell.
    pub fn is_knob(&self) -> bool {
        self.access == Access::Readwrite
    }

    /// The bytes a sized cell's slot holds.
    pub fn slot_bytes(&self) -> u32 {
        self.as_field().slot_bytes()
    }
}

/// An event (section 5.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventDecl {
    pub name: String,
    pub doc: String,
    pub payload: Schema,
    /// `always`, `never`, or a condition on the payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wakes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub large: Option<bool>,
}

/// A capability (section 5.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityDecl {
    pub name: String,
    pub doc: String,
    pub params: Schema,
    pub result: Schema,
    pub effect: Effect,
    pub dispatch: Dispatch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<String>,
    pub policy: Policy,
    /// Valid parameters, as an object.
    #[serde(
        default,
        deserialize_with = "present_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub example: Option<Value>,
}

/// A decision (section 5.4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DecisionDecl {
    pub name: String,
    pub doc: String,
    pub context: Schema,
    /// Either `options` (an enum of choices) or `answer` (a schema).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<Schema>,
    pub default: Value,
    pub timeout: String,
    pub policy: Policy,
}

/// A turn (section 4.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnDecl {
    pub name: String,
    pub doc: String,
    pub timeout: String,
}

/// Where the harness binary is, when the manifest says.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HarnessDecl {
    pub path: Option<String>,
}

/// The command `check` runs, and the slowdown it allows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckDecl {
    pub run: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overhead: Option<String>,
}

/// Where the content slots are, relative to the repository root (section 8).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentDecl {
    pub identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install: Option<String>,
    #[serde(default, rename = "use", skip_serializing_if = "Option::is_none")]
    pub use_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turns: Option<String>,
}

/// Where the audit log is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditDecl {
    pub path: String,
}

/// The stop handler and how long it has.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StopDecl {
    pub graceful: String,
    pub handler: String,
}

/// The policy of each lifecycle operation that changes something.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LifecyclePolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause: Option<Policy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<Policy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<Policy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart: Option<Policy>,
}

/// The lifecycle block (section 5.5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LifecycleDecl {
    pub pause: Pause,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<StopDecl>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<LifecyclePolicy>,
}

/// How often the agent may act (section 5.6).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BudgetDecl {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wakes_per_minute: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_per_hour: Option<u64>,
}

/// The attention block.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttentionDecl {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<BudgetDecl>,
}

/// The policy block.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyDecl {
    /// A confirm unanswered this long is denied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_timeout: Option<String>,
}

/// The agent may be a member of an agent network (section 7).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NetworkDecl {
    /// A run with no membership attaches no agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    /// How members of the network relate to this program's own names.
    pub doc: String,
}

/// The manifest: everything the agent may observe and control (section 7).
///
/// Fields serialize in this order, which is the order of `abaigram.yaml`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub abaigrammar: String,
    pub name: String,
    pub entry: String,
    pub modes: Vec<Mode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<HarnessDecl>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<serde_json::Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<CheckDecl>,
    pub content: ContentDecl,
    pub audit: AuditDecl,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<LifecycleDecl>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention: Option<AttentionDecl>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<PolicyDecl>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<NetworkDecl>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deviations: Vec<String>,
    #[serde(default)]
    pub cells: Vec<CellDecl>,
    #[serde(default)]
    pub events: Vec<EventDecl>,
    #[serde(default)]
    pub capabilities: Vec<CapabilityDecl>,
    #[serde(default)]
    pub decisions: Vec<DecisionDecl>,
    #[serde(default)]
    pub turns: Vec<TurnDecl>,
}

impl Manifest {
    /// The cell of a name.
    pub fn cell(&self, name: &str) -> Option<&CellDecl> {
        self.cells.iter().find(|c| c.name == name)
    }

    /// The event of a name.
    pub fn event(&self, name: &str) -> Option<&EventDecl> {
        self.events.iter().find(|e| e.name == name)
    }

    /// The capability of a name.
    pub fn capability(&self, name: &str) -> Option<&CapabilityDecl> {
        self.capabilities.iter().find(|c| c.name == name)
    }

    /// The decision of a name.
    pub fn decision(&self, name: &str) -> Option<&DecisionDecl> {
        self.decisions.iter().find(|d| d.name == name)
    }

    /// The turn of a name.
    pub fn turn(&self, name: &str) -> Option<&TurnDecl> {
        self.turns.iter().find(|t| t.name == name)
    }

    /// The manifest as pretty JSON with one trailing newline (`manifest --json`).
    pub fn to_json(&self) -> String {
        let mut text = serde_json::to_string_pretty(self).expect("a manifest serializes");
        text.push('\n');
        text
    }
}

/// Whether a name is a valid abai name: lowercase segments joined by dots,
/// words inside a segment joined by underscores (section 5, common rules).
pub fn is_valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.split('.').all(|segment| {
            let mut chars = segment.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
                && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        })
}

/// A duration such as `250ms`, `30s`, `5m` or `1h`, in milliseconds.
pub fn duration_ms(value: &str) -> Option<u64> {
    let digits = value.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let n: u64 = value[..digits].parse().ok()?;
    let unit: u64 = match &value[digits..] {
        "ms" => 1,
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        _ => return None,
    };
    n.checked_mul(unit)
}

/// Whether a value has a declared type.
///
/// `int` takes whole numbers only; `float` any finite number. An object's
/// declared fields must all be present and match; a list's items must all
/// match. Null matches only a `nullable` field.
pub fn matches_type(value: &Value, field: &Field) -> bool {
    if value.is_null() {
        return field.nullable == Some(true);
    }
    match field.ty {
        ValueType::Bool => value.is_boolean(),
        ValueType::Int => {
            const LIMIT: f64 = 9007199254740992.0;
            value.is_i64()
                || value.as_u64().is_some_and(|n| n <= i64::MAX as u64)
                || (value.is_f64()
                    && value.as_f64().is_some_and(|f| {
                        f.is_finite() && f.fract() == 0.0 && (-LIMIT..=LIMIT).contains(&f)
                    }))
        }
        ValueType::Float => value.as_f64().is_some_and(f64::is_finite),
        ValueType::Enum => match (value.as_str(), &field.values) {
            (Some(s), Some(values)) => values.iter().any(|v| v == s),
            _ => false,
        },
        ValueType::String => value.is_string(),
        ValueType::Object => match value.as_object() {
            None => false,
            Some(object) => field.fields.as_ref().is_none_or(|schema| {
                schema
                    .0
                    .iter()
                    .all(|(key, sub)| object.get(key).is_some_and(|v| matches_type(v, sub)))
            }),
        },
        ValueType::List => match value.as_array() {
            None => false,
            Some(items) => field
                .items
                .as_ref()
                .is_none_or(|item| items.iter().all(|v| matches_type(v, item))),
        },
    }
}

/// The longest prefix of a string that is at most `max_bytes` of UTF-8 and
/// ends on a character boundary.
pub fn cut_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names() {
        for good in ["a", "queue.depth", "on_backlog", "a1.b_2.c"] {
            assert!(is_valid_name(good), "{good}");
        }
        for bad in ["", "A", "1a", "a..b", ".a", "a.", "a-b", "a b", "_a", "a.1"] {
            assert!(!is_valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn durations() {
        assert_eq!(duration_ms("250ms"), Some(250));
        assert_eq!(duration_ms("30s"), Some(30_000));
        assert_eq!(duration_ms("5m"), Some(300_000));
        assert_eq!(duration_ms("1h"), Some(3_600_000));
        for bad in [
            "",
            "s",
            "30",
            "30 s",
            "-1s",
            "1.5s",
            "30sec",
            "99999999999999999999s",
        ] {
            assert_eq!(duration_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_bare_field_is_its_type_name() {
        assert_eq!(
            serde_json::to_value(Field::string()).unwrap(),
            json!("string")
        );
        assert_eq!(
            serde_json::to_value(Field::string().max(64)).unwrap(),
            json!({"type": "string", "max": 64})
        );
        let back: Field = serde_json::from_value(json!("int")).unwrap();
        assert_eq!(back, Field::int());
        let back: Field =
            serde_json::from_value(json!({"type": "enum", "enum": ["a", "b"]})).unwrap();
        assert_eq!(back, Field::enumeration(["a", "b"]));
    }

    #[test]
    fn a_field_refuses_what_it_does_not_know() {
        assert!(serde_json::from_value::<Field>(json!("text")).is_err());
        assert!(serde_json::from_value::<Field>(json!({"type": "string", "size": 3})).is_err());
    }

    #[test]
    fn a_schema_keeps_its_order() {
        let schema = Schema::new()
            .field("zeta", Field::int())
            .field("alpha", Field::string().max(64));
        let text = serde_json::to_string(&schema).unwrap();
        assert_eq!(text, r#"{"zeta":"int","alpha":{"type":"string","max":64}}"#);
        let back: Schema = serde_json::from_str(&text).unwrap();
        assert_eq!(back, schema);
        assert_eq!(schema.slot_bytes(), 8 + 64);
    }

    #[test]
    fn types_match() {
        assert!(matches_type(&json!(true), &Field::bool()));
        assert!(matches_type(&json!(3), &Field::int()));
        assert!(matches_type(&json!(3.0), &Field::int()));
        assert!(!matches_type(&json!(3.5), &Field::int()));
        assert!(matches_type(&json!(3.5), &Field::float()));
        assert!(!matches_type(&json!("3"), &Field::float()));
        assert!(matches_type(&json!("a"), &Field::enumeration(["a", "b"])));
        assert!(!matches_type(&json!("c"), &Field::enumeration(["a", "b"])));
        assert!(!matches_type(&json!(null), &Field::string()));
        assert!(matches_type(&json!(null), &Field::string().nullable()));
        let object = Field::object(Schema::new().field("id", Field::string()));
        assert!(matches_type(&json!({"id": "x", "more": 1}), &object));
        assert!(!matches_type(&json!({}), &object));
        let list = Field::list(Field::int());
        assert!(matches_type(&json!([1, 2]), &list));
        assert!(!matches_type(&json!([1, "2"]), &list));
    }

    #[test]
    fn ints_fit_a_signed_word() {
        assert!(matches_type(&json!(i64::MIN), &Field::int()));
        assert!(matches_type(&json!(i64::MAX as u64), &Field::int()));
        assert!(!matches_type(&json!(i64::MAX as u64 + 1), &Field::int()));
        assert!(!matches_type(&json!(u64::MAX), &Field::int()));
        assert!(matches_type(&json!(9007199254740992.0), &Field::int()));
        assert!(matches_type(&json!(-9007199254740992.0), &Field::int()));
        assert!(!matches_type(&json!(18014398509481984.0), &Field::int()));
        assert!(!matches_type(&json!(1e300), &Field::int()));
    }

    #[test]
    fn an_explicit_null_default_round_trips() {
        let cell: CellDecl = serde_json::from_value(json!({
            "name": "note",
            "type": "string",
            "access": "readwrite",
            "doc": "A note.",
            "default": null,
            "nullable": true,
            "policy": "auto"
        }))
        .unwrap();
        assert_eq!(cell.default, Some(Value::Null));
        let text = serde_json::to_string(&cell).unwrap();
        let back: CellDecl = serde_json::from_str(&text).unwrap();
        assert_eq!(back, cell);

        let mut manifest = testdata::sample();
        manifest.cells.push(back);
        assert_eq!(validate(&manifest), Vec::<String>::new());

        let absent: CellDecl = serde_json::from_value(json!({
            "name": "n", "type": "int", "access": "read", "doc": "N."
        }))
        .unwrap();
        assert_eq!(absent.default, None);
        let cap: CapabilityDecl = serde_json::from_value(json!({
            "name": "c", "doc": "C.", "params": {}, "result": {},
            "effect": "read", "dispatch": "safepoint", "policy": "auto",
            "example": null
        }))
        .unwrap();
        assert_eq!(cap.example, Some(Value::Null));
    }

    #[test]
    fn a_cut_keeps_whole_characters() {
        assert_eq!(cut_utf8("héllo", 2), "h");
        assert_eq!(cut_utf8("héllo", 3), "hé");
        assert_eq!(cut_utf8("abc", 8), "abc");
        assert_eq!(cut_utf8("abc", 0), "");
    }
}
