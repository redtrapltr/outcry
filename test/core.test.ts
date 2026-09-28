import { describe, expect, it } from "vitest";
import { createOutcry } from "../src/app.js";
import { AuditLog } from "../src/core/infra.js";
import { estimateDevShare } from "../src/policy/engine.js";
import { buildLaunchPlan, MAX_LAUNCH_WALLETS } from "../src/launch/pumpfun.js";
import { StrategyProgram } from "../src/core/types.js";
import { backtest } from "../src/strategy/backtest.js";
import * as ind from "../src/strategy/indicators.js";
import { PolicyDenied } from "../src/wallet/signer.js";

const setup = (residence = "CH") => {
  const app = createOutcry();
  const user = app.users.create({ badge: "LOUD", jacket: "memes", residence });
  return { app, user };
};
const approval = "passkey-assertion-test";

describe("audit log", () => {
  it("detects tampering through the hash chain", () => {
    const log = new AuditLog();
    log.append("user:a", "x", { n: 1 });
    log.append("user:a", "y", { n: 2 });
    expect(log.verify()).toBe(true);
    log._tamper(0, { n: 999 });
    expect(log.verify()).toBe(false);
  });
});

describe("orders", () => {
  it("quotes, checks policy, and fills only after a passkey approval", async () => {
    const { app, user } = setup();
    const t = await app.desk.proposeOrder({ userId: user.id, legs: [{ side: "buy", asset: "SOL", quoteAsset: "USDC", amount: 100, maxSlippageBps: 50 }] });
    expect(t.status).toBe("needs_confirmation");
    expect(t.legs[0]!.venue).toBe("jupiter");
    expect(t.legs[0]!.platformFeeUsd).toBeCloseTo(0.5, 5); // 50 bps of $100
    await expect(app.desk.approve(t.id, {})).rejects.toThrow(/passkey/);
    const done = await app.desk.approve(t.id, { userApproval: approval });
    expect(done.status).toBe("filled");
    expect(user.balances.USDC).toBeCloseTo(2380, 6);
    expect(user.balances.SOL).toBeGreaterThan(24);
  });

  it("routes tokenized stocks to Ondo or xStocks and geofences US residents", async () => {
    const ch = setup("CH");
    const t = await ch.app.desk.proposeOrder({ userId: ch.user.id, legs: [{ side: "buy", asset: "NVDA", quoteAsset: "USDC", amount: 200, maxSlippageBps: 50 }] });
    expect(t.status).toBe("needs_confirmation");
    expect(t.legs[0]!.venue).toBe("ondo");
    expect(t.jacket).toBe("stocks");
    const us = setup("US");
    const t2 = await us.app.desk.proposeOrder({ userId: us.user.id, legs: [{ side: "buy", asset: "TSLA", quoteAsset: "USDC", amount: 50, maxSlippageBps: 50 }] });
    expect(t2.status).toBe("rejected");
    expect(t2.rejection).toMatch(/not available in your country/);
  });

  it("asks for a second confirmation on a large order", async () => {
    const { app, user } = setup();
    const t = await app.desk.proposeOrder({ userId: user.id, legs: [{ side: "buy", asset: "SOL", quoteAsset: "USDC", amount: 2000, maxSlippageBps: 50 }] });
    expect(t.status).toBe("needs_second_confirmation");
    await expect(app.desk.approve(t.id, { userApproval: approval })).rejects.toThrow(/second confirmation/);
    const done = await app.desk.approve(t.id, { userApproval: approval, secondConfirmation: true });
    expect(done.status).toBe("filled");
  });

  it("rejects orders the wallet can't pay for", async () => {
    const { app, user } = setup();
    const t = await app.desk.proposeOrder({ userId: user.id, legs: [{ side: "buy", asset: "SOL", quoteAsset: "USDC", amount: 999_999, maxSlippageBps: 50 }] });
    expect(t.status).toBe("rejected");
    expect(t.rejection).toMatch(/Insufficient USDC/);
  });

  it("rejects excessive slippage", async () => {
    const { app, user } = setup();
    const t = await app.desk.proposeOrder({ userId: user.id, legs: [{ side: "buy", asset: "SOL", quoteAsset: "USDC", amount: 10, maxSlippageBps: 900 }] });
    expect(t.status).toBe("rejected");
  });
});

