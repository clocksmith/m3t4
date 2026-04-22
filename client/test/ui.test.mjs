import test from "node:test";
import assert from "node:assert/strict";

import { escapeHtml } from "../ui/html.js";
import { actionClass, buttonHtml, linkButtonHtml } from "../ui/actions.js";
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
  assert.match(button, />&lt;ship&gt;<\/button>/);

  const link = linkButtonHtml({ href: "#spectate", variant: "danger", text: "watch live" });
  assert.match(link, /^<a/);
  assert.match(link, /href="#spectate"/);
  assert.match(link, /class="ui-button is-danger"/);
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
  assert.match(card, /context-card x/);
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
