/**
 * Backtester for StrategyProgram.
 *
 * Execution model (no look-ahead):
 *   - signals are evaluated on the close of bar i
 *   - orders fill at the open of bar i+1, plus slippage and fees
 *   - stop-loss / take-profit / trailing stops can trigger intrabar on bar i
 *     using its high/low, filled at the stop level (gaps fill at the open)
 *
 * Reports in-sample and out-of-sample (walk-forward 70/30) results, a
 * buy-and-hold benchmark, a Monte Carlo drawdown range and overfitting flags.
 */
import type { StrategyProgram } from "../core/types.js";
import type { Candle } from "../data/market.js";
import { compile, type PositionState } from "./evaluator.js";
import { rng } from "../data/market.js";

export interface Trade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  returnPct: number;
  reason: "signal" | "stop" | "take_profit" | "trailing" | "end";
}

export interface Metrics {
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  buyHoldReturnPct: number;
  maxDrawdownPct: number;
  trades: number;
  winRatePct: number;
  avgTradePct: number;
  exposurePct: number;
  sharpe: number;
  worstMonthPct: number;
  feesPaid: number;
}

export interface BacktestReport {
  program: StrategyProgram;
  bars: number;
  from: number;
  to: number;
  full: Metrics;
  inSample: Metrics;
  outOfSample: Metrics;
  monteCarloDrawdownPct: { p5: number; p50: number; p95: number };
  warnings: string[];
  equityCurve: { t: number; equity: number }[];
  trades: Trade[];
  paramCount: number;
}

interface RunResult {
  metrics: Metrics;
  trades: Trade[];
  curve: { t: number; equity: number }[];
}

function run(program: StrategyProgram, candles: Candle[], startIdx: number, endIdx: number, startEquity: number): RunResult {
  const c = compile(program, candles);
  const fee = program.feesBps / 10_000;
  const slip = program.slippageBps / 10_000;
  let cash = startEquity;
  let qty = 0;
  let pos: (PositionState & { entryTime: number; cost: number }) | null = null;
  let pendingEntry = false;
  let pendingExit = false;
  let feesPaid = 0;
  let barsInMarket = 0;
  const trades: Trade[] = [];
  const curve: { t: number; equity: number }[] = [];
  const from = Math.max(startIdx, c.warmup);

  const closeAt = (i: number, price: number, reason: Trade["reason"]) => {
    const px = price * (1 - slip);
    const gross = qty * px;
    const f = gross * fee;
    feesPaid += f;
    cash += gross - f;
    const pnl = gross - f - pos!.cost;
    trades.push({ entryTime: pos!.entryTime, exitTime: candles[i]!.t, entryPrice: pos!.entryPrice, exitPrice: px, qty, pnl, returnPct: (pnl / pos!.cost) * 100, reason });
    qty = 0;
    pos = null;
  };

  for (let i = from; i <= endIdx; i++) {
    const bar = candles[i]!;
    // 1. Fill orders decided on the previous close, at this bar's open.
    if (pendingExit && pos) {
      closeAt(i, bar.open, "signal");
      pendingExit = false;
    }
    if (pendingEntry && !pos) {
      const equity = cash;
      let notional: number;
      if ("risk_pct_of_equity" in program.size) {
        const r = program.size.risk_pct_of_equity / 100;
        notional = c.stops.stopLossPct ? (equity * r) / (c.stops.stopLossPct / 100) : equity * r;
      } else notional = program.size.fixed_quote;
      notional = Math.min(notional, equity / (1 + fee));
      if (notional > 0) {
        const px = bar.open * (1 + slip);
        const f = notional * fee;
        feesPaid += f;
        qty = notional / px;
        cash -= notional + f;
        pos = { entryPrice: px, barsHeld: 0, peakPrice: px, entryTime: bar.t, cost: notional + f };
      }
      pendingEntry = false;
    }

    // 2. Intrabar stops on this bar.
    if (pos) {
      barsInMarket++;
      const p: typeof pos = pos;
      const s = c.stops;
      const stopPx = s.stopLossPct ? p.entryPrice * (1 - s.stopLossPct / 100) : -Infinity;
      const trailPx = s.trailingStopPct ? p.peakPrice * (1 - s.trailingStopPct / 100) : -Infinity;
      const tpPx = s.takeProfitPct ? p.entryPrice * (1 + s.takeProfitPct / 100) : Infinity;
      const hardStop = Math.max(stopPx, trailPx);
      if (bar.low <= hardStop) {
        closeAt(i, Math.min(bar.open, hardStop), hardStop === stopPx ? "stop" : "trailing");
      } else if (bar.high >= tpPx) {
        closeAt(i, Math.max(bar.open, tpPx), "take_profit");
      } else {
        p.peakPrice = Math.max(p.peakPrice, bar.high);
        p.barsHeld++;
      }
    }

    // 3. Decide on this close; fill next bar.
    if (i < endIdx) {
      if (pos && c.exit(i, pos)) pendingExit = true;
      else if (!pos && c.entry(i)) pendingEntry = true;
    }
    curve.push({ t: bar.t, equity: cash + qty * bar.close });
  }
  if (pos) closeAt(endIdx, candles[endIdx]!.close, "end");
  if (curve.length) curve[curve.length - 1]!.equity = cash;

  return { metrics: metrics(startEquity, curve, trades, candles, from, endIdx, barsInMarket, feesPaid), trades, curve };
}

