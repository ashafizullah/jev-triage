<div align="center">

# jev-triage

**Automated issue & PR triage for open-source maintainers, powered by [Jev](https://docs.typesafe.ai) (TypeSafe AI).**

[![CI](https://github.com/ashafizullah/jev-triage/actions/workflows/ci.yml/badge.svg)](https://github.com/ashafizullah/jev-triage/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](./package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](./tsconfig.json)

</div>

---

An incoming issue or pull request is classified, scored, checked for missing information, compared against existing items for duplicates, and then labelled — with every uncertain decision routed to a human instead of guessed at.

## What it does

- **Classifies** the item: `bug`, `feature_request`, `question`, `documentation`, `spam`, `other`
- **Scores impact** on a four-level rubric and derives a severity
- **Checks completeness**: reproduction steps, version info, environment, expected behaviour
- **Detects duplicates** against open items, using a local lexical prefilter plus Jev verification
- **Applies labels and leaves one comment**, updating it on re-runs instead of posting again
- **Notifies Slack, Discord or Telegram** for critical or spam findings
- **Learns from corrections**: maintainer overrides are stored as ground truth for an accuracy report

## Why Jev

Triage decisions are a closed set — a category, a severity, a boolean — not free text. Jev answers typed questions against a state and returns typed answers with calibrated probabilities, in one parallel request, without generating a single token to parse. That makes it both cheaper and more reliable than coercing a large language model into emitting JSON.

## How it works

```
GitHub webhook (issues / issue_comment / pull_request)
        │
        ▼  Probot app (signature verification, event routing)
   Ingestion ──► store a bounded audit record
        │
        ▼
   Preprocessor ──► clean the text, collect metadata (labels, author, first-time?, diff)
        │
        ▼
   Jev fan-out #1 ──► category · impact · completeness · spam signals · needs-human-review
        │
        ▼
   Duplicate candidates ──► one list call → lexical prefilter → top K
        │
        ▼
   Jev fan-out #2 ──► one Noul question per candidate → 0..1 duplicate score
        │
        ▼
   Decision engine ──► composite spam risk + confidence gates → planned actions
        │
        ├──► GitHub: labels, comment, close, assign
        └──► Slack / Discord / Telegram
        │
        ▼
   SQLite ──► predictions, actions, corrections → accuracy report
```

Every question and criterion is written in English on purpose: Jev's primary training language is English, and other languages currently score lower accuracy.

## Running it locally

### 1. Get a Jev API key

Create a key at <https://console.typesafe.ai/keys> and put it in `.env` as `TYPESAFE_API_KEY`.

That is the only Jev setting required — the SDK already defaults to `https://api.typesafe.ai`, so
there is no URL to configure (`TYPESAFE_BASE_URL` exists only for routing through a gateway).

The Probot setup wizard fills in every GitHub credential (`APP_ID`, `PRIVATE_KEY`,
`WEBHOOK_SECRET`, `WEBHOOK_PROXY_URL`) but not the Jev key, so this is the one line you always
add by hand.

### 2. Start the dev server

```bash
npm install --include=dev
cp .env.example .env
npm run dev
```

`npm run dev` runs `src/dev.ts`, which uses Probot's `run()` so you get the setup wizard
and the webhook tunnel. It listens on <http://localhost:3000>.

> Use `--include=dev` if your shell exports `NODE_ENV=production`, otherwise npm skips the
> dev dependencies (typescript, vitest, tsx) and nothing will run.

### 3. Register the GitHub App

Open <http://localhost:3000>. It redirects to `/probot`, which offers **Register a GitHub App**.
That flow creates the app with the permissions below, creates a smee.io channel, and writes
`APP_ID`, `WEBHOOK_SECRET`, `PRIVATE_KEY` and `WEBHOOK_PROXY_URL` into your `.env` for you.

Then press `Ctrl+C` and run `npm run dev` again — Probot only reads `.env` at startup.

Required permissions: **Issues: Read & write**, **Pull requests: Read & write**, **Contents: Read**, **Metadata: Read** (add **Members: Read** only if you enable `suggestReviewers`). Subscribed events: `issues`, `issue_comment`, `pull_request`.

Prefer to do it by hand? Create the app from [`app.yml`](./app.yml), then set `APP_ID`,
`WEBHOOK_SECRET` and `PRIVATE_KEY` in `.env` yourself and point the app's webhook URL at
your own smee channel (`WEBHOOK_PROXY_URL`).

### 4. Point it at a repository

After restarting, the log shows the smee channel it is forwarding from. For a persistent
webhook URL, create a channel at <https://smee.io> and set `WEBHOOK_PROXY_URL` to it.

Install the app on a sandbox repository and open an issue there. The bot labels it and
leaves one comment. Sanity-check the server is up with:

```bash
curl http://localhost:3000/healthz
```

### 5. Try it without webhooks

Useful for iterating without touching GitHub:

```bash
# Dry run: prints the decision, confidence values and the actions it would take.
npm run triage -- --repo owner/sandbox --number 42

# Actually apply labels and comments.
npm run triage -- --repo owner/sandbox --number 42 --apply
```

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Missing GitHub App configuration: APP_ID, PRIVATE_KEY, WEBHOOK_SECRET` | `.env` is not filled in; run the setup wizard at `/probot` |
| The setup wizard never appears | `NODE_ENV=production` forces production mode, which requires credentials |
| `tsc`/`vitest` not found | dev dependencies were skipped — `npm install --include=dev` |
| Webhooks never arrive | the app's webhook URL must point at the same smee channel as `WEBHOOK_PROXY_URL` |
| After "Register a GitHub App", GitHub redirects to `your-host.example` and nothing is configured | `app.yml` has `redirect_url` / `hook_attributes` set: Probot spreads `app.yml` over the manifest it generates, so those override the localhost values. Remove them (see the comments in `app.yml`) |
| Nothing happens on an issue | the item carries a label from `ignore.labels` (default `skip-triage`), or `enabled` is false |

## Configuration

Copy [`.github/jev-triage.yml.example`](.github/jev-triage.yml.example) to `.github/jev-triage.yml` in the repository you are triaging. Every key is optional; the file is validated with zod and invalid values fall back to their defaults.

Label names in `labels:` are created automatically (with a neutral colour) the first time the bot applies them, so a fresh repository needs no manual label setup. Rename them here and the bot will create the new names instead.

The most important knobs:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for the repository; nothing runs when false |
| `dryRun` | `false` | Log actions without writing to GitHub |
| `allowAutoClose` | `false` | Permit closing high-confidence spam |
| `triage.issues` | `true` | Triage issues automatically |
| `triage.pullRequests` | `true` | Triage pull requests automatically |
| `triage.onPullRequestPush` | `false` | Re-run triage on every commit pushed to a PR |
| `triage.includeDrafts` | `false` | Triage draft PRs as well |
| `thresholds.actMin` | `0.6` | Confidence below which a human is asked |
| `thresholds.duplicateComment` | `0.85` | Duplicate score needed to also leave a comment |
| `duplicates.maxCandidates` | `6` | Candidates sent to the Jev verification call |
| `ignore.labels` | `["skip-triage"]` | Items with these labels are never triaged |

### Notifications

Set whichever destinations you want; each is used independently and a failing one never
fails triage.

| Destination | Variables |
| --- | --- |
| Slack | `SLACK_WEBHOOK_URL` |
| Discord | `DISCORD_WEBHOOK_URL` |
| Telegram | `TELEGRAM_BOT_TOKEN` **and** `TELEGRAM_CHAT_ID` (plus optional `TELEGRAM_API_BASE` for a self-hosted Bot API server) |

Telegram is not a webhook URL: create a bot with [@BotFather](https://t.me/BotFather), then
message it and read the chat id from `getUpdates` — or add the bot to a group and use that
group id, which is negative. Messages are sent as plain text, so an issue title containing
`_` or `*` cannot break Telegram's Markdown parser, and a half-configured pair is skipped
with a warning instead of silently doing nothing.

Which findings trigger a message is controlled by `notify.on` (default: `critical` and `spam`).

### Choosing the model

`jev-latest` can shift behaviour between releases, so pin a concrete version if your
thresholds are sensitive. Precedence, most specific first:

1. `model:` in a repository's `.github/jev-triage.yml`
2. the `JEV_MODEL` environment variable (deployment-wide default)
3. `jev-latest`

### When triage runs

| Event | Triaged? |
| --- | --- |
| Issue opened / edited / reopened | yes |
| Pull request opened | yes, unless it is a draft and `includeDrafts` is false |
| Pull request edited / reopened | yes |
| Pull request marked ready for review | yes |
| Commit pushed to a pull request | only when `onPullRequestPush` is true |
| `/jev retriage` in a comment | yes, by a user with write access |

`enabled: false` is absolute — not even `/jev retriage` runs. The `triage.*` options only
scope the automation, so an explicit maintainer request bypasses them.

### Decision rules

| Condition | Action |
| --- | --- |
| Category confidence `< actMin`, model asks for a human, or spam risk inside the uncertain band | `needs-triage` label, nothing else |
| Spam risk `≥ 0.6` and `allowAutoClose` and confidence `≥ autoCloseSpam` | Close + polite comment + `spam` label |
| Spam risk `≥ 0.6` but less confident | `spam` + `needs-triage`, never closed |
| Missing information | Comment requesting the specific gap + `needs-info` label |
| Duplicate score `≥ 0.85` / `≥ 0.75` | `possible-duplicate` label, plus a comment at the higher threshold |
| Critical severity with adequate confidence | `priority:critical` label + notification |
| Otherwise | Category label (+ an extra suggested label) |

Destructive actions are off by default. Nothing is ever closed except high-confidence spam when you explicitly opt in.

### Maintainer overrides

Anyone with write access can correct a decision in a comment on the item:

- `/jev reclassify <category>` — override the category and fix the labels
- `/jev not-duplicate` — clear a duplicate suggestion
- `/jev retriage` — run triage again
- `/jev explain` — show the last decision, its answers and confidences

Corrections are stored and used as ground truth in the accuracy report. Removing a label the bot applied counts as a correction too.

## Reporting

There is no admin UI and no extra network surface: reports are generated from the local
SQLite database, either as text or as a self-contained HTML file.

```bash
# Text summary in the terminal (default)
npm run report -- --repo owner/name

# Static HTML dashboard — no scripts, no external assets, works offline
npm run report -- --repo owner/name --format html
#   -> reports/owner-name-YYYY-MM-DD.html

# Machine-readable, or write the text form to a file
npm run report -- --repo owner/name --format csv --out reports/jev.csv
```

`--out` implies the format from its extension (`.html`, `.csv`, `.txt`), and `--limit`
controls how many recent runs and corrections are included.

The text form prints precision/recall per category plus volume, latency and token usage:

```
Items triaged: 128
Items with maintainer corrections: 9
Automated label/close actions applied: 131
Median triage latency: 380 ms
Jev tokens: 412300 in / 41020 out across 128 runs (1416000 estimated)

category            precision  recall  support  tp  fp  fn
------------------  ---------  ------  -------  --  --  --
bug                     0.947   0.964       56  54   3   2
feature_request         0.923   0.857       28  24   2   4
```

Uncorrected predictions count as correct, so these numbers are a lower bound: the report can only penalise the bot for corrections you actually observed.

The HTML report adds a recent-runs table (including the `gates` that fired and whether the run
was a dry run), an action table with the reason each action was skipped, and the list of
maintainer corrections — useful for answering "why did nothing happen on that issue?".

**Keep the report local.** It lists issue numbers and decision details from the repository.

## Deployment

```bash
docker compose up --build
```

The container listens on `3000`, exposes `/healthz`, and keeps SQLite in a named volume. Set `HOST=0.0.0.0` (already the default in the image) so the port is reachable from outside the container.

For a hosted deployment, point the GitHub App's webhook URL at `https://your-host/api/github/webhooks` and provide `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`, `TYPESAFE_API_KEY` and `JEV_TRIAGE_DB_PATH` as environment variables.

## Costs and limits

Jev ingests the state once and evaluates every question against it in parallel:

| Limit | Value |
| --- | --- |
| Budget per request (state + all questions) | 64,000 tokens |
| Budget (state + single longest question) | 32,000 tokens |
| Rate limit | 250,000 tokens/second, 1,200 requests/minute |

The pipeline stays far inside those bounds: the item body is capped at 8,000 characters and each duplicate candidate at a 200-character title plus a 400-character excerpt, with a `budget.maxTotalEstimatedTokens` guard that trims excerpts — then drops candidates — if a request would grow too large. Actual token usage is recorded on every run so you can watch the trend.

## Development

```bash
npm run dev        # src/dev.ts via tsx watch: setup wizard + smee tunnel
npm run typecheck  # tsc --noEmit
npm run lint       # biome check
npm test           # vitest
npm run build      # bundle to dist/ (production entry: src/index.ts)
```

Tests run entirely offline: GitHub is replaced by an in-process Octokit double and Jev by an injectable `JevClient`, so the whole decision pipeline — including the rule matrix, confidence gates, duplicate pass and idempotency — is covered without network access.

### Layout

```
src/
  app.ts                  Probot event wiring
  dev.ts                  local entry point (setup wizard + webhook tunnel)
  index.ts                production server bootstrap + /healthz
  config/                 zod schema, per-repo loading, GitHub App credentials
  webhooks/               issues, pull requests, comments, label events
  pipeline/
    ingest.ts             fetch an item with its metadata
    preprocess.ts         clean text, build the Jev state
    candidates.ts         comparison pool
    similarity.ts         lexical prefilter (tf-idf cosine + title trigrams)
    jev/                  client wrapper, question builders, token budget
    decide.ts             composite scoring + confidence-gated rules
    actions.ts            idempotent GitHub writes
    notify.ts             Slack, Discord and Telegram
    runTriage.ts          orchestrator
  db/                     drizzle schema, client, queries
  metrics/accuracy.ts     precision/recall report
scripts/
  triage-once.ts          one-shot CLI
  report.ts               accuracy report CLI
```

## Privacy

The raw webhook payload is not stored; only the delivery id, event name, action and repository name are kept for auditing. Issue and PR text is sent to the TypeSafe API to be evaluated and the resulting decisions are stored in your local SQLite database. Delete `data/` to erase all local history.

## Security

`npm audit --omit=dev` reports **0 vulnerabilities** in the shipped dependency tree.

The full tree (including dev dependencies) reports one low-severity advisory:
`tsup` pins `esbuild@^0.27.0`, and versions 0.27.3–0.28.0 have an arbitrary-file-read
issue that only affects `esbuild`'s **development server** on Windows. This project never
runs that server — tsup is used purely to bundle `dist/` at build time — so it is not
reachable here. Clearing it would require forcing `esbuild` outside the range tsup declares,
which is a worse trade than carrying a low, non-reachable advisory.

One override worth knowing about:

- `@esbuild-kit/core-utils` → `esbuild@^0.25.4`: that package is deprecated and hard-pins
  `esbuild@~0.18.20`, which is vulnerable. `drizzle-kit` pulls it in transitively; the override
  is verified working via `npm run db:generate`.

Probot's webhook signature verification is enabled by `WEBHOOK_SECRET`; keep it set in
production. The service never writes raw webhook payloads to disk — see [Privacy](#privacy).

## License

[MIT](./LICENSE) © Adam Suchi Hafizullah