describe("signer policy", () => {
  it("refuses main-wallet signatures without a user approval", () => {
    const { app, user } = setup();
    const id = app.users.mainWalletId(user.id);
    expect(() => app.signer.sign({ walletId: id, venue: "jupiter", usd: 5, kind: "trade", payload: {} })).toThrow(PolicyDenied);
  });

  it("enforces sub-wallet venue, per-tx, daily and withdrawal rules", () => {
    const { app, user } = setup();
    const w = app.signer.createSubWallet(user.id, "agent", "t", { allowedVenues: ["jupiter"], maxPerTxUsd: 10, maxPerDayUsd: 15, withdrawTo: user.mainWallet.solana });
    const base = { walletId: w.id, agentId: "agt_x", kind: "trade" as const, payload: {} };
    expect(() => app.signer.sign({ ...base, venue: "pumpfun", usd: 5 })).toThrow(/venue/);
    expect(() => app.signer.sign({ ...base, venue: "jupiter", usd: 11 })).toThrow(/per-transaction/);
    app.signer.sign({ ...base, venue: "jupiter", usd: 10 });
    expect(() => app.signer.sign({ ...base, venue: "jupiter", usd: 6 })).toThrow(/daily/);
    expect(() => app.signer.sign({ ...base, venue: "x", usd: 0, kind: "transfer", transferTo: "attacker" })).toThrow(/main wallet/);
  });
});

describe("launches", () => {
  it("estimates the dev share on the bonding curve", () => {
    expect(estimateDevShare(5).pct).toBeCloseTo(15.3, 0);
    expect(estimateDevShare(0).pct).toBe(0);
  });

  it("launches with a disclosed multi-wallet dev buy", async () => {
    const { app, user } = setup();
    const t = app.launches.propose(user.id, { name: "Work", ticker: "$work", wallets: 10, solPerWallet: 0.5 });
    expect(t.status).toBe("needs_confirmation");
    expect(t.disclosure).toMatch(/10 disclosed wallets via Outcry/);
    await expect(app.launches.approve(t.id, { userApproval: approval })).rejects.toThrow(/disclosure/);
    const done = await app.launches.approve(t.id, { userApproval: approval, disclosureAccepted: true });
    expect(done.status).toBe("filled");
    expect(done.launchWallets).toHaveLength(10);
    const entry = app.registry.get(done.mint!)!;
    expect(entry.wallets).toHaveLength(10);
    const risk = app.market.tokenRisk(done.mint!)!;
    expect(risk.holdersCollapsed).toBe(1); // bundle counted as one holder
    expect(user.balances.SOL).toBeCloseTo(24 - 5 - 0.02, 6);
    const plan = app.launches.plans.get(t.id)!;
    expect(plan.transactions.length).toBeLessThanOrEqual(5);
    expect(plan.bundle.filter((s) => s.op === "buy")).toHaveLength(10);
  });

  it("lets any ticker and any dev-buy size through, with information notes", () => {
    const { app, user } = setup();
    const lookalike = app.launches.propose(user.id, { name: "x", ticker: "BONKK", wallets: 1, solPerWallet: 0.1 });
    expect(lookalike.status).toBe("needs_confirmation");
    expect(lookalike.notes.join(" ")).toMatch(/similar to an existing ticker/);
    const big = app.launches.propose(user.id, { name: "x", ticker: "HUGE", wallets: 10, solPerWallet: 2 });
    expect(big.status).toBe("needs_confirmation"); // 20 SOL ≈ 43% of supply, allowed
    expect(big.notes.join(" ")).toMatch(/Estimated dev share: 4\d\.\d%/);
    // Only the wallet balance limits a launch
    const tooBig = app.launches.propose(user.id, { name: "x", ticker: "MAXX", wallets: 16, solPerWallet: 5 });
    expect(tooBig.rejection).toMatch(/Not enough SOL/);
  });

  it("buys an exact quantity (buy 4 SOL) and fills exactly that", async () => {
    const { app, user } = setup();
    const t = await app.desk.proposeOrder({ userId: user.id, legs: [{ side: "buy", asset: "SOL", quoteAsset: "USDC", amount: 0, receiveExact: 4, maxSlippageBps: 50 }] });
    expect(t.status).toBe("needs_confirmation");
    const leg = t.legs[0]!;
    expect(leg.expectedOut).toBe(4);
    const px = app.market.priceUsd("SOL");
    expect(leg.amount).toBeGreaterThan(4 * px); // includes fees and impact
    expect(leg.amount).toBeLessThan(4 * px * 1.01);
    const solBefore = user.balances.SOL!;
    const done = await app.desk.approve(t.id, { userApproval: approval, secondConfirmation: true });
    expect(done.status).toBe("filled");
    expect(user.balances.SOL! - solBefore).toBeCloseTo(4, 9);
  });

  it("refuses to build a plan without the disclosure, or beyond one Jito bundle", () => {
    const base = { mint: "m", creator: "c", buys: [{ wallet: "w", sol: 1 }] };
    expect(() => buildLaunchPlan({ ...base, metadata: { name: "a", symbol: "A", description: "no disclosure" } })).toThrow(/disclosure/);
    const many = Array.from({ length: MAX_LAUNCH_WALLETS + 1 }, (_, i) => ({ wallet: `w${i}`, sol: 0.1 }));
    expect(() => buildLaunchPlan({ ...base, buys: many, metadata: { name: "a", symbol: "A", description: "1 disclosed wallet" } })).toThrow(/Jito bundle/);
  });
});