function metrics(start: number, curve: { t: number; equity: number }[], trades: Trade[], candles: Candle[], from: number, to: number, barsIn: number, fees: number): Metrics {
  const end = curve.at(-1)?.equity ?? start;
  let peak = start;
  let mdd = 0;
  const rets: number[] = [];
  let prev = start;
  const months = new Map<string, { a: number; b: number }>();
  for (const pt of curve) {
    peak = Math.max(peak, pt.equity);
    mdd = Math.max(mdd, (peak - pt.equity) / peak);
    rets.push(pt.equity / prev - 1);
    prev = pt.equity;
    const m = new Date(pt.t).toISOString().slice(0, 7);
    const e = months.get(m);
    if (!e) months.set(m, { a: pt.equity, b: pt.equity });
    else e.b = pt.equity;
  }
  const mean = rets.reduce((s, r) => s + r, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const barMs = candles.length > 1 ? candles[1]!.t - candles[0]!.t : 3_600_000;
  const barsPerYear = (365 * 86_400_000) / barMs;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const worstMonth = Math.min(0, ...[...months.values()].map((m) => ((m.b - m.a) / m.a) * 100));
  const firstPx = candles[from]?.open ?? 1;
  const lastPx = candles[to]?.close ?? 1;
  return {
    startEquity: start,
    endEquity: end,
    totalReturnPct: ((end - start) / start) * 100,
    buyHoldReturnPct: ((lastPx - firstPx) / firstPx) * 100,
    maxDrawdownPct: mdd * 100,
    trades: trades.length,
    winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
    avgTradePct: trades.length ? trades.reduce((s, t) => s + t.returnPct, 0) / trades.length : 0,
    exposurePct: ((barsIn / Math.max(1, to - from + 1)) * 100),
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(barsPerYear) : 0,
    worstMonthPct: worstMonth,
    feesPaid: fees,
  };
}

function monteCarlo(trades: Trade[], start: number, n = 500, seed = 7) {
  if (trades.length < 2) return { p5: 0, p50: 0, p95: 0 };
  const r = rng(seed);
  const dds: number[] = [];
  const rets = trades.map((t) => t.pnl / start);
  for (let k = 0; k < n; k++) {
    const shuffled = [...rets];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    let eq = 1, peak = 1, mdd = 0;
    for (const x of shuffled) {
      eq += x;
      peak = Math.max(peak, eq);
      mdd = Math.max(mdd, (peak - eq) / peak);
    }
    dds.push(mdd * 100);
  }
  dds.sort((a, b) => a - b);
  const q = (p: number) => dds[Math.min(dds.length - 1, Math.floor(p * dds.length))]!;
  return { p5: q(0.05), p50: q(0.5), p95: q(0.95) };
}

export function backtest(program: StrategyProgram, candles: Candle[], startEquity = 10_000): BacktestReport {
  if (candles.length < 100) throw new Error("Need at least 100 candles to backtest");
  const compiled = compile(program, candles); // validates the program
  if (compiled.warmup >= candles.length * 0.5) throw new Error("Indicators need more history than available; use a longer period or smaller lookbacks");
  const last = candles.length - 1;
  const split = Math.floor(candles.length * 0.7);
  const full = run(program, candles, 0, last, startEquity);
  const is = run(program, candles, 0, split, startEquity);
  const oos = run(program, candles, split, last, startEquity);

  const warnings: string[] = [];
  if (compiled.paramCount > 5) warnings.push(`${compiled.paramCount} tuned parameters: high risk of fitting noise`);
  if (full.metrics.trades < 30) warnings.push(`Only ${full.metrics.trades} trades: too few to trust the statistics`);
  // Compare return per bar, since the two windows differ in length (70/30).
  const isRate = is.metrics.totalReturnPct / Math.max(1, split);
  const oosRate = oos.metrics.totalReturnPct / Math.max(1, last - split);
  if (isRate > 0 && oosRate < isRate * 0.3) {
    warnings.push("Out-of-sample return is far below in-sample: the edge may not persist");
  }
  if (full.metrics.totalReturnPct < full.metrics.buyHoldReturnPct) warnings.push("Underperforms simply holding the asset over this period");

  // Downsample the curve to ~200 points for the UI.
  const stride = Math.max(1, Math.floor(full.curve.length / 200));
  return {
    program,
    bars: candles.length,
    from: candles[0]!.t,
    to: candles[last]!.t,
    full: full.metrics,
    inSample: is.metrics,
    outOfSample: oos.metrics,
    monteCarloDrawdownPct: monteCarlo(full.trades, startEquity),
    warnings,
    equityCurve: full.curve.filter((_, i) => i % stride === 0 || i === full.curve.length - 1),
    trades: full.trades,
    paramCount: compiled.paramCount,
  };
}

export function summarize(r: BacktestReport): string {
  const f = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
  return [
    `Past ${Math.round((r.to - r.from) / 86_400_000)} days, ${r.full.trades} trades: ${f(r.full.totalReturnPct)} vs ${f(r.full.buyHoldReturnPct)} holding.`,
    `Max drawdown ${r.full.maxDrawdownPct.toFixed(1)}% (Monte Carlo range ${r.monteCarloDrawdownPct.p5.toFixed(1)}–${r.monteCarloDrawdownPct.p95.toFixed(1)}%), win rate ${r.full.winRatePct.toFixed(0)}%.`,
    `Out-of-sample (last 30%): ${f(r.outOfSample.totalReturnPct)}. These are past, simulated results, not a forecast.`,
  ].join(" ");
}
