import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { ModelRouter } from "../src/llm/router.js";
import { OfflineProvider } from "../src/llm/offline.js";

let s: Awaited<ReturnType<typeof buildServer>>;
let token = "";
const call = async (method: string, url: string, body?: unknown) => {
  const r = await s.f.inject({ method: method as "GET", url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, json: r.json() };
};

beforeAll(async () => {
  s = await buildServer({ router: new ModelRouter({ providers: { offline: new OfflineProvider() } }), tickMs: 0, simLaunchEveryMs: 0 });
  const r = await call("POST", "/api/session", { badge: "LOUD", jacket: "memes", residence: "CH" });
  token = r.json.token;
});
afterAll(async () => s.f.close());

describe("API", () => {
  it("requires a session", async () => {
    const saved = token;
    token = "";
    expect((await call("GET", "/api/me")).status).toBe(401);
    token = saved;
  });

  it("runs the launch flow end to end", async () => {
    const chat = await call("POST", "/api/chat", { text: "launch $work on pump.fun buy with 10 different wallets 0.5 sol" });
    expect(chat.status).toBe(200);
    const card = chat.json.cards[0];
    expect(card.type).toBe("launch");
    const revised = await call("PATCH", `/api/launch/${card.ticket.id}`, { wallets: 8 });
    expect(revised.json.request.wallets).toBe(8);
    const noDisc = await call("POST", `/api/tickets/${revised.json.id}/approve`, { passkeyAssertion: "pk" });
    expect(noDisc.status).toBe(400);
    const ok = await call("POST", `/api/tickets/${revised.json.id}/approve`, { passkeyAssertion: "pk", disclosureAccepted: true });
    expect(ok.json.status).toBe("filled");
    const reg = await call("GET", `/api/registry/${ok.json.mint}`);
    expect(reg.json.wallets).toHaveLength(8);
  });

  it("builds, tunes and deploys an agent", async () => {
    const chat = await call("POST", "/api/chat", { text: "build me an agent that snipes new pump.fun memes, $20 per trade" });
    const a = chat.json.cards.find((c: { type: string }) => c.type === "agent").agent;
    const tuned = await call("PATCH", `/api/agents/${a.id}`, { sizeUsd: 30, limits: { maxPerTradeUsd: 30, maxPerDayUsd: 90 } });
    expect(tuned.json.agent.spec.sizeUsd).toBe(30);
    expect(tuned.json.agent.version).toBe(2);
    const dep = await call("POST", `/api/agents/${a.id}/deploy`, { mode: "paper" });
    expect(dep.json.agent.state).toBe("paper");
    const auto = await call("POST", `/api/agents/${a.id}/deploy`, { mode: "auto", passkeyAssertion: "pk" });
    expect(auto.status).toBe(400);
    const list = await call("GET", "/api/agents");
    expect(list.json[0].agent.spec.name).toBe("SNIPER");
  });

  it("backtests a strategy and turns it into an agent", async () => {
    const chat = await call("POST", "/api/chat", { text: "backtest buy SOL on 4h when RSI crosses above 30, stop 8%" });
    const st = chat.json.cards.find((c: { type: string }) => c.type === "strategy").strategy;
    const ag = await call("POST", "/api/agents", { fromStrategyId: st.id, sizeUsd: 40 });
    expect(ag.json.agent.spec.kind).toBe("rules");
  });

  it("fills an order and reports health", async () => {
    const chat = await call("POST", "/api/chat", { text: "buy 100 usdc of sol" });
    const t = chat.json.cards[0].ticket;
    const done = await call("POST", `/api/tickets/${t.id}/approve`, { passkeyAssertion: "pk" });
    expect(done.json.status).toBe("filled");
    const h = await call("GET", "/api/health");
    expect(h.json.auditIntact).toBe(true);
  });
});
