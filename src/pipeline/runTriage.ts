import { resolveModel } from "../config/model";
import type { JevTriageConfig } from "../config/schema";
import type { Db } from "../db/client";
import { actions as actionsTable, predictions as predictionsTable, triageRuns } from "../db/schema";
import type { Octokit, RepoRef } from "../github/types";
import { repoFullName } from "../github/types";
import { isDryRunForced } from "../util/env";
import { shortHash } from "../util/hashing";
import type { Logger } from "../util/logger";
import { type AppliedAction, applyActions } from "./actions";
import { fetchCandidates } from "./candidates";
import { type DecisionRationale, type PlannedAction, decide } from "./decide";
import { estimateTokens } from "./jev/budget";
import {
  buildDuplicateQuestions,
  buildTriageQuestions,
  parseDuplicateAnswers,
  parseTriageAnswers,
} from "./jev/questions";
import type { DuplicateResult, JevClient, TriageAnswers } from "./jev/types";
import type { TelegramTarget } from "./notify";
import { type PreprocessedItem, buildState } from "./preprocess";
import { fetchLabelShortlist, fetchReviewerPool } from "./repoMeta";
import { rankCandidates } from "./similarity";

export interface TriageDeps {
  jev: JevClient;
  db: Db;
  log: Logger;
}

export interface TriageRunInput {
  octokit: Octokit;
  ref: RepoRef;
  item: PreprocessedItem;
  config: JevTriageConfig;
  botLogin?: string | null;
  /** Overrides config.dryRun; the CLI passes true by default. */
  dryRun?: boolean;
}

export interface TriageRunResult {
  runId: number;
  runKey: string;
  rationale: DecisionRationale;
  planned: PlannedAction[];
  applied: AppliedAction[];
  answers: TriageAnswers;
  duplicate: DuplicateResult | null;
  modelVersion: string;
  usage: { inputTokens: number; outputTokens: number };
  estimatedTokens: number;
  latencyMs: number;
}

interface RepoMeta {
  labels: string[];
  reviewers: string[];
}

const META_TTL_MS = 5 * 60 * 1000;
const metaCache = new Map<string, { value: RepoMeta; expiresAt: number }>();

export function clearRepoMetaCache(): void {
  metaCache.clear();
}

/**
 * Telegram needs both a bot token and a destination chat. A half-configured pair is a
 * common mistake, so say so rather than silently sending nothing.
 */
function resolveTelegramTarget(
  notify: JevTriageConfig["notify"],
  log: Logger,
): TelegramTarget | undefined {
  const token = process.env[notify.telegramTokenEnv]?.trim();
  const chatId = process.env[notify.telegramChatIdEnv]?.trim();

  if (token && chatId) {
    return { token, chatId, apiBase: process.env[notify.telegramApiBaseEnv]?.trim() || undefined };
  }
  if (token || chatId) {
    log.warn(
      { tokenSet: Boolean(token), chatIdSet: Boolean(chatId) },
      "Telegram notifications need both the bot token and the chat id; skipping Telegram",
    );
  }
  return undefined;
}

async function getRepoMeta(
  octokit: Octokit,
  ref: RepoRef,
  config: JevTriageConfig,
): Promise<RepoMeta> {
  const key = `${repoFullName(ref)}:${config.suggestReviewers ? "r" : "-"}`;
  const cached = metaCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [labels, reviewers] = await Promise.all([
    fetchLabelShortlist(octokit, ref, config),
    config.suggestReviewers ? fetchReviewerPool(octokit, ref, config) : Promise.resolve([]),
  ]);

  const value: RepoMeta = { labels, reviewers };
  metaCache.set(key, { value, expiresAt: Date.now() + META_TTL_MS });
  return value;
}

/** Returns a human-readable reason when the item should not be triaged at all. */
export function shouldSkip(item: PreprocessedItem, config: JevTriageConfig): string | null {
  if (!config.enabled) return "disabled";
  const ignoredLabels = new Set(config.ignore.labels.map((label) => label.toLowerCase()));
  const hit = item.existingLabels.find((label) => ignoredLabels.has(label.toLowerCase()));
  if (hit) return `ignored-label:${hit}`;
  const ignoredAuthors = new Set(config.ignore.authors.map((author) => author.toLowerCase()));
  if (ignoredAuthors.has(item.author.login.toLowerCase()))
    return `ignored-author:${item.author.login}`;
  return null;
}

