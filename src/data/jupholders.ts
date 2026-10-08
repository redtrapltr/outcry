/**
 * Holder counts for young pump.fun tokens from Jupiter's token database
 * (free, no key): one request covers up to 100 mints, so the tokens snipers
 * are watching get fresh holder count, top-10 share, price and liquidity
 * every few seconds.
 *
 * Used when PumpPortal trade data isn't available (it needs a paid key since
 * May 2026). The single top wallet isn't in Jupiter's data: it's measured
 * on-chain (Helius) right before an agent buys.
 */
import type { SimulatedMarket } from "./market.js";

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface JupRow {
  id: string;
  holderCount?: number;
  usdPrice?: number;
  liquidity?: number;
  audit?: { topHoldersPercentage?: number; mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean };
}

export interface HolderPollStatus {
  calls: number;
  lastCallAt: string | null;
  /** Share of polled tokens Jupiter knew about in the last call. */
  lastCoverage: string | null;
  tokensUpdated: number;
  lastError: string | null;
}

export class JupiterHolderPoller {
  private timer?: ReturnType<typeof setInterval>;
  private calls = 0;
  private updated = 0;
  private lastCallAt?: number;
  private lastCoverage?: string;
  private lastError?: string;
  private backoffUntil = 0;

  constructor(
    private market: SimulatedMarket,
    private source: { youngMints(maxAgeMs: number, limit?: number): string[]; tradesFlowing(): boolean },
    private opts: { everyMs?: number; maxAgeMs?: number; fetch?: FetchLike } = {},
  ) {}

  private get f(): FetchLike {
    return this.opts.fetch ?? ((u) => fetch(u, { signal: AbortSignal.timeout(6_000) }) as never);
  }

  start() {
    this.timer = setInterval(() => void this.poll(), this.opts.everyMs ?? 5_000);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  status(): HolderPollStatus {
    return {
      calls: this.calls,
      lastCallAt: this.lastCallAt ? new Date(this.lastCallAt).toISOString() : null,
      lastCoverage: this.lastCoverage ?? null,
      tokensUpdated: this.updated,
      lastError: this.lastError ?? null,
    };
  }

  async poll() {
    if (this.source.tradesFlowing() || Date.now() < this.backoffUntil) return;
    const mints = this.source.youngMints(this.opts.maxAgeMs ?? 10 * 60_000, 100);
    if (!mints.length) return;
    try {
      this.calls++;
      this.lastCallAt = Date.now();
      const r = await this.f(`https://lite-api.jup.ag/tokens/v2/search?query=${mints.join(",")}`);
      if (r.status === 429) {
        this.backoffUntil = Date.now() + 30_000;
        throw new Error("Jupiter 429 (rate limited), pausing 30s");
      }
      if (!r.ok) throw new Error(`Jupiter ${r.status}`);
      const rows = (await r.json()) as JupRow[];
      const want = new Set(mints);
      let hit = 0;
      for (const t of Array.isArray(rows) ? rows : []) {
        if (!want.has(t.id) || t.holderCount === undefined) continue;
        hit++;
        this.updated++;
        const top10 = t.audit?.topHoldersPercentage;
        this.market.updateMeme(
          t.id,
          {
            holders: t.holderCount,
            holdersCollapsed: t.holderCount,
            ...(top10 !== undefined ? { top10Pct: Number(top10.toFixed(2)) } : {}),
            // Only the top-10 total is known here; the single top wallet is checked on-chain before a buy.
            topWalletUnknown: true,
            ...(t.liquidity ? { liquidityUsd: Math.round(t.liquidity) } : {}),
          },
          t.usdPrice,
        );
      }
      this.lastCoverage = `${hit}/${mints.length}`;
      this.lastError = undefined;
    } catch (e) {
      this.lastError = (e as Error).message;
    }
  }
}
