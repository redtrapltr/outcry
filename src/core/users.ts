import type { Jacket, UserProfile } from "./types.js";
import { newId } from "./infra.js";
import type { MarketData } from "../data/market.js";
import type { Signer } from "../wallet/signer.js";

export interface Position {
  symbol: string;
  amount: number;
  costUsd: number;
  jacket: Jacket;
  note?: string;
}

/** In-memory user store. Production: Postgres tables users, balances, positions. */
export class UserStore {
  private users = new Map<string, UserProfile>();
  private mainWalletIds = new Map<string, { solana: string; evm: string }>();
  private positions = new Map<string, Map<string, Position>>();

  constructor(private signer: Signer, private market: MarketData) {}

  create(opts: { badge: string; jacket: Jacket; residence: string; paperBalances?: Record<string, number> }): UserProfile {
    const id = newId("usr");
    const w = this.signer.createMainWallet(id);
    const user: UserProfile = {
      id,
      badge: opts.badge.toUpperCase().slice(0, 4),
      jacket: opts.jacket,
      residence: opts.residence.toUpperCase(),
      mainWallet: { solana: w.solana.address, evm: w.evm.address },
      balances: { ...(opts.paperBalances ?? { SOL: 24, USDC: 2_480 }) },
      medianOrderUsd: 150,
      settings: { secondConfirmAbovePctOfWallet: 25, frontierEscalationUsd: 1_000 },
    };
    this.users.set(id, user);
    this.mainWalletIds.set(id, { solana: w.solana.id, evm: w.evm.id });
    this.positions.set(id, new Map());
    return user;
  }

  /** True if any user holds a balance of this asset (used to keep live tokens tracked). */
  /** Set a unique public @handle: 3-16 letters, digits or underscores. */
  setHandle(userId: string, raw: string) {
    const h = String(raw).trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_]{3,16}$/.test(h)) throw new Error("A handle is 3 to 16 letters, digits or underscores");
    if (["outcry", "woodeng", "admin", "support", "official"].includes(h)) throw new Error(`@${h} is reserved`);
    for (const u of this.users.values()) if (u.id !== userId && u.handle === h) throw new Error(`@${h} is taken`);
    const u = this.get(userId);
    u.handle = h;
    return u;
  }

  /** Public bio shown on the creator profile (160 characters, plain text). */
  setBio(userId: string, raw: string) {
    const u = this.get(userId);
    u.bio = String(raw).replace(/\s+/g, " ").trim().slice(0, 160) || undefined;
    return u;
  }

  /** The user who owns this @handle, if any. */
  byHandle(raw: string): UserProfile | undefined {
    const h = String(raw).trim().replace(/^@/, "").toLowerCase();
    for (const u of this.users.values()) if (u.handle === h) return u;
    return undefined;
  }

  /** Every asset symbol any user holds a balance of. */
  heldSymbols(): Set<string> {
    const out = new Set<string>();
    for (const u of this.users.values()) for (const [k, v] of Object.entries(u.balances)) if (v > 0) out.add(k);
    return out;
  }

  anyHolds(symbol: string) {
    for (const u of this.users.values()) if ((u.balances[symbol] ?? 0) > 0) return true;
    return false;
  }

  get(id: string): UserProfile {
    const u = this.users.get(id);
    if (!u) throw new Error("unknown user");
    return u;
  }

  mainWalletId(userId: string, chain: "solana" | "evm" = "solana"): string {
    return this.mainWalletIds.get(userId)![chain];
  }

  walletUsd(userId: string): number {
    const u = this.get(userId);
    return Object.entries(u.balances).reduce((s, [sym, amt]) => {
      try {
        return s + amt * this.market.priceUsd(sym);
      } catch {
        return s;
      }
    }, 0);
  }

  applyDeltas(userId: string, deltas: Record<string, number>) {
    const u = this.get(userId);
    for (const [sym, d] of Object.entries(deltas)) {
      const next = (u.balances[sym] ?? 0) + d;
      if (next < -1e-9) throw new Error(`balance of ${sym} would go negative`);
      u.balances[sym] = Math.abs(next) < 1e-12 ? 0 : next;
    }
  }

  recordBuy(userId: string, symbol: string, amount: number, costUsd: number, jacket: Jacket, note?: string) {
    const map = this.positions.get(userId)!;
    const p = map.get(symbol) ?? { symbol, amount: 0, costUsd: 0, jacket, note };
    p.amount += amount;
    p.costUsd += costUsd;
    if (note) p.note = note;
    map.set(symbol, p);
  }

  recordSell(userId: string, symbol: string, amount: number) {
    const map = this.positions.get(userId)!;
    const p = map.get(symbol);
    if (!p) return;
    const frac = Math.min(1, amount / p.amount);
    p.costUsd *= 1 - frac;
    p.amount -= amount;
    if (p.amount <= 1e-12) map.delete(symbol);
  }

  portfolio(userId: string) {
    const u = this.get(userId);
    const pos = [...this.positions.get(userId)!.values()].map((p) => {
      let valueUsd = 0;
      try {
        valueUsd = p.amount * this.market.priceUsd(p.symbol);
      } catch {
        /* unknown price */
      }
      return { ...p, valueUsd, pnlUsd: valueUsd - p.costUsd };
    });
    return { balances: { ...u.balances }, walletUsd: this.walletUsd(userId), positions: pos };
  }
}