async function resolveDuplicates(
  octokit: Octokit,
  input: TriageRunInput,
  deps: TriageDeps,
  model: string,
): Promise<{
  duplicate: DuplicateResult | null;
  estimatedTokens: number;
  usage: { inputTokens: number; outputTokens: number };
  modelVersion: string;
}> {
  const { config, item, ref } = input;
  const empty = {
    duplicate: null,
    estimatedTokens: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    modelVersion: "",
  };

  const pool = await fetchCandidates(octokit, ref, {
    excludeNumber: item.number,
    type: item.type,
    poolSize: config.duplicates.candidatePoolSize,
    state: config.duplicates.candidateState,
    excludeCreatedAtOrAfter: item.createdAt,
  });
  if (pool.length === 0) return empty;

  const ranked = rankCandidates(
    { title: item.title, body: item.body },
    pool,
    config.duplicates.maxCandidates,
  );
  if (ranked.length === 0) return empty;

  const built = buildDuplicateQuestions(
    ranked.map(({ candidate }) => ({
      number: candidate.number,
      title: candidate.title,
      body: candidate.body,
    })),
    {
      titleChars: config.budget.candidateTitleChars,
      excerptChars: config.budget.candidateExcerptChars,
      maxEstimatedTokens: config.budget.maxTotalEstimatedTokens,
    },
  );
  if (built.used.length === 0) return empty;

  const response = await deps.jev.systemOne({
    state: buildState(item, { bodyChars: config.budget.bodyChars }),
    questions: built.questions,
    model,
  });

  return {
    duplicate: parseDuplicateAnswers(response.answers, built.used),
    estimatedTokens: response.estimatedTokens,
    usage: response.usage,
    modelVersion: response.model,
  };
}

/**
 * End-to-end triage for a single issue or pull request: preprocess, ask Jev,
 * verify duplicate candidates, decide, persist, then apply the actions.
 */
export async function runTriage(
  input: TriageRunInput,
  deps: TriageDeps,
): Promise<TriageRunResult | null> {
  const { config, item, ref, octokit } = input;
  const log = deps.log;
  const startedAt = Date.now();
  const dryRun = input.dryRun === true || config.dryRun || isDryRunForced();
  const runKey = shortHash({ title: item.title, body: item.body, labels: item.existingLabels });
  const model = resolveModel(config);

  const skipReason = shouldSkip(item, config);
  if (skipReason) {
    log.info({ repo: repoFullName(ref), number: item.number, skipReason }, "Skipping triage");
    return null;
  }

  try {
    return await runPipeline(input, deps, { runKey, dryRun, startedAt, model });
  } catch (err) {
    // Record the failure so the report can show it; without this a broken API key or a
    // Jev outage would only ever appear in the log.
    try {
      deps.db
        .insert(triageRuns)
        .values({
          repo: repoFullName(ref),
          itemNumber: item.number,
          itemType: item.type,
          model,
          modelVersion: null,
          stateHash: runKey,
          requestJson: "{}",
          responseJson: "{}",
          latencyMs: Date.now() - startedAt,
          inputTokens: 0,
          outputTokens: 0,
          estimatedTokens: 0,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          dryRun,
          createdAt: new Date().toISOString(),
        })
        .run();
    } catch (recordErr) {
      log.error({ err: recordErr }, "Could not record the failed triage run");
    }
    throw err;
  }
}

interface RunContext {
  runKey: string;
  dryRun: boolean;
  startedAt: number;
  model: string;
}

