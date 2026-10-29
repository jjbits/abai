# abai-embedded-harness (TypeScript)

The TypeScript harness: the agent side of `spec/abaigrammar.md`, shipped as
a library for the in-process turns mode and as the sidecar binary. It
consumes `@arx-06/ai` and `@arx-06/agent` as pinned packages from
`../vendor/` and generalizes the harness core ported from arx-06.

A model is configured once per machine under `~/.abai/` (`<prog> abai
config`): Anthropic, or a FreeToken server. Nothing in conformance needs
one; the MCP server (`abai mcp`) serves a client such as Claude Code with
no model at all.
