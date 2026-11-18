//! `learnabai`: the guide for an agent that makes a Rust abaigram.
//!
//! The guide is `learnabai.md` beside the crates, built into the binary.
//! Its `{{name}}` places are filled with this build's versions and the
//! deviations the stub declares, so the text an agent reads is the text
//! of the tool it runs.

use std::io::Write;
use std::path::PathBuf;

use abai_stub::declare::{INSTANTIATION_DEVIATIONS, SIDECAR_DEVIATION, THREAD_DEVIATION};
use abai_stub::manifest::ABAIGRAMMAR_VERSION;
use serde_json::{Map, Value, json};

use crate::args::LearnArgs;
use crate::{ABAIKIT_VERSION, Failure, Io};

const GUIDE: &str = include_str!("../../learnabai.md");

/// The name of the skill `--skill` installs. The TypeScript guide's
/// skill is `learnabai`; the two stand side by side.
pub const SKILL_NAME: &str = "learnabai-rust";

const SKILL_DESCRIPTION: &str = "How to create a Rust abaigram or retrofit a Rust program into one with abai (the stub crate, the standard entry, the conformance levels, the step-by-step retrofit, and what never to do). Use when asked to abaify a Rust repository, add abai to a Rust program, or check a Rust abaigram's conformance.";

/// The guide, with its places filled and cut into its sections.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Guide {
    pub text: String,
    /// What stands before the first section.
    pub header: String,
    /// Each section's id and text, in order.
    pub sections: Vec<(String, String)>,
}

