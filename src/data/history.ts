/**
 * Real historical candles for backtests.
 *
 * - Crypto: Binance public market-data mirror (no key, no geo-block).
 * - Stocks (and crypto as a fallback): Twelve Data, with TWELVEDATA_API_KEY.
 *
 * If nothing real is available, callers fall back to the simulated market and
 * must label the result as simulated.
 */
import type { Candle } from "./market.js";
import type { Timeframe } from "../core/types.js";

export interface HistoryResult {
  candles: Candle[];
  source: string;
  real: boolean;
}

export interface HistoryProvider {
  fetch(symbol: string, kind: "crypto" | "stock", tf: Timeframe, bars: number): Promise<HistoryResult | undefined>;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const BINANCE_TF: Record<Timeframe, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
const TWELVE_TF: Record<Timeframe, string> = { "1m": "1min", "5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day" };

/** Map terminal tickers to venue symbols (tokenized stocks track the listed share). */
function stockSymbol(s: string) {
  return s.replace(/x$/i, "").replace(/\.ONDO$/i, "").toUpperCase();
}

export class RealHistory implements HistoryProvider {
  private cache = new Map<string, { at: number; res: HistoryResult }>();
  constructor(
    private opts: { twelveDataKey?: string; fetch?: FetchLike; ttlMs?: number } = {},
  ) {}

  private get f(): FetchLike {
    return this.opts.fetch ?? ((u) => fetch(u, { signal: AbortSignal.timeout(10_000) }) as never);
  }

  async fetch(symbol: string, kind: "crypto" | "stock", tf: Timeframe, bars: number): Promise<HistoryResult | undefined> {
    const key = `${kind}:${symbol}:${tf}:${bars}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < (this.opts.ttlMs ?? 10 * 60_000)) return hit.res;
    let res: HistoryResult | undefined;
    try {
      if (kind === "crypto") res = (await this.binance(symbol, tf, bars)) ?? (await this.twelve(`${symbol}/USD`, tf, bars));
      else res = await this.twelve(stockSymbol(symbol), tf, bars);
    } catch {
      res = undefined;
    }
    if (res && res.candles.length >= 100) {
      this.cache.set(key, { at: Date.now(), res });
      return res;
    }
    return undefined;
  }

  private async binance(symbol: string, tf: Timeframe, bars: number): Promise<HistoryResult | undefined> {
    const pair = `${symbol.toUpperCase()}USDT`;
    const out: Candle[] = [];
    let end: number | undefined;
    while (out.length < bars) {
      const limit = Math.min(1000, bars - out.length);
      const url = `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=${BINANCE_TF[tf]}&limit=${limit}${end ? `&endTime=${end}` : ""}`;
      const r = await this.f(url);
      if (!r.ok) return out.length ? done() : undefined;
      const rows = (await r.json()) as [number, string, string, string, string, string][];
      if (!Array.isArray(rows) || !rows.length) break;
      out.unshift(...rows.map((k) => ({ t: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })));
      end = rows[0]![0] - 1;
      if (rows.length < limit) break;
    }
    return done();
    function done(): HistoryResult {
      return { candles: out, source: `Binance ${pair} ${tf}`, real: true };
    }
  }

  private async twelve(symbol: string, tf: Timeframe, bars: number): Promise<HistoryResult | undefined> {
    const k = this.opts.twelveDataKey;
    if (!k) return undefined;
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${TWELVE_TF[tf]}&outputsize=${Math.min(5000, bars)}&order=ASC&timezone=UTC&apikey=${encodeURIComponent(k)}`;
    const r = await this.f(url);
    if (!r.ok) return undefined;
    const j = (await r.json()) as { status?: string; values?: { datetime: string; open: string; high: string; low: string; close: string; volume?: string }[] };
    if (j.status !== "ok" || !j.values?.length) return undefined;
    const candles = j.values.map((v) => ({
      t: Date.parse(v.datetime.length <= 10 ? `${v.datetime}T00:00:00Z` : `${v.datetime.replace(" ", "T")}Z`),
      open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: +(v.volume ?? 0),
    }));
    return { candles, source: `Twelve Data ${symbol} ${tf}`, real: true };
  }
}
