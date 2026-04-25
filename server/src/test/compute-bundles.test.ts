import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReplayArtifactV1 } from "@m3t4/sim";

import {
  materializeScienceBundle,
  materializeProofBundle,
  sealBundleAgainstMatch,
} from "../compute/bundles.js";

function stubReplay(matchId: string): ReplayArtifactV1 {
  return {
    schema: "m3t4.replay",
    version: 1,
    mode: "ranked",
    createdAt: new Date().toISOString(),
    match: { matchId, stageId: "boardroom", seed: 42 },
    players: [
      { side: 0, kind: "user", label: "Alice", handle: "alice", userId: "u1", slotId: "s1", slotName: "", config: { knobs: {} as any, derived: {}, ops: [] } as any },
      { side: 1, kind: "user", label: "Bob",   handle: "bob",   userId: "u2", slotId: "s2", slotName: "", config: { knobs: {} as any, derived: {}, ops: [] } as any },
    ] as any,
    sim: { constantsHash: "cafebabe" },
    integrity: {
      stageHash: "0".repeat(64),
      charsHash: "0".repeat(64),
      actionLogHash: "0".repeat(16),
      actionLogSha256: "0".repeat(64),
      frameLogHash: "0".repeat(16),
    } as any,
    actions: { encoding: "v1", byteLength: 0, decisionTicks: 0, hash: "0".repeat(16), sha256: "0".repeat(64), body: "" } as any,
    result: { logHash: "0".repeat(16), winner: 0, finalScore: [1, 0], finalRounds: 0, ticks: 0 } as any,
  } as unknown as ReplayArtifactV1;
}

const OK_CONFIG = {
  enabled: true,
  computeLabOrigin: "http://plasma-lab.test",
  adminToken: "token",
  timeoutMs: 1000,
};

const DISABLED_CONFIG = {
  enabled: false,
  computeLabOrigin: "http://plasma-lab.test",
  adminToken: "token",
};

test("materializeScienceBundle returns null when disabled", async () => {
  const fetchImpl = async () => { throw new Error("should not be called"); };
  const result = await materializeScienceBundle(DISABLED_CONFIG, { matchId: "m1", sponsors: [] }, fetchImpl as any);
  assert.equal(result, null);
});

test("materializeScienceBundle posts to materialize-contact-map and returns bundleId on success", async () => {
  const seen: Array<{ url: string; body: any }> = [];
  const fetchImpl = async (url: string, init: any) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        bundle: { bundleId: "bundle-xxx", kernelId: "science.contact_map_tile.v0", chunkIds: ["c1", "c2"], sponsors: ["alice", "bob"], deadlineAt: null },
        preset: "preset-a",
        tileRows: 2,
        tileCols: 2,
        chunkCount: 4,
      }),
      text: async () => "",
    };
  };
  const result = await materializeScienceBundle(OK_CONFIG, {
    matchId: "m1",
    sponsors: ["alice", "bob"],
    expectedMatchSec: 120,
    presetId: "preset-a",
  }, fetchImpl as any);
  assert.ok(result);
  assert.equal(result!.bundleId, "bundle-xxx");
  assert.equal(result!.chunkCount, 4);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://plasma-lab.test/compute/admin/bundles/materialize-contact-map");
  assert.equal(seen[0].body.matchId, "m1");
  assert.equal(seen[0].body.expectedMatchSec, 120);
  assert.equal(seen[0].body.tileRows, undefined);
  assert.equal(seen[0].body.tileCols, undefined);
});

test("materializeScienceBundle forwards explicit tile grid sizing", async () => {
  const seen: any[] = [];
  const fetchImpl = async (_url: string, init: any) => {
    seen.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        bundle: { bundleId: "bundle-small", kernelId: "science.contact_map_tile.v0", chunkIds: ["c1"], sponsors: [], deadlineAt: null },
        preset: "preset-a",
        tileRows: 4,
        tileCols: 4,
        chunkCount: 16,
      }),
      text: async () => "",
    };
  };
  const result = await materializeScienceBundle(OK_CONFIG, {
    matchId: "m-small",
    sponsors: [],
    tileRows: 4,
    tileCols: 4,
  }, fetchImpl as any);
  assert.ok(result);
  assert.equal(result!.chunkCount, 16);
  assert.equal(seen[0].tileRows, 4);
  assert.equal(seen[0].tileCols, 4);
});

test("materializeScienceBundle returns null on admin failure", async () => {
  const fetchImpl = async () => ({
    ok: false, status: 403, json: async () => ({ error: "admin disabled" }), text: async () => "",
  });
  const result = await materializeScienceBundle(OK_CONFIG, { matchId: "m1", sponsors: [] }, fetchImpl as any);
  assert.equal(result, null);
});

test("materializeProofBundle strips private player config before sending replay", async () => {
  const seen: any[] = [];
  const fetchImpl = async (_url: string, init: any) => {
    seen.push(JSON.parse(init.body));
    return {
      ok: true, status: 200,
      json: async () => ({ bundle: { bundleId: "proof-123", kernelId: "m3t4.replay_verify.v1", chunkIds: ["c-proof"], sponsors: [] }, taskId: "t-proof" }),
      text: async () => "",
    };
  };
  const replay = stubReplay("m42");
  const result = await materializeProofBundle(OK_CONFIG, { matchId: "m42", sponsors: ["alice", "bob"], replay }, fetchImpl as any);
  assert.ok(result);
  assert.equal(result!.bundleId, "proof-123");
  const body = seen[0];
  const parsedReplay = JSON.parse(body.replayArtifactJson);
  for (const player of parsedReplay.players) {
    assert.equal("config" in player, false, "player.config must be stripped");
  }
});

test("sealBundleAgainstMatch sends sha256 battle-receipt hash and forwards bundleRoot", async () => {
  const seen: any[] = [];
  const expectedRoot = { algorithm: "sha256", value: "d".repeat(64) };
  const fetchImpl = async (url: string, init: any) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true, status: 200,
      json: async () => ({ bundle: { bundleRoot: expectedRoot } }),
      text: async () => "",
    };
  };
  const replay = stubReplay("m42");
  const sealed = await sealBundleAgainstMatch(OK_CONFIG, { bundleId: "bundle-xxx", matchId: "m42", replay }, fetchImpl as any);
  assert.equal(sealed.ok, true);
  assert.deepEqual(sealed.bundleRoot, expectedRoot);
  const payload = seen[0].body;
  assert.equal(payload.matchId, "m42");
  assert.equal(payload.matchReceiptHash.algorithm, "sha256");
  assert.equal(typeof payload.matchReceiptHash.value, "string");
  assert.equal(payload.matchReceiptHash.value.length, 64);
  assert.ok(seen[0].url.endsWith("/seal"));
});
