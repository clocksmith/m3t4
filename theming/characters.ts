// Character visual kits only. Names, labels, archetypes, and voice lines live
// in content/game-copy.v1.json. All fighters share physics and hitboxes.
// Weapons are a separate visual layer (see ./weapons.ts).

import type { SpriteSheet, TextureRef } from "./assets.js";

export interface PortraitCell extends TextureRef { cell: number; cols: 2; frameW: 96; frameH: 96 }

export interface CharacterKit {
  id: string;
  colors: {
    primary: string;     // main fighter color (UI, HP bar, damage numbers)
    trim: string;        // light accent
    shadow: string;      // dark outline
  };
  sprite: SpriteSheet;   // body animations; weapon is rendered as a separate layer
  portraits: {
    neutral: PortraitCell;
    hurt: PortraitCell;
    ko: PortraitCell;
    victory: PortraitCell;
    large: TextureRef;   // character-select full-body art
  };
}

// Native body atlas contract. Runtime integration is in client/render/canvas2d.js.
const bodySprite = (url = ""): SpriteSheet => ({
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

// All portraits share one 192px 2x2 atlas. Victory reuses neutral; full-body is cell3.
const portraitPack = (dir: string): CharacterKit["portraits"] => {
  const cell = (index: number): PortraitCell => ({ url: `${dir}/portraits/sheet.png`, w: 96, h: 96, frameW: 96, frameH: 96, cols: 2, cell: index });
  return { neutral: cell(0), hurt: cell(1), ko: cell(2), victory: cell(0), large: cell(3) };
};

export const CHARACTER_KITS: CharacterKit[] = [
  {
    id: "sama",
    colors: { primary: "#6ee7b7", trim: "#d1fae5", shadow: "#047857" },
    sprite: bodySprite("assets/chars/sama/monastic_infra/sprite.png"),
    portraits: portraitPack("assets/chars/sama/monastic_infra"),
  },
  {
    id: "darrius",
    colors: { primary: "#fb923c", trim: "#fed7aa", shadow: "#9a3412" },
    sprite: bodySprite("assets/chars/darrius/legal_department_midnight/sprite.png"),
    portraits: portraitPack("assets/chars/darrius/legal_department_midnight"),
  },
  {
    id: "demis",
    colors: { primary: "#60a5fa", trim: "#dbeafe", shadow: "#1e3a8a" },
    sprite: bodySprite("assets/chars/demis/chalk_and_static/sprite.png"),
    portraits: portraitPack("assets/chars/demis/chalk_and_static"),
  },
  {
    id: "mark",
    colors: { primary: "#c084fc", trim: "#ede9fe", shadow: "#5b21b6" },
    sprite: bodySprite("assets/chars/mark/wellness_berserker/sprite.png"),
    portraits: portraitPack("assets/chars/mark/wellness_berserker"),
  },
  {
    id: "jensen",
    colors: { primary: "#a3e635", trim: "#ecfccb", shadow: "#365314" },
    sprite: bodySprite("assets/chars/jensen/silicon_sovereign/sprite.png"),
    portraits: portraitPack("assets/chars/jensen/silicon_sovereign"),
  },
  {
    id: "elon",
    colors: { primary: "#22d3ee", trim: "#cffafe", shadow: "#155e75" },
    sprite: bodySprite("assets/chars/elon/orbital_showman/sprite.png"),
    portraits: portraitPack("assets/chars/elon/orbital_showman"),
  },
];

export const CHAR_BY_ID = Object.fromEntries(CHARACTER_KITS.map((c) => [c.id, c]));
