/**
 * Transport-neutral API. The Fastify server and the in-browser build both
 * call `handle()`, so the hosted demo and the real server share one code path.
 */
import { z } from "zod";
import type { Outcry } from "../app.js";
import { Jacket } from "../core/types.js";
import type { ModelRouter } from "../llm/router.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { blueprint } from "../orchestrator/tools-exec.js";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface ApiResult {
  status: number;
  json: unknown;
}

export function llmStatus(router: ModelRouter) {
  return (["T0", "T1", "T2"] as const).map((t) => {
    const p = router.providerFor(t);
    return { tier: t, model: p.offline ? "offline intent engine" : p.model, live: !p.offline };
  });
}

const SessionBody = z.object({
  badge: z.string().min(1).max(4).default("YOU"),
  jacket: Jacket.default("memes"),
  residence: z.string().length(2).default("CH"),
});

export function createHandlers(app: Outcry, orch: Orchestrator, router: ModelRouter, newToken: () => string) {
  const tokens = new Map<string, string>();

  const own = <T extends { userId: string }>(x: T | undefined, uid: string, what: string): T => {
    if (!x || x.userId !== uid) throw new HttpError(404, `${what} not found`);
    return x;
  };

  type Handler = (ctx: { uid: string; params: Record<string, string>; body: unknown }) => unknown | Promise<unknown>;
  const routes: { method: string; pattern: RegExp; keys: string[]; auth: boolean; fn: Handler }[] = [];
  const route = (method: string, path: string, fn: Handler, auth = true) => {
    const keys: string[] = [];
    const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    routes.push({ method, pattern, keys, auth, fn });
  };

  // --- session & account ---------------------------------------------------
  route("POST", "/api/session", ({ body }) => {
    const b = SessionBody.parse(body ?? {});
    const user = app.users.create(b);
    const token = newToken();
    tokens.set(token, user.id);
    return { token, user, llm: llmStatus(router) };
  }, false);
  route("GET", "/api/me", ({ uid }) => ({ user: app.users.get(uid), portfolio: app.users.portfolio(uid), usage: router.spendOf(uid), llm: llmStatus(router) }));

  // --- chat -------------------------------------------------------------------
  route("POST", "/api/chat", async ({ uid, body }) => {
    const b = z.object({ sessionId: z.string().default("main"), text: z.string().min(1).max(4_000) }).parse(body);
    return orch.handle(uid, b.sessionId, b.text);
  });

  // --- tickets ------------------------------------------------------------------
  route("GET", "/api/tickets", ({ uid }) => app.desk.listForUser(uid));
  route("GET", "/api/tickets/:id", ({ uid, params }) => own(app.desk.tickets.get(params.id!), uid, "Ticket"));
  route("POST", "/api/tickets/:id/approve", async ({ uid, params, body }) => {
    const b = z.object({ passkeyAssertion: z.string().min(1), secondConfirmation: z.boolean().optional(), disclosureAccepted: z.boolean().optional() }).parse(body);
    const t = own(app.desk.tickets.get(params.id!), uid, "Ticket");
    // TODO(live): verify b.passkeyAssertion with WebAuthn against the user's credential and this ticket's hash.
    if (t.kind === "launch") return app.launches.approve(t.id, { userApproval: b.passkeyAssertion, disclosureAccepted: b.disclosureAccepted });
    return app.desk.approve(t.id, { userApproval: b.passkeyAssertion, secondConfirmation: b.secondConfirmation });
  });
  route("POST", "/api/tickets/:id/cancel", ({ uid, params }) => app.desk.cancel(params.id!, uid));
  route("PATCH", "/api/launch/:id", ({ uid, params, body }) => {
    const b = z.object({ wallets: z.number().int().optional(), solPerWallet: z.number().optional(), name: z.string().optional(), ticker: z.string().optional(), imageDataUrl: z.string().optional() }).parse(body);
    return app.launches.revise(uid, params.id!, b);
  });

  // --- agents ----------------------------------------------------------------------
  route("GET", "/api/agents", ({ uid }) => app.agents.listForUser(uid).map((a) => ({ agent: a, positions: app.agents.positionsOf(a.id), blueprint: blueprint(a) })));
  route("POST", "/api/agents", ({ uid, body }) => {
    const b = z.object({ fromStrategyId: z.string(), sizeUsd: z.number().positive().default(50), name: z.string().max(18).optional() }).parse(body);
    const s = own(app.lab.get(b.fromStrategyId), uid, "Strategy");
    const stop = JSON.stringify(s.program.exit).match(/"stop_loss_pct":(\d+(?:\.\d+)?)/)?.[1];
    const res = app.agents.propose(uid, {
      name: (b.name ?? s.program.name).toUpperCase().slice(0, 18),
      goal: s.description,
      markets: [app.market.asset(s.program.asset)?.kind === "tokenized_stock" ? "stocks" : "strategies"],
      kind: "rules",
      program: s.program,
      sizeUsd: b.sizeUsd,
      exit: { stopLossPct: Number(stop ?? 10), takeProfitPct: 100 },
      limits: { maxPerTradeUsd: b.sizeUsd, maxPerDayUsd: b.sizeUsd * 3, maxOpenPositions: 1, maxDrawdownPct: 25 },
      mode: "paper",
    });
    return { agent: res.agent, blueprint: blueprint(res.agent), backtestSummary: res.agent.lastBacktest };
  });
  route("PATCH", "/api/agents/:id", ({ uid, params, body }) => {
    const res = app.agents.revise(uid, params.id!, (body ?? {}) as object);
    return { agent: res.agent, blueprint: blueprint(res.agent), backtestSummary: res.agent.lastBacktest, replay: res.replay };
  });
  route("POST", "/api/agents/:id/deploy", ({ uid, params, body }) => {
    const b = z.object({ mode: z.enum(["paper", "ask", "auto"]), passkeyAssertion: z.string().optional(), riskAcknowledged: z.boolean().optional() }).parse(body);
    const a = app.agents.deploy(uid, params.id!, { mode: b.mode, userApproval: b.passkeyAssertion, riskAcknowledged: b.riskAcknowledged });
    return { agent: a, blueprint: blueprint(a) };
  });
  route("POST", "/api/agents/:id/control", ({ uid, params, body }) => {
    const b = z.object({ action: z.enum(["pause", "resume", "kill"]) }).parse(body);
    return app.agents.control(uid, params.id!, b.action);
  });
  route("GET", "/api/agents/:id/explain", ({ uid, params }) => {
    own(app.agents.get(params.id!), uid, "Agent");
    return app.agents.explain(params.id!, 50);
  });
  route("POST", "/api/panic", ({ uid }) => {
    app.agents.panic(uid);
    return { ok: true };
  });

  // --- strategies ----------------------------------------------------------------------
  route("POST", "/api/strategies", ({ uid, body }) => {
    const res = app.lab.compileAndTest(uid, body);
    if (!res.ok) throw new HttpError(400, res.error);
    return res.strategy;
  });

  // --- public --------------------------------------------------------------------------
  route("GET", "/api/registry", () => app.registry.all(), false);
  route("GET", "/api/registry/:mint", ({ params }) => {
    const e = app.registry.get(params.mint!);
    if (!e) throw new HttpError(404, "Not an Outcry launch");
    return e;
  }, false);
  route("GET", "/api/health", () => ({ ok: true, mode: app.config.mode, auditIntact: app.audit.verify(), llm: llmStatus(router) }), false);

  return {
    tokens,
    userFor(token: string | undefined) {
      return token ? tokens.get(token) : undefined;
    },
    async handle(method: string, path: string, token: string | undefined, body: unknown): Promise<ApiResult> {
      const r = routes.find((x) => x.method === method && x.pattern.test(path));
      if (!r) return { status: 404, json: { error: "Not found" } };
      const m = path.match(r.pattern)!;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
      const uid = token ? tokens.get(token) : undefined;
      if (r.auth && !uid) return { status: 401, json: { error: "Sign in first" } };
      try {
        return { status: 200, json: await r.fn({ uid: uid ?? "", params, body }) };
      } catch (e) {
        const err = e as Error & { status?: number; name?: string; issues?: { path: (string | number)[]; message: string }[] };
        if (err.name === "ZodError" && err.issues) {
          return { status: 400, json: { error: err.issues.slice(0, 3).map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") } };
        }
        return { status: err.status ?? 400, json: { error: err.message } };
      }
    },
  };
}

/**
 * Background loops: agent ticks, and simulated pump.fun launches in paper
 * mode so sniper agents have something to trade. Returns a stop function.
 */
export function startLoops(app: Outcry, tickMs: number, simLaunchEveryMs: number): () => void {
  const timers: ReturnType<typeof setInterval>[] = [];
  if (tickMs > 0) timers.push(setInterval(() => void app.agents.tick(), tickMs));
  if (simLaunchEveryMs > 0 && app.config.mode === "paper") {
    const names = ["CALL", "BID", "OFFR", "RING", "BELL", "TICK", "LOUD", "YELP", "HOLR", "ROAR"];
    let i = 0;
    timers.push(
      setInterval(() => {
        const bad = i % 4 === 3;
        const sym = `${names[i % names.length]}${Math.floor(i / names.length) || ""}`;
        const holders = 180 + ((i * 53) % 400);
        app.market.spawnMeme(sym, bad ? { mintRevoked: false, topWalletPct: 38 } : { holders, holdersCollapsed: holders });
        i++;
      }, simLaunchEveryMs),
    );
  }
  return () => timers.forEach(clearInterval);
}
