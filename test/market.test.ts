import { describe, expect, it } from "vitest";
import { createOutcry } from "../src/app.js";
import { OUTCRY_COPY_BPS, redactAgent } from "../src/market/listings.js";

const spec = (name: string) => ({
  name, goal: "secret sauce", markets: ["memes"], kind: "sniper",
  universe: { venue: "pumpfun", minHolders: 7, maxTopWalletPct: 33, maxAgeSeconds: 600 },
  sizeUsd: 10, exit: { stopLossPct: 5, takeProfitPct: 5 },
  limits: { maxPerTradeUsd: 10, maxPerDayUsd: 100, maxOpenPositions: 5, maxDrawdownPct: 90 }, mode: "paper",
});

describe("agent marketplace", () => {
  it("publish, activate, fees to the creator, hidden strategy, creator-token guard", async () => {
    const app = createOutcry({ mode: "paper" } as never);
    const creator = app.users.create({ badge: "CRE", jacket: "memes", residence: "CH" });
    const sub = app.users.create({ badge: "SUB", jacket: "memes", residence: "CH" });
    const src = app.agents.propose(creator.id, spec("ALPHA")).agent;
    expect(() => app.marketplace.publish(creator.id, src.id, {})).toThrow(/Deploy the agent first/);
    app.agents.deploy(creator.id, src.id, { mode: "paper" });
    app.users.setHandle(creator.id, "creator1");
    const l = app.marketplace.publish(creator.id, src.id, { creatorFeeBps: 50, performanceFeePct: 20, unlockUsd: 10, monthlyUsd: 5, description: "fast memes" });
    const listed = app.marketplace.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("minHolders");
    expect(listed[0]!.fees.perTradePct).toBeCloseTo(0.9, 6);

    const creatorUsdc0 = app.users.get(creator.id).balances.USDC!;
    const subUsdc0 = app.users.get(sub.id).balances.USDC!;
    const { agent: copy } = app.marketplace.activate(sub.id, l.id, { budgetUsd: 50, sizeUsd: 10 });
    expect(app.users.get(sub.id).balances.USDC).toBeCloseTo(subUsdc0 - 15, 6);
    expect(app.users.get(creator.id).balances.USDC).toBeCloseTo(creatorUsdc0 + 15, 6);
    expect(copy.state).toBe("paper");

    // Hidden strategy for the copy's owner.
    const view = redactAgent(copy);
    expect(view.spec.universe).toBeUndefined();
    expect((view as { hiddenStrategy?: boolean }).hiddenStrategy).toBe(true);
    expect(() => app.agents.revise(sub.id, copy.id, { universe: { venue: "pumpfun", minHolders: 1 } } as never)).toThrow(/belongs to its creator/);
    const r = app.agents.revise(sub.id, copy.id, { name: "my copy", sizeUsd: 8 } as never);
    expect(r.agent.spec.name).toBe("MY COPY");
    expect(r.agent.spec.universe?.minHolders).toBe(7); // unchanged internally

    // Copy trades: Outcry 0.4% + creator 0.5%; creator receives 50/90 of the fee.
    await app.agents.tick();
    const before = app.users.get(creator.id).balances.USDC!;
    app.market.spawnMeme("MKTA", { holders: 50, holdersCollapsed: 50 });
    await app.agents.tick();
    await app.agents.tick();
    const tk = app.desk.listForUser(sub.id).find((t) => t.kind === "order" && (t as { legs: { asset: string }[] }).legs[0]?.asset === "MKTA") as { legs: { platformFeeUsd: number; amount: number }[] };
    expect(tk).toBeDefined();
    const fee = tk.legs[0]!.platformFeeUsd;
    expect(fee / 8).toBeGreaterThan((OUTCRY_COPY_BPS + 50) / 10_000 * 0.9);
    const afterTrade = app.users.get(creator.id).balances.USDC!;
    expect(afterTrade - before).toBeCloseTo((fee * 50) / 90, 6);

    // Performance fee: price jumps, take profit sells, creator gets 20% of the new profit.
    const m = app.market as unknown as { memes: Map<string, { risk: { symbol: string }; price: number }> };
    for (const x of m.memes.values()) if (x.risk.symbol === "MKTA") x.price *= 3;
    await app.agents.tick();
    await app.agents.tick();
    const lst = app.marketplace.listings.get(l.id)!;
    expect(lst.earnings.performanceFees).toBeGreaterThan(0);

    // Guard: a copy never buys the creator's own launch.
    app.registry.add({ mint: "creatorcoinmintxxxxxxxxxxxxxxxxxxxxxpump", ticker: "CRE8", creatorUserId: creator.id, creatorBadge: "CRE", wallets: [], devSharePct: 1, launchedAt: new Date().toISOString() } as never);
    app.market.spawnMeme("CRE8", { mint: "creatorcoinmintxxxxxxxxxxxxxxxxxxxxxpump", holders: 50, holdersCollapsed: 50 });
    await app.agents.tick();
    await app.agents.tick();
    expect(app.agents.positionsOf(copy.id).some((p) => p.symbol === "CRE8")).toBe(false);
    expect(app.agents.explain(copy.id, 20).some((e) => String((e.data as { reason?: string }).reason).includes("creator"))).toBe(true);
  });
});

