import { describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { AccessGate } from "../src/api/gate.js";

async function server(gate: AccessGate) {
  return buildServer({ tickMs: 0, simLaunchEveryMs: 0, store: null, gate });
}

describe("invite-only gate", () => {
  it("locks the terminal and API until the password is entered", async () => {
    const s = await server(new AccessGate(["floor-2026"]));
    const page = await s.f.inject({ method: "GET", url: "/terminal.html" });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe("/gate.html?next=%2Fterminal.html");
    expect((await s.f.inject({ method: "POST", url: "/api/session", payload: {} })).statusCode).toBe(401);
    // Public: landing, the gate itself, health, share pages and assets.
    for (const url of ["/", "/index.html", "/gate.html", "/api/health", "/recap.html", "/qr.js"]) expect((await s.f.inject({ method: "GET", url })).statusCode, url).toBe(200);

    const bad = await s.f.inject({ method: "POST", url: "/api/gate", payload: { password: "nope" } });
    expect(bad.statusCode).toBe(403);
    const ok = await s.f.inject({ method: "POST", url: "/api/gate", payload: { password: "floor-2026" }, headers: { "x-forwarded-proto": "https" } });
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    const pass = cookie.split(";")[0]!;
    expect((await s.f.inject({ method: "GET", url: "/terminal.html", headers: { cookie: pass } })).statusCode).toBe(200);
    expect((await s.f.inject({ method: "POST", url: "/api/session", payload: {}, headers: { cookie: pass } })).statusCode).toBe(200);
    // A forged cookie doesn't pass.
    expect((await s.f.inject({ method: "GET", url: "/terminal.html", headers: { cookie: pass.slice(0, -3) + "abc" } })).statusCode).toBe(302);
    await s.f.close();
  });

  it("removing someone's code locks them out, others stay in", async () => {
    const both = new AccessGate(["anna-x7", "ben-q2"]);
    const anna = both.enter("anna-x7", true)!.split(";")[0]!;
    const ben = both.enter("ben-q2", true)!.split(";")[0]!;
    const onlyBen = new AccessGate(["ben-q2"]);
    expect(onlyBen.allows(anna)).toBe(false);
    expect(onlyBen.allows(ben)).toBe(true);
    expect(AccessGate.fromEnv({})).toBeUndefined();
    expect(AccessGate.fromEnv({ OUTCRY_ACCESS_PASSWORD: "a", OUTCRY_ACCESS_CODES: "b, c" })!.size).toBe(3);
  });

  it("slows down password guessing", async () => {
    const g = new AccessGate(["x"]);
    for (let i = 0; i < 10; i++) expect(g.limited("1.2.3.4")).toBe(false);
    expect(g.limited("1.2.3.4")).toBe(true);
    expect(g.limited("5.6.7.8")).toBe(false);
  });
});
