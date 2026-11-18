//! The audit log (contract section 10): one JSON line per act of control,
//! written by the harness (the real one or the stub's null harness), readable
//! back by the agent.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::time::{now_ms, rfc3339};

/// The most bytes of a reason, an error or a name a line keeps.
const TEXT_CAP: usize = 512;
/// The most bytes of a value's JSON a line keeps.
const VALUE_CAP: usize = 2048;

fn cut(text: &str, cap: usize) -> String {
    crate::manifest::cut_utf8(text, cap).to_string()
}

/// One line of the log, being built.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry(Map<String, Value>);

impl Entry {
    /// An entry for an act (`knob`, `call`, `decision`, `turn`,
    /// `touchpoint`, `lifecycle`, `message`, `counter`) on a named thing.
    pub fn new(act: &str, name: &str) -> Self {
        let mut map = Map::new();
        map.insert("ts".to_string(), Value::String(rfc3339(now_ms())));
        map.insert("act".to_string(), Value::String(act.to_string()));
        map.insert("name".to_string(), Value::String(cut(name, TEXT_CAP)));
        Self(map)
    }

    /// How the act ended: `ok`, `failed`, `denied`, `forbidden`,
    /// `timeout`, `invalid`, `default`.
    pub fn outcome(self, outcome: &str) -> Self {
        self.text("outcome", outcome)
    }

    /// A short text field, cut to a bound.
    pub fn text(mut self, key: &str, text: &str) -> Self {
        self.0
            .insert(key.to_string(), Value::String(cut(text, TEXT_CAP)));
        self
    }

    /// A text field that is left out when there is nothing to say.
    pub fn maybe(self, key: &str, text: Option<&str>) -> Self {
        match text {
            Some(text) if !text.is_empty() => self.text(key, text),
            _ => self,
        }
    }

    /// A value. One whose JSON is over the bound is kept as its cut text.
    pub fn value(mut self, key: &str, value: &Value) -> Self {
        let json = value.to_string();
        let kept = if json.len() <= VALUE_CAP {
            value.clone()
        } else {
            Value::String(cut(&json, VALUE_CAP))
        };
        self.0.insert(key.to_string(), kept);
        self
    }

    /// A count or a duration.
    pub fn number(mut self, key: &str, number: u64) -> Self {
        self.0.insert(key.to_string(), Value::from(number));
        self
    }

    /// The entry as a value.
    pub fn into_value(self) -> Value {
        Value::Object(self.0)
    }
}

/// The audit log of one program.
#[derive(Debug)]
pub struct AuditLog {
    path: PathBuf,
    file: Option<File>,
    failed: Option<String>,
}

/// Where a manifest's audit path is: `~/` is the home directory, and a
/// relative path is under the program's root, or the working directory
/// when the root is not known.
pub fn resolve(declared: &str, root: Option<&Path>, home: Option<&Path>) -> PathBuf {
    if let (Some(rest), Some(home)) = (declared.strip_prefix("~/"), home) {
        return home.join(rest);
    }
    let path = Path::new(declared);
    match root {
        Some(root) if path.is_relative() => root.join(path),
        _ => path.to_path_buf(),
    }
}

impl AuditLog {
    /// Open the log for appending, making its directory. A log that
    /// cannot be opened is kept as failed: the acts go on and `failed`
    /// says why nothing is recorded.
    pub fn open(path: PathBuf) -> Self {
        let opened = (|| {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let mut options = OpenOptions::new();
            options.create(true).append(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            options.open(&path)
        })();
        match opened {
            Ok(file) => Self {
                path,
                file: Some(file),
                failed: None,
            },
            Err(error) => Self {
                path,
                file: None,
                failed: Some(error.to_string()),
            },
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Why the log cannot be written, when it cannot.
    pub fn failed(&self) -> Option<&str> {
        self.failed.as_deref()
    }

    /// Append one line. Returns whether it was written.
    pub fn record(&mut self, entry: Entry) -> bool {
        let Some(file) = self.file.as_mut() else {
            return false;
        };
        let mut line = entry.into_value().to_string();
        line.push('\n');
        match file.write_all(line.as_bytes()) {
            Ok(()) => true,
            Err(error) => {
                self.failed = Some(error.to_string());
                self.file = None;
                false
            }
        }
    }

    /// The last `limit` lines, oldest first. A line that is not JSON is
    /// kept as text.
    pub fn tail(&self, limit: usize) -> Vec<Value> {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return Vec::new();
        };
        let lines: Vec<&str> = text.lines().filter(|line| !line.is_empty()).collect();
        lines[lines.len().saturating_sub(limit)..]
            .iter()
            .map(|line| {
                serde_json::from_str(line).unwrap_or_else(|_| Value::String(line.to_string()))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "abai-audit-{label}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn lines_are_appended_and_read_back() {
        let dir = temp("append");
        let path = dir.join("deep/audit.jsonl");
        let mut log = AuditLog::open(path.clone());
        assert_eq!(log.failed(), None);
        assert!(
            log.record(
                Entry::new("knob", "step")
                    .outcome("ok")
                    .value("value", &json!(5))
                    .text("reason", "the queue is long")
                    .maybe("consent", None)
            )
        );
        assert!(
            log.record(
                Entry::new("call", "reset")
                    .outcome("timeout")
                    .number("ms", 5000)
            )
        );
        drop(log);

        // a second open appends
        let mut log = AuditLog::open(path);
        assert!(log.record(Entry::new("turn", "lap").outcome("ok")));
        let lines = log.tail(10);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["act"], "knob");
        assert_eq!(lines[0]["value"], 5);
        assert_eq!(lines[0]["reason"], "the queue is long");
        assert!(lines[0].get("consent").is_none());
        assert!(lines[0]["ts"].as_str().unwrap().ends_with('Z'));
        assert_eq!(lines[1]["ms"], 5000);
        assert_eq!(log.tail(1)[0]["name"], "lap");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn long_texts_and_values_are_cut() {
        let entry = Entry::new("call", &"n".repeat(600))
            .text("reason", &"é".repeat(400))
            .value("params", &json!({"text": "x".repeat(5000)}))
            .into_value();
        assert_eq!(entry["name"].as_str().unwrap().len(), 512);
        assert_eq!(entry["reason"].as_str().unwrap().len(), 512);
        assert_eq!(entry["params"].as_str().unwrap().len(), 2048);
    }

    #[test]
    fn a_log_that_cannot_be_opened_is_failed_not_fatal() {
        let dir = temp("blocked");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("file"), "x").unwrap();
        let mut log = AuditLog::open(dir.join("file/audit.jsonl"));
        assert!(log.failed().is_some());
        assert!(!log.record(Entry::new("turn", "lap")));
        assert!(log.tail(5).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn paths_resolve_against_home_and_root() {
        let home = Path::new("/home/u");
        let root = Path::new("/repo");
        assert_eq!(
            resolve("~/.abai/audit/p.jsonl", Some(root), Some(home)),
            Path::new("/home/u/.abai/audit/p.jsonl")
        );
        assert_eq!(
            resolve("log/a.jsonl", Some(root), Some(home)),
            Path::new("/repo/log/a.jsonl")
        );
        assert_eq!(
            resolve("/var/a.jsonl", Some(root), None),
            Path::new("/var/a.jsonl")
        );
        assert_eq!(resolve("a.jsonl", None, None), Path::new("a.jsonl"));
        assert_eq!(resolve("~/a.jsonl", None, None), Path::new("~/a.jsonl"));
    }
}
