/**
 * Real wallets on Turnkey (pilot).
 *
 * Each Outcry user gets a Turnkey sub-organization holding one Solana wallet.
 * The sub-org's root user carries Outcry's server API key, so the server can
 * sign after Outcry's own checks pass (allowlist, caps, passkey approval).
 * That makes this pilot custodial; the next step is to make the user's
 * passkey the root user and limit the server key with Turnkey policies.
 *
 * Keys never leave Turnkey: we send an unsigned transaction and get it back
 * signed.
 */
import { Turnkey } from "@turnkey/sdk-server";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

export interface TurnkeyConfig {
  organizationId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  baseUrl?: string;
}

/** The subset of Turnkey's API we use (lets tests swap in a fake). */
export interface TurnkeyApi {
  getWhoami(input: { organizationId: string }): Promise<{ organizationId: string; organizationName?: string; userId?: string }>;
  createSubOrganization(input: Record<string, unknown>): Promise<{ subOrganizationId: string; wallet?: { walletId: string; addresses: string[] } }>;
  signTransaction(input: { organizationId: string; signWith: string; unsignedTransaction: string; type: "TRANSACTION_TYPE_SOLANA" }): Promise<{ signedTransaction: string }>;
  createUsers(input: Record<string, unknown>): Promise<{ userIds: string[] }>;
  createPolicy(input: Record<string, unknown>): Promise<{ policyId: string }>;
  updateRootQuorum(input: { organizationId: string; threshold: number; userIds: string[] }): Promise<unknown>;
}

/** Posts a request that the user's passkey stamped in the browser; the server only relays it. */
export type StampedPost = (path: string, body: string, stamp: string) => Promise<unknown>;

export interface RealWallet {
  userId: string;
  subOrgId: string;
  walletId: string;
  address: string;
  createdAt: string;
  /** "server": Outcry's key is root (pilot). "passkey": the user's passkey is the only root; the server can only sign swaps. */
  custody?: "server" | "enrolled" | "passkey";
  endUserId?: string;
  serverUserId?: string;
  credentialId?: string;
  policyIds?: string[];
}

export const SOLANA_PATH = "m/44'/501'/0'/0'";

export class TurnkeyWallets {
  /** userId -> wallet. Persisted. */
  readonly wallets = new Map<string, RealWallet>();
  private creating = new Map<string, Promise<RealWallet>>();
  private who?: { ok: boolean; at: number; organizationName?: string; error?: string };

  constructor(private cfg: TurnkeyConfig, private api: TurnkeyApi = TurnkeyWallets.client(cfg), private stamped: StampedPost = TurnkeyWallets.relay(cfg)) {}

