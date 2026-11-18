//! From the machine configuration to a model to talk to.

use std::path::Path;
use std::time::Duration;

use super::anthropic::{self, Anthropic};
use super::openai::OpenAiCompatible;
use super::{Model, Timing};
use crate::config::{self, Config, Credential};

/// A provider this harness knows by name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Known {
    pub id: &'static str,
    /// What it speaks and what it needs, for `config providers`.
    pub about: &'static str,
}

/// The providers known by name. Any other id is an OpenAI-compatible
/// endpoint whose base URL the configuration gives.
pub const PROVIDERS: &[Known] = &[
    Known {
        id: "anthropic",
        about: "the Anthropic Messages API; needs an API key",
    },
    Known {
        id: "freetoken",
        about: "a FreeToken server, OpenAI-compatible; default http://127.0.0.1:1919, no key needed",
    },
    Known {
        id: "openai",
        about: "the OpenAI chat completions API; needs an API key",
    },
];

const FREETOKEN_DEFAULT: &str = "http://127.0.0.1:1919";
const OPENAI_DEFAULT: &str = "https://api.openai.com/v1";

/// The name of a provider's setting or environment variable:
/// `my-host` and `BASE_URL` give `MY_HOST_BASE_URL`.
pub fn setting_name(provider: &str, suffix: &str) -> String {
    let prefix: String = provider
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("{prefix}_{suffix}")
}

/// A provider's setting, such as `BASE_URL`: the configuration's own,
/// then the credential's, then the environment. The configuration and the
/// credential are read under this harness's name for it and under the
/// TypeScript harness's (the id upper-cased as it is); a blank value is
/// skipped.
fn setting(
    home: &Path,
    config: &Config,
    env: &dyn Fn(&str) -> Option<String>,
    provider: &str,
    suffix: &str,
) -> Result<Option<String>, String> {
    let name = setting_name(provider, suffix);
    let names = [
        name.clone(),
        format!("{}_{suffix}", provider.to_uppercase()),
    ];
    let usable = |value: &str| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    };
    for name in &names {
        if let Some(value) = config.provider_setting(provider, name).and_then(usable) {
            return Ok(Some(value));
        }
    }
    for name in &names {
        if let Some(value) = config::credential_setting(home, provider, name)?
            && let Some(value) = usable(&value)
        {
            return Ok(Some(value));
        }
    }
    Ok(env(&name).as_deref().and_then(usable))
}

/// The provider's API key: the stored one, then the environment's.
fn key(
    home: &Path,
    env: &dyn Fn(&str) -> Option<String>,
    provider: &str,
) -> Result<Option<String>, String> {
    if let Some(key) = config::api_key(home, provider)? {
        return Ok(Some(key));
    }
    let from_env = env(&setting_name(provider, "API_KEY"))
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty());
    if from_env.is_some() {
        return Ok(from_env);
    }
    let stored = config::credentials(home)?;
    match stored.iter().find(|(id, _)| id == provider) {
        // an api_key entry without a usable key, as one that carries only `env`
        Some((_, Credential::Other(kind))) if kind != "api_key" => Err(format!(
            "the stored {provider} credential is of kind {kind}, which this harness cannot use; set an API key: config set key {provider}"
        )),
        _ => Ok(None),
    }
}

/// The Anthropic fallback is wanted unless `ANTHROPIC_FALLBACKS` is
/// `off`, `false` or `0`.
fn fallbacks_wanted(config: &Config) -> bool {
    !config
        .provider_setting("anthropic", "ANTHROPIC_FALLBACKS")
        .is_some_and(|value| {
            ["off", "false", "0"]
                .iter()
                .any(|off| value.trim().eq_ignore_ascii_case(off))
        })
}

