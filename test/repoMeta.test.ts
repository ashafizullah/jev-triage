import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type JevTriageConfig } from "../src/config/schema";
import { fetchLabelShortlist, fetchReviewerPool, managedLabels } from "../src/pipeline/repoMeta";
import { createMockOctokit } from "./helpers/mockOctokit";

const ref = { owner: "acme", repo: "demo" };

function config(overrides: Partial<JevTriageConfig> = {}): JevTriageConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** The label set GitHub creates in a brand new repository. */
const GITHUB_DEFAULT_LABELS = [
  "bug",
  "documentation",
  "duplicate",
  "enhancement",
  "good first issue",
  "help wanted",
  "invalid",
  "question",
  "wontfix",
];

describe("managedLabels", () => {
  it("covers the category labels and every workflow label", () => {
    const labels = managedLabels(config());
    expect(labels).toContain("bug");
    expect(labels).toContain("documentation");
    expect(labels).toContain("needs-info");
    expect(labels).toContain("possible-duplicate");
    expect(labels).toContain("needs-triage");
    expect(labels).toContain("priority:critical");
  });
});

describe("fetchLabelShortlist", () => {
  it("offers only labels that do not collide with the ones the bot owns", async () => {
    const octokit = createMockOctokit({
      repoLabels: GITHUB_DEFAULT_LABELS.map((name) => ({ name })),
    });

    const shortlist = await fetchLabelShortlist(octokit as never, ref, config());

    // Useful, non-conflicting suggestions survive.
    expect(shortlist).toContain("good first issue");
    expect(shortlist).toContain("help wanted");
    expect(shortlist).toContain("wontfix");
    expect(shortlist).toContain("invalid");

    // Exact matches for managed labels are dropped.
    expect(shortlist).not.toContain("bug");
    expect(shortlist).not.toContain("documentation");
    expect(shortlist).not.toContain("question");
    expect(shortlist).not.toContain("enhancement");

    // `duplicate` reads as our `possible-duplicate`, so it must not be offered:
    // applying both would put two contradictory labels on the same item.
    expect(shortlist).not.toContain("duplicate");
  });

  it("drops labels that only share a word with a managed label", async () => {
    const octokit = createMockOctokit({
      repoLabels: [
        { name: "needs-info" },
        { name: "info" },
        { name: "critical" },
        { name: "triage" },
      ],
    });

    const shortlist = await fetchLabelShortlist(octokit as never, ref, config());
    expect(shortlist).toEqual([]);
  });

  it("honours the configured shortlist size", async () => {
    const octokit = createMockOctokit({
      repoLabels: ["a-label", "b-label", "c-label"].map((name) => ({ name })),
    });

    const shortlist = await fetchLabelShortlist(
      octokit as never,
      ref,
      config({ duplicates: { ...DEFAULT_CONFIG.duplicates, labelShortlistSize: 2 } }),
    );
    expect(shortlist).toHaveLength(2);
  });

  it("returns an empty list when the API fails", async () => {
    const octokit = createMockOctokit();
    octokit.paginate = async () => {
      throw new Error("boom");
    };

    expect(await fetchLabelShortlist(octokit as never, ref, config())).toEqual([]);
  });
});

describe("fetchReviewerPool", () => {
  it("prefers an explicitly configured pool", async () => {
    const octokit = createMockOctokit({ contributors: [{ login: "discovered" }] });
    const pool = await fetchReviewerPool(
      octokit as never,
      ref,
      config({ reviewerPool: ["alice", "bob"] }),
    );
    expect(pool).toEqual(["alice", "bob"]);
  });

  it("falls back to recent contributors", async () => {
    const octokit = createMockOctokit({
      contributors: [{ login: "alice" }, { login: "bob" }],
    });
    expect(await fetchReviewerPool(octokit as never, ref, config())).toEqual(["alice", "bob"]);
  });

  it("returns an empty list when discovery fails", async () => {
    const octokit = createMockOctokit();
    octokit.rest.repos.listContributors = async () => {
      throw new Error("boom");
    };
    expect(await fetchReviewerPool(octokit as never, ref, config())).toEqual([]);
  });
});
