// Browser smoke test. Server mode: `npm start`, then run this.
// Static/local mode: serve web/ with any static server and set OUTCRY_URL.
import { chromium } from 'playwright';
const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
const base = (process.env.OUTCRY_URL ?? 'http://localhost:8787/').replace(/\/?$/, '/');
const shot = async (n) => process.env.SHOTS && p.screenshot({ path: `${process.env.SHOTS}/${n}.png` });

// Landing -> Enter the pit
await p.goto(base); await p.waitForTimeout(800);
await shot('landing');
await p.locator('a:has-text("Enter the pit")').first().click();
await p.waitForURL(/terminal\.html/); await p.waitForTimeout(1500);
const pill = await p.locator('#modePill').innerText();

// Launch with disclosed multi-wallet dev buy
await p.fill('#cmd', 'launch $work on pump.fun buy with 10 different wallets 0.5 sol'); await p.press('#cmd', 'Enter');
await p.waitForSelector('.ticket .acc'); await p.check('.acc'); await p.click('text=Sign & launch');
await p.waitForSelector('text=is live (paper)', { timeout: 15000 });

// Agent in ask mode, approve one proposal
await p.fill('#cmd', 'build me an agent that snipes new pump.fun memes, $20 per trade'); await p.press('#cmd', 'Enter');
await p.waitForSelector('text=Ready · adjust below', { timeout: 10000 });
await p.locator('[data-mode="ask"]').last().click();
await p.waitForSelector('text=Your agent proposes a trade', { timeout: 30000 });
await p.locator('text=Sign & fill').last().click();
await p.waitForTimeout(1500);

// Strategy + order
await p.fill('#cmd', 'Backtest: buy SOL on 4h when RSI crosses above 30 and price above the 200 EMA, exit on MACD cross down or -8%'); await p.press('#cmd', 'Enter');
await p.waitForSelector('.metrics', { timeout: 20000 });
await p.fill('#cmd', 'Put 150 USDC into tokenized NVIDIA'); await p.press('#cmd', 'Enter');
await p.waitForSelector('text=Ticket ready'); await p.locator('button:has-text("Sign & fill")').last().click();
await p.waitForTimeout(800);
await shot('terminal');
const fills = await p.locator('.stamp').count();
console.log(JSON.stringify({ base, pill, stamps: fills, errors: errs }));
await b.close();
if (errs.length) process.exit(1);
