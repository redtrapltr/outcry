/**
 * Live trading pilot: real SOL, real swaps, real Turnkey wallets.
 *
 * Guard rails, all enforced here before anything is signed:
 *  - OUTCRY_LIVE_TRADING=1 and the user's @handle on OUTCRY_LIVE_ALLOWLIST
 *  - the account is secured with a passkey, and every swap is approved with it
 *    (checked by the API layer against this quote's id)
 *  - per-buy cap and daily buy cap in USD; sells are never capped (they reduce risk)
 *  - a quote expires after 40 seconds; each quote can be executed once
 *  - a SOL reserve is kept for network fees and token-account rent
 */
import { newId, nowIso, type AuditLog } from "../core/infra.js";
import type { UserStore } from "../core/users.js";
import type { TurnkeyWallets } from "../wallet/turnkey.js";
import { SOL_MINT, USDC_MINT, type JupiterSwap, type SolanaRpc } from "./chain.js";

export interface PilotConfig {
  enabled: boolean;
  allowlist: string[];
  maxOrderUsd: number;
  maxDailyUsd: number;
  /** SOL kept back for fees and rent. */
  reserveSol: number;
}

export interface TokenInfo {
  symbol: string;
  name?: string;
  usdPrice?: number;
  decimals?: number;
}

export interface PilotDeps {
  users: UserStore;
  wallets: TurnkeyWallets;
  jupiter: JupiterSwap;
  rpc: SolanaRpc;
  audit: AuditLog;
  solUsd: () => number;
  /** Mint address for a symbol the market knows (tokenized stocks, tracked memes). */
  resolveMint?: (symbol: string) => string | undefined;
  /** Symbol and USD price for mints (Jupiter token search). */
  tokenInfo: (mints: string[]) => Promise<Record<string, TokenInfo>>;
}

export interface LiveQuote {
  id: string;
  userId: string;
  side: "buy" | "sell";
  mint: string;
  symbol: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  /** Human amounts. */
  payAmount: number;
  payAsset: string;
  receiveAmount: number;
  receiveAsset: string;
  usd: number;
  feeBps?: number;
  /** Outcry's fee on this swap (Jupiter referral), 0 when not collected. */
  outcryFeeBps: number;
  /** What the trade settles against. */
  base: "SOL" | "USDC";
  router?: string;
  requestId: string;
  transaction: string;
  expiresAt: number;
  used?: boolean;
}

export interface LiveTrade {
  id: string;
  userId: string;
  at: string;
  side: "buy" | "sell";
  mint: string;
  symbol: string;
  usd: number;
  paid: string;
  received: string;
  status: "confirmed" | "failed";
  signature?: string;
  error?: string;
  /** What the trade really cost, read back from the chain. */
  costs?: {
    networkFeeUsd: number;
    /** One-time deposit for a new token account (refundable when the account is closed). */
    rentUsd: number;
    /** Market value received minus market value paid, before network fee and rent: Jupiter's fee and slippage. */
    swapEdgeUsd: number;
    outcryFeeUsd: number;
    totalCostUsd: number;
  };
}

const QUOTE_TTL_MS = 40_000;
const short = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;
const isMint = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

export class LivePilot {
  readonly trades = new Map<string, LiveTrade[]>();
  private quotes = new Map<string, LiveQuote>();
  private busy = new Set<string>();

  constructor(private cfg: PilotConfig, private d: PilotDeps) {}

  get jupiter() {
    return this.d.jupiter;
  }

  /** The Turnkey wallet store (persisted alongside the trades). */
  get wallets() {
    return this.d.wallets;
  }

  /** Why this user can't trade live, or undefined when they can. */
  blockedReason(userId: string, hasPasskey: boolean): string | undefined {
    if (!this.cfg.enabled) return "Live trading is switched off on this server";
    const h = this.d.users.get(userId).handle;
    if (!h) return "Choose your @handle first";
    if (!this.cfg.allowlist.includes("*") && !this.cfg.allowlist.includes(h)) return `@${h} isn't on the live trading pilot list yet`;
    if (!hasPasskey) return "Secure your account with a passkey first: every real trade is signed with it";
    return undefined;
  }

