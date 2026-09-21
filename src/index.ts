import { Probot, Server } from "probot";
import type { Options } from "probot";
import { app } from "./app";
import { describeMissingCredentials, resolveProbotCredentials } from "./config/probotEnv";
import { loadEnvFile } from "./util/env";
import { createLogger } from "./util/logger";

async function main(): Promise<void> {
  loadEnvFile();

  const credentials = resolveProbotCredentials();
  const log = createLogger({ level: credentials.logLevel });

  const missing = describeMissingCredentials(credentials);
  if (missing.length > 0) {
    log.error(
      { missing },
      "Missing GitHub App configuration. Copy .env.example to .env and fill it in.",
    );
    process.exit(1);
  }

  const server = new Server({
    log,
    port: Number(process.env.PORT ?? 3000),
    // Containers must bind all interfaces; locally Probot's default (localhost) is fine.
    host: process.env.HOST,
    // Set when tunnelling webhooks to a local machine through smee.io.
    webhookProxy: process.env.WEBHOOK_PROXY_URL,
    Probot: Probot.defaults({
      appId: credentials.appId,
      privateKey: credentials.privateKey,
      secret: credentials.secret,
      webhookPath: credentials.webhookPath,
      logLevel: credentials.logLevel as NonNullable<Options["logLevel"]>,
    }),
  });

  await server.load(app);
  await server.start();
  log.info({ port: server.port, webhookPath: credentials.webhookPath }, "jev-triage is listening");

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "Shutting down");
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start jev-triage", err);
  process.exit(1);
});
