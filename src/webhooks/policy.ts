import type { ItemType, JevTriageConfig } from "../config/schema";

export type TriageTrigger =
  | "opened"
  | "edited"
  | "reopened"
  | "synchronize"
  | "ready_for_review"
  | "retriage";

/**
 * Decides whether an event should be triaged at all, before any GitHub or Jev call is
 * made. Kept as a pure function so the policy is easy to read and to test.
 *
 * Two tiers:
 * - `enabled` is the master switch and is absolute; nothing runs when it is false.
 * - the `triage.*` options scope the *automation*, so an explicit `/jev retriage`
 *   from a maintainer bypasses them.
 */
export function resolveSkipReason(
  type: ItemType,
  trigger: TriageTrigger,
  isDraft: boolean | undefined,
  config: JevTriageConfig,
): string | null {
  if (!config.enabled) return "disabled";
  if (trigger === "retriage") return null;

  if (type === "issue") {
    return config.triage.issues ? null : "issues-disabled";
  }

  if (!config.triage.pullRequests) return "pull-requests-disabled";
  if (trigger === "synchronize" && !config.triage.onPullRequestPush) {
    return "pull-request-push-disabled";
  }
  if (isDraft === true && !config.triage.includeDrafts) return "draft-pull-request";

  return null;
}
