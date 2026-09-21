import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type JevTriageConfig } from "../src/config/schema";
import { type DbHandle, createDb } from "../src/db/client";
import { actions as actionsTable, predictions, triageRuns } from "../src/db/schema";
import { repoFullName } from "../src/github/types";
import { buildAccuracyReport } from "../src/metrics/accuracy";
import { clearRepoMetaCache, runTriage, shouldSkip } from "../src/pipeline/runTriage";
import { createLogger } from "../src/util/logger";
import { createFakeJev } from "./helpers/fakeJev";
import { makeItem } from "./helpers/fixtures";
import { createMockOctokit } from "./helpers/mockOctokit";

const log = createLogger({ silent: true });
const ref = { owner: "acme", repo: "demo" };

let handle: DbHandle;

beforeEach(() => {
  handle = createDb(":memory:");
  clearRepoMetaCache();
});

function config(overrides: Partial<JevTriageConfig> = {}): JevTriageConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function storedRuns(db: DbHandle["db"]) {
  return db.select().from(triageRuns).all();
}

describe("shouldSkip", () => {
  it("skips disabled repositories, ignored labels and ignored authors", () => {
    expect(shouldSkip(makeItem(), config({ enabled: false }))).toBe("disabled");
    expect(shouldSkip(makeItem({ existingLabels: ["skip-triage"] }), config())).toContain(
      "ignored-label",
    );
    expect(
      shouldSkip(makeItem(), config({ ignore: { authors: ["reporter"], labels: [] } })),
    ).toContain("ignored-author");
    expect(shouldSkip(makeItem(), config())).toBeNull();
  });
});

