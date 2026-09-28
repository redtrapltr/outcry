/**
 * Ticket desk: turns proposed legs into quoted, policy-checked tickets, and
 * executes them only after approval. This is the single path to the signer
 * for users and agents alike.
 */
import { AuditLog, EventBus, newId, nowIso } from "../core/infra.js";
import type { Agent, Jacket, OrderLeg, OrderTicket, QuotedLeg, Ticket, TicketSource } from "../core/types.js";
import type { UserStore } from "../core/users.js";
import type { MarketData } from "../data/market.js";
import type { ExecutionRouter } from "../adapters/router.js";
import { evaluateOrder, DEFAULT_POLICY, type PolicyConfig } from "../policy/engine.js";
import { PolicyDenied, type Signer } from "../wallet/signer.js";

export interface DeskDeps {
  market: MarketData;
  users: UserStore;
  signer: Signer;
  exec: ExecutionRouter;
  audit: AuditLog;
  bus: EventBus;
  platformFeeBps: number;
  policy?: PolicyConfig;
  /** Resolves an agent by id (provided by the agent runtime). */
  getAgent?: (agentId: string) => Agent | undefined;
}

export interface ApproveOptions {
  /** Passkey assertion id from the client (user approvals). */
  userApproval?: string;
  secondConfirmation?: boolean;
}

export class TicketDesk {
  readonly tickets = new Map<string, Ticket>();
  constructor(private d: DeskDeps) {}

  get(id: string): Ticket {
    const t = this.tickets.get(id);
    if (!t) throw new Error("Ticket not found");
    return t;
  }

  listForUser(userId: string, limit = 50): Ticket[] {
    return [...this.tickets.values()].filter((t) => t.userId === userId).slice(-limit).reverse();
  }

  /** Balances the ticket spends from: the user's main wallet or an agent's sub-wallet. */
  private book(t: { userId: string; source: TicketSource }) {
    if (t.source.type === "agent") {
      const agent = this.d.getAgent?.(t.source.agentId);
      if (!agent) throw new Error("Agent not found");
      return {
        balances: agent.balances,
        apply: (deltas: Record<string, number>) => {
          for (const [k, v] of Object.entries(deltas)) agent.balances[k] = (agent.balances[k] ?? 0) + v;
        },
        walletId: agent.subWalletId,
        agent,
      };
    }
    const user = this.d.users.get(t.userId);
    return {
      balances: user.balances,
      apply: (deltas: Record<string, number>) => this.d.users.applyDeltas(t.userId, deltas),
      walletId: this.d.users.mainWalletId(t.userId),
      agent: undefined,
    };
  }

  private jacketFor(legs: OrderLeg[]): Jacket {
    const first = legs[0];
    if (!first) return "swaps";
    const a = this.d.market.asset(first.asset);
    if (a?.kind === "tokenized_stock") return "stocks";
    if (a && this.d.market.tokenRisk(a.symbol)) return "memes";
    return "swaps";
  }

  async proposeOrder(input: { userId: string; legs: OrderLeg[]; source?: TicketSource; jacket?: Jacket }): Promise<OrderTicket> {
    const source = input.source ?? { type: "user" as const };
    const now = nowIso();
    const ticket: OrderTicket = {
      kind: "order",
      id: newId("tkt"),
      userId: input.userId,
      source,
      jacket: input.jacket ?? (source.type === "agent" ? "strategies" : this.jacketFor(input.legs)),
      status: "proposed",
      createdAt: now,
      updatedAt: now,
      notes: [],
      warnings: [],
      fills: [],
      legs: [],
      totalUsd: 0,
    };
    this.tickets.set(ticket.id, ticket);
    const actor = source.type === "agent" ? `agent:${source.agentId}` : `user:${input.userId}`;

    try {
      if (input.legs.length === 0 || input.legs.length > 6) throw new Error("A ticket needs 1 to 6 legs");
      const book = this.book(ticket);
      const running = { ...book.balances };
      for (const raw of input.legs) {
        const venue = this.d.exec.venueFor(raw);
        const adapter = this.d.exec.adapterFor(venue);
        const q: QuotedLeg = await adapter.quote({ ...raw, venue }, { userId: input.userId, platformFeeBps: this.d.platformFeeBps });
        const sim = await adapter.simulate(q, running);
        if (!sim.ok) throw new Error(sim.error ?? "Simulation failed");
        for (const [k, v] of Object.entries(sim.deltas)) running[k] = (running[k] ?? 0) + v;
        ticket.legs.push(q);
        const usd = q.side === "buy" ? q.amount * this.d.market.priceUsd(q.quoteAsset) : q.amount * this.d.market.priceUsd(q.asset);
        ticket.totalUsd += usd;
      }

      const verdict = evaluateOrder(
        ticket,
        { user: this.d.users.get(input.userId), walletUsd: this.d.users.walletUsd(input.userId), agent: book.agent },
        this.d.market,
        this.d.policy ?? DEFAULT_POLICY,
      );
      if (verdict.decision === "reject") {
        this.setStatus(ticket, "rejected", verdict.reason);
      } else {
        ticket.warnings = verdict.warnings;
        ticket.notes = verdict.notes;
        if (verdict.decision === "second_confirmation") {
          ticket.warnings.unshift(verdict.reason);
          this.setStatus(ticket, "needs_second_confirmation");
        } else {
          this.setStatus(ticket, "needs_confirmation");
        }
      }
    } catch (e) {
      this.setStatus(ticket, "rejected", (e as Error).message);
    }
    this.d.audit.append(actor, "ticket.proposed", { ticketId: ticket.id, status: ticket.status, legs: ticket.legs, rejection: ticket.rejection });
    return ticket;
  }

