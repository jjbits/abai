//! Machine-level configuration (abaigrammar section 9): one place per user,
//! shared by every abaigram on the machine and by the TypeScript harness.
//! `config.json` names the default provider and model and the connect
//! timeout; `credentials.json`, mode 0600, holds one credential per provider.
//! `ABAI_HOME` relocates the directory. Fields this module does not know are
//! kept as they are when it rewrites a file.

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

pub const ENV_HOME: &str = "ABAI_HOME";
pub const CONFIG_FILE: &str = "config.json";
pub const CREDENTIALS_FILE: &str = "credentials.json";
pub const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 30_000;

/// How long a credential write waits for another writer's lock.
const LOCK_WAIT: Duration = Duration::from_secs(5);
/// A lock older than this was left by a crashed writer and is reclaimed.
const LOCK_STALE: Duration = Duration::from_secs(10);
/// How often a waiting writer retries the lock.
const LOCK_POLL: Duration = Duration::from_millis(25);

/// The configuration home: `ABAI_HOME`, else `$HOME/.abai`.
pub fn home(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(explicit) = env(ENV_HOME) {
        let explicit = explicit.trim();
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }
    match env("HOME") {
        Some(user_home) if !user_home.is_empty() => Some(Path::new(&user_home).join(".abai")),
        _ => None,
    }
}

/// The Rust harness's runtime directory under the home.
pub fn run_dir(home: &Path) -> PathBuf {
    home.join("run-rust")
}

/// `config.json`. Unknown fields are kept.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Config {
    fields: Map<String, Value>,
}

impl Config {
    pub fn provider(&self) -> Option<&str> {
        self.fields.get("provider").and_then(Value::as_str)
    }

    pub fn model(&self) -> Option<&str> {
        self.fields.get("model").and_then(Value::as_str)
    }

    /// `connectTimeoutMs`; the default when absent or not a positive integer.
    pub fn connect_timeout_ms(&self) -> u64 {
        match self.fields.get("connectTimeoutMs").and_then(Value::as_u64) {
            Some(ms) if ms > 0 => ms,
            _ => DEFAULT_CONNECT_TIMEOUT_MS,
        }
    }

    /// `providers[provider][key]`, when it is a string.
    pub fn provider_setting(&self, provider: &str, key: &str) -> Option<&str> {
        self.fields
            .get("providers")?
            .get(provider)?
            .get(key)?
            .as_str()
    }

    /// `aiip.bin`.
    pub fn aiip_bin(&self) -> Option<&str> {
        self.fields.get("aiip")?.get("bin")?.as_str()
    }

    pub fn set_provider(&mut self, id: &str) {
        self.fields
            .insert("provider".to_string(), Value::String(id.to_string()));
    }

    pub fn set_model(&mut self, id: &str) {
        self.fields
            .insert("model".to_string(), Value::String(id.to_string()));
    }

    pub fn set_connect_timeout_ms(&mut self, ms: u64) {
        self.fields
            .insert("connectTimeoutMs".to_string(), Value::from(ms));
    }

    pub fn set_provider_setting(&mut self, provider: &str, key: &str, value: &str) {
        let providers = object_at(&mut self.fields, "providers");
        let settings = object_at(providers, provider);
        settings.insert(key.to_string(), Value::String(value.to_string()));
    }

    /// `None` removes `aiip.bin`, and `aiip` itself if it is then empty.
    pub fn set_aiip_bin(&mut self, path: Option<&str>) {
        match path {
            Some(path) => {
                object_at(&mut self.fields, "aiip")
                    .insert("bin".to_string(), Value::String(path.to_string()));
            }
            None => {
                let now_empty = match self.fields.get_mut("aiip") {
                    Some(Value::Object(aiip)) => {
                        aiip.remove("bin");
                        aiip.is_empty()
                    }
                    _ => false,
                };
                if now_empty {
                    self.fields.remove("aiip");
                }
            }
        }
    }

    pub fn as_value(&self) -> Value {
        Value::Object(self.fields.clone())
    }
}

/// The object under `key`, made (or replacing a non-object) when needed.
fn object_at<'a>(map: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let entry = map
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    match entry {
        Value::Object(object) => object,
        _ => unreachable!("the entry was just made an object"),
    }
}

