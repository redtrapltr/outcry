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
    expect(sent.at(-1)).toContain("subscribeTokenTrade");
    let r = app.market.tokenRisk(MINT)!;
    expect(r.symbol).toBe("WORK");
    expect(r.holders).toBe(1);
    expect(r.topWalletPct).toBe(3);
    expect(r.creatorWallets).toEqual(["creator1"]);
    for (let i = 0; i < 12; i++) feed.handle({ mint: MINT, txType: "buy", traderPublicKey: `w${i}`, tokenAmount: 1_000_000, newTokenBalance: 1_000_000, marketCapSol: 32 + i, vSolInBondingCurve: 33 + i });
    feed.handle({ mint: MINT, txType: "sell", traderPublicKey: "w0", tokenAmount: 1_000_000, newTokenBalance: 0, marketCapSol: 40, vSolInBondingCurve: 41 });
    r = app.market.tokenRisk(MINT)!;
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
    const lookup = new TokenLookup(app.market, {
      follow: (m) => followed.push(m),
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
    expect(summary).toContain("142 real holders");
    expect(summary).toContain("top 10 wallets 23.4%");
    expect(summary).toMatch(/launched 7 min ago/);
    expect(app.market.priceUsd(MINT)).toBeCloseTo(0.0000123, 12);
    expect(followed).toEqual([MINT]);
    // And it can be quoted and ordered by mint.
    const q = await tools.run("u1", "get_quote", { side: "buy", asset: MINT, quote_asset: "USDC", amount: 20 });
    expect(q.ok).toBe(true);
  });
});
