import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["presentation-workflow.live.e2e.test.ts"],
    testTimeout: 45 * 60_000,
    hookTimeout: 60_000,
    globals: true,
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});
