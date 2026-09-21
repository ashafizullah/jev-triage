import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type JevTriageConfig } from "../src/config/schema";
import {
  type Decision,
  type PlannedAction,
  computeSpamRisk,
  decide,
  impactScoreToSeverity,
} from "../src/pipeline/decide";
import { makeAnswers, makeDuplicate, makeItem } from "./helpers/fixtures";

function labelsOf(decision: Decision): string[] {
  return decision.actions
    .filter(
      (action): action is Extract<PlannedAction, { type: "add_label" }> =>
        action.type === "add_label",
    )
    .map((action) => action.label);
}

function run(
  answers: Parameters<typeof decide>[0]["answers"],
  options: {
    config?: Partial<JevTriageConfig>;
    duplicate?: Parameters<typeof decide>[0]["duplicate"];
    item?: Parameters<typeof decide>[0]["item"];
  } = {},
): Decision {
  return decide({
    item: options.item ?? makeItem(),
    config: { ...DEFAULT_CONFIG, ...options.config },
    answers,
    duplicate: options.duplicate ?? null,
  });
}

describe("impactScoreToSeverity", () => {
  it("rounds the fractional score onto the severity ladder", () => {
    expect(impactScoreToSeverity(0)).toBe("low");
    expect(impactScoreToSeverity(0.4)).toBe("low");
    expect(impactScoreToSeverity(1.4)).toBe("medium");
    // Half steps round up, so a borderline report errs toward escalation.
    expect(impactScoreToSeverity(1.5)).toBe("high");
    expect(impactScoreToSeverity(2.5)).toBe("critical");
    expect(impactScoreToSeverity(99)).toBe("critical");
  });
});

describe("computeSpamRisk", () => {
  it("weights the individual signals and normalises to 0..1", () => {
    const risk = computeSpamRisk(
      { promotional: 1, offTopic: 1, abusive: 1 },
      DEFAULT_CONFIG.spamWeights,
    );
    expect(risk).toBeCloseTo(1);
  });

  it("is zero when every signal is zero", () => {
    expect(
      computeSpamRisk({ promotional: 0, offTopic: 0, abusive: 0 }, DEFAULT_CONFIG.spamWeights),
    ).toBe(0);
  });
});

describe("decide — confidence gating", () => {
  it("routes to a human when category confidence is below actMin", () => {
    const decision = run(
      makeAnswers({
        category: { choice: "bug", confidence: 0.4, probabilities: { bug: 0.4 } },
      }),
    );
    expect(labelsOf(decision)).toEqual([DEFAULT_CONFIG.labels.needsTriage]);
    expect(decision.rationale.gates).toContain("low-category-confidence");
    expect(decision.actions.some((action) => action.type === "close")).toBe(false);
  });

  it("routes to a human when the model asks for one", () => {
    const decision = run(makeAnswers({ needsHumanReview: 0.9 }));
    expect(labelsOf(decision)).toEqual([DEFAULT_CONFIG.labels.needsTriage]);
    expect(decision.rationale.gates).toContain("needs-human-review");
  });

  it("routes to a human when spam risk sits in the uncertain band", () => {
    const decision = run(makeAnswers({ spam: { promotional: 0.5, offTopic: 0.5, abusive: 0.5 } }));
    expect(decision.rationale.spamRisk).toBeCloseTo(0.5, 2);
    expect(labelsOf(decision)).toEqual([DEFAULT_CONFIG.labels.needsTriage]);
    expect(decision.rationale.gates).toContain("spam-risk-uncertain");
  });

  it("still asks for missing detail when routing to a human", () => {
    const decision = run(
      makeAnswers({
        needsHumanReview: 0.68,
        infoCompleteness: {
          choice: "missing_repro_steps",
          confidence: 0.97,
          probabilities: {},
        },
      }),
    );

    // A vague report is exactly the one that needs a nudge, so routing to a human must
    // not silence the information request.
    expect(labelsOf(decision)).toContain(DEFAULT_CONFIG.labels.needsTriage);
    expect(labelsOf(decision)).toContain(DEFAULT_CONFIG.labels.needsInfo);
    const comment = decision.actions.find(
      (action) => action.type === "comment" && action.kind === "triage",
    );
    expect(comment && comment.type === "comment" ? comment.body : "").toMatch(/reproduce/i);
  });

  it("stays silent on the human-review path when there is nothing to ask for", () => {
    const decision = run(makeAnswers({ needsHumanReview: 0.9 }));
    expect(labelsOf(decision)).toEqual([DEFAULT_CONFIG.labels.needsTriage]);
    expect(decision.actions.some((action) => action.type === "comment")).toBe(false);
  });
});

