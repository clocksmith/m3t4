import assert from "node:assert/strict";
import test from "node:test";
import { STRATEGIES } from "@m3t4/sim";
import { summarizeWatchlistMatch, watchlistTagsForSlot } from "../watchlist.js";

test("watchlist tags named preset slots", () => {
  const tags = watchlistTagsForSlot({ name: "unicorn", config: STRATEGIES.unicorn });
  assert.ok(tags.some((t) => t.kind === "preset" && t.tag === "preset:unicorn"));
});

test("watchlist tags known v9 generalist archetype", () => {
  const tags = watchlistTagsForSlot({
    name: "player-build",
    config: {
      id: "custom",
      attributes: {
        burnRate: 0.32,
        moat: 87,
        shipRate: 0.33,
        foresight: 0.1225,
        pivotSpeed: 0.22,
        leverage: -0.74,
        networking: 0.39,
        spite: -0.28,
        greed: 0.53,
        pacing: 0.39,
        cunning: 0.05,
        hallucination: 0,
      },
    },
  });
  assert.ok(tags.some((t) => t.kind === "archetype" && t.tag === "v9-full-disruptor-generalist"));
});

test("watchlist summary marks draw and tags without changing result semantics", () => {
  const summary = summarizeWatchlistMatch({
    winner: -1,
    finalScore: [1, 1],
    finalRounds: [0, 0],
    ticks: 100,
    logHash: "x",
    seed: 1,
    frameLog: new Uint8Array(),
  }, { a: [{ kind: "preset", tag: "preset:shipper" }], b: [] });

  assert.equal(summary.quality.draw, true);
  assert.equal(summary.tags.a[0].tag, "preset:shipper");
});
