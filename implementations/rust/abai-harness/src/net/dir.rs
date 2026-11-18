//! Where a run's network identity lives and which aiip binary runs it.
//! The identity is the aiip state directory: certificates, memberships and
//! the daemon's socket. Default: one per program per machine under abai's
//! home, so two runs of one program on one machine are one member; a
//! realization that wants one identity per run points `ABAI_NET_DIR` at
//! the run (the arena points each ship at its run directory).

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use crate::config::{self, Config};

/// The aiip state directory for this run; default `<ABAI_HOME>/net/<program>/`.
pub const ENV_NET_DIR: &str = "ABAI_NET_DIR";
/// An invite token: the run joins with it at attach when its state dir has no membership of that network yet.
pub const ENV_NET_TOKEN: &str = "ABAI_NET_TOKEN";
/// The aiip binary; default the configuration's `aiip.bin`, else `aiip` on the PATH.
pub const ENV_AIIP_BIN: &str = "ABAI_AIIP_BIN";
pub const AIIP_BINARY_NAME: &str = "aiip";

/// An environment without the invite token. The token holds the member's
/// private key and only the harness reads it, at attach: a child of the
/// harness, the aiip daemon or a launched program, has no use for it, so none
/// carries it. Everything else passes through; this strips the one key abai owns.
pub fn without_invite_token(env: &[(String, String)]) -> Vec<(String, String)> {
    env.iter()
        .filter(|(name, _)| name != ENV_NET_TOKEN)
        .cloned()
        .collect()
}

