/**
 * Real market data for paper mode ("paper money, real market").
 *
 * - Crypto prices: Binance public market data (SOL, ETH, BTC), Jupiter price
 *   API as a fallback for SOL. No keys.
 * - Stock prices: Twelve Data (TWELVEDATA_API_KEY), polled slowly to stay in
 *   the free tier.
 * - Candles: real history from RealHistory, cached and refreshed in the
 *   background; the simulation is used until the first fetch lands.
 */
import type { Timeframe } from "../core/types.js";
import type { HistoryProvider } from "./history.js";
import type { Candle, LiveOverlay } from "./market.js";

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const CRYPTO: Record<string, string> = { SOL: "SOLUSDT", ETH: "ETHUSDT", BTC: "BTCUSDT" };
const STOCKS: Record<string, string> = { AAPLx: "AAPL", TSLAx: "TSLA", NVDAon: "NVDA", SPYon: "SPY" };
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TTL: Record<Timeframe, number> = { "1m": 60_000, "5m": 120_000, "15m": 300_000, "1h": 300_000, "4h": 900_000, "1d": 1_800_000 };

export interface LiveStatus {
  prices: Record<string, { usd: number; at: string; source: string }>;
  lastError?: string;
  candleSets: number;
}

export class LiveFeeds implements LiveOverlay {
  private px = new Map<string, { usd: number; at: number; source: string }>();
  private bars = new Map<string, { at: number; candles: Candle[] }>();
  private inflight = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];
  lastError?: string;

  constructor(
    private opts: { history?: HistoryProvider; twelveDataKey?: string; fetch?: FetchLike; cryptoEveryMs?: number; stockEveryMs?: number } = {},
  ) {}

  private get f(): FetchLike {
    return this.opts.fetch ?? ((u) => fetch(u, { signal: AbortSignal.timeout(8_000) }) as never);
  }

  start() {
    void this.pollCrypto();
    void this.pollStocks();
    this.timers.push(setInterval(() => void this.pollCrypto(), this.opts.cryptoEveryMs ?? 20_000));
    this.timers.push(setInterval(() => void this.pollStocks(), this.opts.stockEveryMs ?? 15 * 60_000));
    // Warm the candles agents and charts use most.
    for (const s of Object.keys(CRYPTO)) for (const tf of ["1h", "4h", "1d"] as Timeframe[]) void this.refreshCandles(s, "crypto", tf, 500);
    for (const t of this.timers) t.unref?.();
    return this;
  }

  stop() {
    this.timers.forEach(clearInterval);
  }

  // --- LiveOverlay --------------------------------------------------------

  price(symbol: string): number | undefined {
    const p = this.px.get(symbol);
    // Stocks keep their last price when the market is closed; crypto must be fresh.
    const maxAge = symbol in STOCKS ? 24 * 3_600_000 : 120_000;
    return p && Date.now() - p.at < maxAge ? p.usd : undefined;
  }

  candles(symbol: string, kind: "crypto" | "stock", tf: Timeframe, count: number): Candle[] | undefined {
    if (!(symbol in CRYPTO) && !(symbol in STOCKS)) return undefined;
    const key = `${symbol}:${tf}`;
    const hit = this.bars.get(key);
    const stale = !hit || Date.now() - hit.at > TTL[tf];
    const short = hit && hit.candles.length < count;
    if (stale || short) void this.refreshCandles(symbol, kind, tf, Math.max(count, 500));
    if (!hit || hit.candles.length < Math.min(count, 100)) return undefined;
    const out = hit.candles.slice(-count);
    // Keep the last close in line with the live price.
    const live = this.price(symbol);
    if (live && out.length) {
      const last = { ...out[out.length - 1]! };
      last.close = live;
      last.high = Math.max(last.high, live);
      last.low = Math.min(last.low, live);
      out[out.length - 1] = last;
    }
    return out;
  }

  status(): LiveStatus {
    const prices: LiveStatus["prices"] = {};
    for (const [k, v] of this.px) prices[k] = { usd: v.usd, at: new Date(v.at).toISOString(), source: v.source };
    return { prices, lastError: this.lastError, candleSets: this.bars.size };
  }

  // --- polling -----------------------------------------------------------

  async pollCrypto() {
    try {
      const symbols = encodeURIComponent(JSON.stringify(Object.values(CRYPTO)));
      const r = await this.f(`https://data-api.binance.vision/api/v3/ticker/price?symbols=${symbols}`);
      if (!r.ok) {
        // Rate limited (shared cloud IPs): Jupiter covers SOL meanwhile.
        throw new Error(`Binance ${r.status}`);
      }
      const rows = (await r.json()) as { symbol: string; price: string }[];
      for (const [sym, pair] of Object.entries(CRYPTO)) {
        const row = rows.find((x) => x.symbol === pair);
        if (row && Number(row.price) > 0) this.px.set(sym, { usd: Number(row.price), at: Date.now(), source: "Binance" });
      }
    } catch (e) {
      this.lastError = `crypto prices: ${(e as Error).message}`;
      await this.pollJupiterSol();
    }
  }

  private async pollJupiterSol() {
    try {
      const r = await this.f(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
      if (!r.ok) return;
      const j = (await r.json()) as Record<string, { usdPrice?: number }>;
      const p = j[SOL_MINT]?.usdPrice;
      if (p && p > 0) this.px.set("SOL", { usd: p, at: Date.now(), source: "Jupiter" });
    } catch {
      /* both down: simulated prices are used */
    }
  }

  async pollStocks() {
    const key = this.opts.twelveDataKey;
    if (!key) return;
    try {
      const list = Object.values(STOCKS).join(",");
      const r = await this.f(`https://api.twelvedata.com/price?symbol=${list}&apikey=${encodeURIComponent(key)}`);
      if (!r.ok) throw new Error(`Twelve Data ${r.status}`);
      const j = (await r.json()) as Record<string, { price?: string }>;
      for (const [sym, ticker] of Object.entries(STOCKS)) {
        const p = Number(j[ticker]?.price);
        if (p > 0) this.px.set(sym, { usd: p, at: Date.now(), source: "Twelve Data" });
      }
    } catch (e) {
      this.lastError = `stock prices: ${(e as Error).message}`;
    }
  }

  async refreshCandles(symbol: string, kind: "crypto" | "stock", tf: Timeframe, count: number) {
    const key = `${symbol}:${tf}`;
    if (!this.opts.history || this.inflight.has(key)) return;
    this.inflight.add(key);
    try {
      const r = await this.opts.history.fetch(kind === "crypto" ? symbol : STOCKS[symbol] ?? symbol, kind, tf, Math.min(count, 1_000));
      if (r?.candles.length) this.bars.set(key, { at: Date.now(), candles: r.candles });
    } catch (e) {
      this.lastError = `candles ${key}: ${(e as Error).message}`;
    } finally {
      this.inflight.delete(key);
    }
  }
}
