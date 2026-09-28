/**
 * Scripted end-to-end demo in the terminal (no browser, no API key):
 *   npm run demo
 * Walks through a launch, an order, a strategy backtest and an agent that
 * paper-trades new launches, then verifies the audit log.
 */
import { createOutcry } from "../src/app.js";
import { ModelRouter } from "../src/llm/router.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";

const app = createOutcry();
const orch = new Orchestrator(app, ModelRouter.fromEnv());
const me = app.users.create({ badge: "LOUD", jacket: "memes", residence: "CH" });
const say = async (text: string) => {
  console.log(`\n> ${text}`);
  const r = await orch.handle(me.id, "demo", text);
  console.log(r.reply);
  console.log(`  [${r.meta.tier} · ${r.meta.model} · $${r.meta.costUsd.toFixed(4)}]`);
  return r;
};
const pk = "demo-passkey";

const launch = await say("launch token $work on pump.fun buy direct supply with 10 different wallets 0.5 sol");
const lt = launch.cards.find((c) => c.type === "launch");
if (lt?.type === "launch") {
  const done = await app.launches.approve(lt.ticket.id, { userApproval: pk, disclosureAccepted: true });
  console.log(`  -> ${done.status}: mint ${done.mint}, ${done.launchWallets.length} wallets in the public registry`);
}

const order = await say("put 150 usdc into tokenized nvidia");
const ot = order.cards.find((c) => c.type === "order");
if (ot?.type === "order") console.log(`  -> ${(await app.desk.approve(ot.ticket.id, { userApproval: pk })).status}`);

await say("backtest: buy SOL on 4h when RSI crosses above 30 and price above the 200 EMA, exit on MACD cross down or -8%");

const ag = await say("build me an agent that snipes new pump.fun memes with 200+ holders, $20 per trade");
const ac = ag.cards.find((c) => c.type === "agent");
if (ac?.type === "agent") {
  app.agents.deploy(me.id, ac.agent.id, { mode: "paper" });
  for (const s of ["BID", "OFFR", "CALL"]) app.market.spawnMeme(s, s === "CALL" ? { holders: 120, holdersCollapsed: 120 } : {});
  app.bus.subscribe((e) => e.type === "agent.activity" && console.log(`  [agent] ${e.message}`));
  await app.agents.tick();
}
await say("why did the sniper agent buy?");
await say("launch $sneak and hide the dev wallets");

const p = app.users.portfolio(me.id);
console.log(`\nWallet $${p.walletUsd.toFixed(2)} · audit log intact: ${app.audit.verify()} · AI spend $${orch.router.spendOf(me.id).usd.toFixed(4)}`);