/// A missing file is an empty config; a file that is not a JSON object is an error.
pub fn load_config(home: &Path) -> Result<Config, String> {
    let path = home.join(CONFIG_FILE);
    Ok(Config {
        fields: read_object(&path)?,
    })
}

pub fn save_config(home: &Path, config: &Config) -> Result<(), String> {
    write_private(&home.join(CONFIG_FILE), &config.fields)
}

/// One stored credential, as far as this harness reads it.
#[derive(Clone, PartialEq, Eq)]
pub enum Credential {
    ApiKey(String),
    /// The credential's `type`, such as `oauth`; its secret is never read.
    Other(String),
}

/// The key is never shown.
impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ApiKey(_) => f.debug_tuple("ApiKey").field(&"(set)").finish(),
            Self::Other(kind) => f.debug_tuple("Other").field(kind).finish(),
        }
    }
}

fn credential_of(entry: &Value) -> Credential {
    let kind = entry.get("type").and_then(Value::as_str);
    match (kind, entry.get("key").and_then(Value::as_str)) {
        (Some("api_key"), Some(key)) => Credential::ApiKey(key.to_string()),
        (Some(kind), _) => Credential::Other(kind.to_string()),
        (None, _) => Credential::Other("unknown".to_string()),
    }
}

/// Every provider in `credentials.json`, in file order; a missing file is empty.
pub fn credentials(home: &Path) -> Result<Vec<(String, Credential)>, String> {
    let all = read_object(&home.join(CREDENTIALS_FILE))?;
    Ok(all
        .iter()
        .map(|(provider, entry)| (provider.clone(), credential_of(entry)))
        .collect())
}

/// The provider's key, only for `{type: "api_key", key: <non-empty string>}`.
pub fn api_key(home: &Path, provider: &str) -> Result<Option<String>, String> {
    let all = read_object(&home.join(CREDENTIALS_FILE))?;
    Ok(match all.get(provider).map(credential_of) {
        Some(Credential::ApiKey(key)) if !key.trim().is_empty() => Some(key),
        _ => None,
    })
}

/// Stores `{"type":"api_key","key":key}`, replacing that provider's entry
/// only; an existing `api_key` entry keeps its other fields, such as `env`.
pub fn set_api_key(home: &Path, provider: &str, key: &str) -> Result<(), String> {
    set_api_key_with(home, provider, key, LOCK_WAIT, LOCK_STALE)
}

fn set_api_key_with(
    home: &Path,
    provider: &str,
    key: &str,
    wait: Duration,
    stale: Duration,
) -> Result<(), String> {
    let path = home.join(CREDENTIALS_FILE);
    with_lock(&path, wait, stale, || {
        let mut all = read_object(&path)?;
        let mut entry = match all.get(provider) {
            Some(Value::Object(old))
                if old.get("type").and_then(Value::as_str) == Some("api_key") =>
            {
                old.clone()
            }
            _ => {
                let mut fresh = Map::new();
                fresh.insert("type".to_string(), Value::String("api_key".to_string()));
                fresh
            }
        };
        entry.insert("key".to_string(), Value::String(key.to_string()));
        all.insert(provider.to_string(), Value::Object(entry));
        write_private(&path, &all)
    })
}

/// A setting a credential carries beside its secret: the TypeScript
/// harness keeps some providers' base URL there (`env.<NAME>` of the
/// entry).
pub fn credential_setting(
    home: &Path,
    provider: &str,
    name: &str,
) -> Result<Option<String>, String> {
    let entries = read_object(&home.join(CREDENTIALS_FILE))?;
    Ok(entries
        .get(provider)
        .and_then(|entry| entry.get("env"))
        .and_then(|env| env.get(name))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string))
}

/// Removes the provider's entry; true when there was one.
pub fn unset_credential(home: &Path, provider: &str) -> Result<bool, String> {
    let path = home.join(CREDENTIALS_FILE);
    with_lock(&path, LOCK_WAIT, LOCK_STALE, || {
        let mut all = read_object(&path)?;
        if all.shift_remove(provider).is_none() {
            return Ok(false);
        }
        write_private(&path, &all)?;
        Ok(true)
    })
}