/// The model the machine is configured for. An error says what is
/// missing; nothing is contacted.
pub fn resolve(
    home: &Path,
    config: &Config,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Box<dyn Model>, String> {
    let (Some(provider), Some(model)) = (config.provider(), config.model()) else {
        return Err(
            "no model is configured: config set provider <id>, then config set model <id>"
                .to_string(),
        );
    };
    let timing = Timing {
        connect: Duration::from_millis(config.connect_timeout_ms()),
        ..Timing::default()
    };
    let base = setting(home, config, env, provider, "BASE_URL")?;
    if let Some(url) = &base
        && !(url.starts_with("http://") || url.starts_with("https://"))
    {
        return Err(format!(
            "{provider}: the base URL {url} does not start with http:// or https://"
        ));
    }
    let key = key(home, env, provider)?;
    let need_key = || format!("{provider} needs an API key: config set key {provider}");
    match provider {
        "anthropic" => Ok(Box::new(Anthropic::new(
            base.as_deref().unwrap_or(anthropic::DEFAULT_BASE_URL),
            &key.ok_or_else(need_key)?,
            model,
            timing,
            fallbacks_wanted(config),
        ))),
        "freetoken" => {
            let server = base.unwrap_or_else(|| FREETOKEN_DEFAULT.to_string());
            let server = server.trim_end_matches('/');
            let root = format!("{}/v1", server.strip_suffix("/v1").unwrap_or(server));
            Ok(Box::new(OpenAiCompatible::new(
                provider,
                &root,
                Some(key.as_deref().unwrap_or("local")),
                model,
                timing,
            )))
        }
        "openai" => Ok(Box::new(OpenAiCompatible::new(
            provider,
            base.as_deref().unwrap_or(OPENAI_DEFAULT),
            Some(&key.ok_or_else(need_key)?),
            model,
            timing,
        ))),
        other => {
            let Some(base) = base else {
                return Err(format!(
                    "{other} is not a provider this harness knows by name; give its OpenAI-compatible base URL: config set url {other} <https://host/v1>"
                ));
            };
            Ok(Box::new(OpenAiCompatible::new(
                other,
                &base,
                key.as_deref(),
                model,
                timing,
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn home(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("abai-resolve-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn none(_: &str) -> Option<String> {
        None
    }

    fn configured(provider: &str, model: &str) -> Config {
        let mut config = Config::default();
        config.set_provider(provider);
        config.set_model(model);
        config
    }

    fn name(result: Result<Box<dyn Model>, String>) -> String {
        result.map(|model| model.name()).unwrap()
    }

    fn error(result: Result<Box<dyn Model>, String>) -> String {
        match result {
            Ok(model) => panic!("resolved {}", model.name()),
            Err(error) => error,
        }
    }

    #[test]
    fn setting_names() {
        assert_eq!(setting_name("anthropic", "API_KEY"), "ANTHROPIC_API_KEY");
        assert_eq!(setting_name("my-host.2", "BASE_URL"), "MY_HOST_2_BASE_URL");
    }

    #[test]
    fn nothing_configured_says_what_to_set() {
        let home = home("empty");
        assert!(
            error(resolve(&home, &Config::default(), &none)).starts_with("no model is configured")
        );
        let mut half = Config::default();
        half.set_provider("anthropic");
        assert!(error(resolve(&home, &half, &none)).starts_with("no model is configured"));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn anthropic_needs_a_key_from_the_store_or_the_environment() {
        let home = home("anthropic");
        let config = configured("anthropic", "claude-opus-5-5");
        assert_eq!(
            error(resolve(&home, &config, &none)),
            "anthropic needs an API key: config set key anthropic"
        );
        let env = |name: &str| (name == "ANTHROPIC_API_KEY").then(|| "sk-env".to_string());
        assert_eq!(
            name(resolve(&home, &config, &env)),
            "anthropic claude-opus-5-5"
        );
        config::set_api_key(&home, "anthropic", "sk-stored").unwrap();
        assert_eq!(
            name(resolve(&home, &config, &none)),
            "anthropic claude-opus-5-5"
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn an_account_login_stored_by_another_harness_is_not_a_key() {
        let home = home("oauth");
        std::fs::write(
            home.join(config::CREDENTIALS_FILE),
            r#"{"anthropic":{"type":"oauth","access":"a","refresh":"r"}}"#,
        )
        .unwrap();
        let config = configured("anthropic", "claude-opus-5-5");
        let message = error(resolve(&home, &config, &none));
        assert!(message.contains("of kind oauth"), "{message}");
        // a key in the environment still works beside it
        let env = |name: &str| (name == "ANTHROPIC_API_KEY").then(|| "sk-env".to_string());
        assert!(resolve(&home, &config, &env).is_ok());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn freetoken_needs_nothing_and_reads_the_url_the_other_harness_stored() {
        let home = home("freetoken");
        let config = configured("freetoken", "qwen");
        assert_eq!(name(resolve(&home, &config, &none)), "freetoken qwen");
        std::fs::write(
            home.join(config::CREDENTIALS_FILE),
            r#"{"freetoken":{"type":"api_key","env":{"FREETOKEN_BASE_URL":"http://box:1919"}}}"#,
        )
        .unwrap();
        assert_eq!(
            setting(&home, &config, &none, "freetoken", "BASE_URL")
                .unwrap()
                .as_deref(),
            Some("http://box:1919")
        );
        // an api_key entry with no key is no key, not an error
        assert_eq!(name(resolve(&home, &config, &none)), "freetoken qwen");
        // the configuration's own setting wins
        let mut own = config.clone();
        own.set_provider_setting("freetoken", "FREETOKEN_BASE_URL", "http://here:1");
        assert_eq!(
            setting(&home, &own, &none, "freetoken", "BASE_URL")
                .unwrap()
                .as_deref(),
            Some("http://here:1")
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn settings_skip_blanks_and_read_the_typescript_name() {
        let home = home("settings");
        let mut config = configured("my-host.2", "m");
        config.set_provider_setting("my-host.2", "MY_HOST_2_BASE_URL", "  ");
        let env = |name: &str| (name == "MY_HOST_2_BASE_URL").then(|| "http://env:1".to_string());
        assert_eq!(
            setting(&home, &config, &env, "my-host.2", "BASE_URL")
                .unwrap()
                .as_deref(),
            Some("http://env:1")
        );
        config.set_provider_setting("my-host.2", "MY-HOST.2_BASE_URL", "http://ts:1");
        assert_eq!(
            setting(&home, &config, &env, "my-host.2", "BASE_URL")
                .unwrap()
                .as_deref(),
            Some("http://ts:1")
        );
        std::fs::write(
            home.join(config::CREDENTIALS_FILE),
            r#"{"x.y":{"type":"api_key","env":{"X.Y_BASE_URL":"http://cred:1"}}}"#,
        )
        .unwrap();
        assert_eq!(
            setting(&home, &Config::default(), &none, "x.y", "BASE_URL")
                .unwrap()
                .as_deref(),
            Some("http://cred:1")
        );
        // the environment is asked only for this harness's name
        let ts_env = |name: &str| (name == "P.Q_BASE_URL").then(|| "http://ts:1".to_string());
        assert_eq!(
            setting(&home, &Config::default(), &ts_env, "p.q", "BASE_URL").unwrap(),
            None
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_key_from_the_environment_is_trimmed() {
        let home = home("trim");
        let env = |name: &str| (name == "OPENAI_API_KEY").then(|| " sk-env \n".to_string());
        assert_eq!(
            key(&home, &env, "openai").unwrap().as_deref(),
            Some("sk-env")
        );
        let blank = |name: &str| (name == "OPENAI_API_KEY").then(|| "  ".to_string());
        assert_eq!(key(&home, &blank, "openai").unwrap(), None);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_base_url_must_be_http() {
        let home = home("scheme");
        let mut config = configured("my-host", "m1");
        config.set_provider_setting("my-host", "MY_HOST_BASE_URL", "ftp://h/v1");
        assert_eq!(
            error(resolve(&home, &config, &none)),
            "my-host: the base URL ftp://h/v1 does not start with http:// or https://"
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_freetoken_url_ending_in_v1_is_not_doubled() {
        let provider =
            crate::model::fake::FakeProvider::start(vec![crate::model::fake::Answer::ok(
                serde_json::json!({
                    "choices": [{"finish_reason": "stop", "message": {"content": "hi"}}]
                }),
            )]);
        let home = home("freetoken-v1");
        let mut config = configured("freetoken", "qwen");
        config.set_provider_setting(
            "freetoken",
            "FREETOKEN_BASE_URL",
            &format!("{}/v1/", provider.url),
        );
        let mut model = resolve(&home, &config, &none).unwrap();
        let messages = [crate::model::Message::User("x".to_string())];
        model
            .complete(&crate::model::Request {
                system: "",
                tools: &[],
                messages: &messages,
                limit: None,
            })
            .unwrap();
        assert_eq!(provider.requests()[0].path, "/v1/chat/completions");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn the_fallback_is_turned_off_by_any_of_its_words() {
        let wanted = |value: Option<&str>| {
            let mut config = configured("anthropic", "claude-opus-5-5");
            if let Some(value) = value {
                config.set_provider_setting("anthropic", "ANTHROPIC_FALLBACKS", value);
            }
            fallbacks_wanted(&config)
        };
        assert!(wanted(None));
        assert!(wanted(Some("on")));
        for off in ["off", "OFF", "false", "False", "0"] {
            assert!(!wanted(Some(off)), "{off}");
        }
    }

    #[test]
    fn an_unknown_provider_is_an_endpoint_with_a_base_url() {
        let home = home("other");
        let mut config = configured("my-host", "m1");
        assert!(error(resolve(&home, &config, &none)).contains("config set url my-host"));
        config.set_provider_setting("my-host", "MY_HOST_BASE_URL", "http://127.0.0.1:9/v1");
        assert_eq!(name(resolve(&home, &config, &none)), "my-host m1");
        assert!(
            error(resolve(&home, &configured("openai", "gpt"), &none)).contains("needs an API key")
        );
        std::fs::remove_dir_all(home).unwrap();
    }
}
