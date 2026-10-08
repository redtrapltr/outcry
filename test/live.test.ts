import { describe, expect, it } from "vitest";
import { createOutcry } from "../src/app.js";
import { LiveFeeds } from "../src/data/live.js";
import { PumpPortalFeed, cleanSymbol } from "../src/data/pumpfeed.js";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe("live prices", () => {
  it("overlays real crypto and stock prices on the market", async () => {
    const app = createOutcry({ mode: "paper" } as never);
    const feeds = new LiveFeeds({
      twelveDataKey: "k",
      fetch: async (u) => {
        if (u.includes("binance")) return ok([{ symbol: "SOLUSDT", price: "123.45" }, { symbol: "ETHUSDT", price: "2500" }, { symbol: "BTCUSDT", price: "100000" }]);
        if (u.includes("twelvedata")) return ok({ AAPL: { price: "250.5" }, TSLA: { price: "300" }, NVDA: { price: "190" }, SPY: { price: "650" } });
        return { ok: false, status: 500, json: async () => ({}) };
      },
    });
    await feeds.pollCrypto();
    await feeds.pollStocks();
    app.market.setLive(feeds);
    expect(app.market.priceUsd("SOL")).toBe(123.45);
    expect(app.market.priceUsd("AAPL")).toBe(250.5);
    expect(app.market.priceUsd("NVDA")).toBe(190);
    expect(app.market.priceUsd("USDC")).toBe(1);
  });

  it("falls back to Jupiter for SOL when Binance fails", async () => {
    const feeds = new LiveFeeds({
      fetch: async (u) => (u.includes("jup.ag") ? ok({ So11111111111111111111111111111111111111112: { usdPrice: 140.1 } }) : { ok: false, status: 451, json: async () => ({}) }),
    });
    await feeds.pollCrypto();
    expect(feeds.price("SOL")).toBe(140.1);
  });
});

