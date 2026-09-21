import { afterEach, describe, expect, it, vi } from "vitest";
import { TELEGRAM_MAX_LENGTH, sendNotification, truncateForTelegram } from "../src/pipeline/notify";
import { createLogger } from "../src/util/logger";

const log = createLogger({ silent: true });

function okResponse(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("truncateForTelegram", () => {
  it("leaves short messages alone", () => {
    expect(truncateForTelegram("hello")).toBe("hello");
  });

  it("caps long messages at Telegram's limit", () => {
    const result = truncateForTelegram("x".repeat(TELEGRAM_MAX_LENGTH + 500));
    expect(result).toHaveLength(TELEGRAM_MAX_LENGTH);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("sendNotification", () => {
  it("does nothing when no destination is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendNotification({}, "hello", log);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: false, slack: false, discord: false, telegram: false });
  });

  it("posts to the Telegram Bot API with the chat id", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendNotification(
      { telegram: { token: "123:abc", chatId: "42" } },
      "Critical issue detected",
      log,
    );

    expect(result.telegram).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(JSON.parse(init.body)).toMatchObject({
      chat_id: "42",
      text: "Critical issue detected",
      disable_web_page_preview: true,
    });
  });

  it("honours a self-hosted Bot API base", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await sendNotification(
      { telegram: { token: "123:abc", chatId: "42", apiBase: "http://127.0.0.1:8081/" } },
      "hello",
      log,
    );

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://127.0.0.1:8081/bot123:abc/sendMessage");
  });

  it("does not send Markdown, so issue titles cannot break parsing", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await sendNotification(
      { telegram: { token: "t", chatId: "1" } },
      "Title: fix `thing_*[1]*` now",
      log,
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body).parse_mode).toBeUndefined();
  });

  it("keeps going when a destination fails", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendNotification(
      {
        slack: "https://hooks.slack.test/x",
        telegram: { token: "123:abc", chatId: "42" },
      },
      "hello",
      log,
    );

    // `attempted` distinguishes a real failure from "nobody was configured".
    expect(result).toEqual({ attempted: true, slack: false, discord: false, telegram: false });
  });

  it("treats an HTTP 200 with ok:false as a failure", async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: false, description: "chat not found" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendNotification(
      { telegram: { token: "123:abc", chatId: "42" } },
      "hello",
      log,
    );

    expect(result.telegram).toBe(false);
  });

  it("surfaces Telegram's own explanation, with a hint for the common first-run error", async () => {
    const body = JSON.stringify({
      ok: false,
      error_code: 400,
      description: "Bad Request: chat not found",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 400 })),
    );

    const warn = vi.fn();
    await sendNotification({ telegram: { token: "123:abc", chatId: "42" } }, "hello", {
      warn,
      debug: vi.fn,
      info: vi.fn,
      error: vi.fn,
    } as never);

    const message = (warn.mock.calls[0]?.[0] as { err: Error }).err.message;
    // The raw body is the only thing that makes a 400 diagnosable...
    expect(message).toContain("chat not found");
    // ...and a bot cannot open a conversation, which is almost always the cause.
    expect(message).toMatch(/press Start/i);
  });

  it("never lets the bot token reach the logs through a network error", async () => {
    const token = "123456:SUPER-SECRET-TOKEN";
    const fetchMock = vi.fn(async () => {
      // undici echoes the request URL in connection errors.
      throw new Error(`request to https://api.telegram.org/bot${token}/sendMessage failed`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const warn = vi.fn();
    const result = await sendNotification({ telegram: { token, chatId: "42" } }, "hello", {
      warn,
      debug: vi.fn,
      info: vi.fn,
      error: vi.fn,
    } as never);

    expect(result.telegram).toBe(false);
    // Errors are not JSON-serialisable, so inspect the Error itself.
    const logged = warn.mock.calls[0]?.[0] as { err: Error };
    expect(logged.err.message).not.toContain(token);
    expect(logged.err.message).toContain("<token>");
  });
});
