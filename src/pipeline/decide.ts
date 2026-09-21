import type {
  Category,
  InfoState,
  ItemType,
  JevTriageConfig,
  NotifyReason,
  Severity,
} from "../config/schema";
import { CATEGORIES, INFO_STATES, SEVERITIES } from "../config/schema";
import type { DuplicateResult, TriageAnswers } from "./jev/types";
import type { PreprocessedItem } from "./preprocess";

export interface DecideInput {
  item: PreprocessedItem;
  config: JevTriageConfig;
  answers: TriageAnswers;
  duplicate: DuplicateResult | null;
}

export type PlannedAction =
  | { type: "add_label"; label: string; reason: string }
  | { type: "remove_label"; label: string; reason: string }
  | { type: "comment"; kind: string; body: string; reason: string }
  | { type: "close"; reason: string }
  | { type: "assign"; assignees: string[]; reason: string }
  | { type: "notify"; reason: NotifyReason; message: string };

export interface DecisionRationale {
  itemType: ItemType;
  category: Category;
  categoryConfidence: number;
  severity: Severity;
  severityConfidence: number;
  impactScore: number;
  info: InfoState;
  infoConfidence: number;
  spamRisk: number;
  needsHumanReview: number;
  duplicate: DuplicateResult | null;
  extraLabel: string | null;
  reviewer: string | null;
  /** Names of the rules that fired, useful for auditing and tests. */
  gates: string[];
}

export interface Decision {
  rationale: DecisionRationale;
  actions: PlannedAction[];
}

export function impactScoreToSeverity(score: number): Severity {
  const index = Math.min(Math.max(Math.round(score), 0), SEVERITIES.length - 1);
  return SEVERITIES[index] ?? "low";
}

export function computeSpamRisk(
  spam: { promotional: number; offTopic: number; abusive: number },
  weights: { promotional: number; offTopic: number; abusive: number },
): number {
  const total = weights.promotional + weights.offTopic + weights.abusive || 1;
  const risk =
    weights.promotional * spam.promotional +
    weights.offTopic * spam.offTopic +
    weights.abusive * spam.abusive;
  return Math.min(Math.max(risk / total, 0), 1);
}

const INFO_REQUESTS: Record<Exclude<InfoState, "complete">, string> = {
  missing_repro_steps:
    "Could you share a minimal set of steps that reproduces the problem, including what you expected and what actually happened?",
  missing_version_info: "Could you tell us which version, commit, or release you are running?",
  missing_environment:
    "Could you share your environment: operating system, runtime version, and any relevant configuration?",
  missing_expected_behavior:
    "Could you clarify what you expected to happen and what happened instead?",
};

function isKnownCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

function isKnownInfoState(value: string): value is InfoState {
  return (INFO_STATES as readonly string[]).includes(value);
}

/**
 * Turns Jev answers into a set of actions. Every automated action is gated on
 * confidence: anything uncertain is routed to a human with the `needs-triage` label
 * instead of being acted on.
 */
