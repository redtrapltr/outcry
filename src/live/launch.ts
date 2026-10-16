/**
 * Real pump.fun launches (PumpPortal Local Transaction API + Jito bundles).
 *
 *  1. Metadata (image + JSON) goes to IPFS through Pinata (pump.fun no longer
 *     accepts uploads).
 *  2. One wallet: a single "create" transaction that includes the dev buy,
 *     signed by the creator (main wallet) and the new mint key.
 *     Several wallets (max 5, disclosed): extra launch accounts are funded
 *     first (one transaction from the real wallet, signed like a withdrawal),
 *     then create + buys go out as one Jito bundle: all land or none do.
 *  3. Every launch wallet is written to Outcry's public creator registry and
 *     the disclosure line is added to the token description.
 *
 * PumpPortal charges 0.5% on the dev buys; token creation itself is free.
 */
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { newId, nowIso, type AuditLog } from "../core/infra.js";
import type { LaunchRequest } from "../core/types.js";
import type { CreatorRegistry } from "../launch/service.js";
import type { TurnkeyWallets } from "../wallet/turnkey.js";
import type { SolanaRpc } from "./chain.js";
import { buildMultiTransfer } from "./withdraw.js";

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; statusText?: string; json(): Promise<unknown>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

export const MAX_BUNDLE_WALLETS = 5;
/** SOL each extra launch account gets on top of its buy: network fee + token account deposit + margin. */
export const LAUNCH_ACCOUNT_OVERHEAD_SOL = 0.012;

export interface RealLaunch {
  id: string;
  userId: string;
  ticketId: string;
  request: LaunchRequest;
  disclosure: string;
  mint: string;
  /** Kept only until the launch is sent (signs the create transaction). */
  mintSecret?: number[];
  uri?: string;
  creator: string;
  extraAccounts: string[];
  status: "funding" | "ready" | "awaiting_signature" | "sent" | "confirmed" | "failed";
  fundingWithdrawalId?: string;
  signatures?: string[];
  /** Unsigned create transaction waiting for the wallet passkey (self-custodial creators). */
  pendingCreateTx?: string;
  pendingRest?: string[];
  error?: string;
  createdAt: string;
}

export interface LauncherDeps {
  wallets: TurnkeyWallets;
  rpc: SolanaRpc;
  registry: CreatorRegistry;
  audit: AuditLog;
  creatorBadge: (userId: string) => string;
  pinataJwt?: string;
  jitoUrl?: string;
  fetch?: FetchLike;
  notify?: (userId: string, text: string) => void;
  onLaunched?: (l: RealLaunch, totalSol: number) => void;
}

export class RealLauncher {
  readonly launches = new Map<string, RealLaunch>();

  constructor(private d: LauncherDeps) {}

  private get f(): FetchLike {
    return this.d.fetch ?? ((u, i) => fetch(u, { ...(i as RequestInit), signal: i?.signal ?? AbortSignal.timeout(30_000) }) as never);
  }

  get(userId: string, id: string) {
    const l = this.launches.get(id);
    if (!l || l.userId !== userId) throw Object.assign(new Error("Launch not found"), { status: 404 });
    return l;
  }

  // --- metadata ----------------------------------------------------------------------
  private async pinFile(blob: Blob, name: string): Promise<string> {
    if (!this.d.pinataJwt) throw new Error("Real launches need IPFS hosting: set PINATA_JWT (free account at pinata.cloud)");
    const form = new FormData();
    form.append("file", blob, name);
    form.append("network", "public");
    const r = await this.f("https://uploads.pinata.cloud/v3/files", { method: "POST", headers: { Authorization: `Bearer ${this.d.pinataJwt}` }, body: form });
    const j = (await r.json().catch(() => ({}))) as { data?: { cid?: string }; error?: { message?: string } };
    if (!r.ok || !j.data?.cid) throw new Error(`IPFS upload failed (${r.status}): ${j.error?.message ?? "no details"}`);
    return j.data.cid;
  }

