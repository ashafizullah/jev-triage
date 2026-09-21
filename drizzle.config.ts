import { defineConfig } from "drizzle-kit";

/**
 * Used by `npm run db:generate` to emit SQL migrations when the schema changes.
 *
 * The service itself does not need these files at runtime: `src/db/migrate.ts` ships
 * an idempotent DDL string that is applied on boot, so a fresh deployment works with
 * no build step. Generate migrations when you want a reviewable record of a change,
 * or when moving to Postgres.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.JEV_TRIAGE_DB_PATH ?? "./data/jev-triage.db",
  },
});
