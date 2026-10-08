/**
 * Data layer interface and a deterministic simulated implementation.
 *
 * Production implementations plug in behind `MarketData`:
 *   prices   -> Pyth (Solana) / Chainlink (EVM)
 *   candles  -> ClickHouse store fed by DEX trades, Ondo OHLC for stocks
 *   tokens   -> Yellowstone gRPC stream + Birdeye/Codex holder data
 * The simulated feed lets the whole stack run offline, and makes tests and
 * backtests reproducible.
 */
import type { Asset, Timeframe } from "../core/types.js";

export interface Candle {
  t: number; // open time, ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TokenRisk {
  mint: string;
  symbol: string;
  ageMinutes: number;
  /** Seconds since the create transaction; computed live from createdAtMs. */
  ageSeconds?: number;
  createdAtMs?: number;
  holders: number;
  /** Holders after collapsing disclosed creator wallets into one. */
  holdersCollapsed: number;
  topWalletPct: number;
  /** Share of supply held by the 10 largest holders (creator wallets included). */
  top10Pct?: number;
  /** Share held by the bonding curve / liquidity pools (not counted as holders). */
  poolPct?: number;
  /** Address of the largest real wallet, when known. */
  topWallet?: string;
  /** True when the single top-wallet share could not be measured. */
  topWalletUnknown?: boolean;
  mintRevoked: boolean;
  freezeRevoked: boolean;
  liquidityUsd: number;
  creatorWallets: string[];
  flags: string[];
}

/** Implemented by data/live.ts: real prices/candles, undefined when unavailable. */
export interface LiveOverlay {
  price(symbol: string): number | undefined;
  candles(symbol: string, kind: "crypto" | "stock", tf: Timeframe, count: number): Candle[] | undefined;
}

export interface NewTokenEvent {
  mint: string;
  symbol: string;
  at: number;
}

export interface MarketData {
  asset(symbol: string): Asset | undefined;
  priceUsd(symbol: string): number;
  candles(symbol: string, tf: Timeframe, count: number, endMs?: number): Candle[];
  tokenRisk(mintOrSymbol: string): TokenRisk | undefined;
  recentLaunches(limit: number): NewTokenEvent[];
}

export const TF_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

/** Mulberry32: small, fast, seedable PRNG. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hashStr = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

interface SimAsset extends Asset {
  basePrice: number;
  annualVol: number;
  drift: number;
}

const ASSETS: SimAsset[] = [
  { symbol: "USDC", chain: "solana", kind: "stable", decimals: 6, address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", basePrice: 1, annualVol: 0, drift: 0 },
  { symbol: "SOL", chain: "solana", kind: "native", decimals: 9, basePrice: 150, annualVol: 0.75, drift: 0.2 },
  { symbol: "ETH", chain: "base", kind: "native", decimals: 18, basePrice: 3200, annualVol: 0.6, drift: 0.15 },
  { symbol: "BTC", chain: "ethereum", kind: "token", decimals: 8, basePrice: 90000, annualVol: 0.5, drift: 0.2 },
  { symbol: "NVDAon", chain: "solana", kind: "tokenized_stock", decimals: 9, basePrice: 180, annualVol: 0.45, drift: 0.25 },
  { symbol: "SPYon", chain: "solana", kind: "tokenized_stock", decimals: 9, basePrice: 640, annualVol: 0.18, drift: 0.09 },
  { symbol: "TSLAx", chain: "solana", kind: "tokenized_stock", decimals: 8, basePrice: 420, annualVol: 0.6, drift: 0.1 },
  { symbol: "AAPLx", chain: "solana", kind: "tokenized_stock", decimals: 8, basePrice: 240, annualVol: 0.28, drift: 0.1 },
];

const ALIASES: Record<string, string> = {
  NVDA: "NVDAon", NVIDIA: "NVDAon", SPY: "SPYon", TSLA: "TSLAx", TESLA: "TSLAx", AAPL: "AAPLx", APPLE: "AAPLx",
  SOLANA: "SOL", ETHER: "ETH", ETHEREUM: "ETH", BITCOIN: "BTC", USD: "USDC",
};

/** Filled at runtime by the stock catalog: ticker / company name -> token symbol. */
const DYN_ALIASES = new Map<string, string>();

export function normalizeSymbol(s: string): string {
  const up = s.replace(/^\$/, "").trim();
  const key = up.toUpperCase();
  const dyn = DYN_ALIASES.get(key);
  if (dyn) return dyn;
  if (ALIASES[key]) return ALIASES[key]!;
  const hit = ASSETS.find((a) => a.symbol.toUpperCase() === key);
  return hit ? hit.symbol : up.toUpperCase();
}

