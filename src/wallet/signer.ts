/**
 * Signer / wallet service.
 *
 * Production: Turnkey. Each user is a Turnkey sub-organization; the user's
 * passkey is the root authenticator. Agent and launch wallets are separate
 * wallets inside that sub-org, each bound to a Turnkey policy that is
 * evaluated inside the enclave before any signature is produced.
 *
 * This module defines that contract and a simulated implementation that
 * enforces the same policy rules, so the rest of the stack behaves exactly as
 * it will against Turnkey. The simulated signer never touches real keys.
 */
import { createHash } from "node:crypto";
import { dayKey, newId } from "../core/infra.js";

export interface WalletPolicy {
  /** Programs / routers this wallet may call ("pumpfun", "jupiter", ...). */
  allowedVenues: string[];
  maxPerTxUsd: number;
  maxPerDayUsd: number;
  /** The only address transfers out may go to (the user's main wallet). */
  withdrawTo?: string;
}

export interface ManagedWallet {
  id: string;
  address: string;
  role: "main" | "agent" | "launch";
  ownerUserId: string;
  label: string;
  policy?: WalletPolicy;
  spentToday: { day: string; usd: number };
}

export interface SignRequest {
  walletId: string;
  venue: string;
  usd: number;
  kind: "trade" | "transfer" | "create";
  transferTo?: string;
  /** Proof the user approved: a passkey assertion id in production. */
  userApproval?: string;
  /** Set when an agent signs within its policy instead of the user. */
  agentId?: string;
  payload: unknown;
}

export interface Signature {
  walletId: string;
  signature: string;
}

export class PolicyDenied extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PolicyDenied";
  }
}

export interface Signer {
  createMainWallet(userId: string): { solana: ManagedWallet; evm: ManagedWallet };
  createSubWallet(userId: string, role: "agent" | "launch", label: string, policy: WalletPolicy): ManagedWallet;
  get(walletId: string): ManagedWallet | undefined;
  byAddress(address: string): ManagedWallet | undefined;
  sign(req: SignRequest): Signature;
}

const fakeAddress = (seed: string, chain: "solana" | "evm") => {
  const h = createHash("sha256").update(seed).digest();
  if (chain === "evm") return "0x" + h.subarray(0, 20).toString("hex");
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < 44; i++) out += alphabet[h[i % 32]! % alphabet.length];
  return out;
};

export class SimulatedTurnkeySigner implements Signer {
  private wallets = new Map<string, ManagedWallet>();

  createMainWallet(userId: string) {
    const mk = (chain: "solana" | "evm"): ManagedWallet => {
      const w: ManagedWallet = {
        id: newId("wal"),
        address: fakeAddress(`${userId}:${chain}:main`, chain),
        role: "main",
        ownerUserId: userId,
        label: `main-${chain}`,
        spentToday: { day: dayKey(), usd: 0 },
      };
      this.wallets.set(w.id, w);
      return w;
    };
    return { solana: mk("solana"), evm: mk("evm") };
  }

  createSubWallet(userId: string, role: "agent" | "launch", label: string, policy: WalletPolicy): ManagedWallet {
    const id = newId("wal");
    const w: ManagedWallet = {
      id,
      address: fakeAddress(`${userId}:${role}:${id}`, "solana"),
      role,
      ownerUserId: userId,
      label,
      policy,
      spentToday: { day: dayKey(), usd: 0 },
    };
    this.wallets.set(id, w);
    return w;
  }

  get(walletId: string) {
    return this.wallets.get(walletId);
  }

  byAddress(address: string) {
    return [...this.wallets.values()].find((w) => w.address === address);
  }

  /**
   * Mirrors Turnkey's in-enclave policy evaluation. Order matters: identity
   * (who approved) first, then venue, then amounts.
   */
  sign(req: SignRequest): Signature {
    const w = this.wallets.get(req.walletId);
    if (!w) throw new PolicyDenied("unknown wallet");

    if (w.role === "main") {
      // Main wallet: only a user passkey approval can sign. No agent keys.
      if (!req.userApproval) throw new PolicyDenied("main wallet requires user approval");
    } else {
      const p = w.policy!;
      if (!req.userApproval && !req.agentId) throw new PolicyDenied("sub-wallet requires an approval or an agent id");
      if (req.kind === "transfer") {
        if (!p.withdrawTo || req.transferTo !== p.withdrawTo) {
          throw new PolicyDenied("sub-wallet may only transfer back to the main wallet");
        }
      } else if (!p.allowedVenues.includes(req.venue)) {
        throw new PolicyDenied(`venue ${req.venue} not allowed for ${w.label}`);
      }
      if (req.kind !== "transfer") {
        if (req.usd > p.maxPerTxUsd + 1e-9) throw new PolicyDenied(`over per-transaction cap (${p.maxPerTxUsd} USD)`);
        const today = dayKey();
        if (w.spentToday.day !== today) w.spentToday = { day: today, usd: 0 };
        if (w.spentToday.usd + req.usd > p.maxPerDayUsd + 1e-9) {
          throw new PolicyDenied(`over daily cap (${p.maxPerDayUsd} USD)`);
        }
        w.spentToday.usd += req.usd;
      }
    }
    const signature = createHash("sha256")
      .update(JSON.stringify({ w: w.id, p: req.payload, t: Date.now(), n: Math.random() }))
      .digest("base64url");
    return { walletId: w.id, signature };
  }
}
