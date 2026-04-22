// Character visual kits only. Names, labels, archetypes, and voice lines live
// in content/game-copy.v1.json. All fighters share physics and hitboxes.
// Weapons are a separate visual layer (see ./weapons.ts).

import type { SpriteSheet, TextureRef } from "./assets.js";

export interface CharacterKit {
  id: string;
  colors: {
    primary: string;     // main fighter color (UI, HP bar, damage numbers)
    trim: string;        // light accent
    shadow: string;      // dark outline
  };
  sprite: SpriteSheet;   // body animations; weapon is rendered as a separate layer
  portraits: {
    neutral: TextureRef;
    hurt: TextureRef;
    ko: TextureRef;
    victory: TextureRef;
    large: TextureRef;   // character-select full-body art
  };
}

// Asset stubs. URLs are empty until art lands; shape is the contract.
const emptySprite = (url = ""): SpriteSheet => ({
  url,
  frameW: 64,
  frameH: 64,
  anims: {
    idle:      { row: 0, frames: 4, fps: 6,  loop: true  },
    run:       { row: 1, frames: 6, fps: 12, loop: true  },
    jump:      { row: 2, frames: 2, fps: 10, loop: false },
    fall:      { row: 3, frames: 2, fps: 10, loop: false },
    wallSlide: { row: 4, frames: 2, fps: 8,  loop: true  },
    dive:      { row: 5, frames: 2, fps: 12, loop: false },
    swing:     { row: 6, frames: 6, fps: 60, loop: false }, // 6 frames == STATS.swipeTime (0.1s)
    hit:       { row: 7, frames: 3, fps: 20, loop: false },
    ko:        { row: 8, frames: 4, fps: 10, loop: false },
    carry:     { row: 9, frames: 2, fps: 4,  loop: true  },
    taunt:     { row: 10, frames: 4, fps: 8, loop: false },
    victory:   { row: 11, frames: 4, fps: 8, loop: true  },
  },
});

const emptyPortrait = (w = 96, h = 96): TextureRef => ({ url: "", w, h });

export const CHARACTER_KITS: CharacterKit[] = [
  {
    id: "sama",
    colors: { primary: "#6ee7b7", trim: "#d1fae5", shadow: "#047857" },
    sprite: emptySprite("assets/chars/sama/monastic_infra/sprite.png"),
    portraits: {
      neutral: emptyPortrait(),
      hurt:    emptyPortrait(),
      ko:      emptyPortrait(),
      victory: emptyPortrait(),
      large:   emptyPortrait(512, 768),
    },
  },
  {
    id: "darrius",
    colors: { primary: "#fb923c", trim: "#fed7aa", shadow: "#9a3412" },
    sprite: emptySprite("assets/chars/darrius/legal_department_midnight/sprite.png"),
    portraits: {
      neutral: emptyPortrait(),
      hurt:    emptyPortrait(),
      ko:      emptyPortrait(),
      victory: emptyPortrait(),
      large:   emptyPortrait(512, 768),
    },
  },
  {
    id: "demis",
    colors: { primary: "#60a5fa", trim: "#dbeafe", shadow: "#1e3a8a" },
    sprite: emptySprite("assets/chars/demis/chalk_and_static/sprite.png"),
    portraits: {
      neutral: emptyPortrait(),
      hurt:    emptyPortrait(),
      ko:      emptyPortrait(),
      victory: emptyPortrait(),
      large:   emptyPortrait(512, 768),
    },
  },
  {
    id: "mark",
    colors: { primary: "#c084fc", trim: "#ede9fe", shadow: "#5b21b6" },
    sprite: emptySprite("assets/chars/mark/wellness_berserker/sprite.png"),
    portraits: {
      neutral: emptyPortrait(),
      hurt:    emptyPortrait(),
      ko:      emptyPortrait(),
      victory: emptyPortrait(),
      large:   emptyPortrait(512, 768),
    },
  },
];

export const CHAR_BY_ID = Object.fromEntries(CHARACTER_KITS.map((c) => [c.id, c]));
