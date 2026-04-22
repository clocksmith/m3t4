import assert from "node:assert/strict";
import test from "node:test";
import {
  HALLUCINATION_PER_UNDERSPEND,
  MAX_DERIVED_HALLUCINATION,
  MAX_USER_SPEND,
  MIN_CLEAN_SPEND,
  USER_BUDGET,
  USER_KNOBS,
  computedHallucinationForSpend,
  nativeToUI,
  uiToNative,
  validateUserSubmission,
} from "../budget.js";
import type { BrainConfig, ParamKey } from "../types.js";
import { PARAM_KEYS } from "../types.js";

function cfgFromUi(values: Partial<Record<ParamKey, number>>, hallucination?: number): BrainConfig {
  const attributes: BrainConfig["attributes"] = {};
  let spent = 0;
  for (const key of PARAM_KEYS) {
    if (key === "hallucination") continue;
    const ui = values[key] ?? 0;
    attributes[key] = uiToNative(key, ui);
    if (USER_KNOBS.includes(key)) spent += ui;
  }
  attributes.hallucination = hallucination ?? computedHallucinationForSpend(spent);
  return { id: "budget-test", attributes };
}

function cfgV2FromUi(values: Partial<Record<ParamKey, number>>, hallucinationUi?: number): BrainConfig {
  const attributes: BrainConfig["attributes"] = {};
  let spent = 0;
  for (const key of USER_KNOBS) {
    const ui = values[key] ?? 0;
    attributes[key] = ui;
    spent += ui;
  }
  const hallucination = computedHallucinationForSpend(spent);
  attributes.hallucination = hallucinationUi ?? nativeToUI("hallucination", hallucination);
  return { id: "budget-test-v2", configVersion: 2, attributes };
}

test("validateUserSubmission accepts configs at the hard budget", () => {
  const cfg = cfgFromUi({
    burnRate: 100,
    moat: 100,
    shipRate: 100,
    foresight: 60,
  });

  const validation = validateUserSubmission(cfg);

  assert.equal(validation.ok, true, validation.errors.join("; "));
  assert.equal(validation.spent, USER_BUDGET);
  assert.equal(validation.hallucination, 0);
  assert.equal(validation.config?.attributes.hallucination, 0);
});

test("validateUserSubmission derives hallucination for deeply under-spent configs", () => {
  const cfg = cfgFromUi({
    burnRate: 20,
    shipRate: 20,
    lift: 20,
    discipline: 30,
  });

  const validation = validateUserSubmission(cfg);

  assert.equal(validation.ok, true, validation.errors.join("; "));
  assert.equal(validation.spent, 90);
  assert.equal(validation.hallucination, (MIN_CLEAN_SPEND - 90) * HALLUCINATION_PER_UNDERSPEND);
  assert.equal(validation.config?.attributes.hallucination, validation.hallucination);
});

test("validateUserSubmission keeps the clean band hallucination-free", () => {
  const cfg = cfgFromUi({
    burnRate: 60,
    shipRate: 60,
    lift: 60,
  });

  const validation = validateUserSubmission(cfg);

  assert.equal(validation.ok, true, validation.errors.join("; "));
  assert.equal(validation.spent, MIN_CLEAN_SPEND);
  assert.equal(validation.hallucination, 0);
});

test("computedHallucinationForSpend ramps under-spend below the clean band", () => {
  assert.equal(computedHallucinationForSpend(MIN_CLEAN_SPEND), 0);
  assert.equal(computedHallucinationForSpend(MIN_CLEAN_SPEND - 1), HALLUCINATION_PER_UNDERSPEND);
  assert.equal(computedHallucinationForSpend(0), MAX_DERIVED_HALLUCINATION);
});

