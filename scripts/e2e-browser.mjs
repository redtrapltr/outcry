// Browser smoke test: run `npm start` first, then `node scripts/e2e-browser.mjs`.
import { chromium } from 'playwright';
const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
const base = process.env.OUTCRY_URL ?? 'http://localhost:8787/';
await p.goto(base); await p.waitForTimeout(1200);
await p.fill('#cmd', 'build me an agent that snipes new pump.fun memes, $20 per trade'); await p.press('#cmd', 'Enter');
await p.waitForSelector('text=Ready · adjust below', { timeout: 10000 });
await p.locator('[data-mode="ask"]').last().click();
await p.waitForSelector('text=Your agent proposes a trade', { timeout: 20000 });
await p.locator('text=Sign & fill').last().click();
await p.waitForTimeout(6500);
await p.fill('#cmd', 'why did the sniper agent buy?'); await p.press('#cmd', 'Enter'); await p.waitForTimeout(1500);
if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/desktop.png` });
await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(300);
if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/mobile.png` });
console.log(errs.length ? 'page errors: ' + errs.join('; ') : 'ok: no page errors');
await b.close();
