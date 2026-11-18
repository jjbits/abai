//! `<prog> abai doctor`: checks that the abaigram is whole.

use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::ABAI_STUB_VERSION;
use crate::app::Abaigram;
use crate::env::{ENV_MODE, EnvFn, HarnessSelection};
use crate::manifest::{MANIFEST_FILE, Manifest, Mode, render_yaml, string_scalar, validate};

/// The outcome of one check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Ok,
    Fail,
    Skip,
}

impl CheckStatus {
    /// The status as the report writes it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Fail => "fail",
            Self::Skip => "skip",
        }
    }
}

/// One check and what it found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoctorCheck {
    pub name: String,
    pub status: CheckStatus,
    pub detail: String,
}

/// Every check, in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DoctorReport {
    /// No check failed.
    pub ok: bool,
    /// The checkout's root, when one was found.
    pub root: Option<String>,
    pub checks: Vec<DoctorCheck>,
}

/// What the doctor runs against.
pub struct DoctorOptions<'a> {
    /// The checkout's root as given by `--root`, relative to `cwd`.
    pub root: Option<&'a str>,
    pub cwd: &'a Path,
    pub env: EnvFn<'a>,
    /// Check the model as well.
    pub online: bool,
}

impl fmt::Debug for DoctorOptions<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DoctorOptions")
            .field("root", &self.root)
            .field("cwd", &self.cwd)
            .field("online", &self.online)
            .finish_non_exhaustive()
    }
}

fn check(name: &str, status: CheckStatus, detail: impl Into<String>) -> DoctorCheck {
    DoctorCheck {
        name: name.to_string(),
        status,
        detail: detail.into(),
    }
}

/// Run every check. Never panics: a problem is a failed check.
pub fn run_doctor(app: &Abaigram, options: &DoctorOptions) -> DoctorReport {
    let manifest = app.manifest();
    let entry = &manifest.entry;
    let mut checks = Vec::new();

    checks.push(check(
        "entry",
        CheckStatus::Ok,
        format!("{entry} reached (abai stub {ABAI_STUB_VERSION})"),
    ));

    let violations = validate(manifest);
    let rendered = if violations.is_empty() {
        checks.push(check(
            "manifest",
            CheckStatus::Ok,
            format!(
                "the effective manifest validates ({} cells, {} events, {} capabilities, {} decisions, {} turns)",
                manifest.cells.len(),
                manifest.events.len(),
                manifest.capabilities.len(),
                manifest.decisions.len(),
                manifest.turns.len(),
            ),
        ));
        Some(render_yaml(manifest))
    } else {
        checks.push(check(
            "manifest",
            CheckStatus::Fail,
            format!(
                "the effective manifest does not validate: {}",
                violations.join("; ")
            ),
        ));
        None
    };

    let root = match options.root {
        Some(dir) => Some(options.cwd.join(dir)),
        None => find_root(&manifest.name, options.cwd),
    };
    let root = match root {
        Some(given) if !given.is_dir() => {
            checks.push(check(
                "root",
                CheckStatus::Fail,
                format!("{} is not a directory", given.display()),
            ));
            checks.push(check(MANIFEST_FILE, CheckStatus::Skip, "no checkout"));
            checks.push(check("identity", CheckStatus::Skip, "no checkout"));
            None
        }
        Some(root) => {
            checks.push(check("root", CheckStatus::Ok, root.display().to_string()));
            checks.push(check_manifest_file(&root, rendered.as_deref(), entry));
            checks.push(check_identity(&root, manifest));
            Some(root)
        }
        None => {
            let other = options
                .cwd
                .ancestors()
                .map(|dir| dir.join(MANIFEST_FILE))
                .find(|file| file.is_file());
            let detail = match other {
                Some(other) => format!(
                    "{} names another program (pass --root <dir> to check it against this one)",
                    other.display()
                ),
                None => "no checkout found (pass --root <dir> to check a checked-in abaigram.yaml)"
                    .to_string(),
            };
            checks.push(check("root", CheckStatus::Skip, detail));
            checks.push(check(MANIFEST_FILE, CheckStatus::Skip, "no checkout"));
            checks.push(check("identity", CheckStatus::Skip, "no checkout"));
            None
        }
    };

    checks.push(match app.harness_selection() {
        HarnessSelection::Real => check("harness", CheckStatus::Ok, "ABAI_HARNESS: real"),
        HarnessSelection::Off => check("harness", CheckStatus::Ok, "ABAI_HARNESS: off"),
        HarnessSelection::Unsupported(value) => check(
            "harness",
            CheckStatus::Fail,
            format!("ABAI_HARNESS={value} is not supported (unset or off)"),
        ),
    });

    checks.push(check_modes(&manifest.modes, options.env));
    checks.push(check_audit(manifest, options));

    if !options.online {
        checks.push(check("online", CheckStatus::Skip, "not asked (--offline)"));
    } else if let Some(online) = app.binary_doctor() {
        checks.extend(online);
    } else if let Some(online) = app.embedded_doctor() {
        checks.extend(online);
    } else {
        checks.push(check(
            "online",
            CheckStatus::Skip,
            "no harness is linked to check the model",
        ));
    }

    DoctorReport {
        ok: checks.iter().all(|c| c.status != CheckStatus::Fail),
        root: root.map(|r| r.display().to_string()),
        checks,
    }
}

