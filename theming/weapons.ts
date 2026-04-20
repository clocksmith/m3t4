// Weapon kits. Visual-only; every weapon obeys the shared STATS physics
// (same reach, same swing arc, same frame timing). Rarity is cosmetic.
//
// Grid: CHARACTERS x { common, rare, epic, legendary }
//   - common:    shipped at launch, owned by all players.
//   - rare:      visible in collection UI (status "preview"), not selectable.
//   - epic:      visible in collection UI (status "preview"), not selectable.
//   - legendary: not authored — no entries. Reserved for future tournament
//                prizes. The rarity value exists on the Rarity union so UI
//                can render a locked slot without breaking on unknown keys.

import type { SpriteSheet, Rarity, AssetStatus } from "./assets.js";

export interface WeaponKit {
  id: string;              // "{characterId}.{rarity}"
  characterId: string;     // owns this weapon line
  rarity: Rarity;
  status: AssetStatus;
  name: string;            // in-game display name (parody)
  sprite: SpriteSheet;     // weapon-only sheet; rendered as a layer above the character
  trail: {
    color: string;         // swing arc trail color
    width: number;         // in pixels at internal resolution
    ttl: number;           // seconds
  };
  hitVFX?: string;         // id into AssetManifest.sprites for impact flash
  sound: string;           // audio bank id
}

// Swing frames are fixed to match STATS.swipeTime (0.1s @ 60fps = 6 frames).
const emptyWeaponSprite = (): SpriteSheet => ({
  url: "",
  frameW: 48,
  frameH: 48,
  anims: {
    hold:  { row: 0, frames: 1, fps: 1,  loop: true  },
    swing: { row: 1, frames: 6, fps: 60, loop: false },
    dive:  { row: 2, frames: 2, fps: 30, loop: false },
  },
});

export const WEAPON_KITS: WeaponKit[] = [
  // ---------------- Commons (launch playable) ----------------
  {
    id: "sama.common",
    characterId: "sama",
    rarity: "common",
    status: "playable",
    name: "Orb Mace",
    sprite: emptyWeaponSprite(),
    trail: { color: "#fde68a", width: 3, ttl: 0.12 },
    sound: "swing.light",
  },
  {
    id: "darrius.common",
    characterId: "darrius",
    rarity: "common",
    status: "playable",
    name: "Policy Club",
    sprite: emptyWeaponSprite(),
    trail: { color: "#fed7aa", width: 3, ttl: 0.12 },
    sound: "swing.paper",
  },
  {
    id: "demis.common",
    characterId: "demis",
    rarity: "common",
    status: "playable",
    name: "Medal Mace",
    sprite: emptyWeaponSprite(),
    trail: { color: "#dbeafe", width: 3, ttl: 0.12 },
    sound: "swing.stone",
  },
  {
    id: "mark.common",
    characterId: "mark",
    rarity: "common",
    status: "playable",
    name: "Nunchuck Club",
    sprite: emptyWeaponSprite(),
    trail: { color: "#ede9fe", width: 3, ttl: 0.12 },
    sound: "swing.plastic",
  },

  // ---------------- Rares (preview — visible, not playable) ----------------
  { id: "sama.rare",    characterId: "sama",    rarity: "rare",  status: "preview", name: "Airdrop Flail",   sprite: emptyWeaponSprite(), trail: { color: "#22d3ee", width: 3, ttl: 0.15 }, sound: "" },
  { id: "darrius.rare", characterId: "darrius", rarity: "rare",  status: "preview", name: "Value Pike",      sprite: emptyWeaponSprite(), trail: { color: "#22d3ee", width: 3, ttl: 0.15 }, sound: "" },
  { id: "demis.rare",   characterId: "demis",   rarity: "rare",  status: "preview", name: "Proof Hammer",     sprite: emptyWeaponSprite(), trail: { color: "#22d3ee", width: 3, ttl: 0.15 }, sound: "" },
  { id: "mark.rare",    characterId: "mark",    rarity: "rare",  status: "preview", name: "Attention Axe",    sprite: emptyWeaponSprite(), trail: { color: "#22d3ee", width: 3, ttl: 0.15 }, sound: "" },

  // ---------------- Epics (preview — visible, not playable) ---------------
  { id: "sama.epic",    characterId: "sama",    rarity: "epic",  status: "preview", name: "Protocol Gavel",   sprite: emptyWeaponSprite(), trail: { color: "#a78bfa", width: 4, ttl: 0.18 }, sound: "" },
  { id: "darrius.epic", characterId: "darrius", rarity: "epic",  status: "preview", name: "Ethics Mace",      sprite: emptyWeaponSprite(), trail: { color: "#a78bfa", width: 4, ttl: 0.18 }, sound: "" },
  { id: "demis.epic",   characterId: "demis",   rarity: "epic",  status: "preview", name: "Paradox Blade",     sprite: emptyWeaponSprite(), trail: { color: "#a78bfa", width: 4, ttl: 0.18 }, sound: "" },
  { id: "mark.epic",    characterId: "mark",    rarity: "epic",  status: "preview", name: "Meta Halberd",      sprite: emptyWeaponSprite(), trail: { color: "#a78bfa", width: 4, ttl: 0.18 }, sound: "" },

  // ---------------- Legendaries (preview — visible, not yet available) -------
  { id: "sama.legendary",    characterId: "sama",    rarity: "legendary",  status: "preview", name: "Orb Greatsword",   sprite: emptyWeaponSprite(), trail: { color: "#f472b6", width: 5, ttl: 0.2 }, sound: "" },
  { id: "darrius.legendary", characterId: "darrius", rarity: "legendary",  status: "preview", name: "Oracle Mace",      sprite: emptyWeaponSprite(), trail: { color: "#f472b6", width: 5, ttl: 0.2 }, sound: "" },
  { id: "demis.legendary",   characterId: "demis",   rarity: "legendary",  status: "preview", name: "Infinity Axe",      sprite: emptyWeaponSprite(), trail: { color: "#f472b6", width: 5, ttl: 0.2 }, sound: "" },
  { id: "mark.legendary",    characterId: "mark",    rarity: "legendary",  status: "preview", name: "Brain Forge Hammer", sprite: emptyWeaponSprite(), trail: { color: "#f472b6", width: 5, ttl: 0.2 }, sound: "" },
];

export const WEAPONS_BY_ID: Record<string, WeaponKit> =
  Object.fromEntries(WEAPON_KITS.map((w) => [w.id, w]));

export const weaponsForCharacter = (characterId: string): WeaponKit[] =>
  WEAPON_KITS.filter((w) => w.characterId === characterId);

export const playableWeapons = (): WeaponKit[] =>
  WEAPON_KITS.filter((w) => w.status === "playable");
