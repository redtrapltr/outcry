/**
 * Agent marketplace: creators publish agents, others activate their own copy.
 *
 * - The strategy (filters, rules, exits) stays hidden: subscribers see results
 *   only and can change their own risk settings (size, budget, positions,
 *   drawdown pause), not the recipe.
 * - Fees: on each trade of a copy, Outcry keeps OUTCRY_COPY_BPS and the creator
 *   gets their own per-trade fee. Optional performance fee (share of profit
 *   above the high-water mark), unlock price and monthly subscription.
 * - Guard: a copy never buys tokens launched by the listing's creator.
 *
 * Paper mode moves paper USDC; the same ledger drives live payouts later.
 */
import { newId, nowIso, type AuditLog, type EventBus } from "../core/infra.js";
import type { Agent } from "../core/types.js";
import type { UserStore } from "../core/users.js";
import type { AgentRuntime } from "../agents/runtime.js";
import type { CreatorRegistry } from "../launch/service.js";

export const OUTCRY_COPY_BPS = 40;
export const MAX_CREATOR_FEE_BPS = 200;
/** A listing is ranked once its track record is long enough to mean something. */
export const RANK_MIN_HOURS = 24;
export const RANK_MIN_CLOSED_TRADES = 3;

export type LeaderSort = "score" | "return" | "copied" | "new";

export interface ListingTerms {
  title: string;
  description: string;
  /** Creator's fee per trade, in basis points of the trade (10 = 0.1%). */
  creatorFeeBps: number;
  /** Share of new profits (above the high-water mark), 0-50%. */
  performanceFeePct: number;
  /** One-time price to activate, USD. */
  unlockUsd: number;
  /** Monthly subscription, USD (0 = none). */
  monthlyUsd: number;
}

export interface Listing extends ListingTerms {
  id: string;
  agentId: string;
  creatorUserId: string;
  creatorBadge: string;
  createdAt: string;
  updatedAt: string;
  status: "listed" | "unlisted";
  earnings: { tradeFees: number; performanceFees: number; unlocks: number; subscriptions: number };
}

export interface Subscription {
  id: string;
  listingId: string;
  userId: string;
  agentId: string;
  startedAt: string;
  nextBillingAt?: number;
  highWaterUsd: number;
  status: "active" | "unpaid" | "ended";
}

export interface MarketDeps {
  users: UserStore;
  agents: AgentRuntime;
  registry: CreatorRegistry;
  audit: AuditLog;
  bus: EventBus;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

export class Marketplace {
  readonly listings = new Map<string, Listing>();
  readonly subs = new Map<string, Subscription>();
  private byAgent = new Map<string, string>(); // copy agentId -> subscription id

  constructor(private d: MarketDeps, private rank: { minHours: number; minClosedTrades: number } = { minHours: RANK_MIN_HOURS, minClosedTrades: RANK_MIN_CLOSED_TRADES }) {}

  // --- creators ------------------------------------------------------------

  publish(userId: string, agentId: string, terms: Partial<ListingTerms>): Listing {
    const a = this.d.agents.get(agentId);
    if (!a || a.userId !== userId) throw new Error("Agent not found");
    if ((a as AgentWithCopy).copyOf) throw new Error("You can't publish a copy of someone else's agent");
    if (a.state === "killed") throw new Error("This agent was killed");
    if (a.state === "draft" || a.state === "backtested") throw new Error("Deploy the agent first: listings show its live track record");
    if (!this.d.users.get(userId).handle) throw new Error("Choose your public @handle first (it's shown on your listings)");
    const existing = [...this.listings.values()].find((l) => l.agentId === agentId);
    const t = this.cleanTerms({ title: a.spec.name, description: a.spec.goal, ...(existing ?? {}), ...terms });
    const now = nowIso();
    const l: Listing = existing
      ? Object.assign(existing, t, { status: "listed" as const, updatedAt: now })
      : {
          id: newId("lst"),
          agentId,
          creatorUserId: userId,
          creatorBadge: this.d.users.get(userId).badge,
          createdAt: now,
          updatedAt: now,
          status: "listed",
          earnings: { tradeFees: 0, performanceFees: 0, unlocks: 0, subscriptions: 0 },
          ...t,
        };
    this.listings.set(l.id, l);
    this.d.audit.append(`user:${userId}`, existing ? "market.updated" : "market.published", { listingId: l.id, agentId, terms: t });
    return l;
  }

