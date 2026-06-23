// m3t4 Arena server — Phase 1.
//
// - Auth-gated submit API (dev mode accepts any bearer token as UID)
// - 3-5 slot stables with short per-slot edit cooldowns
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
import { registerBuildRoutes } from "./routes/build.js";
import { registerRankedRoutes } from "./routes/ranked.js";
import { registerReplayVerifyRoutes } from "./routes/replay.js";
import { registerDuelRoutes } from "./p2p/routes.js";
import { registerCommunityVerifyRoutes } from "./community/routes.js";
import { registerProofRoutes } from "./labs/proof/routes.js";
import { initZkVerifiers } from "./labs/proof/zk.js";
import { registerComputeRoutes } from "./compute/routes.js";
import { ComputeStore } from "./compute/store.js";
import { FanoutRelay } from "./fanout.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORE_PATH = CONFIG.storePath ?? path.join(__dirname, "..", "data", "m3t4.json");

const store = CONFIG.storeBackend === "firestore"
  ? new FirestoreStableStore()
  : new FileStableStore(STORE_PATH);
const runsApi = CONFIG.serverRole === "combined" || CONFIG.serverRole === "api";
const runsFirehose = CONFIG.serverRole === "combined" || CONFIG.serverRole === "worker";
const runsFanout = CONFIG.serverRole === "api";
const firehose = runsFirehose ? new Firehose(store) : null;
const fanout = runsFanout ? new FanoutRelay(CONFIG.firehoseWsOrigin) : null;

if (runsApi && CONFIG.features.proofLab && CONFIG.features.zk) {
  // No-op if no vkey.json is present; the proof route reports that clearly.
  initZkVerifiers();
}

const routes: RouteList = [];
if (runsApi) {
  registerBuildRoutes(routes);
  registerRankedRoutes(routes, { store, features: CONFIG.features, config: CONFIG });
  registerReplayVerifyRoutes(routes, { store });
} else {
  routes.push(async (req, res, url) => {
    if (req.method === "GET" && url.pathname === "/api/status") {
      json(res, 200, {
        ok: true,
        role: CONFIG.serverRole,
        cycleMs: CONFIG.cycleMs,
        computeLabOrigin: CONFIG.computeLabOrigin,
        computeStunUrls: CONFIG.computeStunUrls,
        storeBackend: CONFIG.storeBackend,
        wsClientSoftLimit: CONFIG.wsClientSoftLimit,
        features: CONFIG.features,
      });
      return true;
    }
    return false;
  });
}

if (runsApi && CONFIG.features.p2pDuel) {
  const duelStore = new VerifyStore(defaultVerifyStorePath("duel"));
  registerDuelRoutes(routes, { store, vstore: duelStore });
}

if (runsApi && CONFIG.features.communityVerify) {
  const communityStore = new VerifyStore(defaultVerifyStorePath("community"));
  registerCommunityVerifyRoutes(routes, { store, vstore: communityStore });
}

if (runsApi && CONFIG.features.proofLab) {
  const proofStore = new VerifyStore(defaultVerifyStorePath("proof"));
  registerProofRoutes(routes, { store, vstore: proofStore, zkEnabled: CONFIG.features.zk });
}

if (runsApi && CONFIG.features.distributedCompute) {
  const computeStore = new ComputeStore();
  registerComputeRoutes(routes, {
    store: computeStore,
    taskAdminEnabled: CONFIG.features.computeTaskAdmin,
  });
  // Seed a small prime-search task so freshly-connected workers have
  // something to chew on without needing an admin API call. Real
  // workloads are posted via /api/compute/tasks (gated separately).
  computeStore.createTask({
    kind: "prime-search.v0",
    chunks: Array.from({ length: 32 }, (_, i) => ({
      params: { start: 1_000_000 + i * 20_000, endExclusive: 1_000_000 + (i + 1) * 20_000 },
    })),
    minExecutions: 2,
    minAgreeing: 2,
  });
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

const wss = new WebSocketServer({
  server,
  path: "/ws",
  perMessageDeflate: {
    threshold: 512,
    concurrencyLimit: 10,
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
  },
});
wss.on("connection", (ws) => {
  if (firehose) {
    if (isWsAtCapacity(firehose.clientCount())) {
      ws.close(1013, "capacity");
      return;
    }
    const client = firehose.addClient(ws);
    ws.on("close", () => firehose.removeClient(client));
    ws.on("error", () => firehose.removeClient(client));
    return;
  }
  if (fanout) {
    if (isWsAtCapacity(fanout.clientCount())) {
      ws.close(1013, "capacity");
      return;
    }
    const client = fanout.addClient(ws);
    ws.on("close", () => fanout.removeClient(client));
    ws.on("error", () => fanout.removeClient(client));
    return;
  }
  ws.close(1011, "websocket disabled for this role");
});

function isWsAtCapacity(currentClients: number): boolean {
  return CONFIG.wsClientSoftLimit > 0 && currentClients >= CONFIG.wsClientSoftLimit;
}

server.listen(CONFIG.port, () => {
  const storeLabel = CONFIG.storeBackend === "firestore" ? "firestore" : STORE_PATH;
  console.log(`m3t4 server on :${CONFIG.port}  (role=${CONFIG.serverRole}, store=${storeLabel})`);
  if (fanout) {
    console.log(`  fanout: upstream ${CONFIG.firehoseWsOrigin}`);
    fanout.start();
  }
  if (firehose) {
    console.log(`  firehose: close-ELO ±${CONFIG.eloTolerance}, active pool ${CONFIG.activePoolMs}ms`);
    firehose.start().catch((e) => console.error("firehose crashed:", e));
  }
  console.log(`  features: ${JSON.stringify(CONFIG.features)}`);
});
