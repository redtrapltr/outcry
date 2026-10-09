/**
 * Executes model tool calls against the services. Every input is parsed and
 * normalised here, so a malformed call becomes a readable error for the model
 * (and a retry), never an exception in a money path.
 */
import type { Outcry } from "../app.js";
import type { Agent, LaunchTicket, OrderTicket, Timeframe } from "../core/types.js";
import { normalizeSymbol } from "../data/market.js";
import { estimateDevShare } from "../policy/engine.js";
import * as ind from "../strategy/indicators.js";
import type { BacktestReport } from "../strategy/backtest.js";
import type { SavedStrategy } from "../strategy/lab.js";
import { redactAgent, type AgentWithCopy } from "../market/listings.js";
import { usMarketStatus } from "../data/stocks.js";
import type { SniperReplay } from "../agents/runtime.js";

export type Card =
  | { type: "order"; ticket: OrderTicket }
  | { type: "launch"; ticket: LaunchTicket; devSharePct: number }
  | { type: "agent"; agent: Agent; blueprint: BlueprintNode[]; backtest?: BacktestSummary; replay?: SniperReplay }
  | { type: "strategy"; strategy: Omit<SavedStrategy, "report">; report: BacktestSummary }
  | { type: "strategy_search"; asset: string; tested: number; real: boolean; sources: string[]; buyHoldPct: number; ranking: StrategyRank[] }
  | { type: "portfolio"; data: ReturnType<Outcry["users"]["portfolio"]> }
  | { type: "agent_control"; agent: Agent }
  | { type: "live_order"; quote: Record<string, unknown> }
  | { type: "live_withdraw"; withdrawal: Record<string, unknown> };

export interface BlueprintNode {
  key: "goal" | "markets" | "signals" | "risk" | "execution";
  label: string;
  lines: string[];
}

export interface StrategyRank {
  rank: number; name: string; timeframe: string; trades: number; inSamplePct: number; outOfSamplePct: number;
  fullPct: number; holdPct: number; maxDrawdownPct: number; winRatePct: number; strategyId?: string;
}

export interface BacktestSummary {
  summary: string;
  dataSource?: string;
  realData: boolean;
  startEquity: number;
  from: number;
  to: number;
  bars: number;
  full: BacktestReport["full"];
  outOfSample: BacktestReport["outOfSample"];
  monteCarloDrawdownPct: BacktestReport["monteCarloDrawdownPct"];
  warnings: string[];
  equityCurve: BacktestReport["equityCurve"];
  paramCount: number;
}

export interface ToolOutcome {
  ok: boolean;
  /** JSON-able content returned to the model. */
  result: Record<string, unknown>;
  card?: Card;
  /** Extra cards after `card` (e.g. a ranking followed by the top strategies). */
  cards?: Card[];
  /** True when the input failed validation (counts toward escalation). */
  validationError?: boolean;
}

const summarizeReport = (r: BacktestReport, summary: string): BacktestSummary => ({
  summary,
  dataSource: r.dataSource,
  realData: r.realData ?? false,
  startEquity: r.startEquity ?? 10_000,
  from: r.from,
  to: r.to,
  bars: r.bars,
  full: r.full,
  outOfSample: r.outOfSample,
  monteCarloDrawdownPct: r.monteCarloDrawdownPct,
  warnings: r.warnings,
  equityCurve: r.equityCurve,
  paramCount: r.paramCount,
});

