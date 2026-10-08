/**
 * Live pump.fun launches from PumpPortal's public data stream
 * (wss://pumpportal.fun/api/data, no key).
 *
 * Each new token is registered in the market with real data, and its trades
 * are followed to keep price, holders and holder concentration current:
 * - price: marketCapSol / 1B supply x SOL price
 * - holders / top wallet / top 10: from the traders' token balances
 * - creator wallet: the create transaction's signer
 * pump.fun revokes mint and freeze authority at launch.
 *
 * Token names and symbols are untrusted user input: they are sanitized here
 * and wrapped as untrusted data before the model sees them.
 */
import type { SimulatedMarket, TokenRisk } from "./market.js";

const SUPPLY = 1_000_000_000;

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

interface Tracked {
  /** Followed after a lookup: we never saw its full trade history, so holder stats come from the lookup, not the stream. */
  partial?: boolean;
  mint: string;
  creator: string;
  balances: Map<string, number>;
  createdAt: number;
}

export interface PumpFeedStatus {
  connected: boolean;
  tokensSeen: number;
  tracked: number;
  /** Trade events received: if this stays 0 while tokens arrive, trade subscriptions are not working. */
  tradesSeen: number;
  lastTradeAt: string | null;
  subscribeBatches: number;
  otherMessages: number;
  lastOtherMessage: string | null;
  lastEventAt: string | null;
  lastError: string | null;
}

/** Keep tickers readable and unique: letters/digits only, max 10 chars, suffix on collision. */
export function cleanSymbol(raw: unknown, mint: string, taken: (s: string) => boolean) {
  let s = String(raw ?? "").normalize("NFKD").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10);
  if (!s) s = "PUMP";
  if (taken(s)) s = `${s.slice(0, 8)}-${mint.slice(0, 4).toUpperCase()}`;
  return s;
}

export class PumpPortalFeed {
  private ws?: WsLike;
  private tracked = new Map<string, Tracked>();
  private seen = 0;
  private lastEventAt?: number;
  private trades = 0;
  private lastTradeAt?: number;
  private otherMessages = 0;
  private lastOther?: string;
  private subscribeBatches = 0;
  private queued: string[] = [];
  private flushTimer?: ReturnType<typeof setInterval>;
  private lastError?: string;
  private stopped = false;
  private retryMs = 2_000;
  private pruneTimer?: ReturnType<typeof setInterval>;

  constructor(
    private market: SimulatedMarket,
    private opts: {
      url?: string;
      /** Tokens someone holds are followed (and kept) beyond the normal window. */
      isHeld?: (mint: string) => boolean;
      followMinutes?: number;
      batchMs?: number;
      maxTracked?: number;
      makeSocket?: (url: string) => WsLike;
    } = {},
  ) {}

  start() {
    this.connect();
    this.pruneTimer = setInterval(() => this.prune(), 60_000);
    this.pruneTimer.unref?.();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.ws?.close();
  }

  status(): PumpFeedStatus {
    return {
      connected: this.ws?.readyState === 1,
      tokensSeen: this.seen,
      tracked: this.tracked.size,
      tradesSeen: this.trades,
      lastTradeAt: this.lastTradeAt ? new Date(this.lastTradeAt).toISOString() : null,
      subscribeBatches: this.subscribeBatches,
      otherMessages: this.otherMessages,
      lastOtherMessage: this.lastOther ?? null,
      lastEventAt: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
      lastError: this.lastError ?? null,
    };
  }

