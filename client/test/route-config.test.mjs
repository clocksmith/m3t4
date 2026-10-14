import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { DEFAULT_FEATURES } from "../route-config.js";

test("browser feature and compute flags default to off", () => {
  assert.equal(DEFAULT_FEATURES.p2pDuel, false);
  assert.equal(DEFAULT_FEATURES.computeGenomeKmer, false);
  assert.equal(DEFAULT_FEATURES.webgpuRenderer, false);
  assert.equal(DEFAULT_FEATURES.webglRenderer, false);
});

test("about copy keeps shared compute framed as a separate experiment", () => {
  const source = fs.readFileSync(new URL("../../content/game-copy.v1.json", import.meta.url), "utf8");
  const clientCopy = fs.readFileSync(new URL("../content/game-copy.v1.json", import.meta.url), "utf8");
  for (const text of [source, clientCopy]) {
    assert.doesNotMatch(text, /Today, ranked play is server-authoritative/);
    assert.doesNotMatch(text, /Compute controls and public receipt stats live on the Compute page/);
    assert.doesNotMatch(text, /Opt in, set pause policy, and watch accepted receipts accumulate/);
  }
  assert.match(JSON.parse(source).rules.about.body[2], /Shared compute is a separate experiment/);
});
