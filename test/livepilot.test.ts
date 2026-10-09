import { describe, expect, it } from "vitest";
import { createOutcry } from "../src/app.js";
import { TurnkeyWallets, type TurnkeyApi } from "../src/wallet/turnkey.js";
import { JupiterSwap, SolanaRpc, SOL_MINT } from "../src/live/chain.js";
import { LivePilot } from "../src/live/pilot.js";

const MINT = "GrXMbn56JtFngA2FgoXenJG5HeD1GhvFnjyFPWbfpump";
const ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

function setup(over: Partial<{ allow: string[]; sol: number; tokenRaw: string; execStatus: "Success" | "Failed" }> = {}) {
  const app = createOutcry({ mode: "paper" } as never);
  const u = app.users.create({ badge: "THI", jacket: "memes", residence: "CH" });
  app.users.setHandle(u.id, "thiago");
  const calls: { sub: Record<string, unknown>[]; sign: { organizationId: string; signWith: string; unsignedTransaction: string }[]; exec: unknown[]; orders: URLSearchParams[] } = { sub: [], sign: [], exec: [], orders: [] };
  const api: TurnkeyApi = {
    getWhoami: async () => ({ organizationId: "org", organizationName: "Woodeng" }),
    createSubOrganization: async (i) => (calls.sub.push(i), { subOrganizationId: "sub_1", wallet: { walletId: "w_1", addresses: [ADDR] } }),
    signTransaction: async (i) => (calls.sign.push(i), { signedTransaction: i.unsignedTransaction + "ff" }),
  };
  const wallets = new TurnkeyWallets({ organizationId: "org", apiPublicKey: "02pub", apiPrivateKey: "priv" }, api);
  const json = (j: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => j, text: async () => JSON.stringify(j) });
  const jup = new JupiterSwap({ apiKey: "k" }, async (url, init) => {
    if (url.includes("/order?")) {
      const q = new URLSearchParams(url.split("?")[1]);
      calls.orders.push(q);
      const buy = q.get("inputMint") === SOL_MINT;
      return json({ transaction: Buffer.from("unsigned-tx").toString("base64"), requestId: "req_1", inAmount: q.get("amount"), outAmount: buy ? "123000000" : "50000000", router: "metis", feeBps: 10 });
    }
    calls.exec.push(JSON.parse(String(init?.body)));
    return json({ status: over.execStatus ?? "Success", signature: "5igSig", code: over.execStatus === "Failed" ? -1000 : 0, totalOutputAmount: "120000000" });
  });
  const rpc = new SolanaRpc("http://rpc", async (_u, init) => {
    const m = JSON.parse(String(init?.body)).method;
    if (m === "getBalance") return json({ result: { value: Math.round((over.sol ?? 1) * 1e9) } });
    const prog = JSON.parse(String(init?.body)).params[1].programId;
    if (prog.startsWith("Tokenkeg") && over.tokenRaw) return json({ result: { value: [{ account: { data: { parsed: { info: { mint: MINT, tokenAmount: { amount: over.tokenRaw, decimals: 6, uiAmount: 0 } } } } } }] } });
    return json({ result: { value: [] } });
  });
  const pilot = new LivePilot(
    { enabled: true, allowlist: over.allow ?? ["thiago"], maxOrderUsd: 25, maxDailyUsd: 40, reserveSol: 0.01 },
    { users: app.users, wallets, jupiter: jup, rpc, audit: app.audit, solUsd: () => 200, tokenInfo: async (ms) => Object.fromEntries(ms.map((m) => [m, { symbol: "CANDACE", decimals: 6, usdPrice: 0.0001 }])) },
  );
  return { app, u, pilot, calls, wallets };
}

