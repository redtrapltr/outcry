/**
 * Growth mechanics for real-money trading:
 *  - Volume tiers: the more you trade in 30 days, the lower your effective fee.
 *    Jupiter's referral fee can't go below 0.5%, so every trade pays 0.5% and the
 *    difference to your tier is credited back as a rebate.
 *  - Referrals: whoever brought you in earns a share of Outcry's fee on your real trades.
 *  - Live-access waitlist: users request real-money access; admins approve.
 */
import { nowIso } from "../core/infra.js";

export interface Tier {
  name: string;
  minVolumeUsd: number;
  feeBps: number;
}

export const BASE_FEE_BPS = 50;
export const TIERS: Tier[] = [
  { name: "Floor", minVolumeUsd: 0, feeBps: 50 },
  { name: "Pit", minVolumeUsd: 10_000, feeBps: 40 },
  { name: "Whale", minVolumeUsd: 100_000, feeBps: 30 },
];
/** Share of Outcry's fee paid to the referrer (of the fee net of the user's rebate). */
export const REFERRAL_SHARE = 0.2;
const DAY = 86_400_000;

export type PlanId = "free" | "pro" | "sniper";
export interface Plan {
  id: PlanId;
  name: string;
  /** USD per month (annual: 2 months free). */
  priceUsd: number;
  /** Effective Outcry fee (rebated down from the 0.5% charged on-chain). */
  feeBps: number;
  /** How many agents can trade real money at once. */
  realAgents: number;
  perks: string[];
}

export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", name: "Floor", priceUsd: 0, feeBps: 50, realAgents: 2, perks: ["Paper trading, unlimited", "Real trading at 0.5%", "2 real-money agents", "Volume tiers and referrals"] },
  pro: { id: "pro", name: "Pro", priceUsd: 49, feeBps: 35, realAgents: 10, perks: ["Fee 0.35% (rebated)", "10 real-money agents", "Telegram alerts", "Stock spread alerts (soon)", "Priority execution (soon)"] },
  sniper: { id: "sniper", name: "Sniper", priceUsd: 199, feeBps: 25, realAgents: 25, perks: ["Fee 0.25% (rebated)", "25 real-money agents", "Everything in Pro", "Sub-second launch detection (soon)", "Jito bundles for snipes (soon)", "Real pump.fun launches with disclosed multi-wallet buys (soon)"] },
};

export interface Subscription {
  plan: PlanId;
  until: number;
  payments: { at: string; usd: number; months: number; signature?: string }[];
}

export interface AccessRequest {
  userId: string;
  handle?: string;
  note: string;
  at: string;
  status: "pending" | "approved" | "denied";
  decidedAt?: string;
  decidedBy?: string;
}

export class Growth {
  /** userId -> trades (time, USD notional), last 30 days are what count. */
  readonly volume = new Map<string, { t: number; usd: number }[]>();
  /** USD owed back to the user (tier rebates) and to referrers (referral rewards). */
  readonly rebates = new Map<string, number>();
  readonly referralRewards = new Map<string, number>();
  /** userId -> referrer userId. */
  readonly referredBy = new Map<string, string>();
  readonly access = new Map<string, AccessRequest>();
  /** Paid plans (Pro / Sniper). */
  readonly subs = new Map<string, Subscription>();
  /** The user's active plan (free when none or expired). */
  planOf(userId: string, now = Date.now()): Plan {
    const s = this.subs.get(userId);
    return s && s.until > now ? PLANS[s.plan] : PLANS.free;
  }

  planFeeBps(userId: string) {
    const p = this.planOf(userId);
    return p.id === "free" ? undefined : p.feeBps;
  }

  /** Price for a plan: annual = 10 months. */
  static priceFor(plan: PlanId, months: 1 | 12) {
    return PLANS[plan].priceUsd * (months === 12 ? 10 : 1);
  }

  /** Activate (or extend) a plan after a confirmed payment. Upgrading replaces the plan from now. */
  activate(userId: string, plan: PlanId, months: 1 | 12, usd: number, signature?: string, now = Date.now()) {
    if (plan === "free") throw new Error("Nothing to pay for the free plan");
    const cur = this.subs.get(userId);
    const base = cur && cur.plan === plan && cur.until > now ? cur.until : now;
    const s: Subscription = { plan, until: base + months * 30 * DAY, payments: [...(cur?.payments ?? []), { at: nowIso(), usd, months, signature }] };
    this.subs.set(userId, s);
    return s;
  }

