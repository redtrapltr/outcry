/**
 * Core domain types for Outcry.
 *
 * Everything that crosses a trust boundary (LLM tool arguments, API bodies,
 * agent specs, strategy programs) is described by a zod schema here and
 * parsed before use. The LLM never produces transactions, only these objects.
 */
import { z } from "zod";

export const Chain = z.enum(["solana", "base", "ethereum"]);
export type Chain = z.infer<typeof Chain>;

/** Market "jackets": one colour per market in the Outcry Floor identity. */
export const Jacket = z.enum(["memes", "stocks", "swaps", "launch", "strategies", "research"]);
export type Jacket = z.infer<typeof Jacket>;

export const Venue = z.enum(["pumpfun", "jupiter", "uniswap", "ondo", "xstocks", "paper"]);
export type Venue = z.infer<typeof Venue>;

export const AssetKind = z.enum(["native", "stable", "token", "tokenized_stock"]);
export const Asset = z.object({
  symbol: z.string().min(1).max(16),
  chain: Chain,
  kind: AssetKind,
  /** mint (Solana) or contract address (EVM). Absent for natives. */
  address: z.string().optional(),
  decimals: z.number().int().min(0).max(18),
});
export type Asset = z.infer<typeof Asset>;

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export const OrderLeg = z.object({
  side: z.enum(["buy", "sell"]),
  /** Asset being bought or sold, by symbol ("SOL", "NVDAon") or address. */
  asset: z.string().min(1),
  /** What the user pays with on a buy, or receives on a sell. */
  quoteAsset: z.string().min(1).default("USDC"),
  /** Amount of quoteAsset to spend (buy) or of asset to sell (sell). For exact-output buys this is filled in by the quote. */
  amount: z.number().nonnegative().finite(),
  /** Buy exactly this quantity of `asset` ("buy 4 SOL"); the quote works out how much quoteAsset it costs. */
  receiveExact: z.number().positive().finite().optional(),
  maxSlippageBps: z.number().int().min(1).max(5_000).default(50),
  venue: Venue.optional(),
});
export type OrderLeg = z.infer<typeof OrderLeg>;

export const TicketSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user") }),
  z.object({ type: z.literal("agent"), agentId: z.string() }),
]);
export type TicketSource = z.infer<typeof TicketSource>;

export const TicketStatus = z.enum([
  "proposed", // created by a tool call, not yet checked
  "needs_confirmation", // passed policy, waiting for the user
  "needs_second_confirmation", // passed policy but large relative to wallet or habits
  "rejected", // failed policy
  "approved", // user tapped Sign, or agent limits approved
  "submitted",
  "filled",
  "failed",
  "cancelled",
]);
export type TicketStatus = z.infer<typeof TicketStatus>;

export interface QuotedLeg extends OrderLeg {
  venue: Venue;
  chain: Chain;
  expectedOut: number;
  priceImpactBps: number;
  venueFeeUsd: number;
  platformFeeUsd: number;
  route: string;
}

export interface Fill {
  legIndex: number;
  txId: string;
  amountIn: number;
  amountOut: number;
  price: number;
  at: string;
}

interface TicketBase {
  id: string;
  userId: string;
  source: TicketSource;
  jacket: Jacket;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  /** Human-readable lines shown on the ticket (fees, risks, checks). */
  notes: string[];
  warnings: string[];
  rejection?: string;
  fills: Fill[];
}

export interface OrderTicket extends TicketBase {
  kind: "order";
  legs: QuotedLeg[];
  totalUsd: number;
}

// ---------------------------------------------------------------------------
// Token launches
// ---------------------------------------------------------------------------

export const LaunchRequest = z.object({
  name: z.string().min(1).max(32),
  ticker: z
    .string()
    .min(2)
    .max(10)
    .transform((s) => s.replace(/^\$/, "").toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]+$/, "ticker must be letters and digits")),
  description: z.string().max(500).default(""),
  imageDataUrl: z.string().optional(),
  /** Max 16: create + buys must fit one Jito bundle (5 transactions). */
  wallets: z.number().int().min(1).max(16),
  solPerWallet: z.number().positive().max(50),
});
export type LaunchRequest = z.infer<typeof LaunchRequest>;

export interface LaunchTicket extends TicketBase {
  kind: "launch";
  request: LaunchRequest;
  totalSol: number;
  /** Disclosure text appended to token metadata and shown on the ticket. */
  disclosure: string;
  disclosureAccepted: boolean;
  launchWallets: string[];
  mint?: string;
}

export type Ticket = OrderTicket | LaunchTicket;

// ---------------------------------------------------------------------------
// Strategy DSL (shared by the Strategy Lab and the agent runtime)
// ---------------------------------------------------------------------------

export const PriceField = z.enum(["open", "high", "low", "close", "volume"]);

export type ValueExpr =
  | number
  | z.infer<typeof PriceField>
  | { sma: number }
  | { ema: number }
  | { rsi: number }
  | { atr: number }
  | { roc: number }
  | { vwap: number }
  | { macd: [number, number, number] }
  | { macd_signal: [number, number, number] }
  | { bb_upper: [number, number] }
  | { bb_lower: [number, number] }
  | { highest: number }
  | { lowest: number };

