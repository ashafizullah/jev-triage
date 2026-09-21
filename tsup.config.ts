import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  // Native + heavy runtime deps stay external; they are resolved from node_modules at runtime.
  external: ["better-sqlite3", "probot", "@typesafe-ai/sdk", "drizzle-orm", "pino", "yaml", "zod"],
});
