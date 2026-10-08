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
