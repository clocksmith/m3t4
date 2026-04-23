export interface RgbaTileParams {
  sourceId: string;
  width: number;
  height: number;
  rgbaBase64: string;
}

export interface TileRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  height: number;
}

export interface TileAnalysis {
  blank: boolean;
  activePixels: number;
  totalPixels: number;
  activeCoverageQ: number;
  meanLumaQ: number;
  contrastQ: number;
  saturationQ: number;
  edgeDensityQ: number;
  entropyQ: number;
  symmetryQ: number;
  textStrokeQ: number;
  flatnessQ: number;
  warmRatioQ: number;
  coolRatioQ: number;
  purpleDensityQ: number;
  pinkDensityQ: number;
  darkDensityQ: number;
  granularityQ: number;
  fringeAlphaQ: number;
  edgeTouchMask: number;
  alphaRect: TileRect;
  dominantColors: string[];
  quantizedColorCount: number;
}

const MAX_DIM = 96;
const MAX_PIXELS = MAX_DIM * MAX_DIM;
const ACTIVE_ALPHA = 24;
const LUMA_BINS = 16;

export function normalizeRgbaTileParams(params: Partial<RgbaTileParams>): RgbaTileParams {
  const sourceId = normalizeString(params.sourceId ?? "tile", "sourceId", 1, 120);
  const width = asInt(params.width, "width");
  const height = asInt(params.height, "height");
  if (width < 1 || width > MAX_DIM) throw new Error(`width must be 1..${MAX_DIM}`);
  if (height < 1 || height > MAX_DIM) throw new Error(`height must be 1..${MAX_DIM}`);
  if (width * height > MAX_PIXELS) throw new Error(`tile area must be <= ${MAX_PIXELS} pixels`);
  const rgbaBase64 = normalizeString(params.rgbaBase64, "rgbaBase64", 1, 200_000);
  const bytes = decodeRgbaBase64({ sourceId, width, height, rgbaBase64 });
  if (bytes.length !== width * height * 4) throw new Error("rgbaBase64 byte length mismatch");
  return { sourceId, width, height, rgbaBase64 };
}

export function decodeRgbaBase64(params: RgbaTileParams): Uint8Array {
  const bytes = Buffer.from(params.rgbaBase64, "base64");
  if (bytes.length !== params.width * params.height * 4) {
    throw new Error("rgbaBase64 must decode to width*height*4 bytes");
  }
  return new Uint8Array(bytes);
}

