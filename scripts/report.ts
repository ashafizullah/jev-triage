/**
 * Report on stored triage activity. Reads only the local SQLite database.
 *
 *   npm run report -- --repo owner/name
 *   npm run report -- --repo owner/name --format html            # writes a static .html file
 *   npm run report -- --repo owner/name --out reports/jev.csv --format csv
 *
 * The HTML report is fully self-contained (no scripts, no external assets), so it can be
 * opened straight from disk. It contains issue numbers and decision details, so keep it
 * local rather than publishing it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createDb } from "../src/db/client";
import { buildAccuracyReport, formatAccuracyReport, reportToCsv } from "../src/metrics/accuracy";
import { buildReportModel, renderHtmlReport } from "../src/metrics/report";
import { loadEnvFile } from "../src/util/env";

type Format = "text" | "csv" | "html";

const FORMATS: readonly Format[] = ["text", "csv", "html"];

interface CliArgs {
  repo: string;
  dbPath: string;
  format: Format;
  out?: string;
  limit: number;
}

function isFormat(value: string): value is Format {
  return (FORMATS as readonly string[]).includes(value);
}

function formatFromExtension(path: string): Format | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text";
  return null;
}

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const [rawKey, inlineValue] = token.slice(2).split("=");
    const key = rawKey ?? "";
    if (inlineValue !== undefined) {
      values.set(key, inlineValue);
    } else if (argv[i + 1] && !argv[i + 1]?.startsWith("--")) {
      values.set(key, argv[i + 1] as string);
      i += 1;
    }
  }

  const repo = values.get("repo");
  if (!repo || !repo.includes("/")) {
    throw new Error("Missing --repo owner/name");
  }

  const rawFormat = values.get("format");
  if (rawFormat && !isFormat(rawFormat)) {
    throw new Error(`Unknown --format ${rawFormat}. Use one of: ${FORMATS.join(", ")}`);
  }

  const out = values.get("out");
  // Infer the format from the output extension unless --format says otherwise.
  const format: Format =
    (rawFormat as Format | undefined) ?? (out ? (formatFromExtension(out) ?? "text") : "text");

  const limit = Number(values.get("limit") ?? 25);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("--limit must be a positive integer");
  }

  return {
    repo,
    dbPath: values.get("db") ?? process.env.JEV_TRIAGE_DB_PATH ?? "data/jev-triage.db",
    format,
    out,
    limit,
  };
}

function defaultOutPath(repo: string, format: Format): string {
  const [owner, name] = repo.split("/");
  const stamp = new Date().toISOString().slice(0, 10);
  return `reports/${owner}-${name}-${stamp}.${format === "html" ? "html" : "csv"}`;
}

/** Creates the parent directory, so `reports/…` and nested paths just work. */
function writeReport(path: string, contents: string): void {
  const parent = dirname(path);
  if (parent && parent !== ".") mkdirSync(parent, { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function main(): void {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));

  const handle = createDb(args.dbPath);

  if (args.format === "html") {
    const model = buildReportModel(handle.db, args.repo, { limit: args.limit });
    handle.close();

    const out = args.out ?? defaultOutPath(args.repo, "html");
    writeReport(out, renderHtmlReport(model));
    console.log(`HTML report written to ${out}`);
    console.log(
      `${model.recentRuns.length} recent runs, ${model.corrections.length} corrections, ` +
        `${model.actionSummary.length} action kinds included.`,
    );
    console.log("Keep this file local: it lists issue numbers and decision details.");
    return;
  }

  const report = buildAccuracyReport(handle.db, args.repo);
  handle.close();

  const payload = args.format === "csv" ? reportToCsv(report) : formatAccuracyReport(report);
  console.log(payload);

  if (args.out) {
    writeReport(args.out, `${payload}\n`);
    console.log("");
    console.log(`Written to ${args.out}`);
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
