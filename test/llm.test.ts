import { describe, expect, it } from "vitest";
import { createOutcry } from "../src/app.js";
import { AnthropicProvider } from "../src/llm/providers.js";
import { ModelRouter } from "../src/llm/router.js";
import { OfflineProvider } from "../src/llm/offline.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import type { ModelProvider } from "../src/llm/types.js";

/** A fake Anthropic Messages API that enforces the thinking + tool-use contract. */
function fakeAnthropic() {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (!init.headers["x-api-key"]) return new Response("no key", { status: 401 });
    const last = body.messages.at(-1);
    const isToolResult = Array.isArray(last.content) && last.content.some((b: { type: string }) => b.type === "tool_result");
    if (isToolResult) {
      // Real API rejects a tool_result turn whose previous assistant turn lost its thinking block.
      const prev = body.messages.at(-2);
      if (body.thinking && !prev.content.some((b: { type: string }) => b.type === "thinking")) {
        return new Response(JSON.stringify({ error: "thinking block missing" }), { status: 400 });
      }
      return Response.json({
        content: [{ type: "text", text: "SNIPER is ready. Tune it, then deploy it in paper mode." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 8000 },
        model: body.model,
      });
    }
    return Response.json({
      content: [
        { type: "thinking", thinking: "The user wants a sniper agent...", signature: "sig123" },
        {
          type: "tool_use", id: "toolu_1", name: "propose_agent",
          input: { name: "SNIPER", markets: ["memes"], kind: "sniper", universe: { minHolders: 250 }, sizeUsd: 20, exit: { stopLossPct: 30, takeProfitPct: 100 }, limits: { maxPerTradeUsd: 20, maxPerDayUsd: 60, maxOpenPositions: 3, maxDrawdownPct: 30 } },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 2000, output_tokens: 700, cache_creation_input_tokens: 8000 },
      model: body.model,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

describe("Claude integration (mocked API)", () => {
  it("sends thinking blocks back during the tool loop and caches the prompt", async () => {
    const app = createOutcry();
    const user = app.users.create({ badge: "A", jacket: "memes", residence: "CH" });
    const api = fakeAnthropic();
    const router = new ModelRouter({ providers: { anthropic: new AnthropicProvider("test-key", "https://x", api.fetchImpl), offline: new OfflineProvider() } });
    const orch = new Orchestrator(app, router);
    const r = await orch.handle(user.id, "s", "build me an agent that snipes new memes");
    expect(r.meta.model).toBe("claude-opus-5-5");
    expect(r.meta.notice).toBeUndefined();
    expect(r.cards.some((c) => c.type === "agent")).toBe(true);
    expect(r.reply).toMatch(/SNIPER is ready/);
    const first = api.requests[0] as { system: { cache_control?: unknown }[]; tools: { cache_control?: unknown }[]; thinking?: unknown };
    expect(first.system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(first.tools.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    expect(first.thinking).toEqual({ type: "enabled", budget_tokens: 4000 });
    expect(r.meta.costUsd).toBeGreaterThan(0);
  });

  it("falls back to the offline engine when the model API fails", async () => {
    const app = createOutcry();
    const user = app.users.create({ badge: "A", jacket: "memes", residence: "CH" });
    const broken: ModelProvider = { name: "anthropic", chat: async () => { throw new Error("529 overloaded"); } };
    const router = new ModelRouter({ providers: { anthropic: broken, offline: new OfflineProvider() } });
    const r = await new Orchestrator(app, router).handle(user.id, "s", "build me an agent that snipes new memes");
    expect(r.meta.model).toBe("offline");
    expect(r.meta.notice).toMatch(/unavailable/);
    expect(r.cards.some((c) => c.type === "agent")).toBe(true);
  });

  it("stops paying for models once the daily budget is spent", async () => {
    const app = createOutcry();
    const user = app.users.create({ badge: "A", jacket: "memes", residence: "CH" });
    const api = fakeAnthropic();
    const router = new ModelRouter({
      providers: { anthropic: new AnthropicProvider("k", "https://x", api.fetchImpl), offline: new OfflineProvider() },
      budgets: { perUserDailyUsd: 0.01, globalDailyUsd: 100 },
    });
    const orch = new Orchestrator(app, router);
    await orch.handle(user.id, "s", "build me an agent that snipes new memes");
    const calls = api.requests.length;
    const r2 = await orch.handle(user.id, "s", "build me a careful agent that snipes new tokens");
    expect(api.requests.length).toBe(calls);
    expect(r2.meta.notice).toMatch(/budget/);
  });

  it("runs every tier on Claude when only an Anthropic key is set", () => {
    const router = ModelRouter.fromEnv({ ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv);
    expect(router.providerFor("T1").model).toBe("claude-haiku-4-5-20251001");
    expect(router.providerFor("T2").model).toBe("claude-opus-5-5");
    expect(router.budgets.perUserDailyUsd).toBe(0.5);
    const withPlaceholder = ModelRouter.fromEnv({ ANTHROPIC_API_KEY: "sk-ant-xxxxxxxxxxxx", OPENROUTER_API_KEY: "none" } as NodeJS.ProcessEnv);
    expect(withPlaceholder.providerFor("T1").model).toBe("claude-haiku-4-5-20251001");
  });
});
