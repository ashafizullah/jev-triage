import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: false,
    restoreMocks: true,
    // The pipeline touches a real SQLite file only when told to; tests pass ":memory:".
    env: {
      NODE_ENV: "test",
    },
  },
});
