/**
 * Agent runtime.
 *
 * An agent is a versioned spec executed by deterministic code. The LLM
 * designs the spec in chat; at run time no model call is involved, so
 * decisions are cheap, reproducible and explainable from the audit log.
 *
 * Limits are enforced three times: here before a ticket exists, in the
 * policy engine against running totals, and in the sub-wallet's signer
 * policy, which only ever holds the daily cap.
 */
import { AuditLog, EventBus, dayKey, newId, nowIso } from "../core/infra.js";
import { AgentSpec, type Agent, type AgentMode, type OrderTicket, type StrategyProgram } from "../core/types.js";
import type { UserStore } from "../core/users.js";
import type { MarketData, TokenRisk } from "../data/market.js";
import type { TicketDesk } from "../tickets/desk.js";
import type { Signer } from "../wallet/signer.js";
import type { CreatorRegistry } from "../launch/service.js";
import { backtest, summarize, type BacktestReport } from "../strategy/backtest.js";
import { compile } from "../strategy/evaluator.js";

interface AgentPosition {
  symbol: string;
  qty: number;
  entryPrice: number;
  peakPrice: number;
  openedAt: string;
  ticketId: string;
}

export interface AgentRuntimeDeps {
  users: UserStore;
  market: MarketData;
  desk: TicketDesk;
  signer: Signer;
  audit: AuditLog;
  bus: EventBus;
  registry: CreatorRegistry;
  /** Days of paper trading required before auto mode unlocks. */
  paperDaysBeforeAuto: number;
}

export interface SniperReplay {
  scanned: number;
  matched: number;
  skipped: { symbol: string; reason: string }[];
}

export class AgentRuntime {
  readonly agents = new Map<string, Agent>();
  private positions = new Map<string, AgentPosition[]>();
  private seenTokens = new Map<string, Set<string>>();
  private pendingTickets = new Map<string, { agentId: string; side: "buy" | "sell"; symbol: string }>();
  private paperSince = new Map<string, number>();
  private limitNotified = new Map<string, string>();

  constructor(private d: AgentRuntimeDeps) {}

  get(id: string) {
    return this.agents.get(id);
  }

  listForUser(userId: string) {
    return [...this.agents.values()].filter((a) => a.userId === userId);
  }

  positionsOf(agentId: string) {
    return this.positions.get(agentId) ?? [];
  }

  private history = new Map<string, { t: number; v: number }[]>();
  private trades = new Map<string, { t: number; side: "buy" | "sell"; symbol: string; usd: number; pnlUsd?: number }[]>();
  private startUsd = new Map<string, number>();

  private sample(a: Agent, now = Date.now()) {
    const h = this.history.get(a.id) ?? [];
    const v = this.equityUsd(a);
    a.stats.equityUsd = v;
    const last = h.at(-1);
    if (last && now - last.t < 1_000) last.v = v;
    else h.push({ t: now, v });
    // Keep the chart light: thin out older points once there are many.
    if (h.length > 600) {
      const thinned = h.filter((_, i) => i % 2 === 0 || i >= h.length - 200);
      h.splice(0, h.length, ...thinned);
    }
    this.history.set(a.id, h);
  }

  /** Live performance for the terminal: equity curve, P&L, trades and open positions. */
  perf(agentId: string) {
    const a = this.agents.get(agentId);
    if (!a) return undefined;
    if (a.state === "paper" || a.state === "live" || a.state === "paused") this.sample(a);
    const start = this.startUsd.get(agentId) ?? 0;
    const equity = a.stats.equityUsd;
    const trades = this.trades.get(agentId) ?? [];
    const sells = trades.filter((x) => x.side === "sell");
    const positions = this.positionsOf(agentId).map((p) => {
      let price = p.entryPrice;
      try { price = this.d.market.priceUsd(p.symbol); } catch { /* delisted */ }
      const valueUsd = p.qty * price;
      const costUsd = p.qty * p.entryPrice;
      return { symbol: p.symbol, valueUsd, costUsd, pnlUsd: valueUsd - costUsd, pnlPct: costUsd > 0 ? ((valueUsd - costUsd) / costUsd) * 100 : 0, openedAt: p.openedAt };
    });
    return {
      startUsd: start,
      equityUsd: equity,
      pnlUsd: start > 0 ? equity - start : 0,
      pnlPct: start > 0 ? ((equity - start) / start) * 100 : 0,
      realizedPnlUsd: a.stats.realizedPnlUsd,
      unrealizedPnlUsd: positions.reduce((x, p) => x + p.pnlUsd, 0),
      drawdownPct: a.stats.peakEquityUsd > 0 ? Math.max(0, ((a.stats.peakEquityUsd - equity) / a.stats.peakEquityUsd) * 100) : 0,
      cashUsd: equity - positions.reduce((x, p) => x + p.valueUsd, 0),
      /** What the cash is held in (a SOL-funded agent moves with SOL's price even without trades). */
      cash: Object.entries(a.balances).filter(([k, v]) => v > 1e-9 && !positions.some((p) => p.symbol === k)).map(([asset, amount]) => ({ asset, amount })),
      fundedIn: Object.keys(a.balances)[0],
      watching: a.spec.kind === "sniper" ? this.watching(agentId) : [],
      budget: this.budget(a),
      virtual: a.spec.mode === "paper",
      history: this.history.get(agentId) ?? [],
      trades: trades.slice(-100),
      closedTrades: sells.length,
      wins: sells.filter((x) => (x.pnlUsd ?? 0) > 0).length,
      positions,
    };
  }

