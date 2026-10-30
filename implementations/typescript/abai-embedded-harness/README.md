# abai-embedded-harness (TypeScript)

The TypeScript harness: the agent side of the contract, `spec/abaigrammar.md`
in the [abai repository](https://github.com/jjbits/abai), shipped as a
library for the in-process turns mode and as the sidecar binary. It
consumes `@arx-06/ai` and `@arx-06/agent` from npm, published from the
tarballs in the repository's `implementations/typescript/vendor/`, and
generalizes the harness core ported from arx-06.

A model is configured once per machine under `~/.abai/` (`<prog> abai
config`): Anthropic, or a FreeToken server. Nothing in conformance needs
one; the MCP server (`abai mcp`) serves a client such as Claude Code with
no model at all.
