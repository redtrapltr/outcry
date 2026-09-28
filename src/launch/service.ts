/**
 * Token launches on pump.fun with a disclosed multi-wallet dev buy.
 *
 * Product rule enforced here, not a setting: every launch wallet is written
 * to the public creator registry and the disclosure line is appended to the
 * token description. There is no code path that skips either.
 */
import { AuditLog, EventBus, newId, nowIso } from "../core/infra.js";
import { LaunchRequest, type LaunchTicket } from "../core/types.js";
import type { UserStore } from "../core/users.js";
import type { SimulatedMarket } from "../data/market.js";
import { estimateDevShare, evaluateLaunch, DEFAULT_POLICY, type PolicyConfig } from "../policy/engine.js";
import type { TicketDesk } from "../tickets/desk.js";
import type { Signer } from "../wallet/signer.js";
import type { ExecutionMode } from "../adapters/router.js";
import { buildLaunchPlan, type LaunchPlan } from "./pumpfun.js";

export interface RegistryEntry {
  mint: string;
  ticker: string;
  creatorUserId: string;
  creatorBadge: string;
  wallets: { address: string; sol: number }[];
  devSharePct: number;
  launchedAt: string;
}

/** Public creator registry: served at GET /registry/:mint and read by agents. */
export class CreatorRegistry {
  private byMint = new Map<string, RegistryEntry>();
  add(e: RegistryEntry) {
    this.byMint.set(e.mint, e);
  }
  get(mint: string) {
    return this.byMint.get(mint);
  }
  all() {
    return [...this.byMint.values()];
  }
  isCreatorWallet(mint: string, address: string) {
    return !!this.byMint.get(mint)?.wallets.some((w) => w.address === address);
  }
}

export function disclosureLine(req: { wallets: number }, devSharePct: number) {
  return `Creator holds ~${devSharePct.toFixed(1)}% of supply across ${req.wallets} disclosed wallet${req.wallets > 1 ? "s" : ""} via Outcry.`;
}

export interface LaunchDeps {
  users: UserStore;
  signer: Signer;
  desk: TicketDesk;
  market: SimulatedMarket;
  registry: CreatorRegistry;
  audit: AuditLog;
  bus: EventBus;
  mode: ExecutionMode;
  launchFeeSol: number;
  policy?: PolicyConfig;
}

export class LaunchService {
  readonly plans = new Map<string, LaunchPlan>();
  constructor(private d: LaunchDeps) {}

  propose(userId: string, input: unknown): LaunchTicket {
    const parsed = LaunchRequest.safeParse(input);
    const now = nowIso();
    const user = this.d.users.get(userId);
    const base = {
      kind: "launch" as const,
      id: newId("tkt"),
      userId,
      source: { type: "user" as const },
      jacket: "launch" as const,
      createdAt: now,
      updatedAt: now,
      notes: [] as string[],
      warnings: [] as string[],
      fills: [],
      launchWallets: [] as string[],
      disclosureAccepted: false,
    };
    if (!parsed.success) {
      const t: LaunchTicket = {
        ...base,
        status: "rejected",
        rejection: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        request: input as LaunchTicket["request"],
        totalSol: 0,
        disclosure: "",
      };
      this.d.desk.tickets.set(t.id, t);
      return t;
    }
    const req = parsed.data;
    const totalSol = req.wallets * req.solPerWallet;
    const share = estimateDevShare(totalSol);
    const verdict = evaluateLaunch(req, (user.balances.SOL ?? 0) - this.d.launchFeeSol, this.d.policy ?? DEFAULT_POLICY);
    const t: LaunchTicket = {
      ...base,
      status: verdict.decision === "reject" ? "rejected" : "needs_confirmation",
      rejection: verdict.decision === "reject" ? verdict.reason : undefined,
      request: req,
      totalSol,
      disclosure: disclosureLine(req, share.pct),
      notes: verdict.decision === "reject" ? [] : [...verdict.notes, `Outcry launch fee: ${this.d.launchFeeSol} SOL (covers Jito tip, wallet signatures, IPFS)`],
      warnings: verdict.decision === "allow" ? verdict.warnings : [],
    };
    this.d.desk.tickets.set(t.id, t);
    this.d.audit.append(`user:${userId}`, "launch.proposed", { ticketId: t.id, ticker: req.ticker, wallets: req.wallets, totalSol, status: t.status, rejection: t.rejection });
    return t;
  }

  /** Update the steppers on an unsigned launch ticket (wallet count, SOL each, name). */
  revise(userId: string, ticketId: string, patch: Partial<Pick<LaunchRequest, "wallets" | "solPerWallet" | "name" | "ticker" | "description" | "imageDataUrl">>): LaunchTicket {
    const old = this.d.desk.get(ticketId);
    if (old.kind !== "launch" || old.userId !== userId) throw new Error("Not your launch ticket");
    if (old.status !== "needs_confirmation" && old.status !== "rejected") throw new Error(`Ticket is ${old.status}`);
    this.d.desk.setStatus(old, "cancelled");
    return this.propose(userId, { ...old.request, ...patch });
  }

