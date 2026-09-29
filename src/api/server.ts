/**
 * HTTP + WebSocket server for Outcry.
 *
 * Routes live in handlers.ts (shared with the in-browser build). This file
 * only adapts them to Fastify, serves the web app, and streams events.
 *
 * Auth: a bearer token per session. Guests can secure their account with a
 * passkey (auth.ts); once secured, every ticket needs a passkey assertion.
 * State is saved to Postgres (DATABASE_URL) or a file (OUTCRY_STATE_FILE).
 */
import { RealHistory } from "../data/history.js";
import { LiveFeeds } from "../data/live.js";
import { PumpPortalFeed } from "../data/pumpfeed.js";
import { TokenLookup } from "../data/lookup.js";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createOutcry, type Outcry } from "../app.js";
import { ModelRouter } from "../llm/router.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { createHandlers, startLoops } from "./handlers.js";
import { AuthService, type RequestMeta } from "./auth.js";
import { Persistence } from "./persistence.js";
import { storeFromEnv, type StateStore } from "../core/persist.js";

export interface ServerOptions {
  app?: Outcry;
  router?: ModelRouter;
  tickMs?: number;
  simLaunchEveryMs?: number;
  logger?: boolean;
  /** Explicit store (tests). Default: from DATABASE_URL / OUTCRY_STATE_FILE. */
  store?: StateStore | null;
}