  unlist(userId: string, listingId: string) {
    const l = this.mine(userId, listingId);
    l.status = "unlisted";
    l.updatedAt = nowIso();
    return l;
  }

  private cleanTerms(t: Partial<ListingTerms>): ListingTerms {
    return {
      title: String(t.title ?? "Agent").trim().toUpperCase().slice(0, 18) || "AGENT",
      description: String(t.description ?? "").trim().slice(0, 280),
      creatorFeeBps: Math.round(clamp(Number(t.creatorFeeBps ?? 10), 0, MAX_CREATOR_FEE_BPS)),
      performanceFeePct: clamp(Number(t.performanceFeePct ?? 0), 0, 50),
      unlockUsd: clamp(Number(t.unlockUsd ?? 0), 0, 100_000),
      monthlyUsd: clamp(Number(t.monthlyUsd ?? 0), 0, 100_000),
    };
  }

  private mine(userId: string, listingId: string) {
    const l = this.listings.get(listingId);
    if (!l || l.creatorUserId !== userId) throw new Error("Listing not found");
    return l;
  }

  listingFor(agentId: string) {
    return [...this.listings.values()].find((l) => l.agentId === agentId);
  }

  /** Public view: results only, never the strategy. */
  publicView(l: Listing) {
    const perf = this.d.agents.perf(l.agentId);
    const a = this.d.agents.get(l.agentId);
    const h = perf?.history ?? [];
    const step = Math.max(1, Math.ceil(h.length / 60));
    return {
      id: l.id,
      title: l.title,
      description: l.description,
      creator: this.d.users.get(l.creatorUserId)?.handle ? `@${this.d.users.get(l.creatorUserId).handle}` : l.creatorBadge,
      version: a?.version ?? 1,
      kind: a?.spec.kind ?? "sniper",
      mode: a?.spec.mode ?? "paper",
      status: l.status,
      returnPct: perf?.pnlPct ?? 0,
      drawdownPct: perf?.drawdownPct ?? 0,
      closedTrades: perf?.closedTrades ?? 0,
      wins: perf?.wins ?? 0,
      runningSince: h[0] ? new Date(h[0].t).toISOString() : l.createdAt,
      subscribers: [...this.subs.values()].filter((s) => s.listingId === l.id && s.status === "active").length,
      spark: h.filter((_, i) => i % step === 0 || i === h.length - 1).map((p) => p.v),
      startUsd: perf?.startUsd ?? 0,
      fees: {
        perTradePct: (OUTCRY_COPY_BPS + l.creatorFeeBps) / 100,
        outcryPct: OUTCRY_COPY_BPS / 100,
        creatorPct: l.creatorFeeBps / 100,
        performanceFeePct: l.performanceFeePct,
        unlockUsd: l.unlockUsd,
        monthlyUsd: l.monthlyUsd,
      },
    };
  }

  list() {
    return [...this.listings.values()].filter((l) => l.status === "listed").map((l) => this.publicView(l)).sort((a, b) => b.returnPct - a.returnPct);
  }

  /**
   * Leaderboard view of a listing. Score = return per unit of risk: the return
   * divided by the worst drawdown (counted as at least 5%), so a steady +20%
   * outranks a +25% that went through a -60% hole.
   */
  private ranked(l: Listing) {
    const v = this.publicView(l);
    const hours = (Date.now() - Date.parse(v.runningSince)) / 3_600_000;
    const qualified = hours >= this.rank.minHours && v.closedTrades >= this.rank.minClosedTrades;
    const score = v.returnPct / Math.max(5, v.drawdownPct);
    const winRatePct = v.closedTrades ? (v.wins / v.closedTrades) * 100 : null;
    return { ...v, creatorHandle: this.d.users.get(l.creatorUserId)?.handle ?? null, runningHours: Math.round(hours * 10) / 10, qualified, score: Math.round(score * 100) / 100, winRatePct };
  }

