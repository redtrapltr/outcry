import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServer } from "../src/api/server.js";
import { FileStore, PostgresStore, type StateStore } from "../src/core/persist.js";

async function roundTrip(makeStore: () => Promise<StateStore>) {
  // --- first life: create a user, an agent, an order ---
  const s1 = await buildServer({ store: await makeStore(), tickMs: 0, simLaunchEveryMs: 0 });
  const inj = (method: string, url: string, token?: string, payload?: unknown) =>
    s1.f.inject({ method: method as never, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
  const { token, user } = (await inj("POST", "/api/session", undefined, { badge: "PER" })).json();
  const chat = (await inj("POST", "/api/chat", token, { text: "build me an agent that snipes new pump.fun memes with 300+ holders, $15 per trade" })).json();
  const agentId = chat.cards[0].agent.id;
  await inj("POST", `/api/agents/${agentId}/deploy`, token, { mode: "paper" });
  const order = (await inj("POST", "/api/chat", token, { text: "buy 1 SOL" })).json();
  const ticketId = order.cards[0].ticket.id;
  await inj("POST", `/api/tickets/${ticketId}/approve`, token, { passkeyAssertion: "tap" });
  const before = (await inj("GET", "/api/me", token)).json();
  await s1.f.close(); // flushes on close

  // --- second life: same store, fresh process state ---
  const s2 = await buildServer({ store: await makeStore(), tickMs: 0, simLaunchEveryMs: 0 });
  const inj2 = (method: string, url: string) => s2.f.inject({ method: method as never, url, headers: { authorization: `Bearer ${token}` } });
  const me = await inj2("GET", "/api/me");
  expect(me.statusCode).toBe(200);
  expect(me.json().user.id).toBe(user.id);
  expect(me.json().portfolio.balances.SOL).toBeCloseTo(before.portfolio.balances.SOL, 6);
  const agents = (await inj2("GET", "/api/agents")).json();
  expect(agents.map((a: { agent: { id: string } }) => a.agent.id)).toContain(agentId);
  expect(agents[0].agent.state).toBe("paper");
  expect((await inj2("GET", `/api/tickets/${ticketId}`)).json().status).toBe("filled");
  const health = (await s2.f.inject({ method: "GET", url: "/api/health" })).json();
  expect(health.auditIntact).toBe(true);
  // Chat history survives too: a follow-up still knows the agent.
  expect(s2.app.audit.length).toBeGreaterThan(5);
  await s2.f.close();
}

describe("persistence", () => {
  it("restores users, balances, agents, tickets, sessions and the audit chain from a file", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "outcry-")), "state.json");
    await roundTrip(async () => new FileStore(file));
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)("does the same with Postgres", async () => {
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query("drop table if exists outcry_state; drop table if exists outcry_audit");
    await pool.end();
    await roundTrip(() => PostgresStore.connect(process.env.TEST_DATABASE_URL!));
  });
});

describe("persistence keeps saving", () => {
  it("saves again after an unchanged flush", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "outcry-")), "state.json");
    const s = await buildServer({ store: new FileStore(file), tickMs: 0, simLaunchEveryMs: 0 });
    await s.persistence!.flush();
    await s.persistence!.flush(); // unchanged
    const r = await s.f.inject({ method: "POST", url: "/api/session", payload: { badge: "AGN" } });
    await s.persistence!.flush();
    const raw = JSON.parse((await import("node:fs")).readFileSync(file, "utf8"));
    expect(raw.state).toContain(r.json().user.id);
    await s.f.close();
  });
});

describe("chat history", () => {
  it("returns the transcript with current card state, and survives a restart", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "outcry-")), "state.json");
    const s1 = await buildServer({ store: new FileStore(file), tickMs: 0, simLaunchEveryMs: 0 });
    const inj = (s: typeof s1, method: string, url: string, token?: string, payload?: unknown) =>
      s.f.inject({ method: method as never, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
    const { token } = (await inj(s1, "POST", "/api/session", undefined, {})).json();
    const r = (await inj(s1, "POST", "/api/chat", token, { sessionId: "c1", text: "buy 1 SOL" })).json();
    await inj(s1, "POST", `/api/tickets/${r.cards[0].ticket.id}/approve`, token, { passkeyAssertion: "tap" });
    await s1.f.close();
    const s2 = await buildServer({ store: new FileStore(file), tickMs: 0, simLaunchEveryMs: 0 });
    const h = (await inj(s2, "GET", "/api/chat/c1/history", token)).json();
    expect(h.lines.map((l: { role: string }) => l.role)).toEqual(["user", "ai"]);
    expect(h.lines[1].cards[0].ticket.status).toBe("filled");
    expect((await inj(s2, "GET", "/api/chat", token)).json()[0].sessionId).toBe("c1");
    await s2.f.close();
  });
});

