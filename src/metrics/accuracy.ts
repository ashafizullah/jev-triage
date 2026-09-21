import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { actions, corrections, predictions, triageRuns } from "../db/schema";

export interface CategoryAccuracy {
  category: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  support: number;
  precision: number;
  recall: number;
}

export interface AccuracyReport {
  repo: string;
  itemsTriaged: number;
  /** Runs that failed before producing a decision (Jev or GitHub error). */
  failedRuns: number;
  corrections: number;
  autoHandled: number;
  spamActioned: number;
  duplicatesFlagged: number;
  tokens: { runs: number; input: number; output: number; estimated: number };
  medianLatencyMs: number;
  categories: CategoryAccuracy[];
}

interface Labelled {
  /** Composite key that identifies an item across runs. */
  key: string;
  predicted: string;
  actual: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

/**
 * Builds the impact metrics from stored runs and maintainer corrections.
 *
 * Ground truth per item is the most recent correction when one exists, otherwise the
 * prediction is assumed correct. That makes precision/recall a lower bound: it can
 * only penalise the bot for corrections we actually observed.
 */
export function buildAccuracyReport(db: Db, repo: string): AccuracyReport {
  const allRuns = db.select().from(triageRuns).where(eq(triageRuns.repo, repo)).all();
  // Failed runs carry no predictions and a meaningless latency, so they stay out of every
  // statistic below and are reported separately instead.
  const runs = allRuns.filter((run) => run.status !== "error");
  const failedRuns = allRuns.length - runs.length;
  const predictionRows = db.select().from(predictions).all();
  const correctionRows = db.select().from(corrections).where(eq(corrections.repo, repo)).all();
  const actionRows = db.select().from(actions).where(eq(actions.repo, repo)).all();

  const runById = new Map(runs.map((run) => [run.id, run]));
  const runIds = new Set(runs.map((run) => run.id));

  const latestPrediction = new Map<string, { value: string; runId: number }>();
  for (const row of predictionRows) {
    if (!runIds.has(row.runId)) continue;
    if (row.questionId !== "category") continue;
    const run = runById.get(row.runId);
    if (!run) continue;
    const key = `${run.itemNumber}`;
    const existing = latestPrediction.get(key);
    if (!existing || row.runId > existing.runId) {
      latestPrediction.set(key, { value: row.value, runId: row.runId });
    }
  }

  const latestCorrection = new Map<string, { value: string | null; id: number }>();
  for (const row of correctionRows) {
    if (row.questionId !== "category") continue;
    const key = `${row.itemNumber}`;
    const existing = latestCorrection.get(key);
    if (!existing || row.id > existing.id) {
      latestCorrection.set(key, { value: row.corrected, id: row.id });
    }
  }

  const labelled: Labelled[] = [];
  for (const [key, prediction] of latestPrediction) {
    const correction = latestCorrection.get(key);
    const actual = correction?.value ?? prediction.value;
    labelled.push({ key, predicted: prediction.value, actual });
  }

  const allCategories = new Set<string>();
  for (const entry of labelled) {
    allCategories.add(entry.predicted);
    allCategories.add(entry.actual);
  }

  const categories: CategoryAccuracy[] = [...allCategories].sort().map((category) => {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;

    for (const entry of labelled) {
      const predictedIs = entry.predicted === category;
      const actualIs = entry.actual === category;
      if (predictedIs && actualIs) truePositives += 1;
      else if (predictedIs && !actualIs) falsePositives += 1;
      else if (!predictedIs && actualIs) falseNegatives += 1;
    }

    const precision =
      truePositives + falsePositives === 0 ? 0 : truePositives / (truePositives + falsePositives);
    const recall =
      truePositives + falseNegatives === 0 ? 0 : truePositives / (truePositives + falseNegatives);

    return {
      category,
      truePositives,
      falsePositives,
      falseNegatives,
      support: truePositives + falseNegatives,
      precision,
      recall,
    };
  });

  const spamActioned = actionRows.filter(
    (row) => row.target === "spam" || row.target === "possible-duplicate",
  ).length;

  const duplicatesFlagged = actionRows.filter(
    (row) => row.actionType === "add_label" && row.target === "possible-duplicate",
  ).length;

  const itemsWithCorrections = new Set(
    correctionRows.map((row) => row.itemNumber).filter((value) => typeof value === "number"),
  );

  return {
    repo,
    itemsTriaged: new Set(runs.map((run) => run.itemNumber)).size,
    failedRuns,
    corrections: itemsWithCorrections.size,
    autoHandled: actionRows.filter(
      (row) => row.applied && (row.actionType === "add_label" || row.actionType === "close"),
    ).length,
    spamActioned,
    duplicatesFlagged,
    tokens: {
      runs: runs.length,
      input: runs.reduce((sum, run) => sum + run.inputTokens, 0),
      output: runs.reduce((sum, run) => sum + run.outputTokens, 0),
      estimated: runs.reduce((sum, run) => sum + run.estimatedTokens, 0),
    },
    medianLatencyMs: median(runs.map((run) => run.latencyMs)),
    categories,
  };
}

export function formatAccuracyReport(report: AccuracyReport): string {
  const lines: string[] = [];
  lines.push(`Repo: ${report.repo}`);
  lines.push(`Items triaged: ${report.itemsTriaged}`);
  if (report.failedRuns > 0) {
    lines.push(`Runs that failed: ${report.failedRuns}`);
  }
  lines.push(`Items with maintainer corrections: ${report.corrections}`);
  lines.push(`Automated label/close actions applied: ${report.autoHandled}`);
  lines.push(`Duplicates flagged: ${report.duplicatesFlagged}`);
  lines.push(`Median triage latency: ${report.medianLatencyMs} ms`);
  lines.push(
    `Jev tokens: ${report.tokens.input} in / ${report.tokens.output} out across ${report.tokens.runs} runs (${report.tokens.estimated} estimated)`,
  );
  lines.push("");
  lines.push("category            precision  recall  support  tp  fp  fn");
  lines.push("------------------  ---------  ------  -------  --  --  --");
  for (const row of report.categories) {
    lines.push(
      `${row.category.padEnd(18)}  ${row.precision.toFixed(3).padStart(9)}  ${row.recall
        .toFixed(3)
        .padStart(
          6,
        )}  ${String(row.support).padStart(7)}  ${String(row.truePositives).padStart(2)}  ${String(
        row.falsePositives,
      ).padStart(2)}  ${String(row.falseNegatives).padStart(2)}`,
    );
  }
  return lines.join("\n");
}

export function reportToCsv(report: AccuracyReport): string {
  const header = "category,precision,recall,support,true_positives,false_positives,false_negatives";
  const rows = report.categories.map((row) =>
    [
      row.category,
      row.precision.toFixed(4),
      row.recall.toFixed(4),
      row.support,
      row.truePositives,
      row.falsePositives,
      row.falseNegatives,
    ].join(","),
  );
  return [header, ...rows].join("\n");
}
