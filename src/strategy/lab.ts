/**
 * Strategy Lab service: validates a DSL program, backtests it, and keeps the
 * versioned result so it can be deployed as an agent.
 */
import { AuditLog, newId, nowIso } from "../core/infra.js";
import { StrategyProgram } from "../core/types.js";
import type { MarketData } from "../data/market.js";
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

export class StrategyLab {
  private strategies = new Map<string, SavedStrategy>();
  constructor(private market: MarketData, private audit: AuditLog) {}

  compileAndTest(userId: string, input: unknown, existingId?: string): { ok: true; strategy: SavedStrategy } | { ok: false; error: string } {
    const parsed = StrategyProgram.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: "Invalid strategy: " + parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "program"}: ${i.message}`).join("; ") };
    }
    const program = parsed.data;
    if (!this.market.asset(program.asset)) return { ok: false, error: `Unknown asset ${program.asset}` };
    let report: BacktestReport;
    try {
      const candles = this.market.candles(program.asset, program.timeframe, HISTORY_BARS[program.timeframe]);
      report = backtest(program, candles);
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
