//! The `config` verb and the online half of `doctor`.

use std::fmt;
use std::io::Write;
use std::path::Path;

use abai_stub::doctor::{CheckStatus, DoctorCheck};
use serde_json::Value;

use crate::config::{self, Config, Credential};
use crate::model::ModelError;
use crate::model::resolve::{PROVIDERS, resolve, setting_name};

/// Where a verb writes and what it reads.
pub struct Io<'a> {
    pub out: &'a mut dyn Write,
    pub err: &'a mut dyn Write,
    pub env: &'a dyn Fn(&str) -> Option<String>,
    /// Reads one line from the user, without its newline; None at end of input.
    pub read_line: &'a mut dyn FnMut() -> Option<String>,
}

impl fmt::Debug for Io<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Io").finish_non_exhaustive()
    }
}

const NO_HOME: &str = "neither ABAI_HOME nor HOME is set";

const USAGE: &str = "usage: config [show]
       config providers
       config set provider <id> | model <id> | connect-timeout <ms>
       config set url <provider> <base url>
       config set key <provider> [key]
       config set aiip-bin <path>
       config unset key <provider> | aiip-bin
       config net [show]
       config net join --token <blob|->
       config net leave <net>
       config net create <name> --as <member> [--lighthouse]
       config net invite <net> --for <member>
";

/// How a verb ended, before it becomes an exit code.
enum Failure {
    /// Exit 1, with this message after `config: `.
    Failed(String),
    /// Exit 2, with this problem after `config: ` and then the usage block.
    Usage(String),
}

fn failed(message: impl Into<String>) -> Failure {
    Failure::Failed(message.into())
}

fn usage(problem: impl Into<String>) -> Failure {
    Failure::Usage(problem.into())
}

fn line(out: &mut dyn Write, text: &str) {
    let _ = writeln!(out, "{text}");
}

/// `<prog> abai config ...`. `args` are the words after `config`. Returns the exit code.
/// `config` on the process's own terminal and environment.
///
/// `program` is the program the entry runs for, when it knows: `config
/// net` finds that program's network directory by it.
pub fn config_stdio(args: &[String], program: Option<&str>) -> i32 {
    let (mut out, mut err) = (std::io::stdout(), std::io::stderr());
    let env = |name: &str| std::env::var(name).ok();
    let mut read_line = || {
        let mut line = String::new();
        match std::io::stdin().read_line(&mut line) {
            Ok(read) if read > 0 => Some(line.trim_end_matches(['\n', '\r']).to_string()),
            _ => None,
        }
    };
    let mut io = Io {
        out: &mut out,
        err: &mut err,
        env: &env,
        read_line: &mut read_line,
    };
    match args.split_first() {
        Some((first, rest)) if first == "net" => run_config_net(rest, &mut io, program, None),
        _ => run_config(args, &mut io),
    }
}

/// `config ...`. `args` are the words after `config`; `net` goes to [`run_config_net`].
pub fn run_config(args: &[String], io: &mut Io<'_>) -> i32 {
    if let Some((first, rest)) = args.split_first()
        && first == "net"
    {
        return run_config_net(rest, io, None, None);
    }
    let Some(home) = config::home(io.env) else {
        line(io.err, &format!("config: {NO_HOME}"));
        return 1;
    };
    exit_code(config_verb(&home, args, io), "config", io.err)
}

/// The exit code of a verb's result; a failure is written after `prefix: `, a usage problem after `config: ` with the usage block.
fn exit_code(result: Result<(), Failure>, prefix: &str, err: &mut dyn Write) -> i32 {
    match result {
        Ok(()) => 0,
        Err(Failure::Failed(message)) => {
            line(err, &format!("{prefix}: {message}"));
            1
        }
        Err(Failure::Usage(problem)) => {
            line(err, &format!("config: {problem}"));
            let _ = err.write_all(USAGE.as_bytes());
            2
        }
    }
}

fn config_verb(home: &Path, args: &[String], io: &mut Io<'_>) -> Result<(), Failure> {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    match words.as_slice() {
        [] | ["show"] => show(home, io.out),
        ["show", extra, ..] => Err(usage(format!("unexpected word {extra}"))),
        ["providers"] => {
            providers(io.out);
            Ok(())
        }
        ["providers", extra, ..] => Err(usage(format!("unexpected word {extra}"))),
        ["set", rest @ ..] => set(home, rest, io),
        ["unset", rest @ ..] => unset(home, rest, io.out),
        ["login", ..] => Err(failed(
            "account logins are not supported by this harness; store an API key with: config set key <provider>",
        )),
        [verb, ..] => Err(usage(format!("unknown verb {verb}"))),
    }
}

fn load(home: &Path) -> Result<Config, Failure> {
    config::load_config(home).map_err(Failure::Failed)
}

fn save(home: &Path, config: &Config) -> Result<(), Failure> {
    config::save_config(home, config).map_err(Failure::Failed)
}

fn show(home: &Path, out: &mut dyn Write) -> Result<(), Failure> {
    let config = load(home)?;
    let stored = config::credentials(home).map_err(Failure::Failed)?;
    let not_set = "(not set)";
    line(out, &format!("home: {}", home.display()));
    line(
        out,
        &format!("provider: {}", config.provider().unwrap_or(not_set)),
    );
    line(
        out,
        &format!("model: {}", config.model().unwrap_or(not_set)),
    );
    line(
        out,
        &format!("connect timeout: {} ms", config.connect_timeout_ms()),
    );
    line(
        out,
        &format!(
            "aiip: {}",
            config.aiip_bin().unwrap_or("(aiip on the PATH)")
        ),
    );
    if let Some(Value::Object(providers)) = config.as_value().get("providers") {
        for (provider, settings) in providers {
            let Value::Object(settings) = settings else {
                continue;
            };
            for (key, value) in settings {
                if let Value::String(value) = value {
                    let value = if key.ends_with("_BASE_URL") {
                        hide_user_info(value)
                    } else {
                        value.clone()
                    };
                    line(out, &format!("{provider} {key}: {value}"));
                }
            }
        }
    }
    line(out, "credentials:");
    if stored.is_empty() {
        line(out, "  (none)");
    }
    for (provider, credential) in &stored {
        match credential {
            Credential::ApiKey(_) => line(out, &format!("  {provider}: api key")),
            Credential::Other(kind) => line(
                out,
                &format!("  {provider}: {kind} (not usable by this harness)"),
            ),
        }
    }
    Ok(())
}

/// A URL with its user info (`user:pass@`) replaced by `***@`.
fn hide_user_info(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let authority = rest.find(['/', '?', '#']).map_or(rest, |end| &rest[..end]);
    match authority.rfind('@') {
        Some(at) => format!("{scheme}://***@{}", &rest[at + 1..]),
        None => url.to_string(),
    }
}

fn providers(out: &mut dyn Write) {
    for known in PROVIDERS {
        line(out, &format!("{}  {}", known.id, known.about));
    }
    line(
        out,
        "<any other id>  an OpenAI-compatible endpoint; give its base URL with: config set url <id> <https://host/v1>",
    );
}