export function blueprint(a: Agent): BlueprintNode[] {
  const s = a.spec;
  const copy = (a as AgentWithCopy).copyOf;
  if (copy) {
    return [
      { key: "goal", label: "GOAL", lines: [`Marketplace agent: ${s.name}`] },
      { key: "markets", label: "MARKETS · JACKETS", lines: s.markets },
      { key: "signals", label: "SIGNALS · WHEN TO ACT", lines: ["Strategy set by its creator (hidden)", "Copies never buy tokens launched by the creator"] },
      { key: "risk", label: "YOUR RISK SETTINGS", lines: [`$${s.sizeUsd} per trade · exits set by the creator`, `$${s.limits.maxPerDayUsd} wallet, proceeds reinvested · ${s.limits.maxOpenPositions} open positions · pause at −${s.limits.maxDrawdownPct}% drawdown`] },
      { key: "execution", label: "EXECUTION", lines: [s.mode === "paper" ? "Paper trading: simulated fills, no real funds" : "Trades automatically inside these limits"] },
    ];
  }
  const signals: string[] = [];
  if (s.kind === "sniper" && s.universe) {
    signals.push(`New pump.fun tokens, ${s.universe.minHolders}+ holders (disclosed creator wallets count as one)`);
    const age = s.universe.maxAgeSeconds ?? 3600;
    signals.push(`Only launches younger than ${age < 120 ? `${age} seconds` : age < 7200 ? `${Math.round(age / 60)} minutes` : `${Math.round(age / 3600)} hours`}`);
    signals.push(`Top wallet under ${s.universe.maxTopWalletPct}%${s.universe.maxTop10Pct !== undefined ? ` · top 10 wallets under ${s.universe.maxTop10Pct}%` : ""}${s.universe.requireMintRevoked ? " · mint authority revoked" : ""}`);
  } else if (s.program) {
    signals.push(`${s.program.asset} on ${s.program.timeframe}`);
    signals.push(`Entry and exit rules compiled from your description`);
  }
  return [
    { key: "goal", label: "GOAL", lines: [s.goal || s.name] },
    { key: "markets", label: "MARKETS · JACKETS", lines: s.markets },
    { key: "signals", label: "SIGNALS · WHEN TO ACT", lines: signals },
    { key: "risk", label: "RISK LIMITS", lines: [`$${s.sizeUsd} per trade · stop −${s.exit.stopLossPct}% · take profit +${s.exit.takeProfitPct}%${s.exit.maxHoldMinutes ? ` · sell after ${s.exit.maxHoldMinutes} min` : ""}`, `$${s.limits.maxPerDayUsd} wallet, proceeds reinvested · ${s.limits.maxOpenPositions} open positions · pause at −${s.limits.maxDrawdownPct}% drawdown`] },
    { key: "execution", label: "EXECUTION", lines: [s.mode === "ask" ? "Proposes each trade, waits for your tap" : s.mode === "auto" ? "Trades automatically inside these limits" : "Paper trading: simulated fills, no real funds"] },
  ];
}

const untrusted = (o: unknown) => `<untrusted_data>${JSON.stringify(o)}</untrusted_data>`;

export class ToolExecutor {
  /** Resolves Solana mints found in tool input (set by the server when live data is on). */
  lookup?: { ensureFrom(text: string): Promise<string[]> };
  /** Resolves stock tickers / company names to tradable tokens (server, live data on). */
  stocks?: { ensureFrom(text: string): Promise<string[]> };
  /** Stock spread scanner (real Jupiter quotes), when live trading is configured. */
  spreads?: import("../live/spreads.js").SpreadScanner;
  /** Real-money pilot, when configured on the server. */
  live?: { pilot: import("../live/pilot.js").LivePilot; secured: (userId: string) => boolean };
  constructor(private app: Outcry) {}

  wrapForModel(name: string, outcome: ToolOutcome): string {
    const json = JSON.stringify(outcome.result);
    // Anything carrying token names or descriptions is marked untrusted.
    return ["get_token_risk", "list_new_tokens"].includes(name) ? untrusted(outcome.result) : json;
  }

