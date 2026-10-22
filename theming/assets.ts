// Shared asset schema. Referenced by characters, weapons, and stages.
// Runtime arena: 1280x720 logical pixels, integer-scaled canvas backing.
// Native 64px pixel-art fighters over faceted code-native 2.5D scenery.
// Palette discipline is stylistic, not a global bit-depth requirement.

export type Rarity = "common" | "rare" | "epic" | "legendary";

// playable: rendered and selectable in-game.
// preview:  rendered in collection UI as coming-soon, not selectable.
// hidden:   absent from all UI; reserved slot, no assets authored.
export type AssetStatus = "playable" | "preview" | "hidden";

// Multi-frame animated sheet. Frames are laid out one animation per row.
export interface SpriteSheet {
  url: string;
  frameW: number;
  frameH: number;
  anims: Record<string, SpriteAnim>;
}

export interface SpriteAnim {
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
}

// Static image. May tile on one or both axes, or declare 9-slice insets.
export interface TextureRef {
  url: string;
  w: number;
  h: number;
  tile?: { x: boolean; y: boolean };
  slice9?: { top: number; right: number; bottom: number; left: number };
}

// Top-level asset registry. One global manifest per build; stages, UI, and
// shared VFX are indexed by id under the appropriate bucket.
export interface AssetManifest {
  sprites: Record<string, SpriteSheet>;
  textures: Record<string, TextureRef>;
  overlays: Record<string, TextureRef>;
  portraits: Record<string, TextureRef>;
  banners: Record<string, TextureRef>;
  particles: Record<string, TextureRef>;
}
