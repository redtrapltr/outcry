/**
 * HTTP + WebSocket server for Outcry.
 *
 * Routes live in handlers.ts (shared with the in-browser build). This file
 * only adapts them to Fastify, serves the web app, and streams events.
 *
 * v0 auth: a bearer token per demo session. Production replaces
 * /api/session with passkey (WebAuthn) registration and verifies each
 * `passkeyAssertion` server-side before approving a ticket.
 */
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
  const api = createHandlers(app, orch, router, () => randomBytes(24).toString("base64url"));

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
    const res = await api.handle(req.method, url, tokenOf(req.headers, req.query), req.body);
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

  const stop = startLoops(app, opts.tickMs ?? 5_000, opts.simLaunchEveryMs ?? Number(process.env.OUTCRY_SIM_LAUNCH_MS ?? 20_000));
  f.addHook("onClose", async () => stop());

  return { f, app, orch, router, tokens: api.tokens };
}

// Run directly: `npm start`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 8787);
  const { f } = await buildServer({ logger: true });
  await f.listen({ port, host: "0.0.0.0" });
}