  /**
   * Ranked listings plus "rising" ones that don't have a long enough record yet.
   * Unranked agents are never mixed into the ranking, so a lucky 10-minute run
   * can't top the board.
   */
  leaderboard(sort: LeaderSort = "score", limit = 50) {
    const all = [...this.listings.values()].filter((l) => l.status === "listed").map((l) => this.ranked(l));
    const by: Record<LeaderSort, (a: ReturnType<Marketplace["ranked"]>, b: ReturnType<Marketplace["ranked"]>) => number> = {
      score: (a, b) => b.score - a.score || b.returnPct - a.returnPct,
      return: (a, b) => b.returnPct - a.returnPct,
      copied: (a, b) => b.subscribers - a.subscribers || b.score - a.score,
      new: (a, b) => Date.parse(b.runningSince) - Date.parse(a.runningSince),
    };
    const cmp = by[sort] ?? by.score;
    const ranked = all.filter((x) => x.qualified).sort(cmp).slice(0, limit).map((x, i) => ({ ...x, rank: i + 1 }));
    const rising = all.filter((x) => !x.qualified).sort(sort === "new" ? by.new : by.return).slice(0, limit);
    return { sort, rules: { minHours: this.rank.minHours, minClosedTrades: this.rank.minClosedTrades }, ranked, rising };
  }

  /** Public creator page: who they are and how their listed agents do. Earnings stay private. */
  creatorProfile(handle: string) {
    const u = this.d.users.byHandle(handle);
    if (!u?.handle) return undefined;
    const mine = [...this.listings.values()].filter((l) => l.creatorUserId === u.id);
    const listed = mine.filter((l) => l.status === "listed").map((l) => this.ranked(l)).sort((a, b) => b.score - a.score);
    const board = this.leaderboard("score", 1_000).ranked;
    const ranks = new Map(board.map((x) => [x.id, x.rank]));
    const closed = listed.reduce((s, x) => s + x.closedTrades, 0);
    const wins = listed.reduce((s, x) => s + x.wins, 0);
    const since = mine.map((l) => l.createdAt).sort()[0];
    return {
      handle: u.handle,
      badge: u.badge,
      bio: u.bio ?? "",
      creatorSince: since ?? null,
      stats: {
        listed: listed.length,
        subscribers: listed.reduce((s, x) => s + x.subscribers, 0),
        bestReturnPct: listed.length ? Math.max(...listed.map((x) => x.returnPct)) : null,
        bestRank: listed.reduce<number | null>((b, x) => (ranks.has(x.id) && (b === null || ranks.get(x.id)! < b) ? ranks.get(x.id)! : b), null),
        closedTrades: closed,
        winRatePct: closed ? Math.round((wins / closed) * 1000) / 10 : null,
      },
      agents: listed.map((x) => ({ ...x, rank: ranks.get(x.id) ?? null })),
    };
  }

  // --- subscribers -----------------------------------------------------------

  activate(userId: string, listingId: string, opts: { budgetUsd: number; sizeUsd?: number; name?: string }) {
    const l = this.listings.get(listingId);
    if (!l || l.status !== "listed") throw new Error("This agent isn't listed anymore");
    if (l.creatorUserId === userId) throw new Error("This is your own agent");
    const src = this.d.agents.get(l.agentId);
    if (!src) throw new Error("The creator's agent no longer exists");
    const budget = clamp(Number(opts.budgetUsd), 5, 1_000_000);
    const size = clamp(Number(opts.sizeUsd ?? Math.min(src.spec.sizeUsd, budget)), 1, budget);
    const upfront = l.unlockUsd + l.monthlyUsd;
    const user = this.d.users.get(userId);
    if ((user.balances.USDC ?? 0) + 1e-9 < upfront) throw new Error(`Activation costs $${upfront.toFixed(2)} (unlock + first month); you have ${(user.balances.USDC ?? 0).toFixed(2)} USDC`);
    if (upfront > 0) {
      this.pay(userId, l.creatorUserId, upfront);
      l.earnings.unlocks += l.unlockUsd;
      l.earnings.subscriptions += l.monthlyUsd;
    }
    // The copy runs the creator's exact strategy with the subscriber's own risk settings.
    const taken = new Set(this.d.agents.listForUser(userId).filter((x) => x.state !== "killed").map((x) => x.spec.name));
    let name = String(opts.name ?? l.title).toUpperCase().slice(0, 18);
    for (let i = 2; taken.has(name); i++) name = `${l.title.slice(0, 15)} ${i}`;
    const { agent } = this.d.agents.propose(userId, {
      ...src.spec,
      name,
      sizeUsd: size,
      limits: { ...src.spec.limits, maxPerTradeUsd: size, maxPerDayUsd: budget },
      mode: "paper",
    });
    (agent as AgentWithCopy).copyOf = { listingId: l.id, creatorUserId: l.creatorUserId, version: src.version };
    this.d.agents.deploy(userId, agent.id, { mode: "paper" });
    const sub: Subscription = {
      id: newId("sub"),
      listingId: l.id,
      userId,
      agentId: agent.id,
      startedAt: nowIso(),
      nextBillingAt: l.monthlyUsd > 0 ? Date.now() + 30 * 86_400_000 : undefined,
      highWaterUsd: budget,
      status: "active",
    };
    this.subs.set(sub.id, sub);
    this.byAgent.set(agent.id, sub.id);
    this.d.audit.append(`user:${userId}`, "market.activated", { listingId: l.id, agentId: agent.id, budget, size, paidUsd: upfront });
    this.notifyCreator(l, `Someone activated ${l.title}${upfront > 0 ? `: +$${upfront.toFixed(2)}` : ""}`);
    return { agent: this.d.agents.get(agent.id)!, subscription: sub };
  }

