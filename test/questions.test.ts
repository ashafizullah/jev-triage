import { describe, expect, it } from "vitest";
import {
  Q,
  buildDuplicateQuestions,
  buildTriageQuestions,
  parseDuplicateAnswers,
  parseTriageAnswers,
} from "../src/pipeline/jev/questions";

describe("buildTriageQuestions", () => {
  it("always asks the core questions", () => {
    const questions = buildTriageQuestions({
      labelShortlist: [],
      reviewerPool: [],
      suggestReviewers: false,
    });
    expect(Object.keys(questions)).toEqual(
      expect.arrayContaining([
        Q.category,
        Q.impact,
        Q.infoCompleteness,
        Q.spamPromotional,
        Q.spamOffTopic,
        Q.spamAbusive,
        Q.needsHumanReview,
      ]),
    );
    expect(questions[Q.extraLabel]).toBeUndefined();
    expect(questions[Q.reviewer]).toBeUndefined();
  });

  it("adds the extra-label question only when a shortlist exists", () => {
    const questions = buildTriageQuestions({
      labelShortlist: ["good first issue", "help wanted"],
      reviewerPool: [],
      suggestReviewers: false,
    });
    const extra = questions[Q.extraLabel];
    expect(extra?.type).toBe("choice");
    if (extra?.type === "choice") {
      expect(Object.keys(extra.criteria)).toEqual(["none", "good first issue", "help wanted"]);
    }
  });

  it("adds the reviewer question only when enabled", () => {
    const withoutReviewers = buildTriageQuestions({
      labelShortlist: [],
      reviewerPool: ["alice"],
      suggestReviewers: false,
    });
    expect(withoutReviewers[Q.reviewer]).toBeUndefined();

    const withReviewers = buildTriageQuestions({
      labelShortlist: [],
      reviewerPool: ["alice"],
      suggestReviewers: true,
    });
    expect(withReviewers[Q.reviewer]?.type).toBe("choice");
  });

  it("keeps the category criteria contrastive and in English", () => {
    const questions = buildTriageQuestions({
      labelShortlist: [],
      reviewerPool: [],
      suggestReviewers: false,
    });
    const category = questions[Q.category];
    expect(category?.type).toBe("choice");
    if (category?.type === "choice") {
      const bug = category.criteria.bug;
      expect(bug).toBeTruthy();
      expect(typeof bug).toBe("object");
      expect(Object.keys(bug as Record<string, unknown>)).toContain("what");
      expect(Object.keys(bug as Record<string, unknown>)).toContain("not_for");
    }
  });
});

describe("buildDuplicateQuestions", () => {
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    number: index + 1,
    title: `Candidate ${index + 1}`,
    body: "x".repeat(2_000),
  }));

  it("creates one numbered question per candidate", () => {
    const built = buildDuplicateQuestions(candidates, {
      titleChars: 200,
      excerptChars: 400,
      maxEstimatedTokens: 100_000,
    });
    expect(Object.keys(built.questions)).toHaveLength(8);
    expect(built.questions.dup_1?.type).toBe("noul");
    expect(built.truncated).toBe(false);
  });

  it("trims excerpts and drops candidates to respect the token budget", () => {
    const built = buildDuplicateQuestions(candidates, {
      titleChars: 200,
      excerptChars: 400,
      maxEstimatedTokens: 600,
    });
    expect(built.estimatedTokens).toBeLessThanOrEqual(600);
    expect(built.truncated).toBe(true);
    expect(built.used.length).toBeLessThan(8);
  });

  it("never drops the last candidate", () => {
    const built = buildDuplicateQuestions(candidates.slice(0, 1), {
      titleChars: 200,
      excerptChars: 400,
      maxEstimatedTokens: 1,
    });
    expect(built.used).toHaveLength(1);
  });
});

describe("parseTriageAnswers", () => {
  it("normalises a complete answer set", () => {
    const parsed = parseTriageAnswers({
      category: { type: "choice", choice: "bug", confidence: 0.9, probabilities: { bug: 0.9 } },
      impact: { type: "score", score: 1.5, confidence: 0.8, probabilities: { "1": 0.5 } },
      info_completeness: {
        type: "choice",
        choice: "missing_repro_steps",
        confidence: 0.7,
        probabilities: {},
      },
      spam_promotional: { type: "noul", noul: 0.1 },
      spam_off_topic: { type: "noul", noul: 0.2 },
      spam_abusive: { type: "noul", noul: 0.3 },
      needs_human_review: { type: "noul", noul: 0.4 },
    });

    expect(parsed.category.choice).toBe("bug");
    expect(parsed.impact.score).toBe(1.5);
    expect(parsed.infoCompleteness.choice).toBe("missing_repro_steps");
    expect(parsed.spam).toEqual({ promotional: 0.1, offTopic: 0.2, abusive: 0.3 });
    expect(parsed.needsHumanReview).toBe(0.4);
  });

  it("throws when a required answer is missing", () => {
    expect(() => parseTriageAnswers({ category: { choice: "bug", confidence: 1 } })).toThrow(
      /missing required answers/i,
    );
  });
});

describe("parseDuplicateAnswers", () => {
  it("maps answers back to candidate numbers and keeps the best", () => {
    const candidates = [
      { number: 11, title: "A", body: "" },
      { number: 22, title: "B", body: "" },
    ];
    const result = parseDuplicateAnswers(
      { dup_1: { noul: 0.3 }, dup_2: { noul: 0.88 } },
      candidates,
    );

    expect(result.bestNumber).toBe(22);
    expect(result.bestScore).toBeCloseTo(0.88);
    expect(result.candidates.map((entry) => entry.number)).toEqual([22, 11]);
  });

  it("returns an empty result when nothing matched", () => {
    const result = parseDuplicateAnswers({}, [{ number: 1, title: "A", body: "" }]);
    expect(result.bestNumber).toBeNull();
    expect(result.bestScore).toBe(0);
  });
});
