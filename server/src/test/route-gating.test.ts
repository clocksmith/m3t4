import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReplayArtifactV1 } from "@m3t4/sim";
import { json } from "../http-utils.js";
import { registerDuelRoutes } from "../p2p/routes.js";
import { registerRankedRoutes } from "../routes/ranked.js";
import { registerReplayVerifyRoutes } from "../routes/replay.js";
import type { RouteList } from "../routes/types.js";
import { VerifyStore } from "../verify-store.js";

class MemoryStableStore {
  private replays = new Map<string, ReplayArtifactV1>();
  async archiveReplay(a: ReplayArtifactV1): Promise<void> { this.replays.set(a.match.matchId, a); }
  async getReplay(matchId: string): Promise<ReplayArtifactV1 | null> {
    return this.replays.get(matchId) ?? null;
  }
  async getStable(): Promise<any> { return null; }
  async listActive(): Promise<any[]> { return []; }
  async applyDecay(): Promise<number> { return 0; }
  async createStable(): Promise<any> { return null; }
  async updateStable(): Promise<void> {}
  async claimHandle(): Promise<any> { return null; }
  async addSlot(): Promise<any> { return null; }
  async recordMatch(): Promise<void> {}
}

function boot(routes: RouteList): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    for (const route of routes) {
      if (await route(req, res, url)) return;
    }
    json(res, 404, { error: "not found" });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function req(port: number, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: url,
      headers: {
        "content-type": "application/json",
        ...(payload ? { "content-length": String(Buffer.byteLength(payload)) } : {}),
      },
    }, (resp) => {
      const chunks: Buffer[] = [];
      resp.on("data", (c: Buffer) => chunks.push(c));
      resp.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: resp.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function registerCore(routes: RouteList, store: MemoryStableStore): void {
  registerRankedRoutes(routes, {
    store: store as any,
    features: {
      p2pDuel: false,
      communityVerify: false,
      proofLab: false,
      zk: false,
    },
    config: {
      activePoolMs: 1,
      authProviders: ["google", "github"],
      cycleMs: 1500,
      maxSlots: 5,
    },
  });
  registerReplayVerifyRoutes(routes, { store: store as any });
}

test("centralized route graph hides P2P routes by default", async (t) => {
  const routes: RouteList = [];
  const store = new MemoryStableStore();
  registerCore(routes, store);
  const srv = await boot(routes);
  t.after(() => srv.close());

  const status = await req(srv.port, "GET", "/api/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.features.p2pDuel, false);

  const duel = await req(srv.port, "POST", "/api/duel/challenge", {
    toUid: "bob",
    stageId: "datacenter",
  });
  assert.equal(duel.status, 404);
});

test("P2P routes are available only when the duel registrar is mounted", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m3t4-route-gating-"));
  const routes: RouteList = [];
  const store = new MemoryStableStore();
  const vstore = new VerifyStore(path.join(tmp, "verify.json"));
  registerCore(routes, store);
  registerDuelRoutes(routes, { store: store as any, vstore });
  const srv = await boot(routes);
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    return srv.close();
  });

  const duel = await req(srv.port, "POST", "/api/duel/challenge", {
    toUid: "bob",
    stageId: "datacenter",
  });
  assert.equal(duel.status, 200);
  assert.ok(duel.body.challengeId);
});

