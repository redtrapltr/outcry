/**
 * Tokenized US stocks on Solana: xStocks (Backed, symbol suffix "x") and Ondo
 * Global Markets (suffix "on"). Both trade 24/7 on Solana (Raydium, routed by
 * Jupiter), so the price that matters for a trade is the on-chain price.
 *
 * - Catalog: each ticker is resolved to its real mint through Jupiter's token
 *   API (verified tokens only, never a look-alike), in the background and on
 *   demand when a user names a stock.
 * - Prices: on-chain from Jupiter's price API (batched), with the last Nasdaq
 *   price from Twelve Data as a reference, and the US market status.
 */
import type { SimulatedMarket } from "./market.js";

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface StockSeed {
  ticker: string;
  name: string;
  /** Extra words users type for it ("apple", "google"). */
  aliases?: string[];
}

/** Most traded US stocks and ETFs; anything else resolves on demand. */
export const STOCK_SEED: StockSeed[] = [
  ["AAPL", "Apple"], ["MSFT", "Microsoft"], ["NVDA", "NVIDIA", ["nvidia"]], ["AMZN", "Amazon"], ["GOOGL", "Alphabet", ["google"]],
  ["META", "Meta", ["facebook"]], ["TSLA", "Tesla"], ["AVGO", "Broadcom"], ["BRK.B", "Berkshire Hathaway", ["berkshire"]], ["JPM", "JPMorgan"],
  ["V", "Visa"], ["MA", "Mastercard"], ["NFLX", "Netflix"], ["AMD", "AMD"], ["INTC", "Intel"], ["ORCL", "Oracle"], ["CRM", "Salesforce"],
  ["ADBE", "Adobe"], ["COIN", "Coinbase"], ["MSTR", "MicroStrategy", ["strategy inc", "microstrategy"]], ["HOOD", "Robinhood"], ["PLTR", "Palantir"],
  ["UBER", "Uber"], ["ABNB", "Airbnb"], ["SHOP", "Shopify"], ["PYPL", "PayPal"], ["DIS", "Disney"], ["NKE", "Nike"], ["KO", "Coca-Cola", ["coca cola", "coke"]],
  ["PEP", "PepsiCo", ["pepsi"]], ["MCD", "McDonald's", ["mcdonalds"]], ["WMT", "Walmart"], ["COST", "Costco"], ["HD", "Home Depot"], ["PG", "Procter & Gamble"],
  ["JNJ", "Johnson & Johnson"], ["PFE", "Pfizer"], ["MRK", "Merck"], ["LLY", "Eli Lilly", ["lilly"]], ["UNH", "UnitedHealth"], ["XOM", "Exxon Mobil", ["exxon"]],
  ["CVX", "Chevron"], ["BA", "Boeing"], ["GE", "General Electric"], ["IBM", "IBM"], ["QCOM", "Qualcomm"], ["MU", "Micron"], ["ARM", "Arm Holdings"],
  ["SMCI", "Super Micro", ["supermicro"]], ["DELL", "Dell"], ["CSCO", "Cisco"], ["TSM", "TSMC", ["taiwan semiconductor"]], ["ASML", "ASML"],
  ["CRCL", "Circle"], ["GME", "GameStop"], ["RDDT", "Reddit"], ["SPY", "S&P 500 ETF", ["s&p 500", "s&p", "sp500"]], ["QQQ", "Nasdaq 100 ETF", ["nasdaq 100", "nasdaq"]],
  ["IWM", "Russell 2000 ETF", ["russell 2000"]], ["DIA", "Dow Jones ETF", ["dow jones"]], ["GLD", "Gold ETF", ["gold etf"]], ["SLV", "Silver ETF", ["silver etf"]],
  ["TLT", "20+ Year Treasury ETF", ["treasuries", "bonds etf"]], ["VTI", "Total Stock Market ETF"], ["VOO", "Vanguard S&P 500 ETF"],
].map(([ticker, name, aliases]) => ({ ticker: ticker as string, name: name as string, aliases: aliases as string[] | undefined }));

interface JupToken {
  id: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  usdPrice?: number;
  liquidity?: number;
  isVerified?: boolean;
  tags?: string[];
}

