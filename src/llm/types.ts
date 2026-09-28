/**
 * Provider-neutral LLM types. Messages and tool calls follow the shape both
 * Anthropic's Messages API and OpenAI-compatible chat APIs can map onto.
 */

export type Tier = "T0" | "T1" | "T2";

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Write tools create tickets/agents and never execute directly. */
  kind: "read" | "write";
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  maxTokens: number;
  /** Extended thinking budget; 0 disables it. */
  thinkingBudget: number;
}

export interface ChatResponse {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "other";
  usage: Usage;
  model: string;
}

export interface ModelProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface ModelPrice {
  /** USD per 1M tokens */
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export interface TierConfig {
  provider: string;
  model: string;
  fallback?: { provider: string; model: string };
  price: ModelPrice;
  maxTokens: number;
  thinkingBudget: number;
}

export function costUsd(u: Usage, p: ModelPrice): number {
  return (
    (u.inputTokens * p.input + u.cachedInputTokens * p.cachedInput + u.cacheWriteTokens * p.cacheWrite + u.outputTokens * p.output) /
    1_000_000
  );
}