export function analyzeRgbaTile(bytes: Uint8Array, width: number, height: number): TileAnalysis {
  if (bytes.length !== width * height * 4) throw new Error("rgba byte length mismatch");
  const totalPixels = width * height;
  const lumaHist = new Array<number>(LUMA_BINS).fill(0);
  const colorCounts = new Map<number, number>();
  const activeMask = new Uint8Array(totalPixels);
  const lumaValues = new Uint8Array(totalPixels);
  let activePixels = 0;
  let lumaSum = 0;
  let lumaSqSum = 0;
  let satSum = 0;
  let warmPixels = 0;
  let coolPixels = 0;
  let purplePixels = 0;
  let pinkPixels = 0;
  let darkPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let edgeTouchMask = 0;
  let fringeAlphaSum = 0;
  let fringeAlphaCount = 0;

  for (let i = 0; i < totalPixels; i++) {
    const o = i * 4;
    const r = bytes[o];
    const g = bytes[o + 1];
    const b = bytes[o + 2];
    const a = bytes[o + 3];
    const x = i % width;
    const y = Math.floor(i / width);
    const luma = rgbLuma(r, g, b);
    lumaValues[i] = luma;
    const active = a >= ACTIVE_ALPHA ? 1 : 0;
    activeMask[i] = active;
    if (!active) continue;
    activePixels++;
    lumaSum += luma;
    lumaSqSum += luma * luma;
    lumaHist[Math.min(LUMA_BINS - 1, Math.floor((luma / 256) * LUMA_BINS))]++;
    satSum += channelRange(r, g, b);
    if (isWarmPixel(r, g, b)) warmPixels++;
    if (isCoolPixel(r, g, b)) coolPixels++;
    if (isPurplePixel(r, g, b)) purplePixels++;
    if (isPinkPixel(r, g, b)) pinkPixels++;
    if (luma < 90) darkPixels++;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (x === 0) edgeTouchMask |= 8;
    if (x === width - 1) edgeTouchMask |= 2;
    if (y === 0) edgeTouchMask |= 1;
    if (y === height - 1) edgeTouchMask |= 4;
    if ((x === 0 || x === width - 1 || y === 0 || y === height - 1) && a > 0 && a < 255) {
      fringeAlphaSum += a;
      fringeAlphaCount++;
    }
    const color = quantizeColor12(r, g, b);
    colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
  }

  if (activePixels === 0) {
    return {
      blank: true,
      activePixels: 0,
      totalPixels,
      activeCoverageQ: 0,
      meanLumaQ: 0,
      contrastQ: 0,
      saturationQ: 0,
      edgeDensityQ: 0,
      entropyQ: 0,
      symmetryQ: 0,
      textStrokeQ: 0,
      flatnessQ: 1000,
      warmRatioQ: 0,
      coolRatioQ: 0,
      purpleDensityQ: 0,
      pinkDensityQ: 0,
      darkDensityQ: 0,
      granularityQ: 0,
      fringeAlphaQ: 0,
      edgeTouchMask: 0,
      alphaRect: { x0: 0, y0: 0, x1: 0, y1: 0, width: 0, height: 0 },
      dominantColors: [],
      quantizedColorCount: 0,
    };
  }

  let edgeSum = 0;
  let edgeCount = 0;
  let textTransitions = 0;
  let granularSum = 0;
  let granularCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!activeMask[i]) continue;
      const center = lumaValues[i];
      if (x + 1 < width && activeMask[i + 1]) {
        const diff = Math.abs(center - lumaValues[i + 1]);
        edgeSum += diff;
        edgeCount++;
        if (diff >= 120) textTransitions++;
      }
      if (y + 1 < height && activeMask[i + width]) {
        const diff = Math.abs(center - lumaValues[i + width]);
        edgeSum += diff;
        edgeCount++;
        if (diff >= 120) textTransitions++;
      }
      if (x > 0 && x + 1 < width && y > 0 && y + 1 < height) {
        const left = lumaValues[i - 1];
        const right = lumaValues[i + 1];
        const up = lumaValues[i - width];
        const down = lumaValues[i + width];
        granularSum += Math.abs(left - right) + Math.abs(up - down);
        granularCount += 2;
      }
    }
  }

  let symmetryDiff = 0;
  let symmetryCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < Math.floor(width / 2); x++) {
      const i = y * width + x;
      const j = y * width + (width - 1 - x);
      if (!activeMask[i] && !activeMask[j]) continue;
      symmetryCount++;
      const alphaPenalty = Math.abs((activeMask[i] ? 255 : 0) - (activeMask[j] ? 255 : 0));
      const lumaPenalty = Math.abs(lumaValues[i] - lumaValues[j]);
      symmetryDiff += alphaPenalty + lumaPenalty;
    }
  }

  const meanLuma = lumaSum / activePixels;
  const variance = Math.max(0, lumaSqSum / activePixels - meanLuma * meanLuma);
  const contrastQ = qUnit(Math.sqrt(variance) / 128);
  const saturationQ = qUnit(satSum / (activePixels * 255));
  const edgeDensityQ = qUnit(edgeCount > 0 ? edgeSum / (edgeCount * 255) : 0);
  const entropyQ = qUnit(entropyFromHistogram(lumaHist, activePixels) / Math.log2(LUMA_BINS));
  const symmetryQ = clampQ(1000 - Math.round((symmetryDiff / Math.max(1, symmetryCount * 510)) * 1000));
  const flatnessQ = clampQ(1000 - Math.round((entropyQ * 0.65) + (edgeDensityQ * 0.35)));
  const textStrokeQ = qUnit(textTransitions / Math.max(1, activePixels));
  const alphaRect = {
    x0: minX,
    y0: minY,
    x1: maxX + 1,
    y1: maxY + 1,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
  return {
    blank: false,
    activePixels,
    totalPixels,
    activeCoverageQ: qUnit(activePixels / totalPixels),
    meanLumaQ: qUnit(meanLuma / 255),
    contrastQ,
    saturationQ,
    edgeDensityQ,
    entropyQ,
    symmetryQ,
    textStrokeQ,
    flatnessQ,
    warmRatioQ: qUnit(warmPixels / activePixels),
    coolRatioQ: qUnit(coolPixels / activePixels),
    purpleDensityQ: qUnit(purplePixels / activePixels),
    pinkDensityQ: qUnit(pinkPixels / activePixels),
    darkDensityQ: qUnit(darkPixels / activePixels),
    granularityQ: qUnit(granularCount > 0 ? granularSum / (granularCount * 255) : 0),
    fringeAlphaQ: fringeAlphaCount > 0 ? qUnit(fringeAlphaSum / (fringeAlphaCount * 255)) : 0,
    edgeTouchMask,
    alphaRect,
    dominantColors: dominantColorList(colorCounts, 4),
    quantizedColorCount: colorCounts.size,
  };
}

export function qUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clampQ(Math.round(value * 1000));
}

export function clampQ(value: number): number {
  return Math.max(0, Math.min(1000, Math.round(value)));
}

export function normalizeString(value: unknown, label: string, min: number, max: number): string {
  const text = String(value ?? "").trim();
  if (text.length < min || text.length > max) {
    throw new Error(`${label} must be ${min}..${max} chars`);
  }
  return text;
}

export function asInt(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? "0"), 10);
  if (!Number.isSafeInteger(n) || n < 0 || n > 2 ** 31 - 1) {
    throw new Error(`invalid ${label}`);
  }
  return n;
}

function rgbLuma(r: number, g: number, b: number): number {
  return Math.round((r * 77 + g * 150 + b * 29) / 256);
}

function channelRange(r: number, g: number, b: number): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function entropyFromHistogram(hist: number[], total: number): number {
  if (total <= 0) return 0;
  let entropy = 0;
  for (const count of hist) {
    if (!count) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function quantizeColor12(r: number, g: number, b: number): number {
  return ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
}

function dominantColorList(colorCounts: Map<number, number>, limit: number): string[] {
  return [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([color]) => {
      const r = ((color >> 8) & 0xf) * 17;
      const g = ((color >> 4) & 0xf) * 17;
      const b = (color & 0xf) * 17;
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    });
}

function isWarmPixel(r: number, g: number, b: number): boolean {
  return r > 96 && r >= g + 12 && g >= b - 8;
}

function isCoolPixel(r: number, g: number, b: number): boolean {
  return b > 96 && b >= r + 12 && b >= g + 8;
}

function isPurplePixel(r: number, g: number, b: number): boolean {
  return r > 70 && b > 70 && g < Math.min(r, b) - 10;
}

function isPinkPixel(r: number, g: number, b: number): boolean {
  return r > 120 && b > 80 && g < r - 12;
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}
