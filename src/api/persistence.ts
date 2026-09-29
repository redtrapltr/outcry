/**
 * Wires every stateful service into the snapshot store: restore on boot,
 * save every few seconds when something changed, and once more on shutdown.
 */
import type { Outcry } from "../app.js";
import { decode, encode, restore, snapshot, type StateStore } from "../core/persist.js";
import type { ModelRouter } from "../llm/router.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { AuthService } from "./auth.js";

export class Persistence {
  private lastState = "";
  private lastSeq = 0;
  private timer?: ReturnType<typeof setInterval>;
  private saving: Promise<void> | undefined;
  lastSavedAt?: string;
  lastError?: string;

  constructor(
    readonly store: StateStore,
    private app: Outcry,
    private parts: { router: ModelRouter; orch: Orchestrator; sessions: Map<string, string>; transcripts?: Map<string, unknown>; auth?: AuthService },
  ) {}

  private holders() {
    const a = this.app;
    return {
      users: { obj: a.users, fields: ["users", "mainWalletIds", "positions"] },
      desk: { obj: a.desk, fields: ["tickets"] },
      agents: { obj: a.agents, fields: ["agents", "positions", "seenTokens", "pendingTickets", "paperSince", "limitNotified", "history", "trades", "startUsd"] },
      lab: { obj: a.lab, fields: ["strategies"] },
      registry: { obj: a.registry, fields: ["byMint"] },
      launches: { obj: a.launches, fields: ["plans"] },
      signer: { obj: a.signer, fields: ["wallets"] },
      market: { obj: a.market, fields: ["memes", "launches"] },
      router: { obj: this.parts.router, fields: ["spend", "daily"] },
      chat: { obj: this.parts.orch, fields: ["sessions"] },
      sessions: { obj: { tokens: this.parts.sessions }, fields: ["tokens"] },
      ...(this.parts.transcripts ? { transcripts: { obj: { lines: this.parts.transcripts }, fields: ["lines"] } } : {}),
      ...(this.parts.auth ? { auth: { obj: this.parts.auth, fields: ["credentials"] } } : {}),
    };
  }

  /** Load the last snapshot. Returns what was restored. */
  async restore() {
    const { state, audit } = await this.store.load();
    if (audit.length) this.app.audit.load(audit);
    this.lastSeq = this.app.audit.length;
    if (state) {
      restore(this.holders(), decode(state));
      this.lastState = state;
    }
    return { users: (this.app.users as unknown as { users: Map<string, unknown> }).users.size, agents: this.app.agents.agents.size, auditEntries: audit.length };
  }

  async flush(): Promise<void> {
    if (this.saving) return this.saving;
    const run = this.doFlush();
    this.saving = run;
    try {
      await run;
    } finally {
      if (this.saving === run) this.saving = undefined;
    }
  }

  private async doFlush() {
    await Promise.resolve(); // always async, so `saving` is set before we finish
    try {
      const state = encode(snapshot(this.holders()));
      const seq = this.app.audit.length;
      if (state === this.lastState && seq === this.lastSeq) return;
      await this.store.save(state, this.app.audit.since(this.lastSeq));
      this.lastState = state;
      this.lastSeq = seq;
      this.lastSavedAt = new Date().toISOString();
      this.lastError = undefined;
    } catch (e) {
      this.lastError = (e as Error).message;
      console.error("[outcry] save failed:", this.lastError);
    }
  }

  start(everyMs = 5_000) {
    this.timer = setInterval(() => void this.flush(), everyMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
    await this.store.close?.();
  }

  status() {
    return { store: this.store.kind, lastSavedAt: this.lastSavedAt ?? null, lastError: this.lastError ?? null };
  }
}
