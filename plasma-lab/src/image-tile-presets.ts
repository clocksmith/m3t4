export interface TileSamplePreset {
  id: string;
  label: string;
  sourceId: string;
  width: number;
  height: number;
  rgbaBase64: string;
}

export const IMAGE_TILE_SAMPLE_PRESETS: TileSamplePreset[] = [
  buildUiChipPreset(),
  buildSpritePreset(),
  buildTerrainPreset(),
  buildFxPreset(),
];

export const MICROSCOPY_TILE_SAMPLE_PRESETS: TileSamplePreset[] = [
  buildMicroscopyDensePreset(),
  buildMicroscopySparsePreset(),
  buildMicroscopyArtifactPreset(),
];

export function resolveTileSamplePreset(
  id: string,
  domain: "image" | "microscopy",
): TileSamplePreset | null {
  const source = domain === "microscopy" ? MICROSCOPY_TILE_SAMPLE_PRESETS : IMAGE_TILE_SAMPLE_PRESETS;
  return source.find((entry) => entry.id === id) ?? null;
}

function buildUiChipPreset(): TileSamplePreset {
  const image = createImage(32, 32, [16, 18, 24, 255]);
  fillRect(image, 2, 3, 28, 26, [30, 36, 48, 255]);
  strokeRect(image, 2, 3, 28, 26, [92, 148, 255, 255]);
  fillRect(image, 6, 9, 18, 3, [245, 245, 248, 255]);
  fillRect(image, 6, 15, 12, 3, [208, 214, 224, 255]);
  fillRect(image, 20, 15, 4, 3, [208, 214, 224, 255]);
  return preset("ui-chip-sample", "UI chip sample", "sample-ui-chip", image);
}

function buildSpritePreset(): TileSamplePreset {
  const image = createImage(32, 32, [0, 0, 0, 0]);
  fillRect(image, 12, 4, 8, 6, [244, 193, 168, 255]);
  fillRect(image, 11, 10, 10, 9, [96, 158, 255, 255]);
  fillRect(image, 9, 12, 2, 7, [244, 193, 168, 255]);
  fillRect(image, 21, 12, 2, 7, [244, 193, 168, 255]);
  fillRect(image, 12, 19, 3, 8, [38, 56, 92, 255]);
  fillRect(image, 17, 19, 3, 8, [38, 56, 92, 255]);
  fillRect(image, 10, 3, 12, 2, [54, 32, 24, 255]);
  return preset("sprite-sample", "Sprite sample", "sample-sprite", image);
}

function buildTerrainPreset(): TileSamplePreset {
  const image = createImage(32, 32, [72, 96, 66, 255]);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const idx = (y * 32 + x) * 4;
      const green = 88 + ((x * 11 + y * 7) % 46);
      const red = 58 + ((x * 5 + y * 3) % 28);
      const blue = 44 + ((x * 13 + y * 9) % 24);
      image[idx] = red;
      image[idx + 1] = green;
      image[idx + 2] = blue;
      image[idx + 3] = 255;
    }
  }
  fillRect(image, 0, 21, 32, 11, [96, 72, 48, 255]);
  return preset("terrain-sample", "Terrain sample", "sample-terrain", image);
}

function buildFxPreset(): TileSamplePreset {
  const image = createImage(32, 32, [0, 0, 0, 0]);
  for (let i = 0; i < 8; i++) {
    fillRect(image, 14 - i, 15, 4 + i * 2, 2, [188, 80, 255, Math.max(32, 220 - i * 20)]);
    fillRect(image, 15, 14 - i, 2, 4 + i * 2, [64, 196, 255, Math.max(32, 220 - i * 18)]);
  }
  fillRect(image, 12, 12, 8, 8, [255, 248, 255, 220]);
  return preset("fx-burst-sample", "FX burst sample", "sample-fx-burst", image);
}

function buildMicroscopyDensePreset(): TileSamplePreset {
  const image = createImage(32, 32, [248, 218, 226, 255]);
  sprinkleCells(image, 28, 5);
  return preset("microscopy-dense-sample", "Microscopy dense sample", "sample-microscopy-dense", image);
}

function buildMicroscopySparsePreset(): TileSamplePreset {
  const image = createImage(32, 32, [250, 224, 232, 255]);
  sprinkleCells(image, 10, 9);
  return preset("microscopy-sparse-sample", "Microscopy sparse sample", "sample-microscopy-sparse", image);
}

function buildMicroscopyArtifactPreset(): TileSamplePreset {
  const image = createImage(32, 32, [246, 214, 224, 255]);
  sprinkleCells(image, 22, 7);
  for (let y = 0; y < 32; y++) {
    setPixel(image, 28, y, [255, 255, 240, 255], 32);
    if (y > 6 && y < 27) setPixel(image, 27, y, [255, 245, 228, 255], 24);
  }
  return preset("microscopy-artifact-sample", "Microscopy artifact sample", "sample-microscopy-artifact", image);
}

function preset(id: string, label: string, sourceId: string, rgba: Uint8Array): TileSamplePreset {
  return {
    id,
    label,
    sourceId,
    width: 32,
    height: 32,
    rgbaBase64: Buffer.from(rgba).toString("base64"),
  };
}

function createImage(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out.set(rgba, i * 4);
  }
  return out;
}

function fillRect(
  image: Uint8Array,
  x0: number,
  y0: number,
  width: number,
  height: number,
  rgba: [number, number, number, number],
): void {
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) {
      setPixel(image, x, y, rgba);
    }
  }
}

function strokeRect(
  image: Uint8Array,
  x0: number,
  y0: number,
  width: number,
  height: number,
  rgba: [number, number, number, number],
): void {
  for (let x = x0; x < x0 + width; x++) {
    setPixel(image, x, y0, rgba);
    setPixel(image, x, y0 + height - 1, rgba);
  }
  for (let y = y0; y < y0 + height; y++) {
    setPixel(image, x0, y, rgba);
    setPixel(image, x0 + width - 1, y, rgba);
  }
}

function sprinkleCells(image: Uint8Array, count: number, seed: number): void {
  let state = seed >>> 0;
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const cx = 3 + (state % 26);
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const cy = 3 + (state % 26);
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const radius = 1 + (state % 2);
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > radius * radius + 1) continue;
        setPixel(image, x, y, [118, 66, 144, 255]);
      }
    }
  }
}

function setPixel(
  image: Uint8Array,
  x: number,
  y: number,
  rgba: [number, number, number, number],
  blendAlpha = 255,
): void {
  if (x < 0 || y < 0 || x >= 32 || y >= 32) return;
  const i = (y * 32 + x) * 4;
  if (blendAlpha >= 255) {
    image.set(rgba, i);
    return;
  }
  const alpha = blendAlpha / 255;
  image[i] = Math.round(image[i] * (1 - alpha) + rgba[0] * alpha);
  image[i + 1] = Math.round(image[i + 1] * (1 - alpha) + rgba[1] * alpha);
  image[i + 2] = Math.round(image[i + 2] * (1 - alpha) + rgba[2] * alpha);
  image[i + 3] = Math.max(image[i + 3], rgba[3]);
}
