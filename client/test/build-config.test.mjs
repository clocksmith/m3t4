import assert from "node:assert/strict";
import test from "node:test";

import {
  configFromState,
  formatConfigJsonV2,
  normalizeBuildConfig,
  parseBuildConfigJson,
  stateFromConfig,
} from "../lib/build-config.js";

test("slider state round-trips through normalized config", () => {
  const state = {
    burnRate: 17,
    moat: 42,
    shipRate: 31,
    foresight: 9,
    pivotSpeed: 28,
    leverage: 55,
    networking: 14,
    spite: 43,
    greed: 33,
    pacing: 21,
    cunning: 19,
    lift: 27,
    parry: 11,
    chase: 15,
    discipline: 15,
  };

  const cfg = normalizeBuildConfig(configFromState(state));
  const roundTrip = normalizeBuildConfig(configFromState(stateFromConfig(cfg)));

  assert.deepEqual(roundTrip, cfg);
});

test("top-level attribute maps normalize to the same config shape", () => {
  const cfg = configFromState({
    burnRate: 20,
    moat: 20,
    shipRate: 20,
    foresight: 20,
    pivotSpeed: 20,
    leverage: 50,
    networking: 20,
    spite: 50,
    greed: 20,
    pacing: 20,
    cunning: 20,
    lift: 20,
    parry: 20,
    chase: 20,
    discipline: 20,
  });

  assert.deepEqual(normalizeBuildConfig(cfg.attributes), normalizeBuildConfig(cfg));
});

test("formatConfigJsonV2 emits slider-space JSON and imports back to native", () => {
  const state = {
    burnRate: 10,
    moat: 9,
    shipRate: 81,
    foresight: 8,
    pivotSpeed: 47,
    leverage: 50,
    networking: 25,
    spite: 50,
    greed: 5,
    pacing: 6,
    cunning: 0,
    lift: 15,
    parry: 0,
    chase: 39,
    discipline: 15,
  };
  const native = normalizeBuildConfig(configFromState(state, { id: "roundtrip" }));
  const exported = JSON.parse(formatConfigJsonV2(native));

  assert.equal(exported.configVersion, 2);
  assert.equal(exported.attributes.moat, 9);
  assert.equal(exported.attributes.foresight, 8);
  assert.equal(exported.attributes.shipRate, 81);
  assert.equal(exported.attributes.leverage, 50);
  assert.equal(exported.attributes.spite, 50);
  assert.equal(exported.attributes.hallucination, 0);

  assert.deepEqual(parseBuildConfigJson(JSON.stringify(exported)), native);
});