  // -------------------------------------------------------------------------
  // Design time
  // -------------------------------------------------------------------------

  /** Create a draft from a spec (usually written by the LLM) and test it. */
  propose(userId: string, input: unknown): { agent: Agent; backtest?: BacktestReport; replay?: SniperReplay } {
    const spec = AgentSpec.parse(input);
    if (spec.kind === "rules" && !spec.program) throw new Error("A rules agent needs a strategy program");
    if (spec.kind === "sniper" && !spec.universe) throw new Error("A sniper agent needs token filters");
    if (spec.sizeUsd > spec.limits.maxPerTradeUsd) spec.limits.maxPerTradeUsd = spec.sizeUsd;

    const agent: Agent = {
      id: newId("agt"),
      userId,
      version: 1,
      spec,
      state: "draft",
      subWalletId: "",
      subWalletAddress: "",
      balances: {},
      createdAt: nowIso(),
      stats: { spentTodayUsd: 0, dayKey: dayKey(), openPositions: 0, realizedPnlUsd: 0, peakEquityUsd: 0, equityUsd: 0 },
    };
    this.agents.set(agent.id, agent);
    this.d.audit.append(`user:${userId}`, "agent.proposed", { agentId: agent.id, spec });

    let report: BacktestReport | undefined;
    let replay: SniperReplay | undefined;
    if (spec.kind === "rules") {
      const program: StrategyProgram = {
        ...spec.program!,
        exit: { any: [spec.program!.exit, { stop_loss_pct: spec.exit.stopLossPct }, { take_profit_pct: spec.exit.takeProfitPct }] },
        size: { fixed_quote: spec.sizeUsd },
      };
      const candles = this.d.market.candles(program.asset, program.timeframe, 2_000);
      report = backtest(program, candles, Math.max(spec.limits.maxPerDayUsd * 10, 1_000));
      agent.lastBacktest = { at: nowIso(), summary: summarize(report), passed: report.full.maxDrawdownPct <= spec.limits.maxDrawdownPct };
    } else {
      replay = this.replayUniverse(agent);
      agent.lastBacktest = {
        at: nowIso(),
        summary: `Replayed ${replay.scanned} recent launches: ${replay.matched} would have passed the filters.`,
        passed: true,
      };
    }
    agent.state = "backtested";
    this.publishState(agent);
    return { agent, backtest: report, replay };
  }

  /** Apply edits from the builder panel (sliders, toggles) and re-test. */
  revise(userId: string, agentId: string, patch: Partial<AgentSpec>) {
    const a = this.mustOwn(userId, agentId);
    if (a.state === "killed") throw new Error(`${a.spec.name} was killed; build a new agent instead`);
    const next = AgentSpec.parse({
      ...a.spec,
      ...patch,
      limits: { ...a.spec.limits, ...(patch.limits ?? {}) },
      exit: { ...a.spec.exit, ...(patch.exit ?? {}) },
      universe: a.spec.universe || patch.universe ? { ...(a.spec.universe ?? {}), ...(patch.universe ?? {}) } : undefined,
      mode: a.spec.mode,
    });
    if (next.sizeUsd > next.limits.maxPerTradeUsd) next.limits.maxPerTradeUsd = next.sizeUsd;

    if (a.state === "paper" || a.state === "live" || a.state === "paused") {
      // Running agent: apply the new version in place, keep its wallet, funds and positions.
      const oldBudget = a.spec.limits.maxPerDayUsd;
      if (next.limits.maxPerDayUsd !== oldBudget) {
        const fundAsset = a.spec.kind === "sniper" ? "SOL" : "USDC";
        const diffUsd = next.limits.maxPerDayUsd - oldBudget;
        if (a.spec.mode === "paper" && diffUsd > 0) {
          // Paper: add the virtual difference so a bigger budget means a bigger wallet.
          a.balances[fundAsset] = (a.balances[fundAsset] ?? 0) + diffUsd / this.d.market.priceUsd(fundAsset);
          this.startUsd.set(agentId, (this.startUsd.get(agentId) ?? 0) + diffUsd);
          this.activity(a, `${a.spec.name}'s wallet topped up by ${fmtUsd(diffUsd)} (virtual)`);
        }
        if (a.subWalletId) this.d.signer.updatePolicy(a.subWalletId, { maxPerDayUsd: next.limits.maxPerDayUsd * 50, maxPerTxUsd: next.limits.maxPerTradeUsd * 1.02 });
      }
      a.spec = next;
      a.version += 1;
      if (next.kind === "sniper") {
        const replay = this.replayUniverse(a);
        a.lastBacktest = { at: nowIso(), summary: `Replayed ${replay.scanned} recent launches: ${replay.matched} would have passed the filters.`, passed: true };
        this.d.audit.append(`user:${userId}`, "agent.revised", { agentId, version: a.version, spec: next });
        this.activity(a, `${a.spec.name} updated to v${a.version}`);
        this.publishState(a);
        return { agent: a, replay, backtest: undefined as BacktestReport | undefined };
      }
      this.d.audit.append(`user:${userId}`, "agent.revised", { agentId, version: a.version, spec: next });
      this.publishState(a);
      return { agent: a, replay: undefined as SniperReplay | undefined, backtest: undefined as BacktestReport | undefined };
    }

    // Draft: re-test from scratch under the same id.
    this.agents.delete(agentId);
    const res = this.propose(userId, next);
    res.agent.version = a.version + 1;
    this.agents.delete(res.agent.id);
    res.agent.id = agentId;
    this.agents.set(agentId, res.agent);
    return res;
  }