/**
 * Simulated market. Prices follow a seeded geometric random walk anchored to
 * a fixed epoch, so the same (symbol, time) always yields the same candle.
 * Memecoins launched through Outcry are registered at runtime.
 */
export class SimulatedMarket implements MarketData {
  private memes = new Map<string, { risk: TokenRisk; price: number; live?: boolean; updatedAt?: number }>();
  /** Tokenized stocks resolved at runtime (xStocks / Ondo on Solana). */
  private stocks = new Map<string, { asset: Asset; ticker: string; name: string; issuer: string; price?: number; at?: number; ref?: number; refAt?: number }>();

  registerStock(s: { symbol: string; ticker: string; name: string; issuer: string; mint: string; decimals: number }, priceUsd?: number) {
    const prev = this.stocks.get(s.symbol);
    // "msfton" / "MSFTON" -> "MSFTon"
    DYN_ALIASES.set(s.symbol.toUpperCase(), s.symbol);
    this.stocks.set(s.symbol, {
      ...(prev ?? {}),
      asset: { symbol: s.symbol, chain: "solana", kind: "tokenized_stock", decimals: s.decimals, address: s.mint },
      ticker: s.ticker,
      name: s.name,
      issuer: s.issuer,
      ...(priceUsd ? { price: priceUsd, at: Date.now() } : {}),
    });
  }

  updateStockPrice(symbol: string, usd: number) {
    const e = this.stocks.get(symbol);
    if (e && usd > 0) Object.assign(e, { price: usd, at: Date.now() });
  }

  updateStockRef(symbol: string, usd: number) {
    const e = this.stocks.get(symbol);
    if (e && usd > 0) Object.assign(e, { ref: usd, refAt: Date.now() });
  }

  /** "MSFT", "microsoft" -> "MSFTx" (preferred token for the ticker). */
  setStockAlias(ticker: string, symbol: string, names: string[] = []) {
    DYN_ALIASES.set(ticker.toUpperCase(), symbol);
    DYN_ALIASES.set(ticker.toUpperCase().replace(".", ""), symbol);
    for (const n of names) DYN_ALIASES.set(n.toUpperCase(), symbol);
  }

  /** Tradable info for a tokenized stock: on-chain price, Nasdaq reference, gap, market status. */
  stockInfo(symbol: string) {
    const s = normalizeSymbol(symbol);
    const e = this.stocks.get(s);
    const staticRef = ASSETS.find((a) => a.symbol === s && a.kind === "tokenized_stock");
    if (!e && !staticRef) return undefined;
    const onchain = e?.price !== undefined && Date.now() - (e.at ?? 0) < 10 * 60_000 ? e.price : undefined;
    let ref = e?.ref;
    if (ref === undefined && this.live) ref = this.live.price(s);
    const gapPct = onchain !== undefined && ref ? ((onchain - ref) / ref) * 100 : undefined;
    return { symbol: s, ticker: e?.ticker ?? s.replace(/(x|on)$/, ""), name: e?.name ?? s, issuer: e?.issuer ?? (s.endsWith("on") ? "Ondo" : "xStocks"), onchainUsd: onchain, nasdaqUsd: ref, gapPct };
  }

  listStocks() {
    return [...this.stocks.values()].map((e) => ({ symbol: e.asset.symbol, ticker: e.ticker, name: e.name, issuer: e.issuer, priceUsd: e.price }));
  }

  /** When a live token's price last changed (undefined for simulated tokens). */
  priceUpdatedAt(symbolOrMint: string): number | undefined {
    const m = this.findMeme(normalizeSymbol(symbolOrMint), symbolOrMint);
    return m?.live ? m.updatedAt ?? 0 : undefined;
  }
  private live?: LiveOverlay;

  /** Real prices and candles on top of the simulation (see data/live.ts). */
  setLive(live: LiveOverlay | undefined) {
    this.live = live;
  }

  private findMeme(s: string, raw: string) {
    const direct = this.memes.get(raw);
    if (direct) return direct;
    for (const m of this.memes.values()) if (m.risk.symbol === s) return m;
    return undefined;
  }
  private launches: NewTokenEvent[] = [];
  private readonly epoch = Date.UTC(2024, 0, 1);