export function decide(input: DecideInput): Decision {
  const { item, config, answers, duplicate } = input;
  const gates: string[] = [];
  const actions: PlannedAction[] = [];

  const category: Category = isKnownCategory(answers.category.choice)
    ? answers.category.choice
    : "other";
  const info: InfoState = isKnownInfoState(answers.infoCompleteness.choice)
    ? answers.infoCompleteness.choice
    : "complete";

  const spamRisk = computeSpamRisk(answers.spam, config.spamWeights);
  const severity = impactScoreToSeverity(answers.impact.score);
  const categoryLabel = config.labels.category[category];

  const categoryConfident = answers.category.confidence >= config.thresholds.actMin;
  const spamBand = config.thresholds.spamRisk;
  const spamUncertain = spamRisk > spamBand.low && spamRisk < spamBand.high;
  const spamHigh = spamRisk >= spamBand.high;
  const humanReview = answers.needsHumanReview >= config.thresholds.needsHumanReview;

  const rationale: DecisionRationale = {
    itemType: item.type,
    category,
    categoryConfidence: answers.category.confidence,
    severity,
    severityConfidence: answers.impact.confidence,
    impactScore: answers.impact.score,
    info,
    infoConfidence: answers.infoCompleteness.confidence,
    spamRisk,
    needsHumanReview: answers.needsHumanReview,
    duplicate,
    extraLabel:
      answers.extraLabel &&
      answers.extraLabel.choice !== "none" &&
      // Never suggest a label that is really the category label under another name.
      answers.extraLabel.choice.toLowerCase() !== categoryLabel.toLowerCase()
        ? answers.extraLabel.choice
        : null,
    reviewer:
      answers.reviewer && answers.reviewer.choice !== "no_preference"
        ? answers.reviewer.choice
        : null,
    gates,
  };

  const commentSections: string[] = [];

  /**
   * Asks for missing detail, gated on the confidence of the *information* answer rather
   * than the category: we would rather say nothing than nag about a judgment Jev itself
   * was unsure of. Belongs to no single branch — it is useful on the human-review path too.
   */
  const addInfoRequest = (): void => {
    // Never ask a spammer for reproduction steps.
    if (spamHigh || category === "spam") return;
    if (info === "complete") return;
    if (answers.infoCompleteness.confidence < config.thresholds.actMin) {
      gates.push("info-request-low-confidence");
      return;
    }
    gates.push(`info-${info}`);
    actions.push({
      type: "add_label",
      label: config.labels.needsInfo,
      reason: `Missing information: ${info}`,
    });
    commentSections.push(`**Additional information needed**\n\n${INFO_REQUESTS[info]}`);
  };

  /** One comment per run, so re-triaging updates it in place instead of piling up. */
  const pushCommentIfAny = (): void => {
    if (commentSections.length === 0) return;
    actions.push({
      type: "comment",
      kind: "triage",
      body: commentSections.join("\n\n"),
      reason: gates.join(", "),
    });
  };

  /**
   * Applies a category label, dropping the other category labels the bot manages.
   *
   * Categories are mutually exclusive: if an item was triaged as `documentation` and a
   * later run decides it is a `bug`, leaving both labels on it is wrong and confusing.
   * `/jev reclassify` already behaved this way; this brings the automatic path in line.
   */
  const pushCategoryLabel = (label: string, reason: string): void => {
    const managed = new Set(
      Object.values(config.labels.category).map((name) => name.toLowerCase()),
    );
    const next = label.toLowerCase();

    for (const existing of item.existingLabels) {
      const lower = existing.toLowerCase();
      if (lower !== next && managed.has(lower)) {
        actions.push({
          type: "remove_label",
          label: existing,
          reason: `Superseded by category ${category}`,
        });
      }
    }

    actions.push({ type: "add_label", label, reason });
  };

  // Notifications are independent of the GitHub actions: a maintainer still wants to hear
  // about spam or a critical report even when the item is routed to them for a look.
  const notifyReasons: NotifyReason[] = [];
  if (severity === "critical" && config.notify.on.includes("critical"))
    notifyReasons.push("critical");
  if (spamHigh && config.notify.on.includes("spam")) notifyReasons.push("spam");
  if (
    duplicate &&
    duplicate.bestScore >= config.thresholds.duplicateComment &&
    config.notify.on.includes("duplicate")
  ) {
    notifyReasons.push("duplicate");
  }
  const notifyActions: PlannedAction[] = notifyReasons.map((reason) => ({
    type: "notify",
    reason,
    message: messageForNotification(reason, item, rationale),
  }));

  if (!categoryConfident || humanReview || spamUncertain) {
    // 1. Anything uncertain goes to a human. The information request is low-risk and is
    //    exactly what a vague report needs, so it survives; silence would leave the
    //    reporter with no guidance at all.
    if (!categoryConfident) gates.push("low-category-confidence");
    if (humanReview) gates.push("needs-human-review");
    if (spamUncertain) gates.push("spam-risk-uncertain");

    actions.push({
      type: "add_label",
      label: config.labels.needsTriage,
      reason: `Routed to a human (${gates.join(", ")})`,
    });

    // Strong spam evidence is the reason to look, so it must not be dropped here.
    if (spamHigh) {
      gates.push("spam");
      pushCategoryLabel(categoryLabel, "Composite spam risk");
    }

    addInfoRequest();
    pushCommentIfAny();
  } else if (spamHigh) {
    // 2. Spam: label always; closing only when explicitly allowed and very confident.
    gates.push("spam");
    pushCategoryLabel(categoryLabel, "Composite spam risk");

    if (config.allowAutoClose && answers.category.confidence >= config.thresholds.autoCloseSpam) {
      gates.push("spam-auto-close");
      actions.push({
        type: "comment",
        kind: "spam",
        body: [
          "This report looks like spam, so it has been closed automatically.",
          "",
          "If that is wrong, a maintainer can reopen it and the label can be removed.",
        ].join("\n"),
        reason: "High-confidence spam",
      });
      actions.push({ type: "close", reason: "High-confidence spam" });
    } else {
      gates.push("spam-needs-review");
      actions.push({
        type: "add_label",
        label: config.labels.needsTriage,
        reason: "Spam suspected but not confident enough to close",
      });
    }
  } else {
    // 3. Normal path: category label first.
    pushCategoryLabel(categoryLabel, `Category: ${category}`);

    if (rationale.extraLabel) {
      actions.push({
        type: "add_label",
        label: rationale.extraLabel,
        reason: "Suggested by Jev",
      });
    }

    addInfoRequest();

    const duplicateComment = config.thresholds.duplicateComment;
    const duplicateLabel = config.thresholds.duplicateLabel;
    if (duplicate && duplicate.bestNumber !== null && duplicate.bestScore >= duplicateLabel) {
      const withComment = duplicate.bestScore >= duplicateComment;
      gates.push(withComment ? "duplicate-comment" : "duplicate-label");
      actions.push({
        type: "add_label",
        label: config.labels.possibleDuplicate,
        reason: `Duplicate score ${duplicate.bestScore.toFixed(2)}`,
      });
      if (withComment) {
        commentSections.push(
          [
            "**Possible duplicate**",
            "",
            `This looks a lot like #${duplicate.bestNumber}. If it is the same problem, please add any new detail there instead.`,
          ].join("\n"),
        );
      }
    }

    if (rationale.reviewer) {
      gates.push("reviewer-suggestion");
      commentSections.push(
        `**Suggested reviewer**\n\n@${rationale.reviewer} may be the best fit based on the areas this touches.`,
      );
    }

    pushCommentIfAny();

    if (severity === "critical" && answers.impact.confidence >= config.thresholds.actMin) {
      gates.push("severity-critical");
      actions.push({
        type: "add_label",
        label: config.labels.priorityCritical,
        reason: "Critical impact reported",
      });
    }
  }

  actions.push(...notifyActions);

  return { rationale, actions };
}

function messageForNotification(
  reason: NotifyReason,
  item: PreprocessedItem,
  rationale: DecisionRationale,
): string {
  const heading =
    reason === "critical"
      ? "Critical issue detected"
      : reason === "spam"
        ? "Probable spam detected"
        : "Probable duplicate detected";

  const lines = [
    `${heading}: ${item.url}`,
    `Title: ${item.title}`,
    `Type: ${item.type} · Category: ${rationale.category} · Severity: ${rationale.severity}`,
  ];
  if (reason === "spam") {
    lines.push(`Spam risk: ${rationale.spamRisk.toFixed(2)}`);
  }
  if (reason === "duplicate" && rationale.duplicate?.bestNumber) {
    lines.push(`Possible duplicate of #${rationale.duplicate.bestNumber}`);
  }
  return lines.join("\n");
}