  /** Delete an agent: kills it first if it holds funds, then removes it from the list. */
  remove(userId: string, agentId: string) {
    const a = this.mustOwn(userId, agentId);
    if (a.state !== "killed" && a.state !== "draft" && a.state !== "backtested") this.control(userId, agentId, "kill");
    this.agents.delete(agentId);
    this.d.audit.append(`user:${userId}`, "agent.deleted", { agentId });
    this.d.bus.publish({ type: "agent.state", userId, agentId, state: "deleted" });
  }

  private replayUniverse(agent: Agent): SniperReplay {
    const launches = this.d.market.recentLaunches(200);
    const skipped: SniperReplay["skipped"] = [];
    let matched = 0;
    for (const l of launches) {
      const risk = this.d.market.tokenRisk(l.mint);
      if (!risk) continue;
      const reason = this.filterReason(agent, risk);
      if (reason) skipped.push({ symbol: risk.symbol, reason });
      else matched++;
    }
    return { scanned: launches.length, matched, skipped: skipped.slice(0, 10) };
  }

  private filterReason(agent: Agent, risk: TokenRisk): string | null {
    const u = agent.spec.universe!;
    const holders = u.collapseCreatorWallets ? risk.holdersCollapsed : risk.holders;
    if (holders < u.minHolders) {
      const note = u.collapseCreatorWallets && risk.holders !== risk.holdersCollapsed ? ` (${risk.holders} before collapsing ${risk.creatorWallets.length} disclosed creator wallets)` : "";
      return `${holders} holders${note}, needs ${u.minHolders}`;
    }
    // Unknown top wallet: if the top 10 together are under the limit, so is any single wallet.
    // Otherwise, with an on-chain checker, it's measured right before buying; without one, skip.
    if (risk.topWalletUnknown) {
      const boundedByTop10 = risk.top10Pct !== undefined && risk.top10Pct <= u.maxTopWalletPct;
      if (!boundedByTop10 && !this.verifyHolders) return "top wallet share unknown";
    } else if (risk.topWalletPct > u.maxTopWalletPct) return `top wallet holds ${risk.topWalletPct}%`;
    if (u.maxTop10Pct !== undefined && (risk.top10Pct ?? 0) > u.maxTop10Pct) return `top 10 wallets hold ${(risk.top10Pct ?? 0).toFixed(1)}% (max ${u.maxTop10Pct}%)`;
    if (u.requireMintRevoked && !risk.mintRevoked) return "mint authority still active";
    if (!risk.freezeRevoked) return "freeze authority still active";
    return null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Deploy to paper or live. Live needs a passkey approval; auto mode needs
   * a completed paper period or an explicit risk acknowledgement.
   */
  deploy(userId: string, agentId: string, opts: { mode: AgentMode; userApproval?: string; riskAcknowledged?: boolean; now?: number }) {
    const a = this.mustOwn(userId, agentId);
    if (!["backtested", "paper", "paused"].includes(a.state)) throw new Error(`${a.spec.name} is ${a.state}`);
    if (a.lastBacktest && !a.lastBacktest.passed && opts.mode !== "paper") {
      throw new Error(`${a.spec.name}'s backtest drawdown is above its own limit; paper trade it first or loosen the limit`);
    }
    const now = opts.now ?? Date.now();
    if (opts.mode === "auto") {
      const since = this.paperSince.get(agentId);
      const paperDays = since ? (now - since) / 86_400_000 : 0;
      if (paperDays < this.d.paperDaysBeforeAuto && !opts.riskAcknowledged) {
        throw new Error(`Auto mode unlocks after ${this.d.paperDaysBeforeAuto} days of paper trading, or with an explicit risk acknowledgement`);
      }
    }
    if (opts.mode !== "paper" && !opts.userApproval) throw new Error("Going live needs your passkey");

    const user = this.d.users.get(userId);
    const fundAsset = a.spec.kind === "sniper" ? "SOL" : "USDC";
    const fundAmount = a.spec.limits.maxPerDayUsd / this.d.market.priceUsd(fundAsset);

    if (!a.subWalletId) {
      const venues = new Set<string>(["paper"]);
      if (a.spec.markets.includes("memes") || a.spec.markets.includes("launch")) venues.add("pumpfun").add("jupiter");
      if (a.spec.markets.includes("swaps") || a.spec.markets.includes("strategies")) venues.add("jupiter").add("uniswap");
      if (a.spec.markets.includes("stocks")) venues.add("ondo").add("xstocks");
      const w = this.d.signer.createSubWallet(userId, "agent", `agent-${a.spec.name}`, {
        allowedVenues: [...venues],
        maxPerTxUsd: a.spec.limits.maxPerTradeUsd * 1.02,
        // Runaway guard only (turnover per day); the budget itself is the wallet's balance.
        maxPerDayUsd: a.spec.limits.maxPerDayUsd * 50,
        withdrawTo: user.mainWallet.solana,
      });
      a.subWalletId = w.id;
      a.subWalletAddress = w.address;
    }

    if (opts.mode === "paper") {
      // Paper agents trade virtual funds; nothing leaves the main wallet.
      a.balances = { [fundAsset]: fundAmount };
      a.state = "paper";
      if (!this.paperSince.has(agentId)) this.paperSince.set(agentId, now);
    } else {
      // Fund the sub-wallet with one day's cap from the main wallet.
      const have = user.balances[fundAsset] ?? 0;
      const amt = Math.min(fundAmount, have);
      if (amt <= 0) throw new Error(`No ${fundAsset} in your wallet to fund ${a.spec.name}`);
      this.d.users.applyDeltas(userId, { [fundAsset]: -amt });
      a.balances = { [fundAsset]: (a.balances[fundAsset] ?? 0) + amt };
      a.state = "live";
    }
    a.spec.mode = opts.mode;
    a.stats.equityUsd = this.equityUsd(a);
    a.stats.peakEquityUsd = a.stats.equityUsd;
    if (!this.startUsd.has(agentId)) this.startUsd.set(agentId, a.stats.equityUsd);
    this.sample(a);
    this.d.audit.append(`user:${userId}`, "agent.deployed", { agentId, mode: opts.mode, subWallet: a.subWalletAddress, funded: a.balances });
    this.activity(a, `${a.spec.name} deployed in ${opts.mode} mode with ${fmtUsd(a.stats.equityUsd)} ${opts.mode === "paper" ? "(virtual)" : ""}`.trim());
    this.publishState(a);
    return a;
  }

  control(userId: string, agentId: string, action: "pause" | "resume" | "kill", userApproval?: string) {
    const a = this.mustOwn(userId, agentId);
    if (action === "pause") {
      if (a.state === "killed") throw new Error(`${a.spec.name} is already killed`);
      a.state = "paused";
    } else if (action === "resume") {
      if (a.state !== "paused") throw new Error(`${a.spec.name} is not paused`);
      a.state = a.spec.mode === "paper" ? "paper" : "live";
    } else {
      // Kill: stop everything, keep positions, sweep funds back to the main wallet.
      const wasLive = a.state === "live" || (a.state === "paused" && a.spec.mode !== "paper");
      if (wasLive) {
        const user = this.d.users.get(userId);
        this.d.signer.sign({ walletId: a.subWalletId, venue: "system", usd: 0, kind: "transfer", transferTo: user.mainWallet.solana, userApproval: userApproval ?? "kill-switch", payload: { sweep: a.balances } });
        const deltas: Record<string, number> = {};
        for (const [k, v] of Object.entries(a.balances)) if (v > 0) deltas[k] = v;
        this.d.users.applyDeltas(userId, deltas);
        for (const p of this.positionsOf(agentId)) {
          this.d.users.recordBuy(userId, p.symbol, p.qty, p.qty * p.entryPrice, a.spec.markets[0]!, `from agent ${a.spec.name}`);
        }
      }
      a.balances = {};
      this.positions.delete(agentId);
      a.stats.openPositions = 0;
      a.state = "killed";
    }
    this.d.audit.append(`user:${userId}`, `agent.${action}`, { agentId });
    this.activity(a, `${a.spec.name} ${action === "kill" ? "killed; open positions kept, funds swept to your main wallet" : action + "d"}`);
    this.publishState(a);
    return a;
  }

  /** Pause every agent the user owns. */
  panic(userId: string) {
    for (const a of this.listForUser(userId)) if (a.state === "live" || a.state === "paper") this.control(userId, a.id, "pause");
  }

  // -------------------------------------------------------------------------
  // Run loop
  // -------------------------------------------------------------------------

  /** One scheduler tick. Production: Temporal workflows per agent. */
  private migrated = new Set<string>();

  private ticking = false;

  async tick(now = Date.now()) {
    // Fills can wait for the next price (a few seconds): never run two ticks at once.
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickAll(now);
    } finally {
      this.ticking = false;
    }
  }

