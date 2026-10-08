/**
 * Paper adapter: emulates every venue against the market data feed, with the
 * venue's real fee schedule and a size-based price impact. Used for paper
 * mode, agent paper trading, and the whole test suite.
 */
import { newId, nowIso } from "../core/infra.js";
import type { OrderLeg, QuotedLeg, Venue } from "../core/types.js";
import type { MarketData } from "../data/market.js";
import { normalizeSymbol } from "../data/market.js";
import type { Signature } from "../wallet/signer.js";
import {
  NEW_TOKEN_JUPITER_FEE_BPS,
  VENUE_FEE_BPS,
  type ExecutionAdapter,
  type QuoteContext,
  type SimulationResult,
  type SubmitResult,
} from "./types.js";

/**
 * Estimated network cost per transaction in USD (base fee + priority fee / tip),
 * so paper results match what real money pays. Sniping fresh pump.fun tokens
 * means racing other bots, which costs the most.
 */
export interface NetworkFees {
  pumpfun: number;
  solana: number;
  base: number;
  ethereum: number;
}
export const DEFAULT_NETWORK_FEES: NetworkFees = {
  pumpfun: Number(process.env.OUTCRY_NETFEE_PUMP_USD ?? 0.15),
  solana: Number(process.env.OUTCRY_NETFEE_SOLANA_USD ?? 0.01),
  base: Number(process.env.OUTCRY_NETFEE_BASE_USD ?? 0.02),
  ethereum: Number(process.env.OUTCRY_NETFEE_ETH_USD ?? 0.5),
};

export class PaperAdapter implements ExecutionAdapter {
  readonly venue: Venue = "paper";
  readonly chain = "solana" as const;
  private quotes = new Map<string, number>(); // route -> quote time

  constructor(
    private market: MarketData,
    private opts: {
      networkFees?: NetworkFees;
      /** Fill at the next price update after the order (max wait), like a real transaction landing a moment later. */
      fillDelayMaxMs?: number;
    } = {},
  ) {}

  private networkFeeUsd(venue: Venue, chain: string) {
    const f = this.opts.networkFees ?? DEFAULT_NETWORK_FEES;
    if (venue === "pumpfun") return f.pumpfun;
    if (chain === "ethereum") return f.ethereum;
    if (chain === "base") return f.base;
    return f.solana;
  }

  /** Output of a swap for a given input, after venue fee, Outcry fee and price impact. */
  private swapOut(amountIn: number, side: "buy" | "sell", px: number, qpx: number, feeBps: number, platformBps: number, liquidity: number, networkUsd = 0) {
    const notionalUsd = side === "buy" ? amountIn * qpx : amountIn * px;
    // Price impact: sqrt model against pool liquidity (memes) or deep books (majors)
    const impactBps = Math.min(3_000, Math.max(1, Math.round(10_000 * 0.1 * Math.sqrt(notionalUsd / liquidity))));
    const venueFeeUsd = (notionalUsd * feeBps) / 10_000;
    const platformFeeUsd = (notionalUsd * platformBps) / 10_000;
    const netUsd = Math.max(0, notionalUsd - venueFeeUsd - platformFeeUsd - networkUsd);
    const impactMult = 1 - impactBps / 10_000;
    const out = side === "buy" ? (netUsd / px) * impactMult : (netUsd / qpx) * impactMult;
    return { out, impactBps, venueFeeUsd, platformFeeUsd };
  }

