# Vendored packages

Pinned tarballs of the arx-06-0 packages the harness consumes, produced by
`npm pack` in `~/projects/arx-06-0/packages/{ai,agent}` at arx commit
`ec3cd0d14355b29357e26110e7d7c2b788c336f2` (dist built 2026-10-09 15:31;
sources last changed 15:28). Packed 2026-10-14.

| File | sha256 |
|---|---|
| `arx-06-ai-0.87.1.tgz` | `279880814e14f9b8c41764aa2131cd2bea2be83254b1a09c11403587530a3abe` |
| `arx-06-agent-0.87.1.tgz` | `ae6e379564557245a93e0b17ce23b63b0e77d18d751ade6c647874889d27680b` |

To bump: build arx (`fnm exec --using=24 npm run build` there), `npm pack
--pack-destination <this dir>` in each package, replace the two files,
update the two `file:` specs in the root `dependencies` and in
`abai-embedded-harness/package.json` (bump both tarballs together: the agent
tarball declares `@arx-06/ai` as a `^` range that the vendored copy must
satisfy), record the new commit and checksums here, run the gates.
