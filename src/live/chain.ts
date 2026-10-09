/**
 * Real-chain clients for the live pilot: Jupiter Swap V2 (order + execute) and
 * Solana RPC balances. Both take an injectable fetch for tests.
 */
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const defaultFetch: FetchLike = (u, i) => fetch(u, { ...i, signal: i?.signal ?? AbortSignal.timeout(15_000) }) as never;

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

export interface JupOrder {
  transaction: string | null;
  requestId: string;
  inAmount: string;
  outAmount: string;
  router?: string;
  feeBps?: number;
  lastValidBlockHeight?: string | number;
  errorCode?: number | string;
  errorMessage?: string;
  priceImpactPct?: string | number;
  priceImpact?: string | number;
  feeMint?: string;
  platformFee?: { amount?: string; feeBps?: number; feeMint?: string };
  referralAccount?: string;
}

export interface JupExecute {
  status: "Success" | "Failed";
  signature?: string;
  code: number;
  error?: string;
  totalInputAmount?: string;
  totalOutputAmount?: string;
}

export class JupiterSwap {
  constructor(readonly cfg: { apiKey: string; baseUrl?: string; referralAccount?: string; referralFeeBps?: number }, private f: FetchLike = defaultFetch) {}

  private get base() {
    return this.cfg.baseUrl ?? "https://api.jup.ag/swap/v2";
  }

  async order(p: { inputMint: string; outputMint: string; amount: bigint; taker: string; slippageBps?: number }): Promise<JupOrder> {
    const q = new URLSearchParams({ inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount.toString(), taker: p.taker });
    if (p.slippageBps !== undefined) q.set("slippageBps", String(p.slippageBps));
    if (this.cfg.referralAccount && this.cfg.referralFeeBps) {
      q.set("referralAccount", this.cfg.referralAccount);
      q.set("referralFee", String(this.cfg.referralFeeBps));
    }
    const r = await this.f(`${this.base}/order?${q}`, { headers: { "x-api-key": this.cfg.apiKey } });
    const j = (await r.json().catch(() => ({}))) as JupOrder & { error?: string };
    if (!r.ok) throw new Error(r.status >= 500 ? `Jupiter couldn't price this swap right now (${r.status}). Check the token address, or try again in a moment.` : `Jupiter rejected the order (${r.status}): ${j.error ?? j.errorMessage ?? "no details"}`);
    if (!j.transaction) {
      const why: Record<string, string> = { "1": "not enough balance of the token you're paying with", "2": "not enough SOL left for the network fee", "3": "the swap is below Jupiter's minimum size" };
      throw new Error(`Jupiter can't build this swap: ${why[String(j.errorCode)] ?? j.errorMessage ?? "no route found"}`);
    }
    return j;
  }

  /** Price only (no wallet, no transaction): used by the spread scanner. */
  async quoteOnly(p: { inputMint: string; outputMint: string; amount: bigint }): Promise<{ inAmount: string; outAmount: string; router?: string }> {
    const q = new URLSearchParams({ inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount.toString() });
    const r = await this.f(`${this.base}/order?${q}`, { headers: { "x-api-key": this.cfg.apiKey } });
    const j = (await r.json().catch(() => ({}))) as JupOrder & { error?: string };
    if (!r.ok || !j.outAmount || j.outAmount === "0") throw new Error(j.errorMessage ?? j.error ?? `no route (${r.status})`);
    return { inAmount: j.inAmount, outAmount: j.outAmount, router: j.router };
  }

  async execute(signedTransaction: string, requestId: string): Promise<JupExecute> {
    const r = await this.f(`${this.base}/execute`, {
      method: "POST",
      headers: { "x-api-key": this.cfg.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ signedTransaction, requestId }),
    });
    const j = (await r.json().catch(() => ({}))) as JupExecute;
    if (!r.ok && !j.status) throw new Error(`Jupiter execute failed (${r.status})`);
    return j;
  }
}

export interface TokenBalance {
  mint: string;
  amount: number;
  decimals: number;
  raw: string;
}

export class SolanaRpc {
  constructor(private url: string, private f: FetchLike = defaultFetch) {}

  /** JSON-RPC call; retries dropped connections, rate limits (429) and 5xx a couple of times. */
  private async call<T>(method: string, params: unknown[]): Promise<T> {
    let last: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((res) => setTimeout(res, 400 * 3 ** (attempt - 1)));
      let r;
      try {
        r = await this.f(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      } catch (e) {
        last = new Error(`Solana network unreachable (${(e as Error).message})`);
        continue;
      }
      if (r.status === 429 || r.status >= 500) {
        last = new Error(`Solana RPC busy (${r.status})`);
        continue;
      }
      const j = (await r.json()) as { result?: T; error?: { message: string } };
      if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
      return j.result as T;
    }
    throw last ?? new Error(`RPC ${method} failed`);
  }

