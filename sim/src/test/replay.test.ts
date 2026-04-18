import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CHARS, simulate } from "../simulate.js";
import {
  createReplayArtifactV1,
  decodeReplayActions,
  isReplayArtifactV1,
  replayArtifactToResultV1,
  replayArtifactWarningsV1,
  replayHashJson,
  REPLAY_CONSTANTS_HASH,
  stableReplayJson,
  verifyReplayIntegrityV1,
} from "../replay.js";
import { STAGES } from "../stage.js";
import { STRATEGIES, STRATEGY_NAMES, type StrategyName } from "../strategies.js";

test("replay artifact v1 stores a verifiable packed action log", () => {
  const stage = STAGES.datacenter;
  const result = simulate({
    stage,
    brainA: STRATEGIES.blitz,
    brainB: STRATEGIES.shipper,
    seed: 123,
  });

  const artifact = createReplayArtifactV1({
    matchId: "test-match",
    mode: "test",
    stage,
    seed: 123,
    chars: DEFAULT_CHARS,
    players: [
      { kind: "brain", tier: "system", label: "blitz", config: STRATEGIES.blitz },
      { kind: "brain", tier: "system", label: "shipper", config: STRATEGIES.shipper },
    ],
    actionLog: result.frameLog,
    result,
    createdAt: "2026-04-17T00:00:00.000Z",
  });

  assert.equal(isReplayArtifactV1(artifact), true);
  assert.equal(artifact.match.stageId, "datacenter");
  assert.equal(artifact.actions.byteLength, result.frameLog.length);
  assert.equal(artifact.actions.decisionTicks, result.frameLog.length / 2);
  assert.equal(artifact.players[0].side, 0);
  assert.equal(artifact.players[1].side, 1);
  assert.equal(artifact.players[0].configHash, replayHashJson(STRATEGIES.blitz));
  assert.deepEqual(Array.from(decodeReplayActions(artifact.actions)), Array.from(result.frameLog));
  assert.deepEqual(replayArtifactToResultV1(artifact).result, {
    winner: result.winner,
    finalScore: result.finalScore,
    finalRounds: result.finalRounds,
    ticks: result.ticks,
    logHash: result.logHash,
  });
});

test("replay artifacts decode back to the recorded result across match samples", () => {
  const stages = Object.values(STAGES);
  for (let i = 0; i < 20; i++) {
    const aName = STRATEGY_NAMES[i % STRATEGY_NAMES.length] as StrategyName;
    const bName = STRATEGY_NAMES[(i * 7 + 3) % STRATEGY_NAMES.length] as StrategyName;
    const stage = stages[i % stages.length];
    const seed = (i * 65537 + 17) >>> 0;
    const result = simulate({
      stage,
      brainA: STRATEGIES[aName],
      brainB: STRATEGIES[bName],
      seed,
      maxTicks: 720,
    });
    const artifact = createReplayArtifactV1({
      matchId: `sample-${i}`,
      mode: "test",
      stage,
      seed,
      chars: DEFAULT_CHARS,
      players: [
        { kind: "brain", tier: "system", label: aName, config: STRATEGIES[aName] },
        { kind: "brain", tier: "system", label: bName, config: STRATEGIES[bName] },
      ],
      actionLog: result.frameLog,
      result,
      createdAt: "2026-04-17T00:00:00.000Z",
    });

    const replayed = replayArtifactToResultV1(artifact);
    assert.equal(replayed.consumedBytes, result.frameLog.length);
    assert.equal(replayed.result.logHash, result.logHash);
    assert.equal(replayed.result.winner, result.winner);
    assert.deepEqual(replayed.result.finalScore, result.finalScore);
    assert.deepEqual(replayed.result.finalRounds, result.finalRounds);
    assert.equal(replayed.result.ticks, result.ticks);
  }
});

