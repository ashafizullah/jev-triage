import { desc, eq } from "drizzle-orm";
import type { Db } from "./client";
import { corrections, predictions, triageRuns } from "./schema";

export interface CorrectionInput {
  repo: string;
  itemNumber: number;
  questionId: string;
  predicted: string | null;
  corrected: string | null;
  actor: string | null;
  source: "command" | "label_change";
}

export function recordCorrection(db: Db, input: CorrectionInput): void {
  db.insert(corrections)
    .values({ ...input, createdAt: new Date().toISOString() })
    .run();
}

export interface RunSummary {
  id: number;
  createdAt: string;
  model: string;
  modelVersion: string | null;
  dryRun: boolean;
  predictions: Array<{ questionId: string; value: string; confidence: string | null }>;
}

/** Most recent triage run for an item, used by the `/jev explain` command. */
export function latestRun(db: Db, repo: string, itemNumber: number): RunSummary | null {
  const run = db
    .select()
    .from(triageRuns)
    .where(eq(triageRuns.repo, repo))
    .orderBy(desc(triageRuns.id))
    .all()
    .find((row) => row.itemNumber === itemNumber);

  if (!run) return null;

  const rows = db.select().from(predictions).where(eq(predictions.runId, run.id)).all();

  return {
    id: run.id,
    createdAt: run.createdAt,
    model: run.model,
    modelVersion: run.modelVersion,
    dryRun: run.dryRun,
    predictions: rows.map((row) => ({
      questionId: row.questionId,
      value: row.value,
      confidence: row.confidence,
    })),
  };
}

/** Latest predicted value for one question, used to diff against a correction. */
export function latestPrediction(
  db: Db,
  repo: string,
  itemNumber: number,
  questionId: string,
): string | null {
  const run = latestRun(db, repo, itemNumber);
  if (!run) return null;
  const match = run.predictions.find((row) => row.questionId === questionId);
  return match?.value ?? null;
}