export interface StockEntry {
  ticker: string;
  name: string;
  symbol: string; // AAPLx / AAPLon
  issuer: "xStocks" | "Ondo";
  mint: string;
  decimals: number;
  onchainUsd?: number;
  onchainAt?: number;
  nasdaqUsd?: number;
  nasdaqAt?: number;
}

// ---------------------------------------------------------------------------
// US market hours (NYSE regular session, 9:30-16:00 New York time)
// ---------------------------------------------------------------------------

const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

export function usMarketStatus(at = new Date()): { open: boolean; label: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return { open: false, label: "US market closed (weekend)" };
  if (HOLIDAYS.has(date)) return { open: false, label: "US market closed (holiday)" };
  if (mins >= 570 && mins < 960) return { open: true, label: "US market open" };
  if (mins >= 240 && mins < 570) return { open: false, label: "US pre-market" };
  if (mins >= 960 && mins < 1200) return { open: false, label: "US after-hours" };
  return { open: false, label: "US market closed (overnight)" };
}

// ---------------------------------------------------------------------------

export class StockCatalog {
  readonly entries = new Map<string, StockEntry>(); // by symbol (AAPLx)
  private byTicker = new Map<string, StockEntry>(); // preferred token per ticker
  private misses = new Map<string, number>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private seedIndex = 0;
  private pauseUntil = 0;
  private refQueue: string[] = [];
  lastError?: string;

  constructor(
    private market: SimulatedMarket,
    private opts: { fetch?: FetchLike; twelveDataKey?: string; priceEveryMs?: number } = {},
  ) {}

  private get f(): FetchLike {
    return this.opts.fetch ?? ((u) => fetch(u, { signal: AbortSignal.timeout(8_000) }) as never);
  }

  start() {
    // Resolve the seed list gently (one ticker every 4s) so Jupiter's free tier is never hammered.
    this.timers.push(setInterval(() => void this.resolveNextSeed(), 4_000));
    this.timers.push(setInterval(() => void this.pollPrices(), this.opts.priceEveryMs ?? 30_000));
    this.timers.push(setInterval(() => void this.pollNasdaqRef(), 20_000));
    for (const t of this.timers) t.unref?.();
    return this;
  }

  stop() {
    this.timers.forEach(clearInterval);
  }

  status() {
    return { resolved: this.byTicker.size, seed: STOCK_SEED.length, tokens: this.entries.size, lastError: this.lastError ?? null, market: usMarketStatus().label };
  }

  private async resolveNextSeed() {
    if (this.seedIndex >= STOCK_SEED.length) return;
    if (Date.now() < this.pauseUntil) return;
    const s = STOCK_SEED[this.seedIndex++]!;
    try {
      await this.resolve(s.ticker);
    } catch (e) {
      // Rate limited: step back and retry this ticker after a pause.
      this.seedIndex--;
      this.pauseUntil = Date.now() + 60_000;
      this.lastError = (e as Error).message;
    }
  }

  /** Find the stock tickers or company names mentioned in a text and make sure they're tradable. */
  async ensureFrom(text: string): Promise<string[]> {
    const found: string[] = [];
    const upper = ` ${text.toUpperCase().replace(/[^A-Z0-9.&$]/g, " ")} `;
    const lower = ` ${text.toLowerCase()} `;
    for (const s of STOCK_SEED) {
      const tickerHit = s.ticker.length >= 2 && (upper.includes(` ${s.ticker} `) || upper.includes(` $${s.ticker} `) || upper.includes(` ${s.ticker}X `) || upper.includes(` ${s.ticker}ON `));
      const nameHit = [s.name, ...(s.aliases ?? [])].some((n) => n.length >= 4 && lower.includes(n.toLowerCase()));
      if ((tickerHit || nameHit) && !this.byTicker.has(s.ticker)) found.push(s.ticker);
    }
    // Unlisted tickers written like "$RKLB" or "RKLBx": try them too.
    for (const m of text.matchAll(/\$([A-Z]{1,5})\b|\b([A-Z]{1,5})(x|on)\b/g)) {
      const t = m[1] ?? m[2];
      if (t && !this.byTicker.has(t) && !found.includes(t)) found.push(t);
    }
    for (const t of found.slice(0, 3)) await this.resolve(t).catch(() => undefined);
    return found;
  }

