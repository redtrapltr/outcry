import { describe, expect, it } from "vitest";
import { createOutcry } from "../src/app.js";
import { StockCatalog, usMarketStatus } from "../src/data/stocks.js";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const REAL_X = "XsMsftRea1Mint11111111111111111111111111111";
const FAKE_X = "XsMsftFakeMint11111111111111111111111111111";
const REAL_ON = "OnMsftRea1Mint11111111111111111111111111111";

function setup() {
  const app = createOutcry({ mode: "paper" } as never);
  const urls: string[] = [];
  let price = 512.3;
  const cat = new StockCatalog(app.market, {
    fetch: async (u) => {
      urls.push(u);
      if (u.includes("search?query=MSFTx")) return ok([
        { id: FAKE_X, symbol: "MSFTx", name: "Microsoft xStock", liquidity: 9_000_000, isVerified: false, usdPrice: 1 },
        { id: REAL_X, symbol: "MSFTx", name: "Microsoft xStock", liquidity: 2_000_000, isVerified: true, decimals: 8, usdPrice: 512.3 },
      ]);
      if (u.includes("search?query=MSFTon")) return ok([{ id: REAL_ON, symbol: "MSFTon", name: "Microsoft (Ondo)", liquidity: 1_000_000, tags: ["verified"], decimals: 9, usdPrice: 512.1 }]);
      if (u.includes("search?query=")) return ok([]);
      if (u.includes("price/v3")) return ok({ [REAL_X]: { usdPrice: price }, [REAL_ON]: { usdPrice: price - 0.2 } });
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  return { app, cat, urls, setPrice: (p: number) => (price = p) };
}

describe("tokenized stock catalog", () => {
  it("resolves a company name to the verified xStocks token, never a look-alike", async () => {
    const { app, cat } = setup();
    await cat.ensureFrom('{"asset":"put 200 USDC into microsoft"}');
    const a = app.market.asset("MSFT")!;
    expect(a.symbol).toBe("MSFTx");
    expect(a.address).toBe(REAL_X);
    expect(a.kind).toBe("tokenized_stock");
    expect(a.chain).toBe("solana");
    expect(app.market.asset("microsoft")!.symbol).toBe("MSFTx");
    expect(app.market.asset("MSFTon")!.address).toBe(REAL_ON);
    expect(app.market.priceUsd("MSFT")).toBeCloseTo(512.3, 6);
  });

  it("keeps on-chain prices fresh and routes orders on Solana with the market status", async () => {
    const { app, cat, setPrice } = setup();
    await cat.resolve("MSFT");
    setPrice(530);
    await cat.pollPrices();
    expect(app.market.priceUsd("MSFT")).toBeCloseTo(530, 6);
    app.market.updateStockRef("MSFTx", 520);
    const u = app.users.create({ badge: "T", jacket: "stocks", residence: "CH" });
    const t = await app.desk.proposeOrder({ userId: u.id, source: { type: "user" }, legs: [{ side: "buy", asset: "MSFT", quoteAsset: "USDC", amount: 200, maxSlippageBps: 100 }] } as never);
    const leg = (t as { legs: { venue: string; networkFeeUsd?: number; asset: string }[] }).legs[0]!;
    expect(leg.asset).toBe("MSFTx");
    expect(leg.venue).toBe("xstocks");
    expect(leg.networkFeeUsd).toBeCloseTo(0.01, 6);
    expect(t.notes.some((n) => /^US (market|pre-market|after-hours)/.test(n) && n.includes("+1.92% vs last Nasdaq $520.00"))).toBe(true);
    expect(t.warnings.some((w) => w.includes("1.9% above the last Nasdaq price"))).toBe(true);
    // Ondo tokens route to the Ondo venue.
    const t2 = await app.desk.proposeOrder({ userId: u.id, source: { type: "user" }, legs: [{ side: "buy", asset: "MSFTon", quoteAsset: "USDC", amount: 50, maxSlippageBps: 100 }] } as never);
    expect((t2 as { legs: { venue: string }[] }).legs[0]!.venue).toBe("ondo");
  });

  it("knows when the US market is open", () => {
    expect(usMarketStatus(new Date("2026-10-10T15:00:00Z")).label).toBe("US market closed (weekend)"); // Saturday
    expect(usMarketStatus(new Date("2026-10-12T15:00:00Z")).open).toBe(true); // Monday 11:00 New York
    expect(usMarketStatus(new Date("2026-10-12T12:00:00Z")).label).toBe("US pre-market"); // 08:00 New York
    expect(usMarketStatus(new Date("2026-10-12T21:00:00Z")).label).toBe("US after-hours"); // 17:00 New York
    expect(usMarketStatus(new Date("2026-11-26T16:00:00Z")).label).toBe("US market closed (holiday)"); // Thanksgiving
  });
});
