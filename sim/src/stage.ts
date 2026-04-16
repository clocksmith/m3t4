import type { Stage } from "./types.js";

// Three launch stages. Platforms follow the SELF lab default, then
// intentionally divergent alternates to force meta diversity.

export const STAGE_DATACENTER: Stage = {
  id: "datacenter",
  name: "Datacenter",
  platforms: [
    { x: 56, y: 640, w: 1168, h: 80, solid: true },
    { x: 110, y: 524, w: 200, h: 14, solid: false },
    { x: 970, y: 524, w: 200, h: 14, solid: false },
    { x: 470, y: 414, w: 340, h: 14, solid: false },
    { x: 200, y: 304, w: 180, h: 14, solid: false },
    { x: 900, y: 304, w: 180, h: 14, solid: false },
    { x: 540, y: 194, w: 200, h: 14, solid: false },
  ],
  goals: [
    { x: 210, y: 494, sx: 210, sy: 476, label: "USERS" },
    { x: 1070, y: 494, sx: 1070, sy: 476, label: "GPUS" },
    { x: 640, y: 164, sx: 640, sy: 148, label: "INVESTORS" },
  ],
  spawnL: { x: 300, y: 590 },
  spawnR: { x: 980, y: 590 },
};

export const STAGE_BOARDROOM: Stage = {
  id: "boardroom",
  name: "Boardroom",
  platforms: [
    { x: 56, y: 640, w: 1168, h: 80, solid: true },
    { x: 380, y: 480, w: 520, h: 16, solid: false }, // long central table
    { x: 150, y: 340, w: 220, h: 14, solid: false },
    { x: 910, y: 340, w: 220, h: 14, solid: false },
    { x: 540, y: 220, w: 200, h: 14, solid: false },
  ],
  goals: [
    { x: 260, y: 310, sx: 260, sy: 292, label: "USERS" },
    { x: 1020, y: 310, sx: 1020, sy: 292, label: "GPUS" },
    { x: 640, y: 190, sx: 640, sy: 172, label: "INVESTORS" },
  ],
  spawnL: { x: 300, y: 590 },
  spawnR: { x: 980, y: 590 },
};

export const STAGE_DEMODAY: Stage = {
  id: "demoday",
  name: "Demo Day",
  platforms: [
    { x: 56, y: 640, w: 1168, h: 80, solid: true },
    { x: 520, y: 540, w: 240, h: 14, solid: false }, // narrow central stage
    { x: 100, y: 420, w: 180, h: 14, solid: false },
    { x: 1000, y: 420, w: 180, h: 14, solid: false },
    { x: 380, y: 300, w: 180, h: 14, solid: false },
    { x: 720, y: 300, w: 180, h: 14, solid: false },
    { x: 540, y: 160, w: 200, h: 14, solid: false },
  ],
  goals: [
    { x: 190, y: 390, sx: 190, sy: 372, label: "USERS" },
    { x: 1090, y: 390, sx: 1090, sy: 372, label: "GPUS" },
    { x: 640, y: 130, sx: 640, sy: 112, label: "INVESTORS" },
  ],
  spawnL: { x: 280, y: 590 },
  spawnR: { x: 1000, y: 590 },
};

export const STAGES = {
  datacenter: STAGE_DATACENTER,
  boardroom: STAGE_BOARDROOM,
  demoday: STAGE_DEMODAY,
} as const;

export type StageId = keyof typeof STAGES;
