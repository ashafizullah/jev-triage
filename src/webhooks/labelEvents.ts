import type { Context } from "probot";
import { loadConfig } from "../config/load";
import { getDb } from "../db/client";
import { recordCorrection } from "../db/queries";
import { repoFullName } from "../github/types";
import { managedLabels } from "../pipeline/repoMeta";

/**
 * When a human removes a label the bot applied, that is a correction. We record it
 * as ground truth so the accuracy report can measure how often the bot was wrong.
 */
export async function handleIssueUnlabeled(context: Context<"issues.unlabeled">): Promise<void> {
  const { label, issue, sender } = context.payload;
  if (!label || sender?.type === "Bot") return;

  const { owner, repo } = context.repo();
  const config = await loadConfig(context);
  const lower = label.name.toLowerCase();

  if (!managedLabels(config).some((name) => name.toLowerCase() === lower)) return;

  const categoryByLabel = new Map(
    Object.entries(config.labels.category).map(([category, name]) => [
      name.toLowerCase(),
      category,
    ]),
  );

  const category = categoryByLabel.get(lower);
  const questionId = category
    ? "category"
    : lower === config.labels.needsInfo.toLowerCase()
      ? "info_completeness"
      : lower === config.labels.possibleDuplicate.toLowerCase()
        ? "duplicate"
        : lower === config.labels.needsTriage.toLowerCase()
          ? "needs_triage"
          : "label";

  recordCorrection(getDb().db, {
    repo: repoFullName({ owner, repo }),
    itemNumber: issue.number,
    questionId,
    predicted: category ?? label.name,
    corrected: null,
    actor: sender?.login ?? null,
    source: "label_change",
  });

  context.log.debug(
    { label: label.name, questionId, number: issue.number },
    "Recorded label correction",
  );
}
