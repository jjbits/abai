import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** The stub's source entry, so the harness tests run against the stub without a build. */
export const stubSourceIndex = fileURLToPath(new URL("./abai-stub/src/index.ts", import.meta.url));
export const harnessSourceIndex = fileURLToPath(new URL("./abai-embedded-harness/src/index.ts", import.meta.url));
export const abaikitSourceIndex = fileURLToPath(new URL("./abaikit/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 30000,
		reporters: ["dot"],
		silent: "passed-only",
	},
	resolve: {
		alias: [
			{ find: /^@abaigram\/abai-stub$/, replacement: stubSourceIndex },
			{ find: /^@abaigram\/abai-embedded-harness$/, replacement: harnessSourceIndex },
			{ find: /^@abaigram\/abaikit$/, replacement: abaikitSourceIndex },
		],
	},
});