  static relay(cfg: TurnkeyConfig): StampedPost {
    return async (path, body, stamp) => {
      const r = await fetch(`${cfg.baseUrl ?? "https://api.turnkey.com"}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Stamp-WebAuthn": stamp },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      const j = (await r.json().catch(() => ({}))) as { message?: string; details?: unknown };
      if (!r.ok) throw new Error(`Turnkey: ${j.message ?? r.status}`);
      return j;
    };
  }

  static client(cfg: TurnkeyConfig): TurnkeyApi {
    const tk = new Turnkey({
      apiBaseUrl: cfg.baseUrl ?? "https://api.turnkey.com",
      apiPublicKey: cfg.apiPublicKey,
      apiPrivateKey: cfg.apiPrivateKey,
      defaultOrganizationId: cfg.organizationId,
    });
    return tk.apiClient() as unknown as TurnkeyApi;
  }

  /** Checks the API key against the organization (cached for a minute). */
  async status() {
    if (!this.who || Date.now() - this.who.at > 60_000) {
      try {
        const w = await this.api.getWhoami({ organizationId: this.cfg.organizationId });
        this.who = { ok: true, at: Date.now(), organizationName: w.organizationName };
      } catch (e) {
        this.who = { ok: false, at: Date.now(), error: (e as Error).message.slice(0, 200) };
      }
    }
    return { ok: this.who.ok, organization: this.who.organizationName ?? null, error: this.who.error ?? null, wallets: this.wallets.size };
  }

  get(userId: string) {
    return this.wallets.get(userId);
  }

  /** Create the user's sub-organization and Solana wallet (once). */
  async ensure(userId: string): Promise<RealWallet> {
    const have = this.wallets.get(userId);
    if (have) return have;
    const pending = this.creating.get(userId);
    if (pending) return pending;
    const run = (async () => {
      const r = await this.api.createSubOrganization({
        organizationId: this.cfg.organizationId,
        subOrganizationName: `outcry-${userId}`,
        rootUsers: [
          {
            userName: `outcry-server-${userId}`,
            apiKeys: [{ apiKeyName: "outcry-server", publicKey: this.cfg.apiPublicKey, curveType: "API_KEY_CURVE_P256" }],
            authenticators: [],
            oauthProviders: [],
          },
        ],
        rootQuorumThreshold: 1,
        wallet: {
          walletName: "main",
          accounts: [{ curve: "CURVE_ED25519", pathFormat: "PATH_FORMAT_BIP32", path: SOLANA_PATH, addressFormat: "ADDRESS_FORMAT_SOLANA" }],
        },
      });
      const address = r.wallet?.addresses?.[0];
      if (!r.subOrganizationId || !r.wallet?.walletId || !address) throw new Error("Turnkey did not return a wallet");
      const w: RealWallet = { userId, subOrgId: r.subOrganizationId, walletId: r.wallet.walletId, address, createdAt: new Date().toISOString() };
      this.wallets.set(userId, w);
      return w;
    })();
    this.creating.set(userId, run);
    try {
      return await run;
    } finally {
      this.creating.delete(userId);
    }
  }

  /**
   * Step 1 of self-custody: add the user's new passkey to their sub-organization and
   * limit Outcry's server key with policies. The server stays root until step 2 proves
   * the passkey works, so a failed enrolment can never lock the user out.
   */
  async enrollPasskey(userId: string, p: { challenge: string; credentialId: string; clientDataJson: string; attestationObject: string; transports: string[]; label: string }) {
    const w = this.wallets.get(userId);
    if (!w) throw new Error("No real wallet for this account");
    if (w.custody === "passkey") throw new Error("This wallet is already self-custodial");
    const who = await this.api.getWhoami({ organizationId: w.subOrgId });
    const serverUserId = who.userId;
    if (!serverUserId) throw new Error("Turnkey didn't return the server user");
    const transports = p.transports.map((t) => `AUTHENTICATOR_TRANSPORT_${t.toUpperCase()}`).filter((t) => /_(BLE|INTERNAL|NFC|USB|HYBRID)$/.test(t));
    const u = await this.api.createUsers({
      organizationId: w.subOrgId,
      users: [{
        userName: `owner-${userId}`,
        apiKeys: [],
        authenticators: [{ authenticatorName: p.label.slice(0, 60), challenge: p.challenge, attestation: { credentialId: p.credentialId, clientDataJson: p.clientDataJson, attestationObject: p.attestationObject, transports } }],
        oauthProviders: [],
        userTags: [],
      }],
    });
    const endUserId = u.userIds[0];
    if (!endUserId) throw new Error("Turnkey didn't create the passkey user");
    const policyIds: string[] = [];
    for (const pol of serverPolicies(serverUserId, w.address)) {
      const r = await this.api.createPolicy({ organizationId: w.subOrgId, ...pol });
      policyIds.push(r.policyId);
    }
    Object.assign(w, { custody: "enrolled" as const, endUserId, serverUserId, credentialId: p.credentialId, policyIds });
    return { whoamiBody: JSON.stringify({ organizationId: w.subOrgId }), credentialId: p.credentialId };
  }

  /** Step 2: the passkey signed a whoami; if Turnkey says it's the new owner, hand root to it alone. */
  async confirmPasskey(userId: string, whoamiBody: string, stamp: string) {
    const w = this.wallets.get(userId);
    if (!w || w.custody !== "enrolled" || !w.endUserId) throw new Error("Enroll a wallet passkey first");
    const who = (await this.stamped("/public/v1/query/whoami", whoamiBody, stamp)) as { userId?: string; organizationId?: string };
    if (who.userId !== w.endUserId || who.organizationId !== w.subOrgId) throw new Error("That passkey isn't the one just enrolled");
    await this.api.updateRootQuorum({ organizationId: w.subOrgId, threshold: 1, userIds: [w.endUserId] });
    w.custody = "passkey";
    return w;
  }

  /** The exact request body the user's passkey must stamp to sign this transaction. */
  signBody(userId: string, base64Tx: string): string {
    const w = this.wallets.get(userId);
    if (!w) throw new Error("No real wallet for this account");
    return JSON.stringify({
      type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
      timestampMs: String(Date.now()),
      organizationId: w.subOrgId,
      parameters: { signWith: w.address, unsignedTransaction: Buffer.from(base64Tx, "base64").toString("hex"), type: "TRANSACTION_TYPE_SOLANA" },
    });
  }

  /** Relay a passkey-stamped sign request; returns the signed transaction (base64). */
  async submitStampedSign(userId: string, body: string, stamp: string): Promise<string> {
    const w = this.wallets.get(userId);
    if (!w) throw new Error("No real wallet for this account");
    const j = JSON.parse(body) as { organizationId?: string; parameters?: { signWith?: string } };
    if (j.organizationId !== w.subOrgId || j.parameters?.signWith !== w.address) throw new Error("Request doesn't match this wallet");
    const r = (await this.stamped("/public/v1/submit/sign_transaction", body, stamp)) as { activity?: { status?: string; result?: { signTransactionResult?: { signedTransaction?: string } } } };
    const signed = r.activity?.result?.signTransactionResult?.signedTransaction;
    if (!signed) throw new Error(`Turnkey didn't sign (${r.activity?.status ?? "no status"})`);
    return Buffer.from(signed, "hex").toString("base64");
  }

  /** Sign a serialized Solana transaction (base64 in, base64 out). */
  async signSolana(userId: string, base64Tx: string): Promise<string> {
    const w = this.wallets.get(userId);
    if (!w) throw new Error("No real wallet for this account");
    const r = await this.api.signTransaction({
      organizationId: w.subOrgId,
      signWith: w.address,
      unsignedTransaction: Buffer.from(base64Tx, "base64").toString("hex"),
      type: "TRANSACTION_TYPE_SOLANA",
    });
    return Buffer.from(r.signedTransaction, "hex").toString("base64");
  }
}

export function turnkeyFromEnv(env: Record<string, string | undefined>): TurnkeyWallets | undefined {
  const organizationId = env.TURNKEY_ORGANIZATION_ID?.trim();
  const apiPublicKey = env.TURNKEY_API_PUBLIC_KEY?.trim();
  const apiPrivateKey = env.TURNKEY_API_PRIVATE_KEY?.trim();
  if (!organizationId || !apiPublicKey || !apiPrivateKey) return undefined;
  return new TurnkeyWallets({ organizationId, apiPublicKey, apiPrivateKey, baseUrl: env.TURNKEY_BASE_URL?.trim() || undefined });
}

/**
 * What Outcry's server key may still do once the passkey is root:
 *  - sign transactions whose direct SOL transfers only wrap SOL into the wallet's own
 *    wSOL account, and that move none of the wallet's tokens directly (swaps happen
 *    inside the swap program);
 *  - add wallet accounts (for agent wallets).
 * Withdrawals therefore need the user's passkey.
 *
 * Known limit (hardening TODO): these rules see top-level transfers only. A holder of
 * the server key could still craft a swap whose output goes to another account, or
 * close the wSOL account to another address. Closing that gap needs instruction-level
 * policies (Turnkey IDL parsing for Jupiter, token CloseAccount/Approve/SetAuthority
 * and System Assign rules), tested against real swaps.
 */
export function serverPolicies(serverUserId: string, address: string) {
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(address)).toBase58();
  const consensus = `approvers.any(user, user.id == '${serverUserId}')`;
  return [
    {
      policyName: "outcry-server-swaps-only",
      effect: "EFFECT_ALLOW",
      consensus,
      condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && solana.tx.transfers.all(t, t.from != '${address}' || t.to == '${wsol}') && solana.tx.spl_transfers.all(t, t.owner != '${address}')`,
      notes: "Outcry may sign swaps for this wallet; it can't move SOL or tokens out. Withdrawals need the owner's passkey.",
    },
    {
      policyName: "outcry-server-agent-accounts",
      effect: "EFFECT_ALLOW",
      consensus,
      condition: "activity.type == 'ACTIVITY_TYPE_CREATE_WALLET_ACCOUNTS'",
      notes: "Outcry may add accounts (agent wallets) to this wallet.",
    },
  ];
}
