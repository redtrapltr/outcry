/**
 * Composition root: wires every module together. The API server, the demo
 * script and the tests all build the app through this one function.
 */
import { AuditLog, EventBus } from "./core/infra.js";
import { UserStore } from "./core/users.js";
import { SimulatedMarket } from "./data/market.js";
import { PaperAdapter } from "./adapters/paper.js";
import { ExecutionRouter, type ExecutionMode } from "./adapters/router.js";
import { SimulatedTurnkeySigner } from "./wallet/signer.js";
import { TicketDesk } from "./tickets/desk.js";
import { CreatorRegistry, LaunchService } from "./launch/service.js";
import { AgentRuntime } from "./agents/runtime.js";
import { StrategyLab } from "./strategy/lab.js";
import type { HistoryProvider } from "./data/history.js";
import { DEFAULT_POLICY, type PolicyConfig } from "./policy/engine.js";

export interface OutcryConfig {
  mode: ExecutionMode;
  platformFeeBps: number;
  launchFeeSol: number;
  paperDaysBeforeAuto: number;
  policy: PolicyConfig;
  marketSeed: number;
  /** Real historical candles for backtests; undefined = simulated only. */
  history?: HistoryProvider;
}

export const DEFAULT_CONFIG: OutcryConfig = {
  mode: "paper",
  platformFeeBps: 50,
  launchFeeSol: 0.02,
  paperDaysBeforeAuto: 7,
  policy: DEFAULT_POLICY,
  marketSeed: 42,
};

export function createOutcry(overrides: Partial<OutcryConfig> = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const audit = new AuditLog();
  const bus = new EventBus();
  const market = new SimulatedMarket(config.marketSeed);
  const signer = new SimulatedTurnkeySigner();
  const users = new UserStore(signer, market);
  const exec = new ExecutionRouter(market, new PaperAdapter(market), {}, config.mode);
  const registry = new CreatorRegistry();

  // The desk needs agents and agents need the desk: resolve lazily.
  let agents!: AgentRuntime;
  const desk = new TicketDesk({
    market, users, signer, exec, audit, bus,
    platformFeeBps: config.platformFeeBps,
    policy: config.policy,
    getAgent: (id) => agents.get(id),
  });
  agents = new AgentRuntime({ users, market, desk, signer, audit, bus, registry, paperDaysBeforeAuto: config.paperDaysBeforeAuto });
  const launches = new LaunchService({ users, signer, desk, market, registry, audit, bus, mode: config.mode, launchFeeSol: config.launchFeeSol, policy: config.policy });
  const lab = new StrategyLab(market, audit, config.history);

  return { config, audit, bus, market, signer, users, exec, registry, desk, agents, launches, lab };
}

export type Outcry = ReturnType<typeof createOutcry>;
