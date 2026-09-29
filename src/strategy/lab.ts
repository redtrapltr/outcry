/**
 * Strategy Lab service: validates a DSL program, backtests it, and keeps the
 * versioned result so it can be deployed as an agent.
 */
import { AuditLog, newId, nowIso } from "../core/infra.js";
import { StrategyProgram } from "../core/types.js";
import { TF_MS, type Candle, type MarketData } from "../data/market.js";
import type { HistoryProvider } from "../data/history.js";
import { backtest, summarize, type BacktestReport } from "./backtest.js";
import { describe, DslError } from "./evaluator.js";

export interface SavedStrategy {
  id: string;
  userId: string;
  version: number;
  program: StrategyProgram;
  description: string;
  report: BacktestReport;
  summary: string;
  createdAt: string;
}

/** How many candles to backtest per timeframe (about 1-3 years). */
const HISTORY_BARS: Record<StrategyProgram["timeframe"], number> = {
  "1m": 5_000,
  "5m": 5_000,
  "15m": 8_000,
  "1h": 8_760,
  "4h": 4_380,
  "1d": 1_095,
};

interface LoadedCandles {
  candles: Candle[];
  fromIndex: number;
  source: string;
  real: boolean;
}

/** Classic, well-known strategy families with a few standard settings each. */
export function strategyTemplates(asset: string, timeframe: StrategyProgram["timeframe"], sizeUsd: number) {
  const size = { fixed_quote: sizeUsd };
  const base = { asset, timeframe, size };
  const out: { family: string; program: Record<string, unknown> }[] = [];
  const tag = timeframe.toUpperCase();
  for (const [f, sl] of [[20, 50], [50, 200]] as const)
    out.push({ family: "Moving-average trend", program: { ...base, name: `SMA ${f}/${sl} trend ${tag}`, entry: { crosses_above: [{ sma: f }, { sma: sl }] }, exit: { any: [{ crosses_below: [{ sma: f }, { sma: sl }] }, { stop_loss_pct: 10 }] } } });
  out.push({ family: "Moving-average trend", program: { ...base, name: `Price over EMA 50 ${tag}`, entry: { crosses_above: ["close", { ema: 50 }] }, exit: { any: [{ crosses_below: ["close", { ema: 50 }] }, { stop_loss_pct: 8 }] } } });
  for (const n of [20, 55])
    for (const tr of [7, 12])
      out.push({ family: "Breakout", program: { ...base, name: `${n}-bar breakout, trail ${tr}% ${tag}`, entry: { crosses_above: ["close", { highest: n }] }, exit: { any: [{ trailing_stop_pct: tr }, { stop_loss_pct: 8 }] } } });
  out.push({ family: "Mean reversion", program: { ...base, name: `RSI(2) dip in uptrend ${tag}`, entry: { all: [{ lt: [{ rsi: 2 }, 10] }, { gt: ["close", { sma: 200 }] }] }, exit: { any: [{ gt: ["close", { sma: 5 }] }, { stop_loss_pct: 8 }, { bars_held_gte: 10 }] } } });
  out.push({ family: "Mean reversion", program: { ...base, name: `RSI(14) oversold bounce ${tag}`, entry: { crosses_above: [{ rsi: 14 }, 30] }, exit: { any: [{ gt: [{ rsi: 14 }, 60] }, { stop_loss_pct: 8 }, { bars_held_gte: 30 }] } } });
  out.push({ family: "Mean reversion", program: { ...base, name: `Bollinger lower-band bounce ${tag}`, entry: { crosses_above: ["close", { bb_lower: [20, 2] }] }, exit: { any: [{ crosses_above: ["close", { sma: 20 }] }, { stop_loss_pct: 6 }, { bars_held_gte: 20 }] } } });
  out.push({ family: "Momentum", program: { ...base, name: `MACD cross over EMA 200 ${tag}`, entry: { all: [{ crosses_above: [{ macd: [12, 26, 9] }, { macd_signal: [12, 26, 9] }] }, { gt: ["close", { ema: 200 }] }] }, exit: { any: [{ crosses_below: [{ macd: [12, 26, 9] }, { macd_signal: [12, 26, 9] }] }, { stop_loss_pct: 8 }] } } });
  out.push({ family: "Momentum", program: { ...base, name: `Momentum ROC(20) > 0, trail 10% ${tag}`, entry: { crosses_above: [{ roc: 20 }, 0] }, exit: { any: [{ trailing_stop_pct: 10 }, { crosses_below: [{ roc: 20 }, 0] }] } } });
  return out;
}

