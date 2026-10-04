import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  DEFAULT_FEATURES,
  DEFAULT_ROUTE,
  LEGACY_HASH,
  featureForRoute,
} from "../route-config.js";
import { MODE_LOADERS, MODES, ROUTE_NAMES } from "../routes.js";

test("route config keeps browser feature gates centralized", () => {
  assert.equal(DEFAULT_ROUTE, "tune");
  assert.equal(LEGACY_HASH.start, "");
  assert.equal(LEGACY_HASH.intro, "intro");
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
  assert.deepEqual(Object.keys(MODES), []);
  assert.deepEqual(Object.keys(MODE_LOADERS), ["intro", "tune", "live", "roster", "compute", "rules", "about", "duel"]);
  assert.deepEqual(ROUTE_NAMES, ["intro", "tune", "live", "roster", "compute", "rules", "about", "duel"]);
});

test("historical navigation keeps the arena home on the logo", () => {
  const html = fs.readFileSync(new URL("../history/index.html", import.meta.url), "utf8");
  assert.match(html, /<a href="\/history" class="logo"\s[^>]*>/);
  assert.doesNotMatch(html, /data-route="intro" data-nav="primary"/);
  assert.doesNotMatch(html, /data-route="roster" data-nav="primary"/);
  assert.doesNotMatch(html, /data-route="compute" data-nav="primary"/);
  assert.match(html, /data-route="duel" data-nav="primary"/);
  assert.equal((html.match(/data-nav="primary"/g) ?? []).length, 3);
  assert.match(html, /data-route-group="tune roster"/);
  assert.match(html, /href="\/intro">the world/);
  assert.match(html, /href="\/about">how to play/);
  assert.doesNotMatch(html, />start<\/a>/);
  assert.doesNotMatch(html, /id="nav-more"/);
  assert.doesNotMatch(html, />more<\/button>/);
});

test("account control replaces the inline whoami link", () => {
  const html = fs.readFileSync(new URL("../history/index.html", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(html, /id="account"/);
  assert.doesNotMatch(html, /id="whoami"/);
  assert.match(app, /href="\/roster"/);
  assert.match(app, /href="\/compute"/);
});

test("about copy presents policy search and the shared-compute boundary", () => {
  const source = fs.readFileSync(new URL("../../content/game-copy.v1.json", import.meta.url), "utf8");
  const clientCopy = fs.readFileSync(new URL("../content/game-copy.v1.json", import.meta.url), "utf8");
  const mode = fs.readFileSync(new URL("../modes/rules.js", import.meta.url), "utf8");
  for (const text of [source, clientCopy]) {
    assert.doesNotMatch(text, /Today, ranked play is server-authoritative/);
    assert.doesNotMatch(text, /Compute controls and public receipt stats live on the Compute page/);
    assert.doesNotMatch(text, /Opt in, set pause policy, and watch accepted receipts accumulate/);
  }
  const rules = JSON.parse(source).rules;
  assert.equal(rules.subtitle, "bounded policy search through deterministic matches");
  assert.match(rules.about.body[0], /bounded parameter grid/);
  assert.match(rules.about.body[2], /Shared compute is a separate experiment/);
  assert.deepEqual(rules.about.links[0], {
    label: "Reploid",
    href: "https://replo.id",
    kicker: "shared browser inference",
    note: "Reploid is the peer-to-peer inference substrate.",
    cta: "Open Reploid",
  });
  assert.doesNotMatch(mode, /function computeLinkCardHtml/);
});
