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
  /** Fee bps override for a subscription plan (set by the Pro tier). */
  planFeeBps?: (userId: string) => number | undefined;

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
