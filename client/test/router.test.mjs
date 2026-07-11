import test from "node:test";
import assert from "node:assert/strict";

import { createPathRouter } from "../router.js";

function installWindow(pathname = "/") {
  globalThis.window = {
    location: { pathname, search: "" },
    history: {
      replaceState(_state, _title, url) {
        const next = new URL(url, "https://m3t4.ai");
        window.location.pathname = next.pathname;
        window.location.search = next.search;
      },
    },
  };
}

function createHarness({ pathname = "/", loaders = {}, preserveSameRoutes = [] } = {}) {
  installWindow(pathname);
  const events = [];
  const appEl = { innerHTML: "" };
  const mode = (name) => ({
    mount() { events.push(`mount:${name}`); },
    unmount() { events.push(`unmount:${name}`); },
  });
  const router = createPathRouter({
    appEl,
    navLinks: [],
    statusEl: null,
    modes: { intro: mode("intro") },
    modeLoaders: loaders,
    defaultMode: "intro",
    preserveSameRoutes,
  });
  return { appEl, events, mode, router };
}

test("landing render does not load route modules or remount on feature refresh", async () => {
  let loads = 0;
  const harness = createHarness({
    loaders: {
      about: async () => {
        loads++;
        return harness.mode("about");
      },
    },
  });

  await harness.router.render();
  await harness.router.refreshRoutes();

  assert.equal(loads, 0);
  assert.deepEqual(harness.events, ["mount:intro"]);
});

test("direct routes load only their requested mode", async () => {
  const loads = [];
  const harness = createHarness({ pathname: "/about" });
  harness.router = createPathRouter({
    appEl: harness.appEl,
    navLinks: [],
    statusEl: null,
    modes: {
      intro: {
        mount() { harness.events.push("mount:intro"); },
        unmount() { harness.events.push("unmount:intro"); },
      },
    },
    modeLoaders: {
      about: async () => {
        loads.push("about");
        return harness.mode("about");
      },
      tune: async () => {
        loads.push("tune");
        return harness.mode("tune");
      },
    },
    defaultMode: "intro",
  });

  await harness.router.render();

  assert.deepEqual(loads, ["about"]);
  assert.deepEqual(harness.events, ["mount:about"]);
});

test("a stale route load cannot replace a newer navigation", async () => {
  let resolveAbout;
  const harness = createHarness({ pathname: "/about" });
  harness.router = createPathRouter({
    appEl: harness.appEl,
    navLinks: [],
    statusEl: null,
    modes: {
      intro: {
        mount() { harness.events.push("mount:intro"); },
        unmount() { harness.events.push("unmount:intro"); },
      },
    },
    modeLoaders: {
      about: () => new Promise((resolve) => { resolveAbout = resolve; }),
    },
    defaultMode: "intro",
  });

  const staleRender = harness.router.render();
  await Promise.resolve();
  window.location.pathname = "/";
  const currentRender = harness.router.render();
  resolveAbout(harness.mode("about"));
  await Promise.all([staleRender, currentRender]);

  assert.deepEqual(harness.events, ["mount:intro"]);
});