  status(userId: string, hasPasskey: boolean) {
    const reason = this.blockedReason(userId, hasPasskey);
    const w = this.d.wallets.get(userId);
    return {
      enabled: this.cfg.enabled,
      eligible: !reason,
      reason: reason ?? null,
      wallet: w ? { address: w.address, createdAt: w.createdAt } : null,
      limits: { maxOrderUsd: this.cfg.maxOrderUsd, maxDailyUsd: this.cfg.maxDailyUsd, spentTodayUsd: this.spentToday(userId), reserveSol: this.cfg.reserveSol },
      custody: "pilot: Outcry's server key can sign for this wallet after your passkey approval",
    };
  }

  private must(userId: string, hasPasskey: boolean) {
    const r = this.blockedReason(userId, hasPasskey);
    if (r) throw Object.assign(new Error(r), { status: 403 });
  }

  async createWallet(userId: string, hasPasskey: boolean) {
    this.must(userId, hasPasskey);
    const w = await this.d.wallets.ensure(userId);
    this.d.audit.append(`user:${userId}`, "live.wallet_created", { address: w.address, subOrgId: w.subOrgId });
    return { address: w.address, createdAt: w.createdAt };
  }

  /** Real balances, priced in USD. */
  async portfolio(userId: string) {
    const w = this.d.wallets.get(userId);
    if (!w) return null;
    let tokenError: string | null = null;
    const [sol, toks] = await Promise.all([
      this.d.rpc.solBalance(w.address),
      this.d.rpc.tokens(w.address).catch((e: Error) => ((tokenError = e.message.slice(0, 160)), [])),
    ]);
    const info = toks.length ? await this.d.tokenInfo(toks.map((t) => t.mint)).catch(() => ({} as Record<string, TokenInfo>)) : {};
    const solUsd = this.d.solUsd();
    const tokens = toks.map((t) => {
      const i = info[t.mint];
      return { mint: t.mint, symbol: i?.symbol ?? short(t.mint), amount: t.amount, usd: i?.usdPrice !== undefined ? t.amount * i.usdPrice : null };
    }).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
    const totalUsd = sol * solUsd + tokens.reduce((s, t) => s + (t.usd ?? 0), 0);
    return { address: w.address, sol, solUsd: sol * solUsd, tokens, tokenError, totalUsd, explorer: `https://solscan.io/account/${w.address}` };
  }

  spentToday(userId: string) {
    const day = new Date().toISOString().slice(0, 10);
    return (this.trades.get(userId) ?? []).filter((t) => t.side === "buy" && t.status === "confirmed" && t.at.startsWith(day)).reduce((s, t) => s + t.usd, 0);
  }

