/**
 * Conversation orchestrator: one chat turn from message to reply + cards.
 *
 *   route (T0, free) -> model loop with typed tools (T1 or T2)
 *   -> write tools produce cards (tickets, agent drafts, strategies)
 *   -> the client renders cards; signing happens through separate API calls.
 */
import type { Outcry } from "../app.js";
import type { ModelRouter } from "../llm/router.js";
import { SYSTEM_PROMPT, TOOLS } from "../llm/tools.js";
import type { ChatMessage, ContentBlock, ModelProvider, Tier } from "../llm/types.js";
import { ToolExecutor, type Card } from "./tools-exec.js";

export interface TurnResult {
  reply: string;
  cards: Card[];
  meta: { tier: Tier; intent: string; model: string; costUsd: number; toolCalls: string[]; escalated: boolean; notice?: string };
}

interface Session {
  id: string;
  userId: string;
  history: ChatMessage[];
  summary: string;
}

const MAX_ITERATIONS = 6;
const KEEP_MESSAGES = 12; // last ~6 turns; older turns roll into the summary

/** Phrases that tell the user a ticket exists and can be signed. */
const CLAIMS_TICKET = /ticket (is )?(ready|created|prepared)|ticket for .{0,60}(is|waiting)|tap \**sign|sign (it |them )?(in the app|to (execute|deploy|launch))|waiting for your signature|ready to sign/i;

export class Orchestrator {
  private sessions = new Map<string, Session>();
  readonly tools: ToolExecutor;

  constructor(private app: Outcry, readonly router: ModelRouter) {
    this.tools = new ToolExecutor(app);
  }

  /** Forget a chat's model history. */
  dropSession(userId: string, sessionId: string) {
    this.sessions.delete(`${userId}:${sessionId}`);
  }

  private session(userId: string, sessionId: string): Session {
    const key = `${userId}:${sessionId}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = { id: sessionId, userId, history: [], summary: "" };
      this.sessions.set(key, s);
    }
    return s;
  }

  private context(userId: string, s: Session): string {
    const p = this.app.users.portfolio(userId);
    const agents = this.app.agents.listForUser(userId).filter((a) => a.state !== "killed").map((a) => `${a.spec.name} (${a.state}, ${a.spec.mode})`);
    return [
      `Wallet: $${p.walletUsd.toFixed(2)}; balances ${Object.entries(p.balances).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${+v.toFixed(4)}`).join(", ")}.`,
      agents.length ? `Agents: ${agents.join(", ")}.` : "No agents yet.",
      (() => {
        const pending = this.app.desk.listForUser(userId).filter((t) => t.status === "needs_confirmation" || t.status === "needs_second_confirmation").slice(-5);
        return pending.length
          ? `Tickets waiting for the user's signature (shown in the app's "Waiting for your signature" panel): ${pending.map((t) => `${t.id} ${t.kind === "launch" ? "launch" : (t as { legs?: { side: string; asset: string }[] }).legs?.map((l) => `${l.side} ${l.asset}`).join("+")}`).join("; ")}.`
          : "No tickets are waiting for a signature.";
      })(),
      s.summary ? `Earlier in this session: ${s.summary}` : "",
    ].filter(Boolean).join("\n");
  }

