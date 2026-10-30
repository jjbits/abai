// hello: the smallest abaigram. It declares a name, an entry, one mode and
// an audit path, serves the standard agent entry, and prints one word.
//
//   node examples/hello/hello.ts                 run the program
//   node examples/hello/hello.ts abai doctor
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAbaigram, runEntry } from "@abaigram/abai-stub";

const app = createAbaigram(
	{ name: "hello", entry: "node hello.ts abai", modes: ["turns"], audit: { path: "./abai-audit.log" } },
	{ root: dirname(fileURLToPath(import.meta.url)) },
);

const code = await runEntry(app, process.argv.slice(2));
if (code >= 0) process.exit(code);

console.log("hello");