  /** Resolve a ticker to its verified xStocks / Ondo token(s) on Solana. */
  async resolve(ticker: string): Promise<StockEntry | undefined> {
    const T = ticker.toUpperCase();
    const known = this.byTicker.get(T);
    if (known) return known;
    if (Date.now() - (this.misses.get(T) ?? 0) < 30 * 60_000) return undefined;
    const seed = STOCK_SEED.find((s) => s.ticker === T);
    const candidates: StockEntry[] = [];
    for (const [suffix, issuer] of [["x", "xStocks"], ["on", "Ondo"]] as const) {
      const symbol = `${T.replace(".", "")}${suffix}`;
      const r = await this.f(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(symbol)}`);
      if (r.status === 429) throw new Error("Jupiter rate limit");
      if (!r.ok) continue;
      const rows = (await r.json()) as JupToken[];
      // Verified tokens with the exact symbol only: look-alikes are common.
      const ok = (Array.isArray(rows) ? rows : []).filter((x) => x.symbol?.toLowerCase() === symbol.toLowerCase() && (x.isVerified || x.tags?.includes("verified")));
      const best = ok.sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0))[0];
      if (best) {
        candidates.push({ ticker: T, name: seed?.name ?? best.name ?? T, symbol: best.symbol!, issuer, mint: best.id, decimals: best.decimals ?? 8, onchainUsd: best.usdPrice, onchainAt: best.usdPrice ? Date.now() : undefined });
      }
    }
    if (!candidates.length) {
      this.misses.set(T, Date.now());
      return undefined;
    }
    for (const c of candidates) {
      this.entries.set(c.symbol, c);
      this.market.registerStock({ symbol: c.symbol, ticker: c.ticker, name: c.name, issuer: c.issuer, mint: c.mint, decimals: c.decimals }, c.onchainUsd);
    }
    // Prefer xStocks when both exist (deepest Solana liquidity), else Ondo.
    const preferred = candidates.find((c) => c.issuer === "xStocks") ?? candidates[0]!;
    this.byTicker.set(T, preferred);
    this.market.setStockAlias(T, preferred.symbol, [seed?.name, ...(seed?.aliases ?? [])].filter(Boolean) as string[]);
    this.refQueue.push(T);
    return preferred;
  }

  /** On-chain prices for every resolved stock token (Jupiter price API, 50 per call). */
  async pollPrices() {
    const list = [...this.entries.values()];
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50);
      try {
        const r = await this.f(`https://lite-api.jup.ag/price/v3?ids=${chunk.map((e) => e.mint).join(",")}`);
        if (!r.ok) throw new Error(`Jupiter price ${r.status}`);
        const j = (await r.json()) as Record<string, { usdPrice?: number }>;
        for (const e of chunk) {
          const p = j[e.mint]?.usdPrice;
          if (p && p > 0) {
            e.onchainUsd = p;
            e.onchainAt = Date.now();
            this.market.updateStockPrice(e.symbol, p);
          }
        }
        this.lastError = undefined;
      } catch (err) {
        this.lastError = (err as Error).message;
      }
    }
  }

  /** Last Nasdaq price as a reference (Twelve Data free tier: one ticker per call, spaced out). */
  async pollNasdaqRef() {
    const key = this.opts.twelveDataKey;
    if (!key) return;
    // Refresh the queue: tickers never fetched first, then the stalest.
    if (!this.refQueue.length) {
      // Every 4 hours per ticker keeps ~70 tickers inside Twelve Data's free 800 calls/day.
      const stale = [...this.byTicker.values()].filter((e) => !e.nasdaqAt || Date.now() - e.nasdaqAt > 4 * 3_600_000).map((e) => e.ticker);
      this.refQueue.push(...stale.slice(0, 20));
    }
    const t = this.refQueue.shift();
    if (!t) return;
    try {
      const r = await this.f(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(t)}&apikey=${encodeURIComponent(key)}`);
      const j = (await r.json()) as { price?: string };
      const p = Number(j.price);
      if (p > 0) for (const e of this.entries.values()) if (e.ticker === t) { e.nasdaqUsd = p; e.nasdaqAt = Date.now(); this.market.updateStockRef(e.symbol, p); }
    } catch {
      /* reference only */
    }
  }
}
