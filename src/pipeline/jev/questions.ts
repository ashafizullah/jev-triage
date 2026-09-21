import { choice, noul, score } from "@typesafe-ai/sdk";
import type { ChoiceCriteria, EntryType, Questions } from "@typesafe-ai/sdk";
import { MAX_CHOICE_OPTIONS } from "../../config/schema";
import { excerpt, truncate } from "../../util/markdown";
import { estimateTokens } from "./budget";
import type {
  ChoiceAnswer,
  DuplicateCandidateScore,
  DuplicateResult,
  NoulAnswer,
  ScoreAnswer,
  TriageAnswers,
} from "./types";

/** Question ids are also the answer keys, so both sides of the pipeline share them. */
export const Q = {
  category: "category",
  impact: "impact",
  infoCompleteness: "info_completeness",
  spamPromotional: "spam_promotional",
  spamOffTopic: "spam_off_topic",
  spamAbusive: "spam_abusive",
  needsHumanReview: "needs_human_review",
  extraLabel: "extra_label",
  reviewer: "reviewer",
  duplicatePrefix: "dup_",
} as const;

/**
 * Instructions and criteria are in English on purpose: Jev's primary training
 * language is English and non-English input currently scores lower accuracy.
 * Criteria use the documented contrastive shape (what / not_for / examples).
 */
const CATEGORY_CRITERIA: ChoiceCriteria = {
  bug: {
    what: "Existing functionality is broken or behaves incorrectly.",
    not_for: "Requests for behaviour that was never implemented.",
    examples: ["the app crashes when…", "returns the wrong value", "regression since 2.3"],
  },
  feature_request: {
    what: "Asks for new functionality or an enhancement of existing behaviour.",
    not_for: "A report that something already implemented is broken.",
    examples: ["please add support for…", "it would be useful if…"],
  },
  question: {
    what: "A support or usage question about how something works.",
    not_for: "A defect report or a change request.",
    examples: ["how do I configure…?", "is it possible to…?"],
  },
  documentation: {
    what: "Documentation, comments, or examples are wrong, missing, or unclear.",
    not_for: "A defect in the runtime code itself.",
    examples: ["the README says…", "the JSDoc example does not compile"],
  },
  spam: {
    what: "Promotional, off-topic, abusive, or automated junk with no genuine contribution.",
    not_for: "A poorly written but sincere report.",
    examples: ["buy cheap followers", "crypto giveaway link"],
  },
  other: {
    what: "Maintenance work that is not a bug, feature, question, or docs issue.",
    not_for: "Anything that clearly fits an earlier option.",
    examples: ["chore", "refactor", "CI or release automation"],
  },
};

const INFO_CRITERIA: ChoiceCriteria = {
  complete: {
    what: "Enough detail to reproduce or act on the item without follow-up.",
  },
  missing_repro_steps: {
    what: "No clear, ordered steps that reproduce the reported behaviour.",
    not_for: "A complete report that includes reproduction steps.",
  },
  missing_version_info: {
    what: "No version, commit, or release information for the software involved.",
  },
  missing_environment: {
    what: "No operating system, runtime, platform, or configuration detail.",
  },
  missing_expected_behavior: {
    what: "Does not state both the expected and the actual behaviour.",
  },
};

export interface TriageQuestionOptions {
  /** Repository labels that the bot does not manage itself. */
  labelShortlist: string[];
  reviewerPool: string[];
  suggestReviewers: boolean;
}

export function buildTriageQuestions(options: TriageQuestionOptions): Questions {
  const questions: Questions = {
    [Q.category]: choice(
      {
        question: "What is the primary type of this issue or pull request?",
        focus: "Choose the single best fit. Judge the intent of the author, not its quality.",
      },
      CATEGORY_CRITERIA,
    ),
    [Q.impact]: score("If this report is accurate, how severe is the impact it describes?", [
      {
        what: "Low",
        signals: ["cosmetic", "documentation typo", "nice-to-have"],
      },
      {
        what: "Medium",
        signals: ["minor functional problem", "a workaround exists"],
      },
      {
        what: "High",
        signals: ["major functionality broken for many users", "no workaround"],
      },
      {
        what: "Critical",
        signals: ["data loss", "security issue", "outage", "blocks all users"],
      },
    ]),
    [Q.infoCompleteness]: choice(
      {
        question:
          "Is there enough information to reproduce or act on this? If not, which single piece is most missing?",
      },
      INFO_CRITERIA,
    ),
    [Q.spamPromotional]: noul("Does this item contain unsolicited promotion or advertising?"),
    [Q.spamOffTopic]: noul("Is this item unrelated to this repository's purpose and topics?"),
    [Q.spamAbusive]: noul("Does this item contain abusive, harassing, or hateful content?"),
    [Q.needsHumanReview]: noul(
      "Does this item need a maintainer's judgment before any automated action, for example an ambiguous scope, a design decision, or sensitive content?",
    ),
  };

  const shortlist = options.labelShortlist.slice(0, MAX_CHOICE_OPTIONS - 1);
  if (shortlist.length > 0) {
    const criteria: ChoiceCriteria = { none: "No extra label applies." };
    for (const label of shortlist) {
      criteria[label] = `The repository label "${label}".`;
    }
    questions[Q.extraLabel] = choice(
      "Beyond the category, which existing repository label best applies? Choose none if none apply.",
      criteria,
    );
  }

  if (options.suggestReviewers && options.reviewerPool.length > 0) {
    const pool = options.reviewerPool.slice(0, MAX_CHOICE_OPTIONS - 1);
    const criteria: ChoiceCriteria = { no_preference: "No specific reviewer is a better fit." };
    for (const login of pool) {
      criteria[login] = `${login} maintains this repository.`;
    }
    questions[Q.reviewer] = choice(
      {
        question: "Which maintainer is the best fit to review this, based on the areas it touches?",
      },
      criteria,
    );
  }

  return questions;
}