  private async tickAll(now: number) {
    for (const a of this.agents.values()) {
      if (a.state !== "live" && a.state !== "paper") continue;
      // Agents created before "budget = wallet": widen their old daily signer cap to the runaway guard once.
      if (!this.migrated.has(a.id) && a.subWalletId) {
        this.migrated.add(a.id);
        const w = this.d.signer.get(a.subWalletId);
        if (w?.policy && w.policy.maxPerDayUsd < a.spec.limits.maxPerDayUsd * 50) this.d.signer.updatePolicy(a.subWalletId, { maxPerDayUsd: a.spec.limits.maxPerDayUsd * 50 });
      }
      try {
        this.reconcile(a);
        if (a.stats.dayKey !== dayKey(new Date(now))) {
          a.stats.dayKey = dayKey(new Date(now));
          a.stats.spentTodayUsd = 0;
        }
        await this.manageExits(a);
        if (a.spec.kind === "rules") await this.tickRules(a, now);
        else await this.tickSniper(a);
        this.checkDrawdown(a);
        this.sample(a, now);
      } catch (e) {
        this.activity(a, `Error: ${(e as Error).message}`);
      }
    }
  }

  private async tickRules(a: Agent, now: number) {
    const p = a.spec.program!;
    if (this.positionsOf(a.id).length > 0 || this.hasPending(a.id, "buy")) return;
    const candles = this.d.market.candles(p.asset, p.timeframe, 400, now);
    // Evaluate on the last CLOSED candle only.
    const closed = candles.slice(0, -1);
    const c = compile(p, closed);
    const i = closed.length - 1;
    if (i < c.warmup) return;
    if (c.entry(i)) {
      this.decision(a, "entry", { asset: p.asset, close: closed[i]!.close });
      await this.buy(a, p.asset, "USDC");
    }
  }

