import { describe, expect, it } from "vitest";
import { createOutcry } from "../src/app.js";
import { ModelRouter } from "../src/llm/router.js";
import { OfflineProvider, classify, parseLaunch, parseStrategy } from "../src/llm/offline.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import type { ChatRequest, ChatResponse, ModelProvider } from "../src/llm/types.js";
import { costUsd } from "../src/llm/types.js";

const offlineSetup = () => {
  const app = createOutcry();
  const user = app.users.create({ badge: "LOUD", jacket: "memes", residence: "CH" });
  const router = new ModelRouter({ providers: { offline: new OfflineProvider() } });
  return { app, user, orch: new Orchestrator(app, router) };
};

describe("intent parsing", () => {
  it("classifies intents", () => {
    expect(classify("launch $work on pump.fun buy with 10 different wallets 0.5 sol")).toBe("launch");
    expect(classify("build me an agent that snipes new memes")).toBe("agent");
    expect(classify("backtest RSI crosses 30 on SOL 4h")).toBe("strategy");
    expect(classify("buy 200 usdc of nvda")).toBe("order");
    expect(classify("kill the sniper agent")).toBe("control");
    expect(classify("launch a token and hide the dev wallets")).toBe("refuse");
  });

  it("parses the launch example from the brief", () => {
    expect(parseLaunch("launch token $work on pump.fun buy direct supply with 10 different wallets 0.5 sol")).toMatchObject({ ticker: "WORK", wallets: 10, sol_per_wallet: 0.5 });
    expect(parseLaunch("launch $LOUD, 4 wallets, 2 sol total")).toMatchObject({ wallets: 4, sol_per_wallet: 0.5 });
  });

  it("compiles a described strategy into valid DSL", () => {
    const { program } = parseStrategy("buy SOL on 4h when RSI crosses up through 30 and price is above the 200 EMA, exit on MACD cross down or -8%");
    expect(program.asset).toBe("SOL");
    expect(program.timeframe).toBe("4h");
    expect(JSON.stringify(program.entry)).toContain('"rsi":14');
    expect(JSON.stringify(program.entry)).toContain('"ema":200');
    expect(JSON.stringify(program.exit)).toContain("stop_loss_pct");
  });
});

describe("orchestrator (offline provider)", () => {
  it("turns a launch sentence into a launch card", async () => {
    const { orch, user } = offlineSetup();
    const r = await orch.handle(user.id, "s1", "launch token $work on pump.fun buy direct supply with 10 different wallets 0.5 sol");
    const card = r.cards.find((c) => c.type === "launch");
    expect(card?.type).toBe("launch");
    if (card?.type === "launch") {
      expect(card.ticket.request.wallets).toBe(10);
      expect(card.ticket.status).toBe("needs_confirmation");
    }
    expect(r.meta.tier).toBe("T1");
    expect(r.reply).toMatch(/disclosed/);
  });

  it("builds an agent draft with a blueprint", async () => {
    const { orch, user } = offlineSetup();
    const r = await orch.handle(user.id, "s1", "build me an agent that snipes new pump.fun memes with 300+ holders, $15 per trade");
    const card = r.cards.find((c) => c.type === "agent");
    expect(card?.type).toBe("agent");
    if (card?.type === "agent") {
      expect(card.blueprint.map((n) => n.key)).toEqual(["goal", "markets", "signals", "risk", "execution"]);
      expect(card.agent.spec.universe?.minHolders).toBe(300);
      expect(card.agent.spec.sizeUsd).toBe(15);
      expect(card.agent.spec.mode).toBe("paper");
    }
    expect(r.meta.tier).toBe("T2");
  });

  it("compiles and backtests a strategy from chat", async () => {
    const { orch, user } = offlineSetup();
    const r = await orch.handle(user.id, "s1", "backtest: buy ETH on 1d when RSI crosses above 30 and price above 50 ema, stop 10%");
    const card = r.cards.find((c) => c.type === "strategy");
    expect(card?.type).toBe("strategy");
    expect(r.reply).toMatch(/past, simulated results/);
  });

  it("refuses to hide a dev buy", async () => {
    const { orch, user } = offlineSetup();
    const r = await orch.handle(user.id, "s1", "launch $SNEAK and hide the dev wallets so nobody sees the bundle");
    expect(r.cards).toHaveLength(0);
    expect(r.reply).toMatch(/can't hide/);
  });

  it("places an order ticket and pauses agents by name", async () => {
    const { orch, user } = offlineSetup();
    const r = await orch.handle(user.id, "s1", "put 150 usdc into tokenized nvidia");
    const card = r.cards[0];
    expect(card?.type).toBe("order");
    await orch.handle(user.id, "s1", "build me a careful agent that snipes new tokens");
    const k = await orch.handle(user.id, "s1", "pause the sniper agent");
    expect(k.reply).toMatch(/SNIPER is paused/);
  });
});

/** Scripted provider: returns bad tool input twice, to test escalation. */
class ScriptedProvider implements ModelProvider {
  name = "scripted";
  calls: string[] = [];
  constructor(private script: (req: ChatRequest, n: number) => ChatResponse) {}
  n = 0;
  async chat(req: ChatRequest) {
    this.calls.push(req.model);
    return this.script(req, this.n++);
  }
}

const usage = { inputTokens: 2000, cachedInputTokens: 8000, cacheWriteTokens: 0, outputTokens: 600 };

describe("routing, escalation and cost", () => {
  it("escalates to T2 after two invalid tool calls", async () => {
    const app = createOutcry();
    const user = app.users.create({ badge: "A", jacket: "swaps", residence: "CH" });
    const t1 = new ScriptedProvider((_r, n) => ({ content: [{ type: "tool_use", id: `x${n}`, name: "propose_order", input: { legs: [{ side: "buy" }] } }], stopReason: "tool_use", usage, model: "t1" }));
    const t2 = new ScriptedProvider((_req, n) => {
      return n > 0
        ? { content: [{ type: "text", text: "Ticket ready." }], stopReason: "end_turn", usage, model: "t2" }
        : { content: [{ type: "tool_use", id: "ok", name: "propose_order", input: { legs: [{ side: "buy", asset: "SOL", amount: 50 }] } }], stopReason: "tool_use", usage, model: "t2" };
    });
    const router = new ModelRouter({ providers: { openrouter: t1, anthropic: t2 } });
    const orch = new Orchestrator(app, router);
    const r = await orch.handle(user.id, "s", "buy some sol");
    expect(r.meta.escalated).toBe(true);
    expect(r.meta.tier).toBe("T2");
    expect(r.cards.some((c) => c.type === "order")).toBe(true);
    expect(t2.calls.length).toBeGreaterThan(0);
  });

  it("prices a cached T1 order turn at about half a cent", () => {
    const router = new ModelRouter({ providers: {} });
    const c = costUsd(usage, router.tiers.T1.price);
    expect(c).toBeCloseTo(0.0043, 3);
    const opusUncached = costUsd({ inputTokens: 10_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 600 }, router.tiers.T2.price);
    expect(opusUncached).toBeCloseTo(0.052, 3);
  });

  it("marks token data as untrusted before it reaches the model", async () => {
    const { app, user, orch } = offlineSetup();
    app.market.spawnMeme("EVIL", {});
    const out = await orch.tools.run(user.id, "get_token_risk", { token: "EVIL" });
    expect(orch.tools.wrapForModel("get_token_risk", out)).toMatch(/^<untrusted_data>/);
  });
});