  async solBalance(address: string): Promise<number> {
    const r = await this.call<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]);
    return r.value / 1e9;
  }

  async tokens(address: string): Promise<TokenBalance[]> {
    const out: TokenBalance[] = [];
    let lastErr: Error | undefined, okCount = 0;
    for (const programId of TOKEN_PROGRAMS) {
      let r;
      try {
        r = await this.call<{ value: { account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number; uiAmount: number | null } } } } } }[] }>(
        "getTokenAccountsByOwner",
        [address, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }],
      );
        okCount++;
      } catch (e) {
        lastErr = e as Error;
        continue; // one token program failing shouldn't hide the other's balances
      }
      for (const a of r.value) {
        const i = a.account.data.parsed.info;
        if (i.tokenAmount.amount === "0") continue;
        out.push({ mint: i.mint, amount: Number(i.tokenAmount.amount) / 10 ** i.tokenAmount.decimals, decimals: i.tokenAmount.decimals, raw: i.tokenAmount.amount });
      }
    }
    if (!okCount && lastErr) throw lastErr;
    return out;
  }

  /** Token accounts holding nothing: closing them returns their deposit (~0.002 SOL each). */
  async emptyTokenAccounts(owner: string): Promise<{ pubkey: string; program: string; lamports: number }[]> {
    const out: { pubkey: string; program: string; lamports: number }[] = [];
    for (const programId of TOKEN_PROGRAMS) {
      const r = await this.call<{ value: { pubkey: string; account: { lamports: number; data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>(
        "getTokenAccountsByOwner",
        [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }],
      ).catch(() => ({ value: [] }));
      for (const a of r.value) if (a.account.data.parsed.info.tokenAmount.amount === "0") out.push({ pubkey: a.pubkey, program: programId, lamports: a.account.lamports });
    }
    return out;
  }

  async latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const r = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
    return r.value;
  }

  /** The program that owns an account (e.g. which token program a mint belongs to), or null if it doesn't exist. */
  async accountOwner(address: string): Promise<string | null> {
    const r = await this.call<{ value: { owner: string } | null }>("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } }]);
    return r.value?.owner ?? null;
  }

  async send(base64Tx: string): Promise<string> {
    return this.call<string>("sendTransaction", [base64Tx, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]);
  }

  /** Wait until confirmed; returns an error message if the transaction failed or timed out. */
  async confirm(signature: string, timeoutMs = 45_000): Promise<string | undefined> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = await this.call<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>("getSignatureStatuses", [[signature], { searchTransactionHistory: false }]).catch(() => undefined);
      const st = r?.value?.[0];
      if (st?.err) return `Transaction failed on-chain: ${JSON.stringify(st.err).slice(0, 160)}`;
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return undefined;
      await new Promise((res) => setTimeout(res, 1_500));
    }
    return "Not confirmed within 45 seconds (it may still land: check Solscan)";
  }

  /**
   * What a confirmed transaction actually cost the wallet: network fee, SOL
   * locked as rent in newly created token accounts, the wallet's SOL change and
   * its change in one token. Retries briefly while the RPC catches up.
   */
  async txCosts(signature: string, owner: string, mints: string[], tries = 4): Promise<TxCosts | undefined> {
    for (let i = 0; i < tries; i++) {
      const tx = await this.call<RpcTx | null>("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]).catch(() => null);
      if (tx?.meta) {
        const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
        const me = keys.indexOf(owner);
        const pre = tx.meta.preBalances, post = tx.meta.postBalances;
        let rent = 0;
        keys.forEach((_, j) => { if (j !== me && pre[j] === 0 && (post[j] ?? 0) > 0) rent += post[j]!; });
        const tok = (list: RpcTokenBal[] | undefined, mint: string) => (list ?? []).filter((b) => b.owner === owner && b.mint === mint).reduce((x, b) => x + Number(b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount ?? 0), 0);
        return {
          ok: !tx.meta.err,
          feeSol: tx.meta.fee / 1e9,
          rentSol: rent / 1e9,
          solChange: me >= 0 ? ((post[me] ?? 0) - (pre[me] ?? 0)) / 1e9 : 0,
          tokenChanges: Object.fromEntries(mints.map((m) => [m, tok(tx.meta!.postTokenBalances, m) - tok(tx.meta!.preTokenBalances, m)])),
        };
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
    return undefined;
  }
}

export interface TxCosts {
  ok: boolean;
  feeSol: number;
  rentSol: number;
  /** Net SOL change of the wallet (negative = spent), fee and rent included. */
  solChange: number;
  /** Change of each requested mint held by the owner. */
  tokenChanges: Record<string, number>;
}

interface RpcTokenBal { owner?: string; mint: string; uiTokenAmount: { uiAmount: number | null; uiAmountString?: string } }
interface RpcTx {
  meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances?: RpcTokenBal[]; postTokenBalances?: RpcTokenBal[] } | null;
  transaction: { message: { accountKeys: (string | { pubkey: string })[] } };
}
