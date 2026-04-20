import type { StableStore } from "../stable.js";
import { stablePublic } from "../stable.js";
import { handleClaimHandle, handleSubmit } from "../submit.js";
import { json } from "../http-utils.js";
import type { RouteList } from "./types.js";

export interface RankedRouteDeps {
  store: StableStore;
  features: Record<string, boolean>;
  config: {
    activePoolMs: number;
    authProviders: readonly string[];
    cycleMs: number;
    maxSlots: number;
  };
}

export function registerRankedRoutes(routes: RouteList, deps: RankedRouteDeps): void {
  const { store, features, config } = deps;

  routes.push(async (req, res, url) => {
    if (req.method === "GET" && url.pathname === "/api/status") {
      json(res, 200, {
        ok: true,
        cycleMs: config.cycleMs,
        maxSlots: config.maxSlots,
        authProviders: config.authProviders,
        features,
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/features") {
      json(res, 200, { features });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/leaderboard") {
      const active = await store.listActive(config.activePoolMs);
      const rows = active
        .map((st) => stablePublic(st))
        .sort((a, b) => b.eloAggregate - a.eloAggregate);
      json(res, 200, rows.slice(0, 50));
      return true;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/stables/")) {
      const uid = url.pathname.slice("/api/stables/".length);
      const st = await store.getStable(uid);
      if (!st) json(res, 404, { error: "not found" });
      else json(res, 200, stablePublic(st));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/ranked/submit") {
      await handleSubmit(req, res, store);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/handle") {
      await handleClaimHandle(req, res, store);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/internal/elo-decay") {
      const count = await store.applyDecay();
      json(res, 200, { ok: true, decayed: count });
      return true;
    }

    return false;
  });
}

