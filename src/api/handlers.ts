/**
 * Transport-neutral API. The Fastify server and the in-browser build both
 * call `handle()`, so the hosted demo and the real server share one code path.
 */
import { z } from "zod";
import type { Outcry } from "../app.js";
import { Jacket } from "../core/types.js";
import type { ModelRouter } from "../llm/router.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { AuthService, RequestMeta } from "./auth.js";
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

export interface HandlerOptions {
  /** Passkey accounts (server only). */
  auth?: AuthService;
  /** Extra fields for /api/health (e.g. persistence status). */
  extraHealth?: () => Record<string, unknown>;
  /** "real" when live prices / launches feed the paper market. */
  marketMode?: () => "real" | "simulated";
}

export function createHandlers(app: Outcry, orch: Orchestrator, router: ModelRouter, newToken: () => string, opts: HandlerOptions = {}) {
  const tokens = new Map<string, string>();
  const auth = opts.auth;
  /** What the user saw in each chat (text + cards), keyed `${userId}:${sessionId}`. Persisted. */
  type Line = { role: "user" | "ai"; text: string; at: string; cards?: unknown[]; meta?: unknown };
  const transcripts = new Map<string, Line[]>();
  const pushLine = (key: string, line: Line) => {
    const l = transcripts.get(key) ?? [];
    l.push(line);
    if (l.length > 300) l.splice(0, l.length - 300);
    transcripts.set(key, l);
  };
  /** Cards are shown with their CURRENT state (a signed ticket shows as filled, a deleted agent disappears). */
  const freshCards = (uid: string, cards: unknown[] = []) =>
    cards.flatMap((c) => {
      const card = c as Record<string, unknown> & { type: string };
      if (card.type === "order" || card.type === "launch") {
        const t = app.desk.tickets.get((card.ticket as { id: string }).id);
        return t && t.userId === uid ? [{ ...card, ticket: t }] : [];
      }
      if (card.type === "agent") {
        const a = app.agents.get((card.agent as { id: string }).id);
        return a && a.userId === uid && a.state !== "killed" ? [{ ...card, agent: a, blueprint: blueprint(a), replay: undefined }] : [];
      }
      if (card.type === "agent_control") return [];
      return [card];
    });

  const own = <T extends { userId: string }>(x: T | undefined, uid: string, what: string): T => {
    if (!x || x.userId !== uid) throw new HttpError(404, `${what} not found`);
    return x;
  };

  type Handler = (ctx: { uid: string; params: Record<string, string>; body: unknown; meta: RequestMeta; token?: string }) => unknown | Promise<unknown>;
  const needAuth = () => {
    if (!auth) throw new HttpError(501, "Accounts need the Outcry server (not available in the offline demo)");
    return auth;
  };
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
    return { token, user, llm: llmStatus(router), market: opts.marketMode?.() ?? "simulated" };
  }, false);
  route("GET", "/api/me", ({ uid }) => ({ user: app.users.get(uid), portfolio: app.users.portfolio(uid), usage: router.spendOf(uid), llm: llmStatus(router), market: opts.marketMode?.() ?? "simulated" }));

  // --- chat -------------------------------------------------------------------
  route("POST", "/api/chat", async ({ uid, body }) => {
    const b = z.object({ sessionId: z.string().max(64).default("main"), text: z.string().min(1).max(4_000) }).parse(body);
    const key = `${uid}:${b.sessionId}`;
    pushLine(key, { role: "user", text: b.text, at: new Date().toISOString() });
    const r = await orch.handle(uid, b.sessionId, b.text);
    pushLine(key, { role: "ai", text: r.reply, at: new Date().toISOString(), cards: r.cards, meta: r.meta });
    return r;
  });
  route("GET", "/api/chat/:sessionId/history", ({ uid, params }) => {
    const lines = transcripts.get(`${uid}:${params.sessionId}`) ?? [];
    return { sessionId: params.sessionId, lines: lines.map((l) => (l.cards ? { ...l, cards: freshCards(uid, l.cards) } : l)) };
  });
  route("DELETE", "/api/chat/:sessionId", ({ uid, params }) => {
    transcripts.delete(`${uid}:${params.sessionId}`);
    orch.dropSession(uid, params.sessionId!);
    return { ok: true };
  });
  route("PATCH", "/api/chat/:sessionId", ({ uid, params, body }) => {
    const b = z.object({ title: z.string().trim().min(1).max(60) }).parse(body);
    const l = transcripts.get(`${uid}:${params.sessionId}`);
    if (!l) throw new HttpError(404, "Chat not found");
    (l as (Line & { title?: string })[])[0]!.title = b.title;
    return { ok: true };
  });
  route("GET", "/api/chat", ({ uid }) =>
    [...transcripts.entries()]
      .filter(([k]) => k.startsWith(`${uid}:`))
      .map(([k, l]) => ({ sessionId: k.slice(uid.length + 1), title: (l[0] as Line & { title?: string } | undefined)?.title ?? l.find((x) => x.role === "user")?.text.slice(0, 60) ?? "Chat", at: l.at(-1)?.at, messages: l.length }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at))));

  // --- tickets ------------------------------------------------------------------
  route("GET", "/api/tickets", ({ uid }) => app.desk.listForUser(uid));
  route("GET", "/api/tickets/:id", ({ uid, params }) => own(app.desk.tickets.get(params.id!), uid, "Ticket"));
  route("POST", "/api/tickets/:id/challenge", async ({ uid, params, meta }) => {
    const t = own(app.desk.tickets.get(params.id!), uid, "Ticket");
    return needAuth().approvalOptions(uid, t.id, JSON.stringify({ kind: t.kind, status: t.status }), meta);
  });
  route("POST", "/api/tickets/:id/approve", async ({ uid, params, body, meta }) => {
    const b = z.object({ passkeyAssertion: z.string().min(1).optional(), passkeyResponse: z.unknown().optional(), secondConfirmation: z.boolean().optional(), disclosureAccepted: z.boolean().optional() }).parse(body);
    const t = own(app.desk.tickets.get(params.id!), uid, "Ticket");
    if (auth?.hasPasskey(uid)) {
      // Secured account: a passkey assertion bound to this ticket is required.
      if (!b.passkeyResponse) throw new HttpError(401, "Confirm with your passkey to sign");
      await auth.verifyApproval(uid, t.id, b.passkeyResponse, meta);
      b.passkeyAssertion = `webauthn:${t.id}`;
    } else if (app.config.mode === "live") {
      throw new HttpError(403, "Secure your account with a passkey before live trading");
    }
    if (!b.passkeyAssertion) throw new HttpError(400, "Approval missing");
    if (t.kind === "launch") return app.launches.approve(t.id, { userApproval: b.passkeyAssertion, disclosureAccepted: b.disclosureAccepted });
    return app.desk.approve(t.id, { userApproval: b.passkeyAssertion, secondConfirmation: b.secondConfirmation });
  });
  route("POST", "/api/tickets/:id/cancel", ({ uid, params }) => app.desk.cancel(params.id!, uid));
  route("PATCH", "/api/launch/:id", ({ uid, params, body }) => {
    const b = z.object({ wallets: z.number().int().optional(), solPerWallet: z.number().optional(), name: z.string().optional(), ticker: z.string().optional(), imageDataUrl: z.string().optional() }).parse(body);
    return app.launches.revise(uid, params.id!, b);
  });

  // --- agents ----------------------------------------------------------------------
  route("GET", "/api/agents", ({ uid }) => app.agents.listForUser(uid).map((a) => ({ agent: a, positions: app.agents.positionsOf(a.id), blueprint: blueprint(a), perf: app.agents.perf(a.id) })));
  route("GET", "/api/agents/:id/perf", ({ uid, params }) => {
    own(app.agents.get(params.id!), uid, "Agent");
    return app.agents.perf(params.id!);
  });
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
  route("DELETE", "/api/agents/:id", ({ uid, params }) => {
    own(app.agents.get(params.id!), uid, "Agent");
    app.agents.remove(uid, params.id!);
    return { ok: true, deleted: params.id };
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
  route("POST", "/api/strategies", async ({ uid, body }) => {
    const b = (body ?? {}) as { program?: unknown; lookbackDays?: number };
    const res = b.program ? await app.lab.compileAndTest(uid, b.program, undefined, { days: b.lookbackDays }) : await app.lab.compileAndTest(uid, body);
    if (!res.ok) throw new HttpError(400, res.error);
    return res.strategy;
  });

  // --- accounts (passkeys) ------------------------------------------------------
  route("GET", "/api/auth/status", ({ uid }) => ({ secured: auth?.hasPasskey(uid) ?? false, passkeys: auth?.listFor(uid) ?? [], available: !!auth }));
  route("POST", "/api/auth/register/options", ({ uid, meta }) => {
    const u = app.users.get(uid);
    return needAuth().registerOptions(uid, u?.badge ?? "YOU", meta);
  });
  route("POST", "/api/auth/register/verify", async ({ uid, body, meta }) => {
    const b = z.object({ response: z.unknown(), label: z.string().max(40).optional() }).parse(body);
    await needAuth().registerVerify(uid, b.response, meta, b.label);
    app.audit.append(`user:${uid}`, "account.passkey_added", {});
    return { ok: true, secured: true };
  });
  route("POST", "/api/auth/login/options", ({ meta }) => needAuth().loginOptions(meta), false);
  route("POST", "/api/auth/login/verify", async ({ body, meta }) => {
    const b = z.object({ loginId: z.string(), response: z.object({ id: z.string() }).passthrough() }).parse(body);
    const userId = await needAuth().loginVerify(b.loginId, b.response, meta);
    const token = newToken();
    tokens.set(token, userId);
    app.audit.append(`user:${userId}`, "account.signed_in", {});
    return { token, user: app.users.get(userId), llm: llmStatus(router) };
  }, false);
  route("POST", "/api/auth/logout", ({ token }) => {
    if (token) tokens.delete(token);
    return { ok: true };
  });

  // --- public --------------------------------------------------------------------------
  route("GET", "/api/registry", () => app.registry.all(), false);
  route("GET", "/api/registry/:mint", ({ params }) => {
    const e = app.registry.get(params.mint!);
    if (!e) throw new HttpError(404, "Not an Outcry launch");
    return e;
  }, false);
  route("GET", "/api/health", () => ({ ok: true, mode: app.config.mode, auditIntact: app.audit.verify(), llm: llmStatus(router), recentLlmErrors: router.recentErrors, ...(opts.extraHealth?.() ?? {}) }), false);

  return {
    tokens,
    transcripts,
    userFor(token: string | undefined) {
      return token ? tokens.get(token) : undefined;
    },
    async handle(method: string, path: string, token: string | undefined, body: unknown, meta: RequestMeta = { origin: "http://localhost", rpId: "localhost" }): Promise<ApiResult> {
      const r = routes.find((x) => x.method === method && x.pattern.test(path));
      if (!r) return { status: 404, json: { error: "Not found" } };
      const m = path.match(r.pattern)!;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
      const uid = token ? tokens.get(token) : undefined;
      if (r.auth && !uid) return { status: 401, json: { error: "Sign in first" } };
      try {
        return { status: 200, json: await r.fn({ uid: uid ?? "", params, body, meta, token }) };
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
        const top10Pct = 11 + ((i * 37) % 26); // 11–36%: some pass a 20% top-10 rule, some don't
        app.market.spawnMeme(sym, bad ? { mintRevoked: false, topWalletPct: 38, top10Pct: 61 } : { holders, holdersCollapsed: holders, top10Pct });
        i++;
      }, simLaunchEveryMs),
    );
  }
  return () => timers.forEach(clearInterval);
}
