import type { Octokit, RepoRef } from "../github/types";
import { issueUrl, repoFullName } from "../github/types";
import type { Logger } from "../util/logger";
import { buildMarker, parseMarker } from "../util/marker";
import type { PlannedAction } from "./decide";
import { type NotifyTargets, sendNotification } from "./notify";
import type { PreprocessedItem } from "./preprocess";

export interface AppliedAction {
  action: PlannedAction;
  applied: boolean;
  skippedReason?: string;
  target?: string | null;
}

export interface ApplyOptions {
  dryRun: boolean;
  runKey: string;
  botLogin: string | null;
  notify: NotifyTargets;
}

function describeTarget(action: PlannedAction): string | null {
  switch (action.type) {
    case "add_label":
    case "remove_label":
      return action.label;
    case "comment":
      return action.kind;
    case "assign":
      return action.assignees.join(",");
    case "notify":
      return action.reason;
    default:
      return null;
  }
}

function statusOf(err: unknown): number | undefined {
  return typeof err === "object" && err !== null ? (err as { status?: number }).status : undefined;
}

/** Neutral colour for labels we create; maintainers can restyle them freely. */
const AUTO_LABEL_COLOR = "ededed";

/**
 * GitHub rejects adding a label that does not exist in the repository, which would
 * otherwise make triage look like it did nothing on a fresh repo. Create it once and
 * let the caller retry.
 */
async function ensureLabelExists(
  octokit: Octokit,
  ref: RepoRef,
  name: string,
  log: Logger,
): Promise<boolean> {
  try {
    await octokit.rest.issues.createLabel({
      owner: ref.owner,
      repo: ref.repo,
      name,
      color: AUTO_LABEL_COLOR,
      description: "Managed by jev-triage.",
    });
    log.info({ repo: repoFullName(ref), label: name }, "Created missing label");
    return true;
  } catch (err) {
    // 422 means it appeared between our check and the create; that is fine.
    if (statusOf(err) === 422) return true;
    log.warn({ err, label: name }, "Could not create label");
    return false;
  }
}

/**
 * Applies planned actions.
 *
 * Idempotency: labels already present are skipped, and bot comments are located by
 * their marker kind and updated in place, so re-triaging never piles up duplicates.
 * In dry-run mode nothing is written and every action is reported as skipped.
 */
export async function applyActions(
  octokit: Octokit,
  ref: RepoRef,
  item: PreprocessedItem,
  actions: PlannedAction[],
  options: ApplyOptions,
  log: Logger,
): Promise<AppliedAction[]> {
  const results: AppliedAction[] = [];
  const presentLabels = new Set(item.existingLabels);

  const commentCache = new Map<string, number | null>();
  const findExistingComment = async (kind: string): Promise<number | null> => {
    if (commentCache.has(kind)) return commentCache.get(kind) ?? null;
    try {
      const comments = await octokit.paginate(octokit.rest.issues.listComments, {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: item.number,
        per_page: 100,
      });
      const match = comments.find((comment) => {
        const isOurs = options.botLogin ? comment.user?.login === options.botLogin : true;
        return isOurs && parseMarker(comment.body, kind) !== null;
      });
      const id = match?.id ?? null;
      commentCache.set(kind, id);
      return id;
    } catch (err) {
      log.warn({ err }, "Could not list comments while checking idempotency");
      commentCache.set(kind, null);
      return null;
    }
  };

  for (const action of actions) {
    const record: AppliedAction = { action, applied: false, target: describeTarget(action) };

    if (options.dryRun) {
      record.skippedReason = "dry-run";
      results.push(record);
      continue;
    }

    try {
      switch (action.type) {
        case "add_label": {
          if (presentLabels.has(action.label)) {
            record.skippedReason = "label-already-present";
            break;
          }
          try {
            await octokit.rest.issues.addLabels({
              owner: ref.owner,
              repo: ref.repo,
              issue_number: item.number,
              labels: [action.label],
            });
          } catch (err) {
            // A 404 here usually means the label does not exist in this repository yet.
            if (statusOf(err) !== 404) throw err;
            if (!(await ensureLabelExists(octokit, ref, action.label, log))) throw err;
            await octokit.rest.issues.addLabels({
              owner: ref.owner,
              repo: ref.repo,
              issue_number: item.number,
              labels: [action.label],
            });
          }
          presentLabels.add(action.label);
          record.applied = true;
          break;
        }

        case "remove_label": {
          if (!presentLabels.has(action.label)) {
            record.skippedReason = "label-not-present";
            break;
          }
          await octokit.rest.issues.removeLabel({
            owner: ref.owner,
            repo: ref.repo,
            issue_number: item.number,
            name: action.label,
          });
          presentLabels.delete(action.label);
          record.applied = true;
          break;
        }

        case "comment": {
          const marker = buildMarker({ v: 1, kind: action.kind, runKey: options.runKey });
          const body = `${action.body}\n\n${marker}`;
          const existingId = await findExistingComment(action.kind);
          if (existingId !== null) {
            await octokit.rest.issues.updateComment({
              owner: ref.owner,
              repo: ref.repo,
              comment_id: existingId,
              body,
            });
            record.applied = true;
          } else {
            const created = await octokit.rest.issues.createComment({
              owner: ref.owner,
              repo: ref.repo,
              issue_number: item.number,
              body,
            });
            commentCache.set(action.kind, created.data.id);
            record.applied = true;
          }
          break;
        }

        case "close": {
          await octokit.rest.issues.update({
            owner: ref.owner,
            repo: ref.repo,
            issue_number: item.number,
            state: "closed",
            state_reason: "not_planned",
          });
          record.applied = true;
          break;
        }

        case "assign": {
          await octokit.rest.issues.addAssignees({
            owner: ref.owner,
            repo: ref.repo,
            issue_number: item.number,
            assignees: action.assignees,
          });
          record.applied = true;
          break;
        }

        case "notify": {
          const sent = await sendNotification(options.notify, action.message, log);
          record.applied = sent.slack || sent.discord || sent.telegram;
          if (!record.applied) {
            // Distinguish "nobody to tell" from "we tried and it failed" — conflating the
            // two sends you hunting through logs for a webhook that was never the problem.
            record.skippedReason = sent.attempted ? "notification-failed" : "no-webhook-configured";
          }
          break;
        }
      }
    } catch (err) {
      record.skippedReason = err instanceof Error ? err.message : "unknown-error";
      log.warn(
        { err, action: action.type, repo: repoFullName(ref), number: item.number },
        "Action failed",
      );
    }

    if (!record.applied && !record.skippedReason) {
      record.skippedReason = "not-applied";
    }
    results.push(record);
  }

  log.debug(
    { repo: repoFullName(ref), item: issueUrl(ref, item.number), results },
    "Actions processed",
  );

  return results;
}
