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
