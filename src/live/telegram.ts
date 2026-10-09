/**
 * Telegram alerts: users link their chat with a one-time code
 * (t.me/<bot>?start=<code>), then important events are sent as DMs.
 * Long-polls getUpdates (no public webhook needed). Rate-limited per user.
 */
import { randomBytes } from "node:crypto";

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class TelegramAlerts {
  /** userId -> chat id. Persisted. */
  readonly links = new Map<string, number>();
  private codes = new Map<string, { userId: string; at: number }>();
  private sent = new Map<string, number[]>();
  private offset = 0;
  private running = false;
  lastError?: string;

  constructor(private cfg: { token: string; username: string }, private f: FetchLike = (u, i) => fetch(u, { ...i, signal: i?.signal ?? AbortSignal.timeout(35_000) }) as never) {}

  private api(method: string, body: unknown) {
    return this.f(`https://api.telegram.org/bot${this.cfg.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  /** A deep link that connects this user's Telegram when they press Start. */
  linkFor(userId: string) {
    const code = randomBytes(9).toString("base64url");
    this.codes.set(code, { userId, at: Date.now() });
    for (const [k, v] of this.codes) if (Date.now() - v.at > 15 * 60_000) this.codes.delete(k);
    return `https://t.me/${this.cfg.username}?start=${code}`;
  }

  isLinked(userId: string) {
    return this.links.has(userId);
  }

  unlink(userId: string) {
    this.links.delete(userId);
  }

  /** Handle one update from Telegram (exposed for tests). */
  async handleUpdate(u: { update_id: number; message?: { chat: { id: number }; text?: string } }) {
    this.offset = Math.max(this.offset, u.update_id + 1);
    const m = u.message;
    if (!m?.text) return;
    const [cmd, arg] = m.text.trim().split(/\s+/, 2);
    if (cmd === "/start" && arg) {
      const c = this.codes.get(arg);
      if (!c || Date.now() - c.at > 15 * 60_000) return void (await this.reply(m.chat.id, "This link expired. Open Outcry and press 🔔 Telegram alerts again."));
      this.codes.delete(arg);
      this.links.set(c.userId, m.chat.id);
      await this.reply(m.chat.id, "✅ Connected to Outcry. You'll get alerts for real trades, withdrawals and your agents. Send /stop to turn them off.");
    } else if (cmd === "/stop") {
      for (const [uid, chat] of this.links) if (chat === m.chat.id) this.links.delete(uid);
      await this.reply(m.chat.id, "Alerts off. Reconnect any time from Outcry.");
    } else if (cmd === "/start") {
      await this.reply(m.chat.id, "Open Outcry and press 🔔 Telegram alerts to connect this chat.");
    }
  }

  private async reply(chatId: number, text: string) {
    await this.api("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true }).catch(() => undefined);
  }

  /** Send an alert to a linked user (max 20 per minute per user). */
  async notify(userId: string, text: string) {
    const chat = this.links.get(userId);
    if (!chat) return false;
    const now = Date.now();
    const recent = (this.sent.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 20) return false;
    recent.push(now);
    this.sent.set(userId, recent);
    await this.reply(chat, text);
    return true;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    const loop = async () => {
      while (this.running) {
        try {
          const r = await this.api("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message"] });
          const j = (await r.json()) as { ok: boolean; result?: { update_id: number; message?: { chat: { id: number }; text?: string } }[]; description?: string };
          if (!j.ok) throw new Error(j.description ?? `HTTP ${r.status}`);
          for (const u of j.result ?? []) await this.handleUpdate(u);
          this.lastError = undefined;
        } catch (e) {
          this.lastError = (e as Error).message;
          await new Promise((res) => setTimeout(res, 10_000));
        }
      }
    };
    void loop();
    return this;
  }

  stop() {
    this.running = false;
  }

  status() {
    return { bot: `@${this.cfg.username}`, linkedUsers: this.links.size, lastError: this.lastError ?? null };
  }
}

/** Which agent activity is worth a phone notification. */
export const ALERT_WORTHY = /^REAL ·|went REAL|now trades REAL|paus|stopp|drawdown|activated|approved for real|published v|Performance fee/i;
