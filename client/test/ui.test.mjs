import test from "node:test";
import assert from "node:assert/strict";

import { escapeHtml } from "../ui/html.js";
import { actionClass, buttonHtml, chipHtml, linkButtonHtml, toggleSwitchHtml } from "../ui/actions.js";
import { navigateTo, routeToPath, routeToUrl } from "../navigate.js";
import { pageHeaderHtml, contextCardHtml } from "../ui/shell.js";
import { statListHtml } from "../ui/stats.js";

test("escapeHtml covers attribute and text contexts", () => {
  assert.equal(
    escapeHtml(`<x a="1">'&`),
    "&lt;x a=&quot;1&quot;&gt;&#39;&amp;",
  );
});

test("action helpers render shared button classes while preserving selectors", () => {
  assert.equal(actionClass({ variant: "primary", className: "slot-submit" }), "ui-button is-primary slot-submit");

  const button = buttonHtml({
    id: "go",
    variant: "danger",
    className: "extra",
    attrs: { "data-slot": 2 },
    text: "<ship>",
  });
  assert.match(button, /^<button/);
  assert.match(button, /type="button"/);
  assert.match(button, /id="go"/);
  assert.match(button, /class="ui-button is-danger extra"/);
  assert.match(button, /data-slot="2"/);
  assert.match(button, /title="&lt;ship&gt;"/);
  assert.match(button, />&lt;ship&gt;<\/button>/);

  const link = linkButtonHtml({ href: "#spectate", variant: "danger", text: "watch live" });
  assert.match(link, /^<a/);
  assert.match(link, /href="#spectate"/);
  assert.match(link, /class="ui-button is-danger"/);
  assert.match(link, /title="watch live"/);
});

test("toggleSwitchHtml renders the shared ui-toggle structure", () => {
  const toggle = toggleSwitchHtml({
    id: "compute-policy-hidden",
    label: "Pause when tab is hidden",
    title: "Stop donating while this tab is backgrounded",
    className: "compute-policy-item",
    checked: true,
  });
  assert.match(toggle, /^<label/);
  assert.match(toggle, /class="ui-toggle compute-policy-item"/);
  assert.match(toggle, /for="compute-policy-hidden"/);
  assert.match(toggle, /title="Stop donating while this tab is backgrounded"/);
  assert.match(toggle, /<input[^>]*type="checkbox"/);
  assert.match(toggle, /<input[^>]*id="compute-policy-hidden"/);
  assert.match(toggle, /<input[^>]*class="ui-toggle-input"/);
  assert.match(toggle, /<input[^>]*checked/);
  assert.match(toggle, /<span class="ui-toggle-track" aria-hidden="true"><span class="ui-toggle-thumb"><\/span><\/span>/);
  assert.match(toggle, /<span class="ui-toggle-label">Pause when tab is hidden<\/span>/);

  const unchecked = toggleSwitchHtml({ id: "t2", label: "off" });
  assert.doesNotMatch(unchecked, /checked/);

  const escaped = toggleSwitchHtml({ id: "t3", label: "<x>" });
  assert.match(escaped, />&lt;x&gt;<\/span>/);
});

test("chipHtml renders the shared ui-chip structure", () => {
  const chip = chipHtml({ variant: "accent", label: "live", title: "active" });
  assert.match(chip, /^<span/);
  assert.match(chip, /class="ui-chip is-accent"/);
  assert.match(chip, /title="active"/);
  assert.match(chip, />live<\/span>/);

  const plain = chipHtml({ label: "idle" });
  assert.match(plain, /class="ui-chip is-default"/);

  const empty = chipHtml({ variant: "", label: "idle" });
  assert.match(empty, /class="ui-chip"/);
  assert.doesNotMatch(empty, /is-/);
});

test("pageHeaderHtml preserves standard page chrome classes", () => {
  const html = pageHeaderHtml({ title: "Live", subtitle: "now", action: "<button>go</button>" });
  assert.match(html, /class="page-header-row"/);
  assert.match(html, /class="page-title"/);
  assert.match(html, />Live</);
  assert.match(html, />now</);
  assert.match(html, /<button>go<\/button>/);
});

test("contextCardHtml and statListHtml render stable shared structures", () => {
  const card = contextCardHtml({ className: "x", kicker: "k", strong: "s", copy: "c" });
  assert.match(card, /context-card context-card--auto x/);
  assert.doesNotMatch(contextCardHtml({ autoHeight: false }), /context-card--auto/);
  assert.match(card, /context-card-kicker/);
  assert.match(card, /context-card-copy/);

  const stats = statListHtml([{ label: "P1", id: "p1", className: "accent" }]);
  assert.match(stats, /class="stat-list"/);
  assert.match(stats, /<dt>P1<\/dt>/);
  assert.match(stats, /id="p1" class="accent">—<\/dd>/);

  const plainStats = statListHtml([{ label: "tick", value: 12 }]);
  assert.match(plainStats, /<dd>12<\/dd>/);
  assert.doesNotMatch(plainStats, /<dd\s+class=""/);
});

test("routeToUrl and navigateTo preserve target search and hash", () => {
  assert.equal(routeToPath("intro"), "/intro");
  assert.equal(routeToUrl("live", { search: "?match=abc", hash: "#proof" }), "/live?match=abc#proof");
  assert.equal(routeToUrl("/", { search: "view=full", hash: "top" }), "/?view=full#top");

  const previousWindow = global.window;
  const previousPopStateEvent = global.PopStateEvent;
  const pushed = [];
  const dispatched = [];

  global.PopStateEvent = class TestPopStateEvent {
    constructor(type) {
      this.type = type;
    }
  };
  global.window = {
    location: { pathname: "/build", search: "?slot=1", hash: "#editor" },
    history: {
      pushState(_state, _title, url) {
        pushed.push(url);
      },
    },
    dispatchEvent(event) {
      dispatched.push(event.type);
    },
  };

  try {
    navigateTo("compute", { search: "?worker=abc", hash: "#status" });
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    if (previousPopStateEvent === undefined) delete global.PopStateEvent;
    else global.PopStateEvent = previousPopStateEvent;
  }

  assert.deepEqual(pushed, ["/compute?worker=abc#status"]);
  assert.deepEqual(dispatched, ["popstate"]);
});
