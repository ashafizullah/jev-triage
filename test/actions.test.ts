import { describe, expect, it } from "vitest";
import { applyActions } from "../src/pipeline/actions";
import type { PlannedAction } from "../src/pipeline/decide";
import { createLogger } from "../src/util/logger";
import { buildMarker } from "../src/util/marker";
import { makeItem } from "./helpers/fixtures";
import { createMockOctokit } from "./helpers/mockOctokit";

const log = createLogger({ silent: true });
const ref = { owner: "acme", repo: "demo" };
const notify = { slack: undefined, discord: undefined };
const botLogin = "jev-triage[bot]";

function writeCalls(octokit: ReturnType<typeof createMockOctokit>): string[] {
  return octokit.state.calls
    .map((call) => call.method)
    .filter((method) =>
      [
        "issues.addLabels",
        "issues.removeLabel",
        "issues.createComment",
        "issues.updateComment",
        "issues.update",
        "issues.addAssignees",
      ].includes(method),
    );
}

describe("applyActions", () => {
  it("writes nothing in dry-run mode", async () => {
    const octokit = createMockOctokit();
    const actions: PlannedAction[] = [
      { type: "add_label", label: "bug", reason: "test" },
      { type: "comment", kind: "triage", body: "hello", reason: "test" },
      { type: "close", reason: "test" },
    ];

    const results = await applyActions(
      octokit as never,
      ref,
      makeItem(),
      actions,
      { dryRun: true, runKey: "run-1", botLogin, notify },
      log,
    );

    expect(results.every((entry) => !entry.applied)).toBe(true);
    expect(results.every((entry) => entry.skippedReason === "dry-run")).toBe(true);
    expect(octokit.state.labels).toEqual([]);
    expect(octokit.state.comments).toEqual([]);
    expect(octokit.state.closed).toBe(false);
    expect(writeCalls(octokit)).toEqual([]);
  });

  it("adds a label once and skips it when already present", async () => {
    const octokit = createMockOctokit({ labels: ["bug"] });
    const results = await applyActions(
      octokit as never,
      ref,
      makeItem({ existingLabels: ["bug"] }),
      [
        { type: "add_label", label: "bug", reason: "test" },
        { type: "add_label", label: "needs-info", reason: "test" },
      ],
      { dryRun: false, runKey: "run-2", botLogin, notify },
      log,
    );

    expect(results[0]?.applied).toBe(false);
    expect(results[0]?.skippedReason).toBe("label-already-present");
    expect(results[1]?.applied).toBe(true);
    expect(octokit.state.labels).toEqual(["bug", "needs-info"]);
  });

  it("creates a comment, then updates its own comment on a later run", async () => {
    const octokit = createMockOctokit();
    const actions: PlannedAction[] = [
      { type: "comment", kind: "triage", body: "first", reason: "test" },
    ];

    await applyActions(
      octokit as never,
      ref,
      makeItem(),
      actions,
      { dryRun: false, runKey: "run-a", botLogin, notify },
      log,
    );
    expect(octokit.state.comments).toHaveLength(1);

    await applyActions(
      octokit as never,
      ref,
      makeItem(),
      [{ type: "comment", kind: "triage", body: "second", reason: "test" }],
      { dryRun: false, runKey: "run-b", botLogin, notify },
      log,
    );

    expect(octokit.state.comments).toHaveLength(1);
    expect(octokit.state.comments[0]?.body).toContain("second");
    expect(octokit.state.comments[0]?.body).toContain(
      buildMarker({ v: 1, kind: "triage", runKey: "run-b" }),
    );
  });

  it("ignores markers written by other bots when looking for its own comment", async () => {
    const octokit = createMockOctokit({
      comments: [
        {
          id: 5,
          body: `someone else\n${buildMarker({ v: 1, kind: "triage", runKey: "other" })}`,
          user: { login: "other-bot", type: "Bot" },
        },
      ],
    });

    await applyActions(
      octokit as never,
      ref,
      makeItem(),
      [{ type: "comment", kind: "triage", body: "mine", reason: "test" }],
      { dryRun: false, runKey: "run-c", botLogin, notify },
      log,
    );

    expect(octokit.state.comments).toHaveLength(2);
    expect(octokit.state.comments[1]?.body).toContain("mine");
  });

  it("closes and assigns for real when not in dry-run", async () => {
    const octokit = createMockOctokit();
    const results = await applyActions(
      octokit as never,
      ref,
      makeItem(),
      [
        { type: "close", reason: "test" },
        { type: "assign", assignees: ["alice"], reason: "test" },
      ],
      { dryRun: false, runKey: "run-d", botLogin, notify },
      log,
    );

    expect(octokit.state.closed).toBe(true);
    expect(octokit.state.assigned).toEqual(["alice"]);
    expect(results.every((entry) => entry.applied)).toBe(true);
  });

  it("reports a notification as skipped when no webhook is configured", async () => {
    const octokit = createMockOctokit();
    const results = await applyActions(
      octokit as never,
      ref,
      makeItem(),
      [{ type: "notify", reason: "critical", message: "hi" }],
      { dryRun: false, runKey: "run-e", botLogin, notify },
      log,
    );

    expect(results[0]?.applied).toBe(false);
    expect(results[0]?.skippedReason).toBe("no-webhook-configured");
  });

  it("creates a missing label, then retries the add", async () => {
    const octokit = createMockOctokit();
    const addLabels = octokit.rest.issues.addLabels;
    let attempts = 0;
    octokit.rest.issues.addLabels = async (params: any) => {
      attempts += 1;
      // First call mimics GitHub rejecting a label that does not exist yet.
      if (attempts === 1) throw Object.assign(new Error("Not Found"), { status: 404 });
      return addLabels(params);
    };

    const results = await applyActions(
      octokit as never,
      ref,
      makeItem(),
      [{ type: "add_label", label: "needs-triage", reason: "test" }],
      { dryRun: false, runKey: "run-g", botLogin, notify },
      log,
    );

    expect(octokit.state.calls.some((call) => call.method === "issues.createLabel")).toBe(true);
    expect(attempts).toBe(2);
    expect(results[0]?.applied).toBe(true);
    expect(octokit.state.labels).toEqual(["needs-triage"]);
  });

  it("only falls back to creating a label on a 404", async () => {
    const octokit = createMockOctokit();
    octokit.rest.issues.addLabels = async () => {
      throw Object.assign(new Error("Server Error"), { status: 500 });
    };

    const results = await applyActions(
      octokit as never,
      ref,
      makeItem(),
      [{ type: "add_label", label: "bug", reason: "test" }],
      { dryRun: false, runKey: "run-h", botLogin, notify },
      log,
    );

    expect(octokit.state.calls.some((call) => call.method === "issues.createLabel")).toBe(false);
    expect(results[0]?.applied).toBe(false);
    expect(results[0]?.skippedReason).toBe("Server Error");
  });

  it("records a failure without throwing when the API rejects an action", async () => {
    const octokit = createMockOctokit();
    octokit.rest.issues.addLabels = async () => {
      throw new Error("label not found");
    };

    const results = await applyActions(
      octokit as never,
      ref,
      makeItem(),
      [{ type: "add_label", label: "ghost", reason: "test" }],
      { dryRun: false, runKey: "run-f", botLogin, notify },
      log,
    );

    expect(results[0]?.applied).toBe(false);
    expect(results[0]?.skippedReason).toBe("label not found");
  });
});