export interface DuplicateCandidateInput {
  number: number;
  title: string;
  body: string;
}

export interface DuplicateQuestionsResult {
  questions: Questions;
  /** Candidates actually included, in question order. */
  used: DuplicateCandidateInput[];
  estimatedTokens: number;
  truncated: boolean;
}

export interface DuplicateQuestionOptions {
  titleChars: number;
  excerptChars: number;
  maxEstimatedTokens: number;
}

/**
 * Builds one Noul per candidate, embedding the candidate record so each question
 * is self-contained. Excerpts are trimmed until the request fits the token budget.
 */
export function buildDuplicateQuestions(
  candidates: DuplicateCandidateInput[],
  options: DuplicateQuestionOptions,
): DuplicateQuestionsResult {
  let used = candidates.slice();
  let excerptChars = options.excerptChars;
  let truncated = false;

  const build = (list: DuplicateCandidateInput[], chars: number): Questions => {
    const questions: Questions = {};
    list.forEach((candidate, index) => {
      const instructions: EntryType = {
        candidate: {
          number: candidate.number,
          title: truncate(candidate.title, options.titleChars),
          body_excerpt: excerpt(candidate.body, chars),
        },
        question:
          "Is `candidate` describing the same underlying problem or request as the incoming item?",
      };
      questions[`${Q.duplicatePrefix}${index + 1}`] = noul(instructions, {
        true: "The same root problem or request.",
        false: "A different problem, or only superficially similar wording.",
      });
    });
    return questions;
  };

  let questions = build(used, excerptChars);

  // First shrink the excerpts, then drop the weakest candidates.
  while (
    estimateTokens(questions) > options.maxEstimatedTokens &&
    excerptChars > 120 &&
    used.length > 1
  ) {
    excerptChars = Math.max(120, Math.floor(excerptChars * 0.6));
    truncated = true;
    questions = build(used, excerptChars);
  }
  while (estimateTokens(questions) > options.maxEstimatedTokens && used.length > 1) {
    used = used.slice(0, used.length - 1);
    truncated = true;
    questions = build(used, excerptChars);
  }

  return {
    questions,
    used,
    estimatedTokens: estimateTokens(questions),
    truncated,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toStringRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const num = toNumber(raw);
    if (num !== null) out[key] = num;
  }
  return out;
}

function asChoice(value: unknown): ChoiceAnswer | null {
  if (!isRecord(value) || typeof value.choice !== "string") return null;
  return {
    choice: value.choice,
    confidence: toNumber(value.confidence) ?? 0,
    probabilities: toStringRecord(value.probabilities),
  };
}

function asScore(value: unknown): ScoreAnswer | null {
  if (!isRecord(value)) return null;
  const scoreValue = toNumber(value.score);
  if (scoreValue === null) return null;
  return {
    score: scoreValue,
    confidence: toNumber(value.confidence) ?? 0,
    probabilities: toStringRecord(value.probabilities),
  };
}

function asNoul(value: unknown): NoulAnswer | null {
  if (!isRecord(value)) return null;
  const noulValue = toNumber(value.noul);
  return noulValue === null ? null : { noul: noulValue };
}

/** Normalises the raw fan-out #1 answers, failing loudly if a required one is missing. */
export function parseTriageAnswers(answers: Record<string, unknown>): TriageAnswers {
  const category = asChoice(answers[Q.category]);
  const impact = asScore(answers[Q.impact]);
  const infoCompleteness = asChoice(answers[Q.infoCompleteness]);
  const spamPromotional = asNoul(answers[Q.spamPromotional]);
  const spamOffTopic = asNoul(answers[Q.spamOffTopic]);
  const spamAbusive = asNoul(answers[Q.spamAbusive]);
  const needsHumanReview = asNoul(answers[Q.needsHumanReview]);

  const missing = [
    [!category, Q.category],
    [!impact, Q.impact],
    [!infoCompleteness, Q.infoCompleteness],
    [!spamPromotional, Q.spamPromotional],
    [!spamOffTopic, Q.spamOffTopic],
    [!spamAbusive, Q.spamAbusive],
    [!needsHumanReview, Q.needsHumanReview],
  ]
    .filter(([isMissing]) => isMissing)
    .map(([, id]) => id);

  if (missing.length > 0 || !category || !impact || !infoCompleteness) {
    throw new Error(`Jev response is missing required answers: ${missing.join(", ")}`);
  }

  return {
    category,
    impact,
    infoCompleteness,
    spam: {
      promotional: spamPromotional?.noul ?? 0,
      offTopic: spamOffTopic?.noul ?? 0,
      abusive: spamAbusive?.noul ?? 0,
    },
    needsHumanReview: needsHumanReview?.noul ?? 0,
    extraLabel: asChoice(answers[Q.extraLabel]),
    reviewer: asChoice(answers[Q.reviewer]),
  };
}

/** Maps fan-out #2 answers back onto the candidates that produced them. */
export function parseDuplicateAnswers(
  answers: Record<string, unknown>,
  candidates: DuplicateCandidateInput[],
): DuplicateResult {
  const scores: DuplicateCandidateScore[] = [];

  candidates.forEach((candidate, index) => {
    const answer = asNoul(answers[`${Q.duplicatePrefix}${index + 1}`]);
    if (!answer) return;
    scores.push({ number: candidate.number, title: candidate.title, score: answer.noul });
  });

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0] ?? null;

  return {
    bestScore: best?.score ?? 0,
    bestNumber: best?.number ?? null,
    candidates: scores,
  };
}
