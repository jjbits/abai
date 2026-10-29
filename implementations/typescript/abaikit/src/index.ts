/** abaikit: the abai authoring tool, as a library and a binary. See spec/abaigrammar.md. */

export { type AbaikitHandlers, createAbaikit } from "./abaigram.ts";
export { main, type ParsedArgs, parseArgs, UsageError } from "./bin.ts";
export { ABAIKIT_VERSION } from "./version.ts";
