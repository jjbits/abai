//! Content: the abaigrammer's prompts (contract section 8).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::manifest::Manifest;

/// The content slots of one program, read from its files.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Content {
    pub identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install: Option<String>,
    #[serde(default, rename = "use", skip_serializing_if = "Option::is_none")]
    pub use_: Option<String>,
    /// One text per named turn or decision that has a file.
    #[serde(default)]
    pub turns: Vec<(String, String)>,
}

impl Content {
    /// The text of a turn's or a decision's slot.
    pub fn turn(&self, name: &str) -> Option<&str> {
        self.turns
            .iter()
            .find(|(turn, _)| turn == name)
            .map(|(_, text)| text.as_str())
    }
}

fn optional(path: PathBuf) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    (!text.trim().is_empty()).then_some(text)
}

/// Read a program's content from its root. The identity is required;
/// every other slot is used when its file is there. The defaults are
/// `abai/install.md`, `abai/use.md` and `abai/turns/<name>.md`.
pub fn load(root: &Path, manifest: &Manifest) -> Result<Content, String> {
    let identity_path = root.join(&manifest.content.identity);
    let identity = std::fs::read_to_string(&identity_path)
        .map_err(|error| format!("{} could not be read: {error}", identity_path.display()))?;
    if identity.trim().is_empty() {
        return Err(format!("{} is empty", identity_path.display()));
    }
    let slot = |declared: &Option<String>, default: &str| {
        optional(root.join(declared.as_deref().unwrap_or(default)))
    };
    let turns_dir = root.join(manifest.content.turns.as_deref().unwrap_or("abai/turns"));
    let names = manifest
        .turns
        .iter()
        .map(|t| &t.name)
        .chain(manifest.decisions.iter().map(|d| &d.name));
    let turns = names
        .filter_map(|name| {
            optional(turns_dir.join(format!("{name}.md"))).map(|text| (name.clone(), text))
        })
        .collect();
    Ok(Content {
        identity,
        install: slot(&manifest.content.install, "abai/install.md"),
        use_: slot(&manifest.content.use_, "abai/use.md"),
        turns,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::declare::{Decision, Declarations, Turn};
    use crate::manifest::Mode;

    fn manifest() -> Manifest {
        Declarations::new("p", [Mode::Turns])
            .decision(Decision::options(
                "pick",
                ["a", "b"],
                "a",
                "5s",
                "Pick one.",
            ))
            .turn(Turn::new("lap", "5s", "After a lap."))
            .turn(Turn::new("quiet", "5s", "A turn with no file."))
            .manifest()
            .unwrap()
    }

    fn dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "abai-content-{label}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("abai/turns")).unwrap();
        dir
    }

    #[test]
    fn the_slots_that_have_files_are_read() {
        let root = dir("slots");
        std::fs::write(root.join("abai/identity.md"), "You are p.\n").unwrap();
        std::fs::write(root.join("abai/use.md"), "Use it well.\n").unwrap();
        std::fs::write(root.join("abai/install.md"), "  \n").unwrap();
        std::fs::write(root.join("abai/turns/lap.md"), "A lap ended.\n").unwrap();
        std::fs::write(root.join("abai/turns/pick.md"), "Pick with care.\n").unwrap();
        let content = load(&root, &manifest()).unwrap();
        assert_eq!(content.identity, "You are p.\n");
        assert_eq!(content.use_.as_deref(), Some("Use it well.\n"));
        assert_eq!(content.install, None);
        assert_eq!(content.turn("lap"), Some("A lap ended.\n"));
        assert_eq!(content.turn("pick"), Some("Pick with care.\n"));
        assert_eq!(content.turn("quiet"), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_identity_is_required() {
        let root = dir("identity");
        assert!(
            load(&root, &manifest())
                .unwrap_err()
                .contains("could not be read")
        );
        std::fs::write(root.join("abai/identity.md"), "\n").unwrap();
        assert!(load(&root, &manifest()).unwrap_err().ends_with("is empty"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
