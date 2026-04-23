import test from "node:test";
import assert from "node:assert/strict";

import { submitSlot } from "../lib/api.js";

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
