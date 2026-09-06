import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PRIMARY_KNOBS, renderSliderEditor } from "../lib/slider-editor.js";
import { neutralBuildState, KNOBS, scaledStateFromValues, stateSpent, HARD_CAP, configFromState } from "../lib/build-config.js";
import { disclosureHtml, workshopHeaderHtml } from "../ui/shell.js";
import { canvasSurfaceSize, setupCanvasSurface } from "../render/surface.js";
import { imageState, loadImage } from "../render/image-assets.js";
import { isP2PSupported } from "../lib/p2p-capabilities.js";
import { getComputeClient } from "../lib/compute.js";
import { pickCurrentStaticMatch } from "../lib/match-feed.js";

test("local capability and static feed imports do not require Firebase", () => {
  assert.equal(isP2PSupported(), false);
  const index = { scheduleStartedAt: 100, totalScheduleMs: 40, matches: [
    { matchId: "a", virtualStartedAt: 100, virtualEndsAt: 120 },
    { matchId: "b", virtualStartedAt: 120, virtualEndsAt: 140 },
  ] };
  assert.equal(pickCurrentStaticMatch(index, 125).summary.matchId, "b");
  assert.equal(pickCurrentStaticMatch(index, 145).summary.matchId, "a");
});

test("passive spectators do not load or enable Firebase compute without opt-in", async () => {
  const oldWindow = globalThis.window;
  const oldStorage = globalThis.localStorage;
  globalThis.window = { __M3T4_COMPUTE_FIREBASE__: true, __M3T4_FIREBASE_CONFIG__: {} };
  globalThis.localStorage = { getItem: () => null };
  try {
    const client = getComputeClient();
    client.setMatchPhase("active");
    await client.maybeAutoStart();
    assert.equal(client.loading, null);
    assert.equal(client.actual, null);
    assert.equal(client.snapshot().enabled, false);
    assert.equal(client.snapshot().state, "idle");
  } finally {
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage;
  }
});

test("Workshop shares navigation while preserving tune and roster URLs", () => {
  for (const active of ["tune", "roster"]) {
    const html = workshopHeaderHtml({ active, subtitle: "<test>" });
    assert.match(html, /Workshop/);
    assert.ok(html.includes(`href="/${active}" aria-current="page"`));
    assert.equal((html.match(/aria-current=/g) ?? []).length, 1);
    assert.match(html, /&lt;test&gt;/);
  }
  assert.match(disclosureHtml({ label: "<more>", body: "<p>detail</p>" }), /<summary>&lt;more&gt;<\/summary>/);
});

test("compact editor retains all traits and an expanded Advanced section", () => {
  const state = neutralBuildState();
  const saved = { ...state };
  const container = {
    innerHTML: "",
    querySelector: () => ({ open: true }),
    querySelectorAll: () => [],
  };
  renderSliderEditor(container, state);
  assert.deepEqual(state, saved);
  assert.equal(PRIMARY_KNOBS.length, 4);
  assert.equal((container.innerHTML.match(/data-knob=/g) ?? []).length, KNOBS.length);
  const primary = container.innerHTML.split('<details')[0];
  assert.equal((primary.match(/data-knob=/g) ?? []).length, 4);
  assert.match(container.innerHTML, /knobs-advanced" open/);
  for (const [id] of KNOBS) assert.ok(container.innerHTML.includes(`data-knob="${id}"`));
});

test("point scaling never rounds above the cap and remains deterministic", () => {
  for (let seed = 0; seed < 1000; seed++) {
    const values = Object.fromEntries(KNOBS.map(([id], index) => [id, (seed * 37 + index * 53) % 101]));
    const state = scaledStateFromValues(values, HARD_CAP);
    assert.ok(stateSpent(state) <= HARD_CAP);
    assert.equal(stateSpent(state), Math.min(stateSpent(values), HARD_CAP));
    assert.deepEqual(state, scaledStateFromValues(values, HARD_CAP));
    assert.doesNotThrow(() => configFromState(state));
  }
  assert.equal(stateSpent(scaledStateFromValues(Array(15).fill(0))), 0);
});

test("canvas backing stores use integer pixel-art scaling appropriate to display size", () => {
  assert.deepEqual(canvasSurfaceSize(368, 3), { cssW: 368, cssH: 207, dpr: 1, width: 1280, height: 720 });
  assert.equal(canvasSurfaceSize(1280, 2).dpr, 2);
  assert.equal(canvasSurfaceSize(818, 2).dpr, 1);
  assert.equal(canvasSurfaceSize(1, 2).cssW, 1);
});

test("unchanged canvas resize does not reset the backing store", () => {
  const before = Object.fromEntries(["window", "document", "devicePixelRatio", "ResizeObserver"].map(k => [k, globalThis[k]]));
  let writes = 0;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { documentElement: { clientWidth: 368 } };
  globalThis.devicePixelRatio = 3;
  globalThis.ResizeObserver = undefined;
  const canvas = { parentElement: null, style: {}, get width() { return 1280; }, set width(v) { writes++; }, get height() { return 720; }, set height(v) { writes++; } };
  try {
    const surface = setupCanvasSurface(canvas);
    surface.resize();
    surface.teardown();
    assert.equal(writes, 0);
  } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  }
});

test("image loading is lazy, cached, and falls back once without a retry storm", () => {
  const previousImage = globalThis.Image;
  const images = [];
  globalThis.Image = class { constructor() { images.push(this); } };
  try {
    const state = imageState("layer.webp", "layer.png");
    assert.equal(images.length, 0);
    assert.equal(loadImage(state), null);
    const img = images[0];
    assert.equal(img.src, "layer.webp");
    assert.equal(img.decoding, "async");
    loadImage(state);
    assert.equal(images.length, 1);
    img.onerror();
    assert.equal(img.src, "layer.png");
    assert.equal(state.failed, false);
    img.onload();
    assert.equal(loadImage(state), img);
    const broken = imageState("bad.webp", "bad.png");
    loadImage(broken);
    images[1].onerror();
    images[1].onerror();
    assert.equal(broken.failed, true);
    loadImage(broken);
    assert.equal(images.length, 2);
  } finally { if (previousImage === undefined) delete globalThis.Image; else globalThis.Image = previousImage; }
});

test("all declared stage WebP derivatives and PNG fallbacks exist", () => {
  const renderer = readFileSync(new URL("../render/canvas2d.js", import.meta.url), "utf8");
  const pairs = [...renderer.matchAll(/imageState\("([^"]+\.webp)", "([^"]+\.png)"\)/g)];
  assert.equal(pairs.length, 12);
  for (const [, webp, png] of pairs) {
    assert.ok(readFileSync(new URL(`../${webp}`, import.meta.url)).length > 0);
    assert.ok(readFileSync(new URL(`../${png}`, import.meta.url)).length > 0);
  }
});
