# Outcry — AI trading terminal (v0, paper mode)

A product of **Woodeng**. Users fund a wallet and trade crypto, pump.fun tokens and tokenized US stocks by chatting. They can also launch tokens with a disclosed multi-wallet dev buy, design agents that trade for them, and backtest indicator strategies.

This repository is the first working build of the architecture doc (*Outcry — Technical Architecture*). Everything runs end to end in **paper mode**: real policy, signing rules, routing, agents and backtests, against a simulated market and a simulated signer. No real funds move.

## Run it

```bash
npm install
npm test            # 39 tests: policy, signer, tickets, launches, agents, strategy engine, orchestrator, API
npm run demo        # scripted session in the terminal (launch, order, backtest, agent, refusal)
npm start           # API + terminal UI on http://localhost:8787
```

The UI needs no API key: without one, an offline intent engine stands in for the models. To use real models, copy `.env.example` to `.env` and set the keys.

## Deploy on Render (public link with real AI)

1. Render dashboard → **New → Blueprint** → select `redtrapltr/outcry`. Render reads `render.yaml`.
2. When asked, paste your **`ANTHROPIC_API_KEY`**. That one key is enough: Opus 5.5 handles agents and strategies, and Haiku 4.5 handles orders and launches. `OPENROUTER_API_KEY` is optional.
3. Deploy. The site is served at `https://outcry-xxxx.onrender.com`: the landing page at `/`, the terminal at `/terminal.html`.

Safety rails for a public link:
- **AI spend caps.** `OUTCRY_MAX_AI_USD_PER_USER` ($0.50/day) and `OUTCRY_MAX_AI_USD_PER_DAY` ($10/day). Over a cap, the chat keeps working on the offline engine.
- **Session limit.** At most 30 new sessions per IP per hour.
- **Model errors.** If the model API fails (bad key, outage, rate limit), the chat falls back to the next model, then to the offline engine.
- **Saved state.** Users, sessions, passkeys, wallets, agents, tickets, strategies, chat history and the hash-chained audit log are saved to Postgres (`DATABASE_URL`, created by the blueprint) every few seconds and on shutdown, and restored on boot. Without a database, `OUTCRY_STATE_FILE=./data/state.json` saves to a file; with neither, state lives in memory only.
- **Free plan limits.** Free web instances sleep after 15 minutes idle, which pauses agents; the Starter plan keeps them running. Free Postgres is deleted after 30 days; the Basic plan keeps it.

## Accounts

Everyone starts as a guest; the session is remembered in that browser. **Secure with a passkey** (Face ID, Touch ID, Windows Hello, a security key) turns the guest into an account that can **sign in with a passkey** on any device. On a secured account every ticket and launch must be confirmed with the passkey; the server checks a WebAuthn assertion bound to that ticket (`src/api/auth.ts`). Live mode refuses to sign for accounts without a passkey.

## Static demo (no server)

`web/` also runs on its own: `terminal.html` loads `outcry-local.js` (built with `npm run build:web`), which is the whole engine in the browser with the offline intent engine. Any static host works (Netlify, GitHub Pages).

## What's built