fn check_manifest_file(root: &Path, rendered: Option<&str>, entry: &str) -> DoctorCheck {
    let path = root.join(MANIFEST_FILE);
    let shown = path.display();
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return check(
                MANIFEST_FILE,
                CheckStatus::Fail,
                format!("{shown} is missing; run: {entry} manifest > abaigram.yaml"),
            );
        }
        Err(error) => {
            return check(
                MANIFEST_FILE,
                CheckStatus::Fail,
                format!("{shown} could not be read: {error}"),
            );
        }
    };
    let Some(rendered) = rendered else {
        return check(
            MANIFEST_FILE,
            CheckStatus::Fail,
            format!("{shown} cannot be compared: the effective manifest does not validate"),
        );
    };
    match first_differing_line(&text, rendered) {
        Some(line) => check(
            MANIFEST_FILE,
            CheckStatus::Fail,
            format!(
                "{shown} is stale: first difference at line {line}; run: {entry} manifest > abaigram.yaml"
            ),
        ),
        None => check(
            MANIFEST_FILE,
            CheckStatus::Ok,
            format!("{shown} agrees with the code"),
        ),
    }
}

fn check_identity(root: &Path, manifest: &Manifest) -> DoctorCheck {
    let path = root.join(&manifest.content.identity);
    let shown = path.display();
    match fs::read_to_string(&path) {
        Ok(text) if text.trim().is_empty() => {
            check("identity", CheckStatus::Fail, format!("{shown} is empty"))
        }
        Ok(_) => check("identity", CheckStatus::Ok, shown.to_string()),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            check("identity", CheckStatus::Fail, format!("{shown} is missing"))
        }
        Err(error) => check(
            "identity",
            CheckStatus::Fail,
            format!("{shown} could not be read: {error}"),
        ),
    }
}