describe("marketplace: handles and strategy updates", () => {
  it("needs a unique handle to publish, shows it, and lets subscribers accept a new version", async () => {
    const app = createOutcry({ mode: "paper" } as never);
    const creator = app.users.create({ badge: "CRE", jacket: "memes", residence: "CH" });
    const other = app.users.create({ badge: "OTH", jacket: "memes", residence: "CH" });
    const sub = app.users.create({ badge: "SUB", jacket: "memes", residence: "CH" });
    const src = app.agents.propose(creator.id, spec("BETA")).agent;
    app.agents.deploy(creator.id, src.id, { mode: "paper" });
    expect(() => app.marketplace.publish(creator.id, src.id, {})).toThrow(/@handle/);
    app.users.setHandle(creator.id, "@Thiago");
    expect(() => app.users.setHandle(other.id, "thiago")).toThrow(/taken/);
    expect(() => app.users.setHandle(other.id, "x")).toThrow(/3 to 16/);
    const l = app.marketplace.publish(creator.id, src.id, {});
    expect(app.marketplace.list()[0]!.creator).toBe("@thiago");

    const { agent: copy } = app.marketplace.activate(sub.id, l.id, { budgetUsd: 50, sizeUsd: 10 });
    expect(app.marketplace.updateFor(copy.id)!.available).toBe(false);
    // Creator tightens the strategy.
    app.agents.revise(creator.id, src.id, { universe: { venue: "pumpfun", minHolders: 99, maxTopWalletPct: 15 } } as never);
    const u = app.marketplace.updateFor(copy.id)!;
    expect(u.available).toBe(true);
    const after = app.marketplace.applyUpdate(sub.id, copy.id);
    expect(after.spec.universe?.minHolders).toBe(99);
    expect(after.spec.sizeUsd).toBe(10); // subscriber's risk kept
    expect(after.spec.limits.maxPerDayUsd).toBe(50);
    expect(app.marketplace.updateFor(copy.id)!.available).toBe(false);
  });
});

describe("marketplace: leaderboard and creator profiles", () => {
  it("ranks by return per unit of risk, keeps short records out, and shows public creator pages", async () => {
    const app = createOutcry({ mode: "paper" } as never);
    const mk = (badge: string, handle: string, name: string) => {
      const u = app.users.create({ badge, jacket: "memes", residence: "CH" });
      app.users.setHandle(u.id, handle);
      const a = app.agents.propose(u.id, spec(name)).agent;
      app.agents.deploy(u.id, a.id, { mode: "paper" });
      return { u, l: app.marketplace.publish(u.id, a.id, {}) };
    };
    const steady = mk("STD", "steady", "STEADY");
    const wild = mk("WLD", "wild", "WILD");
    const fresh = mk("NEW", "fresh", "FRESH");
    const day = 3_600_000 * 30;
    const fake: Record<string, { pnlPct: number; drawdownPct: number; closedTrades: number; wins: number; t0: number }> = {
      [steady.l.agentId]: { pnlPct: 20, drawdownPct: 4, closedTrades: 10, wins: 7, t0: Date.now() - day },
      [wild.l.agentId]: { pnlPct: 25, drawdownPct: 60, closedTrades: 12, wins: 5, t0: Date.now() - day },
      [fresh.l.agentId]: { pnlPct: 300, drawdownPct: 1, closedTrades: 1, wins: 1, t0: Date.now() - 600_000 },
    };
    app.agents.perf = ((id: string) => {
      const f = fake[id]!;
      return { pnlPct: f.pnlPct, drawdownPct: f.drawdownPct, closedTrades: f.closedTrades, wins: f.wins, startUsd: 100, history: [{ t: f.t0, v: 100 }, { t: Date.now(), v: 100 + f.pnlPct }] };
    }) as never;

    const b = app.marketplace.leaderboard("score");
    expect(b.ranked.map((x) => x.creatorHandle)).toEqual(["steady", "wild"]); // 20/5=4 beats 25/60
    expect(b.ranked[0]!.rank).toBe(1);
    expect(b.rising.map((x) => x.creatorHandle)).toEqual(["fresh"]); // +300% in 10 minutes is not ranked
    expect(app.marketplace.leaderboard("return").ranked[0]!.creatorHandle).toBe("wild");
    expect(JSON.stringify(b)).not.toContain("minHolders");

    app.users.setBio(steady.u.id, "  Slow and   steady.  ");
    const p = app.marketplace.creatorProfile("@Steady")!;
    expect(p.handle).toBe("steady");
    expect(p.bio).toBe("Slow and steady.");
    expect(p.stats.bestRank).toBe(1);
    expect(p.stats.winRatePct).toBe(70);
    expect(JSON.stringify(p)).not.toContain("earnings");
    expect(app.marketplace.creatorProfile("nobody")).toBeUndefined();
  });
});
