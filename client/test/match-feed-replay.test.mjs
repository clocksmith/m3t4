import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { framesFromActionLog, stageForMatchDoc } from "../lib/match-feed.js";
const samples = JSON.parse(fs.readFileSync(new URL("../../sim/src/test/fixtures/archive-frame-hashes.json", import.meta.url)));
const doc = sample => JSON.parse(fs.readFileSync(new URL(`../matches/${sample.file}`, import.meta.url)));

test("viewer selects historical stage geometry and validates complete archived outcomes", () => {
  for (const sample of samples) {
    const match = doc(sample), stage = stageForMatchDoc(match), frames = framesFromActionLog(match);
    assert.equal(stage.platforms.some(p => p.solid && p.w === 34), sample.behaviorVersion >= 24);
    assert.equal(frames.at(-1).tick, match.result.ticks);
    assert.deepEqual(frames.at(-1).scoreboard, match.result.finalScore);
  }
});

test("viewer rejects unknown rules, corrupt outcomes and truncated action logs instead of showing a partial replay", () => {
  const match = doc(samples[0]);
  assert.throws(() => framesFromActionLog({ ...match, sim: { constantsHash: "unknown", behaviorVersion: 23 } }), /constantsHash/);
  assert.throws(() => framesFromActionLog({ ...match, result: { ...match.result, winner: -1 } }), /winner mismatch/);
  assert.throws(() => framesFromActionLog({ ...match, actionLog: match.actionLog.slice(0, 40) }), /ended early/);
});
