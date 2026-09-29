/**
 * On-demand token lookup: any Solana mint the user mentions (or a pump.fun /
 * dexscreener link) is fetched from Jupiter's token API and registered in the
 * market with live data, then followed on the pump.fun stream if it's still
 * on the bonding curve.
 *
 * Jupiter Tokens V2 gives price, holder count, top-holder share, liquidity,
 * mint/freeze authority, creator (dev) and first-pool time for most tokens,
 * including fresh pump.fun ones.
 */
import type { SimulatedMarket, TokenRisk } from "./market.js";
import { cleanSymbol } from "./pumpfeed.js";

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Base58 Solana address (32-44 chars). */
export const MINT_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

export function findMints(text: string): string[] {
  return [...new Set(text.match(MINT_RE) ?? [])];
}

interface JupToken {
  id: string;
  name?: string;
  symbol?: string;
  dev?: string;
  launchpad?: string;
  holderCount?: number;
  usdPrice?: number;
  mcap?: number;
  liquidity?: number;
  createdAt?: string;
  firstPool?: { id?: string; createdAt?: string };
  audit?: { mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean; topHoldersPercentage?: number; devBalancePercentage?: number };
  graduatedPool?: string;
}

export class TokenLookup {
  private misses = new Map<string, number>();

  constructor(
    private market: SimulatedMarket,
    private opts: { fetch?: FetchLike; follow?: (mint: string) => void } = {},
  ) {}

  private get f(): FetchLike {
    return this.opts.fetch ?? ((u) => fetch(u, { signal: AbortSignal.timeout(6_000) }) as never);
  }

  /** Make sure every mint in `text` is known to the market. Returns the mints that resolved. */
  async ensureFrom(text: string): Promise<string[]> {
    const out: string[] = [];
    for (const m of findMints(text).slice(0, 5)) if (await this.ensure(m)) out.push(m);
    return out;
  }

  async ensure(mint: string): Promise<boolean> {
    const known = this.market.tokenRisk(mint);
    // Known live tokens are kept fresh by the stream; refresh others at most every 30s.
    if (known && (known.flags.includes("live") || Date.now() - (this.misses.get(`ok:${mint}`) ?? 0) < 30_000)) return true;
    if (Date.now() - (this.misses.get(mint) ?? 0) < 60_000) return !!known;
    try {
      const r = await this.f(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`);
      if (!r.ok) throw new Error(`Jupiter ${r.status}`);
      const rows = (await r.json()) as JupToken[];
      const t = Array.isArray(rows) ? rows.find((x) => x.id === mint) : undefined;
      if (!t || !(t.usdPrice && t.usdPrice > 0)) {
        // Very fresh pump.fun tokens may not be indexed yet: ask pump.fun directly.
        const p = await this.pumpFun(mint);
        if (p) {
          this.register(p);
          this.misses.set(`ok:${mint}`, Date.now());
          return true;
        }
        this.misses.set(mint, Date.now());
        return !!known;
      }
      this.register(t);
      this.misses.set(`ok:${mint}`, Date.now());
      return true;
    } catch {
      this.misses.set(mint, Date.now());
      return !!known;
    }
  }

  /** pump.fun's public frontend API (unofficial, best effort). */
  private async pumpFun(mint: string): Promise<JupToken | undefined> {
    try {
      const r = await this.f(`https://frontend-api-v3.pump.fun/coins/${mint}`);
      if (!r.ok) return undefined;
      const c = (await r.json()) as { mint?: string; name?: string; symbol?: string; creator?: string; created_timestamp?: number; usd_market_cap?: number; virtual_sol_reserves?: number; complete?: boolean; raydium_pool?: string | null; pump_swap_pool?: string | null };
      if (c?.mint !== mint || !(c.usd_market_cap && c.usd_market_cap > 0)) return undefined;
      return {
        id: mint,
        name: c.name,
        symbol: c.symbol,
        dev: c.creator,
        launchpad: "pump.fun",
        usdPrice: c.usd_market_cap / 1e9,
        createdAt: c.created_timestamp ? new Date(c.created_timestamp).toISOString() : undefined,
        audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
        graduatedPool: c.complete ? c.pump_swap_pool ?? c.raydium_pool ?? "graduated" : undefined,
      };
    } catch {
      return undefined;
    }
  }

  private register(t: JupToken) {
    const created = Date.parse(t.firstPool?.createdAt ?? t.createdAt ?? "") || Date.now();
    const top10 = t.audit?.topHoldersPercentage;
    const patch: Partial<TokenRisk> = {
      holders: t.holderCount ?? 0,
      holdersCollapsed: t.holderCount ?? 0,
      // Jupiter reports the top-10 share; the single top wallet is not given separately.
      topWalletPct: top10 !== undefined ? Number(Math.min(top10, t.audit?.devBalancePercentage ?? top10).toFixed(2)) : 0,
      top10Pct: top10 !== undefined ? Number(top10.toFixed(2)) : undefined,
      mintRevoked: t.audit?.mintAuthorityDisabled ?? false,
      freezeRevoked: t.audit?.freezeAuthorityDisabled ?? false,
      liquidityUsd: Math.round(t.liquidity ?? 0),
    };
    const existing = this.market.tokenRisk(t.id);
    if (existing) {
      this.market.updateMeme(t.id, patch, t.usdPrice);
      return;
    }
    const onCurve = t.launchpad === "pump.fun" && !t.graduatedPool;
    const risk: TokenRisk = {
      mint: t.id,
      symbol: cleanSymbol(t.symbol, t.id, (s) => this.market.hasSymbol(s)),
      ageMinutes: (Date.now() - created) / 60_000,
      createdAtMs: created,
      holders: 0,
      holdersCollapsed: 0,
      topWalletPct: 0,
      mintRevoked: false,
      freezeRevoked: false,
      liquidityUsd: 0,
      creatorWallets: t.dev ? [t.dev] : [],
      flags: ["looked-up", ...(t.launchpad ? [t.launchpad] : []), ...(onCurve ? ["bonding-curve"] : [])],
      ...patch,
    } as TokenRisk;
    this.market.registerLiveMeme(risk, t.usdPrice!);
    if (onCurve) this.opts.follow?.(t.id);
  }
}
