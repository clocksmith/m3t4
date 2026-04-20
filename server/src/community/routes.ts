import type { StableStore } from "../stable.js";
import type { VerifyStore } from "../verify-store.js";
import {
  handleCommunityAttest,
  handleCommunityRegister,
  handleCommunityStatus,
} from "../verify.js";
import type { RouteList } from "../routes/types.js";

export interface CommunityRouteDeps {
  store: StableStore;
  vstore: VerifyStore;
}

export function registerCommunityVerifyRoutes(routes: RouteList, deps: CommunityRouteDeps): void {
  const { store, vstore } = deps;

  routes.push(async (req, res, url) => {
    if (req.method === "POST" && url.pathname === "/api/community/workers/register") {
      await handleCommunityRegister(vstore, req, res);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/community/attest") {
      await handleCommunityAttest(store, vstore, req, res);
      return true;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/community/status/")) {
      const matchId = url.pathname.slice("/api/community/status/".length);
      await handleCommunityStatus(store, vstore, matchId, req, res);
      return true;
    }

    return false;
  });
}

