import type { Chain, OrderLeg, QuotedLeg, Venue } from "../core/types.js";
import type { Signature } from "../wallet/signer.js";

export interface QuoteContext {
  userId: string;
  platformFeeBps: number;
}

export interface SimulationResult {
  ok: boolean;
  /** Balance changes by symbol, negative = spent. Must match the ticket. */
  deltas: Record<string, number>;
  error?: string;
}

export interface SubmitResult {
  txId: string;
  amountIn: number;
  amountOut: number;
  price: number;
}

/**
 * One adapter per venue. The policy engine only sees QuotedLeg objects; it
 * never needs to know how a venue builds its transactions.
 */
export interface ExecutionAdapter {
  readonly venue: Venue;
  readonly chain: Chain;
  quote(leg: OrderLeg & { venue: Venue }, ctx: QuoteContext): Promise<QuotedLeg>;
  simulate(leg: QuotedLeg, balances: Record<string, number>): Promise<SimulationResult>;
  submit(leg: QuotedLeg, signature: Signature): Promise<SubmitResult>;
}

/**
 * Venue fee schedule in basis points. Sources (as of Sept 2026):
 *  - pump.fun bonding curve 125 bps total (pump.fun/docs/fees)
 *  - Jupiter 5-10 bps typical, 50 bps on tokens < 24h old (developers.jup.ag)
 *  - Uniswap v3 common pool tier 30 bps
 *  - Ondo: not published; 10 bps placeholder until the commercial terms land
 */
export const VENUE_FEE_BPS: Record<Venue, number> = {
  pumpfun: 125,
  jupiter: 10,
  uniswap: 30,
  ondo: 10,
  xstocks: 10,
  paper: 0,
};

export const NEW_TOKEN_JUPITER_FEE_BPS = 50;
