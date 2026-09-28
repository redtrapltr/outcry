/**
 * Builds the pump.fun launch bundle as a transport-neutral plan.
 *
 * The live implementation turns each step into Solana instructions with
 * @solana/web3.js against the pump.fun program and submits them as a single
 * Jito bundle, so the create and every dev buy land in the same block.
 * Keeping the plan as data lets us test ordering, amounts and disclosure
 * without a network, and log exactly what will be sent.
 *
 * Verify before going live: program id, instruction layouts and the current
 * bonding-curve constants (see policy/engine.ts).
 */
export const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export interface LaunchPlanInput {
  mint: string;
  creator: string;
  metadata: { name: string; symbol: string; description: string; imageUri?: string };
  buys: { wallet: string; sol: number }[];
  jitoTipSol?: number;
  slippageBps?: number;
}

export type LaunchStep =
  | { op: "upload_metadata"; name: string; symbol: string; description: string; imageUri?: string }
  | { op: "create"; program: string; mint: string; creator: string }
  | { op: "buy"; program: string; mint: string; wallet: string; maxSolCost: number }
  | { op: "jito_tip"; payer: string; sol: number };

export interface LaunchPlan {
  bundle: LaunchStep[];
  /** Steps grouped into transactions: a Jito bundle holds at most 5. */
  transactions: LaunchStep[][];
  totalSol: number;
}

/** Jito bundles carry at most 5 transactions; buys are packed to fit. */
export const JITO_MAX_TXS = 5;
export const BUYS_IN_CREATE_TX = 3;
export const BUYS_PER_TX = 4;
export const MAX_LAUNCH_WALLETS = BUYS_IN_CREATE_TX + BUYS_PER_TX * (JITO_MAX_TXS - 1); // 19

export function buildLaunchPlan(input: LaunchPlanInput): LaunchPlan {
  if (input.buys.length === 0) throw new Error("at least one dev-buy wallet is required");
  if (!input.metadata.description.includes("disclosed wallet")) {
    // Disclosure is a hard requirement; refuse to build a plan without it.
    throw new Error("launch metadata must include the creator-wallet disclosure");
  }
  const slip = (input.slippageBps ?? 500) / 10_000;
  const bundle: LaunchStep[] = [
    { op: "upload_metadata", ...input.metadata },
    { op: "create", program: PUMPFUN_PROGRAM_ID, mint: input.mint, creator: input.creator },
    ...input.buys.map((b) => ({ op: "buy" as const, program: PUMPFUN_PROGRAM_ID, mint: input.mint, wallet: b.wallet, maxSolCost: +(b.sol * (1 + slip)).toFixed(9) })),
    { op: "jito_tip", payer: input.creator, sol: input.jitoTipSol ?? 0.001 },
  ];
  if (input.buys.length > MAX_LAUNCH_WALLETS) {
    throw new Error(`at most ${MAX_LAUNCH_WALLETS} launch wallets fit in one Jito bundle`);
  }
  const [meta, create, ...rest] = bundle;
  const buys = rest.filter((s) => s.op === "buy");
  const tip = rest.find((s) => s.op === "jito_tip")!;
  void meta; // metadata upload happens off-chain, before the bundle
  const transactions: LaunchStep[][] = [[create!, ...buys.slice(0, BUYS_IN_CREATE_TX)]];
  for (let i = BUYS_IN_CREATE_TX; i < buys.length; i += BUYS_PER_TX) transactions.push(buys.slice(i, i + BUYS_PER_TX));
  transactions.at(-1)!.push(tip);
  return { bundle, transactions, totalSol: input.buys.reduce((s, b) => s + b.sol, 0) };
}
