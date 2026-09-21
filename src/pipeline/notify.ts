import type { Logger } from "../util/logger";

export interface TelegramTarget {
  token: string;
  chatId: string;
  /**
   * Bot API root. Defaults to the public `https://api.telegram.org`; override it to point
   * at a self-hosted Bot API server, or at a stub in tests.
   */
  apiBase?: string | undefined;
}

export const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";

export interface NotifyTargets {
  slack?: string | undefined;
  discord?: string | undefined;
  telegram?: TelegramTarget | undefined;
}

export interface NotifyResult {
  /** True when at least one destination was configured and therefore attempted. */
  attempted: boolean;
  slack: boolean;
  discord: boolean;
  telegram: boolean;
}

async function postJson(url: string, payload: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Webhook responded with ${response.status}`);
  }
}

/** Telegram rejects anything longer than this. */
export const TELEGRAM_MAX_LENGTH = 4096;

export function truncateForTelegram(message: string): string {
  if (message.length <= TELEGRAM_MAX_LENGTH) return message;
  return `${message.slice(0, TELEGRAM_MAX_LENGTH - 1)}…`;
}

/**
 * Sends via the Bot API. Note there is no webhook URL to configure: the bot token and the
 * destination chat are two separate values.
 */
async function sendTelegram(target: TelegramTarget, message: string): Promise<void> {
  const base = (target.apiBase?.trim() || DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, "");
  try {
    const response = await fetch(`${base}/bot${target.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: target.chatId,
        // Plain text on purpose: issue titles would break Markdown parsing, and a
        // parse error makes Telegram reject the whole message.
        text: truncateForTelegram(message),
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      // Telegram explains the problem in the body; without it a 400 is undiagnosable.
      const detail = await response.text().catch(() => "");
      const trimmed = detail.trim().slice(0, 300);
      // The most common first-run failure deserves an actual explanation.
      const hint = trimmed.includes("chat not found")
        ? " (a bot cannot start a conversation: open the bot in Telegram and press Start, or fix the chat id)"
        : "";
      throw new Error(
        `Telegram responded with ${response.status}${trimmed ? `: ${trimmed}` : ""}${hint}`,
      );
    }

    // Telegram also reports some failures with HTTP 200 and `ok: false`.
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;
    if (payload?.ok === false) {
      throw new Error(`Telegram rejected the message: ${payload.description ?? "unknown reason"}`);
    }
  } catch (err) {
    // The bot token sits in the request URL, and network errors can echo the URL back.
    const reason = err instanceof Error ? err.message : "unknown error";
    throw new Error(reason.replaceAll(target.token, "<token>"));
  }
}

/**
 * Best-effort notification fan-out. A failing destination must never fail triage, so
 * errors are logged and swallowed.
 */
export async function sendNotification(
  targets: NotifyTargets,
  message: string,
  log: Logger,
): Promise<NotifyResult> {
  const result: NotifyResult = {
    attempted: Boolean(targets.slack || targets.discord || targets.telegram),
    slack: false,
    discord: false,
    telegram: false,
  };

  if (targets.slack) {
    try {
      await postJson(targets.slack, { text: message });
      result.slack = true;
    } catch (err) {
      log.warn({ err }, "Slack notification failed");
    }
  }

  if (targets.discord) {
    try {
      await postJson(targets.discord, { content: message });
      result.discord = true;
    } catch (err) {
      log.warn({ err }, "Discord notification failed");
    }
  }

  if (targets.telegram) {
    try {
      await sendTelegram(targets.telegram, message);
      result.telegram = true;
    } catch (err) {
      log.warn({ err }, "Telegram notification failed");
    }
  }

  return result;
}
