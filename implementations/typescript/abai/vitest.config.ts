import { defineConfig, mergeConfig } from "vitest/config";
import base from "../vitest.base.ts";

export default mergeConfig(
	base,
	defineConfig({
		test: {
			// the cost test measures heap growth per operation and needs a collector it can call
			pool: "forks",
			execArgv: ["--expose-gc"],
		},
	}),
);