describe("decide — categories are mutually exclusive", () => {
  function removalsOf(decision: Decision): string[] {
    return decision.actions
      .filter(
        (action): action is Extract<PlannedAction, { type: "remove_label" }> =>
          action.type === "remove_label",
      )
      .map((action) => action.label);
  }

  it("drops the previous category label when the category changes", () => {
    const decision = run(makeAnswers(), {
      item: makeItem({ existingLabels: ["documentation", "priority:critical"] }),
    });

    expect(removalsOf(decision)).toEqual(["documentation"]);
    expect(labelsOf(decision)).toContain(DEFAULT_CONFIG.labels.category.bug);
  });

  it("leaves the label alone when the category is unchanged", () => {
    const decision = run(makeAnswers(), {
      item: makeItem({ existingLabels: ["bug"] }),
    });

    expect(removalsOf(decision)).toEqual([]);
  });

  it("never removes labels the bot does not own", () => {
    const decision = run(makeAnswers(), {
      item: makeItem({
        existingLabels: ["documentation", "help wanted", "possible-duplicate", "skip-triage"],
      }),
    });

    expect(removalsOf(decision)).toEqual(["documentation"]);
  });

  it("cleans up on the spam path too", () => {
    const decision = run(
      makeAnswers({
        category: { choice: "spam", confidence: 0.95, probabilities: { spam: 0.95 } },
        spam: { promotional: 1, offTopic: 1, abusive: 1 },
      }),
      { item: makeItem({ existingLabels: ["bug"] }) },
    );

    expect(removalsOf(decision)).toEqual(["bug"]);
    expect(labelsOf(decision)).toContain(DEFAULT_CONFIG.labels.category.spam);
  });

  it("matches label names case-insensitively", () => {
    const decision = run(makeAnswers(), {
      item: makeItem({ existingLabels: ["Documentation"] }),
    });

    expect(removalsOf(decision)).toEqual(["Documentation"]);
  });
});

describe("decide — information requests are confidence gated", () => {
  it("does not nag when Jev was unsure the information is missing", () => {
    const decision = run(
      makeAnswers({
        infoCompleteness: { choice: "missing_version_info", confidence: 0.38, probabilities: {} },
      }),
    );

    expect(labelsOf(decision)).not.toContain(DEFAULT_CONFIG.labels.needsInfo);
    expect(decision.rationale.gates).toContain("info-request-low-confidence");
    expect(decision.actions.some((action) => action.type === "comment")).toBe(false);
  });

  it("asks when the information answer is confident", () => {
    const decision = run(
      makeAnswers({
        infoCompleteness: { choice: "missing_version_info", confidence: 0.9, probabilities: {} },
      }),
    );

    expect(labelsOf(decision)).toContain(DEFAULT_CONFIG.labels.needsInfo);
    expect(decision.rationale.gates).toContain("info-missing_version_info");
  });
});

