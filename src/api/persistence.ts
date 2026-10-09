/**
 * Wires every stateful service into the snapshot store: restore on boot,
 * save every few seconds when something changed, and once more on shutdown.
 */
import type { Outcry } from "../app.js";
import { decode, encode, restore, snapshot, type StateStore } from "../core/persist.js";
import type { ModelRouter } from "../llm/router.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { AuthService } from "./auth.js";
import type { LivePilot } from "../live/pilot.js";

export class Persistence {
  private lastState = "";
  private lastSeq = 0;
  private timer?: ReturnType<typeof setInterval>;
  private saving: Promise<void> | undefined;
  private savingSince = 0;
  lastSavedAt?: string;
  lastError?: string;
  /** Set when the persisted audit chain was broken at boot and the tail was quarantined. */
  auditRepair?: { brokenAtSeq: number; quarantined: number; at: string };
  private fenced = false;
  readonly instanceId = `inst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  constructor(
    readonly store: StateStore,
    private app: Outcry,
    private parts: { router: ModelRouter; orch: Orchestrator; sessions: Map<string, string>; transcripts?: Map<string, unknown>; recaps?: Map<string, unknown>; auth?: AuthService; live?: LivePilot },
  ) {}

  private holders() {
    const a = this.app;
    return {
      users: { obj: a.users, fields: ["users", "mainWalletIds", "positions"] },
      desk: { obj: a.desk, fields: ["tickets"] },
      agents: { obj: a.agents, fields: ["agents", "positions", "seenTokens", "pendingTickets", "paperSince", "limitNotified", "history", "trades", "startUsd"] },
      lab: { obj: a.lab, fields: ["strategies"] },
      marketplace: { obj: a.marketplace, fields: ["listings", "subs"] },
      growth: { obj: a.growth, fields: ["volume", "rebates", "referralRewards", "referredBy", "access"] },
      registry: { obj: a.registry, fields: ["byMint"] },
      launches: { obj: a.launches, fields: ["plans"] },
      signer: { obj: a.signer, fields: ["wallets"] },
      market: { obj: a.market, fields: ["memes", "launches"] },
      router: { obj: this.parts.router, fields: ["spend", "daily"] },
      chat: { obj: this.parts.orch, fields: ["sessions"] },
      sessions: { obj: { tokens: this.parts.sessions }, fields: ["tokens"] },
      ...(this.parts.transcripts ? { transcripts: { obj: { lines: this.parts.transcripts }, fields: ["lines"] } } : {}),
      ...(this.parts.recaps ? { recaps: { obj: { items: this.parts.recaps }, fields: ["items"] } } : {}),
      ...(this.parts.auth ? { auth: { obj: this.parts.auth, fields: ["credentials"] } } : {}),
      ...(this.parts.live ? { live: { obj: this.parts.live, fields: ["trades", "withdrawals"] }, liveWallets: { obj: this.parts.live.wallets, fields: ["wallets"] } } : {}),
    };
  }

  /** Load the last snapshot. Returns what was restored. */
  async restore() {
    const { state, audit } = await this.store.load();
    // Take over as the only writer first: an older instance still running during a deploy stops saving.
    await this.store.claim(this.instanceId);
    if (audit.length) {
      const broken = this.app.audit.loadValidPrefix(audit);
      if (broken !== undefined) {
        // Never refuse to start over a broken log: keep the valid part, set the rest aside, say so.
        const quarantined = await this.store.quarantine(broken);
        this.auditRepair = { brokenAtSeq: broken, quarantined, at: new Date().toISOString() };
        console.error(`[outcry] audit chain broken at seq ${broken}; ${quarantined} entries moved to quarantine`);
        this.app.audit.append("system", "audit.repaired", { brokenAtSeq: broken, quarantined });
      }
    }
    this.lastSeq = this.auditRepair ? this.app.audit.length - 1 : this.app.audit.length;
    if (state) {
      restore(this.holders(), decode(state));
      this.lastState = state;
    }
    return { users: (this.app.users as unknown as { users: Map<string, unknown> }).users.size, agents: this.app.agents.agents.size, auditEntries: audit.length };
  }

  async flush(): Promise<void> {
    if (this.saving) {
      // Watchdog: a save that never returns must not stop all future saves.
      if (Date.now() - this.savingSince < 120_000) return this.saving;
      this.lastError = "A save hung for over 2 minutes and was abandoned";
      console.error("[outcry] save hung; abandoning it");
      this.saving = undefined;
    }
    const run = this.doFlush();
    this.saving = run;
    this.savingSince = Date.now();
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
      if (this.fenced) return;
      const ok = await this.store.save(state, this.app.audit.since(this.lastSeq), this.instanceId);
      if (!ok) {
        this.fenced = true;
        if (this.timer) clearInterval(this.timer);
        this.lastError = "A newer instance took over (deploy); this one stopped saving";
        console.warn("[outcry] fenced by a newer instance; no longer saving");
        return;
      }
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
    return { store: this.store.kind, lastSavedAt: this.lastSavedAt ?? null, lastError: this.lastError ?? null, ...(this.saving ? { savingForSec: Math.round((Date.now() - this.savingSince) / 1000) } : {}), ...(this.auditRepair ? { auditRepair: this.auditRepair } : {}) };
  }
}