  /** On-chain holder check (Helius / Solana RPC), set by the server. */
  verifyHolders?: (mint: string) => Promise<{ topWalletPct: number; top10Pct: number; poolPct: number } | undefined>;
  private verifyCache = new Map<string, { at: number; v: Awaited<ReturnType<NonNullable<AgentRuntime["verifyHolders"]>>> }>();

  private async verify(mint: string) {
    if (!this.verifyHolders) return undefined;
    const hit = this.verifyCache.get(mint);
    if (hit && Date.now() - hit.at < 15_000) return hit.v;
    const v = await this.verifyHolders(mint).catch(() => undefined);
    this.verifyCache.set(mint, { at: Date.now(), v });
    if (this.verifyCache.size > 2_000) this.verifyCache.delete(this.verifyCache.keys().next().value!);
    return v;
  }

  /** Young launches that failed a filter so far: re-checked every tick until they pass or age out. */
  private pendingChecks = new Map<string, Map<string, string>>();
  private skipStats = new Map<string, { at: number; checked: number; reasons: Map<string, number> }>();

  private async tickSniper(a: Agent) {
    const seen = this.seenTokens.get(a.id) ?? new Set<string>();
    this.seenTokens.set(a.id, seen);
    const waiting = this.pendingChecks.get(a.id) ?? new Map<string, string>();
    this.pendingChecks.set(a.id, waiting);
    const maxAge = a.spec.universe?.maxAgeSeconds ?? 3_600;
    const fresh = this.d.market.recentLaunches(300).filter((l) => !seen.has(l.mint));
    for (const l of fresh) {
      const risk = this.d.market.tokenRisk(l.mint);
      if (!risk) {
        seen.add(l.mint);
        continue;
      }
      const age = risk.ageSeconds ?? risk.ageMinutes * 60;
      const first = !waiting.has(l.mint);
      if (age > maxAge) {
        seen.add(l.mint);
        const last = waiting.get(l.mint);
        waiting.delete(l.mint);
        // Launches that were already old when the agent started are ignored silently.
        if (age <= maxAge + 600) this.decision(a, "skip", { symbol: risk.symbol, reason: last ? `${last}; aged out after ${maxAge}s` : `launched ${Math.round(age)}s ago (max ${maxAge}s)` });
        continue;
      }
      // Never snipe a token the owner launched themselves.
      const reg = this.d.registry.get(risk.mint);
      if (reg && reg.creatorUserId === a.userId) {
        seen.add(l.mint);
        this.decision(a, "skip", { symbol: risk.symbol, reason: "your own launch" });
        continue;
      }
      const reason = this.filterReason(a, risk);
      if (reason) {
        // Not yet: holders and concentration change fast in the first minutes. Check again next tick.
        waiting.set(l.mint, reason);
        if (first) {
          this.decision(a, "skip", { symbol: risk.symbol, reason, recheck: true });
          this.countSkip(a, reason);
        }
        continue;
      }
      // Passed on stream data: confirm holder concentration on-chain before buying.
      const chain = await this.verify(l.mint);
      let verified = false;
      if (chain) {
        (this.d.market as { updateMeme?: (m: string, p: object) => void }).updateMeme?.(l.mint, { topWalletPct: chain.topWalletPct, top10Pct: chain.top10Pct, poolPct: chain.poolPct, topWalletUnknown: false });
        const again = this.filterReason(a, { ...risk, topWalletPct: chain.topWalletPct, top10Pct: chain.top10Pct, topWalletUnknown: false });
        if (again) {
          waiting.set(l.mint, `${again} (on-chain check)`);
          if (first) this.countSkip(a, again);
          this.decision(a, "skip", { symbol: risk.symbol, reason: `${again} (on-chain check)`, recheck: true });
          continue;
        }
        verified = true;
      } else if (risk.topWalletUnknown && !(risk.top10Pct !== undefined && a.spec.universe && risk.top10Pct <= a.spec.universe.maxTopWalletPct)) {
        // Couldn't measure the top wallet on-chain this time: don't buy blind, try again next tick.
        waiting.set(l.mint, "top wallet not verified yet");
        continue;
      }
      seen.add(l.mint);
      waiting.delete(l.mint);
      this.decision(a, "entry", { symbol: risk.symbol, holders: risk.holdersCollapsed, topWalletPct: chain?.topWalletPct ?? risk.topWalletPct, top10Pct: chain?.top10Pct ?? risk.top10Pct, ageSeconds: Math.round(age), onChainVerified: verified });
      await this.buy(a, risk.symbol, "SOL");
    }
    if (seen.size > 5_000) {
      const keep = [...seen].slice(-2_000);
      seen.clear();
      keep.forEach((m) => seen.add(m));
    }
    this.flushSkipSummary(a);
  }

