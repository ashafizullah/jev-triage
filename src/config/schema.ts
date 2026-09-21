import { z } from "zod";

export const CATEGORIES = [
  "bug",
  "feature_request",
  "question",
  "documentation",
  "spam",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const INFO_STATES = [
  "complete",
  "missing_repro_steps",
  "missing_version_info",
  "missing_environment",
  "missing_expected_behavior",
] as const;
export type InfoState = (typeof INFO_STATES)[number];

export const ITEM_TYPES = ["issue", "pull_request"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const NOTIFY_REASONS = ["critical", "spam", "duplicate"] as const;
export type NotifyReason = (typeof NOTIFY_REASONS)[number];

/** Override commands accepted from maintainers in issue comments. */
export const REVIEW_COMMANDS = ["reclassify", "not-duplicate", "retriage", "explain"] as const;
export type ReviewCommand = (typeof REVIEW_COMMANDS)[number];

/** A Choice question accepts at most 255 options; we stay far below that for accuracy. */
export const MAX_CHOICE_OPTIONS = 16;

const categoryLabels = z.object({
  bug: z.string().default("bug"),
  feature_request: z.string().default("enhancement"),
  question: z.string().default("question"),
  // Matches the label name GitHub creates by default, so most repositories already have it.
  documentation: z.string().default("documentation"),
  spam: z.string().default("spam"),
  other: z.string().default("triage"),
});

/** Used when neither the repository config nor JEV_MODEL specifies a model. */
export const DEFAULT_MODEL = "jev-latest";

export const JevTriageConfigSchema = z.object({
  /** Master switch; when false the app ignores every event. */
  enabled: z.boolean().default(true),
  /** Which kinds of item are triaged at all, and how eagerly pull requests are re-checked. */
  triage: z
    .object({
      issues: z.boolean().default(true),
      pullRequests: z.boolean().default(true),
      /**
       * Re-triage on every commit pushed to a pull request. Off by default: triage is a
       * decision made when the item arrives, and each push would spend another Jev call.
       */
      onPullRequestPush: z.boolean().default(false),
      /**
       * Triage draft pull requests. Off by default, because `ready_for_review` fires when
       * they are finished and drafts cannot be merged, so nothing is missed.
       */
      includeDrafts: z.boolean().default(false),
    })
    .default({}),
  /** Log intended actions without writing anything to GitHub. */
  dryRun: z.boolean().default(false),
  /** Closing an issue is destructive, so it stays opt-in even for confident spam. */
  allowAutoClose: z.boolean().default(false),
  suggestReviewers: z.boolean().default(false),
  /**
   * Model name sent to Jev. Left unset it falls back to the JEV_MODEL environment
   * variable, then to DEFAULT_MODEL. Pin a concrete version in production if your
   * thresholds are sensitive.
   */
  model: z.string().min(1).optional(),
  labels: z
    .object({
      category: categoryLabels.default({}),
      needsInfo: z.string().default("needs-info"),
      possibleDuplicate: z.string().default("possible-duplicate"),
      needsTriage: z.string().default("needs-triage"),
      priorityCritical: z.string().default("priority:critical"),
    })
    .default({}),
  thresholds: z
    .object({
      /** Below this Choice confidence we do not act on the category at all. */
      actMin: z.number().min(0).max(1).default(0.6),
      /** Confidence required before auto-closing a spam report. */
      autoCloseSpam: z.number().min(0).max(1).default(0.9),
      duplicateLabel: z.number().min(0).max(1).default(0.75),
      duplicateComment: z.number().min(0).max(1).default(0.85),
      /** Composite spam risk band; inside the band we route to a human. */
      spamRisk: z
        .object({
          low: z.number().min(0).max(1).default(0.4),
          high: z.number().min(0).max(1).default(0.6),
        })
        .default({}),
      /** Noul probability above which we assume a human is needed. */
      needsHumanReview: z.number().min(0).max(1).default(0.5),
    })
    .default({}),
  /** Weights for the composite spam score, combined in code. */
  spamWeights: z
    .object({
      promotional: z.number().min(0).default(0.45),
      offTopic: z.number().min(0).default(0.3),
      abusive: z.number().min(0).default(0.25),
    })
    .default({}),
  budget: z
    .object({
      /** Estimated-token ceiling per Jev request (chars / 4). */
      maxTotalEstimatedTokens: z.number().int().positive().default(24_000),
      bodyChars: z.number().int().positive().default(8_000),
      candidateTitleChars: z.number().int().positive().default(200),
      candidateExcerptChars: z.number().int().positive().default(400),
    })
    .default({}),
  duplicates: z
    .object({
      /** How many open/closed items to consider as comparison candidates. */
      candidatePoolSize: z.number().int().positive().max(100).default(50),
      /** How many candidates reach the Jev verification call. */
      maxCandidates: z.number().int().positive().max(20).default(6),
      candidateState: z.enum(["open", "all"]).default("open"),
      /** Cap the extracted `extra_label` shortlist; too many options hurts accuracy. */
      labelShortlistSize: z.number().int().positive().max(30).default(15),
    })
    .default({}),
  notify: z
    .object({
      on: z.array(z.enum(NOTIFY_REASONS)).default(["critical", "spam"]),
      slackEnv: z.string().default("SLACK_WEBHOOK_URL"),
      discordEnv: z.string().default("DISCORD_WEBHOOK_URL"),
      /**
       * Telegram needs two values: the bot token from @BotFather and the chat to post to.
       * Both must be set for Telegram notifications to be sent.
       */
      telegramTokenEnv: z.string().default("TELEGRAM_BOT_TOKEN"),
      telegramChatIdEnv: z.string().default("TELEGRAM_CHAT_ID"),
      /** Optional Bot API root, for a self-hosted Bot API server. */
      telegramApiBaseEnv: z.string().default("TELEGRAM_API_BASE"),
    })
    .default({}),
  ignore: z
    .object({
      authors: z.array(z.string()).default([]),
      /** Items carrying any of these labels are skipped entirely. */
      labels: z.array(z.string()).default(["skip-triage"]),
    })
    .default({}),
  /** Optional fixed reviewer pool; when empty we discover recent maintainers. */
  reviewerPool: z.array(z.string()).default([]),
});

export type JevTriageConfig = z.infer<typeof JevTriageConfigSchema>;

/** Defaults produced by parsing an empty object; also used as Probot's config baseline. */
export const DEFAULT_CONFIG: JevTriageConfig = JevTriageConfigSchema.parse({});