describe("agents", () => {
  const sniper = {
    name: "SNIPER", goal: "snipe new memes", markets: ["memes"], kind: "sniper",
    universe: { venue: "pumpfun", minHolders: 200, maxTopWalletPct: 20, requireMintRevoked: true },
    sizeUsd: 20, exit: { stopLossPct: 30, takeProfitPct: 120 },
    limits: { maxPerTradeUsd: 20, maxPerDayUsd: 50, maxOpenPositions: 5, maxDrawdownPct: 40 }, mode: "paper",
  };

  it("paper-trades a sniper within its limits and skips bundled launches", async () => {
    const { app, user } = setup();
    const { agent, replay } = app.agents.propose(user.id, sniper);
    expect(agent.state).toBe("backtested");
    expect(replay!.scanned).toBeGreaterThan(0);
    app.agents.deploy(user.id, agent.id, { mode: "paper" });
    const usdcBefore = user.balances.USDC;

    // Another user launches a token with 10 disclosed wallets: looks like 10 holders, is 1.
    const other = app.users.create({ badge: "DEV", jacket: "launch", residence: "CH" });
    const lt = app.launches.propose(other.id, { name: "Bundle", ticker: "BNDL", wallets: 10, solPerWallet: 0.2 });
    await app.launches.approve(lt.id, { userApproval: approval, disclosureAccepted: true });
    // Three good launches and one bad one
    app.market.spawnMeme("GOOD1");
    app.market.spawnMeme("GOOD2");
    app.market.spawnMeme("GOOD3");
    app.market.spawnMeme("RUG", { mintRevoked: false });

    await app.agents.tick();
    const a = app.agents.get(agent.id)!;
    const pos = app.agents.positionsOf(agent.id).map((p) => p.symbol).sort();
    // Daily cap $50 at $20 per trade allows two buys
    expect(pos.length).toBe(2);
    expect(pos.every((s) => s.startsWith("GOOD"))).toBe(true);
    expect(a.stats.spentTodayUsd).toBeLessThanOrEqual(50 + 1e-6);
    expect(user.balances.USDC).toBe(usdcBefore); // paper: main wallet untouched
    const decisions = app.agents.explain(agent.id, 50).map((e) => e.data as { symbol?: string; reason?: string });
    expect(decisions.some((d) => d.symbol === "BNDL" && /holders/.test(d.reason ?? ""))).toBe(true);
    expect(decisions.some((d) => d.symbol === "RUG")).toBe(true);
    expect(app.audit.verify()).toBe(true);
  });

  it("requires a passkey for live and a paper period for auto", () => {
    const { app, user } = setup();
    const { agent } = app.agents.propose(user.id, sniper);
    expect(() => app.agents.deploy(user.id, agent.id, { mode: "ask" })).toThrow(/passkey/);
    expect(() => app.agents.deploy(user.id, agent.id, { mode: "auto", userApproval: approval })).toThrow(/Auto mode unlocks/);
    const now = Date.now();
    app.agents.deploy(user.id, agent.id, { mode: "paper", now });
    app.agents.control(user.id, agent.id, "pause");
    const live = app.agents.deploy(user.id, agent.id, { mode: "auto", userApproval: approval, now: now + 8 * 86_400_000 });
    expect(live.state).toBe("live");
    expect(live.balances.SOL).toBeGreaterThan(0);
  });

  it("kill sweeps a live agent's funds back to the main wallet", () => {
    const { app, user } = setup();
    const { agent } = app.agents.propose(user.id, sniper);
    const before = user.balances.SOL!;
    app.agents.deploy(user.id, agent.id, { mode: "ask", userApproval: approval });
    expect(user.balances.SOL!).toBeLessThan(before);
    app.agents.control(user.id, agent.id, "kill");
    expect(user.balances.SOL!).toBeCloseTo(before, 9);
    expect(app.agents.get(agent.id)!.state).toBe("killed");
  });

  it("ask mode waits for the user's tap", async () => {
    const { app, user } = setup();
    const { agent } = app.agents.propose(user.id, sniper);
    app.agents.deploy(user.id, agent.id, { mode: "ask", userApproval: approval });
    app.market.spawnMeme("ASKME");
    await app.agents.tick();
    expect(app.agents.positionsOf(agent.id)).toHaveLength(0);
    const pending = app.desk.listForUser(user.id).find((t) => t.status === "needs_confirmation" && t.source.type === "agent" && t.kind === "order" && t.legs[0]!.asset === "ASKME")!;
    expect(pending).toBeDefined();
    await app.desk.approve(pending.id, { userApproval: approval, secondConfirmation: true });
    await app.agents.tick();
    expect(app.agents.positionsOf(agent.id).map((p) => p.symbol)).toContain("ASKME");
  });
});