describe("decide — spam handling", () => {
  const spamAnswers = makeAnswers({
    category: { choice: "spam", confidence: 0.95, probabilities: { spam: 0.95 } },
    spam: { promotional: 1, offTopic: 1, abusive: 1 },
  });

  it("labels spam and asks for review when auto-close is disabled", () => {
    const decision = run(spamAnswers);
    expect(labelsOf(decision)).toContain(DEFAULT_CONFIG.labels.category.spam);
    expect(labelsOf(decision)).toContain(DEFAULT_CONFIG.labels.needsTriage);
    expect(decision.actions.some((action) => action.type === "close")).toBe(false);
    expect(decision.rationale.gates).toContain("spam-needs-review");
  });

  it("closes and comments only when auto-close is explicitly allowed", () => {
    const decision = run(spamAnswers, { config: { allowAutoClose: true } });
    expect(decision.actions.some((action) => action.type === "close")).toBe(true);
    const comment = decision.actions.find(
      (action) => action.type === "comment" && action.kind === "spam",
    );
    expect(comment).toBeTruthy();
    expect(decision.rationale.gates).toContain("spam-auto-close");
  });

  it("still refuses to close when category confidence is only moderate", () => {
    const decision = run(
      makeAnswers({
        category: { choice: "spam", confidence: 0.7, probabilities: { spam: 0.7 } },
        spam: { promotional: 1, offTopic: 1, abusive: 1 },
      }),
      { config: { allowAutoClose: true } },
    );
    expect(decision.actions.some((action) => action.type === "close")).toBe(false);
  });

  it("keeps the spam label when the item is also routed to a human", () => {
    const decision = run(
      makeAnswers({
        category: { choice: "spam", confidence: 0.95, probabilities: { spam: 0.95 } },
        spam: { promotional: 1, offTopic: 0.9, abusive: 0.8 },
        needsHumanReview: 0.8,
      }),
    );

    // Evidence of spam is the reason to look, so routing to a human must not hide it.
    expect(labelsOf(decision)).toContain(DEFAULT_CONFIG.labels.category.spam);
    expect(labelsOf(decision)).toContain(DEFAULT_CONFIG.labels.needsTriage);
    expect(decision.rationale.gates).toContain("spam");
  });

  it("notifies about spam even when routed to a human", () => {
    const decision = run(
      makeAnswers({
        category: { choice: "spam", confidence: 0.95, probabilities: { spam: 0.95 } },
        spam: { promotional: 1, offTopic: 1, abusive: 1 },
        needsHumanReview: 0.9,
      }),
    );

    const notify = decision.actions.find((action) => action.type === "notify");
    expect(notify && notify.type === "notify" ? notify.reason : null).toBe("spam");
  });

  it("never asks a spammer for missing information", () => {
    const decision = run(
      makeAnswers({
        category: { choice: "spam", confidence: 0.95, probabilities: { spam: 0.95 } },
        spam: { promotional: 1, offTopic: 1, abusive: 1 },
        needsHumanReview: 0.9,
        infoCompleteness: {
          choice: "missing_expected_behavior",
          confidence: 0.99,
          probabilities: {},
        },
      }),
    );

    expect(labelsOf(decision)).not.toContain(DEFAULT_CONFIG.labels.needsInfo);
    expect(decision.actions.some((action) => action.type === "comment")).toBe(false);
  });
});

