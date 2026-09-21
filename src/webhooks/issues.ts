import type { Context } from "probot";
import { isBotSender, triageFromContext } from "./shared";

export async function handleIssueOpened(context: Context<"issues.opened">): Promise<void> {
  if (isBotSender(context)) return;
  await triageFromContext(context, "issue", context.payload.issue.number, "opened");
}

export async function handleIssueEdited(context: Context<"issues.edited">): Promise<void> {
  if (isBotSender(context)) return;
  await triageFromContext(context, "issue", context.payload.issue.number, "edited");
}

export async function handleIssueReopened(context: Context<"issues.reopened">): Promise<void> {
  if (isBotSender(context)) return;
  await triageFromContext(context, "issue", context.payload.issue.number, "reopened");
}