  async uploadMetadata(req: LaunchRequest, description: string): Promise<string> {
    let image: Blob, imageName: string;
    const m = req.imageDataUrl?.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/i);
    if (m) {
      image = new Blob([Buffer.from(m[2]!, "base64")], { type: m[1] });
      imageName = `${req.ticker}.${m[1]!.split("/")[1]!.replace("+xml", "")}`;
    } else {
      // No image given: a simple generated logo with the ticker.
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" rx="96" fill="#2F3CFF"/><text x="256" y="300" font-family="Arial Black,Arial,sans-serif" font-size="${Math.max(56, 200 - req.ticker.length * 18)}" fill="#F3EFE4" text-anchor="middle">$${req.ticker}</text></svg>`;
      image = new Blob([svg], { type: "image/svg+xml" });
      imageName = `${req.ticker}.svg`;
    }
    const imageCid = await this.pinFile(image, imageName);
    const link = (u?: string) => (u && /^https?:\/\//i.test(u.trim()) ? u.trim() : undefined);
    const meta = { name: req.name, symbol: req.ticker, description, image: `https://ipfs.io/ipfs/${imageCid}`, showName: true, createdOn: "https://outcry.app", twitter: link(req.twitter), telegram: link(req.telegram), website: link(req.website) };
    const metaCid = await this.pinFile(new Blob([JSON.stringify(meta)], { type: "application/json" }), "metadata.json");
    return `https://ipfs.io/ipfs/${metaCid}`;
  }

  // --- flow --------------------------------------------------------------------------
  /**
   * Step 1: metadata, mint key, launch accounts. Returns the funding transfer to sign
   * when there are extra wallets (prepared by `prepareFunding`), else the launch is ready.
   */
  async prepare(userId: string, ticketId: string, req: LaunchRequest, disclosure: string, prepareFunding: (to: { address: string; sol: number }[], label: string) => Promise<{ id: string }>) {
    const w = this.d.wallets.get(userId);
    if (!w) throw new Error("Create your real wallet first");
    if (req.wallets > MAX_BUNDLE_WALLETS) throw new Error(`Real launches support up to ${MAX_BUNDLE_WALLETS} wallets (one Jito bundle)`);
    const description = [req.description, disclosure].filter(Boolean).join("\n\n");
    const uri = await this.uploadMetadata(req, description);
    const mint = Keypair.generate();
    const id = newId("rl");
    const extraAccounts: string[] = [];
    for (let i = 1; i < req.wallets; i++) extraAccounts.push(await this.d.wallets.agentAccount(userId, `launch:${id}:${i}`));
    const l: RealLaunch = {
      id, userId, ticketId, request: req, disclosure, mint: mint.publicKey.toBase58(), mintSecret: [...mint.secretKey], uri,
      creator: w.address, extraAccounts, status: extraAccounts.length ? "funding" : "ready", createdAt: nowIso(),
    };
    this.launches.set(id, l);
    let funding;
    if (extraAccounts.length) {
      funding = await prepareFunding(extraAccounts.map((a) => ({ address: a, sol: req.solPerWallet + LAUNCH_ACCOUNT_OVERHEAD_SOL })), `$${req.ticker} launch wallets`);
      l.fundingWithdrawalId = funding.id;
    }
    this.d.audit.append(`user:${userId}`, "launch.real_prepared", { launchId: id, mint: l.mint, wallets: req.wallets, uri });
    return { launch: this.publicView(l), funding };
  }

  private tradeArgs(l: RealLaunch) {
    const create = {
      publicKey: l.creator, action: "create", tokenMetadata: { name: l.request.name, symbol: l.request.ticker, uri: l.uri },
      mint: l.mint, denominatedInSol: "true", amount: l.request.solPerWallet, slippage: 10, priorityFee: 0.0005, pool: "pump",
    };
    const buys = l.extraAccounts.map((a) => ({ publicKey: a, action: "buy", mint: l.mint, denominatedInSol: "true", amount: l.request.solPerWallet, slippage: 50, priorityFee: 0.0001, pool: "pump" }));
    return { create, buys };
  }

