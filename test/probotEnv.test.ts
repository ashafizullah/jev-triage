import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeMissingCredentials,
  resolvePrivateKey,
  resolveProbotCredentials,
} from "../src/config/probotEnv";

describe("resolvePrivateKey", () => {
  it("prefers the PRIVATE_KEY environment variable", () => {
    const key = resolvePrivateKey({ PRIVATE_KEY: "  from-env  " });
    expect(key).toBe("from-env");
  });

  it("falls back to the first .pem file in the working directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-triage-"));
    writeFileSync(join(dir, "app.private-key.pem"), "PEM-CONTENT", "utf8");

    expect(resolvePrivateKey({}, dir)).toBe("PEM-CONTENT");
  });

  it("returns undefined when nothing is available", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-triage-empty-"));
    expect(resolvePrivateKey({}, dir)).toBeUndefined();
  });
});

describe("resolveProbotCredentials", () => {
  it("applies defaults for the webhook path and log level", () => {
    const credentials = resolveProbotCredentials({}, "/nonexistent");
    expect(credentials.webhookPath).toBe("/api/github/webhooks");
    expect(credentials.logLevel).toBe("info");
    expect(credentials.appId).toBeUndefined();
  });

  it("reads explicit configuration", () => {
    const credentials = resolveProbotCredentials(
      {
        APP_ID: "12345",
        WEBHOOK_SECRET: "shh",
        WEBHOOK_PATH: "/hooks",
        LOG_LEVEL: "debug",
      },
      "/nonexistent",
    );
    expect(credentials).toMatchObject({
      appId: "12345",
      secret: "shh",
      webhookPath: "/hooks",
      logLevel: "debug",
    });
  });
});

describe("describeMissingCredentials", () => {
  it("lists every missing credential", () => {
    expect(
      describeMissingCredentials({
        appId: undefined,
        privateKey: undefined,
        secret: undefined,
        webhookPath: "/api/github/webhooks",
        logLevel: "info",
      }),
    ).toHaveLength(3);
  });

  it("is empty when everything is present", () => {
    expect(
      describeMissingCredentials({
        appId: "1",
        privateKey: "pem",
        secret: "shh",
        webhookPath: "/api/github/webhooks",
        logLevel: "info",
      }),
    ).toEqual([]);
  });
});
