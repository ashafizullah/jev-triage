/**
 * Node 20.12+ can read a .env file natively; Probot no longer does it for us,
 * and neither dist nor the CLI scripts should require an extra dependency.
 */
export function loadEnvFile(path = ".env"): void {
  const loader = (process as unknown as { loadEnvFile?: (file?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader.call(process, path);
  } catch {
    // Missing .env is a valid production configuration.
  }
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Parses a boolean-ish environment variable; anything else counts as false. */
export function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return TRUTHY.has(value.trim().toLowerCase());
}

/**
 * Deployment-wide safety switch. When set, nothing is ever written to GitHub, whatever
 * a repository's config says — useful for staging or for a first cautious rollout.
 */
export function isDryRunForced(): boolean {
  return isTruthy(process.env.JEV_TRIAGE_DRY_RUN);
}
