// Stage visual kits. Game-logic layout lives in @m3t4/sim/stage.ts.
// This file declares only backgrounds, palettes, parallax layers, particles,
// and textures. Copy/audio/goal labels live outside theming.

import type { TextureRef, AssetStatus } from "./assets.js";

export interface StageVisual {
  id: string;
  status: AssetStatus;
  palette: {
    skyTop: string;
    skyMid: string;
    skyBottom: string;
    platformFace: string;
    platformEdge: string;
    ambient: string;
  };
  backdropMotif: "server-racks" | "boardroom-table" | "stage-with-crowd";

  // Populated for status: "playable". Empty URLs for preview/hidden entries.
  layers: {
    sky: TextureRef;
    farParallax: TextureRef;
    midParallax: TextureRef;
    nearParallax: TextureRef;
  };
  textures: {
    platform: TextureRef;          // tiling platform surface
    platformEdge: TextureRef;      // platform edge cap
    wall: TextureRef;              // tiling wall-jumpable surface
    floorDetail?: TextureRef;      // optional floor decal
  };
  particles: string[];             // particle ids referenced from AssetManifest
  previewThumb?: TextureRef;       // shown in coming-soon UI for preview stages
}

const emptyTex = (w = 1920, h = 1080, tile = false): TextureRef => ({
  url: "",
  w,
  h,
  ...(tile ? { tile: { x: true, y: false } } : {}),
});

const emptyLayers = () => ({
  sky: emptyTex(),
  farParallax: emptyTex(),
  midParallax: emptyTex(),
  nearParallax: emptyTex(),
});

const emptyTextures = () => ({
  platform: emptyTex(64, 64, true),
  platformEdge: emptyTex(64, 32),
  wall: emptyTex(64, 64, true),
});

export const STAGE_VISUALS: Record<string, StageVisual> = {
  datacenter: {
    id: "datacenter",
    status: "playable",
    palette: {
      skyTop: "#141020",
      skyMid: "#0e1520",
      skyBottom: "#080c14",
      platformFace: "#141c28",
      platformEdge: "#2c2c40",
      ambient: "rgba(255,255,255,0.015)",
    },
    backdropMotif: "server-racks",
    layers: emptyLayers(),
    textures: emptyTextures(),
    particles: ["particle-dust", "particle-spark", "particle-datacenter-packet"],
  },
  boardroom: {
    id: "boardroom",
    status: "preview",
    palette: {
      skyTop: "#1a1220",
      skyMid: "#1c1420",
      skyBottom: "#0a0612",
      platformFace: "#352a22",
      platformEdge: "#6b5642",
      ambient: "rgba(240,220,180,0.02)",
    },
    backdropMotif: "boardroom-table",
    layers: emptyLayers(),
    textures: emptyTextures(),
    particles: [],
    previewThumb: emptyTex(320, 180),
  },
  demoday: {
    id: "demoday",
    status: "preview",
    palette: {
      skyTop: "#1a1030",
      skyMid: "#100820",
      skyBottom: "#06040c",
      platformFace: "#1e1630",
      platformEdge: "#7c3aed",
      ambient: "rgba(168,85,247,0.03)",
    },
    backdropMotif: "stage-with-crowd",
    layers: emptyLayers(),
    textures: emptyTextures(),
    particles: [],
    previewThumb: emptyTex(320, 180),
  },
};

export const playableStages = (): StageVisual[] =>
  Object.values(STAGE_VISUALS).filter((s) => s.status === "playable");