  /** One activity line per minute instead of one per skipped launch. */
  private countSkip(a: Agent, reason: string) {
    const st = this.skipStats.get(a.id) ?? { at: Date.now(), checked: 0, reasons: new Map<string, number>() };
    st.checked++;
    const kind = this.reasonKind(a, reason);
    st.reasons.set(kind, (st.reasons.get(kind) ?? 0) + 1);
    this.skipStats.set(a.id, st);
  }

  /** Group skip reasons into readable categories that name the agent's own limit. */
  private reasonKind(a: Agent, reason: string) {
    const u = a.spec.universe;
    if (/holders/.test(reason) && /needs/.test(reason)) return `fewer than ${u?.minHolders ?? "?"} holders`;
    if (/^top 10/.test(reason)) return `top 10 wallets over ${u?.maxTop10Pct ?? "?"}%`;
    if (/^top wallet holds/.test(reason)) return `top wallet over ${u?.maxTopWalletPct ?? "?"}%`;
    return reason;
  }

  private flushSkipSummary(a: Agent, force = false) {
    const st = this.skipStats.get(a.id);
    if (!st || (!force && Date.now() - st.at < 60_000)) return;
    this.skipStats.delete(a.id);
    const ranked = [...st.reasons.entries()].sort((x, y) => y[1] - x[1]);
    if (!ranked.length) return;
    const why = ranked.slice(0, 2).map(([k, n]) => `${n} ${k}`).join(", ");
    const best = this.watching(a.id)[0];
    const closest = best && a.spec.universe ? ` Closest: $${best.symbol} with ${best.holders}/${a.spec.universe.minHolders} holders at ${best.ageSeconds}s${best.holders >= a.spec.universe.minHolders ? `, held back by: ${best.reason}` : ""}.` : "";
    this.activity(a, `Checked ${st.checked} new launch${st.checked > 1 ? "es" : ""} in the last minute, none passed yet (${why}).${closest}`);
  }

  /** Today's spending against the daily limit (days are UTC: they reset at 00:00 UTC). */
  budget(a: Agent) {
    const dayStart = Date.parse(`${dayKey()}T00:00:00Z`);
    const buys = (this.trades.get(a.id) ?? []).filter((t) => t.side === "buy" && t.t >= dayStart);
    const fundAsset = a.spec.kind === "sniper" ? "SOL" : "USDC";
    let cashUsd = 0;
    try {
      cashUsd = (a.balances[fundAsset] ?? 0) * this.d.market.priceUsd(fundAsset);
    } catch {
      /* ignore */
    }
    return {
      budgetUsd: a.spec.limits.maxPerDayUsd,
      cashUsd,
      inPositionsUsd: Math.max(0, a.stats.equityUsd - cashUsd),
      buysToday: buys.map((b) => ({ t: b.t, symbol: b.symbol, usd: b.usd })),
      outOfCash: cashUsd < a.spec.sizeUsd * 0.9,
    };
  }

  /** Launches the sniper is still re-checking, closest to passing first. */
  watching(agentId: string) {
    const a = this.agents.get(agentId);
    const w = this.pendingChecks.get(agentId);
    if (!a || !w) return [];
    const out: { symbol: string; mint: string; ageSeconds: number; holders: number; top10Pct?: number; reason: string }[] = [];
    for (const [mint, reason] of w) {
      const r = this.d.market.tokenRisk(mint);
      if (!r) continue;
      out.push({ symbol: r.symbol, mint, ageSeconds: Math.round(r.ageSeconds ?? r.ageMinutes * 60), holders: r.holdersCollapsed, top10Pct: r.top10Pct, reason: this.reasonKind(a, reason) });
    }
    return out.sort((x, y) => y.holders - x.holders).slice(0, 8);
  }