fn place(name: &str) -> Option<String> {
    Some(match name {
        "abaigrammar" => ABAIGRAMMAR_VERSION.to_string(),
        "stub" => abai_stub::ABAI_STUB_VERSION.to_string(),
        "abaikit" => ABAIKIT_VERSION.to_string(),
        "deviations" => INSTANTIATION_DEVIATIONS
            .iter()
            .copied()
            .chain([THREAD_DEVIATION, SIDECAR_DEVIATION])
            .map(|sentence| format!("- {sentence}"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    })
}

/// Fill every `{{name}}` in a text. A name nobody knows is an error.
fn fill(text: &str) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let Some(len) = rest[start..].find("}}") else {
            break;
        };
        let name = &rest[start + 2..start + len];
        out.push_str(&rest[..start]);
        out.push_str(
            &place(name)
                .ok_or_else(|| format!("the guide names an unknown place {{{{{name}}}}}"))?,
        );
        rest = &rest[start + len + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

/// The id a section heading ends with: `## 4. Levels (levels)`.
fn heading_id(line: &str) -> Option<&str> {
    let id = line
        .strip_prefix("## ")?
        .strip_suffix(')')?
        .rsplit_once(" (")?
        .1;
    (!id.is_empty() && id.bytes().all(|b| b.is_ascii_lowercase())).then_some(id)
}

/// Cut a guide's text into its sections: the `## ` headings outside code
/// fences, each ending in its id in parentheses.
pub fn parse_guide(source: &str) -> Result<Guide, String> {
    let text = fill(source)?;
    let mut header = String::new();
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut fenced = false;
    for line in text.split_inclusive('\n') {
        let bare = line.trim_end_matches('\n');
        if bare.starts_with("```") {
            fenced = !fenced;
        }
        if !fenced && bare.starts_with("## ") {
            let id = heading_id(bare)
                .ok_or_else(|| format!("the heading has no id in parentheses: {bare}"))?;
            if sections.iter().any(|(have, _)| have == id) {
                return Err(format!("two sections are called {id}"));
            }
            sections.push((id.to_string(), String::new()));
        }
        match sections.last_mut() {
            Some((_, body)) => body.push_str(line),
            None => header.push_str(line),
        }
    }
    for (_, body) in &mut sections {
        *body = body.trim_end().to_string();
    }
    Ok(Guide {
        text,
        header,
        sections,
    })
}

/// This build's guide.
pub fn load_guide() -> Result<Guide, Failure> {
    parse_guide(GUIDE).map_err(Failure::Other)
}

/// The skill file: the guide under the front matter a skill needs.
pub fn skill_text(guide: &Guide) -> String {
    format!(
        "---\nname: {SKILL_NAME}\ndescription: {SKILL_DESCRIPTION}\n---\n\nThis is the output of `abaikit-rs learnabai` for abaikit-rs {ABAIKIT_VERSION}; run that command for the current text and `abaikit-rs learnabai --section <id>` for one section.\n\n{}\n",
        guide.text.trim_end()
    )
}

/// Where `--skill` writes: under `--skill-dir`, else the person's skills.
fn skill_path(args: &LearnArgs, io: &Io<'_>) -> Result<PathBuf, Failure> {
    let skills = match &args.skill_dir {
        Some(dir) => io.cwd.join(dir),
        None => {
            let home = io.var("HOME").ok_or_else(|| {
                Failure::usage("--skill needs HOME, or --skill-dir <dir> to say where")
            })?;
            PathBuf::from(home).join(".claude").join("skills")
        }
    };
    Ok(skills.join(SKILL_NAME).join("SKILL.md"))
}

/// Run `learnabai` and return its exit code.
pub fn run_learnabai(args: &LearnArgs, io: &mut Io<'_>) -> Result<u8, Failure> {
    let guide = load_guide()?;
    if args.skill {
        let path = skill_path(args, io)?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|error| Failure::Other(format!("{}: {error}", dir.display())))?;
        }
        std::fs::write(&path, skill_text(&guide))
            .map_err(|error| Failure::Other(format!("{}: {error}", path.display())))?;
        writeln!(io.out, "{}", path.display())?;
        return Ok(0);
    }
    let chosen: Vec<&(String, String)> = match &args.section {
        None => guide.sections.iter().collect(),
        Some(id) => match guide.sections.iter().find(|(have, _)| have == id) {
            Some(section) => vec![section],
            None => {
                let ids: Vec<&str> = guide.sections.iter().map(|(id, _)| id.as_str()).collect();
                return Err(Failure::usage(format!(
                    "learnabai has no section {id} (it has: {})",
                    ids.join(", ")
                )));
            }
        },
    };
    if args.json {
        let sections: Map<String, Value> = chosen
            .iter()
            .map(|(id, body)| (id.clone(), Value::String(body.clone())))
            .collect();
        let document = json!({
            "abaigrammar": ABAIGRAMMAR_VERSION,
            "stub": abai_stub::ABAI_STUB_VERSION,
            "abaikit": ABAIKIT_VERSION,
            "language": "rust",
            "sections": sections,
        });
        let pretty = serde_json::to_string_pretty(&document)
            .map_err(|error| Failure::Other(error.to_string()))?;
        writeln!(io.out, "{pretty}")?;
    } else if args.section.is_some() {
        writeln!(io.out, "{}", chosen[0].1)?;
    } else {
        write!(io.out, "{}", guide.text)?;
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A writer the test can read back.
    #[derive(Clone, Default)]
    struct Kept(Arc<Mutex<Vec<u8>>>);

    impl Write for Kept {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Kept {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    fn run(args: LearnArgs, env: &[(&str, &str)], cwd: PathBuf) -> (Result<u8, Failure>, String) {
        let out = Kept::default();
        let mut io = Io {
            out: Box::new(out.clone()),
            err: Box::new(Kept::default()),
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            cwd,
        };
        let result = run_learnabai(&args, &mut io);
        (result, out.text())
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("abaikit-learn-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_guide_has_its_eight_sections_and_no_place_left_open() {
        let guide = load_guide().unwrap();
        let ids: Vec<&str> = guide.sections.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "what",
                "declare",
                "entry",
                "levels",
                "retrofit",
                "use",
                "deviations",
                "never"
            ]
        );
        assert!(!guide.text.contains("{{"), "a place was left open");
        assert!(guide.header.starts_with("# learnabai"));
        assert!(
            guide
                .header
                .contains(&format!("abai stub {}", abai_stub::ABAI_STUB_VERSION))
        );
        // the deviations are the ones the stub writes into a manifest
        let deviations = &guide.sections[6].1;
        for sentence in INSTANTIATION_DEVIATIONS {
            assert!(deviations.contains(sentence));
        }
        assert!(deviations.contains(THREAD_DEVIATION) && deviations.contains(SIDECAR_DEVIATION));
        // every section starts at its heading and the whole is their sum
        let joined: usize = guide.sections.iter().map(|(_, body)| body.len()).sum();
        assert!(joined + guide.header.len() <= guide.text.len());
        assert!(guide.sections[3].1.starts_with("## 4. "));
    }

    #[test]
    fn a_heading_inside_a_code_fence_is_not_a_section() {
        let guide =
            parse_guide("# t\n\n## One (one)\n```\n## not this\n```\nbody\n\n## Two (two)\nend\n")
                .unwrap();
        assert_eq!(guide.sections.len(), 2);
        assert_eq!(
            guide.sections[0].1,
            "## One (one)\n```\n## not this\n```\nbody"
        );
        assert_eq!(guide.header, "# t\n\n");
    }

    #[test]
    fn a_guide_that_is_not_well_formed_is_refused() {
        assert!(parse_guide("## No id\n").unwrap_err().contains("no id"));
        assert!(
            parse_guide("## A (x)\n## B (x)\n")
                .unwrap_err()
                .contains("two sections")
        );
        assert!(
            parse_guide("{{nobody}}\n")
                .unwrap_err()
                .contains("unknown place")
        );
    }

    #[test]
    fn the_whole_guide_one_section_and_json() {
        let cwd = std::env::temp_dir();
        let (code, whole) = run(LearnArgs::default(), &[], cwd.clone());
        assert_eq!(code, Ok(0));
        assert_eq!(whole, load_guide().unwrap().text);

        let levels = LearnArgs {
            section: Some("levels".to_string()),
            ..LearnArgs::default()
        };
        let (_, one) = run(levels.clone(), &[], cwd.clone());
        assert!(one.starts_with("## 4. ") && one.ends_with('\n'));
        assert!(!one.contains("## 5. "));

        let (_, text) = run(
            LearnArgs {
                json: true,
                ..levels
            },
            &[],
            cwd.clone(),
        );
        let document: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(document["language"], "rust");
        assert_eq!(document["sections"].as_object().unwrap().len(), 1);
        assert!(
            document["sections"]["levels"]
                .as_str()
                .unwrap()
                .starts_with("## 4. ")
        );

        let (_, text) = run(
            LearnArgs {
                json: true,
                ..LearnArgs::default()
            },
            &[],
            cwd.clone(),
        );
        let document: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(document["sections"].as_object().unwrap().len(), 8);

        let missing = LearnArgs {
            section: Some("nope".to_string()),
            ..LearnArgs::default()
        };
        match run(missing, &[], cwd).0 {
            Err(Failure::Usage(message)) => {
                assert!(message.contains("no section nope") && message.contains("levels"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_skill_is_written_where_it_is_told() {
        let dir = temp_dir("skill");
        let named = LearnArgs {
            skill: true,
            skill_dir: Some("skills".to_string()),
            ..LearnArgs::default()
        };
        let (code, out) = run(named, &[], dir.clone());
        assert_eq!(code, Ok(0));
        let path = dir.join("skills/learnabai-rust/SKILL.md");
        assert_eq!(out, format!("{}\n", path.display()));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.starts_with(
                "---\nname: learnabai-rust\ndescription: How to create a Rust abaigram"
            )
        );
        assert!(text.contains("\n---\n\nThis is the output of `abaikit-rs learnabai`"));
        assert!(text.contains("## 8. What never to do (never)") && text.ends_with("\n"));

        // with no directory named, under the person's home
        let home = dir.join("home");
        let at_home = LearnArgs {
            skill: true,
            ..LearnArgs::default()
        };
        let (_, out) = run(
            at_home.clone(),
            &[("HOME", home.to_str().unwrap())],
            dir.clone(),
        );
        assert_eq!(
            out.trim_end(),
            home.join(".claude/skills/learnabai-rust/SKILL.md")
                .display()
                .to_string()
        );
        assert!(matches!(
            run(at_home, &[], dir.clone()).0,
            Err(Failure::Usage(_))
        ));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
