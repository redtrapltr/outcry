/**
 * Offline provider: a deterministic stand-in for the LLM.
 *
 * It reads the user's message, emits the same tool calls a model would, and
 * writes a short reply from the tool results. It lets the whole product run
 * with no API key (demos, CI, local dev), and it doubles as the T0 intent
 * classifier, which costs nothing per turn.
 */
import type { ChatRequest, ChatResponse, ContentBlock, ModelProvider } from "./types.js";

export type Intent = "launch" | "agent" | "strategy" | "order" | "control" | "explain" | "portfolio" | "research" | "smalltalk" | "refuse";

export function classify(text: string): Intent {
  const s = text.toLowerCase();
  if (/\b(hide|hidden|secret|stealth|undisclosed|wash[- ]?trad|fake volume|rug)\b/.test(s) && /\b(launch|wallet|buy|volume|token|dev)\b/.test(s)) return "refuse";
  const building = /\b(build|make|design|create|draft)\b/.test(s) || /\b(pause|stop)\s+(it\s+)?(at|after|when|if)\b/.test(s) || /drawdown|stop[- ]loss/.test(s);
  if (!building && /\b(pause|resume|kill|stop)\b/.test(s) && /\b(agent|bot|sniper|harvest|steady|floor one|it)\b/.test(s)) return "control";
  if (/\bwhy did\b|\bexplain\b.*\b(agent|buy|sell)\b/.test(s)) return "explain";
  if (/\b(launch|deploy|create|mint)\b.*\b(token|coin|\$[a-z0-9]+|on pump)/.test(s)) return "launch";
  if (/\b(agent|bot|autopilot|trade for me|manage my|snipe|sniper)\b/.test(s)) return "agent";
  if (/\b(strategy|backtest|rsi|macd|ema|sma|bollinger|indicator|crosses|pine)\b/.test(s)) return "strategy";
  if (/\b(buy|sell|swap|long|dump|ape|put)\b/.test(s)) return "order";
  // "4 SOL", "exactly 4.0 sol please", "$200 of NVDA": a quantity next to an asset is an order.
  if (/\d+(?:[.,]\d+)?\s*\$?(sol|eth|btc|nvda|spy|tsla|aapl|usdc)\b|\$\s*\d+.*\b(of|in|into)\b/.test(s)) return "order";
  if (/\b(portfolio|balance|positions|holdings|how much do i have|wallet)\b/.test(s)) return "portfolio";
  if (/\b(what|how|why|is|can|should|risk|news|price|chart)\b/.test(s)) return "research";
  return "smalltalk";
}

const num = (s: string | undefined, d: number) => (s ? Number(s.replace(",", ".")) : d);

export function parseLaunch(t: string) {
  const ticker = (t.match(/\$([a-z0-9]{2,10})/i)?.[1] ?? t.match(/(?:token|coin)\s+(?:called\s+|named\s+)?([a-z0-9]{2,10})/i)?.[1] ?? "WORK").toUpperCase();
  const wallets = Math.min(16, Math.max(1, num(t.match(/(\d{1,2})\s*(?:different\s+|separate\s+)?wallets?/i)?.[1], 1)));
  const sol = Math.max(0.01, num(t.match(/(\d+(?:[.,]\d+)?)\s*sol\b(?!\s*total)/i)?.[1], 0.5));
  const totalMatch = t.match(/(\d+(?:[.,]\d+)?)\s*sol\s*total/i)?.[1];
  const solPerWallet = totalMatch ? num(totalMatch, 1) / wallets : sol;
  return {
    name: ticker.charAt(0) + ticker.slice(1).toLowerCase(),
    ticker,
    description: "",
    wallets,
    sol_per_wallet: Number(solPerWallet.toFixed(4)),
  };
}

const ASSET_RE = /\b(sol|solana|eth|ether|ethereum|btc|bitcoin|nvda|nvidia|spy|tsla|tesla|aapl|apple|usdc)\b/i;

