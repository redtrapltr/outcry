/**
 * Pro perk: stock spread alerts. Every few minutes, scan executable xStocks/Ondo
 * quotes and ping subscribed Pro/Sniper users on Telegram when a gap passes
 * their threshold. One alert per ticker per user per hour.
 */
import type { Growth } from "./growth.js";
import type { SpreadScanner } from "./spreads.js";

export class SpreadAlerts {
  private lastSent = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  lastRun?: { at: string; subscribers: number; sent: number; error?: string };

  constructor(private d: { growth: Growth; scanner: SpreadScanner; notify: (userId: string, text: string) => Promise<boolean> | boolean; linked: (userId: string) => boolean }) {}

  subscribers() {
    return [...this.d.growth.spreadAlerts].filter(([uid]) => this.d.growth.planOf(uid).id !== "free" && this.d.linked(uid));
  }

  async runOnce(now = Date.now()) {
    const subs = this.subscribers();
    if (!subs.length) return (this.lastRun = { at: new Date(now).toISOString(), subscribers: 0, sent: 0 });
    let sent = 0;
    try {
      const size = Math.max(...subs.map(([, s]) => s.sizeUsd));
      const scan = await this.d.scanner.scan(size);
      for (const [uid, s] of subs) {
        for (const r of scan.rows) {
          const edge = Math.max(r.swapEdgePct, r.discountPct);
          if (edge < s.minPct) continue;
          const key = `${uid}:${r.ticker}`;
          if (now - (this.lastSent.get(key) ?? 0) < 3_600_000) continue;
          this.lastSent.set(key, now);
          const ok = await this.d.notify(uid, `📈 ${r.ticker} spread: ${r.cheap} is ${r.discountPct.toFixed(2)}% cheaper than ${r.rich} (buy $${r.buyCheapPx.toFixed(2)} vs sell $${r.sellRichPx.toFixed(2)}). Swap edge after fees: ${r.swapEdgePct >= 0 ? "+" : ""}${r.swapEdgePct.toFixed(2)}%. Executable quotes for $${scan.sizeUsd}. Not investment advice.`);
          if (ok) sent++;
        }
      }
      this.lastRun = { at: new Date(now).toISOString(), subscribers: subs.length, sent };
    } catch (e) {
      this.lastRun = { at: new Date(now).toISOString(), subscribers: subs.length, sent, error: (e as Error).message };
    }
    return this.lastRun;
  }

  start(everyMs = 5 * 60_000) {
    this.timer = setInterval(() => void this.runOnce(), everyMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
