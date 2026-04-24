// HTTP integration tests for the verify/duel/community/proof surface.
//
// Boots a minimal HTTP server on a random port, mounts the full route
// set from index.ts using a fresh VerifyStore pointed at a temp file,
// then exercises each endpoint via real HTTP requests. Uses a stub
// StableStore where we need one for replay lookups.

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  BEHAVIOR_VERSION, DEFAULT_CHARS, REPLAY_CONSTANTS_HASH,
  STAGES, STRATEGIES, createReplayArtifactV1, simulate,
  USER_KNOBS, computedHallucinationForSpend, nativeToUI, validateUserSubmission,
  type BrainConfig,
  type ReplayArtifactV1,
} from "@m3t4/sim";
import { VerifyStore } from "../verify-store.js";
import {
  handleCommunityAttest, handleCommunityRegister, handleCommunityStatus,
  handleDuelAccept, handleDuelChallenge, handleDuelSignalGet, handleDuelSignalPost,
  handleDuelSubmit, handleSpectateTuple, handleVerifyReplay,
} from "../verify.js";
import {
  handleAttestRegister, handleAttestSubmit,
  handleProofCommit, handleProofReveal,
  handleProofZkSubmit, handleProofZkSystems,
} from "../proof.js";
import {
  publicReplayArtifactFromReplay,
  publicReplayArtifactPayloadJson,
  type PublicReplayArtifactV1,
} from "../public-artifacts.js";

// --- Stub StableStore (only uses getReplay + archiveReplay) ---

class MemoryStableStore {
  private replays = new Map<string, ReplayArtifactV1>();
  private publicArtifacts = new Map<string, PublicReplayArtifactV1>();
  async archiveReplay(a: ReplayArtifactV1): Promise<void> {
    this.replays.set(a.match.matchId, a);
    this.publicArtifacts.set(a.match.matchId, publicReplayArtifactFromReplay(a));
  }
  async getReplay(matchId: string): Promise<ReplayArtifactV1 | null> {
    return this.replays.get(matchId) ?? null;
  }
  async getPublicReplayArtifact(matchId: string): Promise<PublicReplayArtifactV1 | null> {
    return this.publicArtifacts.get(matchId) ?? null;
  }
  async listPublicReplayArtifactSummaries(): Promise<never[]> { return []; }
  // Other methods not needed for these tests — declared as any to satisfy the type.
  async getStable(): Promise<any> { return null; }
  async listActive(): Promise<any[]> { return []; }
  async applyDecay(): Promise<number> { return 0; }
  async createStable(): Promise<any> { return null; }
  async updateStable(): Promise<void> {}
  async claimHandle(): Promise<any> { return null; }
  async addSlot(): Promise<any> { return null; }
  async recordMatch(): Promise<void> {}
}

// --- Test harness: boot a small HTTP server with the routes mounted ---