fn check_modes(modes: &[Mode], env: EnvFn) -> DoctorCheck {
    let declared = modes
        .iter()
        .map(|m| m.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let selected = env(ENV_MODE).map(|v| v.trim().to_string());
    match selected.as_deref() {
        None | Some("") => {
            let first = modes.first().map(|m| m.as_str()).unwrap_or("");
            check(
                "modes",
                CheckStatus::Ok,
                format!("declared: {declared}; default {first}"),
            )
        }
        Some(value) if Mode::parse(value).is_some_and(|m| modes.contains(&m)) => check(
            "modes",
            CheckStatus::Ok,
            format!("{ENV_MODE}={value} is declared (declared: {declared})"),
        ),
        Some(value) => check(
            "modes",
            CheckStatus::Fail,
            format!(
                "{ENV_MODE}={value} is not declared (declared: {declared}); a plain run falls back and counts it"
            ),
        ),
    }
}

fn check_audit(manifest: &Manifest, options: &DoctorOptions) -> DoctorCheck {
    let configured = &manifest.audit.path;
    if configured.starts_with("~/") && (options.env)("HOME").is_none_or(|home| home.is_empty()) {
        return check(
            "audit",
            CheckStatus::Fail,
            format!("HOME is not set, so {configured} cannot be resolved"),
        );
    }
    let expanded = match (configured.strip_prefix("~/"), (options.env)("HOME")) {
        (Some(rest), Some(home)) => Path::new(&home).join(rest),
        _ => PathBuf::from(configured),
    };
    let path = options.cwd.join(expanded);
    let dir = path.parent().unwrap_or(&path);
    let Some(ancestor) = dir.ancestors().find(|p| p.exists()) else {
        return check(
            "audit",
            CheckStatus::Fail,
            format!("{} has no existing ancestor", dir.display()),
        );
    };
    if !ancestor.is_dir() {
        return check(
            "audit",
            CheckStatus::Fail,
            format!("{} is not a directory", ancestor.display()),
        );
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let probe = ancestor.join(format!(".abai-doctor-{}-{nanos}", std::process::id()));
    let written = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .and_then(|file| {
            drop(file);
            fs::remove_file(&probe)
        });
    match written {
        Ok(()) => check(
            "audit",
            CheckStatus::Ok,
            format!("{configured} ({} is writable)", ancestor.display()),
        ),
        Err(error) => check(
            "audit",
            CheckStatus::Fail,
            format!("the audit directory is not writable: {error}"),
        ),
    }
}

/// The first line at which two texts differ (1-based), or None when equal.
pub fn first_differing_line(a: &str, b: &str) -> Option<usize> {
    if a == b {
        return None;
    }
    let lines_a: Vec<&str> = a.split('\n').collect();
    let lines_b: Vec<&str> = b.split('\n').collect();
    let n = lines_a.len().max(lines_b.len());
    for i in 0..n {
        if lines_a.get(i) != lines_b.get(i) {
            return Some(i + 1);
        }
    }
    Some(n)
}

/// The checkout of the abaigram called `name`: the nearest of `from` and its
/// ancestors that holds an `abaigram.yaml` naming it.
pub fn find_root(name: &str, from: &Path) -> Option<PathBuf> {
    let wanted = format!("name: {}", string_scalar(name));
    from.ancestors()
        .find(|dir| {
            fs::read_to_string(dir.join(MANIFEST_FILE))
                .is_ok_and(|text| text.lines().any(|line| line == wanted))
        })
        .map(Path::to_path_buf)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::declare::Declarations;
    use std::collections::HashMap;

    /// A fresh directory under the system temp directory.
    pub(crate) fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("abai-stub-{label}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub(crate) fn demo() -> Declarations {
        Declarations::new("demo", [Mode::Turns, Mode::Sidecar])
    }

    pub(crate) fn app_with(pairs: &[(&str, &str)]) -> Abaigram {
        let vars = vars(pairs);
        Abaigram::with_env(&demo(), &|name: &str| vars.get(name).cloned()).unwrap()
    }

    pub(crate) fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// A checkout of `demo` whose abaigram.yaml is the render.
    pub(crate) fn good_checkout(label: &str) -> PathBuf {
        let dir = temp_dir(label);
        let app = app_with(&[]);
        fs::write(dir.join(MANIFEST_FILE), render_yaml(app.manifest())).unwrap();
        fs::create_dir_all(dir.join("abai")).unwrap();
        fs::write(dir.join("abai/identity.md"), "The demo.\n").unwrap();
        dir
    }

    fn run(app: &Abaigram, root: Option<&str>, cwd: &Path, pairs: &[(&str, &str)]) -> DoctorReport {
        let vars = vars(pairs);
        let env = |name: &str| vars.get(name).cloned();
        run_doctor(
            app,
            &DoctorOptions {
                root,
                cwd,
                env: &env,
                online: false,
            },
        )
    }

    fn status_of(report: &DoctorReport, name: &str) -> (CheckStatus, String) {
        let c = report.checks.iter().find(|c| c.name == name).unwrap();
        (c.status, c.detail.clone())
    }

    #[test]
    fn a_good_checkout_is_ok() {
        let dir = good_checkout("good");
        let home = dir.to_string_lossy().to_string();
        let report = run(&app_with(&[]), None, &dir, &[("HOME", &home)]);
        let names: Vec<&str> = report.checks.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "entry",
                "manifest",
                "root",
                "abaigram.yaml",
                "identity",
                "harness",
                "modes",
                "audit",
                "online"
            ]
        );
        for c in &report.checks {
            let expected = if c.name == "online" {
                CheckStatus::Skip
            } else {
                CheckStatus::Ok
            };
            assert_eq!(c.status, expected, "{}: {}", c.name, c.detail);
        }
        assert!(report.ok);
        assert_eq!(report.root, Some(dir.display().to_string()));
        assert_eq!(
            status_of(&report, "online").1,
            "not asked (--offline)".to_string()
        );
        assert_eq!(
            status_of(&report, "modes").1,
            "declared: turns, sidecar; default turns"
        );
        assert!(
            status_of(&report, "audit")
                .1
                .starts_with("~/.abai/audit/demo.jsonl (")
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_stale_file_names_the_first_differing_line() {
        let dir = good_checkout("stale");
        let path = dir.join(MANIFEST_FILE);
        let text = fs::read_to_string(&path).unwrap();
        let mut lines: Vec<&str> = text.split('\n').collect();
        lines[5] = "abaigrammar: '9.9'";
        fs::write(&path, lines.join("\n")).unwrap();
        let report = run(&app_with(&[]), None, &dir, &[]);
        let (status, detail) = status_of(&report, "abaigram.yaml");
        assert_eq!(status, CheckStatus::Fail);
        assert!(
            detail.ends_with(
                "is stale: first difference at line 6; run: demo abai manifest > abaigram.yaml"
            ),
            "{detail}"
        );
        assert!(!report.ok);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_missing_file_fails() {
        let dir = good_checkout("missing");
        fs::remove_file(dir.join(MANIFEST_FILE)).unwrap();
        let root = dir.to_string_lossy().to_string();
        let report = run(&app_with(&[]), Some(&root), &dir, &[]);
        let (status, detail) = status_of(&report, "abaigram.yaml");
        assert_eq!(status, CheckStatus::Fail);
        assert_eq!(
            detail,
            format!(
                "{} is missing; run: demo abai manifest > abaigram.yaml",
                dir.join(MANIFEST_FILE).display()
            )
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_empty_identity_fails() {
        let dir = good_checkout("empty-identity");
        fs::write(dir.join("abai/identity.md"), "  \n").unwrap();
        let report = run(&app_with(&[]), None, &dir, &[]);
        let (status, detail) = status_of(&report, "identity");
        assert_eq!(status, CheckStatus::Fail);
        assert_eq!(
            detail,
            format!("{} is empty", dir.join("abai/identity.md").display())
        );
        assert!(!report.ok);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn no_checkout_skips() {
        let dir = temp_dir("no-checkout");
        let report = run(&app_with(&[]), None, &dir, &[]);
        assert_eq!(report.root, None);
        assert_eq!(
            status_of(&report, "root"),
            (
                CheckStatus::Skip,
                "no checkout found (pass --root <dir> to check a checked-in abaigram.yaml)"
                    .to_string()
            )
        );
        assert_eq!(
            status_of(&report, "abaigram.yaml"),
            (CheckStatus::Skip, "no checkout".to_string())
        );
        assert_eq!(
            status_of(&report, "identity"),
            (CheckStatus::Skip, "no checkout".to_string())
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_given_root_is_resolved_against_the_cwd() {
        let dir = temp_dir("given-root");
        let checkout = good_checkout("given-root-checkout");
        fs::rename(&checkout, dir.join("repo")).unwrap();
        let report = run(&app_with(&[]), Some("repo"), &dir, &[]);
        assert_eq!(report.root, Some(dir.join("repo").display().to_string()));
        assert_eq!(status_of(&report, "abaigram.yaml").0, CheckStatus::Ok);
        assert_eq!(status_of(&report, "identity").0, CheckStatus::Ok);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_undeclared_mode_fails() {
        let dir = temp_dir("undeclared-mode");
        let pairs = [("ABAI_MODE", "thread")];
        let report = run(&app_with(&pairs), None, &dir, &pairs);
        assert_eq!(
            status_of(&report, "modes"),
            (
                CheckStatus::Fail,
                "ABAI_MODE=thread is not declared (declared: turns, sidecar); a plain run falls back and counts it".to_string()
            )
        );
        assert!(!report.ok);

        let pairs = [("ABAI_MODE", "sidecar")];
        let report = run(&app_with(&pairs), None, &dir, &pairs);
        assert_eq!(status_of(&report, "modes").0, CheckStatus::Ok);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_unsupported_harness_fails() {
        let dir = temp_dir("null-harness");
        let pairs = [("ABAI_HARNESS", "null")];
        let report = run(&app_with(&pairs), None, &dir, &pairs);
        assert_eq!(
            status_of(&report, "harness"),
            (
                CheckStatus::Fail,
                "ABAI_HARNESS=null is not supported (unset or off)".to_string()
            )
        );
        assert!(!report.ok);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_audit_path_under_home_needs_home() {
        let dir = temp_dir("no-home");
        for pairs in [&[][..], &[("HOME", "")][..]] {
            let report = run(&app_with(&[]), None, &dir, pairs);
            assert_eq!(
                status_of(&report, "audit"),
                (
                    CheckStatus::Fail,
                    "HOME is not set, so ~/.abai/audit/demo.jsonl cannot be resolved".to_string()
                )
            );
            assert!(!report.ok);
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_given_root_that_is_not_a_directory_fails() {
        let dir = temp_dir("root-not-dir");
        fs::write(dir.join("file"), "x").unwrap();
        let home = dir.to_string_lossy().to_string();
        for given in ["file", "absent"] {
            let report = run(&app_with(&[]), Some(given), &dir, &[("HOME", &home)]);
            assert_eq!(
                status_of(&report, "root"),
                (
                    CheckStatus::Fail,
                    format!("{} is not a directory", dir.join(given).display())
                )
            );
            assert_eq!(
                status_of(&report, "abaigram.yaml"),
                (CheckStatus::Skip, "no checkout".to_string())
            );
            assert_eq!(
                status_of(&report, "identity"),
                (CheckStatus::Skip, "no checkout".to_string())
            );
            assert_eq!(report.root, None);
            assert!(!report.ok);
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_checkout_of_another_program_is_named() {
        let dir = temp_dir("other-program");
        fs::write(dir.join(MANIFEST_FILE), "name: other\n").unwrap();
        let nested = dir.join("src");
        fs::create_dir_all(&nested).unwrap();
        let report = run(&app_with(&[]), None, &nested, &[]);
        assert_eq!(report.root, None);
        assert_eq!(
            status_of(&report, "root"),
            (
                CheckStatus::Skip,
                format!(
                    "{} names another program (pass --root <dir> to check it against this one)",
                    dir.join(MANIFEST_FILE).display()
                )
            )
        );
        assert_eq!(
            status_of(&report, "abaigram.yaml"),
            (CheckStatus::Skip, "no checkout".to_string())
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn find_root_finds_an_ancestor_and_checks_the_name() {
        let dir = good_checkout("find-root");
        let nested = dir.join("a/b");
        fs::create_dir_all(&nested).unwrap();
        fs::write(dir.join("a/abaigram.yaml"), "name: other\n").unwrap();
        assert_eq!(find_root("demo", &nested), Some(dir.clone()));
        assert_eq!(find_root("other", &nested), Some(dir.join("a")));
        assert_eq!(find_root("nobody", &nested), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn first_differing_line_cases() {
        assert_eq!(first_differing_line("a\nb\n", "a\nb\n"), None);
        assert_eq!(first_differing_line("a\nb\nc", "a\nx\nc"), Some(2));
        assert_eq!(first_differing_line("a\nb", "a\nb\nc"), Some(3));
        assert_eq!(first_differing_line("a\nb\n", "a\nb"), Some(3));
    }
}