  /**
   * Execute an approved ticket. Users approve with a passkey assertion;
   * agents approve inside their limits (the sub-wallet policy re-checks).
   */
  async approve(ticketId: string, opts: ApproveOptions = {}): Promise<OrderTicket> {
    const t = this.get(ticketId);
    if (t.kind !== "order") throw new Error("Use the launch service for launch tickets");
    if (t.status === "needs_second_confirmation" && !opts.secondConfirmation) {
      throw new Error("This ticket needs a second confirmation");
    }
    if (t.status !== "needs_confirmation" && t.status !== "needs_second_confirmation") {
      throw new Error(`Ticket is ${t.status}; it can't be signed`);
    }
    const isAgent = t.source.type === "agent";
    if (!isAgent && !opts.userApproval) throw new Error("Missing passkey approval");

    const book = this.book(t);
    const actor = isAgent ? `agent:${(t.source as { agentId: string }).agentId}` : `user:${t.userId}`;
    this.setStatus(t, "approved");
    this.d.audit.append(actor, "ticket.approved", { ticketId: t.id, secondConfirmation: !!opts.secondConfirmation });

    try {
      for (const [i, leg] of t.legs.entries()) {
        const adapter = this.d.exec.adapterFor(leg.venue);
        const usd = leg.side === "buy" ? leg.amount * this.d.market.priceUsd(leg.quoteAsset) : leg.amount * this.d.market.priceUsd(leg.asset);
        const sig = this.d.signer.sign({
          walletId: book.walletId,
          venue: leg.venue,
          usd,
          kind: "trade",
          side: leg.side,
          userApproval: opts.userApproval,
          agentId: isAgent ? (t.source as { agentId: string }).agentId : undefined,
          payload: { ticketId: t.id, leg: i },
        });
        this.setStatus(t, "submitted");
        const fill = await adapter.submit(leg, sig);
        const deltas = leg.side === "buy"
          ? { [leg.quoteAsset]: -fill.amountIn, [leg.asset]: fill.amountOut }
          : { [leg.asset]: -fill.amountIn, [leg.quoteAsset]: fill.amountOut };
        book.apply(deltas);
        if (!isAgent) {
          if (leg.side === "buy") this.d.users.recordBuy(t.userId, leg.asset, fill.amountOut, usd, t.jacket);
          else this.d.users.recordSell(t.userId, leg.asset, fill.amountIn);
        }
        t.fills.push({ legIndex: i, txId: fill.txId, amountIn: fill.amountIn, amountOut: fill.amountOut, price: fill.price, at: nowIso() });
        this.d.bus.publish({
          type: "fill",
          userId: t.userId,
          ticketId: t.id,
          agentId: t.source.type === "agent" ? (t.source as { agentId?: string }).agentId : undefined,
          summary: `${leg.side.toUpperCase()} ${leg.asset}: ${fmt(fill.amountIn)} ${leg.side === "buy" ? leg.quoteAsset : leg.asset} -> ${fmt(fill.amountOut)} ${leg.side === "buy" ? leg.asset : leg.quoteAsset}`,
        });
      }
      this.setStatus(t, "filled");
      this.d.audit.append(actor, "ticket.filled", { ticketId: t.id, fills: t.fills });
      if (!isAgent) this.d.bus.publish({ type: "balances", userId: t.userId, balances: { ...this.d.users.get(t.userId).balances } });
    } catch (e) {
      const msg = e instanceof PolicyDenied ? `Wallet policy denied: ${e.message}` : (e as Error).message;
      this.setStatus(t, "failed", msg);
      this.d.audit.append(actor, "ticket.failed", { ticketId: t.id, error: msg, partialFills: t.fills.length });
    }
    return t;
  }

  cancel(ticketId: string, userId: string): Ticket {
    const t = this.get(ticketId);
    if (t.userId !== userId) throw new Error("Not your ticket");
    if (!["needs_confirmation", "needs_second_confirmation", "proposed"].includes(t.status)) {
      throw new Error(`Ticket is ${t.status}; it can't be cancelled`);
    }
    this.setStatus(t, "cancelled");
    this.d.audit.append(`user:${userId}`, "ticket.cancelled", { ticketId });
    return t;
  }

  setStatus(t: Ticket, status: Ticket["status"], rejection?: string) {
    t.status = status;
    t.updatedAt = nowIso();
    if (rejection) t.rejection = rejection;
    this.d.bus.publish({ type: "ticket.updated", userId: t.userId, ticketId: t.id, status });
  }
}

export const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toFixed(2) : Math.abs(n) >= 1 ? n.toFixed(4) : n.toPrecision(4));
