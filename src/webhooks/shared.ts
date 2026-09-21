import type { Context } from "probot";
import { loadConfig } from "../config/load";
import type { ItemType } from "../config/schema";
import { getDb } from "../db/client";
import { webhookEvents } from "../db/schema";
import { repoFullName } from "../github/types";
import { ingestItem } from "../pipeline/ingest";
import { runTriage } from "../pipeline/runTriage";
import { createTriageDeps } from "../runtime";
import { type TriageTrigger, resolveSkipReason } from "./policy";

/**
 * Probot types the unparameterised `Context.payload` as a discriminated union, so we
 * narrow to the handful of fields shared by every event we subscribe to.
 */
interface LoosePayload {
  action?: string;
  installation?: { id?: number };
  repository?: { full_name?: string };
  sender?: { type?: string; login?: string };
  pull_request?: { number?: number; draft?: boolean };
}

function payloadOf(context: Context): LoosePayload {
  return context.payload as unknown as LoosePayload;
}

const botLoginCache = new Map<number, string | null>();

/**
 * The bot's own login (`<app-slug>[bot]`). Needed to recognise our markers and to
 * ignore the events our own comments and labels produce.
 */
async function resolveBotLogin(context: Context): Promise<string | null> {
  const installationId = payloadOf(context).installation?.id;
  if (!installationId) return null;
  const cached = botLoginCache.get(installationId);
  if (cached !== undefined) return cached;

  let login: string | null = null;
  try {
    const { data } = await context.octokit.rest.apps.getAuthenticated();
    const slug = (data as { slug?: string } | null)?.slug;
    login = slug ? `${slug}[bot]` : null;
  } catch {
    login = null;
  }
  botLoginCache.set(installationId, login);
  return login;
}

export function isBotSender(context: Context): boolean {
  return payloadOf(context).sender?.type === "Bot";
}

function recordDelivery(context: Context): void {
  try {
    const payload = payloadOf(context);
    getDb()
      .db.insert(webhookEvents)
      .values({
        deliveryId: context.id ?? null,
        event: context.name ?? "unknown",
        repo: payload.repository?.full_name ?? null,
        payloadJson: JSON.stringify({ action: payload.action }),
        receivedAt: new Date().toISOString(),
      })
      .run();
  } catch (err) {
    context.log.debug({ err }, "Could not record webhook delivery");
  }
}

export type { TriageTrigger };

/**
 * Shared entry point for every webhook that should trigger triage. Errors are
 * caught and logged so a single bad payload never takes the app down.
 */
export async function triageFromContext(
  context: Context,
  type: ItemType,
  number: number,
  trigger: TriageTrigger,
): Promise<void> {
  const log = context.log;
  const ref = context.repo();
  recordDelivery(context);

  try {
    const config = await loadConfig(context);

    const skipReason = resolveSkipReason(
      type,
      trigger,
      payloadOf(context).pull_request?.draft,
      config,
    );
    if (skipReason) {
      log.debug({ repo: repoFullName(ref), number, trigger, skipReason }, "Skipping triage");
      return;
    }

    const item = await ingestItem(context.octokit, ref, type, number);
    const deps = createTriageDeps(log);
    const result = await runTriage(
      {
        octokit: context.octokit,
        ref,
        item,
        config,
        botLogin: await resolveBotLogin(context),
      },
      deps,
    );

    if (result) {
      log.debug(
        { runId: result.runId, trigger, gates: result.rationale.gates },
        "Triage run recorded",
      );
    }
  } catch (err) {
    log.error({ err, repo: repoFullName(ref), number, trigger }, "Triage failed");
  }
}