/// A program name that can be one directory segment: letters, digits, dot, underscore, hyphen; not `.` or `..`.
fn safe_segment(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

/// The state directory for a run: `ABAI_NET_DIR`, else the program's place
/// under abai's home, else none. An error for a relative `ABAI_NET_DIR` (a
/// run and a `config net` command in another directory would reach
/// different places), for a program name that cannot be a directory
/// segment, and when there is no home to put the program's place under.
/// Two programs of one name on one machine share the default place, so they
/// are one identity unless a run is given a directory of its own.
pub fn network_dir_for(
    env: &dyn Fn(&str) -> Option<String>,
    program: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    if let Some(explicit) = env(ENV_NET_DIR) {
        let explicit = explicit.trim();
        if !explicit.is_empty() {
            if !Path::new(explicit).is_absolute() {
                return Err(format!(
                    "{ENV_NET_DIR} must be an absolute path (got {explicit})"
                ));
            }
            return Ok(Some(PathBuf::from(explicit)));
        }
    }
    let Some(program) = program.filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    if !safe_segment(program) {
        let quoted = serde_json::to_string(program).unwrap_or_else(|_| program.to_string());
        return Err(format!(
            "the program's name {quoted} cannot name a directory; set {ENV_NET_DIR}"
        ));
    }
    match config::home(env) {
        Some(home) => Ok(Some(home.join("net").join(program))),
        None => Err(format!(
            "there is no home directory to keep the network state in; set {ENV_NET_DIR}"
        )),
    }
}

/// The aiip binary: `ABAI_AIIP_BIN`, else the configuration's `aiip.bin`, else `aiip` on the PATH; `None` when none is found.
pub fn aiip_binary_for(env: &dyn Fn(&str) -> Option<String>, config: &Config) -> Option<PathBuf> {
    if let Some(explicit) = env(ENV_AIIP_BIN) {
        let explicit = explicit.trim();
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }
    if let Some(configured) = config.aiip_bin() {
        let configured = configured.trim();
        if !configured.is_empty() {
            return Some(PathBuf::from(configured));
        }
    }
    find_on_path(AIIP_BINARY_NAME, env)
}

/// The first executable file of that name on `PATH`.
pub fn find_on_path(name: &str, env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let path = env("PATH").unwrap_or_default();
    for dir in path.split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = Path::new(dir).join(name);
        if candidate.is_file() && executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Whether this process may execute the file (`access(2)` with `X_OK`).
fn executable(path: &Path) -> bool {
    let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `c_path` is a valid NUL-terminated string that outlives the call.
    unsafe { libc::access(c_path.as_ptr(), libc::X_OK) == 0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::fake::Scratch;
    use std::collections::HashMap;
    use std::os::unix::fs::PermissionsExt;

    fn env_of(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name: &str| map.get(name).cloned()
    }

    #[test]
    fn the_state_dir_is_abai_net_dir_else_the_programs_place_under_abais_home_else_none() {
        assert_eq!(
            network_dir_for(&env_of(&[(ENV_NET_DIR, "/tmp/x")]), Some("counter")),
            Ok(Some(PathBuf::from("/tmp/x")))
        );
        assert_eq!(
            network_dir_for(&env_of(&[("ABAI_HOME", "/home/u/.abai")]), Some("counter")),
            Ok(Some(PathBuf::from("/home/u/.abai/net/counter")))
        );
        assert_eq!(
            network_dir_for(&env_of(&[("HOME", "/home/u")]), Some("counter")),
            Ok(Some(PathBuf::from("/home/u/.abai/net/counter")))
        );
        assert_eq!(
            network_dir_for(&env_of(&[("HOME", "/home/u")]), None),
            Ok(None)
        );
        assert_eq!(
            network_dir_for(
                &env_of(&[("HOME", "/home/u"), (ENV_NET_DIR, "  ")]),
                Some("")
            ),
            Ok(None)
        );
    }

    #[test]
    fn a_relative_dir_and_an_unsafe_program_name_are_refused() {
        assert_eq!(
            network_dir_for(&env_of(&[(ENV_NET_DIR, "net")]), Some("counter")),
            Err("ABAI_NET_DIR must be an absolute path (got net)".to_string())
        );
        let error = network_dir_for(&env_of(&[("HOME", "/u")]), Some("a/b")).unwrap_err();
        assert_eq!(
            error,
            "the program's name \"a/b\" cannot name a directory; set ABAI_NET_DIR"
        );
        assert!(network_dir_for(&env_of(&[("HOME", "/u")]), Some("..")).is_err());
        assert!(network_dir_for(&env_of(&[]), Some("counter")).is_err());
    }

    #[test]
    fn the_binary_is_abai_aiip_bin_else_the_configurations_else_aiip_on_the_path_else_none() {
        let bin = Scratch::new();
        let other = Scratch::new();
        let aiip = bin.path().join("aiip");
        std::fs::write(&aiip, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&aiip, std::fs::Permissions::from_mode(0o755)).unwrap();
        let bin_dir = bin.path().display().to_string();
        let other_dir = other.path().display().to_string();
        let config = Config::default();
        assert_eq!(
            aiip_binary_for(
                &env_of(&[(ENV_AIIP_BIN, "/opt/aiip"), ("PATH", &bin_dir)]),
                &config
            ),
            Some(PathBuf::from("/opt/aiip"))
        );
        let mut configured = Config::default();
        configured.set_aiip_bin(Some("/usr/local/bin/aiip"));
        assert_eq!(
            aiip_binary_for(&env_of(&[("PATH", &bin_dir)]), &configured),
            Some(PathBuf::from("/usr/local/bin/aiip"))
        );
        let both = format!("{other_dir}:{bin_dir}");
        assert_eq!(
            aiip_binary_for(&env_of(&[("PATH", &both)]), &config),
            Some(aiip.clone())
        );
        assert_eq!(
            aiip_binary_for(&env_of(&[("PATH", &other_dir)]), &config),
            None
        );
        assert_eq!(find_on_path("aiip", &env_of(&[])), None);
        // a file that is not executable is not the binary
        std::fs::set_permissions(&aiip, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(find_on_path("aiip", &env_of(&[("PATH", &bin_dir)])), None);
    }

    #[test]
    fn the_invite_token_is_stripped_and_nothing_else() {
        let env = vec![
            ("PATH".to_string(), "/p".to_string()),
            (ENV_NET_TOKEN.to_string(), "aiip-invite.secret".to_string()),
            ("HOME".to_string(), "/h".to_string()),
        ];
        assert_eq!(
            without_invite_token(&env),
            vec![
                ("PATH".to_string(), "/p".to_string()),
                ("HOME".to_string(), "/h".to_string()),
            ]
        );
        let plain = vec![("PATH".to_string(), "/p".to_string())];
        assert_eq!(without_invite_token(&plain), plain);
    }
}
