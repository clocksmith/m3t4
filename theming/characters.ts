// Character kits. Visual identity only. All fighters share physics
// (see arena/sim/constants.ts STATS) and all fighters share the same hitbox.
// Weapons are a separate, orthogonal list (see ./weapons.ts) — a character
// does not own its weapon at the schema level; loadouts pair them at match
// time.

import type { SpriteSheet, TextureRef } from "./assets.js";

export interface CharacterKit {
  id: string;
  name: string;          // in-game display name (parody)
  label: string;         // parody company affiliation
  archetype: string;     // design role description
  colors: {
    primary: string;     // main fighter color (UI, HP bar, damage numbers)
    trim: string;        // light accent
    shadow: string;      // dark outline
  };
  voice: {
    victory: string;
    defeat: string;
    taunt?: string;
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
const emptySprite = (): SpriteSheet => ({
  url: "",
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
    name: "Sama",
    label: "OpenAL",
    archetype: "the optimist",
    colors: { primary: "#6ee7b7", trim: "#d1fae5", shadow: "#047857" },
    voice: {
      victory: "shipping is a feature.",
      defeat:  "we're just getting started.",
    },
    sprite: emptySprite(),
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
    name: "Darrius",
    label: "Anthropos",
    archetype: "the steward",
    colors: { primary: "#fb923c", trim: "#fed7aa", shadow: "#9a3412" },
    voice: {
      victory: "this aligns with our values.",
      defeat:  "we should consider the implications.",
    },
    sprite: emptySprite(),
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
    name: "Demis",
    label: "DeepThought",
    archetype: "the grandmaster",
    colors: { primary: "#60a5fa", trim: "#dbeafe", shadow: "#1e3a8a" },
    voice: {
      victory: "as anticipated in move twelve.",
      defeat:  "the tree was insufficiently deep.",
    },
    sprite: emptySprite(),
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
    name: "Mark",
    label: "Metabrain",
    archetype: "the bruiser",
    colors: { primary: "#c084fc", trim: "#ede9fe", shadow: "#5b21b6" },
    voice: {
      victory: "the metaverse prevails.",
      defeat:  "we need to connect more people.",
    },
    sprite: emptySprite(),
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
