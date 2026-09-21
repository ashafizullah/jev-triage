import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  jaccard,
  rankCandidates,
  tokenize,
  trigrams,
} from "../src/pipeline/similarity";

describe("tokenize", () => {
  it("lowercases, strips punctuation and drops stopwords", () => {
    const tokens = tokenize("The App crashes when I SAVE a document!!");
    expect(tokens).toContain("crashes");
    expect(tokens).toContain("save");
    expect(tokens).toContain("document");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("when");
    // Two-character words fall below the minimum token length.
    expect(tokens).not.toContain("a");
    expect(tokens).not.toContain("i");
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for parallel vectors and 0 for disjoint ones", () => {
    const a = new Map([
      ["save", 2],
      ["crash", 1],
    ]);
    const b = new Map([
      ["save", 4],
      ["crash", 2],
    ]);
    const c = new Map([["network", 1]]);

    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
    expect(cosineSimilarity(a, c)).toBe(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity(new Map(), new Map([["x", 1]]))).toBe(0);
  });
});

describe("trigrams and jaccard", () => {
  it("measures overlap between similar strings", () => {
    const a = trigrams("crash when saving");
    const b = trigrams("crash when saving a file");
    expect(jaccard(a, b)).toBeGreaterThan(0.5);
    expect(jaccard(a, trigrams("completely different words"))).toBe(0);
  });
});

describe("rankCandidates", () => {
  const query = {
    title: "Crash when saving a document",
    body: "Opening a document and pressing save crashes the app immediately.",
  };

  const candidates = [
    { number: 7, title: "Add dark mode", body: "It would be nice to have a dark theme." },
    {
      number: 12,
      title: "App crashes on save",
      body: "Pressing save on any document crashes the app immediately.",
    },
    { number: 30, title: "Update dependencies", body: "Bump react to the latest version." },
  ];

  it("ranks the closest match first", () => {
    const ranked = rankCandidates(query, candidates, 3);
    expect(ranked[0]?.candidate.number).toBe(12);
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });

  it("returns at most topK results", () => {
    expect(rankCandidates(query, candidates, 2)).toHaveLength(2);
  });

  it("handles an empty candidate list and a zero limit", () => {
    expect(rankCandidates(query, [], 5)).toEqual([]);
    expect(rankCandidates(query, candidates, 0)).toEqual([]);
  });

  it("is deterministic for ties", () => {
    const tied = [
      { number: 1, title: "same", body: "same" },
      { number: 2, title: "same", body: "same" },
    ];
    const first = rankCandidates({ title: "same", body: "same" }, tied, 2).map(
      (entry) => entry.candidate.number,
    );
    const second = rankCandidates({ title: "same", body: "same" }, tied, 2).map(
      (entry) => entry.candidate.number,
    );
    expect(first).toEqual(second);
  });
});