  /**
   * Price a real swap. Buy: spend `usd` worth of SOL on `token`. Sell: sell
   * `pct` percent of the token back to SOL.
   */
  async quote(userId: string, hasPasskey: boolean, req: { side: "buy" | "sell"; token: string; usd?: number; pct?: number; payWith?: "SOL" | "USDC" }): Promise<Omit<LiveQuote, "transaction" | "requestId" | "userId">> {
    this.must(userId, hasPasskey);
    const w = this.d.wallets.get(userId);
    if (!w) throw new Error("Create your real wallet first");
    const raw = req.token.trim();
    let mint = raw.toUpperCase() === "USDC" ? USDC_MINT : raw;
    if (!isMint(mint)) {
      const m = this.d.resolveMint?.(raw.replace(/^\$/, ""));
      if (m && isMint(m) && !m.startsWith("sim")) mint = m;
    }
    if (!isMint(mint)) throw new Error(`I don't know a real Solana token for "${raw}". Paste its mint address, or use USDC or a stock ticker like MSFT`);
    if (mint === SOL_MINT) throw new Error("Pick a token other than SOL: trades are against SOL");
    const solUsd = this.d.solUsd();
    if (!(solUsd > 0)) throw new Error("No SOL price right now, try again in a few seconds");
    const info = (await this.d.tokenInfo([mint]).catch(() => ({} as Record<string, TokenInfo>)))[mint];
    const symbol = info?.symbol ?? short(mint);

    // Trades settle against SOL by default. Some tokens (e.g. Ondo stocks) only route against USDC,
    // so when the SOL route fails we try USDC, or the user can ask to pay with USDC directly.
    const bases: ("SOL" | "USDC")[] = mint === USDC_MINT ? ["SOL"] : req.payWith === "USDC" ? ["USDC"] : req.payWith === "SOL" ? ["SOL"] : ["SOL", "USDC"];
    let built: Awaited<ReturnType<LivePilot["buildOrder"]>> | undefined;
    const errors: string[] = [];
    for (const base of bases) {
      try {
        built = await this.buildOrder(userId, w.address, req, mint, symbol, base, solUsd);
        break;
      } catch (e) {
        errors.push(`${base}: ${(e as Error).message}`);
      }
    }
    if (!built) throw new Error(errors.length === 1 ? errors[0]!.replace(/^(SOL|USDC): /, "") : `No route worked. ${errors.join(" | ")}`);
    const { order, usd, inputMint, outputMint, payAmount, payAsset, base } = built;
    const baseDecimals = base === "SOL" ? 9 : 6;
    const receiveDecimals = req.side === "buy" ? (info?.decimals ?? (await this.decimalsOf(mint))) : baseDecimals;
    const q: LiveQuote = {
      id: newId("lq"),
      userId,
      side: req.side,
      mint,
      symbol,
      inputMint,
      outputMint,
      inAmount: order.inAmount,
      outAmount: order.outAmount,
      payAmount,
      payAsset,
      receiveAmount: Number(order.outAmount) / 10 ** receiveDecimals,
      receiveAsset: req.side === "buy" ? symbol : base,
      base,
      usd,
      feeBps: order.feeBps,
      outcryFeeBps: this.referralBps(order),
      router: order.router,
      requestId: order.requestId,
      transaction: order.transaction!,
      expiresAt: Date.now() + QUOTE_TTL_MS,
    };
    this.quotes.set(q.id, q);
    for (const [k, v] of this.quotes) if (v.expiresAt < Date.now() - 60_000) this.quotes.delete(k);
    const { transaction: _t, requestId: _r, userId: _u, ...pub } = q;
    return pub;
  }

