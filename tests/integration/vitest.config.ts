import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["presentation-workflow.live.e2e.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 45_000,
    globals: true,
    sequence: {
      concurrent: false,
    },
    globalSetup: "./global-setup.ts",
    fileParallelism: false,
  },
});
