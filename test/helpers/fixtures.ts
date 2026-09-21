import type { DuplicateResult, TriageAnswers } from "../../src/pipeline/jev/types";
import type { PreprocessedItem } from "../../src/pipeline/preprocess";

export function makeItem(overrides: Partial<PreprocessedItem> = {}): PreprocessedItem {
  return {
    type: "issue",
    number: 42,
    title: "Crash when saving a document",
    body: "Opening a document and pressing save crashes the app.",
    url: "https://github.com/acme/demo/issues/42",
    createdAt: "2026-09-01T00:00:00Z",
    author: { login: "reporter", association: "NONE", isFirstTimeContributor: true },
    existingLabels: [],
    isDraft: false,
    diff: null,
    ...overrides,
  };
}

export function makeAnswers(overrides: Partial<TriageAnswers> = {}): TriageAnswers {
  return {
    category: { choice: "bug", confidence: 0.95, probabilities: { bug: 0.95 } },
    impact: { score: 2, confidence: 0.9, probabilities: { "2": 0.9 } },
    infoCompleteness: { choice: "complete", confidence: 0.9, probabilities: { complete: 0.9 } },
    spam: { promotional: 0.02, offTopic: 0.02, abusive: 0.01 },
    needsHumanReview: 0.05,
    extraLabel: null,
    reviewer: null,
    ...overrides,
  };
}

export function makeDuplicate(overrides: Partial<DuplicateResult> = {}): DuplicateResult {
  return {
    bestScore: 0,
    bestNumber: null,
    candidates: [],
    ...overrides,
  };
}
