import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One row per Jev evaluation run (fan-out #1 plus its duplicate pass). */
export const triageRuns = sqliteTable(
  "triage_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repo: text("repo").notNull(),
    itemNumber: integer("item_number").notNull(),
    itemType: text("item_type").notNull(),
    model: text("model").notNull(),
    /** Concrete model version reported by the API (e.g. jev-1.13.0). */
    modelVersion: text("model_version"),
    stateHash: text("state_hash").notNull(),
    requestJson: text("request_json").notNull(),
    responseJson: text("response_json").notNull(),
    latencyMs: integer("latency_ms").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Locally estimated tokens, so we can watch proximity to the 32k/64k budgets. */
    estimatedTokens: integer("estimated_tokens").notNull().default(0),
    /** ok | error */
    status: text("status").notNull(),
    error: text("error"),
    dryRun: integer("dry_run", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("triage_runs_repo_item_idx").on(table.repo, table.itemNumber)],
);

/** Flattened answers, one row per question, for accuracy reporting. */
export const predictions = sqliteTable(
  "predictions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id")
      .notNull()
      .references(() => triageRuns.id, { onDelete: "cascade" }),
    questionId: text("question_id").notNull(),
    /** choice | score | noul | composite */
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    confidence: text("confidence"),
    /** Which issue a duplicate answer points at. */
    dupOfNumber: integer("dup_of_number"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("predictions_run_idx").on(table.runId)],
);

/** Actions the bot attempted, whether or not they were actually applied. */
export const actions = sqliteTable(
  "actions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id")
      .notNull()
      .references(() => triageRuns.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    itemNumber: integer("item_number").notNull(),
    actionType: text("action_type").notNull(),
    target: text("target"),
    payloadJson: text("payload_json").notNull(),
    /** false when skipped by dry-run or already satisfied. */
    applied: integer("applied", { mode: "boolean" }).notNull().default(false),
    skippedReason: text("skipped_reason"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("actions_run_idx").on(table.runId)],
);

/** Maintainer corrections, the ground truth behind precision/recall. */
export const corrections = sqliteTable(
  "corrections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repo: text("repo").notNull(),
    itemNumber: integer("item_number").notNull(),
    questionId: text("question_id").notNull(),
    predicted: text("predicted"),
    corrected: text("corrected"),
    actor: text("actor"),
    /** command | label_change */
    source: text("source").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("corrections_repo_question_idx").on(table.repo, table.questionId)],
);

/** Bounded audit log of received webhook deliveries. */
export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deliveryId: text("delivery_id"),
    event: text("event").notNull(),
    repo: text("repo"),
    payloadJson: text("payload_json").notNull(),
    receivedAt: text("received_at").notNull(),
  },
  (table) => [index("webhook_events_received_idx").on(table.receivedAt)],
);