export function parseOrder(t: string) {
  const side = /\b(sell|dump)\b/i.test(t) ? "sell" : "buy";
  type Leg = { side: string; asset: string; quote_asset: string; amount?: number; receive_exact?: number; max_slippage_bps: number };
  const legs: Leg[] = [];
  // "swap 2 ETH for SOL"
  const swap = t.match(/swap\s+(\d+(?:[.,]\d+)?)\s*([a-z$0-9]+)\s+(?:for|to|into)\s+([a-z$0-9]+)/i);
  if (swap) {
    legs.push({ side: "sell", asset: swap[2]!, quote_asset: swap[3]!, amount: num(swap[1], 1), max_slippage_bps: 50 });
    return { legs };
  }
  // Spend form: "500 USDC into NVDA", "$200 of SOL", "150 usdc of tokenized nvidia"
  const spendRe = /(?:\$\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*(?:usdc|usd|dollars?|\$))\s*(?:worth\s+)?(?:of|into|in|on)?\s*(?:tokenized\s+)?\$?([a-z]{2,10})\b/gi;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = spendRe.exec(t))) {
    const asset = m[3]!;
    if (/^(usdc|usd|and|the|of|worth)$/i.test(asset) || seen.has(asset.toLowerCase())) continue;
    seen.add(asset.toLowerCase());
    legs.push({ side, asset, quote_asset: "USDC", amount: num(m[1] ?? m[2], 100), max_slippage_bps: 50 });
  }
  if (legs.length) return { legs };
  // Quantity form: "buy 4 SOL", "exactly 4.0 sol", "sell 2 eth"
  const qty = t.match(/(\d+(?:[.,]\d+)?)\s*\$?([a-z]{2,10})\b/i);
  if (qty && !/^(usdc|usd|dollars?|wallets?|x|percent)$/i.test(qty[2]!)) {
    const n = num(qty[1], 1);
    legs.push(side === "buy"
      ? { side, asset: qty[2]!, quote_asset: "USDC", receive_exact: n, max_slippage_bps: 50 }
      : { side, asset: qty[2]!, quote_asset: "USDC", amount: n, max_slippage_bps: 50 });
    return { legs };
  }
  const asset = t.match(ASSET_RE)?.[1] ?? t.match(/\$([a-z0-9]{2,10})/i)?.[1] ?? "SOL";
  legs.push({ side, asset, quote_asset: "USDC", amount: num(t.match(/(\d+(?:[.,]\d+)?)/)?.[1], 100), max_slippage_bps: 50 });
  return { legs };
}

