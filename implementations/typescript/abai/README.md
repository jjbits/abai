# abai (TypeScript stub)

The library a TypeScript program includes to become an abaigram: the
program side of `spec/abaigrammar.md`. Declarations in code become the
manifest; cells, events, capabilities, decisions, turns and safepoints are
the program's end of the five channels; `<prog> abai manifest | doctor`
is the stub's part of the standard entry.

```ts
import { createAbaigram } from "abai";

const app = createAbaigram({ name: "counter", modes: ["turns", "sidecar"], cells: {...}, ... });
if ((await app.entry(process.argv.slice(2))) >= 0) process.exit();
const depth = app.cell<number>("queue.depth");   // obtain handles once; names are checked here
const failed = app.event("job.failed");
depth.set(3);                                     // one store
await app.decide("on_backlog", { depth: 3 });     // the default, until a harness attaches
```

`examples/counter/` is the smallest abaigram and the test subject. The
measured cost of every detached operation is written to
`../.design/cost-11.1.md` by the test suite.
