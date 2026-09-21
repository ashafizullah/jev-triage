import type { ApplicationFunctionOptions, Probot } from "probot";
import { healthHandler } from "./health";
import { handleIssueComment } from "./webhooks/issueComments";
import { handleIssueEdited, handleIssueOpened, handleIssueReopened } from "./webhooks/issues";
import { handleIssueUnlabeled } from "./webhooks/labelEvents";
import {
  handlePullRequestEdited,
  handlePullRequestOpened,
  handlePullRequestReadyForReview,
  handlePullRequestReopened,
  handlePullRequestSynchronize,
} from "./webhooks/pullRequests";

/**
 * Probot application. Every GitHub event the app subscribes to is wired here;
 * each handler is deliberately thin and delegates to the shared triage pipeline.
 */
export function app(probot: Probot, options: ApplicationFunctionOptions): void {
  options.addHandler(healthHandler);

  probot.on("issues.opened", handleIssueOpened);
  probot.on("issues.edited", handleIssueEdited);
  probot.on("issues.reopened", handleIssueReopened);
  probot.on("issues.unlabeled", handleIssueUnlabeled);

  probot.on("issue_comment.created", handleIssueComment);

  probot.on("pull_request.opened", handlePullRequestOpened);
  probot.on("pull_request.edited", handlePullRequestEdited);
  probot.on("pull_request.reopened", handlePullRequestReopened);
  probot.on("pull_request.synchronize", handlePullRequestSynchronize);
  probot.on("pull_request.ready_for_review", handlePullRequestReadyForReview);
}