describe("pump.fun live feed", () => {
  const setup = () => {
    const app = createOutcry({ mode: "paper" } as never);
    const sent: string[] = [];
    const sock = { readyState: 1, send: (d: string) => sent.push(d), close() {}, onopen: null, onmessage: null, onclose: null, onerror: null } as never;
    const feed = new PumpPortalFeed(app.market, { makeSocket: () => sock });
    feed.start();
    (sock as { onopen: () => void }).onopen();
    return { app, feed, sent };
  };
  const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

  it("registers new tokens with real holder data and follows their trades", () => {
    const { app, feed, sent } = setup();
    expect(sent[0]).toContain("subscribeNewToken");
    feed.handle({ mint: MINT, txType: "create", traderPublicKey: "creator1", initialBuy: 30_000_000, marketCapSol: 30, vSolInBondingCurve: 31, symbol: "wOrK!", name: "Work" });
    feed.flushSubscriptions();
    expect(sent.at(-1)).toContain("subscribeTokenTrade");
    expect(sent.at(-1)).toContain(MINT);
    feed.handle({ message: "Successfully subscribed to keys." });
    expect(feed.status().otherMessages).toBe(1);
    expect(feed.status().lastOtherMessage).toContain("Successfully subscribed");
    let r = app.market.tokenRisk(MINT)!;
    expect(r.symbol).toBe("WORK");
    expect(r.holders).toBe(1);
    expect(r.topWalletPct).toBe(3);
    expect(r.creatorWallets).toEqual(["creator1"]);
    for (let i = 0; i < 12; i++) feed.handle({ mint: MINT, txType: "buy", traderPublicKey: `w${i}`, tokenAmount: 1_000_000, newTokenBalance: 1_000_000, marketCapSol: 32 + i, vSolInBondingCurve: 33 + i });
    feed.handle({ mint: MINT, txType: "sell", traderPublicKey: "w0", tokenAmount: 1_000_000, newTokenBalance: 0, marketCapSol: 40, vSolInBondingCurve: 41 });
    r = app.market.tokenRisk(MINT)!;
    expect(feed.status().tradesSeen).toBe(13);
    expect(r.holders).toBe(12);
    expect(r.top10Pct).toBeCloseTo(3 + 9 * 0.1, 5);
    expect(app.market.priceUsd(MINT)).toBeCloseTo((40 / 1e9) * app.market.priceUsd("SOL"), 12);
  });

  it("keeps tickers unique", () => {
    expect(cleanSymbol("PEPE", "AbCdEf", (s) => s === "PEPE")).toBe("PEPE-ABCD");
    expect(cleanSymbol("🚀🚀", "Zz99", () => false)).toBe("PUMP");
  });

  it("a sniper re-checks a young launch and buys once it passes its filters", async () => {
    const { app, feed } = setup();
    const u = app.users.create({ badge: "T", jacket: "memes", residence: "CH" });
    const { agent } = app.agents.propose(u.id, {
      name: "LIVE", goal: "x", markets: ["memes"], kind: "sniper",
      universe: { venue: "pumpfun", minHolders: 10, maxTopWalletPct: 20, maxTop10Pct: 30, maxAgeSeconds: 60 },
      sizeUsd: 10, exit: { stopLossPct: 30, takeProfitPct: 100 },
      limits: { maxPerTradeUsd: 10, maxPerDayUsd: 50, maxOpenPositions: 3, maxDrawdownPct: 50 }, mode: "paper",
    });
    app.agents.deploy(u.id, agent.id, { mode: "paper" });
    await app.agents.tick(); // ignore seeded tokens
    feed.handle({ mint: MINT, txType: "create", traderPublicKey: "creator1", initialBuy: 20_000_000, marketCapSol: 30, vSolInBondingCurve: 31, symbol: "LIVE1" });
    await app.agents.tick();
    const entries = () => app.agents.explain(agent.id, 50).filter((e) => e.action.endsWith("entry"));
    expect(entries()).toHaveLength(0); // 1 holder: not yet
    for (let i = 0; i < 12; i++) feed.handle({ mint: MINT, txType: "buy", traderPublicKey: `w${i}`, tokenAmount: 2_000_000, newTokenBalance: 2_000_000, marketCapSol: 33, vSolInBondingCurve: 34 });
    await app.agents.tick();
    expect(entries()).toHaveLength(1);
  });
});

describe("token lookup by mint", () => {
  it("fetches an unknown mint live and answers price / holders / top 10", async () => {
    const { TokenLookup, findMints } = await import("../src/data/lookup.js");
    const { ToolExecutor } = await import("../src/orchestrator/tools-exec.js");
    const app = createOutcry({ mode: "paper" } as never);
    const MINT = "GrXMbn56JtFngA2FgoXenJG5HeD1GhvFnjyFPWbfpump";
    expect(findMints(`price of https://pump.fun/coin/${MINT} ?`)).toEqual([MINT]);
    const followed: string[] = [];
    const SYS = "11111111111111111111111111111111", PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
    const accounts = [
      { address: "curveAta", uiAmount: 89_700_000, owner: "curvePda", prog: PUMP },
      { address: "a1", uiAmount: 49_500_000, owner: "7TixWallet", prog: SYS },
      { address: "a2", uiAmount: 36_600_000, owner: "foede", prog: SYS },
      { address: "a3", uiAmount: 33_700_000, owner: "wirel", prog: SYS },
    ];
    const lookup = new TokenLookup(app.market, {
      follow: (m) => followed.push(m),
      rpc: async (method, params) => {
        if (method === "getTokenLargestAccounts") return { value: accounts.map((a) => ({ address: a.address, uiAmount: a.uiAmount })) };
        if (method === "getTokenSupply") return { value: { uiAmount: 1_000_000_000 } };
        const keys = params[0] as string[];
        if ((params[1] as { encoding: string }).encoding === "jsonParsed") return { value: keys.map((k) => ({ data: { parsed: { info: { owner: accounts.find((a) => a.address === k)!.owner } } } })) };
        return { value: keys.map((k) => ({ owner: accounts.find((a) => a.owner === k)!.prog })) };
      },
      fetch: async (u) => {
        expect(u).toContain(MINT);
        return ok([{ id: MINT, name: "Grx", symbol: "GRX", dev: "DevWallet111", launchpad: "pump.fun", holderCount: 142, usdPrice: 0.0000123, liquidity: 18_500, firstPool: { createdAt: new Date(Date.now() - 7 * 60_000).toISOString() }, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 23.4, devBalancePercentage: 4.1 } }]);
      },
    });
    const tools = new ToolExecutor(app);
    tools.lookup = lookup;
    const out = await tools.run("u1", "get_token_risk", { token: MINT });
    expect(out.ok).toBe(true);
    const summary = String(out.result.summary);
    expect(summary).toContain("$GRX");
    expect(summary).toContain("142 holders");
    expect(summary).toContain("top wallet 4.95% (7Tix");
    expect(summary).toContain("top 10 wallets 11.98% combined");
    expect(summary).toContain("liquidity pool accounts hold 8.97%");
    expect(summary).toMatch(/launched 7 min ago/);
    expect(app.market.priceUsd(MINT)).toBeCloseTo(0.0000123, 12);
    expect(followed).toEqual([MINT]);
    // And it can be quoted and ordered by mint.
    const q = await tools.run("u1", "get_quote", { side: "buy", asset: MINT, quote_asset: "USDC", amount: 20 });
    expect(q.ok).toBe(true);
  });
});

