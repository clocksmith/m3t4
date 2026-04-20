// m3t4 Arena server — Phase 1.
//
// - Auth-gated submit API (dev mode accepts any bearer token as UID)
// - 3-5 slot stables with 24h per-slot rate limits
// - Close-ELO firehose matchmaker, continuous
// - Server-authoritative sim, WebSocket frame streaming
// - File-backed StableStore for local dev (swap for Firestore in prod)

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { CONFIG } from "./config.js";
import { FileStableStore } from "./stable.js";
import { FirestoreStableStore } from "./firestore-store.js";
import { Firehose } from "./firehose.js";
import { defaultVerifyStorePath, VerifyStore } from "./verify-store.js";
import { corsHeaders, json } from "./http-utils.js";
import type { RouteList } from "./routes/types.js";
import { registerRankedRoutes } from "./routes/ranked.js";
import { registerReplayVerifyRoutes } from "./routes/replay.js";
import { registerDuelRoutes } from "./p2p/routes.js";
import { registerCommunityVerifyRoutes } from "./community/routes.js";
import { registerProofRoutes } from "./labs/proof/routes.js";
import { initZkVerifiers } from "./labs/proof/zk.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORE_PATH = process.env.STORE_PATH ?? path.join(__dirname, "..", "data", "m3t4.json");

const store = CONFIG.storeBackend === "firestore"
  ? new FirestoreStableStore()
  : new FileStableStore(STORE_PATH);
const firehose = new Firehose(store);

if (CONFIG.features.proofLab && CONFIG.features.zk) {
  // No-op if no vkey.json is present; the proof route reports that clearly.
  initZkVerifiers();
}

const routes: RouteList = [];
registerRankedRoutes(routes, { store, features: CONFIG.features, config: CONFIG });
registerReplayVerifyRoutes(routes, { store });

if (CONFIG.features.p2pDuel) {
  const duelStore = new VerifyStore(defaultVerifyStorePath("duel"));
  registerDuelRoutes(routes, { store, vstore: duelStore });
}

if (CONFIG.features.communityVerify) {
  const communityStore = new VerifyStore(defaultVerifyStorePath("community"));
  registerCommunityVerifyRoutes(routes, { store, vstore: communityStore });
}

if (CONFIG.features.proofLab) {
  const proofStore = new VerifyStore(defaultVerifyStorePath("proof"));
  registerProofRoutes(routes, { store, vstore: proofStore, zkEnabled: CONFIG.features.zk });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...corsHeaders(),
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-m3t4-match-token",
    });
    res.end(); return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  for (const route of routes) {
    if (await route(req, res, url)) return;
  }

  json(res, 404, { error: "not found" });
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  const client = firehose.addClient(ws);
  ws.on("close", () => firehose.removeClient(client));
  ws.on("error", () => firehose.removeClient(client));
});

server.listen(CONFIG.port, () => {
  const storeLabel = CONFIG.storeBackend === "firestore" ? "firestore" : STORE_PATH;
  console.log(`m3t4 server on :${CONFIG.port}  (store=${storeLabel})`);
  console.log(`  firehose: close-ELO ±${CONFIG.eloTolerance}, active pool ${CONFIG.activePoolMs / 86400000}d`);
  console.log(`  features: ${JSON.stringify(CONFIG.features)}`);
  firehose.start().catch((e) => console.error("firehose crashed:", e));
});
