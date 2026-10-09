/**
 * Stock spread scanner: the same US stock trades as two tokens on Solana
 * (xStocks "MSFTx" and Ondo "MSFTon"). When their prices drift apart, there
 * may be an edge. Displayed prices aren't enough: this asks Jupiter for real,
 * executable quotes in USDC for a given size, both ways, and subtracts
 * Outcry's fee on both legs.
 *
 * Two readings of the result:
 *  - Swap edge (true arbitrage, needs inventory): if you hold the expensive
 *    version, sell it and buy the cheap one; you keep the same exposure and
 *    pocket the difference.
 *  - Discount (for buyers): buying the cheap version costs X% less per share
 *    than the other version right now.
 */
import { USDC_MINT, type JupiterSwap } from "./chain.js";

export interface StockPair {
  ticker: string;
  a: { symbol: string; mint: string; decimals: number; priceUsd?: number };
  b: { symbol: string; mint: string; decimals: number; priceUsd?: number };
}

export interface SpreadRow {
  ticker: string;
  cheap: string;
  rich: string;
  /** Executable USDC per share when buying the cheap version. */
  buyCheapPx: number;
  /** Executable USDC per share when selling the rich version (same share count). */
  sellRichPx: number;
  /** Gap between displayed on-chain prices, % (before quotes). */
  displayedGapPct: number;
  /** Sell rich + buy cheap, after Outcry's fee on both legs, % of size. */
  swapEdgePct: number;
  /** How much cheaper per share the cheap version is to buy right now, %. */
  discountPct: number;
}

export interface SpreadScan {
  at: string;
  sizeUsd: number;
  outcryFeeBps: number;
  scanned: number;
  rows: SpreadRow[];
  errors: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SpreadScanner {
  private cache?: { key: string; at: number; scan: SpreadScan };

  constructor(private jup: Pick<JupiterSwap, "quoteOnly">, private pairs: () => StockPair[], private outcryFeeBps: () => number, private pauseMs = 250) {}

  async scan(sizeUsd = 100, maxPairs = 6): Promise<SpreadScan> {
    const key = `${sizeUsd}:${maxPairs}`;
    if (this.cache && this.cache.key === key && Date.now() - this.cache.at < 120_000) return this.cache.scan;
    const fee = this.outcryFeeBps() / 10_000;
    // Look first at the pairs whose displayed prices differ most (quotes cost API calls).
    const candidates = this.pairs()
      .map((p) => ({ p, gap: p.a.priceUsd && p.b.priceUsd ? Math.abs(p.a.priceUsd / p.b.priceUsd - 1) * 100 : 0 }))
      .sort((x, y) => y.gap - x.gap)
      .slice(0, maxPairs);
    const rows: SpreadRow[] = [];
    const errors: string[] = [];
    for (const { p, gap } of candidates) {
      try {
        const [cheap, rich] = (p.a.priceUsd ?? 0) <= (p.b.priceUsd ?? 0) ? [p.a, p.b] : [p.b, p.a];
        const buy = await this.jup.quoteOnly({ inputMint: USDC_MINT, outputMint: cheap.mint, amount: BigInt(Math.round(sizeUsd * 1e6)) });
        await sleep(this.pauseMs);
        const shares = Number(buy.outAmount) / 10 ** cheap.decimals;
        const sell = await this.jup.quoteOnly({ inputMint: rich.mint, outputMint: USDC_MINT, amount: BigInt(Math.round(shares * 10 ** rich.decimals)) });
        await sleep(this.pauseMs);
        const buyCheapPx = sizeUsd / shares;
        const proceeds = Number(sell.outAmount) / 1e6;
        const sellRichPx = proceeds / shares;
        // Sell `shares` of rich for `proceeds`, buy the same shares of cheap for `sizeUsd`; Outcry's fee on both legs.
        const swapEdgePct = ((proceeds * (1 - fee) - sizeUsd * (1 + fee)) / sizeUsd) * 100;
        rows.push({ ticker: p.ticker, cheap: cheap.symbol, rich: rich.symbol, buyCheapPx, sellRichPx, displayedGapPct: gap, swapEdgePct, discountPct: (1 - buyCheapPx / sellRichPx) * 100 });
      } catch (e) {
        errors.push(`${p.ticker}: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    rows.sort((x, y) => y.swapEdgePct - x.swapEdgePct);
    const scan = { at: new Date().toISOString(), sizeUsd, outcryFeeBps: this.outcryFeeBps(), scanned: candidates.length, rows, errors };
    this.cache = { key, at: Date.now(), scan };
    return scan;
  }
}