function bootTestServer(): Promise<{ port: number; close: () => Promise<void>; store: MemoryStableStore; vstore: VerifyStore; }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m3t4-verify-test-"));
  const storeFile = path.join(tmp, "verify.json");
  process.env.VERIFY_STORE_PATH = storeFile;
  const store = new MemoryStableStore();
  const vstore = new VerifyStore(storeFile);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const p = url.pathname;
      const m = req.method ?? "GET";
      if (m === "POST" && p === "/api/verify/replay") return handleVerifyReplay(req, res);
      if (m === "GET" && p.startsWith("/api/spectate/tuple/")) {
        return handleSpectateTuple(store as any, p.slice("/api/spectate/tuple/".length), req, res);
      }
      if (m === "GET" && p.startsWith("/api/replays/public-artifact/")) {
        const artifact = await store.getPublicReplayArtifact(p.slice("/api/replays/public-artifact/".length));
        if (!artifact) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "public replay artifact not found" }));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(artifact));
        }
        return;
      }
      if (m === "POST" && p === "/api/duel/challenge") return handleDuelChallenge(vstore, req, res);
      if (m === "POST" && p === "/api/duel/accept") return handleDuelAccept(vstore, req, res);
      if (m === "POST" && p === "/api/duel/submit") return handleDuelSubmit(store as any, req, res);
      if (m === "POST" && p.startsWith("/api/duel/signal/")) {
        return handleDuelSignalPost(vstore, p.slice("/api/duel/signal/".length), req, res);
      }
      if (m === "GET" && p.startsWith("/api/duel/signal/")) {
        return handleDuelSignalGet(vstore, p.slice("/api/duel/signal/".length), req, res);
      }
      if (m === "POST" && p === "/api/community/workers/register") return handleCommunityRegister(vstore, req, res);
      if (m === "POST" && p === "/api/community/attest") return handleCommunityAttest(store as any, vstore, req, res);
      if (m === "GET" && p.startsWith("/api/community/status/")) {
        return handleCommunityStatus(store as any, vstore, p.slice("/api/community/status/".length), req, res);
      }
      if (m === "POST" && p === "/api/proof/commit") return handleProofCommit(vstore, req, res);
      if (m === "POST" && p === "/api/proof/reveal") return handleProofReveal(store as any, vstore, req, res);
      if (m === "POST" && p === "/api/proof/attest/register") return handleAttestRegister(vstore, req, res);
      if (m === "POST" && p === "/api/proof/attest/submit") return handleAttestSubmit(store as any, vstore, req, res);
      if (m === "GET" && p === "/api/proof/zk/systems") return handleProofZkSystems(req, res);
      if (m === "POST" && p === "/api/proof/zk/submit") return handleProofZkSubmit(store as any, req, res);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        store, vstore,
        close: () => new Promise<void>((r) => {
          server.close(() => { fs.rmSync(tmp, { recursive: true, force: true }); r(); });
        }),
      });
    });
  });
}

function legalSubmittedConfig(cfg: BrainConfig): BrainConfig {
  const filled: BrainConfig = {
    ...cfg,
    attributes: {
      ...cfg.attributes,
      lift: cfg.attributes.lift ?? 0,
      parry: cfg.attributes.parry ?? 0,
      chase: cfg.attributes.chase ?? 0,
      discipline: cfg.attributes.discipline ?? 0,
    },
  };
  const validation = validateUserSubmission(filled);
  assert.equal(validation.ok, true, validation.errors.join("; "));
  assert.ok(validation.config);
  return validation.config;
}

function v2ConfigFromNative(cfg: BrainConfig): BrainConfig {
  const native = legalSubmittedConfig(cfg);
  const attributes: BrainConfig["attributes"] = {};
  let spent = 0;
  for (const key of USER_KNOBS) {
    const value = native.attributes[key];
    const ui = Math.round(nativeToUI(key, typeof value === "number" ? value : 0));
    attributes[key] = ui;
    spent += ui;
  }
  attributes.hallucination = Math.round(nativeToUI("hallucination", computedHallucinationForSpend(spent)));
  return {
    id: native.id,
    author: native.author,
    seed: native.seed,
    configVersion: 2,
    attributes,
  };
}

