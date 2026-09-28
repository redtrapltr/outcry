/**
 * Indicator library. Every function returns a series aligned with the input
 * candles; values are NaN until the indicator has enough history. Each value
 * at index i uses only candles 0..i, so nothing can look ahead.
 */
import type { Candle } from "../data/market.js";

export type Series = Float64Array;

const nanSeries = (n: number) => new Float64Array(n).fill(NaN);

export function sma(xs: ArrayLike<number>, p: number): Series {
  const out = nanSeries(xs.length);
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i]!;
    if (i >= p) sum -= xs[i - p]!;
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

export function ema(xs: ArrayLike<number>, p: number): Series {
  const out = nanSeries(xs.length);
  const k = 2 / (p + 1);
  let prev = NaN;
  let seed = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    if (Number.isNaN(x)) continue;
    if (Number.isNaN(prev)) {
      seed += x;
      if (i >= p - 1) {
        // seed with the SMA of the first p values
        prev = seed / p;
        out[i] = prev;
      }
      continue;
    }
    prev = x * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(closes: ArrayLike<number>, p: number): Series {
  const out = nanSeries(closes.length);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    const g = Math.max(ch, 0);
    const l = Math.max(-ch, 0);
    if (i <= p) {
      gain += g;
      loss += l;
      if (i === p) {
        gain /= p;
        loss /= p;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (p - 1) + g) / p;
      loss = (loss * (p - 1) + l) / p;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

export function atr(c: Candle[], p: number): Series {
  const tr = new Float64Array(c.length);
  for (let i = 0; i < c.length; i++) {
    const prevClose = i > 0 ? c[i - 1]!.close : c[i]!.open;
    tr[i] = Math.max(c[i]!.high - c[i]!.low, Math.abs(c[i]!.high - prevClose), Math.abs(c[i]!.low - prevClose));
  }
  // Wilder smoothing
  const out = nanSeries(c.length);
  let prev = NaN;
  let sum = 0;
  for (let i = 0; i < c.length; i++) {
    if (i < p) {
      sum += tr[i]!;
      if (i === p - 1) {
        prev = sum / p;
        out[i] = prev;
      }
    } else {
      prev = (prev * (p - 1) + tr[i]!) / p;
      out[i] = prev;
    }
  }
  return out;
}

export function roc(closes: ArrayLike<number>, p: number): Series {
  const out = nanSeries(closes.length);
  for (let i = p; i < closes.length; i++) out[i] = ((closes[i]! - closes[i - p]!) / closes[i - p]!) * 100;
  return out;
}

/** Rolling VWAP over p bars using typical price. */
export function vwap(c: Candle[], p: number): Series {
  const out = nanSeries(c.length);
  let pv = 0;
  let v = 0;
  for (let i = 0; i < c.length; i++) {
    const tp = (c[i]!.high + c[i]!.low + c[i]!.close) / 3;
    pv += tp * c[i]!.volume;
    v += c[i]!.volume;
    if (i >= p) {
      const o = c[i - p]!;
      pv -= ((o.high + o.low + o.close) / 3) * o.volume;
      v -= o.volume;
    }
    if (i >= p - 1 && v > 0) out[i] = pv / v;
  }
  return out;
}

export function macd(closes: ArrayLike<number>, fast: number, slow: number, signal: number): { line: Series; signal: Series } {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = nanSeries(closes.length);
  for (let i = 0; i < closes.length; i++) line[i] = f[i]! - s[i]!;
  // Signal EMA over the defined part of the MACD line only
  const firstDefined = line.findIndex((x) => !Number.isNaN(x));
  const sig = nanSeries(closes.length);
  if (firstDefined >= 0) {
    const tail = ema(line.subarray(firstDefined), signal);
    sig.set(tail, firstDefined);
  }
  return { line, signal: sig };
}

export function bollinger(closes: ArrayLike<number>, p: number, k: number): { upper: Series; lower: Series; mid: Series } {
  const mid = sma(closes, p);
  const upper = nanSeries(closes.length);
  const lower = nanSeries(closes.length);
  for (let i = p - 1; i < closes.length; i++) {
    let v = 0;
    for (let j = i - p + 1; j <= i; j++) v += (closes[j]! - mid[i]!) ** 2;
    const sd = Math.sqrt(v / p);
    upper[i] = mid[i]! + k * sd;
    lower[i] = mid[i]! - k * sd;
  }
  return { upper, lower, mid };
}

/** Highest value of the PREVIOUS p bars (excludes the current bar, so "close crosses above highest(20)" is a real breakout). */
export function highest(xs: ArrayLike<number>, p: number): Series {
  const out = nanSeries(xs.length);
  for (let i = p; i < xs.length; i++) {
    let m = -Infinity;
    for (let j = i - p; j < i; j++) m = Math.max(m, xs[j]!);
    out[i] = m;
  }
  return out;
}

/** Lowest value of the PREVIOUS p bars (excludes the current bar). */
export function lowest(xs: ArrayLike<number>, p: number): Series {
  const out = nanSeries(xs.length);
  for (let i = p; i < xs.length; i++) {
    let m = Infinity;
    for (let j = i - p; j < i; j++) m = Math.min(m, xs[j]!);
    out[i] = m;
  }
  return out;
}
