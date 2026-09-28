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
import type { SniperReplay } from "../agents/runtime.js";

export type Card =
  | { type: "order"; ticket: OrderTicket }
  | { type: "launch"; ticket: LaunchTicket; devSharePct: number }
  | { type: "agent"; agent: Agent; blueprint: BlueprintNode[]; backtest?: BacktestSummary; replay?: SniperReplay }
  | { type: "strategy"; strategy: Omit<SavedStrategy, "report">; report: BacktestSummary }
  | { type: "portfolio"; data: ReturnType<Outcry["users"]["portfolio"]> }
  | { type: "agent_control"; agent: Agent };

export interface BlueprintNode {
  key: "goal" | "markets" | "signals" | "risk" | "execution";
  label: string;
  lines: string[];
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
    { key: "risk", label: "RISK LIMITS", lines: [`$${s.sizeUsd} per trade · stop −${s.exit.stopLossPct}% · take profit +${s.exit.takeProfitPct}%`, `max $${s.limits.maxPerDayUsd} per day · ${s.limits.maxOpenPositions} open positions · pause at −${s.limits.maxDrawdownPct}% drawdown`] },
    { key: "execution", label: "EXECUTION", lines: [s.mode === "ask" ? "Proposes each trade, waits for your tap" : s.mode === "auto" ? "Trades automatically inside these limits" : "Paper trading: simulated fills, no real funds"] },
  ];
}

const untrusted = (o: unknown) => `<untrusted_data>${JSON.stringify(o)}</untrusted_data>`;

export class ToolExecutor {
  constructor(private app: Outcry) {}

  wrapForModel(name: string, outcome: ToolOutcome): string {
    const json = JSON.stringify(outcome.result);
    // Anything carrying token names or descriptions is marked untrusted.
    return ["get_token_risk", "list_new_tokens"].includes(name) ? untrusted(outcome.result) : json;
  }

  async run(userId: string, name: string, input: unknown): Promise<ToolOutcome> {
    const i = (input ?? {}) as Record<string, unknown>;
    const { app } = this;
    try {
      switch (name) {
        case "get_portfolio": {
          const data = app.users.portfolio(userId);
          const top = data.positions.map((p) => `${p.symbol} $${p.valueUsd.toFixed(2)}`).join(", ") || "no open positions";
          return { ok: true, result: { summary: `Wallet value $${data.walletUsd.toFixed(2)}. Positions: ${top}.`, ...data }, card: { type: "portfolio", data } };
        }
        case "get_quote": {
          const exact = i.receive_exact !== undefined && i.receive_exact !== null ? Number(i.receive_exact) : undefined;
          const leg = { side: String(i.side ?? "buy") as "buy" | "sell", asset: String(i.asset), quoteAsset: normalizeSymbol(String(i.quote_asset ?? "USDC")), amount: Number(i.amount ?? 0), receiveExact: exact, maxSlippageBps: 50 };
          const venue = app.exec.venueFor(leg);
          const q = await app.exec.adapterFor(venue).quote({ ...leg, venue }, { userId, platformFeeBps: app.config.platformFeeBps });
          const summary = exact !== undefined
            ? `${exact} ${q.asset} costs ${fmt(q.amount)} ${q.quoteAsset} via ${q.venue} (fees included, impact ${(q.priceImpactBps / 100).toFixed(2)}%).`
            : `${leg.side} with ${fmt(q.amount)} ${leg.side === "buy" ? q.quoteAsset : q.asset} via ${q.venue}: about ${fmt(q.expectedOut)} ${leg.side === "buy" ? q.asset : q.quoteAsset} out, impact ${(q.priceImpactBps / 100).toFixed(2)}%.`;
          return { ok: true, result: { summary, quote: q } };
        }
        case "get_token_risk": {
          const r = app.market.tokenRisk(String(i.token));
          if (!r) return { ok: false, result: { error: `No pump.fun token found for ${String(i.token)}` } };
          const reg = app.registry.get(r.mint);
          const flags = [!r.mintRevoked && "mint authority active", !r.freezeRevoked && "freeze authority active", r.topWalletPct > 20 && `top wallet ${r.topWalletPct}%`].filter(Boolean);
          return {
            ok: true,
            result: {
              summary: `$${r.symbol}: ${r.holdersCollapsed} real holders${r.holders !== r.holdersCollapsed ? ` (${r.holders} addresses, ${r.creatorWallets.length} are disclosed creator wallets)` : ""}, top wallet ${r.topWalletPct}%, liquidity $${r.liquidityUsd.toLocaleString("en-US")}. ${flags.length ? "Flags: " + flags.join(", ") + "." : "No red flags in the checks I ran."}`,
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
          const log = app.agents.explain(a.id, 8).map((e) => ({ at: e.at, action: e.action.replace("agent.decision.", ""), ...(e.data as Record<string, unknown>) }));
          const line = (e: Record<string, unknown>) => {
            const t = String(e.at).slice(11, 19);
            if (e.action === "entry") return `${t} entry signal on ${e.symbol ?? e.asset}${e.holders ? ` (${e.holders} holders, top wallet ${e.topWalletPct}%)` : e.close ? ` at ${Number(e.close).toFixed(2)}` : ""}`;
            if (e.action === "exit") return `${t} sold ${e.symbol}: ${e.reason}`;
            return `${t} skipped ${e.symbol}: ${e.reason}`;
          };
          return { ok: true, result: { summary: log.length ? `${a.spec.name}'s last decisions, from the audit log:\n${log.map(line).join("\n")}` : `${a.spec.name} hasn't made any decisions yet.`, decisions: log } };
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
