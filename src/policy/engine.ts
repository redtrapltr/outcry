/**
 * Policy engine: the only gate between a proposed ticket and the signer.
 *
 * Pure functions over structured data. It never reads free text from the
 * LLM; amounts, assets and venues come from the ticket's typed fields.
 * Every rule returns a verdict with a reason a user can read.
 */
import type { Agent, LaunchRequest, OrderTicket, UserProfile } from "../core/types.js";
import type { MarketData } from "../data/market.js";

export type Verdict =
  | { decision: "allow"; warnings: string[]; notes: string[] }
  | { decision: "second_confirmation"; reason: string; warnings: string[]; notes: string[] }
  | { decision: "reject"; reason: string };

export interface PolicyConfig {
  /** ISO country codes blocked from tokenized stocks (issuer restrictions). */
  stockBlockedCountries: string[];
  maxSlippageBpsMajor: number;
  maxSlippageBpsMeme: number;
  warnImpactBps: number;
  rejectImpactBps: number;
  medianMultipleForSecondConfirm: number;
  launch: {
    maxDevSharePct: number;
    feeReserveSol: number;
    blockedTickers: string[];
    maxImageBytes: number;
  };
}

export const DEFAULT_POLICY: PolicyConfig = {
  stockBlockedCountries: ["US"],
  maxSlippageBpsMajor: 300,
  maxSlippageBpsMeme: 1_500,
  warnImpactBps: 300,
  rejectImpactBps: 2_000,
  medianMultipleForSecondConfirm: 5,
  launch: {
    maxDevSharePct: 25,
    feeReserveSol: 0.05,
    blockedTickers: [
      "BTC", "ETH", "SOL", "USDC", "USDT", "BNB", "XRP", "DOGE", "PEPE", "BONK", "WIF", "JUP", "TRUMP",
      "NVDA", "TSLA", "AAPL", "SPY", "COIN", "OUTCRY", "WOODENG", "BINANCE", "COINBASE", "PUMP",
    ],
    maxImageBytes: 2_000_000,
  },
};

export interface OrderContext {
  user: UserProfile;
  walletUsd: number;
  agent?: Agent;
}

export function evaluateOrder(t: OrderTicket, ctx: OrderContext, market: MarketData, cfg = DEFAULT_POLICY): Verdict {
  const warnings: string[] = [];
  const notes: string[] = [];

  for (const [i, leg] of t.legs.entries()) {
    const asset = market.asset(leg.asset);
    if (!asset) return { decision: "reject", reason: `Leg ${i + 1}: unknown asset ${leg.asset}` };

    if (asset.kind === "tokenized_stock" && cfg.stockBlockedCountries.includes(ctx.user.residence)) {
      return { decision: "reject", reason: `Tokenized stocks are not available in your country (${ctx.user.residence})` };
    }

    const risk = market.tokenRisk(asset.symbol);
    const maxSlip = risk ? cfg.maxSlippageBpsMeme : cfg.maxSlippageBpsMajor;
    if (leg.maxSlippageBps > maxSlip) {
      return { decision: "reject", reason: `Leg ${i + 1}: slippage ${leg.maxSlippageBps} bps is above the ${maxSlip} bps limit` };
    }
    if (leg.priceImpactBps >= cfg.rejectImpactBps) {
      return { decision: "reject", reason: `Leg ${i + 1}: price impact ${(leg.priceImpactBps / 100).toFixed(1)}% is too high; try a smaller size` };
    }
    if (leg.priceImpactBps >= cfg.warnImpactBps) {
      warnings.push(`High price impact on ${leg.asset}: ${(leg.priceImpactBps / 100).toFixed(1)}%`);
    }
    if (risk && leg.side === "buy") {
      if (!risk.mintRevoked) warnings.push(`${risk.symbol}: mint authority is still active (supply can grow)`);
      if (risk.topWalletPct > 30) warnings.push(`${risk.symbol}: top wallet holds ${risk.topWalletPct}% of supply`);
      if (risk.creatorWallets.length > 1) {
        notes.push(`${risk.symbol}: creator holds supply across ${risk.creatorWallets.length} disclosed wallets`);
      }
    }
    notes.push(
      `${leg.side.toUpperCase()} ${leg.asset} via ${leg.venue}: venue fee $${leg.venueFeeUsd.toFixed(2)}, Outcry fee $${leg.platformFeeUsd.toFixed(2)}, max slippage ${leg.maxSlippageBps / 100}%`,
    );
  }

  // Agent limits (enforced again inside the signer's wallet policy).
  if (ctx.agent) {
    const a = ctx.agent;
    const lim = a.spec.limits;
    if (a.state !== "live" && a.state !== "paper") {
      return { decision: "reject", reason: `Agent ${a.spec.name} is ${a.state}` };
    }
    if (t.totalUsd > lim.maxPerTradeUsd + 1e-9) {
      return { decision: "reject", reason: `Agent ${a.spec.name}: $${t.totalUsd.toFixed(2)} is over its per-trade limit of $${lim.maxPerTradeUsd}` };
    }
    if (a.stats.spentTodayUsd + t.totalUsd > lim.maxPerDayUsd + 1e-9) {
      return { decision: "reject", reason: `Agent ${a.spec.name}: daily limit of $${lim.maxPerDayUsd} reached` };
    }
    const buys = t.legs.filter((l) => l.side === "buy").length;
    if (a.stats.openPositions + buys > lim.maxOpenPositions) {
      return { decision: "reject", reason: `Agent ${a.spec.name}: already at ${lim.maxOpenPositions} open positions` };
    }
    return { decision: "allow", warnings, notes };
  }

  // Amount sanity for human orders.
  const pct = ctx.walletUsd > 0 ? (t.totalUsd / ctx.walletUsd) * 100 : 100;
  if (pct >= ctx.user.settings.secondConfirmAbovePctOfWallet) {
    return {
      decision: "second_confirmation",
      reason: `This order is ${pct.toFixed(0)}% of your wallet. Confirm twice to continue.`,
      warnings,
      notes,
    };
  }
  if (ctx.user.medianOrderUsd > 0 && t.totalUsd > ctx.user.medianOrderUsd * cfg.medianMultipleForSecondConfirm) {
    return {
      decision: "second_confirmation",
      reason: `This order is ${(t.totalUsd / ctx.user.medianOrderUsd).toFixed(1)}x your usual size. Confirm twice to continue.`,
      warnings,
      notes,
    };
  }
  return { decision: "allow", warnings, notes };
}

