# @abaigram/abaikit

The abai authoring tool, itself an abaigram. A coding agent uses it to
make a program an abaigram under the contract, `spec/abaigrammar.md` in
the [abai repository](https://github.com/jjbits/abai). Installed with
`npm install --save-dev @abaigram/abaikit`, the command is `abaikit`.

- `abaikit learnabai` prints the guide the agent follows; `--skill`
  installs it as a Claude Code skill.
- `abaikit check <repo>` verifies a repository's conformance and its
  level; it needs no model.
- `abaikit new <name> --lang ts` creates a fresh abaigram.
- `abaikit abaify <repo>` retrofits an existing repository, adding and
  never removing.
- `abaikit run <repo> -- ARGS` starts the repository's program.
- `abaikit abai ...` is the standard agent entry of abaikit itself.
