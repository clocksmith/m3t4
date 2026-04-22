import assert from "node:assert/strict";
import test from "node:test";
import { nativeToUI, uiToNative, USER_KNOBS } from "../budget.js";
import { applyHallucinationNoise, applyMicroAttributeDrift } from "../simulate.js";
import { DEFAULT_PARAMS, type Params } from "../types.js";

function midParams(overrides: Partial<Params> = {}): Params {
  const params: Params = { ...DEFAULT_PARAMS };
  for (const k of USER_KNOBS) params[k] = uiToNative(k, 50);
  return { ...params, hallucination: 0, ...overrides };
}

function uiDeltas(before: Params, after: Params): number[] {
  return USER_KNOBS.map((k) => Math.abs(nativeToUI(k, after[k]) - nativeToUI(k, before[k])));
}

test("micro attribute drift is always active at zero hallucination", () => {
  const base = midParams();
  const drifted = applyHallucinationNoise(base, 0, 0, 0x5eed);
  assert.notDeepEqual(drifted, base);
  assert.equal(drifted.hallucination, 0);
});

test("micro attribute drift is capped to thirty-two total UI points", () => {
  const base = midParams();
  const drifted = applyMicroAttributeDrift(base, 37, 1, 0x5eed);
  const deltas = uiDeltas(base, drifted);
  const changed = deltas.filter((delta) => delta > 1e-9);
  const total = deltas.reduce((sum, delta) => sum + delta, 0);

  assert.equal(changed.length, 8);
  assert.ok(changed.every((delta) => delta <= 4 + 1e-9));
  assert.ok(total <= 32 + 1e-9);
});

test("micro attribute drift is stable inside one drift window", () => {
  const base = midParams();
  assert.deepEqual(
    applyMicroAttributeDrift(base, 120, 0, 0x5eed),
    applyMicroAttributeDrift(base, 239, 0, 0x5eed),
  );
});
