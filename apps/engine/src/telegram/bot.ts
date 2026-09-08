/**
 * The Telegram bot (ADR-0009 §4): the daily report, pushes for what the
 * owner must know, and two commands from the owner's chat id only: `/halt`
 * (immediate, no second factor: stopping is always allowed) and `/status`.
 * It never approves, never unseals, never clears a halt. Long polling over
 * `getUpdates`, so the host needs no public endpoint.
 */
import { errText, logger } from "../log.ts";
import * as m from "../metrics.ts";

const log = logger("telegram");

const API = "https://api.telegram.org";
/** Telegram's limit per message; longer texts are split on line breaks. */
const MAX_TEXT = 4000;

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number | string; type?: string };
    from?: { id: number; username?: string };
  };
};

export type BotDeps = {
  token: string;
  chatId: string;
  /** The `/status` text. */
  status: () => Promise<string>;
  /** The `/halt` action; the bot answers with what it did. */
  halt: (reason: string) => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
};

export class TelegramBot {
  readonly state = { offset: 0, handled: 0, ignored: 0, sent: 0, failed: 0, polling: false };
  private readonly deps: BotDeps;
  private readonly fetch: typeof fetch;
  private stopped = true;
  private backoff = 1000;

  constructor(deps: BotDeps) {
    this.deps = deps;
    this.fetch = deps.fetch ?? globalThis.fetch;
  }

  /** Send one text to the owner's chat; long texts are split. Never throws. */
  async send(text: string): Promise<boolean> {
    let ok = true;
    for (const chunk of split(text)) {
      try {
        const res = await this.fetch(`${API}/bot${this.deps.token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: this.deps.chatId,
            text: chunk,
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`sendMessage ${res.status}`);
        this.state.sent++;
        m.telegram.inc({ outcome: "sent" });
      } catch (e) {
        ok = false;
        this.state.failed++;
        m.telegram.inc({ outcome: "failed" });
        log.warn("telegram send failed", { err: errText(e) });
      }
    }
    return ok;
  }

  /** One update from Telegram. Public for tests. */
  async handle(u: TelegramUpdate): Promise<void> {
    if (u.update_id >= this.state.offset) this.state.offset = u.update_id + 1;
    const msg = u.message;
    if (!msg?.text) return;
    if (String(msg.chat.id) !== this.deps.chatId) {
      this.state.ignored++;
      m.telegram.inc({ outcome: "ignored" });
      log.warn("telegram message from another chat ignored", { chat: String(msg.chat.id) });
      return;
    }
    this.state.handled++;
    m.telegram.inc({ outcome: "handled" });
    const [cmd, ...rest] = msg.text.trim().split(/\s+/);
    const command = (cmd ?? "").toLowerCase().replace(/@.*$/, "");
    try {
      if (command === "/status") await this.send(await this.deps.status());
      else if (command === "/halt") {
        const reason = rest.join(" ").slice(0, 200) || "telegram";
        log.warn("halt from telegram", { reason });
        await this.send(await this.deps.halt(reason));
      } else
        await this.send(
          "Commands: /status, /halt [reason]. Approve, unseal and halt-clear need the console.",
        );
    } catch (e) {
      log.error("telegram command failed", { command, err: errText(e) });
      await this.send(`failed: ${errText(e)}`);
    }
  }

  private async poll(): Promise<void> {
    while (!this.stopped) {
      try {
        const res = await this.fetch(
          `${API}/bot${this.deps.token}/getUpdates?offset=${this.state.offset}&timeout=25&allowed_updates=%5B%22message%22%5D`,
          { signal: AbortSignal.timeout(35_000) },
        );
        if (!res.ok) throw new Error(`getUpdates ${res.status}`);
        const body = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
        if (!body.ok) throw new Error("getUpdates not ok");
        for (const u of body.result ?? []) await this.handle(u);
        this.backoff = 1000;
      } catch (e) {
        if (this.stopped) return;
        log.warn("telegram poll failed", { err: errText(e), backoffMs: this.backoff });
        await new Promise((r) => setTimeout(r, this.backoff));
        this.backoff = Math.min(this.backoff * 2, 60_000);
      }
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.state.polling = true;
    void this.poll().finally(() => {
      this.state.polling = false;
    });
  }

  stop(): void {
    this.stopped = true;
  }
}

export function split(text: string): string[] {
  if (text.length <= MAX_TEXT) return [text];
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > MAX_TEXT) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) out.push(cur);
  return out;
}
