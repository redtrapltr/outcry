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
}

export interface RealWallet {
  userId: string;
  subOrgId: string;
  walletId: string;
  address: string;
  createdAt: string;
}

export const SOLANA_PATH = "m/44'/501'/0'/0'";

export class TurnkeyWallets {
  /** userId -> wallet. Persisted. */
  readonly wallets = new Map<string, RealWallet>();
  private creating = new Map<string, Promise<RealWallet>>();
  private who?: { ok: boolean; at: number; organizationName?: string; error?: string };

  constructor(private cfg: TurnkeyConfig, private api: TurnkeyApi = TurnkeyWallets.client(cfg)) {}

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