describe("strategy engine", () => {
  it("computes RSI and EMA without look-ahead", () => {
    const xs = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const r1 = ind.rsi(xs, 14);
    const r2 = ind.rsi(xs.slice(0, 30), 14);
    for (let i = 0; i < 30; i++) expect(Number.isNaN(r1[i]!) ? NaN : r1[i]).toEqual(Number.isNaN(r2[i]!) ? NaN : r2[i]);
    const e = ind.ema([1, 2, 3, 4, 5], 3);
    expect(e[2]).toBeCloseTo(2);
    expect(e[4]).toBeCloseTo(4);
  });

  it("backtests with walk-forward, benchmark and overfitting flags", () => {
    const { app } = setup();
    const p = StrategyProgram.parse({
      timeframe: "4h", asset: "SOL",
      entry: { all: [{ crosses_above: [{ rsi: 14 }, 30] }, { gt: ["close", { ema: 200 }] }] },
      exit: { any: [{ crosses_below: [{ macd: [12, 26, 9] }, { macd_signal: [12, 26, 9] }] }, { stop_loss_pct: 8 }] },
      size: { risk_pct_of_equity: 1 },
    });
    const r = backtest(p, app.market.candles("SOL", "4h", 2000));
    expect(r.full.startEquity).toBe(10_000);
    expect(r.outOfSample).toBeDefined();
    expect(r.monteCarloDrawdownPct.p95).toBeGreaterThanOrEqual(r.monteCarloDrawdownPct.p5);
    expect(r.paramCount).toBe(7);
  });

  it("rejects stops in entry conditions and unknown indicators", async () => {
    const { app, user } = setup();
    const bad = await app.lab.compileAndTest(user.id, { timeframe: "1h", asset: "SOL", entry: { stop_loss_pct: 5 }, exit: { take_profit_pct: 5 }, size: { fixed_quote: 100 } });
    expect(bad.ok).toBe(false);
    const unknown = await app.lab.compileAndTest(user.id, { timeframe: "1h", asset: "SOL", entry: { gt: [{ supertrend: 10 }, 1] }, exit: { take_profit_pct: 5 }, size: { fixed_quote: 100 } });
    expect(unknown.ok).toBe(false);
  });
});