  async handle(userId: string, sessionId: string, text: string): Promise<TurnResult> {
    const s = this.session(userId, sessionId);
    const user = this.app.users.get(userId);
    const cards: Card[] = [];
    const toolCalls: string[] = [];
    let failures = 0;
    let escalated = false;
    let totalCost = 0;

    let route = this.router.route(text, { escalateAboveUsd: user.settings.frontierEscalationUsd, orderUsdEstimate: estimateUsd(text) });
    // Candidates for this tier: primary, fallback, then the offline engine.
    // Over budget, go straight to offline so a public link can't run up costs.
    let notice: string | undefined;
    const candidatesFor = (tier: Tier) => {
      if (this.router.overBudget(userId)) {
        notice = "Daily AI budget reached: answering with the offline engine.";
        return this.router.chainFor(tier).filter((c) => c.offline);
      }
      return this.router.chainFor(tier);
    };
    let candidates = candidatesFor(route.tier);
    let ci = 0;
    let model = candidates[0]!.model;

    const turnMessages: ChatMessage[] = [{ role: "user", content: `${text}\n\n<context>\n${this.context(userId, s)}\n</context>` }];
    let reply = "";
    let corrected = false;

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      let res: Awaited<ReturnType<ModelProvider["chat"]>> | undefined;
      while (!res) {
        const c = candidates[ci]!;
        const messages = c.offline ? turnMessages : [...s.history, ...turnMessages];
        try {
          res = await c.provider.chat({ model: c.model, system: SYSTEM_PROMPT, messages, tools: TOOLS, maxTokens: c.tierCfg.maxTokens, thinkingBudget: c.tierCfg.thinkingBudget });
          model = c.model;
        } catch (e) {
          // Provider down, bad model id, rate limit: try the next candidate.
          const msg = String((e as Error).message).slice(0, 300);
          this.app.audit.append("system", "llm.error", { model: c.model, error: msg });
          this.router.noteError(c.model, msg);
          console.error(`[outcry] ${c.model} failed: ${msg}`);
          if (ci >= candidates.length - 1) throw e;
          ci++;
          notice = candidates[ci]!.offline
            ? "The AI model is unavailable right now: answering with the offline engine."
            : `${c.model} unavailable, answered by ${candidates[ci]!.model}`;
        }
      }
      totalCost += this.router.record(userId, route.tier, res.usage);
      turnMessages.push({ role: "assistant", content: res.content });

      const calls = res.content.filter((b) => b.type === "tool_use") as Extract<ContentBlock, { type: "tool_use" }>[];
      const texts = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
      if (!calls.length) {
        reply = texts.join("\n").trim();
        // Guard: a reply that says a ticket is ready when no ticket was created this turn.
        const madeTicket = cards.some((c) => c.type === "order" || c.type === "launch" || c.type === "live_order");
        const asked = toolCalls.some((n) => n === "propose_order" || n === "propose_launch");
        // An existing unsigned ticket is fine to point at (it's listed in the app); only a ticket that exists nowhere is a problem.
        const anyPending = this.app.desk.listForUser(userId).some((t) => t.status === "needs_confirmation" || t.status === "needs_second_confirmation");
        if (!corrected && !madeTicket && !asked && !anyPending && CLAIMS_TICKET.test(reply)) {
          corrected = true;
          this.app.audit.append("system", "llm.claimed_ticket_without_tool", { model, reply: reply.slice(0, 200) });
          turnMessages.push({ role: "user", content: "System check: your reply says a ticket is ready, but no propose_order or propose_launch call was made in this turn, so the user sees nothing to sign. Call the right tool now to create the ticket. If the user's request does not call for a new ticket, say plainly that nothing new was created." });
          if (route.tier !== "T2") {
            route = { ...route, tier: "T2", reason: "claimed a ticket without creating it" };
            candidates = candidatesFor("T2");
            ci = 0;
            escalated = true;
          }
          continue;
        }
        break;
      }
      const results: ContentBlock[] = [];
      for (const c of calls) {
        toolCalls.push(c.name);
        const out = await this.tools.run(userId, c.name, c.input);
        if (out.card) cards.push(out.card);
        if (out.cards) cards.push(...out.cards);
        if (out.validationError) failures++;
        results.push({ type: "tool_result", tool_use_id: c.id, content: this.tools.wrapForModel(c.name, out), is_error: !out.ok });
      }
      turnMessages.push({ role: "user", content: results });

      // Escalate to the frontier tier after two validation failures.
      if (failures >= 2 && route.tier !== "T2" && !escalated) {
        route = { ...route, tier: "T2", reason: "T1 failed validation twice" };
        candidates = candidatesFor("T2");
        ci = 0;
        escalated = true;
      }
    }
    if (!reply) reply = cards.length ? "Here's what I prepared." : "I couldn't complete that. Try rephrasing with the asset and amount.";

    // Store a compact history: user text + final reply (tool chatter and thinking dropped).
    s.history.push({ role: "user", content: text }, { role: "assistant", content: reply });
    if (s.history.length > KEEP_MESSAGES) {
      const dropped = s.history.splice(0, s.history.length - KEEP_MESSAGES);
      const gist = dropped.filter((m) => m.role === "user").map((m) => String(m.content).slice(0, 60)).join(" | ");
      s.summary = (s.summary ? s.summary + " | " : "") + gist;
      s.summary = s.summary.slice(-800);
    }

    this.app.audit.append(`user:${userId}`, "chat.turn", { sessionId, tier: route.tier, intent: route.intent, model, toolCalls, costUsd: totalCost, escalated });
    return { reply, cards, meta: { tier: route.tier, intent: route.intent, model, costUsd: totalCost, toolCalls, escalated, notice } };
  }
}

function estimateUsd(text: string): number {
  const m = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(usdc|usd|\$)/i) ?? text.match(/\$\s*(\d[\d,]*(?:\.\d+)?)/);
  return m ? Number(m[1]!.replace(/,/g, "")) : 0;
}