/// A JSON object file; a missing file is an empty object.
fn read_object(path: &Path) -> Result<Map<String, Value>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    // The parse error carries a line and column only, never the file's text.
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Err(format!("{}: not a JSON object", path.display())),
        Err(error) => Err(format!("{}: not valid JSON: {error}", path.display())),
    }
}

/// The directory exists and is private, whether made now or earlier by something looser.
fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|error| format!("{}: {error}", dir.display()))?;
    let mode = fs::metadata(dir)
        .map_err(|error| format!("{}: {error}", dir.display()))?
        .permissions()
        .mode();
    if mode & 0o077 != 0 {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("{}: {error}", dir.display()))?;
    }
    Ok(())
}

/// Writes the object as two-space JSON with a trailing newline, atomically, mode 0600.
fn write_private(path: &Path, object: &Map<String, Value>) -> Result<(), String> {
    let dir = path.parent().unwrap_or(Path::new("."));
    ensure_private_dir(dir)?;
    let mut text = serde_json::to_string_pretty(object)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    text.push('\n');
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let temp = dir.join(format!(".{name}.{}.{nanos}.tmp", std::process::id()));
    let written = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .and_then(|mut file| {
            file.write_all(text.as_bytes())?;
            file.sync_all()
        })
        .map_err(|error| format!("{}: {error}", temp.display()))
        .and_then(|()| {
            fs::rename(&temp, path).map_err(|error| format!("{}: {error}", path.display()))
        });
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

/// Runs `task` holding `<path>.lock`, taken with O_EXCL with a bounded wait;
/// a lock older than `stale` is a crashed writer's and is reclaimed.
fn with_lock<T>(
    path: &Path,
    wait: Duration,
    stale: Duration,
    task: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let dir = path.parent().unwrap_or(Path::new("."));
    ensure_private_dir(dir)?;
    let mut lock_name = path.as_os_str().to_owned();
    lock_name.push(".lock");
    let lock = PathBuf::from(lock_name);
    let deadline = std::time::Instant::now() + wait;
    loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&lock)
        {
            Ok(_) => break,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let age = fs::metadata(&lock)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|modified| SystemTime::now().duration_since(modified).ok());
                if age.is_some_and(|age| age > stale) && fs::remove_file(&lock).is_ok() {
                    continue;
                }
                if std::time::Instant::now() > deadline {
                    return Err(format!("{}: locked by another writer", lock.display()));
                }
                thread::sleep(LOCK_POLL);
            }
            Err(error) => return Err(format!("{}: {error}", lock.display())),
        }
    }
    let result = task();
    let _ = fs::remove_file(&lock);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "abai-harness-config-{}-{label}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn lock_path(home: &Path) -> PathBuf {
        home.join("credentials.json.lock")
    }

    fn home_from(vars: &[(&str, &str)]) -> Option<PathBuf> {
        let map: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        home(&|name| map.get(name).cloned())
    }

    #[test]
    fn home_prefers_abai_home_then_home() {
        assert_eq!(
            home_from(&[("ABAI_HOME", "/x/abai"), ("HOME", "/u")]),
            Some(PathBuf::from("/x/abai"))
        );
        assert_eq!(
            home_from(&[("HOME", "/u")]),
            Some(PathBuf::from("/u/.abai"))
        );
        assert_eq!(home_from(&[]), None);
        assert_eq!(home_from(&[("ABAI_HOME", ""), ("HOME", "")]), None);
        assert_eq!(
            home_from(&[("ABAI_HOME", ""), ("HOME", "/u")]),
            Some(PathBuf::from("/u/.abai"))
        );
        assert_eq!(run_dir(Path::new("/h")), PathBuf::from("/h/run-rust"));
    }

    #[test]
    fn config_missing_file_is_empty() {
        let dir = scratch("config-missing");
        let config = load_config(&dir).unwrap();
        assert_eq!(config, Config::default());
        assert_eq!(config.connect_timeout_ms(), DEFAULT_CONNECT_TIMEOUT_MS);
        assert_eq!(config.provider(), None);
        assert_eq!(config.aiip_bin(), None);
    }

    #[test]
    fn config_round_trips_and_is_private() {
        let dir = scratch("config-roundtrip");
        let mut config = Config::default();
        config.set_provider("anthropic");
        config.set_model("claude-x");
        config.set_connect_timeout_ms(1234);
        config.set_provider_setting("freetoken", "baseUrl", "http://h");
        config.set_aiip_bin(Some("/bin/aiip"));
        save_config(&dir, &config).unwrap();
        let loaded = load_config(&dir).unwrap();
        assert_eq!(loaded, config);
        assert_eq!(loaded.provider(), Some("anthropic"));
        assert_eq!(loaded.model(), Some("claude-x"));
        assert_eq!(loaded.connect_timeout_ms(), 1234);
        assert_eq!(
            loaded.provider_setting("freetoken", "baseUrl"),
            Some("http://h")
        );
        assert_eq!(loaded.aiip_bin(), Some("/bin/aiip"));
        let text = fs::read_to_string(dir.join(CONFIG_FILE)).unwrap();
        assert!(text.ends_with("}\n"));
        assert!(text.contains("\n  \"provider\": \"anthropic\""));
        assert_eq!(mode(&dir.join(CONFIG_FILE)), 0o600);
        assert_eq!(mode(&dir), 0o700);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn config_tightens_an_existing_home() {
        let dir = scratch("config-tighten");
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        save_config(&dir, &Config::default()).unwrap();
        assert_eq!(mode(&dir), 0o700);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn config_keeps_unknown_fields() {
        let dir = scratch("config-unknown");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(CONFIG_FILE),
            r#"{"deviceId":"d-1","future":{"a":[1,2]},"providers":{"x":{"other":"o"}},"aiip":{"bin":"/a"}}"#,
        )
        .unwrap();
        let mut config = load_config(&dir).unwrap();
        config.set_provider_setting("x", "k", "v");
        config.set_aiip_bin(None);
        save_config(&dir, &config).unwrap();
        let value: Value =
            serde_json::from_str(&fs::read_to_string(dir.join(CONFIG_FILE)).unwrap()).unwrap();
        assert_eq!(value["deviceId"], "d-1");
        assert_eq!(value["future"], serde_json::json!({"a": [1, 2]}));
        assert_eq!(
            value["providers"]["x"],
            serde_json::json!({"other": "o", "k": "v"})
        );
        assert!(value.get("aiip").is_none());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn config_not_an_object_is_an_error() {
        let dir = scratch("config-array");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(CONFIG_FILE), "[]").unwrap();
        let error = load_config(&dir).unwrap_err();
        assert!(error.contains(&dir.join(CONFIG_FILE).display().to_string()));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn credentials_set_list_and_unset() {
        let dir = scratch("credentials");
        set_api_key(&dir, "x", "k1").unwrap();
        assert_eq!(api_key(&dir, "x").unwrap(), Some("k1".to_string()));
        assert_eq!(mode(&dir.join(CREDENTIALS_FILE)), 0o600);
        assert!(unset_credential(&dir, "x").unwrap());
        assert!(!unset_credential(&dir, "x").unwrap());
        assert_eq!(api_key(&dir, "x").unwrap(), None);
        assert!(!lock_path(&dir).exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn credentials_keep_other_kinds() {
        let dir = scratch("credentials-other");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(CREDENTIALS_FILE),
            r#"{"anthropic":{"type":"oauth","access":"a","refresh":"r"},"x":{"type":"api_key","key":"k"},"e":{"type":"api_key","key":""},"n":7}"#,
        )
        .unwrap();
        assert_eq!(
            credentials(&dir).unwrap(),
            vec![
                (
                    "anthropic".to_string(),
                    Credential::Other("oauth".to_string())
                ),
                ("x".to_string(), Credential::ApiKey("k".to_string())),
                ("e".to_string(), Credential::ApiKey(String::new())),
                ("n".to_string(), Credential::Other("unknown".to_string())),
            ]
        );
        assert_eq!(api_key(&dir, "anthropic").unwrap(), None);
        assert_eq!(api_key(&dir, "e").unwrap(), None);
        set_api_key(&dir, "y", "z").unwrap();
        let value: Value =
            serde_json::from_str(&fs::read_to_string(dir.join(CREDENTIALS_FILE)).unwrap()).unwrap();
        assert_eq!(
            value["anthropic"],
            serde_json::json!({"type": "oauth", "access": "a", "refresh": "r"})
        );
        assert_eq!(
            value["y"],
            serde_json::json!({"type": "api_key", "key": "z"})
        );
        assert_eq!(mode(&dir.join(CREDENTIALS_FILE)), 0o600);
        assert!(!lock_path(&dir).exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn credentials_not_an_object_is_an_error() {
        let dir = scratch("credentials-array");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(CREDENTIALS_FILE), "[]").unwrap();
        assert!(
            credentials(&dir)
                .unwrap_err()
                .contains(&dir.join(CREDENTIALS_FILE).display().to_string())
        );
        assert!(set_api_key(&dir, "x", "k").is_err());
        assert!(!lock_path(&dir).exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn lock_held_by_another_writer_times_out() {
        let dir = scratch("lock-fresh");
        fs::create_dir_all(&dir).unwrap();
        fs::write(lock_path(&dir), "").unwrap();
        let error = set_api_key_with(
            &dir,
            "x",
            "k",
            Duration::from_millis(200),
            Duration::from_secs(10),
        )
        .unwrap_err();
        assert!(error.contains(&lock_path(&dir).display().to_string()));
        assert!(!dir.join(CREDENTIALS_FILE).exists());
        // The other writer's lock is left for it; this writer took none.
        fs::remove_file(lock_path(&dir)).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_stale_lock_that_cannot_be_removed_times_out() {
        let dir = scratch("lock-dir");
        fs::create_dir_all(lock_path(&dir)).unwrap();
        thread::sleep(Duration::from_millis(5));
        let started = std::time::Instant::now();
        let error = set_api_key_with(&dir, "x", "k", Duration::from_millis(200), Duration::ZERO)
            .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(1), "{error}");
        assert!(error.contains("locked by another writer"), "{error}");
        assert!(lock_path(&dir).is_dir());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_new_key_keeps_the_entrys_other_fields() {
        let dir = scratch("credentials-keep");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(CREDENTIALS_FILE),
            r#"{"freetoken":{"type":"api_key","env":{"FREETOKEN_BASE_URL":"http://box:1919"}},"anthropic":{"type":"oauth","access":"a"}}"#,
        )
        .unwrap();
        set_api_key(&dir, "freetoken", "k").unwrap();
        set_api_key(&dir, "anthropic", "sk").unwrap();
        let value: Value =
            serde_json::from_str(&fs::read_to_string(dir.join(CREDENTIALS_FILE)).unwrap()).unwrap();
        assert_eq!(
            value["freetoken"],
            serde_json::json!({"type": "api_key", "env": {"FREETOKEN_BASE_URL": "http://box:1919"}, "key": "k"})
        );
        assert_eq!(
            value["anthropic"],
            serde_json::json!({"type": "api_key", "key": "sk"})
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_credential_does_not_show_its_key() {
        assert_eq!(
            format!("{:?}", Credential::ApiKey("sk-secret".to_string())),
            r#"ApiKey("(set)")"#
        );
        assert_eq!(
            format!("{:?}", Credential::Other("oauth".to_string())),
            r#"Other("oauth")"#
        );
    }

    #[test]
    fn a_blank_key_is_no_key() {
        let dir = scratch("credentials-blank");
        set_api_key(&dir, "x", "  ").unwrap();
        assert_eq!(api_key(&dir, "x").unwrap(), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stale_lock_is_reclaimed() {
        let dir = scratch("lock-stale");
        fs::create_dir_all(&dir).unwrap();
        fs::write(lock_path(&dir), "").unwrap();
        thread::sleep(Duration::from_millis(5));
        set_api_key_with(&dir, "x", "k", Duration::from_millis(200), Duration::ZERO).unwrap();
        assert_eq!(api_key(&dir, "x").unwrap(), Some("k".to_string()));
        assert!(!lock_path(&dir).exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
