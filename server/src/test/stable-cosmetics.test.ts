import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { STRATEGIES } from "@m3t4/sim";
import { FileStableStore, slotCosmetics } from "../stable.js";

test("file stable stores roster cosmetics and rejects clone bodies", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m3t4-stable-cosmetics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new FileStableStore(path.join(dir, "stable.json"));
  await store.upsertHandle("alice", "alice");

  await store.submitToSlot("alice", 0, STRATEGIES.blitz, "sama-seat", {
    body: "sama",
    weapon: "worldcoin_orb_flail",
  });
  await assert.rejects(
    () => store.submitToSlot("alice", 1, STRATEGIES.shipper, "clone-seat", {
      body: "sama",
      weapon: "backpack_maul",
    }),
    /sama body already used by seat 0/,
  );

  await store.submitToSlot("alice", 1, STRATEGIES.shipper, "demis-seat", {
    body: "demis",
    weapon: "folded_chess_axe",
  });

  const stable = await store.getStable("alice");
  assert.equal(stable?.slots[0]?.cosmetics?.body, "sama");
  assert.equal(stable?.slots[1]?.cosmetics?.weapon, "folded_chess_axe");
});

test("legacy slots receive deterministic non-clone default bodies", () => {
  assert.deepEqual(slotCosmetics(undefined, 0), { body: "sama", weapon: "worldcoin_orb_flail" });
  assert.deepEqual(slotCosmetics(undefined, 1), { body: "darrius", weapon: "rolled_constitution_bat" });
  assert.deepEqual(slotCosmetics(undefined, 2), { body: "demis", weapon: "nobel_medal_flail" });
  assert.deepEqual(slotCosmetics(undefined, 3), { body: "mark", weapon: "sunscreen_bottle_club" });
});
