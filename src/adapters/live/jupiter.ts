/**
 * Jupiter live adapter (Solana).
 *
 * STATUS: written against Jupiter's quote/swap HTTP shape; not exercised by
 * the test suite (the sandbox has no network). Before enabling live mode:
 *   1. Confirm endpoint paths against the current Swap V2 docs
 *      (developers.jup.ag). Ultra is no longer maintained.
 *   2. Register the integrator fee account (Jupiter keeps 20% of it).
 *   3. Run against mainnet with a funded test wallet and $1 orders.
 *
 * The adapter never signs. It returns an unsigned transaction that goes to
 * the signer only after the policy engine and the user approve the ticket.
 */
import type { OrderLeg, QuotedLeg, Venue } from "../../core/types.js";
import type { Signature } from "../../wallet/signer.js";
import type { ExecutionAdapter, QuoteContext, SimulationResult, SubmitResult } from "../types.js";

export interface JupiterConfig {
  baseUrl: string; // e.g. "https://api.jup.ag/swap/v2" (verify)
  apiKey: string;
  feeAccount?: string;
  rpcUrl: string; // Helius/Triton, used for simulateTransaction and sending
  jitoUrl?: string; // bundle endpoint for MEV protection
  resolveMint: (symbol: string) => { mint: string; decimals: number } | undefined;
}

interface JupQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: { swapInfo: { label: string } }[];
  platformFee?: { amount: string; feeBps: number };
}

export class JupiterAdapter implements ExecutionAdapter {
  readonly venue: Venue = "jupiter";
  readonly chain = "solana" as const;
  private lastQuote = new Map<string, JupQuote>();

  constructor(private cfg: JupiterConfig, private fetchImpl: typeof fetch = fetch) {}

  private headers() {
    return { "content-type": "application/json", "x-api-key": this.cfg.apiKey };
  }

  async quote(leg: OrderLeg & { venue: Venue }, ctx: QuoteContext): Promise<QuotedLeg> {
    const input = this.cfg.resolveMint(leg.side === "buy" ? leg.quoteAsset : leg.asset);
    const output = this.cfg.resolveMint(leg.side === "buy" ? leg.asset : leg.quoteAsset);
    if (!input || !output) throw new Error("Unknown mint for Jupiter quote");
    const amountAtomic = BigInt(Math.round(leg.amount * 10 ** input.decimals)).toString();
    const params = new URLSearchParams({
      inputMint: input.mint,
      outputMint: output.mint,
      amount: amountAtomic,
      slippageBps: String(leg.maxSlippageBps),
      platformFeeBps: String(ctx.platformFeeBps),
    });
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/quote?${params}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status}`);
    const q = (await res.json()) as JupQuote;
    const out = Number(q.outAmount) / 10 ** output.decimals;
    const route = q.routePlan.map((r) => r.swapInfo.label).join(" > ");
    const key = `${input.mint}:${output.mint}:${amountAtomic}`;
    this.lastQuote.set(key, q);
    return {
      ...leg,
      chain: "solana",
      expectedOut: out,
      priceImpactBps: Math.round(Number(q.priceImpactPct) * 10_000),
      venueFeeUsd: 0, // filled by the pricing service from route fees
      platformFeeUsd: 0,
      route: `jupiter:${route}`,
    };
  }

  async simulate(_leg: QuotedLeg, _balances: Record<string, number>): Promise<SimulationResult> {
    // 1. POST /swap with the stored quote -> base64 unsigned transaction
    // 2. RPC simulateTransaction with replaceRecentBlockhash + accounts to watch
    // 3. Diff pre/post token balances; reject anything not on the ticket
    throw new Error("Live simulation not enabled in v0: set OUTCRY_MODE=live after wiring RPC");
  }

  async submit(_leg: QuotedLeg, _sig: Signature): Promise<SubmitResult> {
    // Send via Jito bundle (tip from recent percentiles), confirm, retry once
    // with a fresh blockhash, then parse the fill from the transaction meta.
    throw new Error("Live submit not enabled in v0");
  }
}
