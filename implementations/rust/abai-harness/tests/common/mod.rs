//! What the tests of the live modes share: an agent that is a script,
//! and a user whose lines are given.
#![allow(dead_code)]

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread::ThreadId;
use std::time::{Duration, Instant};

use abai_harness::core::{Core, UserChannel};
use abai_harness::embedded::{Front, RunEnd, Wake};
use serde_json::Value;

/// What the scripted agent does with one wake.
pub type Step = Box<dyn FnOnce(&mut Core, &Wake) -> RunEnd + Send>;

#[derive(Default, Clone)]
pub struct Script {
    pub steps: Arc<Mutex<Vec<Step>>>,
    pub wakes: Arc<Mutex<Vec<Wake>>>,
    /// The thread each step ran on.
    pub threads: Arc<Mutex<Vec<ThreadId>>>,
}

impl Script {
    pub fn then(&self, step: impl FnOnce(&mut Core, &Wake) + Send + 'static) {
        self.steps.lock().unwrap().push(Box::new(move |core, wake| {
            step(core, wake);
            RunEnd::Done
        }));
    }

    pub fn then_end(&self, step: impl FnOnce(&mut Core, &Wake) -> RunEnd + Send + 'static) {
        self.steps.lock().unwrap().push(Box::new(step));
    }

    pub fn wakes(&self) -> Vec<Wake> {
        self.wakes.lock().unwrap().clone()
    }

    /// Wait until this many wakes have been delivered.
    pub fn wait_for(&self, count: usize) -> Vec<Wake> {
        let started = Instant::now();
        while self.wakes().len() < count {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "only {} of {count} wakes came: {:?}",
                self.wakes().len(),
                self.wakes()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        self.wakes()
    }
}

pub struct Scripted(pub Script);

impl Front for Scripted {
    fn run(&mut self, core: &mut Core, wake: &Wake, _deadline: Option<Instant>) -> RunEnd {
        self.0
            .threads
            .lock()
            .unwrap()
            .push(std::thread::current().id());
        // a wake with no step scripted for it needs nothing
        let step = {
            let mut steps = self.0.steps.lock().unwrap();
            (!steps.is_empty()).then(|| steps.remove(0))
        };
        let end = step.map_or(RunEnd::Done, |step| step(core, wake));
        self.0.wakes.lock().unwrap().push(wake.clone());
        end
    }

    fn user_line(&mut self, core: &mut Core, line: &str) -> RunEnd {
        if let Some(channel) = core.channel() {
            channel.say(&format!("you said {line}"));
        }
        RunEnd::Done
    }

    fn greeting(&self, _core: &Core) -> String {
        "a session".to_string()
    }
}

/// A user whose lines are given one at a time, and whose screen is kept.
#[derive(Default, Clone)]
pub struct User {
    pub lines: Arc<Mutex<Vec<String>>>,
    pub said: Arc<Mutex<Vec<String>>>,
    /// Whether the user has gone: no more lines will come.
    pub gone: Arc<Mutex<bool>>,
}

impl UserChannel for User {
    fn say(&mut self, text: &str) {
        self.said.lock().unwrap().push(text.to_string());
    }

    fn ask(&mut self, _prompt: &str) -> Option<String> {
        None
    }

    fn confirm(&mut self, _question: &str, _timeout: Duration) -> bool {
        true
    }

    fn try_line(&mut self, wait: Duration) -> Option<Option<String>> {
        let line = {
            let mut lines = self.lines.lock().unwrap();
            (!lines.is_empty()).then(|| lines.remove(0))
        };
        if line.is_some() {
            return Some(line);
        }
        if *self.gone.lock().unwrap() {
            return Some(None);
        }
        std::thread::sleep(wait);
        None
    }
}

/// The audit log at `path`, one short line per entry.
pub fn audit_lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| {
            let line: Value = serde_json::from_str(line).unwrap();
            let mut text = format!("{} {} {}", line["act"], line["name"], line["outcome"]);
            if let Some(cause) = line.get("cause") {
                text.push_str(&format!(" cause={cause}"));
            }
            text.replace('"', "")
        })
        .collect()
}

/// The reasons of an attention wake.
pub fn reasons(wake: &Wake) -> Vec<String> {
    match wake {
        Wake::Attention { reasons, .. } => reasons.clone(),
        other => panic!("not an attention wake: {other:?}"),
    }
}
