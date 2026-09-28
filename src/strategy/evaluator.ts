/**
 * Compiles a StrategyProgram (the DSL the LLM writes) into evaluators over a
 * candle array. The same evaluator runs in backtests and in live agents, so
 * a strategy behaves identically in both.
 */
import type { Condition, StrategyProgram, ValueExpr } from "../core/types.js";
import type { Candle } from "../data/market.js";
import * as ind from "./indicators.js";

export interface PositionState {
  entryPrice: number;
  barsHeld: number;
  peakPrice: number;
}

export interface Compiled {
  /** Number of bars needed before every indicator is defined. */
  warmup: number;
  entry(i: number): boolean;
  exit(i: number, pos: PositionState): boolean;
  /** Stop / take-profit levels for intrabar exits, if the exit uses them. */
  stops: { stopLossPct?: number; takeProfitPct?: number; trailingStopPct?: number };
  paramCount: number;
}

export class DslError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "DslError";
  }
}

function key(v: ValueExpr) {
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function periodOf(v: ValueExpr): number {
  if (typeof v !== "object") return 0;
  if ("macd" in v) return v.macd[1] + 1;
  if ("macd_signal" in v) return v.macd_signal[1] + v.macd_signal[2] + 1;
  if ("bb_upper" in v) return v.bb_upper[0] + 1;
  if ("bb_lower" in v) return v.bb_lower[0] + 1;
  return (Object.values(v)[0] as number) + 1;
}

function countParams(v: ValueExpr): number {
  if (typeof v !== "object") return 0;
  const val = Object.values(v)[0] as number | number[];
  return Array.isArray(val) ? val.length : 1;
}

export function compile(program: StrategyProgram, candles: Candle[]): Compiled {
  const closes = Float64Array.from(candles, (c) => c.close);
  const cache = new Map<string, ind.Series>();
  let warmup = 1;
  let paramCount = 0;
  const seen = new Set<string>();

  const series = (v: ValueExpr): ind.Series | number => {
    if (typeof v === "number") return v;
    const k = key(v);
    const hit = cache.get(k);
    if (hit) return hit;
    let s: ind.Series;
    if (typeof v === "string") {
      s = Float64Array.from(candles, (c) => c[v]);
    } else if ("sma" in v) s = ind.sma(closes, v.sma);
    else if ("ema" in v) s = ind.ema(closes, v.ema);
    else if ("rsi" in v) s = ind.rsi(closes, v.rsi);
    else if ("atr" in v) s = ind.atr(candles, v.atr);
    else if ("roc" in v) s = ind.roc(closes, v.roc);
    else if ("vwap" in v) s = ind.vwap(candles, v.vwap);
    else if ("macd" in v) s = ind.macd(closes, ...v.macd).line;
    else if ("macd_signal" in v) s = ind.macd(closes, ...v.macd_signal).signal;
    else if ("bb_upper" in v) s = ind.bollinger(closes, ...v.bb_upper).upper;
    else if ("bb_lower" in v) s = ind.bollinger(closes, ...v.bb_lower).lower;
    else if ("highest" in v) s = ind.highest(closes, v.highest);
    else if ("lowest" in v) s = ind.lowest(closes, v.lowest);
    else throw new DslError(`Unknown value ${JSON.stringify(v)}`);
    warmup = Math.max(warmup, periodOf(v));
    // MACD line and its signal share one parameter set; count it once.
    const pk = typeof v === "object" ? JSON.stringify(Object.values(v)[0]) + (("macd" in v || "macd_signal" in v) ? ":macd" : ":" + Object.keys(v)[0]) : k;
    if (!seen.has(pk)) {
      seen.add(pk);
      paramCount += countParams(v);
    }
    cache.set(k, s);
    return s;
  };

  const at = (s: ind.Series | number, i: number) => (typeof s === "number" ? s : s[i]!);

  const stops: Compiled["stops"] = {};

  type Ev = (i: number, pos?: PositionState) => boolean;
  const build = (c: Condition, inExit: boolean): Ev => {
    if ("all" in c) {
      const parts = c.all.map((x) => build(x, inExit));
      return (i, p) => parts.every((f) => f(i, p));
    }
    if ("any" in c) {
      const parts = c.any.map((x) => build(x, inExit));
      return (i, p) => parts.some((f) => f(i, p));
    }
    if ("not" in c) {
      const f = build(c.not, inExit);
      return (i, p) => !f(i, p);
    }
    if ("gt" in c || "lt" in c) {
      const [a, b] = "gt" in c ? c.gt : c.lt;
      const sa = series(a);
      const sb = series(b);
      paramCount += typeof a === "number" ? 1 : 0;
      paramCount += typeof b === "number" ? 1 : 0;
      const gt = "gt" in c;
      return (i) => {
        const x = at(sa, i);
        const y = at(sb, i);
        if (Number.isNaN(x) || Number.isNaN(y)) return false;
        return gt ? x > y : x < y;
      };
    }
    if ("crosses_above" in c || "crosses_below" in c) {
      const [a, b] = "crosses_above" in c ? c.crosses_above : c.crosses_below;
      const sa = series(a);
      const sb = series(b);
      paramCount += (typeof a === "number" ? 1 : 0) + (typeof b === "number" ? 1 : 0);
      const up = "crosses_above" in c;
      return (i) => {
        if (i < 1) return false;
        const x0 = at(sa, i - 1), x1 = at(sa, i), y0 = at(sb, i - 1), y1 = at(sb, i);
        if ([x0, x1, y0, y1].some(Number.isNaN)) return false;
        return up ? x0 <= y0 && x1 > y1 : x0 >= y0 && x1 < y1;
      };
    }
    if (!inExit) throw new DslError("Stops and holding-time rules can only appear in the exit condition");
    if ("stop_loss_pct" in c) {
      stops.stopLossPct = c.stop_loss_pct;
      paramCount++;
      return (i, p) => !!p && candles[i]!.close <= p.entryPrice * (1 - c.stop_loss_pct / 100);
    }
    if ("take_profit_pct" in c) {
      stops.takeProfitPct = c.take_profit_pct;
      paramCount++;
      return (i, p) => !!p && candles[i]!.close >= p.entryPrice * (1 + c.take_profit_pct / 100);
    }
    if ("trailing_stop_pct" in c) {
      stops.trailingStopPct = c.trailing_stop_pct;
      paramCount++;
      return (i, p) => !!p && candles[i]!.close <= p.peakPrice * (1 - c.trailing_stop_pct / 100);
    }
    if ("bars_held_gte" in c) {
      paramCount++;
      return (_i, p) => !!p && p.barsHeld >= c.bars_held_gte;
    }
    throw new DslError(`Unknown condition ${JSON.stringify(c)}`);
  };

  const entry = build(program.entry, false);
  const exit = build(program.exit, true);
  return { warmup, entry: (i) => entry(i), exit: (i, p) => exit(i, p), stops, paramCount };
}

/** Plain-language rendering of a program, for tickets and chat replies. */
export function describe(p: StrategyProgram): string {
  const v = (x: ValueExpr): string => {
    if (typeof x === "number") return String(x);
    if (typeof x === "string") return x;
    const [k, val] = Object.entries(x)[0]!;
    return `${k.toUpperCase().replace("_", " ")}(${Array.isArray(val) ? val.join(",") : val})`;
  };
  const c = (x: Condition): string => {
    if ("all" in x) return x.all.map(c).join(" AND ");
    if ("any" in x) return "(" + x.any.map(c).join(" OR ") + ")";
    if ("not" in x) return `NOT ${c(x.not)}`;
    if ("gt" in x) return `${v(x.gt[0])} > ${v(x.gt[1])}`;
    if ("lt" in x) return `${v(x.lt[0])} < ${v(x.lt[1])}`;
    if ("crosses_above" in x) return `${v(x.crosses_above[0])} crosses above ${v(x.crosses_above[1])}`;
    if ("crosses_below" in x) return `${v(x.crosses_below[0])} crosses below ${v(x.crosses_below[1])}`;
    if ("stop_loss_pct" in x) return `stop −${x.stop_loss_pct}%`;
    if ("take_profit_pct" in x) return `take profit +${x.take_profit_pct}%`;
    if ("trailing_stop_pct" in x) return `trailing stop ${x.trailing_stop_pct}%`;
    return `held ${x.bars_held_gte} bars`;
  };
  const size = "risk_pct_of_equity" in p.size ? `risk ${p.size.risk_pct_of_equity}% of equity per trade` : `$${p.size.fixed_quote} per trade`;
  return `${p.asset} on ${p.timeframe}. Enter when ${c(p.entry)}. Exit when ${c(p.exit)}. Size: ${size}.`;
}
