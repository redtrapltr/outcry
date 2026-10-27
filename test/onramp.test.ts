import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { MoonPayOnramp, signMoonPayUrl } from "../src/live/onramp.js";

describe("MoonPay on-ramp", () => {
  it("matches MoonPay's published signing test vector", () => {
    const url = "https://buy.moonpay.com/?apiKey=pk_test_DocsVector00&currencyCode=eth&walletAddress=0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe";
    const signed = signMoonPayUrl(url, "sk_test_DocsVector00");
    expect(signed).toBe(url + "&signature=" + encodeURIComponent("oIJxSghyzll/BLhUFdQZhkxf7DAS8REFaWr/ibO+K8Q="));
  });

  it("pre-fills the user's wallet and signs the link", () => {
    const m = new MoonPayOnramp({ apiKey: "pk_test_x", secretKey: "sk_test_y" });
    const u = new URL(m.buyUrl({ address: "So1anaAddr111", asset: "sol", fiat: "chf", amount: 50.4, userRef: "u1", redirectUrl: "https://outcry.example/terminal.html?funded=1" }));
    expect(u.origin).toBe("https://buy-sandbox.moonpay.com");
    expect(u.searchParams.get("walletAddress")).toBe("So1anaAddr111");
    expect(u.searchParams.get("currencyCode")).toBe("sol");
    expect(u.searchParams.get("baseCurrencyCode")).toBe("chf");
    expect(u.searchParams.get("baseCurrencyAmount")).toBe("50");
    const sig = u.searchParams.get("signature")!;
    const unsigned = u.search.replace(/&signature=[^&]*$/, "");
    expect(sig).toBe(createHmac("sha256", "sk_test_y").update(unsigned).digest("base64"));
    expect(new MoonPayOnramp({ apiKey: "pk_live_x", secretKey: "s" }).buyUrl({ address: "a", asset: "usdc", fiat: "usd", amount: 20, userRef: "u" })).toMatch(/^https:\/\/buy\.moonpay\.com\/\?.*currencyCode=usdc_sol/);
  });
});
