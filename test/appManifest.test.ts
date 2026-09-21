import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Probot's setup wizard reads `app.yml` and spreads it over the manifest it generates,
 * so keys here win. `redirect_url` and `hook_attributes` must therefore stay out of the
 * file: with a placeholder host they send the OAuth callback — and every webhook — to a
 * domain that does not exist, and the manifest `code` never gets exchanged for an app id.
 *
 * Probot fills both in from the running server and the smee channel instead.
 */
describe("app.yml", () => {
  const manifest = parse(readFileSync(new URL("../app.yml", import.meta.url), "utf8")) as Record<
    string,
    any
  >;

  it("leaves the host-specific manifest keys to Probot", () => {
    expect(manifest).not.toHaveProperty("redirect_url");
    expect(manifest).not.toHaveProperty("hook_attributes");
    expect(manifest).not.toHaveProperty("setup_url");
  });

  it("keeps the values the app actually needs", () => {
    expect(manifest.name).toBe("jev-triage");
    // Required by the manifest schema; only the app's homepage link.
    expect(manifest.url).toBeTruthy();
    expect(manifest.default_permissions).toMatchObject({
      issues: "write",
      pull_requests: "write",
      contents: "read",
      metadata: "read",
    });
    expect(manifest.default_events).toEqual(["issues", "issue_comment", "pull_request"]);
  });
});
