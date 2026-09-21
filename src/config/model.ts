import { DEFAULT_MODEL, type JevTriageConfig } from "./schema";

/**
 * Resolves which Jev model to call.
 *
 * Precedence, most specific first:
 *   1. `model:` in the repository's .github/jev-triage.yml
 *   2. the JEV_MODEL environment variable (deployment-wide default)
 *   3. DEFAULT_MODEL
 *
 * The environment variable has to be read here rather than left to the SDK, because the
 * pipeline sends an explicit model on every request — which would otherwise shadow it.
 */
export function resolveModel(
  config: Pick<JevTriageConfig, "model">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // Blank counts as unset throughout: `JEV_MODEL=` in a .env file yields "", and sending
  // an empty model name to the API fails.
  const fromConfig = config.model?.trim();
  if (fromConfig) return fromConfig;

  const fromEnv = env.JEV_MODEL?.trim();
  if (fromEnv) return fromEnv;

  return DEFAULT_MODEL;
}
