import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type JevTriageConfig } from "../src/config/schema";
import { type TriageTrigger, resolveSkipReason } from "../src/webhooks/policy";

function config(overrides: Partial<JevTriageConfig> = {}): JevTriageConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function check(
  type: "issue" | "pull_request",
  trigger: TriageTrigger,
  isDraft: boolean | undefined,
  overrides: Partial<JevTriageConfig> = {},
): string | null {
  return resolveSkipReason(type, trigger, isDraft, config(overrides));
}

describe("resolveSkipReason", () => {
  it("skips everything when the repository is disabled", () => {
    expect(check("issue", "opened", undefined, { enabled: false })).toBe("disabled");
    expect(check("pull_request", "opened", false, { enabled: false })).toBe("disabled");
  });

  it("triages issues and pull requests by default", () => {
    expect(check("issue", "opened", undefined)).toBeNull();
    expect(check("pull_request", "opened", false)).toBeNull();
  });

  it("honours the per-kind switches", () => {
    const noIssues = { triage: { ...DEFAULT_CONFIG.triage, issues: false } };
    const noPulls = { triage: { ...DEFAULT_CONFIG.triage, pullRequests: false } };

    expect(check("issue", "opened", undefined, noIssues)).toBe("issues-disabled");
    expect(check("pull_request", "opened", false, noIssues)).toBeNull();
    expect(check("pull_request", "opened", false, noPulls)).toBe("pull-requests-disabled");
    expect(check("issue", "opened", undefined, noPulls)).toBeNull();
  });

  it("does not re-triage on every push unless asked to", () => {
    expect(check("pull_request", "synchronize", false)).toBe("pull-request-push-disabled");
    expect(
      check("pull_request", "synchronize", false, {
        triage: { ...DEFAULT_CONFIG.triage, onPullRequestPush: true },
      }),
    ).toBeNull();

    // Other triggers are unaffected by that switch.
    expect(check("pull_request", "opened", false)).toBeNull();
    expect(check("pull_request", "edited", false)).toBeNull();
  });

  it("skips draft pull requests unless asked to include them", () => {
    expect(check("pull_request", "opened", true)).toBe("draft-pull-request");
    expect(
      check("pull_request", "opened", true, {
        triage: { ...DEFAULT_CONFIG.triage, includeDrafts: true },
      }),
    ).toBeNull();
  });

  it("does not skip when the draft state is unknown", () => {
    // Non-PR events carry no draft flag; assuming "draft" would silently disable triage.
    expect(check("pull_request", "edited", undefined)).toBeNull();
    expect(check("pull_request", "reopened", undefined)).toBeNull();
  });

  it("lets an explicit maintainer request override the scope switches", () => {
    const scopeOff = {
      triage: { ...DEFAULT_CONFIG.triage, issues: false, pullRequests: false },
    };
    expect(check("issue", "retriage", undefined, scopeOff)).toBeNull();
    expect(check("pull_request", "retriage", true, scopeOff)).toBeNull();
  });

  it("keeps the master switch absolute, even for an explicit request", () => {
    // `enabled: false` means the app is off for this repository: nothing runs at all.
    expect(check("issue", "retriage", undefined, { enabled: false })).toBe("disabled");
    expect(check("pull_request", "retriage", true, { enabled: false })).toBe("disabled");
  });
});