  async approve(ticketId: string, opts: { userApproval?: string; disclosureAccepted?: boolean }): Promise<LaunchTicket> {
    const t = this.d.desk.get(ticketId);
    if (t.kind !== "launch") throw new Error("Not a launch ticket");
    if (t.status !== "needs_confirmation") throw new Error(`Ticket is ${t.status}; it can't be signed`);
    if (!opts.userApproval) throw new Error("Missing passkey approval");
    if (!opts.disclosureAccepted) throw new Error("Accept the creator-wallet disclosure to launch");
    t.disclosureAccepted = true;
    const user = this.d.users.get(t.userId);
    const actor = `user:${t.userId}`;
    this.d.desk.setStatus(t, "approved");

    try {
      // 1. Launch wallets with a pump.fun-only policy; withdrawals only to main.
      const perWalletUsd = t.request.solPerWallet * this.d.market.priceUsd("SOL") * 1.05;
      const wallets = Array.from({ length: t.request.wallets }, (_, i) =>
        this.d.signer.createSubWallet(t.userId, "launch", `launch-${t.request.ticker}-${i + 1}`, {
          allowedVenues: ["pumpfun"],
          maxPerTxUsd: perWalletUsd,
          maxPerDayUsd: perWalletUsd,
          withdrawTo: user.mainWallet.solana,
        }),
      );
      t.launchWallets = wallets.map((w) => w.address);

      // 2. Fund them from the main wallet (user passkey).
      const mainId = this.d.users.mainWalletId(t.userId);
      this.d.signer.sign({ walletId: mainId, venue: "system", usd: t.totalSol * this.d.market.priceUsd("SOL"), kind: "trade", userApproval: opts.userApproval, payload: { fund: t.launchWallets } });

      // 3. Build the create + N buys as one bundle, and sign each buy with its wallet.
      const mint = `${t.request.ticker.toLowerCase()}${newId("m").slice(2)}pump`;
      const plan = buildLaunchPlan({
        mint,
        creator: user.mainWallet.solana,
        metadata: { name: t.request.name, symbol: t.request.ticker, description: [t.request.description, t.disclosure].filter(Boolean).join("\n\n") },
        buys: wallets.map((w) => ({ wallet: w.address, sol: t.request.solPerWallet })),
      });
      this.plans.set(t.id, plan);
      for (const w of wallets) {
        this.d.signer.sign({ walletId: w.id, venue: "pumpfun", usd: t.request.solPerWallet * this.d.market.priceUsd("SOL"), kind: "trade", userApproval: opts.userApproval, payload: { mint, buy: w.address } });
      }

      if (this.d.mode === "live") {
        throw new Error("Live launches are disabled in v0; the bundle plan was built and not sent");
      }

      // 4. Paper settlement: tokens along the bonding curve, split evenly.
      this.d.desk.setStatus(t, "submitted");
      const share = estimateDevShare(t.totalSol);
      const perWalletTokens = share.tokens / wallets.length;
      const registryWallets = wallets.map((w) => ({ address: w.address, sol: t.request.solPerWallet }));
      this.d.registry.add({
        mint,
        ticker: t.request.ticker,
        creatorUserId: t.userId,
        creatorBadge: user.badge,
        wallets: registryWallets,
        devSharePct: share.pct,
        launchedAt: nowIso(),
      });
      // Spot price on the curve after the dev buy: virtual SOL / virtual tokens.
      const priceAfter = ((30 + t.totalSol) / (1_073_000_000 - share.tokens)) * this.d.market.priceUsd("SOL");
      this.d.market.registerMeme(
        {
          mint,
          symbol: t.request.ticker,
          ageMinutes: 0,
          holders: wallets.length,
          holdersCollapsed: 1,
          topWalletPct: Number((share.pct / wallets.length).toFixed(2)),
          mintRevoked: true,
          freezeRevoked: true,
          liquidityUsd: Math.round((30 + t.totalSol) * this.d.market.priceUsd("SOL")),
          creatorWallets: wallets.map((w) => w.address),
          flags: ["outcry-launch", "disclosed-creator-wallets"],
        },
        priceAfter,
      );
      t.mint = mint;
      this.d.users.applyDeltas(t.userId, { SOL: -(t.totalSol + this.d.launchFeeSol) });
      this.d.users.applyDeltas(t.userId, { [t.request.ticker]: share.tokens });
      this.d.users.recordBuy(t.userId, t.request.ticker, share.tokens, t.totalSol * this.d.market.priceUsd("SOL"), "launch", `${wallets.length} disclosed launch wallets`);
      t.fills = wallets.map((w, i) => ({ legIndex: i, txId: `paper_bundle_${mint.slice(0, 8)}_${i + 1}`, amountIn: t.request.solPerWallet, amountOut: perWalletTokens, price: t.request.solPerWallet / perWalletTokens, at: nowIso() }));
      this.d.desk.setStatus(t, "filled");
      this.d.audit.append(actor, "launch.filled", { ticketId: t.id, mint, wallets: t.launchWallets, devSharePct: share.pct, disclosure: t.disclosure });
      this.d.bus.publish({ type: "fill", userId: t.userId, ticketId: t.id, summary: `$${t.request.ticker} launched on pump.fun; dev buy across ${wallets.length} wallets` });
      this.d.bus.publish({ type: "balances", userId: t.userId, balances: { ...user.balances } });
    } catch (e) {
      this.d.desk.setStatus(t, "failed", (e as Error).message);
      this.d.audit.append(actor, "launch.failed", { ticketId: t.id, error: (e as Error).message });
    }
    return t;
  }
}
