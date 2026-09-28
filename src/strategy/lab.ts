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
    const days = opts.days ? Math.max(1, Math.min(3_650, opts.days)) : undefined;
    const calendarBars = days ? Math.ceil((days * 86_400_000) / tfMs) : HISTORY_BARS[program.timeframe];
    const since = Date.now() - (days ?? (calendarBars * tfMs) / 86_400_000) * 86_400_000;

    let candles: Candle[] | undefined;
    let dataSource = "Simulated prices (paper mode), not real market data";
    let realData = false;
    const kind = asset.kind === "tokenized_stock" ? "stock" : asset.kind === "native" || asset.kind === "token" ? "crypto" : undefined;
    if (this.history && kind && !this.market.tokenRisk(program.asset)) {
      const r = await this.history.fetch(program.asset, kind, program.timeframe, Math.min(20_000, calendarBars));
      if (r) {
        const inWindow = r.candles.filter((c) => c.t >= since);
        if (inWindow.length >= 100) {
          candles = inWindow;
          dataSource = r.source;
          realData = true;
        }
      }
    }
    candles ??= this.market.candles(program.asset, program.timeframe, Math.min(20_000, calendarBars));

    // Fixed-size strategies are measured on the money they actually put to work,
    // so "$100 per trade" reports the return on $100, not on a $10,000 account.
    const startEquity = "fixed_quote" in program.size ? program.size.fixed_quote : 10_000;
    let report: BacktestReport;
    try {
      if (candles.length < 100) {
        const need = Math.ceil((100 * tfMs) / 86_400_000);
        return { ok: false, error: `Only ${candles.length} ${program.timeframe} candles in that window; backtests need at least 100. Use a shorter timeframe or at least ${need} days.` };
      }
      report = backtest(program, candles, startEquity);
      report.dataSource = dataSource;
      report.realData = realData;
      report.startEquity = startEquity;
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

  get(id: string) {
    return this.strategies.get(id);
  }

  listForUser(userId: string) {
    return [...this.strategies.values()].filter((s) => s.userId === userId);
  }
}
