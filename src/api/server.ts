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
import { turnkeyFromEnv } from "../wallet/turnkey.js";
import { LivePilot, pilotConfigFromEnv, type TokenInfo } from "../live/pilot.js";
import { JupiterSwap, SolanaRpc } from "../live/chain.js";
import { SpreadScanner, type StockPair } from "../live/spreads.js";

/** Symbol, decimals and USD price for mints, from Jupiter's free token search. */
async function jupiterTokenInfo(mints: string[]): Promise<Record<string, TokenInfo>> {
  const out: Record<string, TokenInfo> = {};
  for (let i = 0; i < mints.length; i += 100) {
    const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mints.slice(i, i + 100).join(",")}`, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) continue;
    for (const t of (await r.json()) as { id: string; symbol?: string; name?: string; decimals?: number; usdPrice?: number }[]) {
      out[t.id] = { symbol: t.symbol ?? t.id.slice(0, 4), name: t.name, decimals: t.decimals, usdPrice: t.usdPrice };
    }
  }
  return out;
}
import { JupiterHolderPoller } from "../data/jupholders.js";
import { StockCatalog } from "../data/stocks.js";
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
  const app = opts.app ?? createOutcry({
    mode: (process.env.OUTCRY_MODE as "paper" | "live") ?? "paper",
    history,
    // With real prices on, paper fills of live memecoins wait for the next price (as a real transaction would).
    paperFillDelayMs: process.env.OUTCRY_LIVE_PRICES === "1" ? Number(process.env.OUTCRY_PAPER_FILL_DELAY_MS ?? 7_000) : 0,
  });

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
  const pump = !opts.app && process.env.OUTCRY_PUMP_FEED === "pumpportal" ? new PumpPortalFeed(app.market, { isHeld: holds, apiKey: process.env.PUMPPORTAL_API_KEY }).start() : undefined;
  const router = opts.router ?? ModelRouter.fromEnv();
  const orch = new Orchestrator(app, router);
  const rpcUrl = process.env.SOLANA_RPC_URL ?? (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : undefined);
  // Holder counts for young launches (free trade data ended in May 2026).
  const heldMints = () => {
    const syms = app.users.heldSymbols();
    for (const a of app.agents.agents.values()) for (const p of app.agents.positionsOf(a.id)) syms.add(p.symbol);
    const out: string[] = [];
    for (const s of syms) {
      const r = app.market.tokenRisk(s);
      if (r && (r.flags.includes("live") || r.flags.includes("looked-up"))) out.push(r.mint);
    }
    return out;
  };
  const holderPoll = pump ? new JupiterHolderPoller(app.market, pump, { heldMints }).start() : undefined;
  // Tokenized stocks: real Solana tokens (xStocks / Ondo) with on-chain prices.
  const stocks = live ? new StockCatalog(app.market, { twelveDataKey: process.env.TWELVEDATA_API_KEY }).start() : undefined;
  if (stocks) orch.tools.stocks = stocks;
  const lookup = live || pump ? new TokenLookup(app.market, { follow: (m) => pump?.follow(m), rpcUrl }) : undefined;
  if (lookup) {
    orch.tools.lookup = lookup;
    // Snipers confirm holder concentration on-chain before each buy.
    if (pump) app.agents.verifyHolders = (mint) => lookup.holders(mint);
  }
  // Solana RPC status for /api/health (shows whether the Helius key works).
  const rpcStatus: { provider: string; ok?: boolean; slot?: number; latencyMs?: number; error?: string; checkedAt?: string } = {
    provider: process.env.SOLANA_RPC_URL ? "custom" : process.env.HELIUS_API_KEY ? "helius" : "public (rate-limited)",
  };
  const checkRpc = async () => {
    const t0 = Date.now();
    try {
      const r = await fetch(rpcUrl ?? "https://api.mainnet-beta.solana.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }), signal: AbortSignal.timeout(6_000) });
      const j = (await r.json()) as { result?: number; error?: { message: string } };
      Object.assign(rpcStatus, { ok: typeof j.result === "number", slot: j.result, latencyMs: Date.now() - t0, error: j.error?.message ?? (r.ok ? undefined : `HTTP ${r.status}`), checkedAt: new Date().toISOString() });
    } catch (e) {
      Object.assign(rpcStatus, { ok: false, error: (e as Error).message, checkedAt: new Date().toISOString() });
    }
  };
  if (live || pump) {
    void checkRpc();
    setInterval(() => void checkRpc(), 5 * 60_000).unref();
  }
  // Real-money pilot: Turnkey wallets + Jupiter swaps (only when the keys are set).
  const turnkey = turnkeyFromEnv(process.env);
  const pilotCfg = pilotConfigFromEnv(process.env);
  const livePilot = turnkey && process.env.JUPITER_API_KEY
    ? new LivePilot(pilotCfg, {
        users: app.users,
        wallets: turnkey,
        jupiter: new JupiterSwap({
          apiKey: process.env.JUPITER_API_KEY,
          // Outcry's fee on real trades: Jupiter referral (50-255 bps; Jupiter keeps 20% of it).
          referralAccount: process.env.JUPITER_REFERRAL_ACCOUNT?.trim() || undefined,
          referralFeeBps: Math.min(255, Math.max(50, Number(process.env.JUPITER_REFERRAL_FEE_BPS ?? 50))),
        }),
        resolveMint: (sym) => {
          const a = app.market.asset(sym);
          return a?.chain === "solana" ? a.address : undefined;
        },
        rpc: new SolanaRpc(rpcUrl ?? "https://api.mainnet-beta.solana.com"),
        audit: app.audit,
        solUsd: () => { try { return app.market.priceUsd("SOL"); } catch { return 0; } },
        tokenInfo: jupiterTokenInfo,
        growth: app.growth,
      })
    : undefined;
  let liveStatus: Record<string, unknown> = { configured: false, missing: [!turnkey && "TURNKEY_ORGANIZATION_ID / TURNKEY_API_PUBLIC_KEY / TURNKEY_API_PRIVATE_KEY", !process.env.JUPITER_API_KEY && "JUPITER_API_KEY"].filter(Boolean) };
  if (livePilot && turnkey) {
    const refresh = async () => {
      const ref = process.env.JUPITER_REFERRAL_ACCOUNT?.trim();
      liveStatus = {
        configured: true, enabled: pilotCfg.enabled, allowlist: pilotCfg.allowlist.length, maxOrderUsd: pilotCfg.maxOrderUsd, maxDailyUsd: pilotCfg.maxDailyUsd,
        turnkey: await turnkey.status(),
        outcryFee: ref ? { referralAccount: ref, bps: Math.min(255, Math.max(50, Number(process.env.JUPITER_REFERRAL_FEE_BPS ?? 50))), lastMissed: livePilot.referralMiss ?? null } : "off (set JUPITER_REFERRAL_ACCOUNT)",
      };
    };
    void refresh();
    setInterval(() => void refresh(), 60_000).unref();
  }
  const auth = new AuthService();
  if (livePilot) {
    orch.tools.live = { pilot: livePilot, secured: (uid) => auth.hasPasskey(uid) };
    // Real-money agents trade from their own on-chain account through the same Jupiter path.
    app.agents.realExec = {
      swap: (a, side, mint, size) => livePilot.agentSwap(a.userId, a.real!.address, side, mint, size),
      solBalance: (a) => livePilot.agentSolBalance(a.real!.address),
    };
    // Same stock, two tokens (xStocks / Ondo): pair them up for the spread scanner.
    orch.tools.spreads = new SpreadScanner(
      livePilot.jupiter,
      () => {
        const byTicker = new Map<string, StockPair["a"][]>();
        for (const s of app.market.listStocks()) {
          const a = app.market.asset(s.symbol);
          if (!a?.address || a.chain !== "solana") continue;
          const list = byTicker.get(s.ticker) ?? [];
          list.push({ symbol: s.symbol, mint: a.address, decimals: a.decimals, priceUsd: s.priceUsd });
          byTicker.set(s.ticker, list);
        }
        return [...byTicker].filter(([, l]) => l.length >= 2).map(([ticker, l]) => ({ ticker, a: l[0]!, b: l[1]! }));
      },
      () => (process.env.JUPITER_REFERRAL_ACCOUNT ? Math.min(255, Math.max(50, Number(process.env.JUPITER_REFERRAL_FEE_BPS ?? 50))) : 0),
    );
  }
  let persistence: Persistence | undefined;
  const api = createHandlers(app, orch, router, () => randomBytes(24).toString("base64url"), {
    auth,
    live: livePilot,
    // Only claim a real market while real data is actually arriving.
    marketMode: () => (live?.price("SOL") !== undefined || pump?.status().connected ? "real" : "simulated"),
    extraHealth: () => ({
      persistence: persistence?.status() ?? { store: "memory (data is lost on restart)" },
      marketData: { prices: live ? live.status() : "simulated", pumpfun: pump ? pump.status() : "simulated launches", holders: holderPoll ? holderPoll.status() : null, stocks: stocks ? stocks.status() : null, solanaRpc: rpcStatus },
      liveTrading: liveStatus,
    }),
  });
  const store = opts.store === null ? undefined : opts.store ?? (await storeFromEnv());
  if (store) {
    persistence = new Persistence(store, app, { router, orch, sessions: api.tokens, transcripts: api.transcripts, recaps: api.recaps, auth, live: livePilot });
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
    const res = await api.handle(req.method, req.url, tokenOf(req.headers, req.query), req.body, metaOf(req.headers));
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
    holderPoll?.stop();
    stocks?.stop();
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