export async function buildServer(opts: ServerOptions = {}) {
  const history = process.env.OUTCRY_REAL_HISTORY === "0" ? undefined : new RealHistory({ twelveDataKey: process.env.TWELVEDATA_API_KEY });
  const app = opts.app ?? createOutcry({ mode: (process.env.OUTCRY_MODE as "paper" | "live") ?? "paper", history });

  // "Paper money, real market": real prices/candles and the live pump.fun launch stream.
  const live = !opts.app && process.env.OUTCRY_LIVE_PRICES === "1" ? new LiveFeeds({ history, twelveDataKey: process.env.TWELVEDATA_API_KEY }).start() : undefined;
  if (live) app.market.setLive(live);
  const holds = (mint: string) => {
    const sym = app.market.tokenRisk(mint)?.symbol;
    if (!sym) return false;
    if (app.users.anyHolds(sym)) return true;
    for (const a of app.agents.agents.values()) if (app.agents.positionsOf(a.id).some((p) => p.symbol === sym)) return true;
    return false;
  };
  const pump = !opts.app && process.env.OUTCRY_PUMP_FEED === "pumpportal" ? new PumpPortalFeed(app.market, { isHeld: holds }).start() : undefined;
  const router = opts.router ?? ModelRouter.fromEnv();
  const orch = new Orchestrator(app, router);
  if (live || pump) orch.tools.lookup = new TokenLookup(app.market, { follow: (m) => pump?.follow(m) });
  const auth = new AuthService();
  let persistence: Persistence | undefined;
  const api = createHandlers(app, orch, router, () => randomBytes(24).toString("base64url"), {
    auth,
    // Only claim a real market while real data is actually arriving.
    marketMode: () => (live?.price("SOL") !== undefined || pump?.status().connected ? "real" : "simulated"),
    extraHealth: () => ({
      persistence: persistence?.status() ?? { store: "memory (data is lost on restart)" },
      marketData: { prices: live ? live.status() : "simulated", pumpfun: pump ? pump.status() : "simulated launches" },
    }),
  });
  const store = opts.store === null ? undefined : opts.store ?? (await storeFromEnv());
  if (store) {
    persistence = new Persistence(store, app, { router, orch, sessions: api.tokens, transcripts: api.transcripts, auth });
    const r = await persistence.restore();
    console.log(`[outcry] state store: ${store.kind}; restored ${r.users} users, ${r.agents} agents, ${r.auditEntries} audit entries`);
    persistence.start(Number(process.env.OUTCRY_SAVE_EVERY_MS ?? 5_000));
  }

  const f = Fastify({ logger: opts.logger ?? false });
  // Accept an empty body with a JSON content-type (buttons that send no data).
  f.removeContentTypeParser("application/json");
  f.addContentTypeParser("application/json", { parseAs: "string" }, (_req, raw, done) => {
    const text = String(raw ?? "").trim();
    if (!text) return done(null, undefined);
    try { done(null, JSON.parse(text)); } catch { const e = new Error("Invalid JSON body") as Error & { statusCode: number }; e.statusCode = 400; done(e, undefined); }
  });
  await f.register(fastifyWebsocket);
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
  await f.register(fastifyStatic, { root: webRoot, prefix: "/" });

  const tokenOf = (headers: Record<string, unknown>, query: unknown) => {
    const h = String(headers.authorization ?? "");
    return h.startsWith("Bearer ") ? h.slice(7) : (query as Record<string, string> | undefined)?.token;
  };

  // Passkeys are bound to the site's origin and host name.
  const metaOf = (h: Record<string, unknown>): RequestMeta => {
    if (process.env.OUTCRY_ORIGIN) {
      const u = new URL(process.env.OUTCRY_ORIGIN);
      return { origin: u.origin, rpId: u.hostname };
    }
    const host = String(h["x-forwarded-host"] ?? h.host ?? "localhost").split(",")[0]!.trim();
    const proto = String(h["x-forwarded-proto"] ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")).split(",")[0]!.trim();
    return { origin: `${proto}://${host}`, rpId: host.replace(/:\d+$/, "") };
  };

  // Basic abuse guard for public deployments: session creation per IP per hour.
  const sessionsByIp = new Map<string, { hour: number; n: number }>();
  const maxSessionsPerHour = Number(process.env.OUTCRY_MAX_SESSIONS_PER_IP_HOUR ?? 30);

  f.all("/api/*", async (req, reply) => {
    const url = req.url.split("?")[0]!;
    if (req.method === "POST" && url === "/api/session") {
      const ip = String(req.headers["x-forwarded-for"] ?? req.ip).split(",")[0]!.trim();
      const hour = Math.floor(Date.now() / 3_600_000);
      const e = sessionsByIp.get(ip);
      const n = e && e.hour === hour ? e.n + 1 : 1;
      sessionsByIp.set(ip, { hour, n });
      if (n > maxSessionsPerHour) return reply.code(429).send({ error: "Too many new sessions from this address; try again later" });
    }
    const res = await api.handle(req.method, url, tokenOf(req.headers, req.query), req.body, metaOf(req.headers));
    return reply.code(res.status).send(res.json);
  });

  // Event stream for the signed-in user (ticket updates, fills, agent activity).
  f.get("/ws/events", { websocket: true }, (socket, req) => {
    const uid = api.userFor(tokenOf(req.headers, req.query));
    if (!uid) {
      socket.close(4401, "unauthorized");
      return;
    }
    const off = app.bus.subscribe((e) => {
      if (e.userId === uid && socket.readyState === socket.OPEN) socket.send(JSON.stringify(e));
    });
    socket.on("close", off);
  });

  // With the live pump.fun stream on, no simulated launches are mixed in.
  const simEvery = pump ? 0 : opts.simLaunchEveryMs ?? Number(process.env.OUTCRY_SIM_LAUNCH_MS ?? 20_000);
  const stop = startLoops(app, opts.tickMs ?? 5_000, simEvery);
  f.addHook("onClose", async () => {
    stop();
    live?.stop();
    pump?.stop();
    await persistence?.stop();
  });

  return { f, app, orch, router, tokens: api.tokens, auth, persistence };
}

// Run directly: `npm start`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 8787);
  const { f } = await buildServer({ logger: true });
  await f.listen({ port, host: "0.0.0.0" });
  // Render sends SIGTERM before a deploy or restart: save state first.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, async () => {
      await f.close().catch(() => {});
      process.exit(0);
    });
  }
}