describe("on-chain holder check before a sniper buy", () => {
  it("blocks a buy when the chain shows a concentrated top wallet, buys when it's clean", async () => {
    for (const [chainTop, expectBuy] of [[35, false], [4, true]] as const) {
      const app = createOutcry({ mode: "paper" } as never);
      const sock = { readyState: 1, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null } as never;
      const feed = new PumpPortalFeed(app.market, { makeSocket: () => sock }).start();
      const checked: string[] = [];
      app.agents.verifyHolders = async (mint) => (checked.push(mint), { topWalletPct: chainTop, top10Pct: chainTop + 10, poolPct: 80 });
      const u = app.users.create({ badge: "T", jacket: "memes", residence: "CH" });
      const { agent } = app.agents.propose(u.id, {
        name: "CHK", goal: "x", markets: ["memes"], kind: "sniper",
        universe: { venue: "pumpfun", minHolders: 5, maxTopWalletPct: 20, maxTop10Pct: 50, maxAgeSeconds: 120 },
        sizeUsd: 10, exit: { stopLossPct: 30, takeProfitPct: 100 },
        limits: { maxPerTradeUsd: 10, maxPerDayUsd: 50, maxOpenPositions: 3, maxDrawdownPct: 50 }, mode: "paper",
      });
      app.agents.deploy(u.id, agent.id, { mode: "paper" });
      await app.agents.tick();
      const MINT = "9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
      feed.handle({ mint: MINT, txType: "create", traderPublicKey: "c", initialBuy: 10_000_000, marketCapSol: 30, vSolInBondingCurve: 31, symbol: "CHK1" });
      for (let i = 0; i < 6; i++) feed.handle({ mint: MINT, txType: "buy", traderPublicKey: `w${i}`, tokenAmount: 1_000_000, newTokenBalance: 1_000_000, marketCapSol: 32, vSolInBondingCurve: 33 });
      await app.agents.tick();
      const log = app.agents.explain(agent.id, 50);
      expect(checked).toContain(MINT);
      const entry = log.find((e) => e.action.endsWith("entry"));
      expect(!!entry).toBe(expectBuy);
      if (expectBuy) expect((entry!.data as { onChainVerified: boolean }).onChainVerified).toBe(true);
      else expect(log.some((e) => String((e.data as { reason?: string }).reason).includes("on-chain check"))).toBe(true);
      feed.stop();
    }
  });
});

