import { describe, expect, it } from "vitest";
import { fetchCandidates } from "../src/pipeline/candidates";
import { createMockOctokit } from "./helpers/mockOctokit";

const ref = { owner: "acme", repo: "demo" };

function candidate(number: number, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Item ${number}`,
    body: "",
    state: "open",
    created_at: createdAt,
    ...extra,
  };
}

describe("fetchCandidates", () => {
  it("skips the item being triaged", async () => {
    const octokit = createMockOctokit({
      candidateItems: [candidate(1, "2026-01-01T00:00:00Z"), candidate(2, "2026-01-02T00:00:00Z")],
    });

    const result = await fetchCandidates(octokit as never, ref, {
      excludeNumber: 1,
      type: "issue",
      poolSize: 50,
      state: "open",
    });

    expect(result.map((item) => item.number)).toEqual([2]);
  });

  it("drops newer items so a duplicate never points forward in time", async () => {
    const octokit = createMockOctokit({
      candidateItems: [
        candidate(1, "2026-01-01T00:00:00Z"),
        candidate(2, "2026-06-01T00:00:00Z"),
        candidate(3, "2026-01-02T00:00:00Z"),
      ],
    });

    const result = await fetchCandidates(octokit as never, ref, {
      excludeNumber: 9,
      type: "issue",
      poolSize: 50,
      state: "open",
      excludeCreatedAtOrAfter: "2026-03-01T00:00:00Z",
    });

    expect(result.map((item) => item.number)).toEqual([1, 3]);
  });

  it("keeps everything when no cutoff is given", async () => {
    const octokit = createMockOctokit({
      candidateItems: [candidate(1, "2026-01-01T00:00:00Z"), candidate(2, "2026-06-01T00:00:00Z")],
    });

    const result = await fetchCandidates(octokit as never, ref, {
      excludeNumber: 9,
      type: "issue",
      poolSize: 50,
      state: "open",
    });

    expect(result).toHaveLength(2);
  });

  it("only compares items of the same kind", async () => {
    const octokit = createMockOctokit({
      candidateItems: [
        candidate(1, "2026-01-01T00:00:00Z"),
        candidate(2, "2026-01-02T00:00:00Z", { pull_request: { url: "https://example.com" } }),
      ],
    });

    const issues = await fetchCandidates(octokit as never, ref, {
      excludeNumber: 9,
      type: "issue",
      poolSize: 50,
      state: "open",
    });
    const pulls = await fetchCandidates(octokit as never, ref, {
      excludeNumber: 9,
      type: "pull_request",
      poolSize: 50,
      state: "open",
    });

    expect(issues.map((item) => item.number)).toEqual([1]);
    expect(pulls.map((item) => item.number)).toEqual([2]);
  });

  it("caps the page size at 100", async () => {
    const octokit = createMockOctokit();
    await fetchCandidates(octokit as never, ref, {
      excludeNumber: 9,
      type: "issue",
      poolSize: 500,
      state: "all",
    });

    const call = octokit.state.calls.find((entry) => entry.method === "issues.listForRepo");
    expect(call?.params.per_page).toBe(100);
    expect(call?.params.state).toBe("all");
  });
});
