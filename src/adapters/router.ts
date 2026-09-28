/**
 * Picks the venue for a leg and the adapter implementation for the current
 * mode. Venue choice is deterministic code, never the LLM's decision: the
 * model may suggest a venue, but this router has the final word.
 */
import type { OrderLeg, Venue } from "../core/types.js";
import type { MarketData } from "../data/market.js";
import type { ExecutionAdapter } from "./types.js";

export type ExecutionMode = "paper" | "live";

export function chooseVenue(leg: OrderLeg, market: MarketData): Venue {
  const asset = market.asset(leg.asset);
  if (!asset) throw new Error(`Unknown asset "${leg.asset}"`);
  if (asset.kind === "tokenized_stock") {
    return asset.chain === "solana" ? "xstocks" : "ondo";
  }
  const risk = market.tokenRisk(asset.symbol);
  if (risk) {
    // Still on the bonding curve if liquidity is small and it's young.
    return risk.liquidityUsd < 70_000 && risk.ageMinutes < 7 * 24 * 60 ? "pumpfun" : "jupiter";
  }
  if (asset.chain === "solana") return "jupiter";
  return "uniswap";
}

export class ExecutionRouter {
  constructor(
    private market: MarketData,
    private paper: ExecutionAdapter,
    private live: Partial<Record<Venue, ExecutionAdapter>> = {},
    public mode: ExecutionMode = "paper",
  ) {}

  venueFor(leg: OrderLeg): Venue {
    return chooseVenue(leg, this.market);
  }

  adapterFor(venue: Venue): ExecutionAdapter {
    if (this.mode === "paper") return this.paper;
    const a = this.live[venue];
    if (!a) throw new Error(`No live adapter for ${venue}; run in paper mode or add the adapter`);
    return a;
  }
}
