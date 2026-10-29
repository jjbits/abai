import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// the declaration module is a singleton the tests import: no real endpoint, no null harness
		env: { ABAI_HARNESS: "off" },
		testTimeout: 30000,
		reporters: ["dot"],
		silent: "passed-only",
	},
});