const period = z.number().int().min(1).max(500);
export const ValueExprSchema: z.ZodType<ValueExpr> = z.union([
  z.number().finite(),
  PriceField,
  z.object({ sma: period }).strict(),
  z.object({ ema: period }).strict(),
  z.object({ rsi: period }).strict(),
  z.object({ atr: period }).strict(),
  z.object({ roc: period }).strict(),
  z.object({ vwap: period }).strict(),
  z.object({ macd: z.tuple([period, period, period]) }).strict(),
  z.object({ macd_signal: z.tuple([period, period, period]) }).strict(),
  z.object({ bb_upper: z.tuple([period, z.number().positive().max(5)]) }).strict(),
  z.object({ bb_lower: z.tuple([period, z.number().positive().max(5)]) }).strict(),
  z.object({ highest: period }).strict(),
  z.object({ lowest: period }).strict(),
]);

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { gt: [ValueExpr, ValueExpr] }
  | { lt: [ValueExpr, ValueExpr] }
  | { crosses_above: [ValueExpr, ValueExpr] }
  | { crosses_below: [ValueExpr, ValueExpr] }
  | { stop_loss_pct: number }
  | { take_profit_pct: number }
  | { trailing_stop_pct: number }
  | { bars_held_gte: number };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema).min(1).max(12) }).strict(),
    z.object({ any: z.array(ConditionSchema).min(1).max(12) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
    z.object({ gt: z.tuple([ValueExprSchema, ValueExprSchema]) }).strict(),
    z.object({ lt: z.tuple([ValueExprSchema, ValueExprSchema]) }).strict(),
    z.object({ crosses_above: z.tuple([ValueExprSchema, ValueExprSchema]) }).strict(),
    z.object({ crosses_below: z.tuple([ValueExprSchema, ValueExprSchema]) }).strict(),
    z.object({ stop_loss_pct: z.number().positive().max(95) }).strict(),
    z.object({ take_profit_pct: z.number().positive().max(10_000) }).strict(),
    z.object({ trailing_stop_pct: z.number().positive().max(95) }).strict(),
    z.object({ bars_held_gte: z.number().int().positive().max(10_000) }).strict(),
  ]),
);

export const Timeframe = z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]);
export type Timeframe = z.infer<typeof Timeframe>;

export const StrategyProgram = z.object({
  name: z.string().min(1).max(40).default("Untitled"),
  timeframe: Timeframe,
  asset: z.string().min(1),
  entry: ConditionSchema,
  exit: ConditionSchema,
  size: z.union([
    z.object({ risk_pct_of_equity: z.number().positive().max(100) }).strict(),
    z.object({ fixed_quote: z.number().positive() }).strict(),
  ]),
  feesBps: z.number().min(0).max(500).default(30),
  slippageBps: z.number().min(0).max(500).default(10),
});
export type StrategyProgram = z.infer<typeof StrategyProgram>;

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const AgentMode = z.enum(["ask", "auto", "paper"]);
export type AgentMode = z.infer<typeof AgentMode>;

export const AgentState = z.enum(["draft", "backtested", "paper", "live", "paused", "killed"]);
export type AgentState = z.infer<typeof AgentState>;

export const AgentLimits = z.object({
  maxPerTradeUsd: z.number().positive(),
  maxPerDayUsd: z.number().positive(),
  maxOpenPositions: z.number().int().positive().max(50),
  maxDrawdownPct: z.number().positive().max(95),
});
export type AgentLimits = z.infer<typeof AgentLimits>;

/** Filters for token-sniping agents (new launches). */
export const TokenUniverse = z.object({
  venue: z.literal("pumpfun"),
  minHolders: z.number().int().min(0).default(200),
  maxTopWalletPct: z.number().min(1).max(100).default(20),
  /** Skip if the 10 largest holders own more than this share of supply. */
  maxTop10Pct: z.number().min(1).max(100).optional(),
  /** Only buy launches younger than this (seconds since the create transaction). */
  maxAgeSeconds: z.number().int().min(1).max(86_400).default(3_600),
  requireMintRevoked: z.boolean().default(true),
  /** Count disclosed creator wallets as one holder (Outcry launch registry). */
  collapseCreatorWallets: z.boolean().default(true),
});

export const AgentSpec = z.object({
  name: z.string().min(1).max(18),
  goal: z.string().max(300).default(""),
  markets: z.array(Jacket).min(1),
  /** Either a price-rule strategy on one asset, or a token-universe sniper. */
  kind: z.enum(["rules", "sniper"]),
  program: StrategyProgram.optional(),
  universe: TokenUniverse.optional(),
  sizeUsd: z.number().positive(),
  exit: z.object({
    stopLossPct: z.number().positive().max(95),
    takeProfitPct: z.number().positive().max(10_000),
  }),
  limits: AgentLimits,
  mode: AgentMode.default("paper"),
});
export type AgentSpec = z.infer<typeof AgentSpec>;

export interface Agent {
  id: string;
  userId: string;
  version: number;
  spec: AgentSpec;
  state: AgentState;
  subWalletId: string;
  subWalletAddress: string;
  /** Funds held by the agent's sub-wallet (never more than its daily cap). */
  balances: Record<string, number>;
  createdAt: string;
  stats: {
    spentTodayUsd: number;
    dayKey: string;
    openPositions: number;
    realizedPnlUsd: number;
    peakEquityUsd: number;
    equityUsd: number;
  };
  lastBacktest?: { at: string; summary: string; passed: boolean };
}

// ---------------------------------------------------------------------------
// Users and wallets
// ---------------------------------------------------------------------------

export interface WalletBalance {
  [symbol: string]: number;
}

export interface UserProfile {
  id: string;
  badge: string;
  jacket: Jacket;
  residence: string; // ISO country code, used for geofencing
  mainWallet: { solana: string; evm: string };
  balances: WalletBalance;
  /** Median order size in USD, used by the amount-sanity check. */
  medianOrderUsd: number;
  settings: {
    secondConfirmAbovePctOfWallet: number;
    frontierEscalationUsd: number;
  };
}