async function runPipeline(
  input: TriageRunInput,
  deps: TriageDeps,
  context: RunContext,
): Promise<TriageRunResult> {
  const { config, item, ref, octokit } = input;
  const log = deps.log;
  const { runKey, dryRun, startedAt, model } = context;

  const meta = await getRepoMeta(octokit, ref, config);

  const state = buildState(item, { bodyChars: config.budget.bodyChars });
  const questions = buildTriageQuestions({
    labelShortlist: meta.labels,
    reviewerPool: meta.reviewers,
    suggestReviewers: config.suggestReviewers,
  });

  const primary = await deps.jev.systemOne({ state, questions, model });
  const answers = parseTriageAnswers(primary.answers);

  const duplicatePass = await resolveDuplicates(octokit, input, deps, model);

  const { rationale, actions: planned } = decide({
    item,
    config,
    answers,
    duplicate: duplicatePass.duplicate,
  });

  const latencyMs = Date.now() - startedAt;
  const estimatedTokens = estimateTokens({ state, questions }) + duplicatePass.estimatedTokens;
  const usage = {
    inputTokens: primary.usage.inputTokens + duplicatePass.usage.inputTokens,
    outputTokens: primary.usage.outputTokens + duplicatePass.usage.outputTokens,
  };
  const modelVersion = primary.model || duplicatePass.modelVersion;

  const inserted = deps.db
    .insert(triageRuns)
    .values({
      repo: repoFullName(ref),
      itemNumber: item.number,
      itemType: item.type,
      model,
      modelVersion,
      stateHash: runKey,
      requestJson: JSON.stringify({ state, questionIds: Object.keys(questions) }),
      responseJson: JSON.stringify({
        answers: primary.answers,
        duplicate: duplicatePass.duplicate,
        // Stored so reports can explain *why* a decision was made, not just what it was.
        gates: rationale.gates,
      }),
      latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedTokens,
      status: "ok",
      dryRun,
      createdAt: new Date().toISOString(),
    })
    .run();

  const runId = Number(inserted.lastInsertRowid);
  const createdAt = new Date().toISOString();

  deps.db
    .insert(predictionsTable)
    .values([
      {
        runId,
        questionId: "category",
        kind: "choice",
        value: rationale.category,
        confidence: String(rationale.categoryConfidence),
        createdAt,
      },
      {
        runId,
        questionId: "severity",
        kind: "composite",
        value: rationale.severity,
        confidence: String(rationale.severityConfidence),
        createdAt,
      },
      {
        runId,
        questionId: "info_completeness",
        kind: "choice",
        value: rationale.info,
        confidence: String(rationale.infoConfidence),
        createdAt,
      },
      {
        runId,
        questionId: "spam_risk",
        kind: "composite",
        value: rationale.spamRisk.toFixed(4),
        confidence: null,
        createdAt,
      },
      ...(rationale.duplicate?.bestNumber
        ? [
            {
              runId,
              questionId: "duplicate",
              kind: "noul",
              value: String(rationale.duplicate.bestNumber),
              confidence: String(rationale.duplicate.bestScore),
              dupOfNumber: rationale.duplicate.bestNumber,
              createdAt,
            },
          ]
        : []),
    ])
    .run();

  const applied = await applyActions(
    octokit,
    ref,
    item,
    planned,
    {
      dryRun,
      runKey,
      botLogin: input.botLogin ?? null,
      notify: {
        slack: process.env[config.notify.slackEnv],
        discord: process.env[config.notify.discordEnv],
        telegram: resolveTelegramTarget(config.notify, log),
      },
    },
    log,
  );

  deps.db
    .insert(actionsTable)
    .values(
      applied.map((entry) => ({
        runId,
        repo: repoFullName(ref),
        itemNumber: item.number,
        actionType: entry.action.type,
        target: entry.target ?? null,
        payloadJson: JSON.stringify(entry.action),
        applied: entry.applied,
        skippedReason: entry.skippedReason ?? null,
        createdAt,
      })),
    )
    .run();

  log.info(
    {
      repo: repoFullName(ref),
      number: item.number,
      category: rationale.category,
      severity: rationale.severity,
      spamRisk: rationale.spamRisk,
      gates: rationale.gates,
      dryRun,
      applied: applied.filter((entry) => entry.applied).length,
      latencyMs,
      estimatedTokens,
    },
    "Triage complete",
  );

  return {
    runId,
    runKey,
    rationale,
    planned,
    applied,
    answers,
    duplicate: duplicatePass.duplicate,
    modelVersion,
    usage,
    estimatedTokens,
    latencyMs,
  };
}
