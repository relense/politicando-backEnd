import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/globalSetup.ts"],
    // Database tests share one database and truncate it between tests.
    fileParallelism: false,
  },
});