export function parseStrategy(t: string) {
  const s = t.toLowerCase();
  const asset = (t.match(ASSET_RE)?.[1] ?? "SOL").toUpperCase().replace("SOLANA", "SOL").replace("ETHEREUM", "ETH").replace("BITCOIN", "BTC").replace("NVIDIA", "NVDA");
  const tf = (s.match(/\b(1m|5m|15m|1h|4h|1d)\b/)?.[1] ?? (/daily|day/.test(s) ? "1d" : /hour/.test(s) ? "1h" : "4h")) as string;
  const entry: unknown[] = [];
  const rsiLevel = s.match(/rsi[^0-9]{0,30}(\d{1,2})/)?.[1];
  if (/rsi/.test(s)) entry.push({ crosses_above: [{ rsi: 14 }, num(rsiLevel, 30)] });
  const emaN = s.match(/(\d{2,3})[- ]?(?:ema|day ema|period ema)|ema\s*\(?(\d{2,3})/);
  if (emaN) entry.push({ gt: ["close", { ema: Number(emaN[1] ?? emaN[2]) }] });
  const smaN = s.match(/(\d{2,3})[- ]?(?:sma|day sma|ma\b)|sma\s*\(?(\d{2,3})/);
  if (smaN) entry.push({ gt: ["close", { sma: Number(smaN[1] ?? smaN[2]) }] });
  if (/bollinger|lower band/.test(s)) entry.push({ lt: ["close", { bb_lower: [20, 2] }] });
  if (/macd/.test(s) && !/exit.*macd|macd.*exit|sell.*macd/.test(s)) entry.push({ crosses_above: [{ macd: [12, 26, 9] }, { macd_signal: [12, 26, 9] }] });
  if (!entry.length) entry.push({ crosses_above: [{ ema: 20 }, { ema: 50 }] });

  const exit: unknown[] = [];
  if (/macd/.test(s)) exit.push({ crosses_below: [{ macd: [12, 26, 9] }, { macd_signal: [12, 26, 9] }] });
  else if (/rsi/.test(s)) exit.push({ crosses_above: [{ rsi: 14 }, 70] });
  else exit.push({ crosses_below: [{ ema: 20 }, { ema: 50 }] });
  const stop = s.match(/(?:stop|sl)[^0-9]{0,15}(\d{1,2}(?:\.\d)?)\s*%|[−-](\d{1,2})\s*%/);
  exit.push({ stop_loss_pct: num(stop?.[1] ?? stop?.[2], 8) });
  const tp = s.match(/(?:take profit|tp|target)[^0-9]{0,15}(\d{1,3})\s*%/);
  if (tp) exit.push({ take_profit_pct: num(tp[1], 20) });
  return {
    program: {
      name: `${asset} ${/rsi/.test(s) ? "RSI" : /macd/.test(s) ? "MACD" : "trend"} ${tf}`,
      timeframe: tf,
      asset,
      entry: entry.length === 1 ? entry[0] : { all: entry },
      exit: { any: exit },
      size: { risk_pct_of_equity: num(s.match(/risk\s*(\d(?:\.\d)?)\s*%/)?.[1], 1) },
    },
  };
}

export function parseAgent(t: string) {
  const s = t.toLowerCase();
  const careful = /careful|safe|slow|steady|conservative/.test(s);
  const snipe = /snipe|sniper|new token|new meme|pump|launch/.test(s) && !/my token|manage/.test(s);
  const sizeUsd = num(s.match(/\$?(\d+(?:\.\d+)?)\s*(?:usd|\$|usdc)?\s*(?:per|each|a)\s*trade/)?.[1], careful ? 10 : 20);
  const holders = num(s.match(/(\d{2,5})\+?\s*holders/)?.[1], 200);
  const name = snipe ? "SNIPER" : careful ? "STEADY" : /manage|profit/.test(s) ? "HARVEST" : "FLOOR ONE";
  const goal = t.replace(/^(please\s+)?(build|make|design|create)\s+(me\s+)?(an?\s+)?/i, "").slice(0, 200);
  const base = {
    name,
    goal,
    sizeUsd,
    exit: { stopLossPct: careful ? 12 : 30, takeProfitPct: careful ? 25 : 120 },
    limits: { maxPerTradeUsd: sizeUsd, maxPerDayUsd: sizeUsd * (careful ? 3 : 5), maxOpenPositions: careful ? 3 : 5, maxDrawdownPct: careful ? 15 : 40 },
  };
  if (snipe) {
    const universe: Record<string, unknown> = { minHolders: holders, maxTopWalletPct: careful ? 10 : 20, requireMintRevoked: true };
    const age = s.match(/(?:no older than|younger than|under|less than|max(?:imum)?)\s*(\d+)?\s*(second|sec|s\b|minute|min|hour|h\b)/);
    if (age && /old|young|age|launch|live/.test(s)) {
      const n = num(age[1], 1);
      universe.maxAgeSeconds = Math.round(n * (/^h/.test(age[2]!) ? 3600 : /^m/.test(age[2]!) ? 60 : 1));
    }
    const top10 = s.match(/top\s*10[^%]*?(\d+(?:\.\d+)?)\s*%/);
    if (top10) universe.maxTop10Pct = Number(top10[1]);
    const pos = s.match(/(\d{1,2})\s*(?:open\s+)?(?:positions|tokens at once|holdings)/);
    if (pos) base.limits.maxOpenPositions = Math.min(50, Math.max(1, Number(pos[1])));
    const dd = s.match(/(?:pause|stop)[^%]*?-?\s*(\d+(?:\.\d+)?)\s*%\s*drawdown|drawdown[^%\d]*-?\s*(\d+(?:\.\d+)?)\s*%/);
    if (dd) base.limits.maxDrawdownPct = Number(dd[1] ?? dd[2]);
    return { ...base, markets: ["memes"], kind: "sniper", universe };
  }
  const strat = parseStrategy(t).program;
  return { ...base, markets: [/nvda|spy|stock/.test(s) ? "stocks" : "swaps"], kind: "rules", program: { ...strat, name: `${name} rules` } };
}

export function parseControl(t: string) {
  const s = t.toLowerCase();
  const action = /kill|stop/.test(s) ? "kill" : /resume/.test(s) ? "resume" : "pause";
  const agent = s.replace(/.*\b(pause|resume|kill|stop)\b\s*(the\s+|my\s+)?/, "").replace(/\b(agent|bot)\b/, "").trim() || "last";
  return { agent, action };
}

/**
 * The offline "model". Turn 1: emit tool calls for the classified intent.
 * Turn 2 (after tool results): write the reply.
 */
export class OfflineProvider implements ModelProvider {
  readonly name = "offline";
  private n = 0;

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const last = req.messages.at(-1)!;
    const usage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    const id = () => `toolu_off_${++this.n}`;

    if (typeof last.content !== "string" && last.content.some((b) => b.type === "tool_result")) {
      return { content: [{ type: "text", text: replyFromResults(last.content) }], stopReason: "end_turn", usage, model: "offline" };
    }
    const raw = typeof last.content === "string" ? last.content : last.content.map((b) => (b.type === "text" ? b.text : "")).join(" ");
    const text = raw.replace(/<context>[\s\S]*?<\/context>/g, "").trim();
    const intent = classify(text);
    const call = (name: string, input: unknown): ChatResponse => ({ content: [{ type: "tool_use", id: id(), name, input }], stopReason: "tool_use", usage, model: "offline" });
    switch (intent) {
      case "refuse":
        return {
          content: [{ type: "text", text: "I can't hide a dev buy or fake activity: buyers need to see the real distribution. I can set up the same launch with disclosed creator wallets. Want that?" }],
          stopReason: "end_turn", usage, model: "offline",
        };
      case "launch": return call("propose_launch", parseLaunch(text));
      case "agent": return call("propose_agent", parseAgent(text));
      case "strategy": return call("compile_strategy", parseStrategy(text));
      case "order": return call("propose_order", parseOrder(text));
      case "control": return call("control_agent", parseControl(text));
      case "explain": return call("explain_agent", { agent: parseControl(text).agent });
      case "portfolio": return call("get_portfolio", {});
      case "research": {
        const tok = text.match(/\$([a-z0-9]{2,10})/i)?.[1];
        if (tok) return call("get_token_risk", { token: tok });
        const asset = text.match(ASSET_RE)?.[1];
        if (asset) return call("get_market_data", { asset, timeframe: "4h", indicators: ["rsi:14", "ema:50", "ema:200"] });
        return call("list_new_tokens", { limit: 5 });
      }
      default:
        return {
          content: [{ type: "text", text: "I can place orders, launch tokens with a disclosed multi-wallet dev buy, build agents that trade for you, and backtest indicator strategies. What do you want to do?" }],
          stopReason: "end_turn", usage, model: "offline",
        };
    }
  }
}

function replyFromResults(blocks: ContentBlock[]): string {
  const results = blocks.filter((b) => b.type === "tool_result") as Extract<ContentBlock, { type: "tool_result" }>[];
  const parts: string[] = [];
  for (const r of results) {
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(r.content.replace(/<\/?untrusted_data>/g, ""));
    } catch {
      parts.push(r.content.slice(0, 300));
      continue;
    }
    if (r.is_error) {
      parts.push(`That didn't work: ${j.error ?? r.content}`);
      continue;
    }
    parts.push(String(j.summary ?? j.message ?? "Done."));
  }
  return parts.join("\n\n");
}
