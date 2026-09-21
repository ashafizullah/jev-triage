/**
 * Idempotent DDL applied on boot. Kept as plain SQL (rather than drizzle-kit
 * migrations) so a fresh deployment starts working with no extra build step;
 * `npm run db:generate` remains available for future schema evolution.
 */
export const DDL = `
CREATE TABLE IF NOT EXISTS triage_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  item_number INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  model TEXT NOT NULL,
  model_version TEXT,
  state_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS triage_runs_repo_item_idx ON triage_runs (repo, item_number);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES triage_runs(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence TEXT,
  dup_of_number INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS predictions_run_idx ON predictions (run_id);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES triage_runs(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  item_number INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  target TEXT,
  payload_json TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  skipped_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS actions_run_idx ON actions (run_id);

CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  item_number INTEGER NOT NULL,
  question_id TEXT NOT NULL,
  predicted TEXT,
  corrected TEXT,
  actor TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS corrections_repo_question_idx ON corrections (repo, question_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT,
  event TEXT NOT NULL,
  repo TEXT,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_events_received_idx ON webhook_events (received_at);
`;