  // --- hooks used by the desk and the runtime ---------------------------------

  private subFor(agentId: string) {
    let id = this.byAgent.get(agentId);
    if (!id) {
      const s = [...this.subs.values()].find((x) => x.agentId === agentId);
      if (s) this.byAgent.set(agentId, (id = s.id));
    }
    return id ? this.subs.get(id) : undefined;
  }

  /** Fee for a trade by this agent, in bps (undefined = the normal Outcry fee). */
  feeBpsFor(agentId: string): number | undefined {
    const s = this.subFor(agentId);
    const l = s && this.listings.get(s.listingId);
    return l ? OUTCRY_COPY_BPS + l.creatorFeeBps : undefined;
  }

  /** Split the platform fee of a filled copy trade: the creator's part is paid out. */
  onTradeFee(agentId: string, platformFeeUsd: number) {
    const s = this.subFor(agentId);
    const l = s && this.listings.get(s.listingId);
    if (!l || platformFeeUsd <= 0 || l.creatorFeeBps <= 0) return;
    const share = (platformFeeUsd * l.creatorFeeBps) / (OUTCRY_COPY_BPS + l.creatorFeeBps);
    this.d.users.applyDeltas(l.creatorUserId, { USDC: share });
    l.earnings.tradeFees += share;
  }

  /** Performance fee on new profits above the high-water mark (called after each sell). */
  chargePerformance(agent: Agent, equityUsd: number, takeFromAgent: (usd: number) => number) {
    const s = this.subFor(agent.id);
    const l = s && this.listings.get(s.listingId);
    if (!s || !l || l.performanceFeePct <= 0) return;
    if (equityUsd <= s.highWaterUsd + 0.01) return;
    const fee = ((equityUsd - s.highWaterUsd) * l.performanceFeePct) / 100;
    const taken = takeFromAgent(fee);
    if (taken <= 0) return;
    this.d.users.applyDeltas(l.creatorUserId, { USDC: taken });
    l.earnings.performanceFees += taken;
    s.highWaterUsd = equityUsd - taken;
    this.d.audit.append(`agent:${agent.id}`, "market.performance_fee", { listingId: l.id, feeUsd: taken, highWaterUsd: s.highWaterUsd });
  }

  /** Copies never buy tokens launched by the listing's creator. */
  blockedToken(agentId: string, mint: string): string | undefined {
    const s = this.subFor(agentId);
    const l = s && this.listings.get(s.listingId);
    if (!l) return undefined;
    const reg = this.d.registry.get(mint);
    return reg && reg.creatorUserId === l.creatorUserId ? "launched by this agent's creator" : undefined;
  }

  /** For a copy: is a newer version of the creator's strategy available? */
  updateFor(agentId: string): { available: boolean; version: number; current: number } | undefined {
    const copy = this.d.agents.get(agentId) as AgentWithCopy | undefined;
    const s = this.subFor(agentId);
    const l = s && this.listings.get(s.listingId);
    const src = l && this.d.agents.get(l.agentId);
    if (!copy?.copyOf || !src) return undefined;
    return { available: src.version > copy.copyOf.version, version: src.version, current: copy.copyOf.version };
  }

