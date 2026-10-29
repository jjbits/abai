import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 90000,
		hookTimeout: 60000,
		reporters: ["dot"],
		silent: "passed-only",
	},
});
