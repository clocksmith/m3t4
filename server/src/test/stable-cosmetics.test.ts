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
  assert.match(nextSlotName("slot 1", undefined), /^[a-z0-9 -]+$/);
  assert.match(nextSlotName("slot-4", "seat_2"), /^[a-z0-9 -]+$/);
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

test("file store migrates every saved fighter once with exact backup and unchanged identity/build/stats", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m3t4-full-roster-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "stable.json");
  const fixture = JSON.parse(fs.readFileSync(new URL("../../../data/m3t4.json", import.meta.url), "utf8"));
  // A dormant seventh seat must not disappear merely because the UI shows four.
  const owner = Object.keys(fixture.stables)[0];
  const original = fixture.stables[owner].slots[0];
  fixture.stables[owner].slots.push(...Array.from({length:6},(_,i)=>({...structuredClone(original),slotId:`dormant-${i}`,name:`old-${i}`})));
  delete original.fighterNameVersion;
  delete original.aiBehaviorVersion;
  const bytes = JSON.stringify(fixture);
  fs.writeFileSync(file, bytes);
  new FileStableStore(file, {readOnly:true});
  assert.equal(fs.readFileSync(file,"utf8"),bytes);
  assert.deepEqual(fs.readdirSync(dir),["stable.json"]);
  const first = new FileStableStore(file);
  const migrated = (await first.getStable(owner))!;
  for (let i=0;i<fixture.stables[owner].slots.length;i++) {
    const before=fixture.stables[owner].slots[i], after=migrated.slots[i];
    assert.equal(after.slotId,before.slotId);
    assert.deepEqual(after.config,before.config);
    for (const key of ["elo","wins","losses","draws","submittedAt","lastPlayedAt"] as const) assert.equal(after[key],before[key]);
    assert.equal(after.fighterNameVersion,1);
    assert.ok(after.previousNames?.includes(before.name) || before.fighterNameVersion===1);
  }
  const backups=fs.readdirSync(dir).filter(name=>name.includes("before-fighter-migration"));
  assert.equal(backups.length,1);
  assert.equal(fs.readFileSync(path.join(dir,backups[0]),"utf8"),bytes);
  const second = new FileStableStore(file);
  assert.deepEqual((await second.getStable(owner))?.slots,migrated.slots);
  assert.equal(fs.readdirSync(dir).filter(name=>name.includes("before-fighter-migration")).length,1);
});

// New parody bodies use the existing unlock budget and cosmetic-only path.
test("Jensen and Elon accept all authored tiers without bypassing Elo gates", () => {
  for (const [body, weapons] of [
    ["jensen",["compute_bat","heatsink_hammer","silicon_cleaver","rack_greatsword"]],
    ["elon",["coil_bat","orbit_lance","satellite_axe","angular_greatsword"]],
  ] as const) for (const [tier,weapon] of weapons.entries()) {
    const threshold=[0,1024,1152,1280][tier];
    assert.deepEqual(normalizeSlotCosmetics({body,weapon},0,undefined,threshold),{body,weapon});
    if(tier) assert.deepEqual(normalizeSlotCosmetics({body,weapon},0,undefined,threshold-1),{body,weapon:weapons[0]});
  }
});