  /**
   * Step 2: build the transactions. The creator's signature comes from Turnkey: by the
   * server for server-custody wallets, or by the wallet passkey (returned as a body to
   * stamp) for self-custodial ones.
   */
  async build(userId: string, id: string) {
    const l = this.get(userId, id);
    if (l.status === "funding") {
      for (const a of l.extraAccounts) {
        const sol = await this.d.rpc.solBalance(a);
        if (sol + 1e-9 < l.request.solPerWallet + LAUNCH_ACCOUNT_OVERHEAD_SOL * 0.9) throw new Error("Launch wallets aren't funded yet: sign the funding transfer first");
      }
      l.status = "ready";
    }
    if (l.status !== "ready") throw new Error(`This launch is ${l.status}`);
    const { create, buys } = this.tradeArgs(l);
    let txs: Uint8Array[];
    if (!buys.length) {
      const r = await this.f("https://pumpportal.fun/api/trade-local", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(create) });
      if (!r.ok) throw new Error(`PumpPortal: ${r.status} ${r.statusText ?? ""} ${(await r.text().catch(() => "")).slice(0, 160)}`.trim());
      txs = [new Uint8Array(await r.arrayBuffer())];
    } else {
      const r = await this.f("https://pumpportal.fun/api/trade-local", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([create, ...buys]) });
      if (!r.ok) throw new Error(`PumpPortal: ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
      const list = (await r.json()) as string[];
      if (!Array.isArray(list) || list.length !== buys.length + 1) throw new Error("PumpPortal returned an unexpected bundle");
      txs = list.map((x) => bs58.decode(x));
    }
    l.pendingCreateTx = Buffer.from(txs[0]!).toString("base64");
    l.pendingRest = txs.slice(1).map((t) => Buffer.from(t).toString("base64"));
    const custody = this.d.wallets.get(userId)?.custody;
    if (custody === "passkey") {
      l.status = "awaiting_signature";
      return { needsPasskey: true as const, body: this.d.wallets.signBody(userId, l.pendingCreateTx), credentialId: this.d.wallets.get(userId)?.credentialId };
    }
    return this.send(userId, id, await this.d.wallets.signSolana(userId, l.pendingCreateTx));
  }

  /** Self-custodial creators: the passkey stamp for the create transaction. */
  async sendWithStamp(userId: string, id: string, body: string, stamp: string) {
    const l = this.get(userId, id);
    if (l.status !== "awaiting_signature") throw new Error(`This launch is ${l.status}`);
    return this.send(userId, id, await this.d.wallets.submitStampedSign(userId, body, stamp));
  }

  /** Add the mint key's signature, sign the buys with their launch accounts, send (Jito bundle when several). */
  private async send(userId: string, id: string, creatorSigned: string) {
    const l = this.get(userId, id);
    const mint = Keypair.fromSecretKey(Uint8Array.from(l.mintSecret ?? []));
    const createTx = VersionedTransaction.deserialize(Buffer.from(creatorSigned, "base64"));
    createTx.sign([mint]);
    const signed: VersionedTransaction[] = [createTx];
    for (let i = 0; i < (l.pendingRest ?? []).length; i++) {
      const s = await this.d.wallets.signSolana(userId, l.pendingRest![i]!, l.extraAccounts[i]);
      signed.push(VersionedTransaction.deserialize(Buffer.from(s, "base64")));
    }
    l.signatures = signed.map((t) => bs58.encode(t.signatures[0]!));
    l.status = "sent";
    try {
      if (signed.length === 1) {
        await this.d.rpc.send(Buffer.from(createTx.serialize()).toString("base64"));
      } else {
        const r = await this.f(this.d.jitoUrl ?? "https://mainnet.block-engine.jito.wtf/api/v1/bundles", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendBundle", params: [signed.map((t) => bs58.encode(t.serialize()))] }),
        });
        const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
        if (!r.ok || j.error) throw new Error(`Jito: ${j.error?.message ?? r.status}`);
      }
      const err = await this.d.rpc.confirm(l.signatures[0]!, 60_000);
      if (err) throw new Error(signed.length > 1 ? `The bundle didn't land (${err}). Nothing was bought; your launch wallets still hold their SOL.` : err);
      l.status = "confirmed";
    } catch (e) {
      l.status = "failed";
      l.error = (e as Error).message.slice(0, 300);
    }
    // The mint key is only needed to create the token: drop it.
    delete l.mintSecret;
    delete l.pendingCreateTx;
    delete l.pendingRest;
    if (l.status === "confirmed") {
      const totalSol = l.request.solPerWallet * l.request.wallets;
      this.d.registry.add({
        mint: l.mint, ticker: l.request.ticker, creatorUserId: userId, creatorBadge: this.d.creatorBadge(userId),
        wallets: [l.creator, ...l.extraAccounts].map((address) => ({ address, sol: l.request.solPerWallet })),
        devSharePct: 0, launchedAt: nowIso(),
      } as never);
      this.d.onLaunched?.(l, totalSol);
      this.d.notify?.(userId, `🚀 $${l.request.ticker} is live on pump.fun\nhttps://pump.fun/coin/${l.mint}`);
    }
    this.d.audit.append(`user:${userId}`, l.status === "confirmed" ? "launch.real_confirmed" : "launch.real_failed", { launchId: id, mint: l.mint, signatures: l.signatures, error: l.error });
    return this.publicView(l);
  }

  publicView(l: RealLaunch) {
    const { mintSecret: _m, pendingCreateTx: _c, pendingRest: _r, ...pub } = l;
    return { ...pub, pumpUrl: `https://pump.fun/coin/${l.mint}`, explorer: l.signatures?.[0] ? `https://solscan.io/tx/${l.signatures[0]}` : null };
  }

  listFor(userId: string) {
    return [...this.launches.values()].filter((l) => l.userId === userId).map((l) => this.publicView(l)).reverse();
  }
}
