import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  DEFAULT_FEATURES,
  DEFAULT_ROUTE,
  LEGACY_HASH,
  featureForRoute,
} from "../route-config.js";
import { MODES } from "../routes.js";

test("route config keeps browser feature gates centralized", () => {
  assert.equal(DEFAULT_ROUTE, "intro");
  assert.equal(LEGACY_HASH.start, "");
  assert.equal(LEGACY_HASH.intro, "");
  assert.equal(LEGACY_HASH.practice, "build");
  assert.equal(LEGACY_HASH.rules, "about");
  assert.equal(DEFAULT_FEATURES.p2pDuel, false);
  assert.equal(DEFAULT_FEATURES.computeGenomeKmer, false);
  assert.equal(DEFAULT_FEATURES.webgpuRenderer, false);
  assert.equal(DEFAULT_FEATURES.webglRenderer, false);
  assert.equal(featureForRoute("duel"), "p2pDuel");
  assert.equal(featureForRoute("spectate"), null);
  assert.deepEqual(Object.keys(MODES), ["intro", "build", "spectate", "profile", "compute", "rules", "about"]);
});

test("top navigation keeps the start tab anchored to the intro route", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<a href="\/" data-route="intro" data-nav="primary" title="Return to the start screen">start<\/a>/);
});
