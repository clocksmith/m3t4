import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildChallenge,
  canonicalJson,
  evaluateGenome,
  runResidualExpertSearch,
  verifySearchReceipt,
  type ResidualTraceRow
} from "../clockwork.js";

const loadTrace = async (): Promise<ResidualTraceRow[]> => JSON.parse(
  await readFile(path.resolve("clockwork/residual-expert-development.json"), "utf8")
);

test("identity fallback exactly reproduces the frozen baseline", async () => {
  const trace = await loadTrace();
  const evaluation = evaluateGenome({
    enabled: false,
    biasQ15: 0,
    featureWeightsQ15: [0, 0, 0],
    stateWeightQ15: 0,
    stateDecayQ8: 0
  }, trace);
  assert.equal(evaluation.rawLedger.developmentSavingsUnits, 0);
  assert.equal(evaluation.rawLedger.finalStateQ8, 0);
});

test("search reruns are byte-identical and receipts are advisory", async () => {
  const trace = await loadTrace();
  const challenge = buildChallenge(trace);
  const first = runResidualExpertSearch({ challenge, trace });
  const second = runResidualExpertSearch({ challenge, trace });
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(first.receipt.authority, "advisory");
  assert.ok(first.receipt.negativeResults.length > 0);
  assert.ok(first.receipt.paretoFrontier.length > 0);
  assert.deepEqual(verifySearchReceipt({
    challenge,
    trace,
    candidates: first.candidates,
    receipt: first.receipt
  }), { ok: true, reasons: [] });
});

test("receipt verification rejects altered evaluation evidence", async () => {
  const trace = await loadTrace();
  const challenge = buildChallenge(trace);
  const result = runResidualExpertSearch({ challenge, trace });
  result.receipt.evaluations[0].rawLedger.candidateLossUnits += 1;
  const verified = verifySearchReceipt({
    challenge,
    trace,
    candidates: result.candidates,
    receipt: result.receipt
  });
  assert.equal(verified.ok, false);
  assert.ok(verified.reasons.some((reason) => reason.includes("receipt digest mismatch")));
  assert.ok(verified.reasons.some((reason) => reason.includes("evaluation mismatch")));
});
