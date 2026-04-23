import assert from "node:assert/strict";
import test from "node:test";
import {
  createReplayArtifactV1,
  DEFAULT_CHARS,
  REPLAY_CONSTANTS_HASH,
  simulate,
  STAGES,
  STRATEGIES,
} from "@m3t4/sim";
import { redactedReplayForCompute, seedReplayComputeTasks } from "../compute/auto-seed.js";

test("compute auto-seed redacts private configs before replay verification", () => {
  const replay = fixtureReplay();
  const redacted = redactedReplayForCompute(replay);
  assert.equal(redacted.players.length, 2);
  for (const player of redacted.players) {
    assert.equal((player as any).config, undefined);
  }
  assert.equal(redacted.actions.hash, replay.actions.hash);
  assert.equal(redacted.result.logHash, replay.result.logHash);
});

test("compute auto-seed posts public artifact and replay verify tasks", async () => {
  const replay = fixtureReplay();
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const results = await seedReplayComputeTasks({
    enabled: true,
    computeLabOrigin: "https://plasma-lab.example/",
    adminToken: "secret",
    timeoutMs: 1000,
  }, replay, async (url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, init, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ taskId: url.endsWith("/replay-verify") ? "task-replay" : "task-artifact" }),
      text: async () => "",
    };
  });

  assert.deepEqual(results.map((result) => result.taskId), ["task-artifact", "task-replay"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://plasma-lab.example/compute/admin/tasks/public-artifact");
  assert.equal(calls[1].url, "https://plasma-lab.example/compute/admin/tasks/replay-verify");
  for (const call of calls) {
    assert.equal((call.init.headers as Record<string, string>)["x-plasma-admin-token"], "secret");
  }
  assert.equal(calls[0].body.artifact.matchId, replay.match.matchId);
  assert.equal(calls[0].body.artifact.payload.tuple.players[0].config, undefined);
  assert.equal(calls[1].body.replayArtifact.players[0].config, undefined);
  assert.equal(calls[1].body.replayArtifact.actions.hash, replay.actions.hash);
});

test("compute auto-seed can enqueue public preset seed sweeps independently", async () => {
  const replay = fixtureReplay();
  const calls: { url: string; body: any }[] = [];
  const results = await seedReplayComputeTasks({
    enabled: true,
    replayTasksEnabled: false,
    computeLabOrigin: "https://plasma-lab.example/",
    adminToken: "secret",
    timeoutMs: 1000,
    seedSweep: {
      enabled: true,
      brainA: "blitz",
      brainB: "shipper",
      seedCount: 16,
      seedChunkSize: 4,
      maxTicks: 480,
    },
  }, replay, async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ taskId: "task-seed-sweep" }),
      text: async () => "",
    };
  });

  assert.deepEqual(results.map((result) => result.taskId), ["task-seed-sweep"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://plasma-lab.example/compute/admin/tasks/seed-sweep");
  assert.equal(calls[0].body.stageId, replay.match.stageId);
  assert.equal(calls[0].body.brainA, "blitz");
  assert.equal(calls[0].body.brainB, "shipper");
  assert.equal(calls[0].body.seedEndExclusive - calls[0].body.seedStart, 16);
  assert.equal(calls[0].body.seedChunkSize, 4);
  assert.equal(calls[0].body.maxTicks, 480);
  assert.equal(calls[0].body.minExecutions, 2);
  assert.equal(calls[0].body.minAgreeing, 2);
});

test("compute auto-seed can enqueue WebGPU tensor tiles independently", async () => {
  const replay = fixtureReplay();
  const calls: { url: string; body: any }[] = [];
  const results = await seedReplayComputeTasks({
    enabled: true,
    replayTasksEnabled: false,
    computeLabOrigin: "https://plasma-lab.example/",
    adminToken: "secret",
    timeoutMs: 1000,
    tensorTile: {
      enabled: true,
      rows: 12,
      cols: 10,
      depth: 24,
      minExecutions: 3,
      minAgreeing: 2,
    },
  }, replay, async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ taskId: "task-tensor-tile" }),
      text: async () => "",
    };
  });

  assert.deepEqual(results.map((result) => result.taskId), ["task-tensor-tile"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://plasma-lab.example/compute/admin/tasks/tensor-tile");
  assert.equal(typeof calls[0].body.seed, "number");
  assert.equal(calls[0].body.rows, 12);
  assert.equal(calls[0].body.cols, 10);
  assert.equal(calls[0].body.depth, 24);
  assert.equal(calls[0].body.minExecutions, 3);
  assert.equal(calls[0].body.minAgreeing, 2);
});

test("compute auto-seed stays inert unless enabled and authenticated", async () => {
  const replay = fixtureReplay();
  const called = async () => {
    throw new Error("fetch should not be called");
  };
  assert.deepEqual(await seedReplayComputeTasks({
    enabled: false,
    computeLabOrigin: "https://plasma-lab.example",
    adminToken: "secret",
  }, replay, called), []);
  assert.deepEqual(await seedReplayComputeTasks({
    enabled: true,
    computeLabOrigin: "https://plasma-lab.example",
  }, replay, called), []);
});

function fixtureReplay() {
  const result = simulate({
    stage: STAGES.datacenter,
    brainA: STRATEGIES.blitz,
    brainB: STRATEGIES.shipper,
    seed: 4242,
    maxTicks: 240,
  });
  return createReplayArtifactV1({
    matchId: "auto-seed-1",
    mode: "ranked",
    stage: STAGES.datacenter,
    seed: 4242,
    chars: DEFAULT_CHARS,
    players: [
      { kind: "brain", tier: "user", label: "blitz", config: STRATEGIES.blitz, slotName: "a" },
      { kind: "brain", tier: "user", label: "shipper", config: STRATEGIES.shipper, slotName: "b" },
    ],
    actionLog: result.frameLog,
    result,
    sim: { constantsHash: REPLAY_CONSTANTS_HASH },
  });
}