describe("sniper age and top-10 filters, live edits, delete", () => {
  it("skips launches older than maxAgeSeconds and top-10 above the cap; edits apply in place; delete removes", async () => {
    const { createOutcry } = await import("../src/app.js");
    const app = createOutcry({ mode: "paper" } as never);
    const u = app.users.create({ badge: "T", jacket: "memes", residence: "CH" });
    const { agent } = app.agents.propose(u.id, {
      name: "MEME_SNIPER", goal: "snipe", markets: ["memes"], kind: "sniper",
      universe: { venue: "pumpfun", minHolders: 100, maxTopWalletPct: 20, maxTop10Pct: 20, maxAgeSeconds: 60, requireMintRevoked: true },
      sizeUsd: 10, exit: { stopLossPct: 22, takeProfitPct: 100 },
      limits: { maxPerTradeUsd: 10, maxPerDayUsd: 100, maxOpenPositions: 5, maxDrawdownPct: 25 }, mode: "paper",
    });
    app.agents.deploy(u.id, agent.id, { mode: "paper" });
    await app.agents.tick(); // old seeded launches are ignored silently
    app.market.spawnMeme("OLDY", { createdAtMs: Date.now() - 5 * 60_000, holders: 400, holdersCollapsed: 400, top10Pct: 10 });
    app.market.spawnMeme("CONC", { holders: 400, holdersCollapsed: 400, top10Pct: 35 });
    app.market.spawnMeme("GOOD", { holders: 400, holdersCollapsed: 400, top10Pct: 15 });
    await app.agents.tick();
    const log = app.agents.explain(agent.id, 20).map((e) => ({ action: e.action, ...(e.data as Record<string, unknown>) }) as Record<string, any>);
    expect(log.find((e) => e.symbol === "OLDY")?.reason).toMatch(/launched \d+s ago/);
    expect(log.find((e) => e.symbol === "CONC")?.reason).toMatch(/top 10 wallets/);
    expect(log.find((e) => e.symbol === "GOOD")?.action).toContain("entry");

    const before = app.agents.get(agent.id)!;
    const res = app.agents.revise(u.id, agent.id, { limits: { maxDrawdownPct: 50 } } as never);
    expect(res.agent.id).toBe(agent.id);
    expect(res.agent.state).toBe("paper");
    expect(res.agent.spec.limits.maxDrawdownPct).toBe(50);
    expect(res.agent.spec.exit.stopLossPct).toBe(22);
    expect(res.agent.subWalletId).toBe(before.subWalletId);

    app.agents.remove(u.id, agent.id);
    expect(app.agents.get(agent.id)).toBeUndefined();
  });
});