async function req(port: number, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request({
      host: "127.0.0.1", port, method, path: url,
      headers: {
        "content-type": "application/json",
        ...(payload ? { "content-length": String(Buffer.byteLength(payload)) } : {}),
        ...headers,
      },
    }, (resp) => {
      const chunks: Buffer[] = [];
      resp.on("data", (c: Buffer) => chunks.push(c));
      resp.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: any; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: resp.statusCode ?? 0, body: parsed });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// --- Tests ---

test("verify/replay: re-simulates action log and confirms result", async (t) => {
  const srv = await bootTestServer();
  t.after(() => srv.close());
  const result = simulate({
    stage: STAGES.datacenter,
    brainA: STRATEGIES.blitz, brainB: STRATEGIES.shipper,
    seed: 999, maxTicks: 240,
  });
  const actionLogB64 = Buffer.from(result.frameLog).toString("base64");
  const r = await req(srv.port, "POST", "/api/verify/replay", {
    seed: 999, stageId: "datacenter",
    actionLogB64,
    maxTicks: 240,
    expectedLogHash: result.logHash,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.result.logHash, result.logHash);
});

test("verify/replay: rejects wrong expected hash", async (t) => {
  const srv = await bootTestServer();
  t.after(() => srv.close());
  const result = simulate({
    stage: STAGES.datacenter,
    brainA: STRATEGIES.blitz, brainB: STRATEGIES.shipper,
    seed: 1000, maxTicks: 240,
  });
  const r = await req(srv.port, "POST", "/api/verify/replay", {
    seed: 1000, stageId: "datacenter",
    actionLogB64: Buffer.from(result.frameLog).toString("base64"),
    maxTicks: 240,
    expectedLogHash: "00000000",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.match(r.body.reason, /logHash mismatch/);
});

test("spectate/tuple: returns public ref + trust label", async (t) => {
  const srv = await bootTestServer();
  t.after(() => srv.close());
  const result = simulate({
    stage: STAGES.datacenter,
    brainA: STRATEGIES.blitz, brainB: STRATEGIES.shipper,
    seed: 101, maxTicks: 240,
  });
  const art = createReplayArtifactV1({
    matchId: "t1", mode: "ranked", stage: STAGES.datacenter, seed: 101, chars: DEFAULT_CHARS,
    players: [
      { kind: "brain", tier: "user", label: "blitz", config: STRATEGIES.blitz, slotName: "a" },
      { kind: "brain", tier: "user", label: "shipper", config: STRATEGIES.shipper, slotName: "b" },
    ],
    actionLog: result.frameLog, result,
    sim: { constantsHash: REPLAY_CONSTANTS_HASH },
  });
  await srv.store.archiveReplay(art);
  const r = await req(srv.port, "GET", "/api/spectate/tuple/t1");
  assert.equal(r.status, 200);
  assert.equal(r.body.matchId, "t1");
  assert.equal(r.body.seed, 101);
  assert.equal(r.body.trust.tier, "ranked-server");
  // configs must NOT leak
  for (const p of r.body.players) assert.equal(p.config, undefined);
});

test("public replay artifact exports hashes without private configs", async (t) => {
  const srv = await bootTestServer();
  t.after(() => srv.close());
  const result = simulate({
    stage: STAGES.datacenter,
    brainA: STRATEGIES.blitz, brainB: STRATEGIES.shipper,
    seed: 202, maxTicks: 240,
  });
  const art = createReplayArtifactV1({
    matchId: "pub1", mode: "ranked", stage: STAGES.datacenter, seed: 202, chars: DEFAULT_CHARS,
    players: [
      { kind: "brain", tier: "user", label: "blitz", config: STRATEGIES.blitz, handle: "alice", slotName: "a" },
      { kind: "brain", tier: "user", label: "shipper", config: STRATEGIES.shipper, handle: "bob", slotName: "b" },
    ],
    actionLog: result.frameLog, result,
    sim: { constantsHash: REPLAY_CONSTANTS_HASH },
  });
  await srv.store.archiveReplay(art);

  const r = await req(srv.port, "GET", "/api/replays/public-artifact/pub1");
  assert.equal(r.status, 200);
  assert.equal(r.body.schema, "m3t4.public-replay-artifact");
  assert.equal(r.body.matchId, "pub1");
  assert.equal(r.body.payload.tuple.players[0].handle, "alice");
  assert.equal(r.body.payload.tuple.players[0].config, undefined);
  assert.equal(r.body.payload.tuple.players[1].config, undefined);
  assert.equal(r.body.payload.actions.byteLength, result.frameLog.length);
  assert.equal(r.body.payload.tuple.expectedLogHash, result.logHash);
  assert.equal(
    crypto.createHash("sha256").update(publicReplayArtifactPayloadJson(r.body.payload), "utf8").digest("hex"),
    r.body.artifactSha256,
  );
});

test("duel flow: challenge → accept → submit archives p2p-action-verified replay", async (t) => {
  const srv = await bootTestServer();
  t.after(() => srv.close());
  // challenge
  const ch = await req(srv.port, "POST", "/api/duel/challenge", {
    toUid: "bob", stageId: "datacenter",
  }, { authorization: "Bearer alice" });
  assert.equal(ch.status, 200);
  assert.ok(ch.body.challengeId);
  // accept
  const ac = await req(srv.port, "POST", "/api/duel/accept", { challengeId: ch.body.challengeId });
  assert.equal(ac.status, 200);
  const token = ac.body.token;
  assert.ok(token.signature);
  // run the match locally with the issued seed
  const result = simulate({
    stage: STAGES.datacenter,
    brainA: STRATEGIES.blitz, brainB: STRATEGIES.shipper,
    seed: token.seed,
  });
  const actionLogB64 = Buffer.from(result.frameLog).toString("base64");
  const sub = await req(srv.port, "POST", "/api/duel/submit", {
    token, actionLogB64, result,
    peerSignatures: ["sigA", "sigB"],
  });
  assert.equal(sub.status, 200, `submit failed: ${JSON.stringify(sub.body)}`);
  assert.equal(sub.body.ok, true);
  assert.equal(sub.body.trust.tier, "p2p-action-verified");
  // spectate the archived match — trust label preserved
  const spec = await req(srv.port, "GET", `/api/spectate/tuple/${sub.body.matchId}`);
  assert.equal(spec.body.trust.tier, "p2p-action-verified");
});

test("duel signal exchange: SDP offer/answer + ICE round-trip", async (t) => {
  const srv = await bootTestServer();
  t.after(() => srv.close());
  const matchId = "sig1";
  const post1 = await req(srv.port, "POST", `/api/duel/signal/${matchId}`, {
    role: "offer", sdp: "v=0\no=alice", fromPlayerId: "alice",
  });
  assert.equal(post1.status, 200);
  const post2 = await req(srv.port, "POST", `/api/duel/signal/${matchId}`, {
    role: "answer", sdp: "v=0\no=bob", fromPlayerId: "bob",
  });
  assert.equal(post2.status, 200);
  const post3 = await req(srv.port, "POST", `/api/duel/signal/${matchId}`, {
    ice: { candidate: "candidate:abc" }, fromPlayerId: "alice",
  });
  assert.equal(post3.status, 200);
  const get = await req(srv.port, "GET", `/api/duel/signal/${matchId}?role=offer`);
  assert.equal(get.status, 200);
  assert.equal(get.body.sdp.fromPlayerId, "alice");
  assert.equal(get.body.ice.length, 1);
});

test("community verification: register → attest → quorum reached upgrades label", async (t) => {
  const srv = await bootTestServer();
  t.after(() => srv.close());
  // Seed a replay
  const result = simulate({
    stage: STAGES.datacenter,
    brainA: STRATEGIES.blitz, brainB: STRATEGIES.shipper,
    seed: 5, maxTicks: 240,
  });
  const art = createReplayArtifactV1({
    matchId: "c1", mode: "generated", stage: STAGES.datacenter, seed: 5, chars: DEFAULT_CHARS,
    players: [
      { kind: "brain", tier: "user", label: "blitz", config: STRATEGIES.blitz },
      { kind: "brain", tier: "user", label: "shipper", config: STRATEGIES.shipper },
    ],
    actionLog: result.frameLog, result,
    sim: { constantsHash: REPLAY_CONSTANTS_HASH },
  });
  await srv.store.archiveReplay(art);

  // Register 3 workers
  const workers = await Promise.all([1, 2, 3].map(async () => {
    const r = await req(srv.port, "POST", "/api/community/workers/register", { label: "w" });
    assert.equal(r.status, 200);
    return r.body as { workerId: string; sharedSecret: string };
  }));

  // Each worker attests with the strong action-log hash.
  for (const w of workers) {
    const actionSha = art.actions.sha256!;
    const payload = `c1:${actionSha}`;
    const signature = crypto.createHmac("sha256", w.sharedSecret).update(payload).digest("hex");
    const r = await req(srv.port, "POST", "/api/community/attest", {
      matchId: "c1", workerId: w.workerId, computedActionSha256: actionSha, signature,
    });
    assert.equal(r.status, 200);
  }
  // Status now shows community-verified
  const s = await req(srv.port, "GET", "/api/community/status/c1");
  assert.equal(s.status, 200);
  assert.equal(s.body.quorum.reached, true);
  assert.equal(s.body.currentTier, "community-verified");
});

test("community verification: signature mismatch rejected", async (t) => {
  const srv = await bootTestServer();
  t.after(() => srv.close());
  const reg = await req(srv.port, "POST", "/api/community/workers/register", {});
  const r = await req(srv.port, "POST", "/api/community/attest", {
    matchId: "xxx", workerId: reg.body.workerId,
    computedLogHash: "abc",
    signature: "00".repeat(32),
  });
  assert.equal(r.status, 403);
  assert.match(r.body.reason, /signature mismatch/);
});

test("proof L1 commit-reveal: hash mismatch rejected", async (t) => {
  const srv = await bootTestServer();
  t.after(() => srv.close());
  const commitR = await req(srv.port, "POST", "/api/proof/commit", {
    commitmentHash: "a".repeat(64),
  });
  assert.equal(commitR.status, 200);
  const revealR = await req(srv.port, "POST", "/api/proof/reveal", {
    commitmentId: commitR.body.commitmentId,
    config: STRATEGIES.blitz, salt: "saltsaltsalt",
  });
  assert.equal(revealR.status, 403);
  assert.match(revealR.body.reason, /commitment hash mismatch/);
});

test("proof L1 commit-reveal: valid reveal stamps proof-carrying label", async (t) => {
  const srv = await bootTestServer();
  t.after(() => srv.close());
  const salt = "saltsaltsalt";
  const config = legalSubmittedConfig(STRATEGIES.blitz);
  // Compute canonical commitment
  const canonical = canonicalJson(config);
  const commitmentHash = crypto.createHash("sha256").update(canonical + ":" + salt).digest("hex");
  const commitR = await req(srv.port, "POST", "/api/proof/commit", { commitmentHash });
  assert.equal(commitR.status, 200);
  const revealR = await req(srv.port, "POST", "/api/proof/reveal", {
    commitmentId: commitR.body.commitmentId,
    config, salt,
  });
  assert.equal(revealR.status, 200);
  assert.equal(revealR.body.tier, "proof-carrying");
  assert.equal(revealR.body.proof.subtier, "L1-commit-reveal");
});

test("proof L1 standalone replay archives normalized native configs for v2 reveals", async (t) => {
  const srv = await bootTestServer();
  t.after(() => srv.close());
  const salt = "saltsaltsalt";
  const config = v2ConfigFromNative(STRATEGIES.blitz);
  const opponentConfig = v2ConfigFromNative(STRATEGIES.shipper);
  const configValidation = validateUserSubmission(config);
  const opponentValidation = validateUserSubmission(opponentConfig);
  assert.ok(configValidation.config);
  assert.ok(opponentValidation.config);
  const canonical = canonicalJson(config);
  const commitmentHash = crypto.createHash("sha256").update(canonical + ":" + salt).digest("hex");
  const commitR = await req(srv.port, "POST", "/api/proof/commit", { commitmentHash });
  assert.equal(commitR.status, 200);
  const result = simulate({
    stage: STAGES.datacenter,
    brainA: STRATEGIES.blitz, brainB: STRATEGIES.shipper,
    seed: 202, maxTicks: 240,
  });

  const revealR = await req(srv.port, "POST", "/api/proof/reveal", {
    commitmentId: commitR.body.commitmentId,
    config,
    salt,
    matchContext: {
      opponentConfig,
      stageId: "datacenter",
      seed: 202,
      actionLogB64: Buffer.from(result.frameLog).toString("base64"),
      maxTicks: 240,
    },
  });

  assert.equal(revealR.status, 200);
  assert.equal(revealR.body.tier, "proof-carrying");
  const replay = await srv.store.getReplay(revealR.body.matchId);
  assert.ok(replay);
  assert.deepEqual(replay.players[0].config, configValidation.config);
  assert.deepEqual(replay.players[1].config, opponentValidation.config);
  assert.equal(replay.players[0].config?.configVersion, undefined);
  assert.equal(replay.players[1].config?.configVersion, undefined);
});

test("proof L3: no verifier registered for unknown proof system returns 501-like", async (t) => {
  const srv = await bootTestServer();
  t.after(() => srv.close());
  // Seed a replay so archive check passes
  const result = simulate({
    stage: STAGES.datacenter,
    brainA: STRATEGIES.blitz, brainB: STRATEGIES.shipper,
    seed: 77, maxTicks: 240,
  });
  const art = createReplayArtifactV1({
    matchId: "zk1", mode: "generated", stage: STAGES.datacenter, seed: 77, chars: DEFAULT_CHARS,
    players: [
      { kind: "brain", tier: "user", label: "blitz", config: STRATEGIES.blitz },
      { kind: "brain", tier: "user", label: "shipper", config: STRATEGIES.shipper },
    ],
    actionLog: result.frameLog, result,
    sim: { constantsHash: REPLAY_CONSTANTS_HASH },
  });
  await srv.store.archiveReplay(art);
  const r = await req(srv.port, "POST", "/api/proof/zk/submit", {
    proofSystem: "groth16",
    matchId: "zk1",
    actionLogHash: art.actions.sha256!,
    simConstantsHash: REPLAY_CONSTANTS_HASH,
    behaviorVersion: BEHAVIOR_VERSION,
    proofBytesB64: Buffer.from("fake-proof-bytes").toString("base64"),
  });
  assert.equal(r.status, 501);
  assert.match(r.body.reason, /no verifier registered/);
});

test("proof L3 dev-mock: HMAC signature over envelope accepted", async (t) => {
  const srv = await bootTestServer();
  t.after(() => srv.close());
  const result = simulate({
    stage: STAGES.datacenter,
    brainA: STRATEGIES.blitz, brainB: STRATEGIES.shipper,
    seed: 78, maxTicks: 240,
  });
  const art = createReplayArtifactV1({
    matchId: "zk2", mode: "generated", stage: STAGES.datacenter, seed: 78, chars: DEFAULT_CHARS,
    players: [
      { kind: "brain", tier: "user", label: "blitz", config: STRATEGIES.blitz },
      { kind: "brain", tier: "user", label: "shipper", config: STRATEGIES.shipper },
    ],
    actionLog: result.frameLog, result,
    sim: { constantsHash: REPLAY_CONSTANTS_HASH },
  });
  await srv.store.archiveReplay(art);
  const proofSystem = "dev-mock";
  const payload = [proofSystem, "zk2", art.actions.sha256!, REPLAY_CONSTANTS_HASH, String(BEHAVIOR_VERSION)].join("|");
  const secret = "dev-mock-zk-accept-any-signed-envelope-do-not-ship";
  const sig = crypto.createHmac("sha256", secret).update(payload).digest();
  const r = await req(srv.port, "POST", "/api/proof/zk/submit", {
    proofSystem, matchId: "zk2",
    actionLogHash: art.actions.sha256!,
    simConstantsHash: REPLAY_CONSTANTS_HASH,
    behaviorVersion: BEHAVIOR_VERSION,
    proofBytesB64: sig.toString("base64"),
  });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.tier, "proof-carrying");
});

// Canonical JSON helper (mirror of proof.ts — must match exactly)
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
