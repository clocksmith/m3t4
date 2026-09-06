// Weapon visual kits only. Names and audio live in content/game-copy.v1.json.
// Every weapon obeys shared sim physics; rarity is cosmetic.
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
  sprite: SpriteSheet;     // weapon-only sheet; rendered as a layer above the character
  trail: {
    color: string;         // swing arc trail color
    width: number;         // in pixels at internal resolution
    ttl: number;           // seconds
  };
  hitVFX?: string;         // id into AssetManifest.sprites for impact flash
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
    sprite: emptyWeaponSprite(),
    trail: { color: "#fde68a", width: 3, ttl: 0.12 },
  },
  {
    id: "darrius.common",
    characterId: "darrius",
    rarity: "common",
    status: "playable",
    sprite: emptyWeaponSprite(),
    trail: { color: "#fed7aa", width: 3, ttl: 0.12 },
  },
  {
    id: "demis.common",
    characterId: "demis",
    rarity: "common",
    status: "playable",
    sprite: emptyWeaponSprite(),
    trail: { color: "#dbeafe", width: 3, ttl: 0.12 },
  },
  {
    id: "mark.common",
    characterId: "mark",
    rarity: "common",
    status: "playable",
    sprite: emptyWeaponSprite(),
    trail: { color: "#ede9fe", width: 3, ttl: 0.12 },
  },

  // ---------------- Rares (preview — visible, not playable) ----------------
  { id: "sama.rare",    characterId: "sama",    rarity: "rare",  status: "preview", sprite: emptyWeaponSprite(), trail: { color: "#22d3ee", width: 3, ttl: 0.15 } },
  { id: "darrius.rare", characterId: "darrius", rarity: "rare",  status: "preview", sprite: emptyWeaponSprite(), trail: { color: "#22d3ee", width: 3, ttl: 0.15 } },
  { id: "demis.rare",   characterId: "demis",   rarity: "rare",  status: "preview", sprite: emptyWeaponSprite(), trail: { color: "#22d3ee", width: 3, ttl: 0.15 } },
  { id: "mark.rare",    characterId: "mark",    rarity: "rare",  status: "preview", sprite: emptyWeaponSprite(), trail: { color: "#22d3ee", width: 3, ttl: 0.15 } },

  // ---------------- Epics (preview — visible, not playable) ---------------
  { id: "sama.epic",    characterId: "sama",    rarity: "epic",  status: "preview", sprite: emptyWeaponSprite(), trail: { color: "#a78bfa", width: 4, ttl: 0.18 } },
  { id: "darrius.epic", characterId: "darrius", rarity: "epic",  status: "preview", sprite: emptyWeaponSprite(), trail: { color: "#a78bfa", width: 4, ttl: 0.18 } },
  { id: "demis.epic",   characterId: "demis",   rarity: "epic",  status: "preview", sprite: emptyWeaponSprite(), trail: { color: "#a78bfa", width: 4, ttl: 0.18 } },
  { id: "mark.epic",    characterId: "mark",    rarity: "epic",  status: "preview", sprite: emptyWeaponSprite(), trail: { color: "#a78bfa", width: 4, ttl: 0.18 } },

  // ---------------- Legendaries (preview — visible, not yet available) -------
  { id: "sama.legendary",    characterId: "sama",    rarity: "legendary",  status: "preview", sprite: emptyWeaponSprite(), trail: { color: "#38bdf8", width: 5, ttl: 0.2 } },
  { id: "darrius.legendary", characterId: "darrius", rarity: "legendary",  status: "preview", sprite: emptyWeaponSprite(), trail: { color: "#38bdf8", width: 5, ttl: 0.2 } },
  { id: "demis.legendary",   characterId: "demis",   rarity: "legendary",  status: "preview", sprite: emptyWeaponSprite(), trail: { color: "#38bdf8", width: 5, ttl: 0.2 } },
  { id: "mark.legendary",    characterId: "mark",    rarity: "legendary",  status: "preview", sprite: emptyWeaponSprite(), trail: { color: "#38bdf8", width: 5, ttl: 0.2 } },
];

export const WEAPONS_BY_ID: Record<string, WeaponKit> =
  Object.fromEntries(WEAPON_KITS.map((w) => [w.id, w]));

export const weaponsForCharacter = (characterId: string): WeaponKit[] =>
  WEAPON_KITS.filter((w) => w.characterId === characterId);

export const playableWeapons = (): WeaponKit[] =>
  WEAPON_KITS.filter((w) => w.status === "playable");