  /** Build one Jupiter order against a base asset (SOL or USDC), with the pilot's checks. */
  private async buildOrder(userId: string, address: string, req: { side: "buy" | "sell"; usd?: number; pct?: number }, mint: string, symbol: string, base: "SOL" | "USDC", solUsd: number) {
    const baseMint = base === "SOL" ? SOL_MINT : USDC_MINT;
    const sol = await this.d.rpc.solBalance(address);
    if (req.side === "buy") {
      const usd = Number(req.usd);
      if (!(usd > 0)) throw new Error("How many dollars should go into this buy?");
      if (usd > this.cfg.maxOrderUsd + 1e-9) throw new Error(`Pilot limit: $${this.cfg.maxOrderUsd} per buy`);
      const spent = this.spentToday(userId);
      if (spent + usd > this.cfg.maxDailyUsd + 1e-9) throw new Error(`Pilot limit: $${this.cfg.maxDailyUsd} of buys per day ($${spent.toFixed(2)} used)`);
      let amount: bigint, payAmount: number;
      if (base === "SOL") {
        payAmount = usd / solUsd;
        if (sol - payAmount < this.cfg.reserveSol) throw new Error(`Not enough SOL: you have ${sol.toFixed(4)} SOL and ${this.cfg.reserveSol} SOL stays back for fees. Deposit SOL to ${address}`);
        amount = BigInt(Math.floor(payAmount * 1e9));
      } else {
        const usdc = (await this.d.rpc.tokens(address)).find((t) => t.mint === USDC_MINT)?.amount ?? 0;
        if (usdc + 1e-9 < usd) throw new Error(`Not enough USDC: you have ${usdc.toFixed(2)}`);
        if (sol < 0.003) throw new Error(`Keep at least 0.003 SOL for network fees (have ${sol.toFixed(4)})`);
        payAmount = usd;
        amount = BigInt(Math.floor(usd * 1e6));
      }
      const order = await this.d.jupiter.order({ inputMint: baseMint, outputMint: mint, amount, taker: address });
      return { order, usd, inputMint: baseMint, outputMint: mint, payAmount, payAsset: base as string, base };
    }
    const pct = Math.min(100, Math.max(1, Number(req.pct ?? 100)));
    const held = (await this.d.rpc.tokens(address)).find((t) => t.mint === mint);
    if (!held) throw new Error(`You don't hold ${symbol}`);
    const amount = pct >= 100 ? BigInt(held.raw) : (BigInt(held.raw) * BigInt(Math.round(pct * 100))) / 10_000n;
    if (amount <= 0n) throw new Error("Nothing to sell");
    if (sol < 0.001) throw new Error(`You need a little SOL for the network fee (have ${sol.toFixed(4)})`);
    const order = await this.d.jupiter.order({ inputMint: mint, outputMint: baseMint, amount, taker: address });
    const usd = base === "SOL" ? (Number(order.outAmount) / 1e9) * solUsd : Number(order.outAmount) / 1e6;
    return { order, usd, inputMint: mint, outputMint: baseMint, payAmount: Number(amount) / 10 ** held.decimals, payAsset: symbol, base };
  }

  /** Last time Jupiter skipped our referral fee (usually: no fee token account for that mint yet). */
  referralMiss?: { at: string; feeMint?: string };

  private referralBps(order: { platformFee?: { feeBps?: number; feeMint?: string }; feeMint?: string; referralAccount?: string }) {
    const want = this.d.jupiter.cfg.referralAccount ? this.d.jupiter.cfg.referralFeeBps ?? 0 : 0;
    if (!want) return 0;
    const got = order.platformFee?.feeBps ?? 0;
    if (got !== want) {
      this.referralMiss = { at: nowIso(), feeMint: order.platformFee?.feeMint ?? order.feeMint };
      return 0;
    }
    return want;
  }

  private async decimalsOf(mint: string) {
    const i = (await this.d.tokenInfo([mint]).catch(() => ({} as Record<string, TokenInfo>)))[mint];
    return i?.decimals ?? 6;
  }

  quoteFor(userId: string, quoteId: string) {
    const q = this.quotes.get(quoteId);
    if (!q || q.userId !== userId) throw Object.assign(new Error("Quote not found"), { status: 404 });
    return q;
  }

  /** Sign with Turnkey and send through Jupiter. Call only after the passkey check. */
  async execute(userId: string, hasPasskey: boolean, quoteId: string, approval: string): Promise<LiveTrade> {
    this.must(userId, hasPasskey);
    if (!approval) throw new Error("Approve with your passkey");
    const q = this.quoteFor(userId, quoteId);
    if (q.used) throw new Error("This quote was already used");
    if (Date.now() > q.expiresAt) throw new Error("Quote expired, get a new one");
    if (this.busy.has(userId)) throw new Error("Another trade is still being sent");
    if (q.side === "buy" && this.spentToday(userId) + q.usd > this.cfg.maxDailyUsd + 1e-9) throw new Error(`Pilot limit: $${this.cfg.maxDailyUsd} of buys per day`);
    q.used = true;
    this.busy.add(userId);
    const t: LiveTrade = {
      id: newId("lt"),
      userId,
      at: nowIso(),
      side: q.side,
      mint: q.mint,
      symbol: q.symbol,
      usd: q.usd,
      paid: `${q.payAmount.toPrecision(6)} ${q.payAsset}`,
      received: `${q.receiveAmount.toPrecision(6)} ${q.receiveAsset}`,
      status: "failed",
    };
    try {
      const signed = await this.d.wallets.signSolana(userId, q.transaction);
      const r = await this.d.jupiter.execute(signed, q.requestId);
      t.signature = r.signature;
      if (r.status === "Success") {
        t.status = "confirmed";
        if (r.totalOutputAmount) {
          const dec = q.side === "buy" ? q.receiveAmount / (Number(q.outAmount) || 1) : 1e-9;
          t.received = `${(Number(r.totalOutputAmount) * dec).toPrecision(6)} ${q.receiveAsset}`;
        }
        if (r.signature) t.costs = await this.costsOf(r.signature, userId, q).catch(() => undefined);
      } else {
        t.error = r.error ?? `Jupiter code ${r.code}`;
      }
    } catch (e) {
      t.error = (e as Error).message.slice(0, 300);
    } finally {
      this.busy.delete(userId);
    }
    const list = this.trades.get(userId) ?? [];
    list.push(t);
    if (list.length > 500) list.splice(0, list.length - 500);
    this.trades.set(userId, list);
    this.d.audit.append(`user:${userId}`, t.status === "confirmed" ? "live.swap_confirmed" : "live.swap_failed", { quoteId, side: t.side, mint: t.mint, usd: t.usd, signature: t.signature, error: t.error, approval });
    return t;
  }

