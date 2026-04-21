import type { StableStore } from "../stable.js";
import { handleSpectateTuple, handleVerifyReplay } from "../verify.js";
import { json } from "../http-utils.js";
import type { RouteList } from "./types.js";

export interface ReplayRouteDeps {
  store: StableStore;
}

export function registerReplayVerifyRoutes(routes: RouteList, deps: ReplayRouteDeps): void {
  routes.push(async (req, res, url) => {
    if (req.method === "POST" && url.pathname === "/api/verify/replay") {
      await handleVerifyReplay(req, res);
      return true;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/spectate/tuple/")) {
      const matchId = url.pathname.slice("/api/spectate/tuple/".length);
      if (!matchId) json(res, 400, { error: "matchId required" });
      else await handleSpectateTuple(deps.store, matchId, req, res);
      return true;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/replays/public-artifact/")) {
      const matchId = url.pathname.slice("/api/replays/public-artifact/".length);
      if (!matchId) {
        json(res, 400, { error: "matchId required" });
        return true;
      }
      const artifact = await deps.store.getPublicReplayArtifact(matchId);
      if (!artifact) json(res, 404, { error: "public replay artifact not found" });
      else json(res, 200, artifact);
      return true;
    }

    return false;
  });
}
