import assert from "node:assert/strict";
import test from "node:test";

import {
  configFromState,
  normalizeBuildConfig,
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