describe("time exit", () => {
  it("sells a position after maxHoldMinutes even if the price never moves", async () => {
    const app = createOutcry({ mode: "paper" } as never);
    const u = app.users.create({ badge: "T", jacket: "memes", residence: "CH" });
    const { agent } = app.agents.propose(u.id, {
      name: "TIMED", goal: "x", markets: ["memes"], kind: "sniper",
      universe: { venue: "pumpfun", minHolders: 1, maxTopWalletPct: 100, maxAgeSeconds: 300 },
      sizeUsd: 10, exit: { stopLossPct: 90, takeProfitPct: 1000, maxHoldMinutes: 1 },
      limits: { maxPerTradeUsd: 10, maxPerDayUsd: 50, maxOpenPositions: 3, maxDrawdownPct: 90 }, mode: "paper",
    });
    app.agents.deploy(u.id, agent.id, { mode: "paper" });
    await app.agents.tick();
    app.market.spawnMeme("TIMEX", { holders: 50, holdersCollapsed: 50 });
    await app.agents.tick(); // buy
    await app.agents.tick(); // reconcile
    const pos = app.agents.positionsOf(agent.id).find((p) => p.symbol === "TIMEX")!;
    expect(pos).toBeDefined();
    pos.openedAt = new Date(Date.now() - 2 * 60_000).toISOString(); // pretend 2 minutes passed
    await app.agents.tick(); // time exit
    await app.agents.tick(); // reconcile
    expect(app.agents.positionsOf(agent.id).some((p) => p.symbol === "TIMEX")).toBe(false);
    expect(app.agents.explain(agent.id, 20).some((e) => String((e.data as { reason?: string }).reason).includes("time exit"))).toBe(true);
  });
});

describe("holders from Jupiter when pump.fun trade data is unavailable", () => {
  it("updates holder counts in batches and lets a sniper buy after an on-chain check", async () => {
    const { JupiterHolderPoller } = await import("../src/data/jupholders.js");
    const app = createOutcry({ mode: "paper" } as never);
    const sock = { readyState: 1, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null } as never;
    const feed = new PumpPortalFeed(app.market, { makeSocket: () => sock }).start();
    const MINT = "5xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const urls: string[] = [];
    let holders = 1;
    const poller = new JupiterHolderPoller(app.market, feed, {
      fetch: async (u) => (urls.push(u), ok([{ id: MINT, holderCount: holders, usdPrice: 0.00001, liquidity: 9000, audit: { topHoldersPercentage: 14.2 } }])),
    });
    app.agents.verifyHolders = async () => ({ topWalletPct: 3.1, top10Pct: 14.2, poolPct: 80 });
    const u = app.users.create({ badge: "T", jacket: "memes", residence: "CH" });
    const { agent } = app.agents.propose(u.id, {
      name: "JUP", goal: "x", markets: ["memes"], kind: "sniper",
      universe: { venue: "pumpfun", minHolders: 5, maxTopWalletPct: 25, maxAgeSeconds: 120 },
      sizeUsd: 10, exit: { stopLossPct: 20, takeProfitPct: 30, maxHoldMinutes: 10 },
      limits: { maxPerTradeUsd: 10, maxPerDayUsd: 100, maxOpenPositions: 5, maxDrawdownPct: 50 }, mode: "paper",
    });
    app.agents.deploy(u.id, agent.id, { mode: "paper" });
    await app.agents.tick();
    feed.handle({ mint: MINT, txType: "create", traderPublicKey: "c", initialBuy: 30_000_000, marketCapSol: 30, vSolInBondingCurve: 31, symbol: "JUPT" });
    await poller.poll();
    await app.agents.tick();
    const entries = () => app.agents.explain(agent.id, 50).filter((e) => e.action.endsWith("entry"));
    expect(entries()).toHaveLength(0); // 1 holder so far
    holders = 12;
    await poller.poll();
    expect(urls.at(-1)).toContain(MINT);
    expect(app.market.tokenRisk(MINT)!.holders).toBe(12);
    await app.agents.tick();
    expect(entries()).toHaveLength(1);
    expect((entries()[0]!.data as { onChainVerified: boolean }).onChainVerified).toBe(true);
    expect(poller.status().lastCoverage).toBe("1/1");
    feed.stop();
  });
});

