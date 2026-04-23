import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { STRATEGIES } from "@m3t4/sim";
import { effectiveRateLockedUntil, FileStableStore, nextSlotName, normalizeSlotCosmetics, slotCosmetics } from "../stable.js";

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
  assert.equal(stable?.slots[1]?.cosmetics?.weapon, "nobel_medal_flail");
});

test("legacy slots receive deterministic non-clone default bodies", () => {
  assert.deepEqual(slotCosmetics(undefined, 0), { body: "sama", weapon: "worldcoin_orb_flail" });
  assert.deepEqual(slotCosmetics(undefined, 1), { body: "darrius", weapon: "rolled_constitution_bat" });
  assert.deepEqual(slotCosmetics(undefined, 2), { body: "demis", weapon: "nobel_medal_flail" });
  assert.deepEqual(slotCosmetics(undefined, 3), { body: "mark", weapon: "sunscreen_bottle_club" });
});

test("weapon selection unlocks by slot Elo thresholds", () => {
  assert.deepEqual(
    normalizeSlotCosmetics({ body: "sama", weapon: "backpack_maul" }, 0, undefined, 1000),
    { body: "sama", weapon: "worldcoin_orb_flail" },
  );
  assert.deepEqual(
    normalizeSlotCosmetics({ body: "sama", weapon: "backpack_maul" }, 0, undefined, 1024),
    { body: "sama", weapon: "backpack_maul" },
  );
  assert.deepEqual(
    normalizeSlotCosmetics({ body: "sama", weapon: "gpu_server_blade" }, 0, undefined, 1151),
    { body: "sama", weapon: "worldcoin_orb_flail" },
  );
  assert.deepEqual(
    normalizeSlotCosmetics({ body: "sama", weapon: "gpu_server_blade" }, 0, undefined, 1152),
    { body: "sama", weapon: "gpu_server_blade" },
  );
});

test("generic slot names are replaced with lowercase defaults", () => {
  assert.match(nextSlotName("slot 1", undefined), /^[a-z0-9]+$/);
  assert.match(nextSlotName("slot-4", "seat_2"), /^[a-z0-9]+$/);
  assert.equal(nextSlotName(" WINGUS ", undefined), "wingus");
  assert.equal(nextSlotName(undefined, "DINGUS"), "dingus");
});

test("legacy long edit locks are capped by the current submit cooldown", () => {
  const submittedAt = Date.now() - 60_000;
  assert.equal(effectiveRateLockedUntil({
    submittedAt,
    rateLockedUntil: submittedAt + 900_000,
  }) <= Date.now(), true);
});
