import type { Context } from "probot";
import { loadConfig } from "../config/load";
import { CATEGORIES, type Category, type ItemType, type JevTriageConfig } from "../config/schema";
import { getDb } from "../db/client";
import { latestPrediction, latestRun, recordCorrection } from "../db/queries";
import { repoFullName } from "../github/types";
import { triageFromContext } from "./shared";

const COMMAND_RE = /^\/jev\s+([a-z-]+)(?:\s+(.*))?$/i;
const WRITE_PERMISSIONS = new Set(["admin", "write", "maintain"]);

function toCategory(value: string): Category | null {
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  return (CATEGORIES as readonly string[]).includes(normalized) ? (normalized as Category) : null;
}

async function hasWriteAccess(
  context: Context<"issue_comment.created">,
  login: string,
): Promise<boolean> {
  const { owner, repo } = context.repo();
  try {
    const { data } = await context.octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: login,
    });
    return WRITE_PERMISSIONS.has(data.permission);
  } catch {
    return false;
  }
}

async function reply(context: Context<"issue_comment.created">, body: string): Promise<void> {
  const { owner, repo } = context.repo();
  await context.octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: context.payload.issue.number,
    body,
  });
}

function categoryLabelFor(config: JevTriageConfig, category: Category): string {
  return config.labels.category[category];
}

async function applyCategoryCorrection(
  context: Context<"issue_comment.created">,
  config: JevTriageConfig,
  category: Category,
): Promise<string> {
  const { owner, repo } = context.repo();
  const { issue } = context.payload;
  const nextLabel = categoryLabelFor(config, category);
  const managed = new Set(
    Object.values(config.labels.category).map((label) => label.toLowerCase()),
  );

  for (const label of issue.labels) {
    const name = typeof label === "string" ? label : (label.name ?? "");
    if (name && managed.has(name.toLowerCase()) && name.toLowerCase() !== nextLabel.toLowerCase()) {
      await context.octokit.rest.issues
        .removeLabel({ owner, repo, issue_number: issue.number, name })
        .catch(() => undefined);
    }
  }

  await context.octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: issue.number,
    labels: [nextLabel],
  });

  return nextLabel;
}

function formatExplain(context: Context<"issue_comment.created">): string {
  const { owner, repo } = context.repo();
  const run = latestRun(getDb().db, repoFullName({ owner, repo }), context.payload.issue.number);
  if (!run) {
    return "I have no recorded triage run for this item yet.";
  }

  const rows = run.predictions
    .map((entry) => {
      const confidence = entry.confidence ? ` (${Number(entry.confidence).toFixed(2)})` : "";
      return `| ${entry.questionId} | ${entry.value}${confidence} |`;
    })
    .join("\n");

  return [
    `Last triage run #${run.id} at ${run.createdAt}${run.dryRun ? " (dry run)" : ""}.`,
    "",
    "| Question | Answer |",
    "| --- | --- |",
    rows,
    "",
    `Model: \`${run.modelVersion ?? run.model}\``,
  ].join("\n");
}

/**
 * Maintainer override channel. Only users with write access can change a decision,
 * and every correction is stored as ground truth for the accuracy report.
 */
export async function handleIssueComment(context: Context<"issue_comment.created">): Promise<void> {
  const { comment, issue } = context.payload;
  if (!comment.user || comment.user.type === "Bot") return;

  const match = COMMAND_RE.exec(comment.body.trim());
  if (!match) return;

  const command = (match[1] ?? "").toLowerCase();
  const argument = (match[2] ?? "").trim();
  const { owner, repo } = context.repo();
  const repoName = repoFullName({ owner, repo });
  const itemType: ItemType = issue.pull_request ? "pull_request" : "issue";

  if (!(await hasWriteAccess(context, comment.user.login))) {
    context.log.debug({ user: comment.user.login }, "Ignoring /jev command without write access");
    return;
  }

  const config = await loadConfig(context);
  const db = getDb().db;

  switch (command) {
    case "reclassify": {
      const category = toCategory(argument);
      if (!category) {
        await reply(
          context,
          `Unknown category \`${argument}\`. Valid values: ${CATEGORIES.join(", ")}.`,
        );
        return;
      }
      const predicted = latestPrediction(db, repoName, issue.number, "category");
      const label = await applyCategoryCorrection(context, config, category);
      recordCorrection(db, {
        repo: repoName,
        itemNumber: issue.number,
        questionId: "category",
        predicted,
        corrected: category,
        actor: comment.user.login,
        source: "command",
      });
      await reply(
        context,
        `Recorded category correction: \`${predicted ?? "unknown"}\` → \`${category}\`. Applied label \`${label}\`.`,
      );
      return;
    }

    case "not-duplicate": {
      const predicted = latestPrediction(db, repoName, issue.number, "duplicate");
      await context.octokit.rest.issues
        .removeLabel({
          owner,
          repo,
          issue_number: issue.number,
          name: config.labels.possibleDuplicate,
        })
        .catch(() => undefined);
      recordCorrection(db, {
        repo: repoName,
        itemNumber: issue.number,
        questionId: "duplicate",
        predicted,
        corrected: null,
        actor: comment.user.login,
        source: "command",
      });
      await reply(context, "Removed the possible-duplicate label and recorded the correction.");
      return;
    }

    case "retriage": {
      await reply(context, "Re-running triage now.");
      await triageFromContext(context, itemType, issue.number, "retriage");
      return;
    }

    case "explain": {
      await reply(context, formatExplain(context));
      return;
    }

    default: {
      await reply(
        context,
        [
          "Available commands:",
          "",
          "- `/jev reclassify <category>` — override the category",
          "- `/jev not-duplicate` — clear a duplicate suggestion",
          "- `/jev retriage` — run triage again",
          "- `/jev explain` — show the last decision and confidences",
        ].join("\n"),
      );
    }
  }
}
