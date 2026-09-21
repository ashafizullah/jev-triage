import { beforeEach, describe, expect, it } from "vitest";
import { type DbHandle, createDb } from "../src/db/client";
import { actions, corrections, predictions, triageRuns } from "../src/db/schema";
import { buildAccuracyReport, reportToCsv } from "../src/metrics/accuracy";

const repo = "acme/demo";
let handle: DbHandle;

beforeEach(() => {
  handle = createDb(":memory:");
});

function addRun(itemNumber: number, category: string, latencyMs = 100): number {
  const inserted = handle.db
    .insert(triageRuns)
    .values({
      repo,
      itemNumber,
      itemType: "issue",
      model: "jev-latest",
      modelVersion: "jev-test",
      stateHash: `hash-${itemNumber}`,
      requestJson: "{}",
      responseJson: "{}",
      latencyMs,
      inputTokens: 100,
      outputTokens: 10,
      estimatedTokens: 200,
      status: "ok",
      createdAt: new Date().toISOString(),
    })
    .run();
  const runId = Number(inserted.lastInsertRowid);
  handle.db
    .insert(predictions)
    .values({
      runId,
      questionId: "category",
      kind: "choice",
      value: category,
      confidence: "0.9",
      createdAt: new Date().toISOString(),
    })
    .run();
  return runId;
}

describe("buildAccuracyReport", () => {
  it("treats uncorrected predictions as correct", () => {
    addRun(1, "bug");
    addRun(2, "bug");
    const report = buildAccuracyReport(handle.db, repo);

    const bug = report.categories.find((row) => row.category === "bug");
    expect(bug?.truePositives).toBe(2);
    expect(bug?.precision).toBe(1);
    expect(bug?.recall).toBe(1);
    expect(report.corrections).toBe(0);
    expect(report.itemsTriaged).toBe(2);
  });

  it("uses the latest correction as ground truth", () => {
    addRun(1, "bug");
    addRun(2, "feature_request");
    handle.db
      .insert(corrections)
      .values({
        repo,
        itemNumber: 1,
        questionId: "category",
        predicted: "bug",
        corrected: "feature_request",
        actor: "maintainer",
        source: "command",
        createdAt: new Date().toISOString(),
      })
      .run();

    const report = buildAccuracyReport(handle.db, repo);
    const bug = report.categories.find((row) => row.category === "bug");
    const feature = report.categories.find((row) => row.category === "feature_request");

    // Item 1: predicted bug, actually feature_request -> one FP for bug, one FN for feature.
    expect(bug?.falsePositives).toBe(1);
    expect(bug?.truePositives).toBe(0);
    expect(feature?.falseNegatives).toBe(1);
    expect(feature?.truePositives).toBe(1);
    expect(feature?.precision).toBe(1);
    expect(feature?.recall).toBe(0.5);
    expect(report.corrections).toBe(1);
  });

  it("summarises tokens, latency and applied actions", () => {
    const runId = addRun(1, "bug", 250);
    handle.db
      .insert(actions)
      .values([
        {
          runId,
          repo,
          itemNumber: 1,
          actionType: "add_label",
          target: "bug",
          payloadJson: "{}",
          applied: true,
          createdAt: new Date().toISOString(),
        },
        {
          runId,
          repo,
          itemNumber: 1,
          actionType: "add_label",
          target: "possible-duplicate",
          payloadJson: "{}",
          applied: true,
          createdAt: new Date().toISOString(),
        },
      ])
      .run();

    const report = buildAccuracyReport(handle.db, repo);
    expect(report.tokens.input).toBe(100);
    expect(report.tokens.runs).toBe(1);
    expect(report.medianLatencyMs).toBe(250);
    expect(report.duplicatesFlagged).toBe(1);
    expect(report.autoHandled).toBe(2);
  });

  it("reports an empty state without failing", () => {
    const report = buildAccuracyReport(handle.db, repo);
    expect(report.itemsTriaged).toBe(0);
    expect(report.categories).toEqual([]);
    expect(report.medianLatencyMs).toBe(0);
  });

  it("emits a CSV with one row per category", () => {
    addRun(1, "bug");
    const csv = reportToCsv(buildAccuracyReport(handle.db, repo));
    const lines = csv.split("\n");
    expect(lines[0]).toContain("category,precision,recall");
    expect(lines[1]).toContain("bug");
  });
});