test("validateUserSubmission accepts capped over-budget configs when hallucination matches", () => {
  const cfg = cfgFromUi({
    burnRate: 100,
    moat: 100,
    shipRate: 100,
    foresight: 90,
  });

  const validation = validateUserSubmission(cfg);

  assert.equal(validation.ok, true, validation.errors.join("; "));
  assert.equal(validation.spent, MAX_USER_SPEND);
  assert.equal(validation.hallucination, MAX_DERIVED_HALLUCINATION);
  assert.equal(validation.config?.attributes.hallucination, MAX_DERIVED_HALLUCINATION);
});

test("validateUserSubmission rejects configs beyond the hallucination cap", () => {
  const spent = 400;
  const cfg = cfgFromUi({
    burnRate: 100,
    moat: 100,
    shipRate: 100,
    foresight: 100,
  }, computedHallucinationForSpend(spent));

  const validation = validateUserSubmission(cfg);

  assert.equal(validation.ok, false);
  assert.ok(
    validation.errors.some((error) => error.includes("hallucination cap")),
    `expected a hallucination-cap error, got ${JSON.stringify(validation.errors)}`,
  );
  assert.equal(validation.config, undefined);
});

test("validateUserSubmission rejects nonzero hallucination within budget", () => {
  const cfg = cfgFromUi({
    burnRate: 100,
    moat: 100,
    shipRate: 100,
  }, 10);

  const validation = validateUserSubmission(cfg);

  assert.equal(validation.ok, false);
  assert.ok(
    validation.errors.some((error) => error.includes("hallucination must equal 0")),
    `expected a hallucination mismatch, got ${JSON.stringify(validation.errors)}`,
  );
});

test("validateUserSubmission rejects out-of-range knob values", () => {
  const cfg = cfgFromUi({
    burnRate: 100,
    moat: 100,
    shipRate: 100,
  });
  cfg.attributes.burnRate = 1.5;

  const validation = validateUserSubmission(cfg);

  assert.equal(validation.ok, false);
  assert.ok(
    validation.errors.some((error) => error.includes("burnRate must be within")),
    `expected a range error, got ${JSON.stringify(validation.errors)}`,
  );
  assert.equal(validation.config, undefined);
});

test("validateUserSubmission accepts v2 UI-space configs and normalizes to native", () => {
  const cfg = cfgV2FromUi({
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
    lift: 15,
    chase: 39,
    discipline: 15,
  });

  const validation = validateUserSubmission(cfg);

  assert.equal(validation.ok, true, validation.errors.join("; "));
  assert.equal(validation.spent, USER_BUDGET);
  assert.equal(validation.hallucination, 0);
  assert.equal(validation.config?.configVersion, undefined);
  assert.equal(validation.config?.attributes.moat, 27);
  assert.equal(validation.config?.attributes.foresight, 0.02);
  assert.equal(validation.config?.attributes.leverage, 0);
  assert.equal(validation.config?.attributes.spite, 0);
});

test("validateUserSubmission accepts v2 hallucination as UI-space percent", () => {
  const cfg = cfgV2FromUi({
    burnRate: 100,
    moat: 100,
    shipRate: 100,
    foresight: 90,
  }, 100);

  const validation = validateUserSubmission(cfg);

  assert.equal(validation.ok, true, validation.errors.join("; "));
  assert.equal(validation.spent, MAX_USER_SPEND);
  assert.equal(validation.hallucination, MAX_DERIVED_HALLUCINATION);
  assert.equal(validation.config?.attributes.hallucination, MAX_DERIVED_HALLUCINATION);
});

test("validateUserSubmission rejects v2 values outside UI range", () => {
  const cfg = cfgV2FromUi({
    burnRate: 100,
    moat: 101,
    shipRate: 100,
  });

  const validation = validateUserSubmission(cfg);

  assert.equal(validation.ok, false);
  assert.ok(
    validation.errors.some((error) => error.includes("moat must be within [0, 100] (configVersion 2)")),
    `expected a v2 range error, got ${JSON.stringify(validation.errors)}`,
  );
});