describe("decide — normal path", () => {
  it("applies the category label and nothing else for a clean bug report", () => {
    const decision = run(makeAnswers());
    expect(labelsOf(decision)).toEqual([DEFAULT_CONFIG.labels.category.bug]);
    expect(decision.actions).toHaveLength(1);
  });

  it("applies an extra label when Jev suggests one", () => {
    const decision = run(
      makeAnswers({
        extraLabel: { choice: "help wanted", confidence: 0.8, probabilities: {} },
      }),
    );
    expect(labelsOf(decision)).toContain("help wanted");
  });

  it("ignores the none/no_preference sentinel values", () => {
    const decision = run(
      makeAnswers({
        extraLabel: { choice: "none", confidence: 0.9, probabilities: {} },
        reviewer: { choice: "no_preference", confidence: 0.9, probabilities: {} },
      }),
    );
    expect(decision.rationale.extraLabel).toBeNull();
    expect(decision.rationale.reviewer).toBeNull();
  });

  it("does not suggest a label that duplicates the category label", () => {
    // Category `bug` maps to the label "bug"; suggesting "bug" again is noise.
    const decision = run(
      makeAnswers({ extraLabel: { choice: "bug", confidence: 0.9, probabilities: {} } }),
    );
    expect(decision.rationale.extraLabel).toBeNull();
    expect(labelsOf(decision)).toEqual([DEFAULT_CONFIG.labels.category.bug]);
  });

  it("matches the category label case-insensitively", () => {
    const decision = run(
      makeAnswers({ extraLabel: { choice: "BUG", confidence: 0.9, probabilities: {} } }),
    );
    expect(decision.rationale.extraLabel).toBeNull();
  });

  it("requests missing information and labels the item", () => {
    const decision = run(
      makeAnswers({
        infoCompleteness: {
          choice: "missing_repro_steps",
          confidence: 0.9,
          probabilities: {},
        },
      }),
    );
    expect(labelsOf(decision)).toContain(DEFAULT_CONFIG.labels.needsInfo);
    const comment = decision.actions.find(
      (action) => action.type === "comment" && action.kind === "triage",
    );
    expect(comment && comment.type === "comment" ? comment.body : "").toMatch(/reproduce/i);
  });

  it("labels and comments on a strong duplicate", () => {
    const decision = run(makeAnswers(), {
      duplicate: makeDuplicate({
        bestScore: 0.9,
        bestNumber: 314,
        candidates: [{ number: 314, title: "Dupe", score: 0.9 }],
      }),
    });
    expect(labelsOf(decision)).toContain(DEFAULT_CONFIG.labels.possibleDuplicate);
    const comment = decision.actions.find(
      (action) => action.type === "comment" && action.kind === "triage",
    );
    expect(comment && comment.type === "comment" ? comment.body : "").toContain("#314");
  });

  it("labels but does not comment on a weaker duplicate", () => {
    const decision = run(makeAnswers(), {
      duplicate: makeDuplicate({
        bestScore: 0.78,
        bestNumber: 7,
        candidates: [{ number: 7, title: "Maybe", score: 0.78 }],
      }),
    });
    expect(labelsOf(decision)).toContain(DEFAULT_CONFIG.labels.possibleDuplicate);
    expect(
      decision.actions.some((action) => action.type === "comment" && action.kind === "triage"),
    ).toBe(false);
  });

  it("escalates critical severity and notifies", () => {
    const decision = run(
      makeAnswers({ impact: { score: 3, confidence: 0.92, probabilities: { "3": 0.92 } } }),
    );
    expect(labelsOf(decision)).toContain(DEFAULT_CONFIG.labels.priorityCritical);
    expect(decision.actions.some((action) => action.type === "notify")).toBe(true);
    expect(decision.rationale.gates).toContain("severity-critical");
  });

  it("does not escalate to critical when impact confidence is low", () => {
    const decision = run(
      makeAnswers({ impact: { score: 3, confidence: 0.3, probabilities: { "3": 0.3 } } }),
    );
    expect(labelsOf(decision)).not.toContain(DEFAULT_CONFIG.labels.priorityCritical);
  });

  it("suggests a reviewer in the triage comment", () => {
    const decision = run(
      makeAnswers({ reviewer: { choice: "alice", confidence: 0.7, probabilities: {} } }),
    );
    const comment = decision.actions.find(
      (action) => action.type === "comment" && action.kind === "triage",
    );
    expect(comment && comment.type === "comment" ? comment.body : "").toContain("@alice");
  });

  it("falls back to the other category for unknown values", () => {
    const decision = run(
      makeAnswers({ category: { choice: "unknown-thing", confidence: 0.9, probabilities: {} } }),
    );
    expect(decision.rationale.category).toBe("other");
    expect(labelsOf(decision)).toContain(DEFAULT_CONFIG.labels.category.other);
  });
});