describe("held tokens keep live prices", () => {
  it("refreshes the price of a token held past the young-launch window, so stops can fire", async () => {
    const { JupiterHolderPoller } = await import("../src/data/jupholders.js");
    const app = createOutcry({ mode: "paper" } as never);
    const sock = { readyState: 1, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null } as never;
    const feed = new PumpPortalFeed(app.market, { makeSocket: () => sock }).start();
    const MINT = "4xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    feed.handle({ mint: MINT, txType: "create", traderPublicKey: "c", initialBuy: 1e7, marketCapSol: 30, vSolInBondingCurve: 31, symbol: "OLDHELD" });
    app.market.updateMeme(MINT, { createdAtMs: Date.now() - 60 * 60_000 }); // an hour old: outside the young window
    let price = 0.00002;
    const urls: string[] = [];
    const poller = new JupiterHolderPoller(app.market, feed, {
      heldMints: () => [MINT],
      fetch: async (u) => (urls.push(u), ok([{ id: MINT, holderCount: 80, usdPrice: price }])),
    });
    await poller.poll();
    expect(app.market.priceUsd(MINT)).toBeCloseTo(0.00002, 12);
    price = 0.000005;
    await poller.poll();
    expect(urls.at(-1)).toContain(MINT);
    expect(app.market.priceUsd(MINT)).toBeCloseTo(0.000005, 12);
    feed.stop();
  });
});

describe("budget is the agent's wallet", () => {
  it("keeps buying with sale proceeds beyond the budget in gross buys, stops only when cash is tied up", async () => {
    const app = createOutcry({ mode: "paper" } as never);
    const u = app.users.create({ badge: "T", jacket: "memes", residence: "CH" });
    const { agent } = app.agents.propose(u.id, {
      name: "RECYCLE", goal: "x", markets: ["memes"], kind: "sniper",
      universe: { venue: "pumpfun", minHolders: 1, maxTopWalletPct: 100, maxAgeSeconds: 600 },
      sizeUsd: 10, exit: { stopLossPct: 5, takeProfitPct: 5 },
      limits: { maxPerTradeUsd: 10, maxPerDayUsd: 30, maxOpenPositions: 10, maxDrawdownPct: 95 }, mode: "paper",
    });
    app.agents.deploy(u.id, agent.id, { mode: "paper" });
    await app.agents.tick();
    const m = app.market as unknown as { memes: Map<string, { risk: { symbol: string }; price: number }> };
    const bump = (sym: string, f: number) => { for (const x of m.memes.values()) if (x.risk.symbol === sym) x.price *= f; };
    let bought = 0;
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 3; i++) app.market.spawnMeme(`R${round}X${i}`, { holders: 50, holdersCollapsed: 50 });
      await app.agents.tick(); // buys
      await app.agents.tick(); // reconcile
      const syms = app.agents.positionsOf(agent.id).map((p) => p.symbol);
      bought += syms.length;
      expect(syms.length).toBeGreaterThanOrEqual(2); // limited by cash, not a daily cap
      syms.forEach((s) => bump(s, 1.2)); // take profit on all
      await app.agents.tick(); // sells
      await app.agents.tick(); // reconcile
      expect(app.agents.positionsOf(agent.id)).toHaveLength(0);
    }
    expect(bought).toBeGreaterThanOrEqual(7); // well over $30 of buys in one day
    // With cash tied up, it waits.
    for (let i = 0; i < 10; i++) app.market.spawnMeme(`FULL${i}`, { holders: 50, holdersCollapsed: 50 });
    await app.agents.tick();
    await app.agents.tick();
    const open = app.agents.positionsOf(agent.id).length;
    expect(open).toBeGreaterThanOrEqual(3);
    expect(open).toBeLessThan(10); // stopped by cash, not by the 10-position limit
    const bud = app.agents.budget(app.agents.get(agent.id)!);
    expect(bud.outOfCash).toBe(true);
  });
});
