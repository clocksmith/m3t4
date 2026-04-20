import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DERIVED_HALLUCINATION,
  MAX_USER_SPEND,
  USER_BUDGET,
  USER_KNOBS,
  computedHallucinationForSpend,
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
