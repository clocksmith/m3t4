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
  assert.equal(LEGACY_HASH.practice, "tune");
  assert.equal(LEGACY_HASH.rules, "about");
  assert.equal(LEGACY_HASH.spectate, "live");
  assert.equal(LEGACY_HASH.build, "tune");
  assert.equal(LEGACY_HASH.profile, "roster");
  assert.equal(DEFAULT_FEATURES.p2pDuel, false);
  assert.equal(DEFAULT_FEATURES.computeGenomeKmer, false);
  assert.equal(DEFAULT_FEATURES.webgpuRenderer, false);
  assert.equal(DEFAULT_FEATURES.webglRenderer, false);
  assert.equal(featureForRoute("duel"), null);
  assert.equal(featureForRoute("live"), null);
  assert.deepEqual(Object.keys(MODES), ["intro", "tune", "live", "roster", "compute", "rules", "about"]);
});

test("top navigation keeps home on the logo without a start tab", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<a href="\/" class="logo" title="Go home">/);
  assert.doesNotMatch(html, /data-route="intro" data-nav="primary"/);
  assert.doesNotMatch(html, /data-route="roster" data-nav="primary"/);
  assert.doesNotMatch(html, /data-route="compute" data-nav="primary"/);
  assert.match(html, /data-route="duel" data-nav="primary"/);
  assert.doesNotMatch(html, />start<\/a>/);
  assert.doesNotMatch(html, /id="nav-more"/);
  assert.doesNotMatch(html, />more<\/button>/);
});

test("account control replaces the inline whoami link", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(html, /id="account"/);
  assert.doesNotMatch(html, /id="whoami"/);
  assert.match(app, /href="\/roster"/);
  assert.match(app, /href="\/compute"/);
});

test("about copy excludes stale ranked and compute CTA copy", () => {
  const source = fs.readFileSync(new URL("../../content/game-copy.v1.json", import.meta.url), "utf8");
  const clientCopy = fs.readFileSync(new URL("../content/game-copy.v1.json", import.meta.url), "utf8");
  const mode = fs.readFileSync(new URL("../modes/rules.js", import.meta.url), "utf8");
  for (const text of [source, clientCopy]) {
    assert.doesNotMatch(text, /Today, ranked play is server-authoritative/);
    assert.doesNotMatch(text, /Compute controls and public receipt stats live on the Compute page/);
    assert.doesNotMatch(text, /Opt in, set pause policy, and watch accepted receipts accumulate/);
  }
  assert.doesNotMatch(mode, /function computeLinkCardHtml/);
});
