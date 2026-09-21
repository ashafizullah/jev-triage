import type { Context } from "probot";
import { isBotSender, triageFromContext } from "./shared";

export async function handlePullRequestOpened(
  context: Context<"pull_request.opened">,
): Promise<void> {
  if (isBotSender(context)) return;
  await triageFromContext(context, "pull_request", context.payload.pull_request.number, "opened");
}

export async function handlePullRequestEdited(
  context: Context<"pull_request.edited">,
): Promise<void> {
  if (isBotSender(context)) return;
  await triageFromContext(context, "pull_request", context.payload.pull_request.number, "edited");
}

export async function handlePullRequestReopened(
  context: Context<"pull_request.reopened">,
): Promise<void> {
  if (isBotSender(context)) return;
  await triageFromContext(context, "pull_request", context.payload.pull_request.number, "reopened");
}

/**
 * Fires on every commit pushed to the branch. Triage re-runs only when
 * `triage.onPullRequestPush` is enabled, since each run costs another Jev call.
 */
export async function handlePullRequestSynchronize(
  context: Context<"pull_request.synchronize">,
): Promise<void> {
  if (isBotSender(context)) return;
  await triageFromContext(
    context,
    "pull_request",
    context.payload.pull_request.number,
    "synchronize",
  );
}

export async function handlePullRequestReadyForReview(
  context: Context<"pull_request.ready_for_review">,
): Promise<void> {
  if (isBotSender(context)) return;
  await triageFromContext(
    context,
    "pull_request",
    context.payload.pull_request.number,
    "ready_for_review",
  );
}
