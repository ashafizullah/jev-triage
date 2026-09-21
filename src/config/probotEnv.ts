import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Probot 14 resolves environment variables only in `run()` / `createProbot()`, not
 * inside the `Server` class. We drive `Server` directly so we can register the
 * `/healthz` route, which means resolving the GitHub App credentials ourselves.
 */
export interface ProbotCredentials {
  appId?: string;
  privateKey?: string;
  secret?: string;
  webhookPath: string;
  logLevel: string;
}

/** PRIVATE_KEY wins; otherwise the first *.pem in the working directory, like Probot. */
export function resolvePrivateKey(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string | undefined {
  const fromEnv = env.PRIVATE_KEY?.trim();
  if (fromEnv) return fromEnv;

  try {
    const pem = readdirSync(cwd).find((name) => name.endsWith(".pem"));
    if (pem) return readFileSync(join(cwd, pem), "utf8");
  } catch {
    // Directory listing failures are not fatal here.
  }
  return undefined;
}

export function resolveProbotCredentials(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ProbotCredentials {
  return {
    appId: env.APP_ID?.trim() || undefined,
    privateKey: resolvePrivateKey(env, cwd),
    secret: env.WEBHOOK_SECRET?.trim() || undefined,
    webhookPath: env.WEBHOOK_PATH?.trim() || "/api/github/webhooks",
    logLevel: env.LOG_LEVEL?.trim() || "info",
  };
}

export function describeMissingCredentials(credentials: ProbotCredentials): string[] {
  const missing: string[] = [];
  if (!credentials.appId) missing.push("APP_ID");
  if (!credentials.privateKey)
    missing.push("PRIVATE_KEY (or a *.pem file in the working directory)");
  if (!credentials.secret) missing.push("WEBHOOK_SECRET");
  return missing;
}