  /** Read the confirmed transaction back and price every part of its cost in USD. */
  private async costsOf(signature: string, userId: string, q: LiveQuote): Promise<LiveTrade["costs"]> {
    const w = this.d.wallets.get(userId)!;
    const c = await this.d.rpc.txCosts(signature, w.address, [q.mint, USDC_MINT]);
    if (!c) return undefined;
    const sol = this.d.solUsd();
    const tokUsd = q.mint === USDC_MINT ? 1 : (await this.d.tokenInfo([q.mint]).catch(() => ({} as Record<string, TokenInfo>)))[q.mint]?.usdPrice;
    if (!(sol > 0) || tokUsd === undefined) return undefined;
    // Value that went into / came out of the swap on the base side.
    const baseUsd = q.base === "SOL" ? Math.abs(c.solChange + c.feeSol + c.rentSol) * sol : Math.abs(c.tokenChanges[USDC_MINT] ?? 0);
    const tokenUsd = Math.abs(c.tokenChanges[q.mint] ?? 0) * tokUsd;
    const paidUsd = q.side === "buy" ? baseUsd : tokenUsd;
    const gotUsd = q.side === "buy" ? tokenUsd : baseUsd;
    const networkFeeUsd = c.feeSol * sol, rentUsd = c.rentSol * sol;
    // The value gap includes Outcry's fee; report the fee on its own line and the rest as price vs market.
    const outcryFeeUsd = (q.usd * q.outcryFeeBps) / 10_000;
    const swapEdgeUsd = gotUsd - paidUsd + outcryFeeUsd;
    return { networkFeeUsd, rentUsd, swapEdgeUsd, outcryFeeUsd, totalCostUsd: networkFeeUsd + outcryFeeUsd + Math.max(0, -swapEdgeUsd) };
  }

  history(userId: string) {
    return [...(this.trades.get(userId) ?? [])].reverse().map((t) => ({ ...t, explorer: t.signature ? `https://solscan.io/tx/${t.signature}` : null }));
  }
}

export function pilotConfigFromEnv(env: Record<string, string | undefined>): PilotConfig {
  return {
    enabled: env.OUTCRY_LIVE_TRADING === "1",
    allowlist: String(env.OUTCRY_LIVE_ALLOWLIST ?? "").split(/[\s,]+/).map((h) => h.replace(/^@/, "").toLowerCase().trim()).filter(Boolean),
    maxOrderUsd: Number(env.OUTCRY_LIVE_MAX_ORDER_USD ?? 25),
    maxDailyUsd: Number(env.OUTCRY_LIVE_MAX_DAILY_USD ?? 100),
    reserveSol: Number(env.OUTCRY_LIVE_RESERVE_SOL ?? 0.01),
  };
}
