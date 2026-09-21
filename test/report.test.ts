import { beforeEach, describe, expect, it } from "vitest";
import { type DbHandle, createDb } from "../src/db/client";
import { actions, corrections, predictions, triageRuns } from "../src/db/schema";
import { buildReportModel, escapeHtml, renderHtmlReport } from "../src/metrics/report";

const repo = "acme/demo";
let handle: DbHandle;

beforeEach(() => {
  handle = createDb(":memory:");
});

function seedRun(options: {
  itemNumber: number;
  category: string;
  gates: string[];
  dryRun?: boolean;
  modelVersion?: string | null;
}): number {
  const inserted = handle.db
    .insert(triageRuns)
    .values({
      repo,
      itemNumber: options.itemNumber,
      itemType: "issue",
      model: "jev-latest",
      modelVersion: options.modelVersion ?? "jev-1.13.0",
      stateHash: `hash-${options.itemNumber}`,
      requestJson: "{}",
      responseJson: JSON.stringify({ answers: {}, duplicate: null, gates: options.gates }),
      latencyMs: 250,
      inputTokens: 1000,
      outputTokens: 50,
      estimatedTokens: 1200,
      status: "ok",
      dryRun: options.dryRun ?? false,
      createdAt: new Date().toISOString(),
    })
    .run();

  const runId = Number(inserted.lastInsertRowid);
  handle.db
    .insert(predictions)
    .values([
      {
        runId,
        questionId: "category",
        kind: "choice",
        value: options.category,
        confidence: "0.9",
        createdAt: new Date().toISOString(),
      },
      {
        runId,
        questionId: "severity",
        kind: "composite",
        value: "medium",
        confidence: "0.9",
        createdAt: new Date().toISOString(),
      },
      {
        runId,
        questionId: "info_completeness",
        kind: "choice",
        value: "complete",
        confidence: "0.9",
        createdAt: new Date().toISOString(),
      },
      {
        runId,
        questionId: "spam_risk",
        kind: "composite",
        value: "0.0500",
        confidence: null,
        createdAt: new Date().toISOString(),
      },
    ])
    .run();

  return runId;
}

describe("escapeHtml", () => {
  it("neutralises anything that could break out of the document", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("renders null and undefined as empty", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("buildReportModel", () => {
  it("returns an empty model for a repository with no history", () => {
    const model = buildReportModel(handle.db, repo);
    expect(model.accuracy.itemsTriaged).toBe(0);
    expect(model.recentRuns).toEqual([]);
    expect(model.corrections).toEqual([]);
    expect(model.actionSummary).toEqual([]);
    expect(model.modelVersions).toEqual([]);
  });

  it("joins runs with their predictions and stored gates", () => {
    seedRun({ itemNumber: 1, category: "bug", gates: ["severity-critical"] });
    seedRun({ itemNumber: 2, category: "spam", gates: ["spam", "spam-needs-review"] });

    const model = buildReportModel(handle.db, repo);

    expect(model.recentRuns).toHaveLength(2);
    // Newest first.
    expect(model.recentRuns[0]?.itemNumber).toBe(2);
    expect(model.recentRuns[0]?.category).toBe("spam");
    expect(model.recentRuns[0]?.gates).toEqual(["spam", "spam-needs-review"]);
    expect(model.recentRuns[0]?.severity).toBe("medium");
    expect(model.modelVersions).toEqual(["jev-1.13.0"]);
  });

  it("tolerates a response payload without gates", () => {
    handle.db
      .insert(triageRuns)
      .values({
        repo,
        itemNumber: 9,
        itemType: "issue",
        model: "jev-latest",
        stateHash: "h",
        requestJson: "{}",
        responseJson: JSON.stringify({ answers: {} }),
        status: "ok",
        createdAt: new Date().toISOString(),
      })
      .run();

    expect(buildReportModel(handle.db, repo).recentRuns[0]?.gates).toEqual([]);
  });

  it("summarises actions with their skip reasons", () => {
    const runId = seedRun({ itemNumber: 1, category: "bug", gates: [] });
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
          target: "needs-info",
          payloadJson: "{}",
          applied: false,
          skippedReason: "label-already-present",
          createdAt: new Date().toISOString(),
        },
      ])
      .run();

    const summary = buildReportModel(handle.db, repo).actionSummary.find(
      (entry) => entry.actionType === "add_label",
    );
    expect(summary).toMatchObject({ applied: 1, total: 2 });
    expect(summary?.skipped).toEqual([{ reason: "label-already-present", count: 1 }]);
  });

  it("lists corrections", () => {
    handle.db
      .insert(corrections)
      .values({
        repo,
        itemNumber: 3,
        questionId: "category",
        predicted: "docs",
        corrected: "bug",
        actor: "maintainer",
        source: "command",
        createdAt: new Date().toISOString(),
      })
      .run();

    const model = buildReportModel(handle.db, repo);
    expect(model.corrections[0]).toMatchObject({
      itemNumber: 3,
      predicted: "docs",
      corrected: "bug",
      actor: "maintainer",
    });
  });

  it("honours the limit", () => {
    seedRun({ itemNumber: 1, category: "bug", gates: [] });
    seedRun({ itemNumber: 2, category: "bug", gates: [] });
    seedRun({ itemNumber: 3, category: "bug", gates: [] });

    expect(buildReportModel(handle.db, repo, { limit: 2 }).recentRuns).toHaveLength(2);
  });
});

describe("renderHtmlReport", () => {
  it("produces a self-contained page with no scripts or external requests", () => {
    seedRun({ itemNumber: 7, category: "bug", gates: ["severity-critical"] });
    const html = renderHtmlReport(buildReportModel(handle.db, repo));

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/src="http/);
    expect(html).not.toMatch(/href="http(?!s:\/\/github\.com)/);
    // Inline styling only, so the file works offline.
    expect(html).toContain("<style>");
  });

  it("includes the figures a maintainer cares about", () => {
    seedRun({ itemNumber: 7, category: "bug", gates: ["severity-critical"] });
    const html = renderHtmlReport(buildReportModel(handle.db, repo));

    expect(html).toContain("acme/demo");
    expect(html).toContain("Jev input tokens");
    expect(html).toContain("Category accuracy");
    expect(html).toContain("#7");
    expect(html).toContain("severity-critical");
  });

  it("escapes content that comes from issue text", () => {
    handle.db
      .insert(corrections)
      .values({
        repo,
        itemNumber: 1,
        questionId: "category",
        predicted: "<img src=x onerror=alert(1)>",
        corrected: "</td></tr><script>alert(1)</script>",
        actor: "<b>attacker</b>",
        source: "command",
        createdAt: new Date().toISOString(),
      })
      .run();

    const html = renderHtmlReport(buildReportModel(handle.db, repo));

    // Nothing from the database may arrive as live markup.
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<b>attacker</b>");

    // ...and the escaped form is what actually made it into the page.
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&lt;b&gt;attacker&lt;/b&gt;");
    expect(html).toContain("&lt;/td&gt;&lt;/tr&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("says so when there is nothing to show", () => {
    const html = renderHtmlReport(buildReportModel(handle.db, repo));
    expect(html).toContain("No data yet.");
  });
});
