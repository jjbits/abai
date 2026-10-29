import { defineConfig, mergeConfig } from "vitest/config";
import base from "../vitest.base.ts";

export default mergeConfig(base, defineConfig({}));
