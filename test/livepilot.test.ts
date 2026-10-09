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
  const calls: { sub: Record<string, unknown>[]; sign: { organizationId: string; signWith: string; unsignedTransaction: string }[]; exec: unknown[]; orders: URLSearchParams[]; sent: string[]; users: Record<string, unknown>[]; policies: Record<string, unknown>[]; quorum: unknown[]; stamped: { path: string; body: string; stamp: string }[] } = { sub: [], sign: [], exec: [], orders: [], sent: [], users: [], policies: [], quorum: [], stamped: [] };
  const api: TurnkeyApi = {
    getWhoami: async (i) => ({ organizationId: i.organizationId, organizationName: "Woodeng", userId: "server_user" }),
    createSubOrganization: async (i) => (calls.sub.push(i), { subOrganizationId: "sub_1", wallet: { walletId: "w_1", addresses: [ADDR] } }),
    signTransaction: async (i) => (calls.sign.push(i), { signedTransaction: i.unsignedTransaction + "ff" }),
    createUsers: async (i) => (calls.users.push(i), { userIds: ["owner_user"] }),
    createPolicy: async (i) => (calls.policies.push(i), { policyId: `pol_${calls.policies.length}` }),
    updateRootQuorum: async (i) => (calls.quorum.push(i), {}),
    createWalletAccounts: async () => ({ addresses: ["AgentAcct1111111111111111111111111111111111"] }),
  };
  const stampedPost = async (path: string, body: string, stamp: string) => {
    calls.stamped.push({ path, body, stamp });
    if (path.endsWith("whoami")) return stamp === "good" ? { organizationId: "sub_1", userId: "owner_user" } : { organizationId: "sub_1", userId: "someone_else" };
    const j = JSON.parse(body);
    return { activity: { status: "ACTIVITY_STATUS_COMPLETED", result: { signTransactionResult: { signedTransaction: j.parameters.unsignedTransaction + "aa" } } } };
  };
  const wallets = new TurnkeyWallets({ organizationId: "org", apiPublicKey: "02pub", apiPrivateKey: "priv" }, api, stampedPost);
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
    if (m === "getLatestBlockhash") return json({ result: { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 } } });
    if (m === "getAccountInfo") return json({ result: { value: { owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" } } });
    if (m === "sendTransaction") { calls.sent.push(JSON.parse(String(init?.body)).params[0]); return json({ result: "sigW" }); }
    if (m === "getSignatureStatuses") return json({ result: { value: [{ confirmationStatus: "confirmed", err: null }] } });
    if (m === "getTransaction") {
      const spent = 100_000_000 + 5_000 + 2_039_280; // 0.1 SOL swap + fee + new token account
      return json({ result: { meta: { err: null, fee: 5_000, preBalances: [1e9, 0, 0], postBalances: [1e9 - spent, 2_039_280, 0],
        preTokenBalances: [], postTokenBalances: [{ owner: ADDR, mint: MINT, uiTokenAmount: { uiAmount: 199_000, uiAmountString: "199000" } }] },
        transaction: { message: { accountKeys: [{ pubkey: ADDR }, { pubkey: "ata" }, { pubkey: "wsol" }] } } } });
    }
    const prog = JSON.parse(String(init?.body)).params[1].programId;
    if (prog.startsWith("Tokenkeg") && over.tokenRaw && JSON.parse(String(init?.body)).params[0] === ADDR) return json({ result: { value: [{ account: { data: { parsed: { info: { mint: MINT, tokenAmount: { amount: over.tokenRaw, decimals: 6, uiAmount: 0 } } } } } }] } });
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
    const open = setup({ allow: ["*"] });
    expect(open.pilot.status(open.u.id, true).eligible).toBe(true);
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
    // Costs read back from the chain: SOL $200, token $0.0001 -> paid $20 of SOL, got $19.90 of token.
    const c = t.costs!;
    expect(c.networkFeeUsd).toBeCloseTo(0.001, 6);
    expect(c.rentUsd).toBeCloseTo(0.407856, 5);
    expect(c.swapEdgeUsd).toBeCloseTo(-0.1, 6);
    expect(c.outcryFeeUsd).toBe(0);
    expect(c.totalCostUsd).toBeCloseTo(0.101, 6);
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

describe("real orders from the chat", () => {
  it("parses real-money requests and shows a real ticket; plain orders stay paper", async () => {
    const { parseRealOrder, REAL_MONEY, OfflineProvider } = await import("../src/llm/offline.js");
    expect(REAL_MONEY.test("buy $2 of USDC with real money")).toBe(true);
    expect(REAL_MONEY.test("buy 4 SOL")).toBe(false);
    expect(parseRealOrder("buy $2 of usdc with real money")).toEqual({ side: "buy", token: "USDC", usd: 2 });
    expect(parseRealOrder(`sell half my ${MINT} for real`)).toEqual({ side: "sell", token: MINT, pct: 50 });
    expect(parseRealOrder("buy microsoft stock with real money, 3$ worth of it")).toEqual({ side: "buy", token: "MSFT", usd: 3 });
    expect(parseRealOrder("buy something with real money").token).toBe("");

    const { ModelRouter } = await import("../src/llm/router.js");
    const { Orchestrator } = await import("../src/orchestrator/orchestrator.js");
    const s = setup();
    await s.pilot.createWallet(s.u.id, true);
    const orch = new Orchestrator(s.app, new ModelRouter({ providers: { offline: new OfflineProvider() } }));
    orch.tools.live = { pilot: s.pilot, secured: () => true };
    const r = await orch.handle(s.u.id, "c1", "buy $2 of USDC with real money");
    const card = r.cards.find((c) => c.type === "live_order") as { quote: { usd: number; symbol: string } } | undefined;
    expect(card?.quote.usd).toBe(2);
    expect(r.reply).toMatch(/real money/i);
    const paper = await orch.handle(s.u.id, "c1", "buy 1 SOL");
    expect(paper.cards.some((c) => c.type === "order")).toBe(true);
    expect(paper.cards.some((c) => c.type === "live_order")).toBe(false);
  });
});

describe("pay with USDC and stock spreads", () => {
  it("falls back to USDC when the SOL route fails", async () => {
    const s = setup({ tokenRaw: "0" });
    await s.pilot.createWallet(s.u.id, true);
    // Make the SOL route fail and give the wallet 50 USDC.
    const jup = s.pilot.jupiter as unknown as { order: (p: { inputMint: string }) => Promise<unknown> };
    const orig = jup.order.bind(jup);
    jup.order = async (p) => { if (p.inputMint === SOL_MINT) throw new Error("no route"); return orig(p as never); };
    const rpc = (s.pilot as unknown as { d: { rpc: { tokens: () => Promise<unknown[]> } } }).d.rpc;
    rpc.tokens = async () => [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: 50, decimals: 6, raw: "50000000" }];
    const q = await s.pilot.quote(s.u.id, true, { side: "buy", token: MINT, usd: 4 });
    expect(q.payAsset).toBe("USDC");
    expect(q.base).toBe("USDC");
    expect(s.calls.orders.at(-1)!.get("amount")).toBe("4000000");
  });

  it("scans executable spreads and nets Outcry's fee on both legs", async () => {
    const { SpreadScanner } = await import("../src/live/spreads.js");
    // MSFTon is cheaper: $100 buys 0.2 shares ($500/sh); selling 0.2 MSFTx returns $102 ($510/sh).
    const jup = { quoteOnly: async (p: { inputMint: string; outputMint: string; amount: bigint }) =>
      p.outputMint === "onmint" ? { inAmount: p.amount.toString(), outAmount: String(0.2 * 1e8) } : { inAmount: p.amount.toString(), outAmount: String(102 * 1e6) } };
    const sc = new SpreadScanner(jup as never, () => [{ ticker: "MSFT", a: { symbol: "MSFTx", mint: "xmint", decimals: 8, priceUsd: 528 }, b: { symbol: "MSFTon", mint: "onmint", decimals: 8, priceUsd: 521 } }], () => 50, 0);
    const r = await sc.scan(100);
    const row = r.rows[0]!;
    expect(row.cheap).toBe("MSFTon");
    expect(row.buyCheapPx).toBeCloseTo(500, 6);
    expect(row.sellRichPx).toBeCloseTo(510, 6);
    expect(row.discountPct).toBeCloseTo((1 - 500 / 510) * 100, 6);
    expect(row.swapEdgePct).toBeCloseTo(((102 * 0.995 - 100 * 1.005) / 100) * 100, 6); // +1.0% net
  });
});

describe("withdrawals", () => {
  it("sends SOL or a Token-2022 token to a regular wallet, after approval, and refuses bad addresses", async () => {
    const { Keypair, Transaction, SystemInstruction, PublicKey } = await import("@solana/web3.js");
    const { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } = await import("@solana/spl-token");
    const s = setup({ sol: 0.5, tokenRaw: "1000000000" });
    await s.pilot.createWallet(s.u.id, true);
    const dest = Keypair.generate().publicKey.toBase58();
    await expect(s.pilot.prepareWithdrawal(s.u.id, true, { to: "nope", token: "SOL", amount: 0.1 })).rejects.toThrow(/valid Solana address/);
    const ata = getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(dest), false, TOKEN_2022_PROGRAM_ID).toBase58();
    await expect(s.pilot.prepareWithdrawal(s.u.id, true, { to: ata, token: "SOL", amount: 0.1 })).rejects.toThrow(/regular wallet/);
    await expect(s.pilot.prepareWithdrawal(s.u.id, true, { to: dest, token: "SOL", amount: 1 })).rejects.toThrow(/at most/);

    const p = await s.pilot.prepareWithdrawal(s.u.id, true, { to: dest, token: "SOL", amount: 0.1 });
    expect(JSON.stringify(p)).not.toContain('"tx"');
    await expect(s.pilot.executeWithdrawal(s.u.id, true, p.id, "")).rejects.toThrow(/passkey/);
    const r = await s.pilot.executeWithdrawal(s.u.id, true, p.id, "webauthn:x");
    expect(r.status).toBe("confirmed");
    expect(r.explorer).toContain("sigW");
    const tx = Transaction.from(Buffer.from(Buffer.from(s.calls.sign[0]!.unsignedTransaction, "hex")));
    const transfer = tx.instructions.find((i) => i.programId.toBase58() === "11111111111111111111111111111111")!;
    const d = SystemInstruction.decodeTransfer(transfer);
    expect(d.toPubkey.toBase58()).toBe(dest);
    expect(Number(d.lamports)).toBe(100_000_000);
    await expect(s.pilot.executeWithdrawal(s.u.id, true, p.id, "webauthn:x")).rejects.toThrow(/not found/);

    const t = await s.pilot.prepareWithdrawal(s.u.id, true, { to: dest, token: MINT, max: true });
    expect(t.amount).toBe(1000);
    expect(t.createsAccountSol).toBeGreaterThan(0);
    await s.pilot.executeWithdrawal(s.u.id, true, t.id, "webauthn:x");
    const ttx = Transaction.from(Buffer.from(s.calls.sign[1]!.unsignedTransaction, "hex"));
    expect(ttx.instructions.at(-1)!.programId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(s.pilot.withdrawalHistory(s.u.id)).toHaveLength(2);
    expect(s.app.audit.since(0).filter((e) => e.action === "live.withdraw_confirmed")).toHaveLength(2);
  });
});

describe("withdrawals from the chat", () => {
  it("only to an address the user typed; the model can't change it", async () => {
    const { Keypair } = await import("@solana/web3.js");
    const { OfflineProvider } = await import("../src/llm/offline.js");
    const { ModelRouter } = await import("../src/llm/router.js");
    const { Orchestrator } = await import("../src/orchestrator/orchestrator.js");
    const s = setup({ sol: 0.5 });
    await s.pilot.createWallet(s.u.id, true);
    const orch = new Orchestrator(s.app, new ModelRouter({ providers: { offline: new OfflineProvider() } }));
    orch.tools.live = { pilot: s.pilot, secured: () => true };
    const dest = Keypair.generate().publicKey.toBase58();
    const r = await orch.handle(s.u.id, "w1", `send 0.01 SOL to ${dest}`);
    const card = r.cards.find((c) => c.type === "live_withdraw") as { withdrawal: { to: string; amount: number } } | undefined;
    expect(card?.withdrawal.to).toBe(dest);
    expect(card?.withdrawal.amount).toBe(0.01);
    // A tool call with an address that isn't in the user's message is refused.
    const other = Keypair.generate().publicKey.toBase58();
    const bad = await orch.tools.run(s.u.id, "propose_withdrawal", { to: other, token: "SOL", amount: 0.01 }, { userText: `send 0.01 SOL to ${dest}` });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad.result)).toMatch(/pasted/);
  });

  it("retries the Solana RPC when the connection drops", async () => {
    let n = 0;
    const rpc = new SolanaRpc("http://rpc", async () => {
      if (++n < 3) throw new Error("fetch failed");
      return { ok: true, status: 200, json: async () => ({ result: { value: 2e9 } }), text: async () => "" };
    });
    expect(await rpc.solBalance(ADDR)).toBe(2);
    expect(n).toBe(3);
  });
});

describe("reclaim deposits", () => {
  it("closes empty token accounts back into the wallet", async () => {
    const { Transaction } = await import("@solana/web3.js");
    const s = setup({ sol: 0.5 });
    await s.pilot.createWallet(s.u.id, true);
    const rpc = (s.pilot as unknown as { d: { rpc: { emptyTokenAccounts: () => Promise<unknown[]> } } }).d.rpc;
    rpc.emptyTokenAccounts = async () => [{ pubkey: "So11111111111111111111111111111111111111112", program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", lamports: 2_039_280 }];
    expect((await s.pilot.reclaimable(s.u.id)).sol).toBeCloseTo(0.00203928, 9);
    const w = await s.pilot.prepareReclaim(s.u.id, true);
    expect(w.to).toBe(ADDR);
    expect(w.asset).toMatch(/reclaimed/);
    await s.pilot.executeWithdrawal(s.u.id, true, w.id, "webauthn:x");
    const tx = Transaction.from(Buffer.from(s.calls.sign.at(-1)!.unsignedTransaction, "hex"));
    expect(tx.instructions.at(-1)!.programId.toBase58()).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    rpc.emptyTokenAccounts = async () => [];
    await expect(s.pilot.prepareReclaim(s.u.id, true)).rejects.toThrow(/Nothing to reclaim/);
  });
});

describe("self-custody (passkey owns the wallet)", () => {
  it("enrols the passkey, limits the server, verifies before switching root, then withdrawals need the passkey", async () => {
    const { Keypair, PublicKey } = await import("@solana/web3.js");
    const { NATIVE_MINT, getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const s = setup({ sol: 0.5 });
    await s.pilot.createWallet(s.u.id, true);
    await expect(s.pilot.enrollPasskey(s.u.id, true, { id: "cred1", response: { clientDataJSON: "cd", attestationObject: "ao" } })).rejects.toThrow(/expired/);
    s.pilot.rememberCustodyChallenge(s.u.id, "chal123");
    const e = await s.pilot.enrollPasskey(s.u.id, true, { id: "cred1", response: { clientDataJSON: "cd", attestationObject: "ao", transports: ["internal", "hybrid", "weird"] } });
    const auth = (s.calls.users[0]!.users as { authenticators: { challenge: string; attestation: { credentialId: string; transports: string[] } }[] }[])[0]!.authenticators[0]!;
    expect(auth.challenge).toBe("chal123");
    expect(auth.attestation.transports).toEqual(["AUTHENTICATOR_TRANSPORT_INTERNAL", "AUTHENTICATOR_TRANSPORT_HYBRID"]);
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(ADDR)).toBase58();
    const swap = s.calls.policies[0] as { consensus: string; condition: string };
    expect(swap.consensus).toContain("server_user");
    expect(swap.condition).toContain(`t.to == '${wsol}'`);
    expect(swap.condition).toContain(`t.owner != '${ADDR}'`);
    expect(s.calls.quorum).toHaveLength(0); // not switched before the passkey is proven
    expect(s.pilot.status(s.u.id, true).custody).toBe("enrolled");

    await expect(s.pilot.confirmCustody(s.u.id, true, e.whoamiBody, "bad")).rejects.toThrow(/isn't the one/);
    expect(s.calls.quorum).toHaveLength(0);
    await s.pilot.confirmCustody(s.u.id, true, e.whoamiBody, "good");
    expect(s.calls.quorum[0]).toEqual({ organizationId: "sub_1", threshold: 1, userIds: ["owner_user"] });
    expect(s.pilot.status(s.u.id, true).custody).toBe("passkey");

    // Withdrawals now go through the passkey stamp, never the server key.
    const dest = Keypair.generate().publicKey.toBase58();
    const w = await s.pilot.prepareWithdrawal(s.u.id, true, { to: dest, token: "SOL", amount: 0.01 });
    expect(w.turnkey?.credentialId).toBe("cred1");
    expect(JSON.parse(w.turnkey!.body).organizationId).toBe("sub_1");
    await expect(s.pilot.executeWithdrawal(s.u.id, true, w.id, "webauthn:x")).rejects.toThrow(/wallet passkey/);
    const signsBefore = s.calls.sign.length;
    const r = await s.pilot.executeWithdrawal(s.u.id, true, w.id, "turnkey-passkey", "stamp-xyz");
    expect(r.status).toBe("confirmed");
    expect(s.calls.sign.length).toBe(signsBefore);
    expect(s.calls.stamped.at(-1)).toMatchObject({ path: "/public/v1/submit/sign_transaction", stamp: "stamp-xyz" });
  });
});

describe("real-money agents", () => {
  it("trades its own account through realExec, then closes positions", async () => {
    const app = createOutcry({ mode: "paper" } as never);
    const u = app.users.create({ badge: "THI", jacket: "memes", residence: "CH" });
    const spec = {
      name: "REALBOT", goal: "test", markets: ["memes"], kind: "sniper",
      universe: { venue: "pumpfun", minHolders: 7, maxTopWalletPct: 33, maxAgeSeconds: 600 },
      sizeUsd: 10, exit: { stopLossPct: 20, takeProfitPct: 50 },
      limits: { maxPerTradeUsd: 10, maxPerDayUsd: 50, maxOpenPositions: 3, maxDrawdownPct: 90 }, mode: "paper",
    };
    const a = app.agents.propose(u.id, spec).agent;
    app.agents.deploy(u.id, a.id, { mode: "paper" });
    const swaps: { side: string; mint: string; size: unknown }[] = [];
    app.agents.realExec = {
      swap: async (_a, side, mint, size) => (swaps.push({ side, mint, size }), side === "buy" ? { ok: true, signature: "s1", tokenAmount: (size.usd ?? 0) / app.market.priceUsd("REALM"), solAmount: (size.usd ?? 0) / app.market.priceUsd("SOL") } : { ok: true, signature: "s2", solAmount: 0.2 }),
      solBalance: async () => 0.5,
    };
    app.agents.goReal(u.id, a.id, "AgentAddr1111111111111111111111111111111111", 0.5);
    expect(app.agents.get(a.id)!.real?.address).toBe("AgentAddr1111111111111111111111111111111111");
    const mint = "RealMemeMint11111111111111111111111111pump";
    app.market.spawnMeme("REALM", { mint, holders: 50, holdersCollapsed: 50 });
    await app.agents.tick();
    await app.agents.tick();
    expect(swaps[0]).toMatchObject({ side: "buy", mint });
    expect(app.agents.positionsOf(a.id)).toHaveLength(1);
    expect(app.desk.listForUser(u.id).some((t) => t.kind === "order")).toBe(false); // no paper tickets
    // Simulated memes (sim... mints) are never bought with real money.
    app.market.spawnMeme("SIMM", { holders: 50, holdersCollapsed: 50 });
    await app.agents.tick();
    expect(swaps.filter((x) => x.side === "buy")).toHaveLength(1);
    const left = await app.agents.closeAllReal(u.id, a.id);
    expect(left).toBe(0);
    expect(swaps.at(-1)).toMatchObject({ side: "sell", mint, size: { pct: 100 } });
    expect(app.agents.perf(a.id)!.trades.map((t) => t.side)).toEqual(["buy", "sell"]);
  });
});

describe("growth: tiers, rebates, referrals, waitlist", () => {
  it("rebates the difference to the tier, pays referrers, and approves access", async () => {
    const { Growth } = await import("../src/live/growth.js");
    const g = new Growth();
    expect(g.tierFor("a").name).toBe("Floor");
    g.recordTrade("a", 9_000, 50);
    expect(g.tierFor("a").next?.remainingUsd).toBeCloseTo(1_000, 6);
    g.recordTrade("a", 2_000, 50); // tier computed before this trade: Floor -> no rebate
    expect(g.tierFor("a").name).toBe("Pit");
    const r = g.recordTrade("a", 1_000, 50); // Pit: 0.4% -> 0.1% back
    expect(r.rebateUsd).toBeCloseTo(1, 6);
    expect(g.tierFor("a").rebateOwedUsd).toBeCloseTo(1, 6);
    // Fee not applied on-chain -> nothing to rebate.
    expect(g.recordTrade("a", 1_000, 0).rebateUsd).toBe(0);
    // Volume older than 30 days drops out.
    expect(g.tierFor("a", Date.now() + 31 * 86_400_000).name).toBe("Floor");

    expect(g.setReferrer("b", "a")).toBe(true);
    expect(g.setReferrer("b", "c")).toBe(false);
    expect(g.setReferrer("a", "a")).toBe(false);
    const rb = g.recordTrade("b", 100, 50); // fee $0.50, Outcry keeps 80% = $0.40, referrer 20% = $0.08
    expect(rb.referralUsd).toBeCloseTo(0.08, 6);
    expect(g.referralStats("a")).toMatchObject({ invited: 1 });

    // Waitlist: approval makes a non-allowlisted user eligible.
    const s = setup({ allow: [] });
    (s.pilot as unknown as { d: { growth: unknown } }).d.growth = s.app.growth;
    expect(s.pilot.status(s.u.id, true).eligible).toBe(false);
    s.app.growth.requestAccess(s.u.id, "thiago", "please");
    expect(s.app.growth.pending()).toHaveLength(1);
    s.app.growth.decide(s.u.id, true, "admin");
    expect(s.pilot.status(s.u.id, true).eligible).toBe(true);
  });

  it("records referrals at sign-up through the API", async () => {
    const { buildServer } = await import("../src/api/server.js");
    const srv = await buildServer({ store: null, tickMs: 0, simLaunchEveryMs: 0 } as never);
    const a = (await srv.f.inject({ method: "POST", url: "/api/session", payload: {} })).json();
    await srv.f.inject({ method: "PATCH", url: "/api/me", headers: { authorization: `Bearer ${a.token}` }, payload: { handle: "inviter" } });
    const b = (await srv.f.inject({ method: "POST", url: "/api/session", payload: { ref: "inviter" } })).json();
    expect(srv.app.growth.referredBy.get(b.user.id)).toBe(a.user.id);
    await srv.f.close();
  });
});
