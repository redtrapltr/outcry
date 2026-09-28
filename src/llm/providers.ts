/**
 * LLM providers.
 *
 * AnthropicProvider   -> Claude (T2 frontier tier). Prompt caching is applied
 *                        to the system prompt and tool list, which are
 *                        identical across turns (~8k tokens).
 * OpenAICompatProvider-> any OpenAI-compatible endpoint: OpenRouter (BYOK),
 *                        a LiteLLM gateway, Google's OpenAI-compatible Gemini
 *                        endpoint, DeepSeek. Used for T0/T1.
 *
 * Both are thin HTTP clients with no SDK dependency, so the gateway choice
 * stays a config change.
 */
import type { ChatRequest, ChatResponse, ContentBlock, ModelProvider } from "./types.js";

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  constructor(private apiKey: string, private baseUrl = "https://api.anthropic.com", private fetchImpl: typeof fetch = fetch) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const tools = req.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      // Cache breakpoint on the last tool caches the whole tool list.
      ...(i === req.tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    }));
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: req.messages,
      tools,
    };
    if (req.thinkingBudget > 0) body.thinking = { type: "enabled", budget_tokens: req.thinkingBudget };

    const send = (b: Record<string, unknown>) =>
      this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(b),
      });
    let res = await send(body);
    if (!res.ok && res.status === 400 && body.thinking) {
      // Some models or accounts reject the thinking parameter: retry once without it,
      // stripping thinking blocks from earlier assistant turns of this tool loop.
      const text = await res.text();
      if (/thinking/i.test(text)) {
        console.warn(`[outcry] ${req.model} rejected extended thinking, retrying without it: ${text.slice(0, 200)}`);
        const { thinking: _t, ...rest } = body;
        const messages = req.messages.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.filter((c) => c.type !== "thinking" && c.type !== "redacted_thinking") } : m));
        res = await send({ ...rest, messages });
      } else {
        throw new Error(`Anthropic 400: ${text.slice(0, 300)}`);
      }
    }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = (await res.json()) as {
      content: ({ type: string; text?: string; id?: string; name?: string; input?: unknown; thinking?: string; signature?: string; data?: string })[];
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      model: string;
    };
    const content: ContentBlock[] = [];
    for (const b of j.content) {
      if (b.type === "text" && b.text) content.push({ type: "text", text: b.text });
      if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id!, name: b.name!, input: b.input });
      // Thinking blocks are kept for the rest of this turn's tool loop (the API
      // requires them back unchanged); the orchestrator drops them from history.
      if (b.type === "thinking") content.push({ type: "thinking", thinking: b.thinking ?? "", signature: b.signature ?? "" });
      if (b.type === "redacted_thinking") content.push({ type: "redacted_thinking", data: b.data ?? "" });
    }
    return {
      content,
      stopReason: j.stop_reason === "tool_use" ? "tool_use" : j.stop_reason === "end_turn" ? "end_turn" : j.stop_reason === "max_tokens" ? "max_tokens" : "other",
      usage: {
        inputTokens: j.usage.input_tokens,
        outputTokens: j.usage.output_tokens,
        cachedInputTokens: j.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: j.usage.cache_creation_input_tokens ?? 0,
      },
      model: j.model,
    };
  }
}

export class OpenAICompatProvider implements ModelProvider {
  constructor(
    readonly name: string,
    private apiKey: string,
    private baseUrl: string, // e.g. https://openrouter.ai/api/v1
    private fetchImpl: typeof fetch = fetch,
    private extraHeaders: Record<string, string> = {},
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // Map Anthropic-style blocks to OpenAI chat messages.
    const messages: Record<string, unknown>[] = [{ role: "system", content: req.system }];
    for (let m of req.messages) {
      if (Array.isArray(m.content)) m = { ...m, content: m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking") };
      if (typeof m.content === "string") {
        messages.push({ role: m.role, content: m.content });
        continue;
      }
      const text = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      const calls = m.content.filter((b) => b.type === "tool_use") as Extract<ContentBlock, { type: "tool_use" }>[];
      const results = m.content.filter((b) => b.type === "tool_result") as Extract<ContentBlock, { type: "tool_result" }>[];
      if (m.role === "assistant") {
        messages.push({
          role: "assistant",
          content: text || null,
          ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}),
        });
      } else {
        for (const r of results) messages.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.content });
        if (text) messages.push({ role: "user", content: text });
      }
    }
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, ...this.extraHeaders },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        messages,
        tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      }),
    });
    if (!res.ok) throw new Error(`${this.name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = (await res.json()) as {
      choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string }[];
      usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } };
      model: string;
    };
    const msg = j.choices[0]!.message;
    const content: ContentBlock[] = [];
    if (msg.content) content.push({ type: "text", text: msg.content });
    for (const c of msg.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(c.function.arguments || "{}");
      } catch {
        input = { _unparseable: c.function.arguments };
      }
      content.push({ type: "tool_use", id: c.id, name: c.function.name, input });
    }
    const cached = j.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      content,
      stopReason: (msg.tool_calls?.length ?? 0) > 0 ? "tool_use" : j.choices[0]!.finish_reason === "length" ? "max_tokens" : "end_turn",
      usage: { inputTokens: (j.usage?.prompt_tokens ?? 0) - cached, cachedInputTokens: cached, cacheWriteTokens: 0, outputTokens: j.usage?.completion_tokens ?? 0 },
      model: j.model,
    };
  }
}
