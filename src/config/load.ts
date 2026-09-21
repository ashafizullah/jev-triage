import type { Context } from "probot";
import { parse as parseYaml } from "yaml";
import type { Octokit, RepoRef } from "../github/types";
import { DEFAULT_CONFIG, type JevTriageConfig, JevTriageConfigSchema } from "./schema";

export const CONFIG_FILE = "jev-triage.yml";

/**
 * Validates a raw config object (as returned by Probot's YAML loader).
 * Unknown keys are ignored; invalid values fall back to the defaults.
 */
export function parseConfig(raw: unknown): { config: JevTriageConfig; issues: string[] } {
  const result = JevTriageConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    return {
      config: DEFAULT_CONFIG,
      issues: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  return { config: result.data, issues: [] };
}

/**
 * Reads `.github/jev-triage.yml` from the repository's default branch, deep-merged
 * over the built-in defaults, then validated.
 */
export async function loadConfig(context: Context): Promise<JevTriageConfig> {
  let raw: unknown = DEFAULT_CONFIG;
  try {
    raw = (await context.config(CONFIG_FILE, DEFAULT_CONFIG)) ?? DEFAULT_CONFIG;
  } catch (err) {
    context.log.warn({ err }, "Could not load .github/jev-triage.yml; using defaults");
    return DEFAULT_CONFIG;
  }

  const { config, issues } = parseConfig(raw);
  if (issues.length > 0) {
    context.log.warn({ issues }, "Invalid jev-triage config values; using defaults for those keys");
  }
  return config;
}

/**
 * Same config lookup, but for CLI runs that have no Probot context: reads
 * `.github/jev-triage.yml` straight from the API and falls back to defaults.
 */
export async function loadConfigFromRepo(
  octokit: Octokit,
  ref: RepoRef,
): Promise<{ config: JevTriageConfig; issues: string[]; found: boolean }> {
  let raw: unknown = {};
  let found = false;

  try {
    const response = await octokit.rest.repos.getContent({
      owner: ref.owner,
      repo: ref.repo,
      path: `.github/${CONFIG_FILE}`,
    });
    const data = response.data;
    if (!Array.isArray(data) && data.type === "file" && "content" in data) {
      const decoded = Buffer.from(data.content, "base64").toString("utf8");
      raw = parseYaml(decoded) ?? {};
      found = true;
    }
  } catch {
    // No config file is normal; every key then comes from the defaults.
  }

  const { config, issues } = parseConfig(raw);
  return { config, issues, found };
}