  volume30d(userId: string, now = Date.now()) {
    const l = this.volume.get(userId) ?? [];
    const cut = now - 30 * DAY;
    if (l.length && l[0]!.t < cut) this.volume.set(userId, l.filter((x) => x.t >= cut));
    return (this.volume.get(userId) ?? []).reduce((s, x) => s + x.usd, 0);
  }

  tierFor(userId: string, now = Date.now()) {
    const v = this.volume30d(userId, now);
    const tier = [...TIERS].reverse().find((t) => v >= t.minVolumeUsd) ?? TIERS[0]!;
    const plan = this.planFeeBps?.(userId);
    const feeBps = plan !== undefined ? Math.min(plan, tier.feeBps) : tier.feeBps;
    const next = TIERS.find((t) => t.minVolumeUsd > v);
    return {
      name: tier.name,
      feeBps,
      volume30dUsd: v,
      next: next ? { name: next.name, feeBps: next.feeBps, remainingUsd: next.minVolumeUsd - v } : null,
      rebateOwedUsd: this.rebates.get(userId) ?? 0,
      planApplied: plan !== undefined && plan < tier.feeBps,
    };
  }

  /**
   * Record a filled real trade. `chargedBps` is what was actually charged on-chain
   * (0 when the referral fee wasn't applied).
   */
  recordTrade(userId: string, usd: number, chargedBps: number, now = Date.now()) {
    if (!(usd > 0)) return { rebateUsd: 0, referralUsd: 0 };
    const tier = this.tierFor(userId, now);
    const l = this.volume.get(userId) ?? [];
    l.push({ t: now, usd });
    this.volume.set(userId, l);
    let rebateUsd = 0, referralUsd = 0;
    if (chargedBps > 0) {
      rebateUsd = (usd * Math.max(0, chargedBps - tier.feeBps)) / 10_000;
      if (rebateUsd > 0) this.rebates.set(userId, (this.rebates.get(userId) ?? 0) + rebateUsd);
      const ref = this.referredBy.get(userId);
      if (ref) {
        // Jupiter keeps 20% of the referral fee; the referrer gets a share of what Outcry keeps after the rebate.
        const outcryNet = (usd * chargedBps) / 10_000 * 0.8 - rebateUsd;
        referralUsd = Math.max(0, outcryNet * REFERRAL_SHARE);
        if (referralUsd > 0) this.referralRewards.set(ref, (this.referralRewards.get(ref) ?? 0) + referralUsd);
      }
    }
    return { rebateUsd, referralUsd };
  }

  /** A new user arrived through `referrerId`'s link (once; no self-referral). */
  setReferrer(userId: string, referrerId: string) {
    if (userId === referrerId || this.referredBy.has(userId)) return false;
    this.referredBy.set(userId, referrerId);
    return true;
  }

  referralStats(userId: string) {
    let invited = 0;
    for (const r of this.referredBy.values()) if (r === userId) invited++;
    return { invited, rewardsUsd: this.referralRewards.get(userId) ?? 0, sharePct: REFERRAL_SHARE * 100 };
  }

  // --- live access -----------------------------------------------------------
  requestAccess(userId: string, handle: string | undefined, note: string) {
    const prev = this.access.get(userId);
    if (prev?.status === "approved") return prev;
    const r: AccessRequest = { userId, handle, note: note.slice(0, 280), at: nowIso(), status: "pending" };
    this.access.set(userId, r);
    return r;
  }

  decide(userId: string, approve: boolean, by: string) {
    const r = this.access.get(userId);
    if (!r) throw new Error("No request from this user");
    r.status = approve ? "approved" : "denied";
    r.decidedAt = nowIso();
    r.decidedBy = by;
    return r;
  }

  isApproved(userId: string) {
    return this.access.get(userId)?.status === "approved";
  }

  pending() {
    return [...this.access.values()].filter((r) => r.status === "pending").sort((a, b) => a.at.localeCompare(b.at));
  }
}
