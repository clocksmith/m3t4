import type { StableStore } from "../stable.js";
import type { VerifyStore } from "../verify-store.js";
import { handleDuelAccept, handleDuelChallenge } from "./challenge.js";
import { handleDuelSignalGet, handleDuelSignalPost } from "./signal.js";
import { handleDuelSubmit } from "./submit-action-log.js";
import type { RouteList } from "../routes/types.js";

export interface DuelRouteDeps {
  store: StableStore;
  vstore: VerifyStore;
}

export function registerDuelRoutes(routes: RouteList, deps: DuelRouteDeps): void {
  const { store, vstore } = deps;

  routes.push(async (req, res, url) => {
    if (req.method === "POST" && url.pathname === "/api/duel/challenge") {
      await handleDuelChallenge(vstore, req, res);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/duel/accept") {
      await handleDuelAccept(vstore, req, res);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/duel/submit") {
      await handleDuelSubmit(store, req, res);
      return true;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/duel/signal/")) {
      const matchId = url.pathname.slice("/api/duel/signal/".length);
      await handleDuelSignalPost(vstore, matchId, req, res);
      return true;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/duel/signal/")) {
      const matchId = url.pathname.slice("/api/duel/signal/".length);
      await handleDuelSignalGet(vstore, matchId, req, res);
      return true;
    }

    return false;
  });
}

