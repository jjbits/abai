//! A repository as `check` sees it: its root, the nearest ancestor of
//! the given path holding `abaigram.yaml`, and what that file says of
//! how to reach the program.
//!
//! This tool has no YAML reader. The file is written by the stub's
//! renderer, one top-level key a line, so the two lines needed here are
//! read as text; the whole manifest comes from the program itself, as
//! `<entry> manifest --json`.

use std::path::{Path, PathBuf};

use crate::Failure;

pub const MANIFEST_FILE: &str = "abaigram.yaml";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subject {
    pub root: PathBuf,
    pub manifest_path: PathBuf,
    /// The file's text, to compare with what the entry prints.
    pub manifest_text: String,
    pub name: String,
    /// The command line of the standard entry, for the shell in the root.
    pub entry: String,
}

/// The nearest ancestor of `start` (itself included) holding an `abaigram.yaml`.
pub fn find_subject_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|dir| dir.join(MANIFEST_FILE).is_file())
        .map(Path::to_path_buf)
}

/// The value of a top-level `key: value` line as the stub's renderer
/// writes a string: plain, or in double quotes with JSON's escapes.
pub fn top_level_string(text: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}: ");
    let value = text.lines().find_map(|line| line.strip_prefix(&prefix))?;
    if value.starts_with('"') {
        serde_json::from_str::<String>(value).ok()
    } else {
        Some(value.to_string())
    }
}

/// The subject at `path` (relative to `cwd`). A usage failure when there
/// is none, or its file does not say how to reach the program.
pub fn load_subject(path: &str, cwd: &Path) -> Result<Subject, Failure> {
    let given = cwd.join(path);
    if !given.exists() {
        return Err(Failure::usage(format!("{path}: no such file or directory")));
    }
    // symbolic links and `..` resolved, so the ancestors are the real ones
    let given = given.canonicalize().unwrap_or(given);
    let Some(root) = find_subject_root(&given) else {
        return Err(Failure::usage(format!(
            "{path}: no {MANIFEST_FILE} here or above it (is the repository an abaigram yet?)"
        )));
    };
    let manifest_path = root.join(MANIFEST_FILE);
    let manifest_text = std::fs::read_to_string(&manifest_path).map_err(|error| {
        Failure::usage(format!(
            "{} cannot be read: {error}",
            manifest_path.display()
        ))
    })?;
    let need = |key: &str| {
        top_level_string(&manifest_text, key)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                Failure::usage(format!(
                    "{} has no {key}: it is not a manifest the stub rendered",
                    manifest_path.display()
                ))
            })
    };
    Ok(Subject {
        name: need("name")?,
        entry: need("entry")?,
        root,
        manifest_path,
        manifest_text,
    })
}

/// One argument for `sh -c`, quoted so the shell passes it through whole.
pub fn shell_quote(arg: &str) -> String {
    let plain = !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_./:=@%+,-".contains(c));
    if plain {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

/// An entry's command line with words appended, for the shell in the root.
pub fn entry_command(entry: &str, words: &[&str]) -> String {
    let mut command = entry.to_string();
    for word in words {
        command.push(' ');
        command.push_str(&shell_quote(word));
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("abaikit-subject-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn usage(result: Result<Subject, Failure>) -> String {
        match result {
            Err(Failure::Usage(message)) => message,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_subject_is_found_from_below_its_root() {
        let dir = temp_dir("found");
        std::fs::create_dir_all(dir.join("src/deep")).unwrap();
        let text = "# a comment\n\nabaigrammar: \"0.1\"\nname: demo\nentry: \"./demo abai\"\nmodes:\n  - turns\ncells:\n  - name: inner\n    entry: no\n";
        std::fs::write(dir.join(MANIFEST_FILE), text).unwrap();
        let subject = load_subject("src/deep", &dir).unwrap();
        assert_eq!(subject.root, dir);
        assert_eq!(subject.name, "demo");
        assert_eq!(subject.entry, "./demo abai");
        assert_eq!(subject.manifest_text, text);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_path_that_is_no_abaigram_is_a_usage_failure() {
        let dir = temp_dir("none");
        assert_eq!(
            usage(load_subject("nope", &dir)),
            "nope: no such file or directory"
        );
        assert!(usage(load_subject(".", &dir)).contains("no abaigram.yaml here or above it"));
        std::fs::write(dir.join(MANIFEST_FILE), "name: demo\n").unwrap();
        assert!(usage(load_subject(".", &dir)).contains("has no entry"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn strings_are_read_as_the_renderer_writes_them() {
        assert_eq!(
            top_level_string("name: a b\n", "name").as_deref(),
            Some("a b")
        );
        assert_eq!(
            top_level_string("entry: \"say \\\"hi\\\" \\u00e9\"\n", "entry").as_deref(),
            Some("say \"hi\" é")
        );
        assert_eq!(top_level_string("  name: nested\n", "name"), None);
        assert_eq!(top_level_string("named: x\n", "name"), None);
    }

    #[test]
    fn words_are_quoted_for_the_shell() {
        assert_eq!(shell_quote("--json"), "--json");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(
            entry_command("./p abai", &["doctor", "--root", "/a b"]),
            "./p abai doctor --root '/a b'"
        );
    }
}