fn is_provider_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn set(home: &Path, words: &[&str], io: &mut Io<'_>) -> Result<(), Failure> {
    match words {
        [] => Err(usage("set needs what to set")),
        ["provider", id] => {
            if !is_provider_id(id) {
                return Err(usage(format!("not a provider id: {id}")));
            }
            let mut config = load(home)?;
            config.set_provider(id);
            save(home, &config)?;
            line(io.out, &format!("provider: {id}"));
            Ok(())
        }
        ["model", id] => {
            if id.trim().is_empty() {
                return Err(usage(format!("not a model id: {id}")));
            }
            let mut config = load(home)?;
            config.set_model(id);
            save(home, &config)?;
            line(io.out, &format!("model: {id}"));
            Ok(())
        }
        ["connect-timeout", ms] => {
            let ms = match ms.parse::<u64>() {
                Ok(ms) if ms > 0 => ms,
                _ => {
                    return Err(usage(
                        "connect-timeout is a positive number of milliseconds",
                    ));
                }
            };
            let mut config = load(home)?;
            config.set_connect_timeout_ms(ms);
            save(home, &config)?;
            line(io.out, &format!("connect timeout: {ms} ms"));
            Ok(())
        }
        ["url", provider, url] => {
            if !is_provider_id(provider) {
                return Err(usage(format!("not a provider id: {provider}")));
            }
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err(usage("a base URL starts with http:// or https://"));
            }
            let mut config = load(home)?;
            config.set_provider_setting(provider, &setting_name(provider, "BASE_URL"), url);
            save(home, &config)?;
            line(io.out, &format!("{provider} base URL: {url}"));
            Ok(())
        }
        ["key", provider] => {
            if !is_provider_id(provider) {
                return Err(usage(format!("not a provider id: {provider}")));
            }
            line(io.err, "(the key is shown as you type)");
            let _ = write!(io.err, "key for {provider}: ");
            let _ = io.err.flush();
            let key = (io.read_line)().unwrap_or_default();
            store_key(home, provider, &key, io.out)
        }
        ["key", provider, key] => {
            if !is_provider_id(provider) {
                return Err(usage(format!("not a provider id: {provider}")));
            }
            store_key(home, provider, key, io.out)?;
            line(
                io.err,
                "note: a key given on the command line stays in the shell's history; leave it out to be asked for it",
            );
            Ok(())
        }
        ["aiip-bin", path] => {
            let mut config = load(home)?;
            config.set_aiip_bin(Some(path));
            save(home, &config)?;
            line(io.out, &format!("aiip: {path}"));
            Ok(())
        }
        ["url"] | ["url", _] => Err(usage("set url needs a provider and a base URL")),
        [what] => match *what {
            "provider" | "model" | "connect-timeout" | "key" | "aiip-bin" => {
                Err(usage(format!("set {what} needs a value")))
            }
            _ => Err(usage(format!("cannot set {what}"))),
        },
        [what, ..] => match *what {
            "provider" | "model" | "connect-timeout" | "url" | "key" | "aiip-bin" => {
                Err(usage(format!("too many words for set {what}")))
            }
            _ => Err(usage(format!("cannot set {what}"))),
        },
    }
}

fn store_key(home: &Path, provider: &str, key: &str, out: &mut dyn Write) -> Result<(), Failure> {
    let key = key.trim();
    if key.is_empty() {
        return Err(failed("no key given"));
    }
    config::set_api_key(home, provider, key).map_err(Failure::Failed)?;
    line(out, &format!("{provider}: key stored"));
    Ok(())
}

fn unset(home: &Path, words: &[&str], out: &mut dyn Write) -> Result<(), Failure> {
    match words {
        [] => Err(usage("unset needs what to unset")),
        ["key", provider] => {
            if !is_provider_id(provider) {
                return Err(usage(format!("not a provider id: {provider}")));
            }
            if config::unset_credential(home, provider).map_err(Failure::Failed)? {
                line(out, &format!("{provider}: key removed"));
            } else {
                line(out, &format!("{provider}: no key was stored"));
            }
            Ok(())
        }
        ["key"] => Err(usage("unset key needs a provider")),
        ["aiip-bin"] => {
            let mut config = load(home)?;
            config.set_aiip_bin(None);
            save(home, &config)?;
            line(out, "aiip is aiip on the PATH again");
            Ok(())
        }
        ["key" | "aiip-bin", ..] => Err(usage(format!("too many words for unset {}", words[0]))),
        [what, ..] => Err(usage(format!("cannot unset {what}"))),
    }
}

fn check(name: &str, status: CheckStatus, detail: impl Into<String>) -> DoctorCheck {
    DoctorCheck {
        name: name.to_string(),
        status,
        detail: detail.into(),
    }
}

/// The online half of `doctor`: is a model configured, and does its provider answer.
pub fn doctor_online(env: &dyn Fn(&str) -> Option<String>) -> Vec<DoctorCheck> {
    let Some(home) = config::home(env) else {
        return vec![check("model", CheckStatus::Fail, NO_HOME)];
    };
    let config = match config::load_config(&home) {
        Ok(config) => config,
        Err(error) => return vec![check("model", CheckStatus::Fail, error)],
    };
    let model = match resolve(&home, &config, env) {
        Ok(model) => model,
        Err(error) => return vec![check("model", CheckStatus::Fail, error)],
    };
    let configured = check(
        "model",
        CheckStatus::Ok,
        format!("{} is configured", model.name()),
    );
    let reachable = match model.probe() {
        Ok(detail) => check("model.reachable", CheckStatus::Ok, detail),
        Err(ModelError::Unreachable(why)) => check(
            "model.reachable",
            CheckStatus::Fail,
            format!("the provider could not be reached: {why}"),
        ),
        Err(ModelError::Rejected {
            status: status @ (401 | 403),
            message,
        }) => check(
            "model.reachable",
            CheckStatus::Fail,
            format!("the provider refused the key ({status}): {message}"),
        ),
        Err(ModelError::Rejected {
            status: status @ (404 | 405),
            ..
        }) => check(
            "model.reachable",
            CheckStatus::Skip,
            format!("the provider has no model list to ask ({status})"),
        ),
        Err(other) => check("model.reachable", CheckStatus::Fail, other.to_string()),
    };
    vec![configured, reachable]
}

/// What `config net` and the doctor's network check say on a system without Unix sockets.
#[cfg(not(unix))]
const NO_UNIX: &str = "config net needs a Unix system in this build";

/// `config net ...`: this program's identity on an aiip network. `args`
/// are the words after `config net`. `program` is the program's name when
/// the entry knows it; it picks the network directory. `spawn` starts the
/// daemon in tests; `None` starts the aiip binary. Returns the exit code.
pub fn run_config_net(
    args: &[String],
    io: &mut Io<'_>,
    program: Option<&str>,
    spawn: Option<crate::net::daemon::SpawnFn>,
) -> i32 {
    #[cfg(unix)]
    {
        let result = network::config_net(args, io, program, spawn);
        exit_code(result, "config net", io.err)
    }
    #[cfg(not(unix))]
    {
        let _ = (args, program, spawn);
        line(io.err, NO_UNIX);
        1
    }
}

/// The doctor's network checks: the aiip binary, the daemon, the
/// memberships. Never starts a daemon. Silent when the manifest declares
/// no network and the environment configures none. A problem is a `Fail`
/// only when the manifest's `network.required` is true; otherwise a `Skip`.
pub fn doctor_network(
    env: &dyn Fn(&str) -> Option<String>,
    program: Option<&str>,
    declared: Option<&abai_stub::manifest::NetworkDecl>,
) -> Vec<DoctorCheck> {
    #[cfg(unix)]
    {
        network::doctor_checks(env, program, declared)
    }
    #[cfg(not(unix))]
    {
        let _ = (env, program, declared);
        vec![check("aiip.daemon", CheckStatus::Skip, NO_UNIX)]
    }
}

/// `config net` and the doctor's network checks, on the aiip daemon of a state directory.
#[cfg(unix)]
mod network {
    use std::path::{Path, PathBuf};