  constructor(private seed = 42) {
    // A few pre-existing pump.fun tokens so sniper agents have a universe.
    const r = rng(seed);
    const names = ["GRIT", "MOTH", "BLOC", "TAPE", "PIT", "HANDS", "YELL", "FLOOR"];
    names.forEach((sym, i) => {
      const holders = Math.floor(80 + r() * 900);
      const top = 4 + r() * 50;
      this.registerMeme({
        mint: `sim${sym.toLowerCase()}${"x".repeat(32 - sym.length)}pump`,
        symbol: sym,
        ageMinutes: Math.floor(3 + r() * 600),
        holders,
        holdersCollapsed: holders,
        topWalletPct: Number(top.toFixed(1)),
        top10Pct: Number(Math.min(100, top + 6 + r() * 30).toFixed(1)),
        mintRevoked: i % 5 !== 3,
        freezeRevoked: true,
        liquidityUsd: Math.floor(5_000 + r() * 90_000),
        creatorWallets: [],
        flags: [],
      }, 0.00001 + r() * 0.0004);
    });
  }

  asset(symbol: string): Asset | undefined {
    const s = normalizeSymbol(symbol);
    const a = ASSETS.find((x) => x.symbol === s);
    if (a) {
      const dyn = this.stocks.get(a.symbol);
      return { symbol: a.symbol, chain: a.chain, kind: a.kind, decimals: dyn?.asset.decimals ?? a.decimals, address: dyn?.asset.address ?? a.address };
    }
    const st = this.stocks.get(s);
    if (st) return { ...st.asset };
    const m = this.findMeme(s, symbol);
    if (m) return { symbol: m.risk.symbol, chain: "solana", kind: "token", decimals: 6, address: m.risk.mint };
    return undefined;
  }

  priceUsd(symbol: string, atMs = Date.now()): number {
    const s = normalizeSymbol(symbol);
    const meme = this.findMeme(s, symbol);
    if (meme?.live) return meme.price;
    if (meme) {
      // memes wobble around their launch price, deterministic per minute
      const r = rng(hashStr(s) ^ Math.floor(atMs / 60_000));
      return meme.price * (0.7 + r() * 0.9);
    }
    // Tokenized stocks: the on-chain price is what a trade pays (they trade 24/7).
    const st = this.stocks.get(s);
    if (st?.price !== undefined && Date.now() - (st.at ?? 0) < 10 * 60_000 && Date.now() - atMs < 120_000) return st.price;
    const a = ASSETS.find((x) => x.symbol === s);
    if (!a) {
      if (st?.price !== undefined) return st.price;
      throw new Error(`unknown asset ${symbol}`);
    }
    if (a.annualVol === 0) return a.basePrice;
    if (this.live && Date.now() - atMs < 120_000) {
      const p = this.live.price(s);
      if (p !== undefined) return p;
    }
    const c = this.candles(s, "1h", 1, atMs)[0]!;
    return c.close;
  }

  candles(symbol: string, tf: Timeframe, count: number, endMs = Date.now()): Candle[] {
    const s = normalizeSymbol(symbol);
    const a = ASSETS.find((x) => x.symbol === s);
    if (!a) {
      // Runtime-resolved stocks only have real candles (no simulation).
      if (this.stocks.has(s) && this.live) {
        const real = this.live.candles(s, "stock", tf, count);
        if (real) return real;
        throw new Error(`Price history for ${s} is still loading; try again in a few seconds`);
      }
      throw new Error(`no candles for ${symbol}`);
    }
    if (this.live && Date.now() - endMs < 120_000) {
      const real = this.live.candles(s, a.kind === "tokenized_stock" ? "stock" : "crypto", tf, count);
      if (real) return real;
    }
    const step = TF_MS[tf];
    const lastOpen = Math.floor(endMs / step) * step;
    const first = lastOpen - (count - 1) * step;
    // Walk from epoch in 1h steps for a stable path, then aggregate.
    const out: Candle[] = [];
    for (let t = first; t <= lastOpen; t += step) {
      out.push(this.candleAt(a, t, step));
    }
    return out;
  }

  private dayCache = new Map<string, number[]>();

  private candleAt(a: SimAsset, t: number, step: number): Candle {
    const open = Math.exp(this.cachedLogPrice(a, t));
    const close = Math.exp(this.cachedLogPrice(a, t + step));
    const r = rng(hashStr(a.symbol) ^ Math.floor(t / 1000));
    const spread = Math.abs(close - open) + open * (a.annualVol / Math.sqrt(365 * 24 * 3600_000 / step)) * (0.3 + r());
    return {
      t,
      open,
      close,
      high: Math.max(open, close) + spread * r() * 0.6,
      low: Math.min(open, close) - spread * r() * 0.6,
      volume: Math.round((1 + r() * 3) * 1_000_000 / a.basePrice),
    };
  }

