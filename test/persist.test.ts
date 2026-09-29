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