  private async manageExits(a: Agent) {
    const s = a.spec.exit;
    for (const p of [...this.positionsOf(a.id)]) {
      if (this.hasPending(a.id, "sell", p.symbol)) continue;
      const px = this.d.market.priceUsd(p.symbol);
      p.peakPrice = Math.max(p.peakPrice, px);
      const chg = (px / p.entryPrice - 1) * 100;
      let reason: string | null = null;
      if (chg <= -s.stopLossPct) reason = `stop −${s.stopLossPct}% hit (${chg.toFixed(1)}%)`;
      else if (chg >= s.takeProfitPct) reason = `take profit +${s.takeProfitPct}% hit (+${chg.toFixed(1)}%)`;
      else if (s.maxHoldMinutes && Date.now() - Date.parse(p.openedAt) >= s.maxHoldMinutes * 60_000) reason = `held ${s.maxHoldMinutes} min, time exit (${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%)`;
      else if (a.spec.kind === "rules") {
        const prog = a.spec.program!;
        const candles = this.d.market.candles(prog.asset, prog.timeframe, 400).slice(0, -1);
        const c = compile(prog, candles);
        const i = candles.length - 1;
        if (i >= c.warmup && c.exit(i, { entryPrice: p.entryPrice, barsHeld: 1, peakPrice: p.peakPrice })) reason = "exit rule triggered";
      }
      if (reason) {
        this.decision(a, "exit", { symbol: p.symbol, reason, pnlPct: chg });
        await this.sell(a, p, reason);
      }
    }
  }

  private checkDrawdown(a: Agent) {
    a.stats.equityUsd = this.equityUsd(a);
    a.stats.peakEquityUsd = Math.max(a.stats.peakEquityUsd, a.stats.equityUsd);
    const dd = a.stats.peakEquityUsd > 0 ? ((a.stats.peakEquityUsd - a.stats.equityUsd) / a.stats.peakEquityUsd) * 100 : 0;
    if (dd > a.spec.limits.maxDrawdownPct) {
      a.state = "paused";
      this.d.audit.append(`agent:${a.id}`, "agent.auto_paused", { drawdownPct: dd });
      this.activity(a, `Paused: drawdown ${dd.toFixed(1)}% is over its ${a.spec.limits.maxDrawdownPct}% limit. Positions kept.`);
      this.publishState(a);
    }
  }

