// Arena server: HTTP + WebSocket on one port. REST for submit / leaderboard,
// WebSocket for spectating live brackets.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { ConfigStore } from "./configStore.js";
import { Matchmaker } from "./matchmaker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT ?? "7777", 10);
const STORE_PATH = process.env.STORE ?? path.join(__dirname, "..", "data", "configs.json");
const CYCLE_MS = parseInt(process.env.CYCLE_MS ?? "60000", 10);

const store = new ConfigStore(STORE_PATH);
const mm = new Matchmaker(store);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (req.method === "POST" && url.pathname === "/api/configs") {
    let buf = "";
    for await (const chunk of req) buf += chunk;
    try {
      const body = JSON.parse(buf || "{}");
      const stored = store.submit(body.config, { author: body.author });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: stored.config.id, hash: stored.hash }));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String((e as Error).message) }));
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/leaderboard") {
    const lb = store.leaderboard(parseInt(url.searchParams.get("limit") ?? "25", 10));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(lb.map((s) => ({ id: s.config.id, elo: s.elo, wins: s.wins, losses: s.losses, draws: s.draws, author: s.author }))));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/configs") {
    const id = url.searchParams.get("id");
    if (id) {
      const c = store.get(id);
      if (!c) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(c));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(store.list().map((c) => ({ id: c.config.id, author: c.author, elo: c.elo }))));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, configs: store.list().length, cycleMs: CYCLE_MS }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  const client = mm.addClient(ws);
  ws.on("close", () => mm.removeClient(client));
  ws.on("error", () => mm.removeClient(client));
});

server.listen(PORT, () => {
  console.log(`arena server listening on :${PORT}  (store=${STORE_PATH}, cycle=${CYCLE_MS}ms)`);
});

// Scheduler: kick off a cycle every CYCLE_MS, but skip if one is mid-flight.
let running = false;
async function tickCycle(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await mm.startCycle();
  } catch (e) {
    console.error("cycle error:", e);
  } finally {
    running = false;
  }
}
setInterval(tickCycle, CYCLE_MS);
setTimeout(tickCycle, 1000);