    use abai_stub::doctor::{CheckStatus, DoctorCheck};
    use abai_stub::manifest::NetworkDecl;

    use super::{Failure, Io, check, failed, line, usage};
    use crate::config::{self, Config};
    use crate::net::{
        AiipClient, AiipError, AiipMembership, CreateNetworkRequest, ENV_NET_DIR, ENV_NET_TOKEN,
        EnsureOptions, KNOWN_AIIP_API, NO_BINARY, NetworkMembership, SpawnFn, aiip_binary_for,
        ensure_aiip_daemon, memberships_on_disk, network_dir_for, no_membership, socket_path_for,
    };

    /// The machine's configuration; an empty one when there is no home.
    fn machine_config(env: &dyn Fn(&str) -> Option<String>) -> Result<Config, String> {
        match config::home(env) {
            Some(home) => config::load_config(&home),
            None => Ok(Config::default()),
        }
    }

    /// Whether the variable holds more than blanks.
    fn is_set(env: &dyn Fn(&str) -> Option<String>, name: &str) -> bool {
        env(name).is_some_and(|value| !value.trim().is_empty())
    }

    /// The value after `name`: `None` when the flag is absent, empty when it has no value (a value never starts with `--`).
    fn flag<'a>(args: &[&'a str], name: &str) -> Option<&'a str> {
        let at = args.iter().position(|arg| *arg == name)?;
        match args.get(at + 1) {
            Some(value) if !value.starts_with("--") => Some(value),
            _ => Some(""),
        }
    }

    fn from_daemon(m: &AiipMembership) -> NetworkMembership {
        NetworkMembership {
            network: m.network_name.clone(),
            id: m.network_id.clone(),
            member: m.self_name.clone(),
            addr: m.self_addr.clone(),
            authority: m.authority,
            peers: m.peers,
        }
    }

    fn membership_line(m: &NetworkMembership) -> String {
        let authority = if m.authority { ", authority" } else { "" };
        format!("  {} on {} ({}){authority}", m.member, m.network, m.addr)
    }

    /// `config net [show|join|leave|create|invite]`.
    pub(super) fn config_net(
        args: &[String],
        io: &mut Io<'_>,
        program: Option<&str>,
        spawn: Option<SpawnFn>,
    ) -> Result<(), Failure> {
        let Some(dir) = network_dir_for(io.env, program).map_err(failed)? else {
            return Err(usage(format!(
                "config net needs the program (run it as <prog> abai config net ...) or {ENV_NET_DIR}"
            )));
        };
        let words: Vec<&str> = args.iter().map(String::as_str).collect();
        let (what, rest) = match words.split_first() {
            Some((what, rest)) => (Some(*what), rest),
            None => (None, &[][..]),
        };
        match what {
            None | Some("show") => show_net(&dir, io),
            Some("join") => {
                let token = match flag(rest, "--token") {
                    None | Some("") => return Err(usage("net join takes: --token <blob|->")),
                    Some("-") => read_token(io),
                    Some(token) => token.to_string(),
                };
                if token.is_empty() {
                    return Err(usage("no token given"));
                }
                with_daemon(&dir, io, spawn, |client, io| {
                    let m = client.join(&token)?.membership;
                    line(
                        io.out,
                        &format!(
                            "joined {} as {} ({})",
                            m.network_name, m.self_name, m.self_addr
                        ),
                    );
                    Ok(())
                })
            }
            Some("leave") => {
                let net = rest.first().copied().unwrap_or("");
                if net.is_empty() {
                    return Err(usage("net leave takes: <net>"));
                }
                with_daemon(&dir, io, spawn, |client, io| {
                    client.leave(net)?;
                    line(io.out, &format!("left {net}"));
                    Ok(())
                })
            }
            Some("create") => {
                let name = rest.first().copied().unwrap_or("");
                let as_ = flag(rest, "--as").unwrap_or("");
                if name.is_empty() || name.starts_with("--") || as_.is_empty() {
                    return Err(usage(
                        "net create takes: <name> --as <member> [--lighthouse]",
                    ));
                }
                let request = CreateNetworkRequest {
                    name: name.to_string(),
                    as_: as_.to_string(),
                    lighthouse: rest.contains(&"--lighthouse"),
                };
                with_daemon(&dir, io, spawn, |client, io| {
                    let m = client.create(&request)?;
                    let lighthouse = if m.lighthouse == Some(true) {
                        " and lighthouse"
                    } else {
                        ""
                    };
                    line(
                        io.out,
                        &format!(
                            "created {} as {} ({}), the authority{lighthouse}",
                            m.network_name, m.self_name, m.self_addr
                        ),
                    );
                    Ok(())
                })
            }
            Some("invite") => {
                let net = rest.first().copied().unwrap_or("");
                let for_name = flag(rest, "--for").unwrap_or("");
                if net.is_empty() || net.starts_with("--") || for_name.is_empty() {
                    return Err(usage("net invite takes: <net> --for <member>"));
                }
                with_daemon(&dir, io, spawn, |client, io| {
                    let invite = client.invite(net, for_name)?;
                    // the token alone on out, so it can be piped; what it is on err
                    line(io.out, &invite.token);
                    line(
                        io.err,
                        &format!(
                            "invite for {} ({}) on {net}: a bearer secret, hand it to that member's run as {ENV_NET_TOKEN}",
                            invite.name, invite.addr
                        ),
                    );
                    Ok(())
                })
            }
            Some(other) => Err(usage(format!("unknown net subcommand {other}"))),
        }
    }

    /// The invite token from the user: one line, trimmed; empty at end of input.
    fn read_token(io: &mut Io<'_>) -> String {
        let _ = write!(io.err, "Invite token: ");
        let _ = io.err.flush();
        (io.read_line)()
            .map(|token| token.trim().to_string())
            .unwrap_or_default()
    }

    /// Run one operation against the directory's daemon, started when none
    /// answers. A daemon started in a directory the run owns (`ABAI_NET_DIR`)
    /// is ended after; one in the shared per-program directory stays, as the
    /// aiip CLI leaves its daemons, so a program running beside this command
    /// keeps its network.
    fn with_daemon(
        dir: &Path,
        io: &mut Io<'_>,
        spawn: Option<SpawnFn>,
        operation: impl FnOnce(&AiipClient, &mut Io<'_>) -> Result<(), AiipError>,
    ) -> Result<(), Failure> {
        let config = machine_config(io.env).map_err(failed)?;
        let Some(bin) = aiip_binary_for(io.env, &config) else {
            return Err(failed(NO_BINARY));
        };
        let mut options = EnsureOptions::new(bin);
        options.spawn = spawn;
        let daemon = ensure_aiip_daemon(dir, options).map_err(failed)?;
        let result = operation(&daemon.client, io);
        if is_set(io.env, ENV_NET_DIR) {
            daemon.stop();
        }
        result.map_err(|error| failed(error.to_string()))
    }

    fn show_net(dir: &Path, io: &mut Io<'_>) -> Result<(), Failure> {
        let config = machine_config(io.env).map_err(failed)?;
        line(io.out, &format!("network dir: {}", dir.display()));
        let bin = aiip_binary_for(io.env, &config);
        let bin = bin.as_ref().map_or_else(
            || "(none found)".to_string(),
            |bin| bin.display().to_string(),
        );
        line(io.out, &format!("aiip: {bin}"));
        let socket = socket_path_for(dir).map_err(failed)?;
        let client = AiipClient::new(&socket);
        let memberships = match client.status() {
            Ok(status) => {
                line(
                    io.out,
                    &format!(
                        "daemon: running ({}, pid {}) at {}",
                        status.version,
                        status.pid,
                        socket.display()
                    ),
                );
                let listed = client
                    .networks()
                    .map_err(|error| failed(error.to_string()))?;
                listed.iter().map(from_daemon).collect()
            }
            Err(_) => {
                line(io.out, "daemon: not running (it starts with the harness)");
                memberships_on_disk(dir)
            }
        };
        if memberships.is_empty() {
            line(io.out, "memberships: (none)");
        } else {
            line(io.out, "memberships:");
            for m in &memberships {
                line(io.out, &membership_line(m));
            }
        }
        Ok(())
    }

    pub(super) fn doctor_checks(
        env: &dyn Fn(&str) -> Option<String>,
        program: Option<&str>,
        declared: Option<&NetworkDecl>,
    ) -> Vec<DoctorCheck> {
        let mut checks = Vec::new();
        let required = declared.is_some_and(|d| d.required == Some(true));
        let configured = is_set(env, ENV_NET_DIR) || is_set(env, ENV_NET_TOKEN);
        // a program with no network and a run with none configured: nothing to check, and nothing to say
        if declared.is_none() && !configured {
            return checks;
        }
        // a problem with a network the program does not require is a skip, never a fail
        let problem = if required {
            CheckStatus::Fail
        } else {
            CheckStatus::Skip
        };
        checks.push(match machine_config(env) {
            Ok(config) => match aiip_binary_for(env, &config) {
                Some(bin) => check("aiip.binary", CheckStatus::Ok, bin.display().to_string()),
                None => check("aiip.binary", problem, NO_BINARY),
            },
            Err(error) => check("aiip.binary", problem, error),
        });
        let dir: PathBuf = match network_dir_for(env, program) {
            Ok(Some(dir)) => dir,
            Ok(None) => {
                checks.push(check(
                    "aiip.daemon",
                    CheckStatus::Skip,
                    format!("no program named and {ENV_NET_DIR} unset"),
                ));
                return checks;
            }
            Err(error) => {
                checks.push(check("aiip.daemon", problem, error));
                return checks;
            }
        };
        let socket = match socket_path_for(&dir) {
            Ok(socket) => socket,
            Err(error) => {
                checks.push(check("aiip.daemon", problem, error));
                return checks;
            }
        };
        let client = AiipClient::new(&socket);
        let memberships = match client.status() {
            Ok(status) => {
                if !status.version.starts_with("aiip-") {
                    let quoted = serde_json::to_string(&status.version)
                        .unwrap_or_else(|_| status.version.clone());
                    checks.push(check(
                        "aiip.daemon",
                        problem,
                        format!(
                            "what answers at {} is not aiipd (version {quoted})",
                            socket.display()
                        ),
                    ));
                    return checks;
                }
                let skew = if status.version == KNOWN_AIIP_API {
                    String::new()
                } else {
                    format!(" (this harness knows {KNOWN_AIIP_API})")
                };
                checks.push(check(
                    "aiip.daemon",
                    CheckStatus::Ok,
                    format!("{} at {}{skew}", status.version, socket.display()),
                ));
                match client.networks() {
                    Ok(listed) => listed.iter().map(from_daemon).collect::<Vec<_>>(),
                    Err(error) => {
                        checks.push(check(
                            "aiip.network",
                            problem,
                            format!("memberships could not be listed: {error}"),
                        ));
                        return checks;
                    }
                }
            }
            Err(_) => {
                checks.push(check(
                    "aiip.daemon",
                    CheckStatus::Skip,
                    format!(
                        "not running at {} (it starts with the harness)",
                        dir.display()
                    ),
                ));
                memberships_on_disk(&dir)
            }
        };
        checks.push(if memberships.is_empty() {
            check("aiip.network", problem, no_membership(&dir))
        } else {
            let names: Vec<String> = memberships
                .iter()
                .map(|m| format!("{} on {}", m.member, m.network))
                .collect();
            check("aiip.network", CheckStatus::Ok, names.join(", "))
        });
        checks
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::fake::{Answer, FakeProvider};
    use serde_json::json;
    use std::path::PathBuf;

    fn scratch(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("abai-harness-cli-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// What one run of `config` came to.
    struct Run {
        code: i32,
        out: String,
        err: String,
    }

    fn run_with(home: &Path, words: &[&str], mut input: Vec<String>) -> Run {
        let home_text = home.display().to_string();
        let env = move |name: &str| (name == "ABAI_HOME").then(|| home_text.clone());
        run_env(&env, words, &mut input)
    }

    fn run_env(
        env: &dyn Fn(&str) -> Option<String>,
        words: &[&str],
        input: &mut Vec<String>,
    ) -> Run {
        let args: Vec<String> = words.iter().map(|word| word.to_string()).collect();
        captured(env, input, |io| run_config(&args, io))
    }

    /// One run of a verb on captured streams, reading lines from the end of `input`.
    fn captured(
        env: &dyn Fn(&str) -> Option<String>,
        input: &mut Vec<String>,
        verb: impl FnOnce(&mut Io<'_>) -> i32,
    ) -> Run {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut read_line = || input.pop();
        let code = {
            let mut io = Io {
                out: &mut out,
                err: &mut err,
                env,
                read_line: &mut read_line,
            };
            verb(&mut io)
        };
        Run {
            code,
            out: String::from_utf8(out).unwrap(),
            err: String::from_utf8(err).unwrap(),
        }
    }

    fn run(home: &Path, words: &[&str]) -> Run {
        run_with(home, words, Vec::new())
    }

    fn done(home: &Path, words: &[&str], out: &str) {
        let result = run(home, words);
        assert_eq!(result.code, 0, "{words:?}: {}", result.err);
        assert_eq!(result.out, out, "{words:?}");
        assert_eq!(result.err, "", "{words:?}");
    }

    fn usage_error(home: &Path, words: &[&str], problem: &str) {
        let result = run(home, words);
        assert_eq!(result.code, 2, "{words:?}");
        assert_eq!(result.out, "", "{words:?}");
        assert_eq!(
            result.err,
            format!("config: {problem}\n{USAGE}"),
            "{words:?}"
        );
    }

    fn env_for(home: &Path) -> impl Fn(&str) -> Option<String> {
        let home_text = home.display().to_string();
        move |name: &str| (name == "ABAI_HOME").then(|| home_text.clone())
    }

    #[test]
    fn show_on_an_empty_home() {
        let home = scratch("show-empty");
        let expected = format!(
            "home: {}\nprovider: (not set)\nmodel: (not set)\nconnect timeout: 30000 ms\naiip: (aiip on the PATH)\ncredentials:\n  (none)\n",
            home.display()
        );
        done(&home, &[], &expected);
        done(&home, &["show"], &expected);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn show_after_settings_and_a_key() {
        let home = scratch("show-set");
        done(&home, &["set", "provider", "local"], "provider: local\n");
        done(&home, &["set", "model", "m1"], "model: m1\n");
        done(
            &home,
            &["set", "connect-timeout", "1500"],
            "connect timeout: 1500 ms\n",
        );
        done(
            &home,
            &["set", "url", "local", "http://127.0.0.1:9/v1"],
            "local base URL: http://127.0.0.1:9/v1\n",
        );
        done(
            &home,
            &["set", "aiip-bin", "/opt/aiip"],
            "aiip: /opt/aiip\n",
        );
        let stored = run(&home, &["set", "key", "local", "sk-secret-text"]);
        assert_eq!(stored.code, 0, "{}", stored.err);
        assert_eq!(stored.out, "local: key stored\n");
        std::fs::write(
            home.join(config::CREDENTIALS_FILE),
            std::fs::read_to_string(home.join(config::CREDENTIALS_FILE))
                .unwrap()
                .replacen(
                    '{',
                    r#"{"anthropic":{"type":"oauth","access":"a-secret"},"#,
                    1,
                ),
        )
        .unwrap();
        let result = run(&home, &["show"]);
        assert_eq!(result.code, 0, "{}", result.err);
        assert_eq!(
            result.out,
            format!(
                "home: {}\nprovider: local\nmodel: m1\nconnect timeout: 1500 ms\naiip: /opt/aiip\nlocal LOCAL_BASE_URL: http://127.0.0.1:9/v1\ncredentials:\n  anthropic: oauth (not usable by this harness)\n  local: api key\n",
                home.display()
            )
        );
        assert!(!result.out.contains("sk-secret-text"));
        assert!(!result.out.contains("a-secret"));
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn show_hides_user_info_in_a_base_url() {
        let home = scratch("show-userinfo");
        done(
            &home,
            &["set", "url", "local", "https://me:pw@h:8/v1?x=a@b"],
            "local base URL: https://me:pw@h:8/v1?x=a@b\n",
        );
        let result = run(&home, &["show"]);
        assert_eq!(result.code, 0, "{}", result.err);
        assert!(
            result
                .out
                .contains("local LOCAL_BASE_URL: https://***@h:8/v1?x=a@b\n"),
            "{}",
            result.out
        );
        assert!(!result.out.contains("me:pw"));
        assert_eq!(hide_user_info("http://h/v1"), "http://h/v1");
        assert_eq!(hide_user_info("http://u@h"), "http://***@h");
        assert_eq!(hide_user_info("not a url"), "not a url");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn providers_lists_the_known_ones_and_any_other() {
        let home = scratch("providers");
        let mut expected = String::new();
        for known in PROVIDERS {
            expected.push_str(&format!("{}  {}\n", known.id, known.about));
        }
        expected.push_str("<any other id>  an OpenAI-compatible endpoint; give its base URL with: config set url <id> <https://host/v1>\n");
        done(&home, &["providers"], &expected);
        assert!(expected.starts_with("anthropic  the Anthropic Messages API"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn set_stores_each_value() {
        let home = scratch("set");
        done(
            &home,
            &["set", "provider", "my-host.2_x"],
            "provider: my-host.2_x\n",
        );
        done(&home, &["set", "model", "gpt-x"], "model: gpt-x\n");
        done(
            &home,
            &["set", "connect-timeout", "250"],
            "connect timeout: 250 ms\n",
        );
        done(
            &home,
            &["set", "url", "my-host.2_x", "https://h/v1"],
            "my-host.2_x base URL: https://h/v1\n",
        );
        done(
            &home,
            &["set", "aiip-bin", "/bin/aiip"],
            "aiip: /bin/aiip\n",
        );
        let config = config::load_config(&home).unwrap();
        assert_eq!(config.provider(), Some("my-host.2_x"));
        assert_eq!(config.model(), Some("gpt-x"));
        assert_eq!(config.connect_timeout_ms(), 250);
        assert_eq!(
            config.provider_setting("my-host.2_x", "MY_HOST_2_X_BASE_URL"),
            Some("https://h/v1")
        );
        assert_eq!(config.aiip_bin(), Some("/bin/aiip"));
        done(
            &home,
            &["unset", "aiip-bin"],
            "aiip is aiip on the PATH again\n",
        );
        assert_eq!(config::load_config(&home).unwrap().aiip_bin(), None);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn set_key_takes_the_word_or_a_line_and_never_echoes_it() {
        let home = scratch("key");
        let result = run_with(
            &home,
            &["set", "key", "openai"],
            vec!["  sk-read  ".to_string()],
        );
        assert_eq!(result.code, 0, "{}", result.err);
        assert_eq!(result.out, "openai: key stored\n");
        assert_eq!(
            result.err,
            "(the key is shown as you type)\nkey for openai: "
        );
        assert_eq!(
            config::api_key(&home, "openai").unwrap(),
            Some("sk-read".to_string())
        );
        let result = run(&home, &["set", "key", "anthropic", "sk-word"]);
        assert_eq!(result.code, 0, "{}", result.err);
        assert_eq!(result.out, "anthropic: key stored\n");
        assert_eq!(
            result.err,
            "note: a key given on the command line stays in the shell's history; leave it out to be asked for it\n"
        );
        assert_eq!(
            config::api_key(&home, "anthropic").unwrap(),
            Some("sk-word".to_string())
        );
        done(
            &home,
            &["unset", "key", "anthropic"],
            "anthropic: key removed\n",
        );
        done(
            &home,
            &["unset", "key", "anthropic"],
            "anthropic: no key was stored\n",
        );
        assert_eq!(config::api_key(&home, "anthropic").unwrap(), None);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn set_key_with_no_input_fails() {
        let home = scratch("key-none");
        let result = run(&home, &["set", "key", "openai"]);
        assert_eq!(result.code, 1);
        assert_eq!(result.out, "");
        let asked = "(the key is shown as you type)\nkey for openai: ";
        assert_eq!(result.err, format!("{asked}config: no key given\n"));
        let result = run_with(&home, &["set", "key", "openai"], vec!["   ".to_string()]);
        assert_eq!(result.code, 1);
        assert_eq!(result.err, format!("{asked}config: no key given\n"));
        assert_eq!(config::api_key(&home, "openai").unwrap(), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn usage_errors_exit_2_with_the_usage() {
        let home = scratch("usage");
        usage_error(&home, &["frob"], "unknown verb frob");
        usage_error(&home, &["show", "x"], "unexpected word x");
        usage_error(&home, &["providers", "x"], "unexpected word x");
        usage_error(&home, &["set"], "set needs what to set");
        usage_error(&home, &["set", "colour", "red"], "cannot set colour");
        usage_error(&home, &["set", "provider"], "set provider needs a value");
        usage_error(&home, &["set", "model"], "set model needs a value");
        usage_error(
            &home,
            &["set", "connect-timeout"],
            "set connect-timeout needs a value",
        );
        usage_error(&home, &["set", "key"], "set key needs a value");
        usage_error(&home, &["set", "aiip-bin"], "set aiip-bin needs a value");
        usage_error(
            &home,
            &["set", "provider", "a", "b"],
            "too many words for set provider",
        );
        usage_error(
            &home,
            &["set", "key", "a", "b", "c"],
            "too many words for set key",
        );
        usage_error(&home, &["set", "provider", "a/b"], "not a provider id: a/b");
        usage_error(&home, &["set", "provider", ""], "not a provider id: ");
        usage_error(&home, &["set", "model", ""], "not a model id: ");
        usage_error(&home, &["set", "model", "  "], "not a model id:   ");
        usage_error(&home, &["set", "key", "a/b"], "not a provider id: a/b");
        usage_error(
            &home,
            &["set", "key", "a/b", "sk"],
            "not a provider id: a/b",
        );
        usage_error(
            &home,
            &["set", "url", "a b", "https://h/v1"],
            "not a provider id: a b",
        );
        usage_error(&home, &["unset", "key", ""], "not a provider id: ");
        for bad in ["0", "-5", "1.5", "soon"] {
            usage_error(
                &home,
                &["set", "connect-timeout", bad],
                "connect-timeout is a positive number of milliseconds",
            );
        }
        usage_error(
            &home,
            &["set", "url"],
            "set url needs a provider and a base URL",
        );
        usage_error(
            &home,
            &["set", "url", "x"],
            "set url needs a provider and a base URL",
        );
        usage_error(
            &home,
            &["set", "url", "x", "ftp://h"],
            "a base URL starts with http:// or https://",
        );
        usage_error(&home, &["unset"], "unset needs what to unset");
        usage_error(&home, &["unset", "key"], "unset key needs a provider");
        usage_error(
            &home,
            &["unset", "key", "a", "b"],
            "too many words for unset key",
        );
        usage_error(
            &home,
            &["unset", "aiip-bin", "x"],
            "too many words for unset aiip-bin",
        );
        usage_error(&home, &["unset", "model"], "cannot unset model");
        // nothing was written
        assert!(!home.exists());
    }

    #[test]
    fn no_home_fails() {
        let env = |_: &str| None;
        let result = run_env(&env, &["show"], &mut Vec::new());
        assert_eq!(result.code, 1);
        assert_eq!(result.out, "");
        assert_eq!(result.err, "config: neither ABAI_HOME nor HOME is set\n");
    }

    #[test]
    fn login_is_not_here() {
        let home = scratch("login");
        let result = run(&home, &["login", "anthropic"]);
        assert_eq!(result.code, 1);
        assert_eq!(
            result.err,
            "config: account logins are not supported by this harness; store an API key with: config set key <provider>\n"
        );
        assert!(!home.exists());
    }

    #[test]
    fn a_broken_config_file_fails() {
        let home = scratch("broken");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join(config::CONFIG_FILE), "[]").unwrap();
        let result = run(&home, &["set", "model", "m"]);
        assert_eq!(result.code, 1);
        assert!(result.err.starts_with("config: "), "{}", result.err);
        assert!(result.err.contains("not a JSON object"), "{}", result.err);
        let checks = doctor_online(&env_for(&home));
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].status, CheckStatus::Fail);
        assert!(checks[0].detail.contains("not a JSON object"));
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn doctor_with_nothing_configured_fails_the_model_check() {
        let home = scratch("doctor-empty");
        let checks = doctor_online(&env_for(&home));
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].name, "model");
        assert_eq!(checks[0].status, CheckStatus::Fail);
        assert!(checks[0].detail.starts_with("no model is configured"));
        let checks = doctor_online(&|_: &str| None);
        assert_eq!(checks, vec![check("model", CheckStatus::Fail, NO_HOME)]);
        let _ = std::fs::remove_dir_all(&home);
    }

    fn configure_local(home: &Path, url: &str) {
        done(home, &["set", "provider", "local"], "provider: local\n");
        done(home, &["set", "model", "m1"], "model: m1\n");
        done(
            home,
            &["set", "url", "local", url],
            &format!("local base URL: {url}\n"),
        );
    }

    #[test]
    fn doctor_asks_the_provider_for_its_models() {
        let home = scratch("doctor-ok");
        let fake = FakeProvider::start(vec![Answer::ok(json!({"data": []}))]);
        configure_local(&home, &fake.url);
        let checks = doctor_online(&env_for(&home));
        assert_eq!(checks.len(), 2, "{checks:?}");
        assert_eq!(
            checks[0],
            check("model", CheckStatus::Ok, "local m1 is configured")
        );
        assert_eq!(checks[1].name, "model.reachable");
        assert_eq!(checks[1].status, CheckStatus::Ok, "{}", checks[1].detail);
        let requests = fake.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/models");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn doctor_reports_a_refused_key() {
        let home = scratch("doctor-401");
        let fake = FakeProvider::start(vec![Answer::status(
            401,
            json!({"error": {"message": "bad key"}}),
        )]);
        configure_local(&home, &fake.url);
        let checks = doctor_online(&env_for(&home));
        assert_eq!(checks.len(), 2, "{checks:?}");
        assert_eq!(checks[0].status, CheckStatus::Ok);
        assert_eq!(
            checks[1],
            check(
                "model.reachable",
                CheckStatus::Fail,
                "the provider refused the key (401): bad key"
            )
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn doctor_reports_an_unreachable_provider() {
        let home = scratch("doctor-closed");
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        configure_local(&home, &format!("http://127.0.0.1:{port}"));
        let checks = doctor_online(&env_for(&home));
        assert_eq!(checks.len(), 2, "{checks:?}");
        assert_eq!(checks[1].name, "model.reachable");
        assert_eq!(checks[1].status, CheckStatus::Fail);
        assert!(
            checks[1]
                .detail
                .starts_with("the provider could not be reached"),
            "{}",
            checks[1].detail
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn aiip_bin_is_set_shown_and_unset() {
        let home = scratch("aiip-bin");
        done(
            &home,
            &["set", "aiip-bin", "/opt/aiip"],
            "aiip: /opt/aiip\n",
        );
        assert_eq!(
            config::load_config(&home).unwrap().as_value()["aiip"],
            json!({"bin": "/opt/aiip"})
        );
        let shown = run(&home, &[]);
        assert_eq!(shown.code, 0, "{}", shown.err);
        assert!(shown.out.contains("aiip: /opt/aiip\n"), "{}", shown.out);
        done(
            &home,
            &["unset", "aiip-bin"],
            "aiip is aiip on the PATH again\n",
        );
        assert_eq!(
            config::load_config(&home).unwrap().as_value().get("aiip"),
            None
        );
        let shown = run(&home, &["show"]);
        assert_eq!(shown.code, 0, "{}", shown.err);
        assert!(
            shown.out.contains("aiip: (aiip on the PATH)\n"),
            "{}",
            shown.out
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[cfg(unix)]
    mod net {
        use super::*;
        use crate::net::fake::{FakeAiipd, FakeOverlay, Scratch};
        use crate::net::{AiipClient, ChildExit, ChildLike, KillSignal, SpawnFn, SpawnRequest};
        use abai_stub::manifest::NetworkDecl;
        use std::collections::HashMap;
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};

        fn env_of(vars: &[(&str, String)]) -> impl Fn(&str) -> Option<String> + use<> {
            let vars: Vec<(String, String)> = vars
                .iter()
                .map(|(name, value)| (name.to_string(), value.clone()))
                .collect();
            move |name: &str| {
                vars.iter()
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.clone())
            }
        }

        fn text(path: &Path) -> String {
            path.display().to_string()
        }

        fn run_net(
            env: &dyn Fn(&str) -> Option<String>,
            words: &[&str],
            program: Option<&str>,
            spawn: Option<SpawnFn>,
            mut input: Vec<String>,
        ) -> Run {
            let args: Vec<String> = words.iter().map(|word| word.to_string()).collect();
            captured(env, &mut input, |io| {
                run_config_net(&args, io, program, spawn)
            })
        }

        /// The fakes a test started, stopped when it ends.
        #[derive(Default, Clone)]
        struct Fakes(Arc<Mutex<Vec<FakeAiipd>>>);

        impl Fakes {
            fn add(&self, fake: FakeAiipd) -> FakeAiipd {
                self.0.lock().unwrap().push(fake.clone());
                fake
            }

            fn list(&self) -> Vec<FakeAiipd> {
                self.0.lock().unwrap().clone()
            }
        }

        impl Drop for Fakes {
            fn drop(&mut self) {
                if Arc::strong_count(&self.0) == 1 {
                    for fake in self.list() {
                        fake.stop();
                    }
                }
            }
        }

        /// A child whose life is a fake daemon.
        struct FakeChild {
            fake: FakeAiipd,
            exit: Option<ChildExit>,
        }

        impl ChildLike for FakeChild {
            fn id(&self) -> u32 {
                std::process::id()
            }
            fn try_wait(&mut self) -> Option<ChildExit> {
                self.exit.clone()
            }
            fn kill(&mut self, _signal: KillSignal) {
                self.fake.stop();
                self.exit = Some(ChildExit::Signal("SIGTERM".to_string()));
            }
        }

        /// A spawn serving a fake of `overlay` on the directory it is asked for.
        fn fake_spawn(overlay: FakeOverlay, spawned: Fakes) -> SpawnFn {
            Arc::new(move |request: &SpawnRequest<'_>| {
                let at = request
                    .args
                    .iter()
                    .position(|arg| arg == "--state-dir")
                    .unwrap();
                let dir = PathBuf::from(&request.args[at + 1]);
                let fake = spawned.add(overlay.fake_at(&dir.join("aiipd.sock")));
                fake.start()?;
                Ok(Box::new(FakeChild { fake, exit: None }) as Box<dyn ChildLike>)
            })
        }

        #[test]
        fn net_needs_the_program_or_the_net_dir_and_shows_the_memberships_on_disk_when_no_daemon_runs()
         {
            let scratch = Scratch::new();
            let home = scratch.path();
            let result = run(home, &["net"]);
            assert_eq!(result.code, 2);
            assert_eq!(result.out, "");
            assert_eq!(
                result.err,
                format!(
                    "config: config net needs the program (run it as <prog> abai config net ...) or ABAI_NET_DIR\n{USAGE}"
                )
            );

            let net = home.join("net");
            std::fs::create_dir_all(net.join("memberships")).unwrap();
            std::fs::write(
                net.join("memberships").join("x.json"),
                json!({
                    "networkID": "x".repeat(32),
                    "networkName": "world",
                    "identity": {"name": "beta", "addr": "100.107.0.9"},
                    "authority": {"ca": "..."},
                    "peers": [{}, {}],
                })
                .to_string(),
            )
            .unwrap();
            let with_dir = env_of(&[("ABAI_HOME", text(home)), ("ABAI_NET_DIR", text(&net))]);
            let result = run_env(&with_dir, &["net"], &mut Vec::new());
            assert_eq!(result.code, 0, "{}", result.err);
            assert_eq!(
                result.out,
                format!(
                    "network dir: {}\naiip: (none found)\ndaemon: not running (it starts with the harness)\nmemberships:\n  beta on world (100.107.0.9), authority\n",
                    net.display()
                )
            );
            assert_eq!(result.err, "");

            let home_only = env_of(&[("ABAI_HOME", text(home))]);
            let result = run_net(&home_only, &["show"], Some("netty"), None, Vec::new());
            assert_eq!(result.code, 0, "{}", result.err);
            assert!(
                result.out.contains(&format!(
                    "network dir: {}\n",
                    home.join("net").join("netty").display()
                )),
                "{}",
                result.out
            );
            assert!(
                result.out.ends_with("memberships: (none)\n"),
                "{}",
                result.out
            );
        }

        #[test]
        fn create_invite_join_and_leave_run_against_the_directorys_daemon() {
            let overlay = FakeOverlay::new();
            let fakes = Fakes::default();
            let (home_a, home_b) = (Scratch::new(), Scratch::new());
            let dir_a = home_a.path().join("net").join("netty");
            let dir_b = home_b.path().join("net").join("netty");
            std::fs::create_dir_all(&dir_a).unwrap();
            std::fs::create_dir_all(&dir_b).unwrap();
            // daemons already running in both directories: found, used, and left running
            fakes.add(overlay.new_outsider(&dir_a.join("aiipd.sock")).unwrap());
            fakes.add(overlay.new_outsider(&dir_b.join("aiipd.sock")).unwrap());
            let env_a = env_of(&[
                ("ABAI_HOME", text(home_a.path())),
                ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
            ]);
            let env_b = env_of(&[
                ("ABAI_HOME", text(home_b.path())),
                ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
            ]);
            let no_spawn: SpawnFn = Arc::new(|_: &SpawnRequest<'_>| {
                Err(std::io::Error::other("spawn must not be reached"))
            });
            let net = |env: &dyn Fn(&str) -> Option<String>, words: &[&str], input: Vec<String>| {
                run_net(env, words, Some("netty"), Some(no_spawn.clone()), input)
            };

            let created = net(&env_a, &["create", "world", "--as", "alpha"], Vec::new());
            assert_eq!(created.code, 0, "{}", created.err);
            assert!(
                created.out.starts_with("created world as alpha (100.107.")
                    && created.out.ends_with("), the authority\n")
                    && created.out.lines().count() == 1,
                "{}",
                created.out
            );

            let invited = net(&env_a, &["invite", "world", "--for", "beta"], Vec::new());
            assert_eq!(invited.code, 0, "{}", invited.err);
            assert_eq!(invited.out.lines().count(), 1, "{}", invited.out);
            let token = invited.out.trim().to_string();
            assert!(token.starts_with("fake-invite-"), "{token}");
            assert!(
                invited.err.starts_with("invite for beta (100.107.")
                    && invited.err.ends_with(
                        ") on world: a bearer secret, hand it to that member's run as ABAI_NET_TOKEN\n"
                    ),
                "{}",
                invited.err
            );
            assert!(!invited.err.contains(&token));

            let joined = net(
                &env_b,
                &["join", "--token", "-"],
                vec![format!(" {token} ")],
            );
            assert_eq!(joined.code, 0, "{}", joined.err);
            assert!(
                joined.out.starts_with("joined world as beta ("),
                "{}",
                joined.out
            );
            assert_eq!(joined.err, "Invite token: ");
            assert!(!joined.out.contains(&token));
            let on_b = AiipClient::new(dir_b.join("aiipd.sock"));
            let names: Vec<String> = on_b
                .networks()
                .unwrap()
                .into_iter()
                .map(|m| m.self_name)
                .collect();
            assert_eq!(names, vec!["beta".to_string()]);

            let shown = net(&env_b, &[], Vec::new());
            assert_eq!(shown.code, 0, "{}", shown.err);
            assert!(
                shown.out.contains(&format!(
                    "daemon: running (aiip-m8, pid {}) at {}\n",
                    std::process::id(),
                    dir_b.join("aiipd.sock").display()
                )),
                "{}",
                shown.out
            );
            assert!(shown.out.contains("\n  beta on world ("), "{}", shown.out);

            let left = net(&env_b, &["leave", "world"], Vec::new());
            assert_eq!(left.code, 0, "{}", left.err);
            assert_eq!(left.out, "left world\n");
            assert_eq!(on_b.networks().unwrap(), Vec::new());

            let no_for = net(&env_a, &["invite", "world"], Vec::new());
            assert_eq!(no_for.code, 2);
            assert_eq!(
                no_for.err,
                format!("config: net invite takes: <net> --for <member>\n{USAGE}")
            );
            let bogus = net(&env_a, &["bogus"], Vec::new());
            assert_eq!(bogus.code, 2);
            assert_eq!(
                bogus.err,
                format!("config: unknown net subcommand bogus\n{USAGE}")
            );
            let nope = net(&env_b, &["leave", "nope"], Vec::new());
            assert_eq!(nope.code, 1);
            assert_eq!(nope.out, "");
            assert_eq!(nope.err, "config net: no membership matches \"nope\"\n");
            // the found daemons were left running
            assert!(fakes.list().iter().all(FakeAiipd::running));
        }

        #[test]
        fn a_daemon_started_for_one_command_is_ended_after_it_in_the_runs_own_directory_and_kept_in_the_shared_one()
         {
            let scratch = Scratch::new();
            let home = scratch.path();
            let spawned = Fakes::default();
            let own = env_of(&[
                ("ABAI_HOME", text(home)),
                ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
                ("ABAI_NET_DIR", text(&home.join("own"))),
            ]);
            let spawn = fake_spawn(FakeOverlay::new(), spawned.clone());
            let result = run_net(
                &own,
                &["create", "world", "--as", "alpha"],
                Some("netty"),
                Some(spawn),
                Vec::new(),
            );
            assert_eq!(result.code, 0, "{}", result.err);
            assert!(
                result.out.starts_with("created world as alpha"),
                "{}",
                result.out
            );
            assert_eq!(spawned.list().len(), 1);
            let deadline = Instant::now() + Duration::from_secs(1);
            while spawned.list()[0].running() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            assert!(!spawned.list()[0].running());

            let shared = env_of(&[
                ("ABAI_HOME", text(home)),
                ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
            ]);
            let spawn = fake_spawn(FakeOverlay::new(), spawned.clone());
            let result = run_net(
                &shared,
                &["create", "world", "--as", "alpha"],
                Some("netty"),
                Some(spawn),
                Vec::new(),
            );
            assert_eq!(result.code, 0, "{}", result.err);
            assert_eq!(spawned.list().len(), 2);
            std::thread::sleep(Duration::from_millis(30));
            // stays for the program's next run, as the aiip CLI leaves its daemons
            assert!(spawned.list()[1].running());
        }

        #[test]
        fn net_usage_problems_exit_2_before_any_daemon_and_the_token_is_never_shown() {
            let scratch = Scratch::new();
            let env = env_of(&[
                ("ABAI_HOME", text(scratch.path())),
                ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
            ]);
            let no_spawn: SpawnFn = Arc::new(|_: &SpawnRequest<'_>| {
                Err(std::io::Error::other("spawn must not be reached"))
            });
            let usage_of = |words: &[&str], input: Vec<String>, problem: &str| {
                let result = run_net(&env, words, Some("netty"), Some(no_spawn.clone()), input);
                assert_eq!(result.code, 2, "{words:?}");
                assert_eq!(result.out, "", "{words:?}");
                assert!(
                    result.err.ends_with(&format!("config: {problem}\n{USAGE}")),
                    "{words:?}: {}",
                    result.err
                );
            };
            usage_of(&["join"], Vec::new(), "net join takes: --token <blob|->");
            usage_of(
                &["join", "--token"],
                Vec::new(),
                "net join takes: --token <blob|->",
            );
            usage_of(
                &["join", "--token", "--x"],
                Vec::new(),
                "net join takes: --token <blob|->",
            );
            usage_of(&["join", "--token", "-"], Vec::new(), "no token given");
            usage_of(
                &["join", "--token", "-"],
                vec!["  ".to_string()],
                "no token given",
            );
            usage_of(&["leave"], Vec::new(), "net leave takes: <net>");
            let create = "net create takes: <name> --as <member> [--lighthouse]";
            usage_of(&["create"], Vec::new(), create);
            usage_of(&["create", "world"], Vec::new(), create);
            usage_of(&["create", "--as", "alpha"], Vec::new(), create);
            usage_of(
                &["create", "world", "--as", "--lighthouse"],
                Vec::new(),
                create,
            );
            usage_of(
                &["invite", "--for", "beta"],
                Vec::new(),
                "net invite takes: <net> --for <member>",
            );
            assert!(!scratch.path().join("net").exists());

            let refused = run_net(
                &env,
                &["join", "--token", "-"],
                Some("netty"),
                Some(no_spawn.clone()),
                vec!["secret-token".to_string()],
            );
            assert_eq!(refused.code, 1);
            assert!(
                refused
                    .err
                    .starts_with("Invite token: config net: the aiip binary could not be started"),
                "{}",
                refused.err
            );
            assert!(!refused.err.contains("secret-token"));

            let no_bin = env_of(&[("ABAI_HOME", text(scratch.path())), ("PATH", String::new())]);
            let result = run_net(
                &no_bin,
                &["leave", "world"],
                Some("netty"),
                None,
                Vec::new(),
            );
            assert_eq!(result.code, 1);
            assert_eq!(
                result.err,
                format!("config net: {}\n", crate::net::NO_BINARY)
            );
            let relative = env_of(&[("ABAI_NET_DIR", "rel/dir".to_string())]);
            let result = run_net(&relative, &[], None, None, Vec::new());
            assert_eq!(result.code, 1);
            assert_eq!(
                result.err,
                "config net: ABAI_NET_DIR must be an absolute path (got rel/dir)\n"
            );
        }

        #[test]
        fn doctors_network_checks_say_nothing_without_a_declaration_and_check_the_binary_the_daemon_and_the_memberships_otherwise()
         {
            let scratch = Scratch::new();
            let home = scratch.path();
            let by_name = |checks: Vec<DoctorCheck>| -> HashMap<String, (CheckStatus, String)> {
                checks
                    .into_iter()
                    .filter(|c| c.name.starts_with("aiip."))
                    .map(|c| (c.name, (c.status, c.detail)))
                    .collect()
            };
            let bare = env_of(&[("ABAI_HOME", text(home)), ("PATH", String::new())]);
            assert_eq!(doctor_network(&bare, Some("netty"), None), Vec::new());

            let net = home.join("net").join("netty");
            let declared = NetworkDecl {
                required: None,
                doc: "x".to_string(),
            };
            let no_bin = by_name(doctor_network(&bare, Some("netty"), Some(&declared)));
            assert_eq!(no_bin["aiip.binary"].0, CheckStatus::Skip);
            assert_eq!(
                no_bin["aiip.daemon"],
                (
                    CheckStatus::Skip,
                    format!(
                        "not running at {} (it starts with the harness)",
                        net.display()
                    )
                )
            );
            assert_eq!(no_bin["aiip.network"].0, CheckStatus::Skip);

            let required = NetworkDecl {
                required: Some(true),
                doc: "x".to_string(),
            };
            let missing = by_name(doctor_network(&bare, Some("netty"), Some(&required)));
            assert_eq!(missing["aiip.binary"].0, CheckStatus::Fail);
            assert_eq!(missing["aiip.network"].0, CheckStatus::Fail);

            std::fs::create_dir_all(&net).unwrap();
            let fakes = Fakes::default();
            fakes.add(
                FakeOverlay::new()
                    .new_member("beta", &net.join("aiipd.sock"))
                    .unwrap(),
            );
            let with_bin = env_of(&[
                ("ABAI_HOME", text(home)),
                ("PATH", String::new()),
                ("ABAI_AIIP_BIN", "/opt/aiip".to_string()),
            ]);
            let live = by_name(doctor_network(&with_bin, Some("netty"), Some(&required)));
            let expected: HashMap<String, (CheckStatus, String)> = [
                ("aiip.binary", (CheckStatus::Ok, "/opt/aiip".to_string())),
                (
                    "aiip.daemon",
                    (
                        CheckStatus::Ok,
                        format!("aiip-m8 at {}", net.join("aiipd.sock").display()),
                    ),
                ),
                (
                    "aiip.network",
                    (CheckStatus::Ok, "beta on fake".to_string()),
                ),
            ]
            .into_iter()
            .map(|(name, check)| (name.to_string(), check))
            .collect();
            assert_eq!(live, expected);
        }
    }
}
