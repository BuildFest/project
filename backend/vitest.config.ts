import { defineConfig } from "vitest/config";

// Integration suites each start an embedded PostgreSQL server. Running those
// files concurrently is both resource-heavy and flaky on CI/Windows, so keep
// file execution serial while still allowing normal concurrency inside a file.
export default defineConfig({
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
