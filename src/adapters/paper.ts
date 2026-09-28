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

export class PaperAdapter implements ExecutionAdapter {
  readonly venue: Venue = "paper";
  readonly chain = "solana" as const;
  private quotes = new Map<string, number>(); // route -> quote time

  constructor(private market: MarketData) {}

  async quote(leg: OrderLeg & { venue: Venue }, ctx: QuoteContext): Promise<QuotedLeg> {
    const asset = this.market.asset(leg.asset);
    if (!asset) throw new Error(`Unknown asset "${leg.asset}". Try a ticker like SOL, NVDA or a pump.fun mint.`);
    const quote = this.market.asset(leg.quoteAsset);
    if (!quote) throw new Error(`Unknown quote asset "${leg.quoteAsset}"`);

    const px = this.market.priceUsd(asset.symbol);
    const qpx = this.market.priceUsd(quote.symbol);
    const risk = this.market.tokenRisk(asset.symbol);

    let feeBps = VENUE_FEE_BPS[leg.venue];
    if (leg.venue === "jupiter" && risk && risk.ageMinutes < 24 * 60) feeBps = NEW_TOKEN_JUPITER_FEE_BPS;

    // USD notional of the leg
    const notionalUsd = leg.side === "buy" ? leg.amount * qpx : leg.amount * px;
    // Price impact: sqrt model against pool liquidity (memes) or deep books (majors)
    const liquidity = risk ? risk.liquidityUsd : 50_000_000;
    const impactBps = Math.min(3_000, Math.max(1, Math.round(10_000 * 0.1 * Math.sqrt(notionalUsd / liquidity))));

    const venueFeeUsd = (notionalUsd * feeBps) / 10_000;
    const platformFeeUsd = (notionalUsd * ctx.platformFeeBps) / 10_000;
    const netUsd = notionalUsd - venueFeeUsd - platformFeeUsd;
    const impactMult = 1 - impactBps / 10_000;
    const expectedOut = leg.side === "buy" ? (netUsd / px) * impactMult : (netUsd / qpx) * impactMult;

    const route = `${leg.venue}:${quote.symbol}->${asset.symbol}`;
    this.quotes.set(route, Date.now());
    return {
      ...leg,
      asset: asset.symbol,
      quoteAsset: quote.symbol,
      chain: asset.chain,
      expectedOut,
      priceImpactBps: impactBps,
      venueFeeUsd,
      platformFeeUsd,
      route,
    };
  }

  async simulate(leg: QuotedLeg, balances: Record<string, number>): Promise<SimulationResult> {
    const spend = leg.side === "buy" ? leg.quoteAsset : leg.asset;
    const receive = leg.side === "buy" ? leg.asset : leg.quoteAsset;
    const have = balances[spend] ?? 0;
    if (have + 1e-9 < leg.amount) {
      return { ok: false, deltas: {}, error: `Insufficient ${spend}: have ${round(have)}, need ${round(leg.amount)}` };
    }
    const risk = this.market.tokenRisk(leg.asset);
    if (leg.side === "buy" && risk && !risk.freezeRevoked) {
      return { ok: false, deltas: {}, error: `${leg.asset} still has freeze authority: sells could be blocked` };
    }
    return { ok: true, deltas: { [spend]: -leg.amount, [receive]: leg.expectedOut } };
  }

  async submit(leg: QuotedLeg, _sig: Signature): Promise<SubmitResult> {
    // Fill at a fresh price, bounded by the ticket's max slippage.
    const px = this.market.priceUsd(leg.asset);
    const qpx = this.market.priceUsd(leg.quoteAsset);
    const notional = leg.side === "buy" ? leg.amount * qpx : leg.amount * px;
    const net = notional - leg.venueFeeUsd - leg.platformFeeUsd;
    const impact = 1 - leg.priceImpactBps / 10_000;
    let out = leg.side === "buy" ? (net / px) * impact : (net / qpx) * impact;
    const minOut = leg.expectedOut * (1 - leg.maxSlippageBps / 10_000);
    if (out < minOut) {
      throw new Error(`Price moved beyond max slippage (${leg.maxSlippageBps} bps); nothing was filled`);
    }
    out = Math.min(out, leg.expectedOut * 1.02);
    return {
      txId: `paper_${newId("tx")}_${nowIso().slice(11, 19).replace(/:/g, "")}`,
      amountIn: leg.amount,
      amountOut: out,
      price: leg.side === "buy" ? leg.amount / out : out / leg.amount,
    };
  }
}

export const round = (n: number, d = 4) => Number(n.toFixed(d));
export { normalizeSymbol };
