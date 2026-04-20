import type { StableStore } from "../../stable.js";
import type { VerifyStore } from "../../verify-store.js";
import {
  handleAttestRegister,
  handleAttestSubmit,
  handleProofCommit,
  handleProofReveal,
  handleProofZkSubmit,
  handleProofZkSystems,
} from "../../proof.js";
import type { RouteList } from "../../routes/types.js";

export interface ProofLabRouteDeps {
  store: StableStore;
  vstore: VerifyStore;
  zkEnabled: boolean;
}

export function registerProofRoutes(routes: RouteList, deps: ProofLabRouteDeps): void {
  const { store, vstore } = deps;

  routes.push(async (req, res, url) => {
    if (req.method === "POST" && url.pathname === "/api/proof/commit") {
      await handleProofCommit(vstore, req, res);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/proof/reveal") {
      await handleProofReveal(store, vstore, req, res);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/proof/attest/register") {
      await handleAttestRegister(vstore, req, res);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/proof/attest/submit") {
      await handleAttestSubmit(store, vstore, req, res);
      return true;
    }

    if (deps.zkEnabled && req.method === "GET" && url.pathname === "/api/proof/zk/systems") {
      await handleProofZkSystems(req, res);
      return true;
    }

    if (deps.zkEnabled && req.method === "POST" && url.pathname === "/api/proof/zk/submit") {
      await handleProofZkSubmit(store, req, res);
      return true;
    }

    return false;
  });
}