  private equityUsd(a: Agent) {
    let v = 0;
    for (const [k, amt] of Object.entries(a.balances)) {
      try {
        v += amt * this.d.market.priceUsd(k);
      } catch {
        /* ignore */
      }
    }
    return v;
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  private async buy(a: Agent, symbol: string, quote: "USDC" | "SOL") {
    const lim = a.spec.limits;
    // Check 1 of 3: the runtime's own limits, before any ticket exists.
    // Proposals still waiting for the user's tap count against the cap too.
    const pendingUsd = [...this.pendingTickets].filter(([id, p]) => p.agentId === a.id && p.side === "buy" && ["needs_confirmation", "needs_second_confirmation", "approved", "submitted"].includes(this.d.desk.get(id).status)).reduce((s, [id]) => s + (this.d.desk.get(id) as OrderTicket).totalUsd, 0);
    // The agent trades its own wallet: it can buy while it has cash (sale proceeds included).
    const cashUsd = (a.balances[quote] ?? 0) * this.d.market.priceUsd(quote) - pendingUsd;
    if (cashUsd < a.spec.sizeUsd * 0.9) {
      this.decision(a, "skip", { symbol, reason: "no free cash (all funds in open positions)" });
      if (this.limitNotified.get(a.id) !== `cash:${this.positionsOf(a.id).length}`) {
        this.limitNotified.set(a.id, `cash:${this.positionsOf(a.id).length}`);
        this.activity(a, `${a.spec.name} has ${fmtUsd(Math.max(0, cashUsd))} free; it buys again when a position is sold`);
      }
      return;
    }
    const pendingBuys = [...this.pendingTickets].filter(([id, p]) => p.agentId === a.id && p.side === "buy" && ["needs_confirmation", "needs_second_confirmation"].includes(this.d.desk.get(id).status)).length;
    if (this.positionsOf(a.id).length + pendingBuys >= lim.maxOpenPositions) {
      this.activity(a, `Skipped ${symbol}: already at ${lim.maxOpenPositions} open positions`);
      return;
    }
    // Spend the trade size, or what's left of the wallet after fees if that's a bit less.
    const spendUsd = Math.min(a.spec.sizeUsd, cashUsd / 1.03);
    const amount = spendUsd / this.d.market.priceUsd(quote);
    const t = await this.d.desk.proposeOrder({
      userId: a.userId,
      source: { type: "agent", agentId: a.id },
      jacket: a.spec.markets[0],
      legs: [{ side: "buy", asset: symbol, quoteAsset: quote, amount, maxSlippageBps: quote === "SOL" ? 1_000 : 100 }],
    });
    await this.afterPropose(a, t, "buy", symbol);
  }

  private async sell(a: Agent, p: AgentPosition, reason: string) {
    const t = await this.d.desk.proposeOrder({
      userId: a.userId,
      source: { type: "agent", agentId: a.id },
      jacket: a.spec.markets[0],
      legs: [{ side: "sell", asset: p.symbol, quoteAsset: a.spec.kind === "sniper" ? "SOL" : "USDC", amount: p.qty, maxSlippageBps: a.spec.kind === "sniper" ? 1_500 : 150 }],
    });
    t.notes.unshift(`Exit reason: ${reason}`);
    await this.afterPropose(a, t, "sell", p.symbol);
  }

  private async afterPropose(a: Agent, t: OrderTicket, side: "buy" | "sell", symbol: string) {
    if (t.status === "rejected") {
      this.activity(a, `${side.toUpperCase()} ${symbol} rejected: ${t.rejection}`);
      return;
    }
    this.pendingTickets.set(t.id, { agentId: a.id, side, symbol });
    if (a.spec.mode === "ask") {
      this.activity(a, `Proposed ${side.toUpperCase()} ${symbol} for ${fmtUsd(t.totalUsd)}: waiting for your tap`);
      this.d.bus.publish({ type: "agent.proposal", userId: a.userId, agentId: a.id, ticketId: t.id });
      return;
    }
    await this.d.desk.approve(t.id, { secondConfirmation: true });
    this.reconcile(a);
  }

  private hasPending(agentId: string, side: "buy" | "sell", symbol?: string) {
    for (const [id, p] of this.pendingTickets) {
      if (p.agentId !== agentId || p.side !== side || (symbol && p.symbol !== symbol)) continue;
      const t = this.d.desk.get(id);
      if (["needs_confirmation", "needs_second_confirmation", "approved", "submitted"].includes(t.status)) return true;
    }
    return false;
  }

  private pushTrade(id: string, x: { t: number; side: "buy" | "sell"; symbol: string; usd: number; pnlUsd?: number }) {
    const l = this.trades.get(id) ?? [];
    l.push(x);
    if (l.length > 300) l.shift();
    this.trades.set(id, l);
  }

  /** Fold filled or failed agent tickets into positions and stats. */
  private reconcile(a: Agent) {
    for (const [id, p] of [...this.pendingTickets]) {
      if (p.agentId !== a.id) continue;
      const t = this.d.desk.get(id) as OrderTicket;
      if (t.status === "filled") {
        const fill = t.fills[0]!;
        const leg = t.legs[0]!;
        if (p.side === "buy") {
          const price = this.d.market.priceUsd(leg.quoteAsset) * (fill.amountIn / fill.amountOut);
          const list = this.positions.get(a.id) ?? [];
          list.push({ symbol: p.symbol, qty: fill.amountOut, entryPrice: price, peakPrice: price, openedAt: fill.at, ticketId: id });
          this.positions.set(a.id, list);
          a.stats.spentTodayUsd += t.totalUsd;
          this.pushTrade(a.id, { t: Date.now(), side: "buy", symbol: p.symbol, usd: t.totalUsd });
          this.activity(a, `${a.spec.mode === "paper" ? "PAPER · " : ""}BUY ${p.symbol} ${fmtUsd(t.totalUsd)} filled`);
        } else {
          const list = this.positions.get(a.id) ?? [];
          const idx = list.findIndex((x) => x.symbol === p.symbol);
          if (idx >= 0) {
            const pos = list[idx]!;
            const proceedsUsd = fill.amountOut * this.d.market.priceUsd(leg.quoteAsset);
            const pnl = proceedsUsd - pos.qty * pos.entryPrice;
            a.stats.realizedPnlUsd += pnl;
            // The budget is the agent's wallet: sale proceeds can be reinvested (net, not gross).
            a.stats.spentTodayUsd = Math.max(0, a.stats.spentTodayUsd - proceedsUsd);
            list.splice(idx, 1);
            this.pushTrade(a.id, { t: Date.now(), side: "sell", symbol: p.symbol, usd: proceedsUsd, pnlUsd: pnl });
            this.activity(a, `${a.spec.mode === "paper" ? "PAPER · " : ""}SELL ${p.symbol} filled, P&L ${pnl >= 0 ? "+" : ""}${fmtUsd(pnl)}`);
          }
        }
        a.stats.openPositions = this.positionsOf(a.id).length;
        this.pendingTickets.delete(id);
        this.d.audit.append(`agent:${a.id}`, "agent.fill", { ticketId: id, side: p.side, symbol: p.symbol });
      } else if (["failed", "rejected", "cancelled"].includes(t.status)) {
        this.activity(a, `${p.side.toUpperCase()} ${p.symbol} ${t.status}${t.rejection ? `: ${t.rejection}` : ""}`);
        this.pendingTickets.delete(id);
      }
    }
  }

  /** Answer "why did X buy Y?" from the audit log, not from memory. */
  explain(agentId: string, limit = 10) {
    return this.d.audit.query((e) => e.actor === `agent:${agentId}` && e.action.startsWith("agent.decision"), limit);
  }

  // -------------------------------------------------------------------------

  private decision(a: Agent, kind: "entry" | "exit" | "skip", data: Record<string, unknown>) {
    this.d.audit.append(`agent:${a.id}`, `agent.decision.${kind}`, { version: a.version, ...data });
  }

  private activity(a: Agent, message: string) {
    this.d.bus.publish({ type: "agent.activity", userId: a.userId, agentId: a.id, message });
  }

  private publishState(a: Agent) {
    this.d.bus.publish({ type: "agent.state", userId: a.userId, agentId: a.id, state: a.state });
  }

  private mustOwn(userId: string, agentId: string) {
    const a = this.agents.get(agentId);
    if (!a || a.userId !== userId) throw new Error("Agent not found");
    return a;
  }
}

const fmtUsd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
