/**
 * Model router: picks the cheapest tier that can handle a turn.
 *
 * T0 is a local classifier (free). T1 handles clear orders and launches.
 * T2 (frontier) handles agents, strategies, research, large or ambiguous
 * orders, and anything T1 fails to turn into a valid ticket twice.
 */
import { classify, OfflineProvider, type Intent } from "./offline.js";
import { AnthropicProvider, OpenAICompatProvider } from "./providers.js";
import { costUsd, type ModelProvider, type Tier, type TierConfig, type Usage } from "./types.js";

/** Prices from the architecture doc (BenchLM / CloudZero, Sept 2026). Verify before contracting. */
export const DEFAULT_TIERS: Record<Tier, TierConfig> = {
  T0: { provider: "openrouter", model: "qwen/qwen3.7-flash", price: { input: 0.03, cachedInput: 0.03, cacheWrite: 0.03, output: 0.13 }, maxTokens: 400, thinkingBudget: 0 },
  T1: { provider: "openrouter", model: "google/gemini-3.8-flash", fallback: { provider: "openrouter", model: "deepseek/deepseek-v4-pro" }, price: { input: 0.75, cachedInput: 0.07, cacheWrite: 0.75, output: 3.75 }, maxTokens: 1_500, thinkingBudget: 0 },
  T2: { provider: "anthropic", model: "claude-opus-5-5", fallback: { provider: "openrouter", model: "openai/gpt-6-astra" }, price: { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 }, maxTokens: 8_000, thinkingBudget: 4_000 },
};

export interface RouteDecision {
  tier: Tier;
  intent: Intent;
  reason: string;
}

export interface RouterOptions {
  providers: Record<string, ModelProvider>;
  tiers?: Record<Tier, TierConfig>;
}

export class ModelRouter {
  readonly tiers: Record<Tier, TierConfig>;
  private spend = new Map<string, { usd: number; turns: number; byTier: Record<Tier, number> }>();

  constructor(private opts: RouterOptions) {
    this.tiers = opts.tiers ?? DEFAULT_TIERS;
  }

  /** Build providers from environment variables; falls back to offline. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ModelRouter {
    const providers: Record<string, ModelProvider> = { offline: new OfflineProvider() };
    if (env.ANTHROPIC_API_KEY) providers.anthropic = new AnthropicProvider(env.ANTHROPIC_API_KEY);
    if (env.OPENROUTER_API_KEY) providers.openrouter = new OpenAICompatProvider("openrouter", env.OPENROUTER_API_KEY, env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1");
    if (env.LLM_GATEWAY_URL && env.LLM_GATEWAY_KEY) providers.gateway = new OpenAICompatProvider("gateway", env.LLM_GATEWAY_KEY, env.LLM_GATEWAY_URL);
    const tiers = structuredClone(DEFAULT_TIERS);
    for (const t of ["T0", "T1", "T2"] as Tier[]) {
      const m = env[`OUTCRY_${t}_MODEL`];
      const p = env[`OUTCRY_${t}_PROVIDER`];
      if (m) tiers[t].model = m;
      if (p) tiers[t].provider = p;
    }
    return new ModelRouter({ providers, tiers });
  }

  route(text: string, opts: { orderUsdEstimate?: number; escalateAboveUsd: number; previousFailures?: number }): RouteDecision {
    const intent = classify(text);
    if ((opts.previousFailures ?? 0) >= 2) return { tier: "T2", intent, reason: "T1 failed validation twice" };
    switch (intent) {
      case "agent":
      case "strategy":
      case "research":
      case "explain":
        return { tier: "T2", intent, reason: `${intent} needs frontier reasoning` };
      case "order":
        if ((opts.orderUsdEstimate ?? 0) > opts.escalateAboveUsd) return { tier: "T2", intent, reason: "large order" };
        return { tier: "T1", intent, reason: "clear order" };
      case "launch":
      case "control":
      case "portfolio":
        return { tier: "T1", intent, reason: intent };
      case "refuse":
        return { tier: "T1", intent, reason: "policy refusal" };
      default:
        return { tier: "T0", intent, reason: "small talk" };
    }
  }

  /** Provider for a tier, falling back to its fallback and then offline. */
  providerFor(tier: Tier): { provider: ModelProvider; model: string; tierCfg: TierConfig; offline: boolean } {
    const cfg = this.tiers[tier];
    const p = this.opts.providers[cfg.provider];
    if (p) return { provider: p, model: cfg.model, tierCfg: cfg, offline: false };
    if (cfg.fallback) {
      const f = this.opts.providers[cfg.fallback.provider];
      if (f) return { provider: f, model: cfg.fallback.model, tierCfg: cfg, offline: false };
    }
    return { provider: this.opts.providers.offline ?? new OfflineProvider(), model: "offline", tierCfg: cfg, offline: true };
  }

  record(userId: string, tier: Tier, usage: Usage): number {
    const cost = costUsd(usage, this.tiers[tier].price);
    const s = this.spend.get(userId) ?? { usd: 0, turns: 0, byTier: { T0: 0, T1: 0, T2: 0 } };
    s.usd += cost;
    s.turns += 1;
    s.byTier[tier] += cost;
    this.spend.set(userId, s);
    return cost;
  }

  spendOf(userId: string) {
    return this.spend.get(userId) ?? { usd: 0, turns: 0, byTier: { T0: 0, T1: 0, T2: 0 } };
  }
}