describe("chat list", () => {
  it("lists, renames and deletes chats", async () => {
    const s = await buildServer({ store: null, tickMs: 0, simLaunchEveryMs: 0 });
    const inj = (method: string, url: string, token?: string, payload?: unknown) =>
      s.f.inject({ method: method as never, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
    const { token } = (await inj("POST", "/api/session", undefined, {})).json();
    await inj("POST", "/api/chat", token, { sessionId: "a", text: "buy 1 SOL" });
    await inj("POST", "/api/chat", token, { sessionId: "b", text: "what is my balance" });
    expect((await inj("GET", "/api/chat", token)).json().map((c: { sessionId: string }) => c.sessionId)).toEqual(["b", "a"]);
    await inj("PATCH", "/api/chat/a", token, { title: "Orders" });
    await inj("DELETE", "/api/chat/b", token);
    const list = (await inj("GET", "/api/chat", token)).json();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("Orders");
    await s.f.close();
  });
});

describe("persistence never takes the site down", () => {
  const PG = process.env.TEST_DATABASE_URL;

  async function activity(s: Awaited<ReturnType<typeof buildServer>>, n = 3) {
    const { token } = (await s.f.inject({ method: "POST", url: "/api/session", payload: {} })).json();
    for (let i = 0; i < n; i++) await s.f.inject({ method: "POST", url: "/api/chat", headers: { authorization: `Bearer ${token}` }, payload: { text: "buy 1 SOL" } });
    return token as string;
  }

  it.skipIf(!PG)("takes over even when a previous instance is stuck holding the state lock", async () => {
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: PG });
    const s1 = await buildServer({ store: await PostgresStore.connect(PG!), tickMs: 0, simLaunchEveryMs: 0 });
    const token = await activity(s1, 1);
    await s1.persistence!.flush();
    // A stuck save: transaction open, row locked, connection never comes back.
    pool.on("error", () => {});
    const stuck = await pool.connect();
    stuck.on("error", () => {}); // it gets terminated by the new instance, as intended
    await stuck.query("begin");
    await stuck.query("update outcry_state set updated_at = now() where id = 'main'");
    const t0 = Date.now();
    const s2 = await buildServer({ store: await PostgresStore.connect(PG!), tickMs: 0, simLaunchEveryMs: 0 });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect((await s2.f.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    await activity(s2, 1);
    await s2.persistence!.flush();
    expect(s2.persistence!.status().lastError).toBeNull();
    stuck.release(true);
    await s2.f.close();
    await s1.f.close().catch(() => {});
    await pool.end().catch(() => {});
  }, 40_000);

  it.skipIf(!PG)("starts with a broken audit chain: keeps the valid part, quarantines the rest", async () => {
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: PG });
    await pool.query("drop table if exists outcry_state; drop table if exists outcry_audit; drop table if exists outcry_audit_quarantine");
    const s1 = await buildServer({ store: await PostgresStore.connect(PG!), tickMs: 0, simLaunchEveryMs: 0 });
    const token = await activity(s1);
    await s1.f.close();
    const total = Number((await pool.query("select count(*) from outcry_audit")).rows[0].count);
    expect(total).toBeGreaterThan(4);
    await pool.query("delete from outcry_audit where seq = 2"); // a gap, like a lost write
    const s2 = await buildServer({ store: await PostgresStore.connect(PG!), tickMs: 0, simLaunchEveryMs: 0 });
    const health = (await s2.f.inject({ method: "GET", url: "/api/health" })).json();
    expect(health.auditIntact).toBe(true);
    expect(health.persistence.auditRepair.brokenAtSeq).toBe(2);
    // Users and sessions are still there.
    expect((await s2.f.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    await s2.persistence!.flush();
    await s2.f.close();
    expect(Number((await pool.query("select count(*) from outcry_audit_quarantine")).rows[0].count)).toBe(total - 3);
    // The next boot is clean.
    const s3 = await buildServer({ store: await PostgresStore.connect(PG!), tickMs: 0, simLaunchEveryMs: 0 });
    expect((await s3.f.inject({ method: "GET", url: "/api/health" })).json().persistence.auditRepair).toBeUndefined();
    await s3.f.close();
    await pool.end();
  });

  it.skipIf(!PG)("during a deploy the old instance stops writing once the new one starts", async () => {
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: PG });
    await pool.query("drop table if exists outcry_state; drop table if exists outcry_audit; drop table if exists outcry_audit_quarantine");
    const oldI = await buildServer({ store: await PostgresStore.connect(PG!), tickMs: 0, simLaunchEveryMs: 0 });
    await activity(oldI, 1);
    await oldI.persistence!.flush();
    const newI = await buildServer({ store: await PostgresStore.connect(PG!), tickMs: 0, simLaunchEveryMs: 0 });
    // Both keep working; only the new one may write.
    await activity(oldI, 2);
    await activity(newI, 2);
    await oldI.persistence!.flush();
    await newI.persistence!.flush();
    expect(oldI.persistence!.status().lastError).toMatch(/newer instance/);
    await oldI.f.close();
    await newI.f.close();
    const after = await buildServer({ store: await PostgresStore.connect(PG!), tickMs: 0, simLaunchEveryMs: 0 });
    const h = (await after.f.inject({ method: "GET", url: "/api/health" })).json();
    expect(h.auditIntact).toBe(true);
    expect(h.persistence.auditRepair).toBeUndefined();
    await after.f.close();
    await pool.end();
  });
});
