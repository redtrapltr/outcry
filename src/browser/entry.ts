/**
 * In-browser build: the full Outcry stack (policy, signer, desk, launches,
 * agents, strategy engine, router, orchestrator) running locally in paper
 * mode with the offline intent engine. Used for the hosted demo link, where
 * there is no Node server. Exposes `window.OutcryLocal`.
 */
import { createOutcry } from "../app.js";
import { createHandlers, startLoops } from "../api/handlers.js";
import { ModelRouter } from "../llm/router.js";
import { OfflineProvider } from "../llm/offline.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import type { OutcryEvent } from "../core/infra.js";

// Started lazily, so pages talking to a real server never run a second engine.
let engine: { app: ReturnType<typeof createOutcry>; api: ReturnType<typeof createHandlers> } | undefined;
function ensure() {
  if (!engine) {
    const app = createOutcry({ mode: "paper" });
    const router = new ModelRouter({ providers: { offline: new OfflineProvider() } });
    const orch = new Orchestrator(app, router);
    const api = createHandlers(app, orch, router, () => Math.random().toString(36).slice(2) + Date.now().toString(36));
    startLoops(app, 4_000, 12_000);
    engine = { app, api };
  }
  return engine;
}

const local = {
  async request(method: string, path: string, token: string | undefined, body?: unknown) {
    return ensure().api.handle(method, path, token, body === undefined ? undefined : JSON.parse(JSON.stringify(body)));
  },
  subscribe(token: string, fn: (e: OutcryEvent) => void): () => void {
    const { app, api } = ensure();
    const uid = api.userFor(token);
    return app.bus.subscribe((e) => {
      if (e.userId === uid) fn(JSON.parse(JSON.stringify(e)));
    });
  },
};

(globalThis as unknown as { OutcryLocal: typeof local }).OutcryLocal = local;