export interface TestOptions {
  /** Backtest window in calendar days (e.g. 365 for one year). Default: about 1-3 years depending on timeframe. */
  days?: number;
}

export class StrategyLab {
  private strategies = new Map<string, SavedStrategy>();
  constructor(private market: MarketData, private audit: AuditLog, private history?: HistoryProvider) {}

  async compileAndTest(userId: string, input: unknown, existingId?: string, opts: TestOptions = {}): Promise<{ ok: true; strategy: SavedStrategy } | { ok: false; error: string }> {
    const parsed = StrategyProgram.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: "Invalid strategy: " + parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "program"}: ${i.message}`).join("; ") };
    }
    const program = parsed.data;
    const asset = this.market.asset(program.asset);
    if (!asset) return { ok: false, error: `Unknown asset ${program.asset}` };
    const tfMs = TF_MS[program.timeframe];
    const data = await this.loadCandles(program.asset, program.timeframe, opts.days);
    // Fixed-size strategies are measured on the money they actually put to work,
    // so "$100 per trade" reports the return on $100, not on a $10,000 account.
    const startEquity = "fixed_quote" in program.size ? program.size.fixed_quote : 10_000;
    let report: BacktestReport;
    try {
      if (data.candles.length - data.fromIndex < 100) {
        const need = Math.ceil((100 * tfMs) / 86_400_000);
        return { ok: false, error: `Only ${data.candles.length - data.fromIndex} ${program.timeframe} candles in that window; backtests need at least 100. Use a shorter timeframe or at least ${need} days.` };
      }
      report = this.run(program, data, startEquity);
    } catch (e) {
      return { ok: false, error: e instanceof DslError ? `Invalid strategy: ${e.message}` : (e as Error).message };
    }
    const prev = existingId ? this.strategies.get(existingId) : undefined;
    const s: SavedStrategy = {
      id: prev?.id ?? newId("stg"),
      userId,
      version: (prev?.version ?? 0) + 1,
      program,
      description: describe(program),
      report,
      summary: summarize(report),
      createdAt: nowIso(),
    };
    this.strategies.set(s.id, s);
    this.audit.append(`user:${userId}`, "strategy.compiled", { strategyId: s.id, version: s.version, program, full: report.full, warnings: report.warnings });
    return { ok: true, strategy: s };
  }

  private run(program: StrategyProgram, data: LoadedCandles, startEquity: number) {
    const report = backtest(program, data.candles, startEquity, data.fromIndex);
    report.dataSource = data.source;
    report.realData = data.real;
    report.startEquity = startEquity;
    return report;
  }

  /** Candles for the test window plus up to ~300 earlier bars to warm up indicators. */
  async loadCandles(symbol: string, tf: StrategyProgram["timeframe"], days?: number): Promise<LoadedCandles> {
    const asset = this.market.asset(symbol);
    const tfMs = TF_MS[tf];
    const d = days ? Math.max(1, Math.min(3_650, days)) : undefined;
    const windowBars = d ? Math.ceil((d * 86_400_000) / tfMs) : HISTORY_BARS[tf];
    const since = Date.now() - windowBars * tfMs;
    const WARMUP = 300;
    const kind = asset?.kind === "tokenized_stock" ? "stock" : asset?.kind === "native" || asset?.kind === "token" ? "crypto" : undefined;
    if (this.history && kind && !this.market.tokenRisk(symbol)) {
      // Stocks trade ~252 days a year and ~7 hours a day, so ask for extra calendar bars.
      const want = Math.min(20_000, Math.ceil(windowBars + WARMUP * (kind === "stock" ? 1.6 : 1)));
      const r = await this.history.fetch(symbol, kind, tf, want);
      if (r) {
        const fromIndex = Math.max(0, r.candles.findIndex((c) => c.t >= since));
        if (r.candles.length - fromIndex >= 60) return { candles: r.candles, fromIndex, source: r.source, real: true };
      }
    }
    const candles = this.market.candles(symbol, tf, Math.min(20_000, windowBars + WARMUP));
    return { candles, fromIndex: Math.min(WARMUP, Math.max(0, candles.length - windowBars)), source: "Simulated prices (paper mode), not real market data", real: false };
  }

  /**
   * Try a library of classic strategies on one asset and rank them honestly:
   * candidates are ranked on the first 70% of the window (in-sample), and the
   * last 30% (out-of-sample) is reported as the check that selection didn't fit noise.
   */
  async search(userId: string, opts: { asset: string; days?: number; timeframes?: StrategyProgram["timeframe"][]; sizeUsd?: number; keep?: number }) {
    const asset = this.market.asset(opts.asset);
    if (!asset) return { ok: false as const, error: `Unknown asset ${opts.asset}` };
    const size = opts.sizeUsd ?? 1_000;
    const tfs = opts.timeframes?.length ? opts.timeframes : (["1d", "4h"] as const);
    const rows: { strategy: SavedStrategy; family: string; score: number }[] = [];
    const sources = new Set<string>();
    let real = true;
    let hold: number | undefined;
    for (const tf of tfs) {
      const data = await this.loadCandles(asset.symbol, tf, opts.days ?? 365);
      sources.add(data.source);
      real &&= data.real;
      for (const t of strategyTemplates(asset.symbol, tf, size)) {
        const parsed = StrategyProgram.safeParse(t.program);
        if (!parsed.success) continue;
        let report: BacktestReport;
        try {
          report = this.run(parsed.data, data, size);
        } catch {
          continue;
        }
        if (tf === "1d" || hold === undefined) hold = report.full.buyHoldReturnPct;
        const s: SavedStrategy = { id: newId("stg"), userId, version: 1, program: parsed.data, description: describe(parsed.data), report, summary: summarize(report), createdAt: nowIso() };
        // Rank on in-sample only; strategies with too few trades are pushed down.
        const minTrades = 6;
        const score = report.inSample.totalReturnPct - (report.full.trades < minTrades ? 1_000 : 0);
        rows.push({ strategy: s, family: t.family, score });
      }
    }
    if (!rows.length) return { ok: false as const, error: "No strategy could be tested on this data" };
    rows.sort((a, b) => b.score - a.score);
    const keep = rows.slice(0, opts.keep ?? 3);
    for (const r of keep) this.strategies.set(r.strategy.id, r.strategy);
    this.audit.append(`user:${userId}`, "strategy.search", { asset: asset.symbol, tested: rows.length, top: keep.map((k) => ({ id: k.strategy.id, name: k.strategy.program.name })) });
    return {
      ok: true as const,
      asset: asset.symbol,
      tested: rows.length,
      real,
      sources: [...sources],
      buyHoldPct: hold ?? 0,
      ranking: rows.slice(0, 10).map((r, i) => ({
        rank: i + 1,
        name: r.strategy.program.name ?? r.family,
        timeframe: r.strategy.program.timeframe,
        trades: r.strategy.report.full.trades,
        inSamplePct: r.strategy.report.inSample.totalReturnPct,
        outOfSamplePct: r.strategy.report.outOfSample.totalReturnPct,
        fullPct: r.strategy.report.full.totalReturnPct,
        holdPct: r.strategy.report.full.buyHoldReturnPct,
        maxDrawdownPct: r.strategy.report.full.maxDrawdownPct,
        winRatePct: r.strategy.report.full.winRatePct,
        strategyId: keep.includes(r) ? r.strategy.id : undefined,
      })),
      top: keep.map((k) => k.strategy),
    };
  }

  get(id: string) {
    return this.strategies.get(id);
  }

  listForUser(userId: string) {
    return [...this.strategies.values()].filter((s) => s.userId === userId);
  }
}
