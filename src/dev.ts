/**
 * Local development entry point.
 *
 * Uses Probot's `run()` rather than building the server ourselves, which gives the
 * behaviour you want while developing:
 *
 *  - first run, with no APP_ID/PRIVATE_KEY, opens the GitHub App setup wizard on
 *    http://localhost:3000 and writes the credentials into .env for you
 *  - WEBHOOK_PROXY_URL is connected to a smee.io channel automatically
 *  - our `/healthz` route is still registered, because Probot passes `addHandler`
 *    to the app function
 *
 * Production uses src/index.ts, which owns the HTTP server directly.
 */
import { run } from "probot";
import { app } from "./app";
import { loadEnvFile } from "./util/env";

loadEnvFile();

run(app).catch((err) => {
  console.error("Failed to start jev-triage", err);
  process.exit(1);
});
