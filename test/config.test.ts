import { describe, expect, it } from "vitest";
import { loadConfigFromRepo, parseConfig } from "../src/config/load";
import { MAX_CHOICE_OPTIONS } from "../src/config/schema";
import { createMockOctokit } from "./helpers/mockOctokit";

describe("parseConfig", () => {
  it("returns the documented defaults for an empty config", () => {
    const { config, issues } = parseConfig({});
    expect(issues).toEqual([]);
    expect(config.enabled).toBe(true);
    expect(config.allowAutoClose).toBe(false);
    expect(config.suggestReviewers).toBe(false);
    // Left unset on purpose, so JEV_MODEL can act as the deployment-wide default.
    expect(config.model).toBeUndefined();
    expect(config.thresholds).toEqual({
      actMin: 0.6,
      autoCloseSpam: 0.9,
      duplicateLabel: 0.75,
      duplicateComment: 0.85,
      spamRisk: { low: 0.4, high: 0.6 },
      needsHumanReview: 0.5,
    });
    expect(config.duplicates.maxCandidates).toBe(6);
    expect(config.budget.candidateExcerptChars).toBe(400);
  });

  it("applies overrides", () => {
    const { config } = parseConfig({ allowAutoClose: true, thresholds: { actMin: 0.8 } });
    expect(config.allowAutoClose).toBe(true);
    expect(config.thresholds.actMin).toBe(0.8);
    // Untouched keys keep their defaults thanks to the deep merge in zod.
    expect(config.thresholds.duplicateLabel).toBe(0.75);
  });

  it("ignores unknown keys", () => {
    const { issues } = parseConfig({ somethingElse: true });
    expect(issues).toEqual([]);
  });

  it("reports validation problems and falls back to defaults", () => {
    const { config, issues } = parseConfig({ thresholds: { actMin: "high" } });
    expect(issues.length).toBeGreaterThan(0);
    expect(config.thresholds.actMin).toBe(0.6);
  });

  it("caps the label shortlist below the Choice option limit", () => {
    expect(MAX_CHOICE_OPTIONS).toBe(16);
  });
});

describe("loadConfigFromRepo", () => {
  const ref = { owner: "acme", repo: "demo" };

  it("falls back to defaults when no config file exists", async () => {
    const octokit = createMockOctokit({ configFile: null });
    const result = await loadConfigFromRepo(octokit as never, ref);
    expect(result.found).toBe(false);
    expect(result.config.dryRun).toBe(false);
  });

  it("reads and validates .github/jev-triage.yml", async () => {
    const octokit = createMockOctokit({
      configFile: ["dryRun: true", "thresholds:", "  actMin: 0.7"].join("\n"),
    });
    const result = await loadConfigFromRepo(octokit as never, ref);
    expect(result.found).toBe(true);
    expect(result.config.dryRun).toBe(true);
    expect(result.config.thresholds.actMin).toBe(0.7);
  });
});