test("ranked replay artifacts require a sim binding", () => {
  const stage = STAGES.datacenter;
  const result = simulate({
    stage,
    brainA: STRATEGIES.blitz,
    brainB: STRATEGIES.shipper,
    seed: 1,
    maxTicks: 120,
  });

  assert.throws(() => createReplayArtifactV1({
    matchId: "ranked-missing-binding",
    mode: "ranked",
    stage,
    seed: 1,
    chars: DEFAULT_CHARS,
    players: [
      { kind: "brain", tier: "system", label: "blitz", config: STRATEGIES.blitz },
      { kind: "brain", tier: "system", label: "shipper", config: STRATEGIES.shipper },
    ],
    actionLog: result.frameLog,
    result,
  }), /sourceHash or sim\.constantsHash/);

  const artifact = createReplayArtifactV1({
    matchId: "ranked-bound",
    mode: "ranked",
    stage,
    seed: 1,
    chars: DEFAULT_CHARS,
    players: [
      { kind: "brain", tier: "system", label: "blitz", config: STRATEGIES.blitz },
      { kind: "brain", tier: "system", label: "shipper", config: STRATEGIES.shipper },
    ],
    actionLog: result.frameLog,
    result,
    sim: { constantsHash: REPLAY_CONSTANTS_HASH },
  });
  assert.equal(replayArtifactToResultV1(artifact).result.logHash, result.logHash);
});

test("ranked replay decode rejects mismatched constantsHash (sim/rules drift)", () => {
  const stage = STAGES.datacenter;
  const result = simulate({
    stage, brainA: STRATEGIES.blitz, brainB: STRATEGIES.shipper,
    seed: 1, maxTicks: 120,
  });
  const artifact = createReplayArtifactV1({
    matchId: "ranked-drift",
    mode: "ranked", stage, seed: 1, chars: DEFAULT_CHARS,
    players: [
      { kind: "brain", tier: "system", label: "blitz", config: STRATEGIES.blitz },
      { kind: "brain", tier: "system", label: "shipper", config: STRATEGIES.shipper },
    ],
    actionLog: result.frameLog, result,
    sim: { constantsHash: "00000000" },
  });
  assert.throws(
    () => replayArtifactToResultV1(artifact),
    /constantsHash mismatch/,
  );
  assert.doesNotThrow(
    () => replayArtifactToResultV1(artifact, { allowConstantsMismatch: true }),
  );
});

test("stableReplayJson rejects implicit binary views", () => {
  assert.throws(() => stableReplayJson(new Uint8Array([1, 2, 3])), /binary views/);
});

test("replay decode detects tampered stage, players, and action bytes", () => {
  const stage = STAGES.datacenter;
  const result = simulate({
    stage, brainA: STRATEGIES.blitz, brainB: STRATEGIES.shipper,
    seed: 42, maxTicks: 360,
  });
  const make = () => createReplayArtifactV1({
    matchId: "tamper", mode: "test", stage, seed: 42, chars: DEFAULT_CHARS,
    players: [
      { kind: "brain", tier: "system", label: "blitz", config: STRATEGIES.blitz },
      { kind: "brain", tier: "system", label: "shipper", config: STRATEGIES.shipper },
    ],
    actionLog: result.frameLog, result,
  });

  assert.doesNotThrow(() => replayArtifactToResultV1(make()));

  const a1 = make();
  (a1.initial.stage as { name: string }).name = "tampered";
  assert.throws(() => replayArtifactToResultV1(a1), /stageHash mismatch/);

  const a2 = make();
  (a2.players[0].config as { id: string }).id = "not-blitz";
  assert.throws(() => replayArtifactToResultV1(a2), /playerHashes mismatch/);

  const a3 = make();
  const raw = Buffer.from(a3.actions.bytesBase64, "base64");
  raw[0] ^= 0x01;
  a3.actions.bytesBase64 = raw.toString("base64");
  assert.throws(() => replayArtifactToResultV1(a3), /actions\.hash mismatch|action hash mismatch/);
});

test("replayArtifactWarningsV1 flags missing sim binding", () => {
  const stage = STAGES.datacenter;
  const result = simulate({
    stage, brainA: STRATEGIES.blitz, brainB: STRATEGIES.shipper,
    seed: 7, maxTicks: 120,
  });
  const unbound = createReplayArtifactV1({
    matchId: "warn-unbound", mode: "test", stage, seed: 7, chars: DEFAULT_CHARS,
    players: [
      { kind: "brain", tier: "system", label: "blitz", config: STRATEGIES.blitz },
      { kind: "brain", tier: "system", label: "shipper", config: STRATEGIES.shipper },
    ],
    actionLog: result.frameLog, result,
  });
  assert.deepEqual(replayArtifactWarningsV1(unbound), [
    "replay artifact has no sim sourceHash/constantsHash binding",
  ]);

  const bound = createReplayArtifactV1({
    matchId: "warn-bound", mode: "test", stage, seed: 7, chars: DEFAULT_CHARS,
    players: [
      { kind: "brain", tier: "system", label: "blitz", config: STRATEGIES.blitz },
      { kind: "brain", tier: "system", label: "shipper", config: STRATEGIES.shipper },
    ],
    actionLog: result.frameLog, result,
    sim: { sourceHash: "abc" },
  });
  assert.deepEqual(replayArtifactWarningsV1(bound), []);
});