  /** Daily anchor prices are cached; intraday uses one extra step. */
  private cachedLogPrice(a: SimAsset, t: number): number {
    const dayMs = 86_400_000;
    const days = Math.max(0, Math.floor((t - this.epoch) / dayMs));
    let arr = this.dayCache.get(a.symbol);
    const seed = hashStr(a.symbol) ^ this.seed;
    const sigmaD = a.annualVol / Math.sqrt(365);
    if (!arr) {
      arr = [Math.log(a.basePrice)];
      this.dayCache.set(a.symbol, arr);
    }
    if (arr.length <= days + 1) {
      while (arr.length <= days + 1) {
        const d = arr.length;
        const rr = rng(seed ^ (d * 2654435761));
        let lp = arr[d - 1]! + (a.drift / 365 - 0.5 * sigmaD * sigmaD) + sigmaD * gauss(rr);
        if (d % 97 === 0) lp += (rr() - 0.5) * sigmaD * 6;
        arr.push(lp);
      }
    }
    const intra = (t - this.epoch - days * dayMs) / dayMs;
    const lp0 = arr[days]!;
    const lp1 = arr[days + 1]!;
    const r2 = rng(seed ^ Math.floor(t / 3_600_000));
    const noise = sigmaD * 0.15 * (r2() - 0.5) * Math.sin(Math.PI * intra);
    return lp0 + (lp1 - lp0) * intra + noise;
  }

  tokenRisk(mintOrSymbol: string): TokenRisk | undefined {
    const s = normalizeSymbol(mintOrSymbol);
    const m = this.findMeme(s, mintOrSymbol);
    if (!m) return undefined;
    // Age is live: derived from the creation time on every read.
    const r = m.risk;
    const created = r.createdAtMs ?? Date.now() - r.ageMinutes * 60_000;
    const ageSeconds = Math.max(0, (Date.now() - created) / 1000);
    return { ...r, createdAtMs: created, ageSeconds, ageMinutes: ageSeconds / 60, top10Pct: r.top10Pct ?? Math.min(100, r.topWalletPct * 2.5) };
  }

  recentLaunches(limit: number): NewTokenEvent[] {
    return this.launches.slice(-limit).reverse();
  }

  /** Called by the launch module and by the simulated new-token stream. */
  registerMeme(risk: TokenRisk, priceUsd: number) {
    const createdAtMs = risk.createdAtMs ?? Date.now() - risk.ageMinutes * 60_000;
    this.memes.set(risk.mint, { risk: { ...risk, createdAtMs }, price: priceUsd });
    this.launches.push({ mint: risk.mint, symbol: risk.symbol, at: createdAtMs });
  }

  /** Live feed: register a real token (price is exact, no simulated wobble). */
  registerLiveMeme(risk: TokenRisk, priceUsd: number) {
    this.registerMeme(risk, priceUsd);
    this.memes.get(risk.mint)!.live = true;
  }

  updateMeme(mint: string, patch: Partial<TokenRisk>, priceUsd?: number) {
    const m = this.memes.get(mint);
    if (!m) return;
    Object.assign(m.risk, patch);
    if (priceUsd !== undefined && Number.isFinite(priceUsd) && priceUsd > 0) {
      m.price = priceUsd;
      m.updatedAt = Date.now();
    }
  }

  hasSymbol(symbol: string) {
    return ASSETS.some((a) => a.symbol.toUpperCase() === symbol.toUpperCase()) || !!ALIASES[symbol.toUpperCase()] || [...this.memes.values()].some((m) => m.risk.symbol === symbol);
  }

  /** Drop old live tokens nobody holds, so memory and snapshots stay small. */
  pruneMemes(maxAgeMs: number, keep: (mint: string) => boolean) {
    const now = Date.now();
    for (const [mint, m] of this.memes) {
      if (m.live && now - (m.risk.createdAtMs ?? now) > maxAgeMs && !keep(mint)) this.memes.delete(mint);
    }
    if (this.launches.length > 3_000) this.launches.splice(0, this.launches.length - 3_000);
  }

  /** Test/demo hook: emit a brand-new token. */
  spawnMeme(symbol: string, overrides: Partial<TokenRisk> = {}, priceUsd = 0.00002): TokenRisk {
    const risk: TokenRisk = {
      mint: `sim${symbol.toLowerCase()}${Date.now().toString(36)}pump`,
      symbol,
      ageMinutes: 0,
      holders: 250,
      holdersCollapsed: 250,
      topWalletPct: 8,
      top10Pct: 18,
      mintRevoked: true,
      freezeRevoked: true,
      liquidityUsd: 12_000,
      creatorWallets: [],
      flags: [],
      ...overrides,
    };
    this.registerMeme(risk, priceUsd);
    return risk;
  }
}

function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
