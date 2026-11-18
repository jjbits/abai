//! The command line: `abaikit-rs <verb> ...`.

use abai_stub::manifest::Mode;

use crate::Failure;

pub const USAGE: &str = "usage: abaikit-rs learnabai|check ...
       abaikit-rs learnabai [--section <name>] [--json] [--skill] [--skill-dir <dir>]
       abaikit-rs check <repo> [--level <1-4>] [--mode <turns|thread|sidecar>] [--entry <cmd>] [--runs <n>] [--timeout <seconds>] [--json]
       abaikit-rs --version

learnabai prints the guide for an agent that makes a Rust abaigram;
check verifies a repository's conformance and needs no model.";

/// `check`'s arguments.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CheckArgs {
    pub repo: String,
    /// The level the repository must reach, 1 to 4.
    pub level: Option<u8>,
    /// Check this declared mode only.
    pub mode: Option<Mode>,
    /// Use this command line in place of the manifest's entry.
    pub entry: Option<String>,
    /// How many measurement runs of each kind.
    pub runs: Option<u32>,
    /// The bound on one `check.run`, in seconds.
    pub timeout_s: Option<u64>,
    pub json: bool,
}

/// `learnabai`'s arguments.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LearnArgs {
    pub section: Option<String>,
    pub json: bool,
    pub skill: bool,
    pub skill_dir: Option<String>,
}

/// One invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    Help,
    Version,
    Learnabai(LearnArgs),
    Check(CheckArgs),
}

/// The positionals, and each flag with its value if it takes one.
type Scanned<'a> = (Vec<&'a str>, Vec<(&'a str, Option<&'a str>)>);

/// A verb's arguments, sorted into flags and positionals. `valued` are
/// the flags that take a value, as `--flag value` or `--flag=value`;
/// `bare` the ones that take none.
fn scan<'a>(
    verb: &str,
    argv: &'a [String],
    valued: &[&str],
    bare: &[&str],
) -> Result<Scanned<'a>, Failure> {
    let mut positionals = Vec::new();
    let mut flags = Vec::new();
    let mut at = 0;
    while at < argv.len() {
        let raw = argv[at].as_str();
        at += 1;
        if raw == "--" {
            return Err(Failure::usage(format!("{verb} takes no program command")));
        }
        if !raw.starts_with('-') {
            positionals.push(raw);
            continue;
        }
        let (name, inline) = match raw.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (raw, None),
        };
        if bare.contains(&name) {
            if inline.is_some() {
                return Err(Failure::usage(format!("{name} takes no value")));
            }
            flags.push((name, None));
            continue;
        }
        if !valued.contains(&name) {
            return Err(Failure::usage(format!("unknown argument {name}")));
        }
        let value = match inline {
            Some(value) => value,
            None => {
                let next = argv.get(at).map(String::as_str);
                at += 1;
                match next {
                    Some(value) if !value.starts_with("--") => value,
                    _ => return Err(Failure::usage(format!("{name} needs a value"))),
                }
            }
        };
        if value.is_empty() {
            return Err(Failure::usage(format!("{name} needs a value")));
        }
        flags.push((name, Some(value)));
    }
    Ok((positionals, flags))
}

fn positive(value: &str, flag: &str) -> Result<u64, Failure> {
    match value.parse::<u64>() {
        Ok(n) if n > 0 => Ok(n),
        _ => Err(Failure::usage(format!("{flag} needs a positive integer"))),
    }
}

