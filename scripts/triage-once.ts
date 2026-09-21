/**
 * One-shot triage for a single issue or PR, without needing a live webhook.
 *
 *   npm run triage -- --repo owner/name --number 42            # dry run (default)
 *   npm run triage -- --repo owner/name --number 42 --apply    # write to GitHub
 *
 * Requires APP_ID, PRIVATE_KEY and TYPESAFE_API_KEY in the environment.
 */
import { Probot } from "probot";
import { loadConfigFromRepo } from "../src/config/load";
import { describeMissingCredentials, resolveProbotCredentials } from "../src/config/probotEnv";
import type { ItemType } from "../src/config/schema";
import { createDb } from "../src/db/client";
import { ingestItem } from "../src/pipeline/ingest";
import { createJevClient } from "../src/pipeline/jev/client";
import { runTriage } from "../src/pipeline/runTriage";
import { loadEnvFile } from "../src/util/env";
import { createLogger } from "../src/util/logger";

interface CliArgs {
  repo: string;
  number: number;
  dryRun: boolean;
  dbPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=");
      const key = rawKey ?? "";
      if (inlineValue !== undefined) {
        values.set(key, inlineValue);
      } else if (argv[i + 1] && !argv[i + 1]?.startsWith("--")) {
        values.set(key, argv[i + 1] as string);
        i += 1;
      } else {
        flags.add(key);
      }
    }
  }

  const repo = values.get("repo");
  const number = Number(values.get("number"));
  if (!repo || !repo.includes("/")) {
    throw new Error("Missing --repo owner/name");
  }
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("Missing or invalid --number");
  }

  return {
    repo,
    number,
    dryRun: !flags.has("apply"),
    dbPath: values.get("db") ?? process.env.JEV_TRIAGE_DB_PATH ?? "data/jev-triage.db",
  };
}

async function main(): Promise<void> {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));
  const [owner, repoName] = args.repo.split("/") as [string, string];
  const ref = { owner, repo: repoName };
  const log = createLogger({ level: process.env.LOG_LEVEL ?? "info" });

  const credentials = resolveProbotCredentials();
  const missing = describeMissingCredentials(credentials);
  if (missing.length > 0) {
    throw new Error(`Missing GitHub App configuration: ${missing.join(", ")}`);
  }

  const probot = new Probot({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    secret: credentials.secret,
  });
  await probot.ready();

  // `probot.auth()` with no installation id authenticates as the App, which is only good
  // for app-level APIs. Repository endpoints need an installation token, so resolve the
  // installation first and do every read with that client.
  const appOctokit = await probot.auth();
  const installation = await appOctokit.rest.apps.getRepoInstallation(ref);
  const octokit = await probot.auth(installation.data.id);

  const issue = await octokit.rest.issues.get({ ...ref, issue_number: args.number });
  const type: ItemType = issue.data.pull_request ? "pull_request" : "issue";

  const { config, issues, found } = await loadConfigFromRepo(octokit, ref);
  if (issues.length > 0) {
    log.warn({ issues }, "Invalid config values; those keys fall back to defaults");
  }

  const item = await ingestItem(octokit, ref, type, args.number);
  const handle = createDb(args.dbPath);
  const jev = createJevClient({ apiKey: process.env.TYPESAFE_API_KEY });

  const result = await runTriage(
    { octokit, ref, item, config, dryRun: args.dryRun },
    { jev, db: handle.db, log },
  );

  handle.close();

  if (!result) {
    console.log("Item skipped by configuration.");
    return;
  }

  console.log("");
  console.log(`#${item.number} ${item.title}`);
  console.log(`Config file: ${found ? ".github/jev-triage.yml" : "(defaults)"}`);
  console.log(`Mode: ${args.dryRun ? "DRY RUN (no writes)" : "APPLYING ACTIONS"}`);
  console.log(`Model: ${result.modelVersion}`);
  console.log(
    `Category: ${result.rationale.category} (${result.rationale.categoryConfidence.toFixed(2)}) · Severity: ${result.rationale.severity} · Info: ${result.rationale.info}`,
  );
  console.log(
    `Spam risk: ${result.rationale.spamRisk.toFixed(2)} · Gates: ${result.rationale.gates.join(", ") || "-"}`,
  );
  if (result.duplicate?.bestNumber) {
    console.log(
      `Top duplicate candidate: #${result.duplicate.bestNumber} (${result.duplicate.bestScore.toFixed(2)})`,
    );
  }
  console.log(
    `Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out (estimated ${result.estimatedTokens}) in ${result.latencyMs} ms`,
  );
  console.log("");
  console.log("Planned actions:");
  for (const entry of result.applied) {
    const status = entry.applied ? "applied" : `skipped (${entry.skippedReason ?? "n/a"})`;
    console.log(`  - ${entry.action.type} ${entry.target ?? ""} — ${status}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
