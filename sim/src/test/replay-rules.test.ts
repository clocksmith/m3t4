import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { STEP } from "../constants.js";
import { DEFAULT_CHARS, simulate } from "../simulate.js";
import { createReplayArtifactV1, framesFromActionLog, replayArtifactToResultV1, replayRulesVersion, REPLAY_CONSTANTS_HASH } from "../replay.js";
import { STAGES, stageForRules } from "../stage.js";
import { STRATEGIES } from "../strategies.js";
import type { TraceFrame } from "../simulate.js";

const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const samples: Array<{ file: string; behaviorVersion: number; frameHash: string }> = json("../../src/test/fixtures/archive-frame-hashes.json");
const hash = (frames: unknown) => createHash("sha256").update(JSON.stringify(frames)).digest("hex");
function historicalShape(frames: TraceFrame[], behaviorVersion: number) {
  if (behaviorVersion !== 23) return frames;
  const oldFighter = ({ lastAttackStartTick: _attack, respawnT: _respawn, ...fighter }: TraceFrame["p0"]) => fighter;
  return frames.map(frame => ({ ...frame, p0: oldFighter(frame.p0), p1: oldFighter(frame.p1) }));
}

test("archived v23/v24 samples retain historical full-frame hashes and original outcomes", () => {
  for (const sample of samples) {
    const doc = json(`../../../client/matches/${sample.file}`);
    const rulesVersion = replayRulesVersion(doc.sim);
    const out = framesFromActionLog({ stage: stageForRules(doc.stageId, rulesVersion)!, rulesVersion,
      seed: doc.seed, chars: doc.chars, actionLog: Buffer.from(doc.actionLog, "base64"), maxTicks: doc.result.ticks });
    assert.equal(out.ok, true, sample.file);
    const { seed: _seed, ...expected } = doc.result;
    assert.deepEqual(out.result, expected, sample.file);
    assert.equal(hash(historicalShape(out.frames, sample.behaviorVersion)), sample.frameHash, sample.file);
  }
});

test("sealed v25 action log preserves its full frames under explicit legacy rules", () => {
  const doc = json("../../src/test/fixtures/v25-replay.json");
  const rulesVersion = replayRulesVersion(doc.sim);
  const stage = stageForRules(doc.stageId, rulesVersion)!;
  const actions = Buffer.from(doc.actionLog, "base64");
  const out = framesFromActionLog({ stage, rulesVersion, seed: doc.seed, chars: doc.chars,
    actionLog: actions, maxTicks: doc.result.ticks });
  assert.equal(out.ok, true);
  const { seed: _seed, ...expected } = doc.result;
  assert.deepEqual(out.result, expected);
  assert.equal(hash(out.frames), doc.frameHash);
  const artifact = createReplayArtifactV1({ matchId: "archived-v25", mode: "ranked", stage, seed: doc.seed,
    chars: doc.chars, actionLog: actions, result: expected, sim: doc.sim,
    players: [{ kind: "brain", label: "blitz" }, { kind: "brain", label: "shipper" }] });
  // Original artifacts predate explicit rulesVersion; their hash still routes correctly.
  delete artifact.sim.rulesVersion;
  assert.deepEqual(replayArtifactToResultV1(artifact).result, expected);
});

test("replay metadata routes known rules and rejects unknown or conflicting physics", () => {
  assert.equal(replayRulesVersion({ behaviorVersion: 23, constantsHash: "9eeceb29" }), 0);
  assert.equal(replayRulesVersion({ behaviorVersion: 24, constantsHash: "7de44c64" }), 1);
  assert.equal(replayRulesVersion({ behaviorVersion: 25, constantsHash: "63332fa3" }), 1);
  assert.equal(replayRulesVersion({ behaviorVersion: 26, constantsHash: "4682ad88" }), 2);
  assert.equal(replayRulesVersion({ constantsHash: REPLAY_CONSTANTS_HASH }), 3);
  assert.throws(() => replayRulesVersion({}), /rules binding/);
  assert.throws(() => replayRulesVersion({ behaviorVersion: 999 }), /rules binding/);
  assert.throws(() => replayRulesVersion({ rulesVersion: 9 }), /rulesVersion/);
  assert.throws(() => replayRulesVersion({ rulesVersion: 2, constantsHash: "9eeceb29" }), /conflicts/);
  assert.throws(() => replayRulesVersion({ rulesVersion: 2, constantsHash: "unknown" }), /constantsHash/);
});

test("all static featured archive matches replay with exact results and zero early log terminations", () => {
  const index = json("../../../client/matches/index.json");
  for (const m of index.matches) {
    const doc = json(`../../../client/matches/${m.matchId}.json`);
    const rulesVersion = replayRulesVersion(doc.sim);
    const stage = stageForRules(doc.stageId, rulesVersion)!;
    const out = framesFromActionLog({
      stage,
      rulesVersion,
      seed: doc.seed,
      chars: doc.chars,
      actionLog: Buffer.from(doc.actionLog, "base64"),
      maxTicks: doc.result.ticks,
    });
    assert.equal(out.ok, true, `match ${m.matchId} replay failed: ${out.reason}`);
    const { seed: _seed, ...expected } = doc.result;
    assert.deepEqual(out.result, expected, `match ${m.matchId} result mismatch`);
  }
});

test("new action logs replay identically including pauses and exact goal progress", () => {
  const stage = STAGES.datacenter;
  const result = simulate({ stage, brainA: STRATEGIES.blitz, brainB: STRATEGIES.shipper, seed: 13579, maxTicks: 7200 });
  const input = { stage, seed: 13579, chars: DEFAULT_CHARS, actionLog: result.frameLog, maxTicks: result.ticks };
  const first = framesFromActionLog(input), again = framesFromActionLog(input);
  assert.equal(first.ok, true);
  assert.deepEqual(first, again);
  const { frameLog: _log, seed: _seed, ...expected } = result;
  assert.deepEqual(first.result, expected);
  assert.ok(first.frames.every(frame => frame.goal.holdRequiredTicks === 120));
  for (const frame of first.frames) {
    assert.ok(Number.isInteger(frame.goal.holdTicks));
    if (frame.token.exists) assert.equal(frame.token.dwellT, frame.goal.holdTicks! * STEP);
  }
});
