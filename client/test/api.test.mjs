import test from "node:test";
import assert from "node:assert/strict";

import { leaderboardPage, submitSlot } from "../lib/api.js";

test("submitSlot sends config in the config field", async (t) => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ ok: true, slotId: "slot-a" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const config = { attributes: { burnRate: 0.25 } };
  const cosmetics = { body: "sama", weapon: "worldcoin_orb_flail" };
  const result = await submitSlot("token-a", 2, config, "wingus", cosmetics);

  assert.deepEqual(result, { ok: true, slotId: "slot-a" });
  assert.equal(captured.url, "http://localhost:7777/api/ranked/submit");
  assert.equal(captured.init.headers.authorization, "Bearer token-a");
  assert.deepEqual(JSON.parse(captured.init.body), {
    slotIdx: 2,
    config,
    name: "wingus",
    cosmetics,
  });
});

test("leaderboardPage requests a stable offset page", async (t) => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = null;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({
      rows: [{ userId: "two", handle: "two", eloAggregate: 1400 }],
      offset: 25,
      limit: 25,
      total: 26,
      hasMore: false,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const page = await leaderboardPage({ limit: 25, offset: 25 });

  assert.equal(capturedUrl, "http://localhost:7777/api/leaderboard?page=1&limit=25&offset=25");
  assert.equal(page.rows[0].handle, "two");
  assert.equal(page.hasMore, false);
});
