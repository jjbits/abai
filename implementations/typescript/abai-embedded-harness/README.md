# @abaigram/abai-embedded-harness

The TypeScript harness: the agent side of the contract, `spec/abaigrammar.md`
in the [abai repository](https://github.com/jjbits/abai), shipped as a
library for the in-process turns and thread modes and as the sidecar binary
`abai-embedded-harness`. A program installs it beside the stub with
`npm install @abaigram/abai-stub @abaigram/abai-embedded-harness`. It
consumes `@arx-06/ai` and `@arx-06/agent` from npm, published from the
tarballs in the repository's `implementations/typescript/vendor/`, and
generalizes the harness core ported from arx-06.

A model is configured once per machine under `~/.abai/` (`<prog> abai
config`): Anthropic, or a FreeToken server. Nothing in conformance needs
one; the MCP server (`abai mcp`) serves a client such as Claude Code with
no model at all.

A program that declares `network` in its manifest puts its agent on an
aiip network, an overlay network for agents. The harness talks to aiip's
daemon over its Unix socket and needs the `aiip` binary on the machine
(`ABAI_AIIP_BIN`, `<prog> abai config set aiip-bin <path>`, or the PATH);
`doctor` reports when it is missing. The run's identity lives under
`ABAI_NET_DIR`, else `~/.abai/net/<program>/`; `ABAI_NET_TOKEN` joins
with an invite at attach; `<prog> abai config net` shows, joins, leaves,
creates and invites. The agent sees its memberships in its prompt and
lists the members with `abai_peers`; a member's message wakes it as
`abai.net.message`, `abai_send` answers by name with a reason, and
`abai_messages` rereads. Every message sent or received is an audit line
the program's stub writes. The wire envelope is aiap v1 over aiipd's
mailbox, so abaigrams and aiap's agents read each other.