/// Parse the arguments after the binary's name.
pub fn parse(argv: &[String]) -> Result<Parsed, Failure> {
    let Some(verb) = argv.first().map(String::as_str) else {
        return Ok(Parsed::Help);
    };
    let rest = &argv[1..];
    match verb {
        "help" | "--help" | "-h" => Ok(Parsed::Help),
        "--version" | "-V" => Ok(Parsed::Version),
        "learnabai" => {
            let (positionals, flags) = scan(
                verb,
                rest,
                &["--section", "--skill-dir"],
                &["--json", "--skill"],
            )?;
            if let Some(stray) = positionals.first() {
                return Err(Failure::usage(format!("unexpected argument {stray}")));
            }
            let mut args = LearnArgs::default();
            for (name, value) in flags {
                match name {
                    "--section" => args.section = value.map(str::to_string),
                    "--skill-dir" => args.skill_dir = value.map(str::to_string),
                    "--json" => args.json = true,
                    _ => args.skill = true,
                }
            }
            if args.skill_dir.is_some() && !args.skill {
                return Err(Failure::usage("--skill-dir needs --skill"));
            }
            Ok(Parsed::Learnabai(args))
        }
        "check" => {
            let (positionals, flags) = scan(
                verb,
                rest,
                &["--level", "--mode", "--entry", "--runs", "--timeout"],
                &["--json"],
            )?;
            let repo = match positionals.as_slice() {
                [] => return Err(Failure::usage("check needs a repository")),
                [repo] => repo.to_string(),
                [_, stray, ..] => {
                    return Err(Failure::usage(format!("unexpected argument {stray}")));
                }
            };
            let mut args = CheckArgs {
                repo,
                ..CheckArgs::default()
            };
            for (name, value) in flags {
                let value = value.unwrap_or_default();
                match name {
                    "--level" => {
                        args.level = match value.parse::<u8>() {
                            Ok(level @ 1..=4) => Some(level),
                            _ => {
                                return Err(Failure::usage("--level needs a level from 1 to 4"));
                            }
                        }
                    }
                    "--mode" => {
                        args.mode = Some(match value {
                            "turns" => Mode::Turns,
                            "thread" => Mode::Thread,
                            "sidecar" => Mode::Sidecar,
                            _ => {
                                return Err(Failure::usage(
                                    "--mode needs turns, thread or sidecar",
                                ));
                            }
                        })
                    }
                    "--entry" => args.entry = Some(value.to_string()),
                    "--runs" => {
                        args.runs = Some(
                            u32::try_from(positive(value, name)?)
                                .map_err(|_| Failure::usage("--runs is too large"))?,
                        )
                    }
                    "--timeout" => args.timeout_s = Some(positive(value, name)?),
                    _ => args.json = true,
                }
            }
            Ok(Parsed::Check(args))
        }
        other => Err(Failure::usage(format!("unknown verb {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(words: &[&str]) -> Result<Parsed, Failure> {
        parse(&words.iter().map(|w| w.to_string()).collect::<Vec<_>>())
    }

    fn usage(words: &[&str]) -> String {
        match parsed(words) {
            Err(Failure::Usage(message)) => message,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn no_verb_and_help_are_the_usage() {
        assert_eq!(parsed(&[]), Ok(Parsed::Help));
        assert_eq!(parsed(&["--help"]), Ok(Parsed::Help));
        assert_eq!(parsed(&["--version"]), Ok(Parsed::Version));
        assert_eq!(usage(&["frob"]), "unknown verb frob");
    }

    #[test]
    fn check_takes_a_repository_and_its_flags() {
        assert_eq!(
            parsed(&[
                "check",
                "repo",
                "--level",
                "3",
                "--mode=thread",
                "--runs",
                "5",
                "--timeout=9",
                "--entry",
                "./prog abai",
                "--json",
            ]),
            Ok(Parsed::Check(CheckArgs {
                repo: "repo".to_string(),
                level: Some(3),
                mode: Some(Mode::Thread),
                entry: Some("./prog abai".to_string()),
                runs: Some(5),
                timeout_s: Some(9),
                json: true,
            }))
        );
        assert_eq!(usage(&["check"]), "check needs a repository");
        assert_eq!(usage(&["check", "a", "b"]), "unexpected argument b");
        assert_eq!(
            usage(&["check", "a", "--level", "5"]),
            "--level needs a level from 1 to 4"
        );
        assert_eq!(
            usage(&["check", "a", "--mode", "x"]),
            "--mode needs turns, thread or sidecar"
        );
        assert_eq!(
            usage(&["check", "a", "--runs", "0"]),
            "--runs needs a positive integer"
        );
        assert_eq!(usage(&["check", "a", "--runs"]), "--runs needs a value");
        assert_eq!(
            usage(&["check", "a", "--runs", "--json"]),
            "--runs needs a value"
        );
        assert_eq!(usage(&["check", "a", "--entry="]), "--entry needs a value");
        assert_eq!(usage(&["check", "a", "--json=1"]), "--json takes no value");
        assert_eq!(usage(&["check", "a", "--frob"]), "unknown argument --frob");
        assert_eq!(
            usage(&["check", "a", "--", "x"]),
            "check takes no program command"
        );
    }

    #[test]
    fn learnabai_takes_its_flags() {
        assert_eq!(
            parsed(&["learnabai", "--section", "levels", "--json"]),
            Ok(Parsed::Learnabai(LearnArgs {
                section: Some("levels".to_string()),
                json: true,
                skill: false,
                skill_dir: None,
            }))
        );
        assert_eq!(
            parsed(&["learnabai", "--skill", "--skill-dir", "d"]),
            Ok(Parsed::Learnabai(LearnArgs {
                section: None,
                json: false,
                skill: true,
                skill_dir: Some("d".to_string()),
            }))
        );
        assert_eq!(
            usage(&["learnabai", "--skill-dir", "d"]),
            "--skill-dir needs --skill"
        );
        assert_eq!(usage(&["learnabai", "x"]), "unexpected argument x");
    }
}