  /** Smallest input that yields `target` output (the curve is monotonic, so bisection is exact enough). */
  private inputFor(target: number, px: number, qpx: number, feeBps: number, platformBps: number, liquidity: number, networkUsd = 0) {
    let lo = 0;
    let hi = ((target * px) / qpx) * 2 + networkUsd / qpx + 1e-9;
    while (this.swapOut(hi, "buy", px, qpx, feeBps, platformBps, liquidity, networkUsd).out < target) hi *= 2;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (this.swapOut(mid, "buy", px, qpx, feeBps, platformBps, liquidity, networkUsd).out >= target) hi = mid;
      else lo = mid;
    }
    return Math.ceil(hi * 1e6) / 1e6; // round up to the quote token's precision
  }

  private context(leg: OrderLeg & { venue: Venue }) {
    const asset = this.market.asset(leg.asset);
    if (!asset) throw new Error(`Unknown asset "${leg.asset}". Try a ticker like SOL, NVDA or a pump.fun mint.`);
    const quote = this.market.asset(leg.quoteAsset);
    if (!quote) throw new Error(`Unknown quote asset "${leg.quoteAsset}"`);
    const risk = this.market.tokenRisk(asset.symbol);
    let feeBps = VENUE_FEE_BPS[leg.venue];
    if (leg.venue === "jupiter" && risk && risk.ageMinutes < 24 * 60) feeBps = NEW_TOKEN_JUPITER_FEE_BPS;
    return {
      asset,
      quote,
      networkUsd: this.networkFeeUsd(leg.venue, asset.chain),
      px: this.market.priceUsd(asset.symbol),
      qpx: this.market.priceUsd(quote.symbol),
      feeBps,
      liquidity: risk ? risk.liquidityUsd : 50_000_000,
    };
  }

  async quote(leg: OrderLeg & { venue: Venue }, ctx: QuoteContext): Promise<QuotedLeg> {
    const c = this.context(leg);
    let amount = leg.amount;
    if (leg.receiveExact !== undefined) {
      if (leg.side !== "buy") throw new Error("Exact-output only applies to buys; for sells, the amount is what you sell");
      amount = this.inputFor(leg.receiveExact, c.px, c.qpx, c.feeBps, ctx.platformFeeBps, c.liquidity, c.networkUsd);
    }
    if (!(amount > 0)) throw new Error("Amount must be positive");
    const q = this.swapOut(amount, leg.side, c.px, c.qpx, c.feeBps, ctx.platformFeeBps, c.liquidity, c.networkUsd);
    const route = `${leg.venue}:${c.quote.symbol}->${c.asset.symbol}`;
    this.quotes.set(route, Date.now());
    return {
      ...leg,
      amount,
      asset: c.asset.symbol,
      quoteAsset: c.quote.symbol,
      chain: c.asset.chain,
      expectedOut: leg.receiveExact ?? q.out,
      priceImpactBps: q.impactBps,
      venueFeeUsd: q.venueFeeUsd,
      platformFeeUsd: q.platformFeeUsd,
      networkFeeUsd: c.networkUsd,
      route,
    };
  }

  async simulate(leg: QuotedLeg, balances: Record<string, number>): Promise<SimulationResult> {
    const spend = leg.side === "buy" ? leg.quoteAsset : leg.asset;
    const receive = leg.side === "buy" ? leg.asset : leg.quoteAsset;
    const have = balances[spend] ?? 0;
    // Exact-output buys may cost up to the slippage bound, so reserve that much.
    const need = leg.receiveExact !== undefined ? leg.amount * (1 + leg.maxSlippageBps / 10_000) : leg.amount;
    if (have + 1e-9 < need) {
      return { ok: false, deltas: {}, error: `Insufficient ${spend}: have ${round(have)}, need ${round(need)}` };
    }
    const risk = this.market.tokenRisk(leg.asset);
    if (leg.side === "buy" && risk && !risk.freezeRevoked) {
      return { ok: false, deltas: {}, error: `${leg.asset} still has freeze authority: sells could be blocked` };
    }
    return { ok: true, deltas: { [spend]: -leg.amount, [receive]: leg.expectedOut } };
  }

  async submit(leg: QuotedLeg, _sig: Signature): Promise<SubmitResult> {
    // A real transaction lands a moment after the decision. For live memecoins, wait for the
    // next price update and fill at that price, not the (older) price the decision was based on.
    const updatedAt = (this.market as { priceUpdatedAt?: (s: string) => number | undefined }).priceUpdatedAt;
    const maxWait = this.opts.fillDelayMaxMs ?? 0;
    if (maxWait > 0 && updatedAt) {
      const t0 = Date.now();
      const first = updatedAt.call(this.market, leg.asset);
      if (first !== undefined) {
        while (Date.now() - t0 < maxWait && (updatedAt.call(this.market, leg.asset) ?? 0) <= t0) await new Promise((r) => setTimeout(r, 200));
      }
    }
    // Fill at a fresh price, bounded by the ticket's max slippage.
    const c = this.context(leg);
    const platformBps = leg.amount > 0 ? Math.round((leg.platformFeeUsd / (leg.side === "buy" ? leg.amount * c.qpx : leg.amount * c.px)) * 10_000) : 0;
    const txId = `paper_${newId("tx")}_${nowIso().slice(11, 19).replace(/:/g, "")}`;
    if (leg.receiveExact !== undefined) {
      // Exact output: receive exactly the requested quantity; the input may move within slippage.
      const need = this.inputFor(leg.receiveExact, c.px, c.qpx, c.feeBps, platformBps, c.liquidity, c.networkUsd);
      const maxIn = leg.amount * (1 + leg.maxSlippageBps / 10_000);
      if (need > maxIn) throw new Error(`Price moved beyond max slippage (${leg.maxSlippageBps} bps); nothing was filled`);
      return { txId, amountIn: need, amountOut: leg.receiveExact, price: need / leg.receiveExact };
    }
    let out = this.swapOut(leg.amount, leg.side, c.px, c.qpx, c.feeBps, platformBps, c.liquidity, c.networkUsd).out;
    const minOut = leg.expectedOut * (1 - leg.maxSlippageBps / 10_000);
    if (out < minOut) {
      throw new Error(`Price moved beyond max slippage (${leg.maxSlippageBps} bps); nothing was filled`);
    }
    out = Math.min(out, leg.expectedOut * 1.02);
    return {
      txId,
      amountIn: leg.amount,
      amountOut: out,
      price: leg.side === "buy" ? leg.amount / out : out / leg.amount,
    };
  }
}

export const round = (n: number, d = 4) => Number(n.toFixed(d));
export { normalizeSymbol };