  /** The subscriber accepts the creator's latest strategy; their own risk settings stay. */
  applyUpdate(userId: string, agentId: string) {
    const copy = this.d.agents.get(agentId) as AgentWithCopy | undefined;
    if (!copy || copy.userId !== userId || !copy.copyOf) throw new Error("Agent not found");
    const l = this.listings.get(copy.copyOf.listingId);
    const src = l && this.d.agents.get(l.agentId);
    if (!l || !src) throw new Error("The creator's agent no longer exists");
    if (src.version <= copy.copyOf.version) return copy;
    // Strategy fields come from the creator; risk fields stay the subscriber's.
    copy.spec = { ...copy.spec, kind: src.spec.kind, markets: src.spec.markets, universe: src.spec.universe, program: src.spec.program, exit: src.spec.exit, goal: src.spec.goal };
    copy.copyOf.version = src.version;
    copy.version += 1;
    this.d.audit.append(`user:${userId}`, "market.copy_updated", { agentId, listingId: l.id, version: src.version });
    this.d.bus.publish({ type: "agent.activity", userId, agentId, message: `${copy.spec.name} now runs the creator's v${src.version}` });
    return copy;
  }

  /** Called when a creator edits a listed agent: tell every subscriber. */
  onSourceUpdated(agentId: string) {
    const l = this.listingFor(agentId);
    const src = this.d.agents.get(agentId);
    if (!l || !src) return;
    for (const s of this.subs.values()) {
      if (s.listingId !== l.id || s.status === "ended") continue;
      this.d.bus.publish({ type: "agent.activity", userId: s.userId, agentId: s.agentId, message: `The creator of ${l.title} published v${src.version}. Update your copy from the agent list when you're ready.` });
    }
  }

  /** Is this agent a marketplace copy? Its strategy is hidden from its owner. */
  isCopy(agentId: string) {
    return !!this.subFor(agentId);
  }

  /** Monthly billing; unpaid subscriptions pause the copy. */
  bill(now = Date.now()) {
    for (const s of this.subs.values()) {
      if (s.status !== "active" || !s.nextBillingAt || s.nextBillingAt > now) continue;
      const l = this.listings.get(s.listingId);
      if (!l) continue;
      const bal = this.d.users.get(s.userId).balances.USDC ?? 0;
      if (bal + 1e-9 < l.monthlyUsd) {
        s.status = "unpaid";
        try {
          this.d.agents.control(s.userId, s.agentId, "pause");
        } catch {
          /* already paused */
        }
        continue;
      }
      this.pay(s.userId, l.creatorUserId, l.monthlyUsd);
      l.earnings.subscriptions += l.monthlyUsd;
      s.nextBillingAt += 30 * 86_400_000;
    }
  }

  private pay(from: string, to: string, usd: number) {
    this.d.users.applyDeltas(from, { USDC: -usd });
    this.d.users.applyDeltas(to, { USDC: usd });
  }

  private notifyCreator(l: Listing, message: string) {
    this.d.bus.publish({ type: "agent.activity", userId: l.creatorUserId, agentId: l.agentId, message });
  }

  mineFor(userId: string) {
    return [...this.listings.values()].filter((l) => l.creatorUserId === userId).map((l) => ({ ...this.publicView(l), earnings: l.earnings, terms: { creatorFeeBps: l.creatorFeeBps, performanceFeePct: l.performanceFeePct, unlockUsd: l.unlockUsd, monthlyUsd: l.monthlyUsd } }));
  }
}

export type AgentWithCopy = Agent & { copyOf?: { listingId: string; creatorUserId: string; version: number } };

/** What a copy's owner may see: the creator's filters, rules and exits are removed. */
export function redactAgent<T extends Agent>(a: T): T {
  const c = (a as AgentWithCopy).copyOf;
  if (!c) return a;
  const spec = { ...a.spec, universe: undefined, program: undefined, goal: "", exit: { stopLossPct: 0, takeProfitPct: 0 } };
  return { ...a, spec, hiddenStrategy: true, lastBacktest: undefined } as T;
}