describe("runTriage", () => {
  it("applies the category label and records the run", async () => {
    const octokit = createMockOctokit();
    const jev = createFakeJev();

    const result = await runTriage(
      { octokit: octokit as never, ref, item: makeItem(), config: config(), botLogin: "bot[bot]" },
      { jev, db: handle.db, log },
    );

    expect(result).not.toBeNull();
    expect(octokit.state.labels).toEqual(["bug"]);
    expect(result?.rationale.category).toBe("bug");
    expect(storedRuns(handle.db)).toHaveLength(1);
    expect(handle.db.select().from(predictions).all().length).toBeGreaterThan(0);
    expect(handle.db.select().from(actionsTable).all().length).toBeGreaterThan(0);
  });

  it("writes nothing but still records the run in dry-run mode", async () => {
    const octokit = createMockOctokit();
    const jev = createFakeJev();

    const result = await runTriage(
      {
        octokit: octokit as never,
        ref,
        item: makeItem(),
        config: config(),
        botLogin: "bot[bot]",
        dryRun: true,
      },
      { jev, db: handle.db, log },
    );

    expect(octokit.state.labels).toEqual([]);
    expect(octokit.state.comments).toEqual([]);
    expect(octokit.state.closed).toBe(false);
    expect(result?.applied.every((entry) => !entry.applied)).toBe(true);

    const runs = storedRuns(handle.db);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.dryRun).toBe(true);
  });

  it("returns null and does no work when the item is ignored", async () => {
    const octokit = createMockOctokit();
    const jev = createFakeJev();

    const result = await runTriage(
      {
        octokit: octokit as never,
        ref,
        item: makeItem({ existingLabels: ["skip-triage"] }),
        config: config(),
        botLogin: "bot[bot]",
      },
      { jev, db: handle.db, log },
    );

    expect(result).toBeNull();
    expect(jev.requests).toHaveLength(0);
    expect(storedRuns(handle.db)).toHaveLength(0);
  });

  it("routes uncertain items to a human", async () => {
    const octokit = createMockOctokit();
    const jev = createFakeJev({
      triage: {
        category: { type: "choice", choice: "bug", confidence: 0.3, probabilities: { bug: 0.3 } },
      },
    });

    await runTriage(
      { octokit: octokit as never, ref, item: makeItem(), config: config(), botLogin: "bot[bot]" },
      { jev, db: handle.db, log },
    );

    expect(octokit.state.labels).toEqual([DEFAULT_CONFIG.labels.needsTriage]);
  });

  it("verifies duplicate candidates with a second Jev call", async () => {
    const octokit = createMockOctokit({
      candidateItems: [
        {
          number: 7,
          title: "Crash when saving a document",
          body: "Pressing save crashes the app.",
          pull_request: undefined,
          state: "open",
          created_at: "2026-08-01T00:00:00Z",
        },
        {
          number: 9,
          title: "Add dark mode",
          body: "A dark theme would be nice.",
          pull_request: undefined,
          state: "open",
          created_at: "2026-08-02T00:00:00Z",
        },
      ],
    });
    const jev = createFakeJev({ duplicates: { dup_1: { noul: 0.93 }, dup_2: { noul: 0.05 } } });

    const result = await runTriage(
      { octokit: octokit as never, ref, item: makeItem(), config: config(), botLogin: "bot[bot]" },
      { jev, db: handle.db, log },
    );

    // One call for classification, one for the duplicate pass.
    expect(jev.requests).toHaveLength(2);
    expect(result?.duplicate?.bestScore).toBeCloseTo(0.93);
    expect(octokit.state.labels).toContain(DEFAULT_CONFIG.labels.possibleDuplicate);

    const comment = octokit.state.comments.find((entry) =>
      entry.body.includes("Possible duplicate"),
    );
    expect(comment?.body).toContain("#7");
  });

  it("skips the duplicate pass when there is nothing to compare against", async () => {
    const octokit = createMockOctokit({ candidateItems: [] });
    const jev = createFakeJev();

    const result = await runTriage(
      { octokit: octokit as never, ref, item: makeItem(), config: config(), botLogin: "bot[bot]" },
      { jev, db: handle.db, log },
    );

    expect(jev.requests).toHaveLength(1);
    expect(result?.duplicate).toBeNull();
  });

  describe("when the pipeline fails", () => {
    it("records an error run and rethrows", async () => {
      const octokit = createMockOctokit();
      const jev = {
        requests: [],
        async systemOne() {
          throw new Error("401 Unauthorized: missing API key");
        },
      };

      await expect(
        runTriage(
          {
            octokit: octokit as never,
            ref,
            item: makeItem(),
            config: config(),
            botLogin: "bot[bot]",
          },
          { jev: jev as never, db: handle.db, log },
        ),
      ).rejects.toThrow(/401 Unauthorized/);

      const runs = storedRuns(handle.db);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("error");
      expect(runs[0]?.error).toMatch(/401 Unauthorized/);
      // Nothing was applied, and no predictions were invented.
      expect(octokit.state.labels).toEqual([]);
      expect(handle.db.select().from(predictions).all()).toEqual([]);
    });

    it("keeps failures out of the accuracy statistics", async () => {
      // One successful run, then a failing one on a different item.
      await runTriage(
        { octokit: createMockOctokit() as never, ref, item: makeItem(), config: config() },
        { jev: createFakeJev(), db: handle.db, log },
      );
      await expect(
        runTriage(
          {
            octokit: createMockOctokit() as never,
            ref,
            item: makeItem({ number: 99 }),
            config: config(),
          },
          {
            jev: {
              systemOne: async () => {
                throw new Error("boom");
              },
            } as never,
            db: handle.db,
            log,
          },
        ),
      ).rejects.toThrow();

      const report = buildAccuracyReport(handle.db, repoFullName(ref));
      expect(report.itemsTriaged).toBe(1);
      expect(report.failedRuns).toBe(1);
      expect(report.tokens.runs).toBe(1);
    });
  });

  describe("telegram notifications", () => {
    const spamJev = () =>
      createFakeJev({
        triage: {
          category: {
            type: "choice",
            choice: "spam",
            confidence: 0.95,
            probabilities: { spam: 0.95 },
          },
          spam_promotional: { type: "noul", noul: 1 },
          spam_off_topic: { type: "noul", noul: 1 },
          spam_abusive: { type: "noul", noul: 1 },
        },
      });

    afterEach(() => {
      // Empty string, not undefined: assigning undefined to process.env stores the
      // literal string "undefined", which is truthy and looks like a real value.
      process.env.TELEGRAM_BOT_TOKEN = "";
      process.env.TELEGRAM_CHAT_ID = "";
      vi.unstubAllGlobals();
    });

    it("sends when both the token and the chat id are configured", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "123:abc";
      process.env.TELEGRAM_CHAT_ID = "42";
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
      vi.stubGlobal("fetch", fetchMock);

      const result = await runTriage(
        {
          octokit: createMockOctokit() as never,
          ref,
          item: makeItem(),
          config: config(),
          botLogin: "bot[bot]",
        },
        { jev: spamJev(), db: handle.db, log },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
      expect(result?.applied.find((entry) => entry.action.type === "notify")?.applied).toBe(true);
    });

    it("stays quiet when only half the pair is configured", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "123:abc";
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await runTriage(
        {
          octokit: createMockOctokit() as never,
          ref,
          item: makeItem(),
          config: config(),
          botLogin: "bot[bot]",
        },
        { jev: spamJev(), db: handle.db, log },
      );

      expect(fetchMock).not.toHaveBeenCalled();
      const notify = result?.applied.find((entry) => entry.action.type === "notify");
      expect(notify?.applied).toBe(false);
      expect(notify?.skippedReason).toBe("no-webhook-configured");
    });
  });

  describe("JEV_TRIAGE_DRY_RUN", () => {
    afterEach(() => {
      process.env.JEV_TRIAGE_DRY_RUN = "";
    });

    it("forces a dry run even when the caller did not ask for one", async () => {
      process.env.JEV_TRIAGE_DRY_RUN = "true";
      const octokit = createMockOctokit();

      const result = await runTriage(
        {
          octokit: octokit as never,
          ref,
          item: makeItem(),
          config: config(),
          botLogin: "bot[bot]",
          dryRun: false,
        },
        { jev: createFakeJev(), db: handle.db, log },
      );

      expect(octokit.state.labels).toEqual([]);
      expect(result?.applied.every((entry) => !entry.applied)).toBe(true);
      expect(storedRuns(handle.db)[0]?.dryRun).toBe(true);
    });

    it("is off for any non-truthy value", async () => {
      process.env.JEV_TRIAGE_DRY_RUN = "false";
      const octokit = createMockOctokit();

      await runTriage(
        {
          octokit: octokit as never,
          ref,
          item: makeItem(),
          config: config(),
          botLogin: "bot[bot]",
          dryRun: false,
        },
        { jev: createFakeJev(), db: handle.db, log },
      );

      expect(octokit.state.labels).toEqual(["bug"]);
    });
  });
});
