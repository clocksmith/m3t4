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
import { FileStableStore, stablePublic } from "./stable.js";
import { Firehose } from "./firehose.js";
import { handleClaimHandle, handleSubmit } from "./submit.js";
import {
  handleCommunityAttest,
  handleDuelAccept,
  handleDuelChallenge,
  handleDuelRendezvous,
  handleDuelSubmit,
  handleSpectateTuple,
  handleVerifyReplay,
} from "./verify.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORE_PATH = process.env.STORE_PATH ?? path.join(__dirname, "..", "data", "m3t4.json");

const store = new FileStableStore(STORE_PATH);
const firehose = new Firehose(store);

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    });
    res.end(); return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/status") {
    return json(res, 200, {
      ok: true,
      cycleMs: CONFIG.cycleMs,
      maxSlots: CONFIG.maxSlots,
      authProviders: CONFIG.authProviders,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/leaderboard") {
    const active = await store.listActive(CONFIG.activePoolMs);
    const rows = active
      .map((st) => stablePublic(st))
      .sort((a, b) => b.eloAggregate - a.eloAggregate);
    return json(res, 200, rows.slice(0, 50));
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/stables/")) {
    const uid = url.pathname.slice("/api/stables/".length);
    const st = await store.getStable(uid);
    if (!st) return json(res, 404, { error: "not found" });
    return json(res, 200, stablePublic(st));
  }

  if (req.method === "POST" && url.pathname === "/api/ranked/submit") {
    return handleSubmit(req, res, store);
  }
  if (req.method === "POST" && url.pathname === "/api/handle") {
    return handleClaimHandle(req, res, store);
  }

  if (req.method === "POST" && url.pathname === "/internal/elo-decay") {
    const count = await store.applyDecay();
    return json(res, 200, { ok: true, decayed: count });
  }

  // --- ARCHITECTURE.md surface ---

  if (req.method === "POST" && url.pathname === "/api/verify/replay") {
    return handleVerifyReplay(req, res);
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/spectate/tuple/")) {
    const matchId = url.pathname.slice("/api/spectate/tuple/".length);
    if (!matchId) return json(res, 400, { error: "matchId required" });
    return handleSpectateTuple(store, matchId, req, res);
  }
  if (req.method === "POST" && url.pathname === "/api/duel/challenge") {
    return handleDuelChallenge(req, res);
  }
  if (req.method === "POST" && url.pathname === "/api/duel/accept") {
    return handleDuelAccept(req, res);
  }
  if (req.method === "POST" && url.pathname === "/api/duel/submit") {
    return handleDuelSubmit(store, req, res);
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/duel/rendezvous/")) {
    const challengeId = url.pathname.slice("/api/duel/rendezvous/".length);
    return handleDuelRendezvous(challengeId, req, res);
  }
  if (req.method === "POST" && url.pathname === "/api/community/attest") {
    return handleCommunityAttest(store, req, res);
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
  console.log(`m3t4 server on :${CONFIG.port}  (store=${STORE_PATH})`);
  console.log(`  firehose: close-ELO ±${CONFIG.eloTolerance}, active pool ${CONFIG.activePoolMs / 86400000}d`);
  firehose.start().catch((e) => console.error("firehose crashed:", e));
});
