/**
 * Small infrastructure pieces shared by every module: ids, an event bus,
 * and a hash-chained, append-only audit log.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { customAlphabet } from "nanoid";

const alphabet = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);
export const newId = (prefix: string) => `${prefix}_${alphabet()}`;
export const nowIso = () => new Date().toISOString();
export const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

/** Typed events pushed to clients over the websocket. */
export type OutcryEvent =
  | { type: "ticket.updated"; userId: string; ticketId: string; status: string }
  | { type: "fill"; userId: string; ticketId: string; summary: string }
  | { type: "agent.activity"; userId: string; agentId: string; message: string }
  | { type: "agent.state"; userId: string; agentId: string; state: string }
  | { type: "agent.proposal"; userId: string; agentId: string; ticketId: string }
  | { type: "balances"; userId: string; balances: Record<string, number> };

export class EventBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(1000);
  }
  publish(event: OutcryEvent) {
    this.emitter.emit("event", event);
  }
  subscribe(fn: (e: OutcryEvent) => void): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }
}

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string; // "user:<id>", "agent:<id>", "system"
  action: string;
  data: unknown;
  prevHash: string;
  hash: string;
}

/**
 * Append-only audit log. Each entry commits to the previous entry's hash, so
 * any edit or deletion is detectable by `verify()`. In production this is a
 * Postgres table with the same columns; here it is in memory.
 */
export class AuditLog {
  private entries: AuditEntry[] = [];

  append(actor: string, action: string, rawData: unknown): AuditEntry {
    // Snapshot the data: later mutations of the caller's objects must not
    // change what was logged (and would break the hash chain).
    const data = rawData === undefined ? null : JSON.parse(JSON.stringify(rawData));
    const prevHash = this.entries.at(-1)?.hash ?? "genesis";
    const seq = this.entries.length;
    const at = nowIso();
    const hash = createHash("sha256")
      .update(JSON.stringify({ seq, at, actor, action, data, prevHash }))
      .digest("hex");
    const entry: AuditEntry = { seq, at, actor, action, data, prevHash, hash };
    this.entries.push(entry);
    return entry;
  }

  query(filter: (e: AuditEntry) => boolean, limit = 100): AuditEntry[] {
    return this.entries.filter(filter).slice(-limit);
  }

  verify(): boolean {
    let prev = "genesis";
    for (const e of this.entries) {
      const expect = createHash("sha256")
        .update(JSON.stringify({ seq: e.seq, at: e.at, actor: e.actor, action: e.action, data: e.data, prevHash: prev }))
        .digest("hex");
      if (e.prevHash !== prev || e.hash !== expect) return false;
      prev = e.hash;
    }
    return true;
  }

  /** Test hook: simulate tampering. */
  _tamper(seq: number, data: unknown) {
    const e = this.entries[seq];
    if (e) e.data = data;
  }
}
