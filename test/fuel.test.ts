import { describe, expect, it } from "vitest";
import { ModelRouter } from "../src/llm/router.js";
import { OfflineProvider } from "../src/llm/offline.js";
import type { ModelProvider } from "../src/llm/types.js";
import { buildServer } from "../src/api/server.js";

const fake = {} as ModelProvider;
// T2 input is $4 per million tokens: 10,000 input tokens = $0.04.
const turn = { inputTokens: 10_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

describe("AI fuel", () => {
  it("runs on the free daily tank, then on paid fuel, then empties", () => {
    const r = new ModelRouter({ providers: { anthropic: fake, offline: new OfflineProvider() }, budgets: { perUserDailyUsd: 0.1, globalDailyUsd: 100 } });
    expect(r.fuel("u").level).toBe(1);
    r.record("u", "T2", turn);
    r.record("u", "T2", turn);
    expect(r.fuel("u").freeLeftUsd).toBeCloseTo(0.02, 6);
    expect(r.overBudget("u")).toBe(false);
    r.record("u", "T2", turn); // $0.12 used > $0.10 free
    expect(r.overBudget("u")).toBe(true);
    expect(r.fuel("u").empty).toBe(true);
    r.addCredit("u", 0.1);
    expect(r.overBudget("u")).toBe(false);
    r.record("u", "T2", turn); // free tank is empty: all $0.04 comes from paid fuel
    expect(r.fuel("u").creditUsd).toBeCloseTo(0.06, 6);
    r.record("u", "T2", turn);
    r.record("u", "T2", turn); // 0.06 - 0.08 -> 0
    expect(r.fuel("u").creditUsd).toBe(0);
    expect(r.overBudget("u")).toBe(true);
  });

  it("uses free fuel first and only charges the overflow to paid fuel", () => {
    const r = new ModelRouter({ providers: { anthropic: fake, offline: new OfflineProvider() }, budgets: { perUserDailyUsd: 0.05, globalDailyUsd: 100 } });
    r.addCredit("u", 1);
    r.record("u", "T2", turn); // $0.04 free
    expect(r.fuel("u").creditUsd).toBeCloseTo(1, 6);
    r.record("u", "T2", turn); // $0.01 free + $0.03 paid
    expect(r.fuel("u").creditUsd).toBeCloseTo(0.97, 6);
  });

  it("paid fuel keeps the AI on when the whole deployment's daily cap is hit", () => {
    const r = new ModelRouter({ providers: { anthropic: fake, offline: new OfflineProvider() }, budgets: { perUserDailyUsd: 1, globalDailyUsd: 0.04 } });
    r.record("someone", "T2", turn);
    expect(r.overBudget("u")).toBe(true);
    expect(r.fuel("u").globalEmpty).toBe(true);
    r.addCredit("u", 0.5);
    expect(r.overBudget("u")).toBe(false);
    r.record("u", "T2", turn);
    expect(r.fuel("u").creditUsd).toBeCloseTo(0.46, 6);
  });

  it("is hidden without a real model and refuses to sell without a treasury", async () => {
    const s = await buildServer({ router: new ModelRouter({ providers: { offline: new OfflineProvider() } }), tickMs: 0, simLaunchEveryMs: 0, store: null });
    const { token } = (await s.f.inject({ method: "POST", url: "/api/session", payload: {} })).json();
    const h = { authorization: `Bearer ${token}` };
    const me = (await s.f.inject({ method: "GET", url: "/api/me", headers: h })).json();
    expect(me.fuel.enabled).toBe(false);
    const f = (await s.f.inject({ method: "GET", url: "/api/fuel", headers: h })).json();
    expect(f.packs.map((p: { id: string }) => p.id)).toEqual(["shout", "roar", "riot"]);
    expect(f.payable).toBe(false);
    const buy = await s.f.inject({ method: "POST", url: "/api/fuel/buy", headers: h, payload: { pack: "shout" } });
    expect(buy.statusCode).toBeGreaterThanOrEqual(400);
    // The floor-pass bonus needs the four core steps first.
    const early = await s.f.inject({ method: "POST", url: "/api/onboarding/claim", headers: h });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatch(/trader name.*passkey.*practice trade.*AI trader/);
    await s.f.close();
  });
});
