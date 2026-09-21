import type { JevTriageConfig } from "../config/schema";
import type { Octokit, RepoRef } from "../github/types";

/** Every label the bot manages itself; these never belong in the suggestion shortlist. */
export function managedLabels(config: JevTriageConfig): string[] {
  return [
    ...Object.values(config.labels.category),
    config.labels.needsInfo,
    config.labels.possibleDuplicate,
    config.labels.needsTriage,
    config.labels.priorityCritical,
  ];
}

function labelTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2),
  );
}

/**
 * True when a candidate reads as the same thing as a label the bot manages, so offering
 * it would put two contradictory labels on one item. A shared word is the signal:
 * `duplicate` next to our `possible-duplicate`, or `critical` next to `priority:critical`.
 * Exact-name matches are already filtered out; this catches the rest.
 */
function overlapsManagedLabels(candidate: string, managed: string[]): boolean {
  const candidateTokens = labelTokens(candidate);
  if (candidateTokens.size === 0) return false;
  return managed.some((label) => {
    for (const token of labelTokens(label)) {
      if (candidateTokens.has(token)) return true;
    }
    return false;
  });
}

/**
 * Labels a contributor could reasonably be given, excluding the ones the bot owns.
 * The list is capped because a Choice with too many options loses accuracy.
 */
export async function fetchLabelShortlist(
  octokit: Octokit,
  ref: RepoRef,
  config: JevTriageConfig,
): Promise<string[]> {
  try {
    const labels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
      owner: ref.owner,
      repo: ref.repo,
      per_page: 100,
    });
    const managed = managedLabels(config);
    const managedLower = new Set(managed.map((label) => label.toLowerCase()));

    return labels
      .map((label) => label.name)
      .filter(
        (name) =>
          name.length > 0 &&
          !managedLower.has(name.toLowerCase()) &&
          !overlapsManagedLabels(name, managed),
      )
      .sort((a, b) => a.localeCompare(b))
      .slice(0, config.duplicates.labelShortlistSize);
  } catch {
    return [];
  }
}

/**
 * Reviewer candidates, either from explicit configuration or discovered from the
 * repository's top contributors.
 */
export async function fetchReviewerPool(
  octokit: Octokit,
  ref: RepoRef,
  config: JevTriageConfig,
): Promise<string[]> {
  if (config.reviewerPool.length > 0) {
    return config.reviewerPool.slice(0, config.duplicates.labelShortlistSize);
  }
  try {
    const contributors = await octokit.rest.repos.listContributors({
      owner: ref.owner,
      repo: ref.repo,
      per_page: 30,
    });
    return contributors.data
      .map((entry) => entry.login)
      .filter((login): login is string => typeof login === "string" && login.length > 0)
      .slice(0, config.duplicates.labelShortlistSize);
  } catch {
    return [];
  }
}