| Layer (doc section) | Where | Status |
| --- | --- | --- |
| Core types, zod schemas for every trust boundary | `src/core/types.ts` | Done |
| Hash-chained audit log, event bus | `src/core/infra.ts` | Done; swap to a Postgres table |
| Policy engine: slippage, impact, geofence, amount sanity, agent limits, launch rules | `src/policy/engine.ts` | Done |
| Signer with in-enclave-style policies (main, agent, launch wallets) | `src/wallet/signer.ts` | Simulated Turnkey; same rules |
| Ticket desk: quote → simulate → policy → approve → sign → fill | `src/tickets/desk.ts` | Done |
| Execution adapters | `src/adapters/` | Paper adapter with real venue fee schedules; Jupiter live adapter drafted |
| Token launches with disclosed dev bundle, Jito bundle plan, creator registry | `src/launch/` | Done (paper); live submit disabled |
| Agent runtime: lifecycle, sniper and rules agents, triple limits, ask/auto/paper, kill switch, explanations | `src/agents/runtime.ts` | Done |
| Strategy DSL, indicators, backtester (walk-forward, Monte Carlo, overfitting flags) | `src/strategy/` | Done |
| Model router (T0/T1/T2), providers, cost tracking, escalation | `src/llm/` | Done; Anthropic + OpenAI-compatible (OpenRouter, LiteLLM, Gemini, DeepSeek) |
| Orchestrator + typed tools + untrusted-data wrapping | `src/orchestrator/` | Done |
| API (REST + WebSocket events) | `src/api/server.ts` | Done; demo auth |
| Terminal UI (Outcry Floor, night theme) | `web/index.html` | Done: tickets, launch flow, agent builder animation with live tuning, strategy results, activity feed |
| Market data | `src/data/market.ts` | Simulated, deterministic feed behind the `MarketData` interface |

## How a turn works

1. `POST /api/chat` → the orchestrator classifies the message for free (T0) and routes it: clear orders and launches go to T1; agents, strategies and research go to T2.
2. The model calls typed tools. Read tools run freely. Write tools (`propose_order`, `propose_launch`, `propose_agent`, `compile_strategy`) return a **card**, never a transaction.
3. The client renders the card. Signing is a separate call, `POST /api/tickets/:id/approve`, carrying a passkey assertion.
4. The desk re-checks policy, the signer applies the wallet's own policy, the adapter fills, and events stream over `/api/events`.

Agents enter at the same desk with their own sub-wallet, so they get no shortcut.

## Product rules enforced in code

- **Launch wallets are always disclosed.** A line is added to the token description, every wallet goes into the public registry (`GET /api/registry/:mint`), and the pump.fun plan builder refuses metadata without the disclosure. Outcry's own sniper agents count those wallets as one holder and never snipe their owner's launch.
- **The model never holds keys.** It can't sign, change limits or add wallets.
- **Agents go live only after a backtest.** Auto mode needs 7 days of paper trading or an explicit risk acknowledgement, and live mode needs a passkey.
- **Backtests are labelled as past, simulated results,** with overfitting warnings shown every time.

## Configuration

See `.env.example`. Model IDs and prices come from the architecture doc (Sept 2026 sources) and are overridable per tier with `OUTCRY_T0_MODEL`, `OUTCRY_T1_MODEL` and `OUTCRY_T2_MODEL`.

## Before going live (not done in v0)

1. ~~**Passkeys**~~ done (`src/api/auth.ts`). Still to do: passkey on agent deploys in ask/auto mode, account recovery, session expiry.
2. **Turnkey:** implement `Signer` with Turnkey sub-orgs and policies. The rules in `SimulatedTurnkeySigner` are the spec. Negotiate enterprise signature pricing first; see unit economics.
3. **Market data:** implement `MarketData` with Pyth or Chainlink prices, a Helius or Yellowstone token stream, Birdeye or Codex holders, and Ondo OHLC.
4. **Jupiter:** confirm Swap V2 endpoint paths, then finish `simulate` and `submit` in `src/adapters/live/jupiter.ts` (Jito bundle, retry once).
5. **pump.fun:** turn the `LaunchPlan` steps into real instructions with `@solana/web3.js`. Verify the program id, account layouts and bonding-curve constants in `policy/engine.ts`.
6. **Ondo / xStocks:** get API access and written confirmation on Swiss eligibility.
7. **Persistence:** snapshot persistence to Postgres is done (`src/core/persist.ts`, `src/api/persistence.ts`). At scale, move to per-table storage, ClickHouse for market data and Temporal for the agent scheduler.
8. **Legal:** get the AMLA/SRO position, check the FinSA advertising rules for tokenized stocks, and decide EU scope under MiCA.
9. **External security audit** of the policy engine, signer integration and agent runtime.

## Browser smoke test

```bash
npm start &
npx playwright install chromium   # once
node scripts/e2e-browser.mjs
```
