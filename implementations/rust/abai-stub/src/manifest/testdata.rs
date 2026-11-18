//! A valid manifest for the tests: the contract's example with one of each declaration.

use super::Manifest;
use serde_json::json;

/// A manifest that validates, built from the contract's example (section 5).
pub(crate) fn sample() -> Manifest {
    serde_json::from_value(json!({
        "abaigrammar": "0.1",
        "name": "jobs",
        "entry": "./bin/jobs abai",
        "modes": ["sidecar", "turns"],
        "check": {"run": "make bench"},
        "content": {"identity": "abai/identity.md", "use": "abai/use.md"},
        "audit": {"path": "~/.abai/audit/jobs.jsonl"},
        "lifecycle": {"pause": "cooperative", "stop": {"graceful": "10s", "handler": "stop"}},
        "attention": {"budget": {"wakes_per_minute": 30, "tokens_per_hour": 200000}},
        "policy": {"confirm_timeout": "60s"},
        "deviations": ["A first deviation (section 6.3)."],
        "cells": [
            {
                "name": "queue.depth",
                "type": "int",
                "access": "read",
                "doc": "Number of jobs waiting. Rises when producers outpace workers."
            },
            {
                "name": "worker.count",
                "type": "int",
                "access": "readwrite",
                "default": 4,
                "range": [1, 64],
                "cadence": 1000,
                "policy": "auto",
                "doc": "Active worker threads. The pool resizes within a second of a change."
            }
        ],
        "events": [
            {
                "name": "job.failed",
                "payload": {
                    "job_id": {"type": "string", "max": 64},
                    "error": {"type": "string", "max": 512}
                },
                "wakes": "always",
                "doc": "A job exhausted its retries."
            }
        ],
        "capabilities": [
            {
                "name": "job.retry",
                "params": {"job_id": "string"},
                "result": {"ok": "bool"},
                "effect": "mutate",
                "dispatch": "safepoint",
                "timeout": "5s",
                "policy": "confirm",
                "example": {"job_id": "job-0001"},
                "doc": "Requeue a failed job once."
            }
        ],
        "decisions": [
            {
                "name": "on_backlog",
                "context": {"depth": "int", "workers": "int"},
                "options": ["scale_up", "shed_oldest", "wait"],
                "default": "wait",
                "timeout": "5s",
                "policy": "auto",
                "doc": "Asked when the queue depth crosses the high-water mark."
            }
        ],
        "turns": [
            {
                "name": "end_of_batch",
                "timeout": "30s",
                "doc": "After each batch completes. The agent may tune worker.count."
            }
        ]
    }))
    .unwrap()
}