test("REPLAY_CONSTANTS_HASH is stable across identical calls and versions", async () => {
  const mod = await import("../replay.js");
  assert.equal(typeof mod.REPLAY_CONSTANTS_HASH, "string");
  assert.equal(mod.REPLAY_CONSTANTS_HASH.length, 8);
  const mod2 = await import("../replay.js");
  assert.equal(mod.REPLAY_CONSTANTS_HASH, mod2.REPLAY_CONSTANTS_HASH);
});

test("REPLAY_CONSTANTS_HASH includes BEHAVIOR_VERSION", async () => {
  const { replayHashJson } = await import("../replay.js");
  const { STEP, STATS } = await import("../constants.js");
  const v1 = replayHashJson({ STEP, STATS, BEHAVIOR_VERSION: 1 });
  const v2 = replayHashJson({ STEP, STATS, BEHAVIOR_VERSION: 2 });
  assert.notEqual(v1, v2, "bumping BEHAVIOR_VERSION must change the constants hash");
});

test("REPLAY_CONSTANTS_HASH includes nested STATS fields", async () => {
  const { replayHashJson } = await import("../replay.js");
  const { STATS, STEP, GRAVITY, GOAL_DWELL_S } = await import("../constants.js");
  const withCurrent = replayHashJson({
    STEP, GRAVITY, STATS, GOAL_DWELL_S,
  });
  const withTweakedSwipe = replayHashJson({
    STEP, GRAVITY,
    STATS: { ...STATS, swipeTime: STATS.swipeTime + 0.001 },
    GOAL_DWELL_S,
  });
  assert.notEqual(withCurrent, withTweakedSwipe,
    "changing STATS.swipeTime must bump the constants hash");
  const withTweakedSword = replayHashJson({
    STEP, GRAVITY,
    STATS: { ...STATS, sword: STATS.sword + 1 },
    GOAL_DWELL_S,
  });
  assert.notEqual(withCurrent, withTweakedSword,
    "changing STATS.sword must bump the constants hash");
});

test("verifyReplayIntegrityV1 recomputes action hash from bytes (tamper without decode)", () => {
  const stage = STAGES.datacenter;
  const result = simulate({
    stage, brainA: STRATEGIES.blitz, brainB: STRATEGIES.shipper,
    seed: 201, maxTicks: 240,
  });
  const artifact = createReplayArtifactV1({
    matchId: "byte-tamper", mode: "test", stage, seed: 201, chars: DEFAULT_CHARS,
    players: [
      { kind: "brain", tier: "system", label: "blitz", config: STRATEGIES.blitz },
      { kind: "brain", tier: "system", label: "shipper", config: STRATEGIES.shipper },
    ],
    actionLog: result.frameLog, result,
  });
  const raw = Buffer.from(artifact.actions.bytesBase64, "base64");
  raw[0] ^= 0x01;
  artifact.actions.bytesBase64 = raw.toString("base64");
  assert.throws(() => verifyReplayIntegrityV1(artifact), /actions\.hash mismatch vs bytes/);
});

test("verifyReplayIntegrityV1 is idempotent on a fresh artifact", () => {
  const stage = STAGES.datacenter;
  const result = simulate({
    stage, brainA: STRATEGIES.blitz, brainB: STRATEGIES.shipper,
    seed: 99, maxTicks: 240,
  });
  const artifact = createReplayArtifactV1({
    matchId: "verify", mode: "test", stage, seed: 99, chars: DEFAULT_CHARS,
    players: [
      { kind: "brain", tier: "system", label: "blitz", config: STRATEGIES.blitz },
      { kind: "brain", tier: "system", label: "shipper", config: STRATEGIES.shipper },
    ],
    actionLog: result.frameLog, result,
  });
  assert.doesNotThrow(() => verifyReplayIntegrityV1(artifact));
  assert.doesNotThrow(() => verifyReplayIntegrityV1(artifact));
});
