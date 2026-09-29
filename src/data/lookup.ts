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

type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;
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
    private opts: { fetch?: FetchLike; follow?: (mint: string) => void; rpc?: RpcCall; rpcUrl?: string } = {},
  ) {}

  private rpc: RpcCall = (method, params) =>
    this.opts.rpc
      ? this.opts.rpc(method, params)
      : fetch(this.opts.rpcUrl ?? "https://api.mainnet-beta.solana.com", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(6_000),
        })
          .then((r) => r.json() as Promise<{ result?: unknown; error?: { message: string } }>)
          .then((j) => {
            if (j.error) throw new Error(j.error.message);
            return j.result;
          });

  /**
   * Largest holders from the chain: token accounts -> owners -> keep only
   * real wallets (system-owned), so the bonding curve and AMM pools don't count
   * as "holders". Returns shares of total supply.
   */
  async holders(mint: string): Promise<{ topWalletPct: number; top10Pct: number; poolPct: number; topWallet: string } | undefined> {
    try {
      const largest = (await this.rpc("getTokenLargestAccounts", [mint, { commitment: "confirmed" }])) as { value: { address: string; uiAmount: number | null }[] };
      const supply = (await this.rpc("getTokenSupply", [mint, { commitment: "confirmed" }])) as { value: { uiAmount: number | null } };
      const total = supply?.value?.uiAmount ?? 0;
      const accts = largest?.value?.filter((a) => (a.uiAmount ?? 0) > 0) ?? [];
      if (!total || !accts.length) return undefined;
      const parsed = (await this.rpc("getMultipleAccounts", [accts.map((a) => a.address), { encoding: "jsonParsed" }])) as { value: ({ data?: { parsed?: { info?: { owner?: string } } } } | null)[] };
      const owners = accts.map((_, i) => parsed?.value?.[i]?.data?.parsed?.info?.owner ?? "");
      const uniq = [...new Set(owners.filter(Boolean))];
      const ownerInfo = (await this.rpc("getMultipleAccounts", [uniq, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }])) as { value: ({ owner?: string } | null)[] };
      const program = new Map(uniq.map((o, i) => [o, ownerInfo?.value?.[i]?.owner ?? "none"]));
      const SYSTEM = "11111111111111111111111111111111";
      const byOwner = new Map<string, number>();
      let pool = 0;
      accts.forEach((a, i) => {
        const o = owners[i]!;
        const prog = program.get(o);
        // Wallets are owned by the system program (or hold no SOL at all); anything else is a program account: curve, pool, vault.
        if (o && (prog === SYSTEM || prog === "none")) byOwner.set(o, (byOwner.get(o) ?? 0) + (a.uiAmount ?? 0));
        else pool += a.uiAmount ?? 0;
      });
      const sorted = [...byOwner.entries()].sort((x, y) => y[1] - x[1]);
      const pct = (n: number) => Number(((n / total) * 100).toFixed(2));
      return { topWalletPct: pct(sorted[0]?.[1] ?? 0), top10Pct: pct(sorted.slice(0, 10).reduce((x, y) => x + y[1], 0)), poolPct: pct(pool), topWallet: sorted[0]?.[0] ?? "" };
    } catch {
      return undefined;
    }
  }

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
          await this.enrich(mint);
          this.misses.set(`ok:${mint}`, Date.now());
          return true;
        }
        this.misses.set(mint, Date.now());
        return !!known;
      }
      this.register(t);
      await this.enrich(mint);
      this.misses.set(`ok:${mint}`, Date.now());
      return true;
    } catch {
      this.misses.set(mint, Date.now());
      return !!known;
    }
  }

  private async enrich(mint: string) {
    const h = await this.holders(mint);
    if (h) this.market.updateMeme(mint, { topWalletPct: h.topWalletPct, top10Pct: h.top10Pct, poolPct: h.poolPct, topWallet: h.topWallet, topWalletUnknown: false });
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
      // Jupiter reports only the top-10 share. The single top wallet comes from the chain (enrich); until then it's unknown.
      topWalletPct: 0,
      topWalletUnknown: true,
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
