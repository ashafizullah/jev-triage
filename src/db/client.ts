import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { DDL } from "./migrate";
import * as schema from "./schema";

export interface DbHandle {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: Database.Database;
  close: () => void;
}

function ensureParentDir(path: string): void {
  if (path === ":memory:" || path.startsWith("file:")) return;
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Opens (and if needed creates) the SQLite database, applying the idempotent DDL.
 * Pass ":memory:" for tests.
 */
export function createDb(path: string): DbHandle {
  ensureParentDir(path);
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(DDL);

  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}

export type Db = DbHandle["db"];

/** Lazily-created singleton used by the webhook handlers. */
let shared: DbHandle | null = null;

export function getDb(path = process.env.JEV_TRIAGE_DB_PATH ?? "data/jev-triage.db"): DbHandle {
  if (!shared) {
    shared = createDb(path);
  }
  return shared;
}

export function closeSharedDb(): void {
  shared?.close();
  shared = null;
}