describe("live trading pilot", () => {
  it("blocks users who aren't allowlisted or have no passkey", async () => {
    const { u, pilot } = setup({ allow: ["someoneelse"] });
    expect(pilot.status(u.id, true).reason).toMatch(/pilot list/);
    await expect(pilot.createWallet(u.id, true)).rejects.toThrow(/pilot list/);
    const s2 = setup();
    expect(s2.pilot.status(s2.u.id, false).reason).toMatch(/passkey/);
  });

  it("creates one Turnkey sub-org per user with the server key as root", async () => {
    const { u, pilot, calls } = setup();
    const [a, b] = await Promise.all([pilot.createWallet(u.id, true), pilot.createWallet(u.id, true)]);
    expect(a.address).toBe(ADDR);
    expect(b.address).toBe(ADDR);
    expect(calls.sub).toHaveLength(1);
    const root = (calls.sub[0]!.rootUsers as { apiKeys: { publicKey: string }[] }[])[0]!;
    expect(root.apiKeys[0]!.publicKey).toBe("02pub");
    expect(JSON.stringify(calls.sub[0])).toContain("ADDRESS_FORMAT_SOLANA");
  });

  it("buys within caps, signs with Turnkey, executes once, enforces the daily cap", async () => {
    const { u, pilot, calls } = setup();
    await pilot.createWallet(u.id, true);
    await expect(pilot.quote(u.id, true, { side: "buy", token: MINT, usd: 30 })).rejects.toThrow(/\$25 per buy/);
    const q = await pilot.quote(u.id, true, { side: "buy", token: MINT, usd: 20 });
    expect(calls.orders[0]!.get("amount")).toBe(String(Math.floor((20 / 200) * 1e9)));
    expect(calls.orders[0]!.get("taker")).toBe(ADDR);
    expect(q.receiveAmount).toBeCloseTo(123, 6);
    expect(JSON.stringify(q)).not.toContain("unsigned"); // the raw transaction stays server-side
    await expect(pilot.execute(u.id, true, q.id, "")).rejects.toThrow(/passkey/);
    const t = await pilot.execute(u.id, true, q.id, "webauthn:x");
    expect(t.status).toBe("confirmed");
    expect(calls.sign[0]!.organizationId).toBe("sub_1");
    expect(calls.sign[0]!.unsignedTransaction).toBe(Buffer.from("unsigned-tx").toString("hex"));
    expect(Buffer.from((calls.exec[0] as { signedTransaction: string }).signedTransaction, "base64").toString("hex")).toBe(Buffer.from("unsigned-tx").toString("hex") + "ff");
    await expect(pilot.execute(u.id, true, q.id, "webauthn:x")).rejects.toThrow(/already used/);
    expect(pilot.spentToday(u.id)).toBeCloseTo(20, 6);
    await expect(pilot.quote(u.id, true, { side: "buy", token: MINT, usd: 25 })).rejects.toThrow(/per day/);
    expect(pilot.history(u.id)[0]!.explorer).toContain("solscan.io/tx/5igSig");
  });

  it("keeps a SOL reserve, sells a share of the holding, records failures", async () => {
    const low = setup({ sol: 0.05 });
    await low.pilot.createWallet(low.u.id, true);
    await expect(low.pilot.quote(low.u.id, true, { side: "buy", token: MINT, usd: 10 })).rejects.toThrow(/Not enough SOL/);

    const s = setup({ tokenRaw: "1000000000", execStatus: "Failed" });
    await s.pilot.createWallet(s.u.id, true);
    const q = await s.pilot.quote(s.u.id, true, { side: "sell", token: MINT, pct: 50 });
    expect(s.calls.orders[0]!.get("amount")).toBe("500000000");
    expect(s.calls.orders[0]!.get("outputMint")).toBe(SOL_MINT);
    expect(q.usd).toBeCloseTo(0.05 * 200, 6);
    const t = await s.pilot.execute(s.u.id, true, q.id, "webauthn:x");
    expect(t.status).toBe("failed");
    expect(s.app.audit.since(0).some((e) => e.action === "live.swap_failed")).toBe(true);
  });
});
