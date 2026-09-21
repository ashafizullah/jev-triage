import { desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { actions, corrections, predictions, triageRuns } from "../db/schema";
import { type AccuracyReport, buildAccuracyReport } from "./accuracy";

export interface RunRow {
  id: number;
  itemNumber: number;
  itemType: string;
  status: string;
  error: string | null;
  category: string;
  severity: string;
  info: string;
  spamRisk: string;
  gates: string[];
  dryRun: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  modelVersion: string | null;
  createdAt: string;
}

export interface CorrectionRow {
  itemNumber: number;
  questionId: string;
  predicted: string | null;
  corrected: string | null;
  actor: string | null;
  source: string;
  createdAt: string;
}

export interface ActionSummary {
  actionType: string;
  applied: number;
  total: number;
  skipped: { reason: string; count: number }[];
}

export interface ReportModel {
  repo: string;
  generatedAt: string;
  accuracy: AccuracyReport;
  modelVersions: string[];
  recentRuns: RunRow[];
  corrections: CorrectionRow[];
  actionSummary: ActionSummary[];
}

export interface BuildReportOptions {
  /** How many recent runs and corrections to include. */
  limit?: number;
}

function readGates(responseJson: string): string[] {
  try {
    const parsed = JSON.parse(responseJson) as { gates?: unknown };
    return Array.isArray(parsed.gates) ? parsed.gates.filter((g) => typeof g === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Assembles everything the report needs in one pass. Deliberately read-only: nothing
 * here touches GitHub or Jev, so a report can be generated at any time from the DB alone.
 */
export function buildReportModel(
  db: Db,
  repo: string,
  options: BuildReportOptions = {},
): ReportModel {
  const limit = options.limit ?? 25;

  const runRows = db
    .select()
    .from(triageRuns)
    .where(eq(triageRuns.repo, repo))
    .orderBy(desc(triageRuns.id))
    .limit(limit)
    .all();

  const runIds = runRows.map((run) => run.id);
  const predictionRows =
    runIds.length > 0
      ? db.select().from(predictions).where(inArray(predictions.runId, runIds)).all()
      : [];

  const byRun = new Map<number, Map<string, string>>();
  for (const row of predictionRows) {
    const bucket = byRun.get(row.runId) ?? new Map<string, string>();
    bucket.set(row.questionId, row.value);
    byRun.set(row.runId, bucket);
  }

  const recentRuns: RunRow[] = runRows.map((run) => {
    const answers = byRun.get(run.id) ?? new Map<string, string>();
    return {
      id: run.id,
      itemNumber: run.itemNumber,
      itemType: run.itemType,
      status: run.status,
      error: run.error,
      category: answers.get("category") ?? "-",
      severity: answers.get("severity") ?? "-",
      info: answers.get("info_completeness") ?? "-",
      spamRisk: answers.get("spam_risk") ?? "-",
      gates: readGates(run.responseJson),
      dryRun: run.dryRun,
      latencyMs: run.latencyMs,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      modelVersion: run.modelVersion,
      createdAt: run.createdAt,
    };
  });

  const correctionRows = db
    .select()
    .from(corrections)
    .where(eq(corrections.repo, repo))
    .orderBy(desc(corrections.id))
    .limit(limit)
    .all();

  const actionRows = db.select().from(actions).where(eq(actions.repo, repo)).all();
  const grouped = new Map<string, ActionSummary>();
  for (const row of actionRows) {
    const summary = grouped.get(row.actionType) ?? {
      actionType: row.actionType,
      applied: 0,
      total: 0,
      skipped: [],
    };
    summary.total += 1;
    if (row.applied) {
      summary.applied += 1;
    } else if (row.skippedReason) {
      const existing = summary.skipped.find((entry) => entry.reason === row.skippedReason);
      if (existing) existing.count += 1;
      else summary.skipped.push({ reason: row.skippedReason, count: 1 });
    }
    grouped.set(row.actionType, summary);
  }

  const modelVersions = [
    ...new Set(
      runRows.map((run) => run.modelVersion).filter((value): value is string => Boolean(value)),
    ),
  ];

  return {
    repo,
    generatedAt: new Date().toISOString(),
    accuracy: buildAccuracyReport(db, repo),
    modelVersions,
    recentRuns,
    corrections: correctionRows.map((row) => ({
      itemNumber: row.itemNumber,
      questionId: row.questionId,
      predicted: row.predicted,
      corrected: row.corrected,
      actor: row.actor,
      source: row.source,
      createdAt: row.createdAt,
    })),
    actionSummary: [...grouped.values()].sort(
      (a, b) => b.total - a.total || a.actionType.localeCompare(b.actionType),
    ),
  };
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function summaryCard(label: string, value: string | number): string {
  return `<div class="card"><div class="card-value">${escapeHtml(value)}</div><div class="card-label">${escapeHtml(label)}</div></div>`;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return `<p class="empty">No data yet.</p>`;
  }
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("\n");
  return `<table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

/**
 * Renders a fully self-contained HTML page: no scripts, no external assets, no network
 * requests. Everything is escaped, because issue content is attacker-controlled.
 */
export function renderHtmlReport(model: ReportModel): string {
  const { accuracy } = model;

  const categoryRows = [...accuracy.categories]
    .sort((a, b) => b.support - a.support || a.category.localeCompare(b.category))
    .map((row) => [
      escapeHtml(row.category),
      escapeHtml(percent(row.precision)),
      escapeHtml(percent(row.recall)),
      escapeHtml(row.support),
      escapeHtml(row.truePositives),
      escapeHtml(row.falsePositives),
      escapeHtml(row.falseNegatives),
    ]);

  const runRows = model.recentRuns.map((run) => {
    const mode =
      run.status === "error"
        ? `error: ${run.error ?? "unknown"}`
        : run.dryRun
          ? "dry-run"
          : "applied";
    return [
      `<a href="https://github.com/${escapeHtml(model.repo)}/issues/${escapeHtml(run.itemNumber)}">#${escapeHtml(run.itemNumber)}</a>`,
      escapeHtml(run.itemType === "pull_request" ? "PR" : "issue"),
      escapeHtml(run.category),
      escapeHtml(run.severity),
      escapeHtml(run.info),
      escapeHtml(run.gates.join(", ") || "—"),
      escapeHtml(mode),
      escapeHtml(`${run.latencyMs} ms`),
      escapeHtml(run.inputTokens + run.outputTokens),
      escapeHtml(run.createdAt),
    ];
  });

  const correctionRows = model.corrections.map((row) => [
    `#${escapeHtml(row.itemNumber)}`,
    escapeHtml(row.questionId),
    escapeHtml(row.predicted ?? "—"),
    escapeHtml(row.corrected ?? "(cleared)"),
    escapeHtml(row.actor ?? "—"),
    escapeHtml(row.source),
  ]);

  const actionRows = model.actionSummary.map((summary) => [
    escapeHtml(summary.actionType),
    escapeHtml(summary.applied),
    escapeHtml(summary.total),
    escapeHtml(
      summary.skipped
        .sort((a, b) => b.count - a.count)
        .map((entry) => `${entry.reason} ×${entry.count}`)
        .join(", ") || "—",
    ),
  ]);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>jev-triage report — ${escapeHtml(model.repo)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0 auto; max-width: 1100px; padding: 2rem 1rem 4rem; color: #1f2328; background: #fff; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .75rem; padding-bottom: .35rem; border-bottom: 1px solid #d8dee4; }
  .meta { color: #59636e; font-size: .85rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .75rem; margin: 1.5rem 0; }
  .card { border: 1px solid #d8dee4; border-radius: 8px; padding: .75rem 1rem; }
  .card-value { font-size: 1.35rem; font-weight: 600; }
  .card-label { color: #59636e; font-size: .8rem; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid #e6e9ed; vertical-align: top; }
  th { color: #59636e; font-weight: 600; white-space: nowrap; }
  .empty { color: #59636e; font-style: italic; }
  a { color: #0969da; text-decoration: none; }
  .warn { margin-top: 2.5rem; padding: .75rem 1rem; border-left: 3px solid #bf8700; background: #fff8c5;
          color: #4d2d00; font-size: .85rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    .card, th, td { border-color: #30363d; }
    .meta, .card-label, th, .empty { color: #8b949e; }
    a { color: #4493f8; }
    .warn { background: #2e2a12; color: #e3b341; border-color: #9e6a03; }
  }
</style>
</head>
<body>
<h1>jev-triage report</h1>
<p class="meta">${escapeHtml(model.repo)} · generated ${escapeHtml(model.generatedAt)}${model.modelVersions.length > 0 ? ` · model ${escapeHtml(model.modelVersions.join(", "))}` : ""}</p>

<div class="cards">
  ${summaryCard("Items triaged", accuracy.itemsTriaged)}
  ${summaryCard("Runs that failed", accuracy.failedRuns)}
  ${summaryCard("With corrections", accuracy.corrections)}
  ${summaryCard("Label/close actions applied", accuracy.autoHandled)}
  ${summaryCard("Duplicates flagged", accuracy.duplicatesFlagged)}
  ${summaryCard("Median latency", `${accuracy.medianLatencyMs} ms`)}
  ${summaryCard("Jev input tokens", accuracy.tokens.input)}
  ${summaryCard("Jev output tokens", accuracy.tokens.output)}
</div>

<h2>Category accuracy</h2>
<p class="meta">Uncorrected predictions count as correct, so these are a lower bound: the report can only penalise the bot for corrections you actually observed.</p>
${table(["Category", "Precision", "Recall", "Support", "TP", "FP", "FN"], categoryRows)}

<h2>Actions</h2>
${table(["Action", "Applied", "Total", "Skipped because"], actionRows)}

<h2>Recent runs</h2>
${table(
  ["Item", "Kind", "Category", "Severity", "Info", "Gates", "Mode", "Latency", "Tokens", "When"],
  runRows,
)}

<h2>Maintainer corrections</h2>
${table(["Item", "Question", "Predicted", "Corrected", "Actor", "Source"], correctionRows)}

<p class="warn"><strong>Do not publish this file.</strong> It contains issue numbers and decision
details from this repository. Keep it local, or share it only with people who already have access.</p>
</body>
</html>
`;
}
