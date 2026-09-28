/**
 * HTTP + WebSocket API for the Outcry terminal.
 *
 * v0 auth: a bearer token per demo session. Production replaces /api/session
 * with passkey (WebAuthn) registration and verifies each `passkeyAssertion`
 * server-side before approving a ticket (see README, "Before going live").
 */
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { createOutcry, type Outcry } from "../app.js";
import { ModelRouter } from "../llm/router.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { blueprint } from "../orchestrator/tools-exec.js";
import { Jacket } from "../core/types.js";

export interface ServerOptions {
  app?: Outcry;
  router?: ModelRouter;
  tickMs?: number;
  simLaunchEveryMs?: number;
  logger?: boolean;
}

export async function buildServer(opts: ServerOptions = {}) {
  const app = opts.app ?? createOutcry({ mode: (process.env.OUTCRY_MODE as "paper" | "live") ?? "paper" });
  const router = opts.router ?? ModelRouter.fromEnv();
  const orch = new Orchestrator(app, router);
  const tokens = new Map<string, string>(); // token -> userId

  const f = Fastify({ logger: opts.logger ?? false });
  await f.register(fastifyWebsocket);
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
  await f.register(fastifyStatic, { root: webRoot, prefix: "/" });

  const auth = (req: FastifyRequest): string => {
    const h = req.headers.authorization ?? "";
    const tok = h.startsWith("Bearer ") ? h.slice(7) : ((req.query as Record<string, string>)?.token ?? "");
    const uid = tokens.get(tok);
    if (!uid) throw Object.assign(new Error("Sign in first"), { statusCode: 401 });
    return uid;
  };
  const fail = (reply: FastifyReply, e: unknown, code = 400) => {
    const err = e as { statusCode?: number; message: string };
    return reply.code(err.statusCode ?? code).send({ error: err.message });
  };

  // --- session -------------------------------------------------------------
  const SessionBody = z.object({
    badge: z.string().min(1).max(4).default("YOU"),
    jacket: Jacket.default("memes"),
    residence: z.string().length(2).default("CH"),
  });
  f.post("/api/session", async (req, reply) => {
    try {
      const b = SessionBody.parse(req.body ?? {});
      const user = app.users.create(b);
      const token = randomBytes(24).toString("base64url");
      tokens.set(token, user.id);
      return { token, user, llm: llmStatus(router) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  f.get("/api/me", async (req, reply) => {
    try {
      const uid = auth(req);
      return { user: app.users.get(uid), portfolio: app.users.portfolio(uid), usage: router.spendOf(uid), llm: llmStatus(router) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // --- chat ----------------------------------------------------------------
  f.post("/api/chat", async (req, reply) => {
    try {
      const uid = auth(req);
      const b = z.object({ sessionId: z.string().default("main"), text: z.string().min(1).max(4_000) }).parse(req.body);
      return await orch.handle(uid, b.sessionId, b.text);
    } catch (e) {
      return fail(reply, e);
    }
  });

  // --- tickets ---------------------------------------------------------------
  f.get("/api/tickets", async (req, reply) => {
    try {
      return app.desk.listForUser(auth(req));
    } catch (e) {
      return fail(reply, e);
    }
  });

  f.get("/api/tickets/:id", async (req, reply) => {
    try {
      const uid = auth(req);
      const t = app.desk.get((req.params as { id: string }).id);
      if (t.userId !== uid) throw Object.assign(new Error("Not your ticket"), { statusCode: 403 });
      return t;
    } catch (e) {
      return fail(reply, e);
    }
  });

  f.post("/api/tickets/:id/approve", async (req, reply) => {
    try {
      const uid = auth(req);
      const { id } = req.params as { id: string };
      const b = z.object({ passkeyAssertion: z.string().min(1), secondConfirmation: z.boolean().optional(), disclosureAccepted: z.boolean().optional() }).parse(req.body);
      const t = app.desk.get(id);
      if (t.userId !== uid) throw Object.assign(new Error("Not your ticket"), { statusCode: 403 });
      // TODO(live): verify b.passkeyAssertion with WebAuthn against the user's credential and this ticket's hash.
      if (t.kind === "launch") return await app.launches.approve(id, { userApproval: b.passkeyAssertion, disclosureAccepted: b.disclosureAccepted });
      return await app.desk.approve(id, { userApproval: b.passkeyAssertion, secondConfirmation: b.secondConfirmation });
    } catch (e) {
      return fail(reply, e);
    }
  });

  f.post("/api/tickets/:id/cancel", async (req, reply) => {
    try {
      return app.desk.cancel((req.params as { id: string }).id, auth(req));
    } catch (e) {
      return fail(reply, e);
    }
  });

  f.patch("/api/launch/:id", async (req, reply) => {
    try {
      const uid = auth(req);
      const b = z.object({ wallets: z.number().int().optional(), solPerWallet: z.number().optional(), name: z.string().optional(), ticker: z.string().optional(), imageDataUrl: z.string().optional() }).parse(req.body);
      return app.launches.revise(uid, (req.params as { id: string }).id, b);
    } catch (e) {
      return fail(reply, e);
    }
  });

  // --- agents ----------------------------------------------------------------
  f.get("/api/agents", async (req, reply) => {
    try {
      const uid = auth(req);
      return app.agents.listForUser(uid).map((a) => ({ agent: a, positions: app.agents.positionsOf(a.id), blueprint: blueprint(a) }));
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** Turn a Strategy Lab result into a rules agent draft. */
  f.post("/api/agents", async (req, reply) => {
    try {
      const uid = auth(req);
      const b = z.object({ fromStrategyId: z.string(), sizeUsd: z.number().positive().default(50), name: z.string().max(18).optional() }).parse(req.body);
      const s = app.lab.get(b.fromStrategyId);
      if (!s || s.userId !== uid) throw Object.assign(new Error("Strategy not found"), { statusCode: 404 });
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
    } catch (e) {
      return fail(reply, e);
    }
  });

  f.patch("/api/agents/:id", async (req, reply) => {
    try {
      const uid = auth(req);
      const res = app.agents.revise(uid, (req.params as { id: string }).id, req.body as object);
      return { agent: res.agent, blueprint: blueprint(res.agent), backtestSummary: res.agent.lastBacktest, replay: res.replay };
    } catch (e) {
      return fail(reply, e);
    }
  });

  f.post("/api/agents/:id/deploy", async (req, reply) => {
    try {
      const uid = auth(req);
      const b = z.object({ mode: z.enum(["paper", "ask", "auto"]), passkeyAssertion: z.string().optional(), riskAcknowledged: z.boolean().optional() }).parse(req.body);
      const a = app.agents.deploy(uid, (req.params as { id: string }).id, { mode: b.mode, userApproval: b.passkeyAssertion, riskAcknowledged: b.riskAcknowledged });
      return { agent: a, blueprint: blueprint(a) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  f.post("/api/agents/:id/control", async (req, reply) => {
    try {
      const uid = auth(req);
      const b = z.object({ action: z.enum(["pause", "resume", "kill"]) }).parse(req.body);
      return app.agents.control(uid, (req.params as { id: string }).id, b.action);
    } catch (e) {
      return fail(reply, e);
    }
  });

  f.get("/api/agents/:id/explain", async (req, reply) => {
    try {
      const uid = auth(req);
      const a = app.agents.get((req.params as { id: string }).id);
      if (!a || a.userId !== uid) throw Object.assign(new Error("Agent not found"), { statusCode: 404 });
      return app.agents.explain(a.id, 50);
    } catch (e) {
      return fail(reply, e);
    }
  });

  f.post("/api/panic", async (req, reply) => {
    try {
      app.agents.panic(auth(req));
      return { ok: true };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // --- strategies --------------------------------------------------------------
  f.post("/api/strategies", async (req, reply) => {
    try {
      const uid = auth(req);
      const res = app.lab.compileAndTest(uid, req.body);
      if (!res.ok) return reply.code(400).send({ error: res.error });
      return res.strategy;
    } catch (e) {
      return fail(reply, e);
    }
  });

  // --- public ------------------------------------------------------------------
  f.get("/api/registry", async () => app.registry.all());
  f.get("/api/registry/:mint", async (req, reply) => {
    const e = app.registry.get((req.params as { mint: string }).mint);
    return e ?? reply.code(404).send({ error: "Not an Outcry launch" });
  });
  f.get("/api/health", async () => ({ ok: true, mode: app.config.mode, auditIntact: app.audit.verify(), llm: llmStatus(router) }));

  // --- events --------------------------------------------------------------------
  f.get("/api/events", { websocket: true }, (socket, req) => {
    let uid: string;
    try {
      uid = auth(req);
    } catch {
      socket.close(4401, "unauthorized");
      return;
    }
    const off = app.bus.subscribe((e) => {
      if (e.userId === uid && socket.readyState === socket.OPEN) socket.send(JSON.stringify(e));
    });
    socket.on("close", off);
  });

  // --- scheduler -------------------------------------------------------------------
  const timers: NodeJS.Timeout[] = [];
  const tickMs = opts.tickMs ?? 5_000;
  if (tickMs > 0) timers.push(setInterval(() => void app.agents.tick(), tickMs));
  const simMs = opts.simLaunchEveryMs ?? Number(process.env.OUTCRY_SIM_LAUNCH_MS ?? 20_000);
  if (simMs > 0 && app.config.mode === "paper") {
    const names = ["CALL", "BID", "OFFR", "RING", "BELL", "TICK", "LOUD", "YELP", "HOLR", "ROAR"];
    let i = 0;
    timers.push(setInterval(() => {
      const bad = i % 4 === 3;
      const sym = `${names[i % names.length]}${Math.floor(i / names.length) || ""}`;
      app.market.spawnMeme(sym, bad ? { mintRevoked: false, topWalletPct: 38 } : { holders: 180 + ((i * 53) % 400), holdersCollapsed: 180 + ((i * 53) % 400) });
      i++;
    }, simMs));
  }
  f.addHook("onClose", async () => timers.forEach(clearInterval));

  return { f, app, orch, router, tokens };
}

function llmStatus(router: ModelRouter) {
  return (["T0", "T1", "T2"] as const).map((t) => {
    const p = router.providerFor(t);
    return { tier: t, model: p.offline ? "offline intent engine" : p.model, live: !p.offline };
  });
}

// Run directly: `npm start`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 8787);
  const { f } = await buildServer({ logger: true });
  await f.listen({ port, host: "0.0.0.0" });
}