  async run(userId: string, name: string, input: unknown, ctx: { userText?: string } = {}): Promise<ToolOutcome> {
    const i = (input ?? {}) as Record<string, unknown>;
    const { app } = this;
    try {
      if (this.lookup) await this.lookup.ensureFrom(JSON.stringify(input ?? {}));
      if (this.stocks) await this.stocks.ensureFrom(JSON.stringify(input ?? {}));
      switch (name) {
        case "get_portfolio": {
          const data = app.users.portfolio(userId);
          const top = data.positions.map((p) => `${p.symbol} $${p.valueUsd.toFixed(2)}`).join(", ") || "no open positions";
          return { ok: true, result: { summary: `Wallet value $${data.walletUsd.toFixed(2)}. Positions: ${top}.`, ...data }, card: { type: "portfolio", data } };
        }
        case "list_stocks": {
          const q = String(i.query ?? "").toLowerCase();
          const all = app.market.listStocks().filter((x) => !q || x.ticker.toLowerCase().includes(q) || x.name.toLowerCase().includes(q));
          const st = usMarketStatus();
          return { ok: true, result: { summary: `${st.label}. ${all.length} tokenized stocks ready to trade${q ? ` matching "${q}"` : ""}: ${all.slice(0, 60).map((x) => `${x.ticker} (${x.symbol}${x.priceUsd ? ` $${x.priceUsd.toFixed(2)}` : ""})`).join(", ")}. Others resolve on request by ticker.`, stocks: all.slice(0, 100) } };
        }
        case "get_quote": {
          const exact = i.receive_exact !== undefined && i.receive_exact !== null ? Number(i.receive_exact) : undefined;
          const leg = { side: String(i.side ?? "buy") as "buy" | "sell", asset: String(i.asset), quoteAsset: normalizeSymbol(String(i.quote_asset ?? "USDC")), amount: Number(i.amount ?? 0), receiveExact: exact, maxSlippageBps: 50 };
          const venue = app.exec.venueFor(leg);
          const q = await app.exec.adapterFor(venue).quote({ ...leg, venue }, { userId, platformFeeBps: app.config.platformFeeBps });
          const summary = exact !== undefined
            ? `${exact} ${q.asset} costs ${fmt(q.amount)} ${q.quoteAsset} via ${q.venue} (fees included, impact ${(q.priceImpactBps / 100).toFixed(2)}%).`
            : `${leg.side} with ${fmt(q.amount)} ${leg.side === "buy" ? q.quoteAsset : q.asset} via ${q.venue}: about ${fmt(q.expectedOut)} ${leg.side === "buy" ? q.asset : q.quoteAsset} out, impact ${(q.priceImpactBps / 100).toFixed(2)}%.`;
          const info = app.market.stockInfo(q.asset);
          const stockLine = info ? ` ${usMarketStatus().label}; ${info.ticker} (${info.issuer} token) trades 24/7 on Solana${info.onchainUsd ? ` at $${info.onchainUsd.toFixed(2)}` : ""}${info.gapPct !== undefined ? `, ${info.gapPct >= 0 ? "+" : ""}${info.gapPct.toFixed(2)}% vs last Nasdaq $${info.nasdaqUsd!.toFixed(2)}` : ""}.` : "";
          return { ok: true, result: { summary: summary + stockLine, quote: q, ...(info ? { stock: info } : {}) } };
        }
        case "get_token_risk": {
          const r = app.market.tokenRisk(String(i.token));
          if (!r) return { ok: false, result: { error: `No token found for ${String(i.token)}. For tokens not launched in the last hours, ask for the mint address.` } };
          const px = (() => { try { return app.market.priceUsd(r.mint); } catch { return undefined; } })();
          const age = (r.ageSeconds ?? r.ageMinutes * 60);
          const ageTxt = age < 120 ? `${Math.round(age)}s` : age < 7200 ? `${Math.round(age / 60)} min` : age < 172_800 ? `${Math.round(age / 3600)} h` : `${Math.round(age / 86_400)} days`;
          const reg = app.registry.get(r.mint);
          const flags = [!r.mintRevoked && "mint authority active", !r.freezeRevoked && "freeze authority active", !r.topWalletUnknown && r.topWalletPct > 20 && `top wallet ${r.topWalletPct}%`].filter(Boolean);
          const topTxt = r.topWalletUnknown ? "top single wallet: not measured" : `top wallet ${r.topWalletPct}%${r.topWallet ? ` (${r.topWallet.slice(0, 4)}…${r.topWallet.slice(-4)})` : ""}`;
          return {
            ok: true,
            result: {
              summary: `$${r.symbol} (${r.mint}): price ${px !== undefined ? "$" + (px < 0.01 ? px.toPrecision(4) : px.toFixed(4)) + `, market cap ≈ $${Math.round(px * 1e9).toLocaleString("en-US")}` : "unknown"}, launched ${ageTxt} ago. ${r.holdersCollapsed} holders, ${topTxt}${r.top10Pct !== undefined ? `, top 10 wallets ${r.top10Pct}% combined` : ""}${r.poolPct !== undefined ? ` (bonding curve / liquidity pool accounts hold ${r.poolPct}% and are not counted as holders)` : ""}, liquidity $${r.liquidityUsd.toLocaleString("en-US")}. ${flags.length ? "Flags: " + flags.join(", ") + "." : "No red flags in the checks I ran."} Bundles (wallets buying together at launch) are not detected yet.`,
              risk: r,
              creatorRegistry: reg ? { wallets: reg.wallets.length, devSharePct: reg.devSharePct } : null,
            },
          };
        }
        case "list_new_tokens": {
          const list = app.market.recentLaunches(Math.min(20, Number(i.limit ?? 10))).map((l) => {
            const r = app.market.tokenRisk(l.mint)!;
            return { symbol: r.symbol, mint: r.mint, ageMinutes: r.ageMinutes, holders: r.holdersCollapsed, topWalletPct: r.topWalletPct, mintRevoked: r.mintRevoked };
          });
          return { ok: true, result: { summary: `Latest launches: ${list.map((x) => `$${x.symbol} (${x.holders} holders)`).join(", ")}.`, tokens: list } };
        }
        case "get_market_data": {
          const asset = normalizeSymbol(String(i.asset));
          const tf = (String(i.timeframe ?? "1h") as Timeframe);
          const c = app.market.candles(asset, tf, 300);
          const closes = c.map((x) => x.close);
          const last = closes.at(-1)!;
          const rsi14 = ind.rsi(closes, 14).at(-1)!;
          const ema50 = ind.ema(closes, 50).at(-1)!;
          const ema200 = ind.ema(closes, 200).at(-1)!;
          const chg = ((last - closes.at(-7)!) / closes.at(-7)!) * 100;
          return {
            ok: true,
            result: {
              summary: `${asset} ${last.toFixed(2)} USD on ${tf}: RSI(14) ${rsi14.toFixed(0)}, ${last > ema200 ? "above" : "below"} the 200-EMA (${ema200.toFixed(2)}), ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}% over 6 bars.`,
              asset, timeframe: tf, last, rsi14, ema50, ema200,
            },
          };
        }
        case "propose_order": {
          const legs = (Array.isArray(i.legs) ? i.legs : []).map((l: Record<string, unknown>) => ({
            side: (String(l.side ?? "buy") === "sell" ? "sell" : "buy") as "buy" | "sell",
            asset: String(l.asset ?? ""),
            quoteAsset: normalizeSymbol(String(l.quote_asset ?? "USDC")),
            amount: Number(l.amount ?? 0),
            receiveExact: l.receive_exact !== undefined && l.receive_exact !== null ? Number(l.receive_exact) : undefined,
            maxSlippageBps: Number(l.max_slippage_bps ?? 50),
          }));
          if (!legs.length || legs.some((l) => !l.asset || !(l.amount > 0 || (l.receiveExact ?? 0) > 0))) {
            return { ok: false, validationError: true, result: { error: "Each leg needs a side, an asset, and either amount (to spend or sell) or receive_exact (to buy an exact quantity)" } };
          }
          const t = await app.desk.proposeOrder({ userId, legs });
          if (t.status === "rejected") return { ok: false, result: { error: t.rejection, ticketId: t.id }, card: { type: "order", ticket: t } };
          const lines = t.legs.map((l) =>
            l.receiveExact !== undefined
              ? `BUY exactly ${fmt(l.receiveExact)} ${l.asset} for ≈${fmt(l.amount)} ${l.quoteAsset} via ${l.venue}`
              : `${l.side.toUpperCase()} ${l.asset} with ${fmt(l.amount)} ${l.side === "buy" ? l.quoteAsset : l.asset} via ${l.venue} (≈${fmt(l.expectedOut)} ${l.side === "buy" ? l.asset : l.quoteAsset})`,
          );
          return {
            ok: true,
            result: { summary: `Ticket ready: ${lines.join("; ")}. Total ≈ $${t.totalUsd.toFixed(2)}.${t.warnings.length ? " Check: " + t.warnings.join("; ") + "." : ""} Nothing moves until you sign.`, ticketId: t.id, status: t.status },
            card: { type: "order", ticket: t },
          };
        }
        case "propose_withdrawal": {
          if (!this.live) return { ok: false, result: { error: "Real-money wallets aren't set up on this server." } };
          const to = String(i.to ?? "").trim();
          // Safety: the destination must appear verbatim in what the user typed this turn. The model can
          // never invent, complete or "fix" an address.
          if (!to || !ctx.userText || !ctx.userText.includes(to)) {
            return { ok: false, validationError: true, result: { error: "For safety, withdrawals only go to an address the user pasted in this message. Ask them to paste the full destination address." } };
          }
          try {
            const w = await this.live.pilot.prepareWithdrawal(userId, this.live.secured(userId), { to, token: String(i.token ?? "SOL"), amount: i.amount !== undefined ? Number(i.amount) : undefined, max: !!i.max });
            return {
              ok: true,
              result: { summary: `Withdrawal ready: send ${w.amount} ${w.asset} to ${w.to}. Network fee about ${w.feeSol} SOL${w.createsAccountSol ? ` plus ${w.createsAccountSol} SOL for the receiver's token account` : ""}. Check the address, then sign with your passkey within 60 seconds. Withdrawals can't be reversed.` },
              card: { type: "live_withdraw", withdrawal: w as unknown as Record<string, unknown> },
            };
          } catch (e) {
            return { ok: false, result: { error: (e as Error).message } };
          }
        }
        case "scan_stock_spreads": {
          if (!this.spreads) return { ok: false, result: { error: "The spread scanner needs live trading (Jupiter key) on this server." } };
          const size = Math.min(1_000, Math.max(10, Number(i.size_usd ?? 100)));
          const r = await this.spreads.scan(size);
          const lines = r.rows.map((x) => `${x.ticker}: ${x.cheap} cheaper by ${x.discountPct.toFixed(2)}% (buy $${x.buyCheapPx.toFixed(2)} vs sell ${x.rich} $${x.sellRichPx.toFixed(2)}); swap edge after Outcry fees ${x.swapEdgePct >= 0 ? "+" : ""}${x.swapEdgePct.toFixed(2)}%`);
          return { ok: true, result: { summary: `Executable quotes for $${size} at ${r.at} (Outcry fee ${r.outcryFeeBps / 100}% per leg). ${lines.length ? lines.join("; ") : "No pair could be quoted."}${r.errors.length ? ` Not quotable: ${r.errors.join("; ")}` : ""}`, scan: r } };
        }
        case "propose_real_order": {
          if (!this.live) return { ok: false, result: { error: "Real-money trading isn't set up on this server. I can place it as a paper order instead." } };
          const side = String(i.side) === "sell" ? "sell" : "buy";
          const token = String(i.token ?? "").trim();
          if (!token) return { ok: false, validationError: true, result: { error: "Which token? Give a mint address, USDC, or a stock ticker like MSFT." } };
          try {
            const payWith = i.pay_with === "USDC" || i.pay_with === "SOL" ? (i.pay_with as "SOL" | "USDC") : undefined;
            const q = await this.live.pilot.quote(userId, this.live.secured(userId), { side, token, usd: i.usd !== undefined ? Number(i.usd) : undefined, pct: i.pct !== undefined ? Number(i.pct) : undefined, payWith });
            return {
              ok: true,
              result: { summary: `Real order ready: ${side.toUpperCase()} ${q.symbol}, pay ${fmt(q.payAmount)} ${q.payAsset}, receive about ${fmt(q.receiveAmount)} ${q.receiveAsset} (≈$${q.usd.toFixed(2)}). This is real money: sign with your passkey within 40 seconds, or get a new quote.`, quoteId: q.id },
              card: { type: "live_order", quote: q as unknown as Record<string, unknown> },
            };
          } catch (e) {
            return { ok: false, result: { error: (e as Error).message } };
          }
        }
        case "propose_launch": {
          const t = app.launches.propose(userId, { name: i.name, ticker: i.ticker, description: i.description ?? "", wallets: Number(i.wallets), solPerWallet: Number(i.sol_per_wallet ?? i.solPerWallet) });
          const share = estimateDevShare(t.totalSol).pct;
          if (t.status === "rejected") return { ok: false, validationError: !t.totalSol, result: { error: t.rejection }, card: { type: "launch", ticket: t, devSharePct: share } };
          return {
            ok: true,
            result: { summary: `Launch ticket for $${t.request.ticker}: ${t.request.wallets} launch wallets × ${t.request.solPerWallet} SOL = ${t.totalSol.toFixed(2)} SOL dev buy, about ${share.toFixed(1)}% of supply, disclosed as creator wallets on the token page. Adjust it, then sign.`, ticketId: t.id },
            card: { type: "launch", ticket: t, devSharePct: share },
          };
        }
        case "propose_agent": {
          const spec: Record<string, unknown> = { ...i, mode: "paper" };
          if (spec.kind === "sniper") spec.universe = { venue: "pumpfun", ...(spec.universe as object) };
          const res = app.agents.propose(userId, spec);
          const bt = res.backtest ? summarizeReport(res.backtest, res.agent.lastBacktest!.summary) : undefined;
          return {
            ok: true,
            result: { summary: `${res.agent.spec.name} is assembled. ${res.agent.lastBacktest?.summary ?? ""} Tune it below, then deploy in paper mode first.`, agentId: res.agent.id },
            card: { type: "agent", agent: res.agent, blueprint: blueprint(res.agent), backtest: bt, replay: res.replay },
          };
        }
        case "update_agent": {
          const a = this.findAgent(userId, String(i.agent ?? ""));
          if (!a) return { ok: false, result: { error: "No matching agent to update. Name it, or use propose_agent to build a new one." } };
          const { agent: _n, ...patch } = i as Record<string, unknown>;
          if (patch.universe && a.spec.kind === "sniper") patch.universe = { venue: "pumpfun", ...(patch.universe as object) };
          const res = app.agents.revise(userId, a.id, patch as never);
          const bt = res.backtest ? summarizeReport(res.backtest, res.agent.lastBacktest!.summary) : undefined;
          return {
            ok: true,
            result: { summary: `${res.agent.spec.name} updated to v${res.agent.version} (${res.agent.state}). ${res.agent.lastBacktest?.summary ?? ""}`, agentId: res.agent.id },
            card: { type: "agent", agent: res.agent, blueprint: blueprint(res.agent), backtest: bt, replay: res.replay },
          };
        }
        case "search_strategies": {
          const tfs = Array.isArray(i.timeframes) ? (i.timeframes as string[]).filter((x) => ["1h", "4h", "1d"].includes(x)) : undefined;
          const res = await app.lab.search(userId, { asset: String(i.asset ?? ""), days: Number(i.lookback_days ?? 0) || undefined, timeframes: tfs as never, sizeUsd: Number(i.size_usd ?? 0) || undefined });
          if (!res.ok) return { ok: false, result: { error: res.error } };
          const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
          const lines = res.ranking.slice(0, 8).map((r) => `${r.rank}. ${r.name}: ${pct(r.fullPct)} full, ${pct(r.outOfSamplePct)} out-of-sample, ${r.trades} trades, ${r.winRatePct.toFixed(0)}% win, max DD ${r.maxDrawdownPct.toFixed(1)}%`);
          const cards: Card[] = [{ type: "strategy_search", asset: res.asset, tested: res.tested, real: res.real, sources: res.sources, buyHoldPct: res.buyHoldPct, ranking: res.ranking }];
          for (const s of res.top.slice(0, 2)) {
            const { report, ...rest } = s;
            cards.push({ type: "strategy", strategy: rest, report: summarizeReport(report, rest.summary) });
          }
          return {
            ok: true,
            result: {
              summary: `Tested ${res.tested} strategies on ${res.asset} (${res.real ? "REAL prices: " + res.sources.join(", ") : "SIMULATED prices, not real history"}). Buy-and-hold over the window: ${pct(res.buyHoldPct)}. Ranked on the first 70% of the window; out-of-sample = last 30%.\n${lines.join("\n")}`,
              topStrategyIds: res.top.map((t) => t.id),
            },
            cards,
          };
        }
        case "compile_strategy": {
          const days = Number(i.lookback_days ?? i.days ?? 0) || undefined;
          const res = await app.lab.compileAndTest(userId, i.program ?? i, undefined, { days });
          if (!res.ok) return { ok: false, validationError: true, result: { error: res.error } };
          const { report, ...rest } = res.strategy;
          return {
            ok: true,
            result: { summary: `${rest.description}\n\n${rest.summary}${report.warnings.length ? "\n\nFlags: " + report.warnings.join("; ") + "." : ""}`, strategyId: rest.id },
            card: { type: "strategy", strategy: rest, report: summarizeReport(report, rest.summary) },
          };
        }
        case "control_agent": {
          const a = this.findAgent(userId, String(i.agent ?? ""));
          if (!a) return { ok: false, result: { error: "No matching agent. Name it, e.g. “pause sniper”." } };
          const action = String(i.action) as "pause" | "resume" | "kill";
          app.agents.control(userId, a.id, action);
          return { ok: true, result: { summary: action === "kill" ? `${a.spec.name} is off the floor. Open positions stay in your wallet; unspent funds went back to your main wallet.` : `${a.spec.name} is ${a.state}.` }, card: { type: "agent_control", agent: a } };
        }
        case "explain_agent": {
          const a = this.findAgent(userId, String(i.agent ?? ""));
          if (!a) return { ok: false, result: { error: "No matching agent" } };
          const hiddenStrategy = app.marketplace.isCopy(a.id);
          const log = app.agents.explain(a.id, 8).map((e) => {
            const d = { at: e.at, action: e.action.replace("agent.decision.", ""), ...(e.data as Record<string, unknown>) } as Record<string, unknown>;
            // Marketplace copy: the creator's filters stay private.
            if (hiddenStrategy && d.action === "skip") d.reason = "didn't match the strategy";
            if (hiddenStrategy) { delete d.holders; delete d.topWalletPct; delete d.top10Pct; }
            return d;
          });
          const line = (e: Record<string, unknown>) => {
            const t = String(e.at).slice(11, 19);
            if (e.action === "entry") return `${t} entry signal on ${e.symbol ?? e.asset}${e.holders ? ` (${e.holders} holders, top wallet ${e.topWalletPct}%)` : e.close ? ` at ${Number(e.close).toFixed(2)}` : ""}`;
            if (e.action === "exit") return `${t} sold ${e.symbol}: ${e.reason}`;
            return `${t} skipped ${e.symbol}: ${e.reason}`;
          };
          const b = app.agents.budget(a);
          const budgetLine = `Wallet: $${b.cashUsd.toFixed(2)} free cash, $${b.inPositionsUsd.toFixed(2)} in open positions (budget $${b.budgetUsd}; sale proceeds are reinvested, no daily cap). ${b.buysToday.length} buy${b.buysToday.length === 1 ? "" : "s"} today${b.buysToday.length ? `: ${b.buysToday.map((x) => `${new Date(x.t).toISOString().slice(11, 16)} UTC $${x.symbol} $${x.usd.toFixed(2)}`).join(", ")}` : ""}.${b.outOfCash ? " No free cash: it buys again when a position is sold." : ""}`;
          return { ok: true, result: { summary: `${budgetLine}\n${log.length ? `${a.spec.name}'s last decisions, from the audit log:\n${log.map(line).join("\n")}` : `${a.spec.name} hasn't made any decisions yet.`}`, decisions: log, budget: b } };
        }
        default:
          return { ok: false, validationError: true, result: { error: `Unknown tool ${name}` } };
      }
    } catch (e) {
      const msg = (e as Error).message;
      const isValidation = (e as { name?: string }).name === "ZodError";
      return { ok: false, validationError: isValidation, result: { error: isValidation ? "Invalid input: " + msg.slice(0, 400) : msg } };
    }
  }

  private findAgent(userId: string, q: string) {
    const list = this.app.agents.listForUser(userId).filter((a) => a.state !== "killed");
    const s = q.toLowerCase().trim();
    if (!s || s === "last" || s === "it") return list.at(-1);
    return list.find((a) => a.id === q || a.spec.name.toLowerCase() === s || a.spec.name.toLowerCase().includes(s) || s.includes(a.spec.name.toLowerCase()));
  }
}

const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(2) : Math.abs(n) >= 1 ? n.toFixed(4) : n.toPrecision(4));