describe("agent exits are never blocked by spend caps", () => {
  it("allows a sell after the daily limit is used up, and perf tracks equity", async () => {
    const { createOutcry } = await import("../src/app.js");
    const app = createOutcry({ mode: "paper" } as never);
    const u = app.users.create({ badge: "T", jacket: "memes", residence: "CH" });
    const { agent } = app.agents.propose(u.id, {
      name: "CAPPED", goal: "x", markets: ["memes"], kind: "sniper",
      universe: { venue: "pumpfun", minHolders: 10, maxTopWalletPct: 50 },
      sizeUsd: 20, exit: { stopLossPct: 5, takeProfitPct: 5 },
      limits: { maxPerTradeUsd: 20, maxPerDayUsd: 20, maxOpenPositions: 5, maxDrawdownPct: 90 }, mode: "paper",
    });
    app.agents.deploy(u.id, agent.id, { mode: "paper" });
    await app.agents.tick();
    app.market.spawnMeme("CAPA", { holders: 400, holdersCollapsed: 400 });
    await app.agents.tick(); // buys CAPA, uses the whole $20 daily cap
    await app.agents.tick(); // reconcile
    expect(app.agents.positionsOf(agent.id).map((p) => p.symbol)).toContain("CAPA");
    // Move the price hard so the exit triggers.
    const m = app.market as unknown as { memes: Map<string, { risk: { symbol: string }; price: number }> };
    for (const x of m.memes.values()) if (x.risk.symbol === "CAPA") x.price *= 0.5;
    await app.agents.tick(); // sell proposed + filled
    await app.agents.tick(); // reconcile
    expect(app.agents.positionsOf(agent.id).map((p) => p.symbol)).not.toContain("CAPA");
    const perf = app.agents.perf(agent.id)!;
    expect(perf.startUsd).toBeGreaterThan(0);
    expect(perf.history.length).toBeGreaterThanOrEqual(1);
    expect(perf.closedTrades).toBe(1);
    expect(perf.realizedPnlUsd).toBeLessThan(0);
  });
});

describe("strategy lab: periods, sizing, breakouts, real data", () => {
  const breakout = { name: "BO", timeframe: "1d", asset: "AAPL", entry: { crosses_above: ["close", { highest: 20 }] }, exit: { any: [{ trailing_stop_pct: 7 }, { stop_loss_pct: 8 }] }, size: { fixed_quote: 100 } };

  it("highest(n) excludes the current bar so breakouts can trigger", async () => {
    const { highest } = await import("../src/strategy/indicators.js");
    const h = highest([1, 2, 3, 4, 10], 3);
    expect(h[4]).toBe(4); // previous 3 bars: 2,3,4
    expect(Number.isNaN(h[2])).toBe(true);
  });

  it("honours lookback_days, measures on the trade size and labels simulated data", async () => {
    const { createOutcry } = await import("../src/app.js");
    const app = createOutcry({ mode: "paper" } as never);
    const res = await app.lab.compileAndTest("u1", breakout, undefined, { days: 365 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = res.strategy.report;
    expect((r.to - r.from) / 86_400_000).toBeGreaterThan(350);
    expect((r.to - r.from) / 86_400_000).toBeLessThan(370);
    expect(r.startEquity).toBe(100);
    expect(r.realData).toBe(false);
    expect(res.strategy.summary).toMatch(/SIMULATED/);
    expect(r.full.trades).toBeGreaterThan(0);
  });

  it("uses real candles from the history provider when available", async () => {
    const { createOutcry } = await import("../src/app.js");
    const { RealHistory } = await import("../src/data/history.js");
    const day = 86_400_000, start = Date.now() - 400 * day;
    const values = Array.from({ length: 400 }, (_, i) => {
      const px = 150 + 20 * Math.sin(i / 15) + i * 0.05;
      return { datetime: new Date(start + i * day).toISOString().slice(0, 10), open: String(px), high: String(px * 1.01), low: String(px * 0.99), close: String(px), volume: "1000" };
    });
    const urls: string[] = [];
    const history = new RealHistory({ twelveDataKey: "test-key", fetch: async (u) => { urls.push(u); return { ok: true, status: 200, json: async () => ({ status: "ok", values }) }; } });
    const app = createOutcry({ mode: "paper", history } as never);
    const res = await app.lab.compileAndTest("u1", breakout, undefined, { days: 365 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(urls[0]).toContain("symbol=AAPL");
    expect(urls[0]).toContain("interval=1day");
    expect(res.strategy.report.realData).toBe(true);
    expect(res.strategy.report.dataSource).toContain("Twelve Data AAPL");
    expect(res.strategy.summary).toMatch(/real prices/);
  });
});