// ---------------------------------------------------------------------------
// Launches
// ---------------------------------------------------------------------------

/**
 * pump.fun bonding curve starts at 30 virtual SOL and 1.073B virtual tokens
 * (constant product). Used to estimate the dev buy's share of the 1B supply.
 * Verify these constants against the program before live launches.
 */
export const PUMP_VIRTUAL_SOL = 30;
export const PUMP_VIRTUAL_TOKENS = 1_073_000_000;
export const PUMP_TOTAL_SUPPLY = 1_000_000_000;

export function estimateDevShare(totalSol: number): { tokens: number; pct: number } {
  const k = PUMP_VIRTUAL_SOL * PUMP_VIRTUAL_TOKENS;
  const tokens = PUMP_VIRTUAL_TOKENS - k / (PUMP_VIRTUAL_SOL + totalSol);
  return { tokens, pct: (tokens / PUMP_TOTAL_SUPPLY) * 100 };
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

export function evaluateLaunch(req: LaunchRequest, solBalance: number, cfg = DEFAULT_POLICY): Verdict {
  const ticker = req.ticker.toUpperCase();
  const clash = cfg.launch.blockedTickers.find((b) => b === ticker || (b.length >= 4 && levenshtein(b, ticker) <= 1));
  if (clash) {
    return { decision: "reject", reason: `$${ticker} is too close to an existing token or brand ($${clash}). Pick another ticker.` };
  }
  if (req.imageDataUrl && req.imageDataUrl.length * 0.75 > cfg.launch.maxImageBytes) {
    return { decision: "reject", reason: "Logo is larger than 2 MB" };
  }
  const total = req.wallets * req.solPerWallet;
  if (total + cfg.launch.feeReserveSol > solBalance + 1e-9) {
    return { decision: "reject", reason: `Not enough SOL: dev buy ${total.toFixed(2)} SOL plus ~${cfg.launch.feeReserveSol} SOL fees, you have ${solBalance.toFixed(2)} SOL` };
  }
  const share = estimateDevShare(total);
  if (share.pct > cfg.launch.maxDevSharePct) {
    return {
      decision: "reject",
      reason: `A ${total.toFixed(2)} SOL dev buy would take about ${share.pct.toFixed(1)}% of supply; the limit is ${cfg.launch.maxDevSharePct}%. Lower the SOL per wallet.`,
    };
  }
  return {
    decision: "allow",
    warnings: share.pct > 15 ? [`Dev buy takes about ${share.pct.toFixed(1)}% of supply; buyers will see this on the token page`] : [],
    notes: [
      `Estimated dev share: ${share.pct.toFixed(1)}% of supply across ${req.wallets} disclosed wallet${req.wallets > 1 ? "s" : ""}`,
      "Create instruction and all dev buys land in one Jito bundle",
      "Mint authority is revoked at launch (pump.fun standard)",
    ],
  };
}
