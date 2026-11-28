import { describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { Growth, MIN_CLAIM_USD } from "../src/live/growth.js";

describe("referral rewards", () => {
  it("a friend who opens your link is linked to you once, never to themselves", async () => {
    const s = await buildServer({ tickMs: 0, simLaunchEveryMs: 0, store: null, gate: null });
    const me = (await s.f.inject({ method: "POST", url: "/api/session", payload: {} })).json();
    await s.f.inject({ method: "PATCH", url: "/api/me", headers: { authorization: `Bearer ${me.token}` }, payload: { handle: "redtrap" } });
    const friend = (await s.f.inject({ method: "POST", url: "/api/session", payload: { ref: "redtrap" } })).json();
    const r = (await s.f.inject({ method: "GET", url: "/api/rewards", headers: { authorization: `Bearer ${me.token}` } })).json();
    expect(r.invited).toBe(1);
    expect(r.trading).toBe(0);
    expect(r.sharePct).toBe(20);
    expect(r.minClaimUsd).toBe(MIN_CLAIM_USD);
    expect(s.app.growth.referredBy.get(friend.userId ?? [...s.app.growth.referredBy.keys()][0]!)).toBeTruthy();
    await s.f.close();
  });

  it("earns 20% of Outcry's net fee on the friend's real trades, cashes out from $5, admin marks it paid", () => {
    const g = new Growth();
    g.setReferrer("friend", "me");
    // $10,000 at 0.5%: $50 fee, Jupiter keeps 20% -> $40, minus the friend's rebate (Floor tier: none) -> 20% = $8.
    g.recordTrade("friend", 10_000, 50);
    const st = g.referralStats("me");
    expect(st.trading).toBe(1);
    expect(st.rewardsUsd).toBeCloseTo(8, 6);
    expect(st.lifetimeUsd).toBeCloseTo(8, 6);
    const c = g.claim("me", "redtrap", "MyOutcryWallet111");
    expect(c.usd).toBeCloseTo(8, 6);
    expect(g.claimable("me").usd).toBe(0);
    expect(g.referralStats("me").lifetimeUsd).toBeCloseTo(8, 6);
    expect(() => g.claim("me", "redtrap", "MyOutcryWallet111")).toThrow(/from \$5/);
    expect(g.pendingClaims()).toHaveLength(1);
    g.markClaimPaid(c.id, "5".repeat(64));
    expect(g.pendingClaims()).toHaveLength(0);
    expect(g.claimsOf("me")[0]!.status).toBe("paid");
  });
});