  private connect() {
    const url = this.opts.url ?? "wss://pumpportal.fun/api/data";
    const make = this.opts.makeSocket ?? ((u: string) => new (globalThis as unknown as { WebSocket: new (u: string) => WsLike }).WebSocket(u));
    let ws: WsLike;
    try {
      ws = make(url);
    } catch (e) {
      this.lastError = (e as Error).message;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 2_000;
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      const keys = [...this.tracked.keys()];
      if (keys.length) ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys }));
    };
    ws.onmessage = (ev) => {
      try {
        this.handle(JSON.parse(String(ev.data)));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onerror = () => {
      this.lastError = "websocket error";
    };
    ws.onclose = () => {
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 60_000);
    setTimeout(() => this.connect(), wait).unref?.();
  }

  private solUsd() {
    try {
      return this.market.priceUsd("SOL");
    } catch {
      return 150;
    }
  }

  /** Exposed for tests. */
  handle(msg: Record<string, unknown>) {
    const mint = typeof msg.mint === "string" ? msg.mint : undefined;
    const tx = String(msg.txType ?? "").toLowerCase();
    if (!mint || (tx !== "create" && tx !== "buy" && tx !== "sell")) {
      // Server notices (subscription acks, errors, limits): keep the last one for /api/health.
      this.otherMessages++;
      this.lastOther = JSON.stringify(msg).slice(0, 300);
      return;
    }
    this.lastEventAt = Date.now();
    if (tx === "create") this.onCreate(mint, msg);
    else {
      this.trades++;
      this.lastTradeAt = Date.now();
      this.onTrade(mint, { ...msg, txType: tx });
    }
  }

  private priceOf(msg: Record<string, unknown>) {
    const mcSol = Number(msg.marketCapSol);
    return mcSol > 0 ? (mcSol / SUPPLY) * this.solUsd() : undefined;
  }

  private liquidityOf(msg: Record<string, unknown>) {
    const vSol = Number(msg.vSolInBondingCurve);
    return vSol > 0 ? Math.round(vSol * this.solUsd() * 2) : 0;
  }

  private onCreate(mint: string, msg: Record<string, unknown>) {
    if (this.tracked.has(mint)) return;
    this.seen++;
    const creator = String(msg.traderPublicKey ?? "");
    const t: Tracked = { mint, creator, balances: new Map(), createdAt: Date.now() };
    const initial = Number(msg.initialBuy);
    if (creator && initial > 0) t.balances.set(creator, initial);
    this.tracked.set(mint, t);
    const symbol = cleanSymbol(msg.symbol, mint, (s) => this.market.hasSymbol(s));
    const risk: TokenRisk = {
      mint,
      symbol,
      ageMinutes: 0,
      createdAtMs: Date.now(),
      ...this.holderStats(t),
      mintRevoked: true,
      freezeRevoked: true,
      liquidityUsd: this.liquidityOf(msg),
      creatorWallets: creator ? [creator] : [],
      flags: ["pump.fun", "live"],
    };
    this.market.registerLiveMeme(risk, this.priceOf(msg) ?? 0.000004);
    this.followMore([mint]);
    if (this.tracked.size > (this.opts.maxTracked ?? 400)) this.prune(true);
  }

  private onTrade(mint: string, msg: Record<string, unknown>) {
    const t = this.tracked.get(mint);
    if (!t) return;
    const who = String(msg.traderPublicKey ?? "");
    if (who) {
      const bal = Number(msg.newTokenBalance);
      if (Number.isFinite(bal) && msg.newTokenBalance !== undefined) {
        if (bal > 0) t.balances.set(who, bal);
        else t.balances.delete(who);
      } else {
        const amt = Number(msg.tokenAmount) || 0;
        const next = (t.balances.get(who) ?? 0) + (msg.txType === "buy" ? amt : -amt);
        if (next > 1e-6) t.balances.set(who, next);
        else t.balances.delete(who);
      }
    }
    this.market.updateMeme(mint, { ...(t.partial ? {} : this.holderStats(t)), liquidityUsd: this.liquidityOf(msg) }, this.priceOf(msg));
  }

  private holderStats(t: Tracked) {
    const vals = [...t.balances.values()].sort((a, b) => b - a);
    const pct = (n: number) => Number(((n / SUPPLY) * 100).toFixed(2));
    return {
      holders: vals.length,
      // One disclosed creator wallet: collapsing changes nothing for pump.fun creators.
      holdersCollapsed: vals.length,
      topWalletPct: pct(vals[0] ?? 0),
      top10Pct: pct(vals.slice(0, 10).reduce((a, b) => a + b, 0)),
    };
  }

  /** Follow an existing token's trades (e.g. one the user looked up). */
  follow(mint: string) {
    if (this.tracked.has(mint)) return;
    this.tracked.set(mint, { mint, creator: "", balances: new Map(), createdAt: Date.now(), partial: true });
    this.followMore([mint]);
  }

  /** Subscriptions are batched (one message every 2s) instead of one message per launch. */
  private followMore(keys: string[]) {
    this.queued.push(...keys);
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushSubscriptions(), this.opts.batchMs ?? 2_000);
      this.flushTimer.unref?.();
    }
  }

  flushSubscriptions() {
    if (!this.queued.length || this.ws?.readyState !== 1) return;
    const keys = [...new Set(this.queued.splice(0))].filter((k) => this.tracked.has(k));
    if (!keys.length) return;
    this.subscribeBatches++;
    this.ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys }));
  }

  /** Stop following old tokens nobody holds; drop them from the market later. */
  private prune(force = false) {
    const window = (this.opts.followMinutes ?? 30) * 60_000;
    const drop: string[] = [];
    const byAge = [...this.tracked.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const t of byAge) {
      const held = this.opts.isHeld?.(t.mint) ?? false;
      const old = Date.now() - t.createdAt > window;
      const over = force && this.tracked.size - drop.length > (this.opts.maxTracked ?? 400);
      if (!held && (old || over)) drop.push(t.mint);
    }
    if (drop.length) {
      for (const m of drop) this.tracked.delete(m);
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: drop }));
    }
    this.market.pruneMemes(6 * 3_600_000, (m) => this.opts.isHeld?.(m) ?? false);
  }
}
