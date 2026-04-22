#!/usr/bin/env node
// Post-process raw image-generator PNGs into client-ready pixel assets.
//
// Default path convention:
//   input:  generations/raw/assets/...
//   output: client/assets/...
//
// The tool accepts proportional oversized output from image generators:
// it center-crops only enough to match the target aspect ratio, then
// nearest-neighbor resizes to the target size and keys the near-#FF00FF
// background to alpha. For inferred sprite grids, it also clears one-pixel
// separator lines at cell boundaries unless disabled.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const rawRoot = path.resolve(repoRoot, "generations/raw");
const clientRoot = path.resolve(repoRoot, "client");
const themePath = path.resolve(repoRoot, "theming/visual-theme.v1.json");
let crcTable = null;

const args = process.argv.slice(2);
const inputArg = args.find((arg) => !arg.startsWith("--"));
if (!inputArg || args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(inputArg ? 0 : 1);
}

const inputPath = path.resolve(inputArg);
const target = parseTarget(arg("--target")) ?? inferTarget(inputPath);
if (!target) {
  fail("could not infer target size; pass --target WIDTHxHEIGHT");
}

const outputPath = arg("--out")
  ? path.resolve(arg("--out"))
  : defaultOutputPath(inputPath);
const keyColor = parseHexColor(arg("--key") ?? "#FF00FF");
const tolerance = parseInteger(arg("--tolerance") ?? "24", "--tolerance");
const edgeConnectedKey = args.includes("--edge-connected-key");
const keepGridLines = args.includes("--keep-grid-lines");
const gridLineRadius = parseInteger(arg("--grid-line-radius") ?? "1", "--grid-line-radius");
const despillKey = args.includes("--despill-key");
const despillPasses = parseInteger(arg("--despill-passes") ?? "2", "--despill-passes");
const scrubKey = args.includes("--scrub-key");

const decoded = decodePng(fs.readFileSync(inputPath));
const crop = cropRect(decoded.width, decoded.height, target.width, target.height);
const resized = resizeNearest(decoded, crop, target.width, target.height);
const keyed = keyToAlpha(resized, keyColor, tolerance, edgeConnectedKey);
const grid = keepGridLines ? null : inferGrid(inputPath);
const clearedUnusedPixels = grid ? clearUnusedCells(resized, grid, keyColor) : 0;
const clearedGridPixels = grid ? clearGridLines(resized, grid, gridLineRadius, keyColor) : 0;
const despilledPixels = despillKey ? despillKeyFringe(resized, despillPasses, keyColor) : 0;
const scrubbedKeyPixels = scrubKey ? scrubKeyArtifacts(resized, keyColor) : 0;
const normalizedTransparentPixels = normalizeTransparentMatte(resized);
const encoded = encodePng(target.width, target.height, resized.data);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, encoded);

const relIn = path.relative(process.cwd(), inputPath);
const relOut = path.relative(process.cwd(), outputPath);
process.stdout.write(`post-processed ${relIn}\n`);
process.stdout.write(`input: ${decoded.width}x${decoded.height}\n`);
process.stdout.write(`crop: x=${crop.x} y=${crop.y} w=${crop.width} h=${crop.height}\n`);
process.stdout.write(`output: ${target.width}x${target.height} -> ${relOut}\n`);
process.stdout.write(`keyed transparent pixels: ${keyed}\n`);
if (grid) process.stdout.write(`cleared unused-cell pixels: ${clearedUnusedPixels}\n`);
if (grid) process.stdout.write(`cleared grid separator pixels: ${clearedGridPixels}\n`);
if (despilledPixels) process.stdout.write(`despilled key-fringe pixels: ${despilledPixels}\n`);
if (scrubbedKeyPixels) process.stdout.write(`scrubbed key-artifact pixels: ${scrubbedKeyPixels}\n`);
if (normalizedTransparentPixels) process.stdout.write(`normalized transparent matte pixels: ${normalizedTransparentPixels}\n`);

function printUsage() {
  process.stdout.write(`Usage:
  node tools/postprocess-generation.mjs <raw-png> [--target 512x128] [--out path] [--key #FF00FF] [--tolerance 24] [--edge-connected-key] [--despill-key] [--despill-passes 2] [--scrub-key] [--keep-grid-lines] [--grid-line-radius 1]

Examples:
  node tools/postprocess-generation.mjs generations/raw/assets/chars/sama/monastic_infra/packed/pack-00.png
  node tools/postprocess-generation.mjs generations/raw/assets/chars/sama/monastic_infra/packed/pack-00.png --target 512x128
`);
}

function arg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function fail(message) {
  process.stderr.write(`postprocess-generation: ${message}\n`);
  process.exit(1);
}

function parseInteger(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail(`${label} must be a non-negative integer`);
  return n;
}

function parseTarget(value) {
  if (!value) return null;
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match) fail("--target must be WIDTHxHEIGHT, e.g. 512x128");
  return { width: Number(match[1]), height: Number(match[2]) };
}

function parseHexColor(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) fail("--key must be a hex RGB color, e.g. #FF00FF");
  const hex = match[1];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function inferTarget(inputPathAbs) {
  const assetPath = assetPathFromInput(inputPathAbs);
  const packedSheet = /\/packed\/pack-(\d+)\.png$/u.exec(assetPath);
  if (packedSheet) {
    const doc = readTheme();
    const shared = doc.prompts?.characterSheets?._sharedRules;
    if (!shared) fail("missing prompts.characterSheets._sharedRules in visual theme");
    return {
      width: (shared.promptCols ?? shared.cols) * shared.cellW,
      height: (shared.promptRows ?? 2) * shared.cellH,
    };
  }

  const rowStrip = /\/row-strips\/rows-(\d+)-(\d+)\.png$/u.exec(assetPath);
  if (rowStrip) {
    const doc = readTheme();
    const shared = doc.prompts?.characterSheets?._sharedRules;
    if (!shared) fail("missing prompts.characterSheets._sharedRules in visual theme");
    const rowStart = Number(rowStrip[1]);
    const rowEnd = Number(rowStrip[2]);
    const rows = rowEnd - rowStart + 1;
    if (rows <= 0) fail(`invalid row-strip range in ${assetPath}`);
    return {
      width: shared.cols * shared.cellW,
      height: rows * shared.cellH,
    };
  }

  return inferExactPromptTarget(assetPath);
}

function inferGrid(inputPathAbs) {
  const assetPath = assetPathFromInput(inputPathAbs);
  const packedSheet = /\/packed\/pack-(\d+)\.png$/u.exec(assetPath);
  if (packedSheet) {
    const doc = readTheme();
    const shared = doc.prompts?.characterSheets?._sharedRules;
    if (!shared) return null;
    const cols = shared.promptCols ?? shared.cols;
    const rows = shared.promptRows ?? 2;
    const populated = shared.promptPopulatedCells ?? cols * rows - 1;
    return {
      cols,
      rows,
      cellW: shared.cellW,
      cellH: shared.cellH,
      frames: Array.from({ length: rows }, (_, row) => {
        const remaining = populated - row * cols;
        return Math.max(0, Math.min(cols, remaining));
      }),
    };
  }

  const rowStrip = /\/row-strips\/rows-(\d+)-(\d+)\.png$/u.exec(assetPath);
  if (!rowStrip) return null;
  const doc = readTheme();
  const shared = doc.prompts?.characterSheets?._sharedRules;
  if (!shared) return null;
  const rowStart = Number(rowStrip[1]);
  const rowEnd = Number(rowStrip[2]);
  const rows = rowEnd - rowStart + 1;
  if (rows <= 0) return null;
  return {
    cols: shared.cols,
    rows,
    cellW: shared.cellW,
    cellH: shared.cellH,
    frames: shared.animationRows
      .slice(rowStart, rowEnd + 1)
      .map((row) => row.frames),
  };
}

function inferExactPromptTarget(assetPath) {
  const doc = readTheme();
  const prompts = doc.prompts ?? {};
  const directGroups = ["stages", "objectives"];
  for (const groupName of directGroups) {
    const found = findDirectGroupTarget(prompts[groupName], assetPath);
    if (found) return found;
  }
  const sharedGroups = ["portraitSheets", "portraitsLarge", "weaponSheetsLaunch", "weaponSheetsAdvanced", "lockedSlot"];
  for (const groupName of sharedGroups) {
    const found = findSharedGroupTarget(prompts[groupName], assetPath);
    if (found) return found;
  }
  return null;
}

function findDirectGroupTarget(group, assetPath) {
  if (!group || typeof group !== "object") return null;
  for (const [key, value] of Object.entries(group)) {
    if (key.startsWith("_") || !value || typeof value !== "object") continue;
    if (value.out === assetPath && value.outW && value.outH) {
      return { width: value.outW, height: value.outH };
    }
  }
  return null;
}

function findSharedGroupTarget(group, assetPath) {
  if (!group || typeof group !== "object") return null;
  const shared = group._sharedRules;
  if (!shared) return null;
  for (const [key, value] of Object.entries(group)) {
    if (key.startsWith("_") || !value || typeof value !== "object") continue;
    if (value.out === assetPath && shared.outW && shared.outH) {
      return { width: shared.outW, height: shared.outH };
    }
  }
  return null;
}

function readTheme() {
  return JSON.parse(fs.readFileSync(themePath, "utf8"));
}

function assetPathFromInput(inputPathAbs) {
  const relativeToRaw = path.relative(rawRoot, inputPathAbs);
  if (!relativeToRaw.startsWith("..") && !path.isAbsolute(relativeToRaw)) {
    return normalizeAssetPath(relativeToRaw);
  }
  const idx = inputPathAbs.indexOf(`${path.sep}assets${path.sep}`);
  if (idx !== -1) return normalizeAssetPath(inputPathAbs.slice(idx + 1));
  return normalizeAssetPath(path.basename(inputPathAbs));
}

function normalizeAssetPath(value) {
  return value.split(path.sep).join("/");
}

function defaultOutputPath(inputPathAbs) {
  const relativeToRaw = path.relative(rawRoot, inputPathAbs);
  if (!relativeToRaw.startsWith("..") && !path.isAbsolute(relativeToRaw)) {
    return path.join(clientRoot, relativeToRaw);
  }
  return path.join(clientRoot, "assets", path.basename(inputPathAbs));
}

function cropRect(sourceW, sourceH, targetW, targetH) {
  const sourceAspect = sourceW / sourceH;
  const targetAspect = targetW / targetH;
  if (Math.abs(sourceAspect - targetAspect) < 0.0001) {
    return { x: 0, y: 0, width: sourceW, height: sourceH };
  }
  if (sourceAspect > targetAspect) {
    const width = Math.max(1, Math.round(sourceH * targetAspect));
    const x = Math.floor((sourceW - width) / 2);
    return { x, y: 0, width, height: sourceH };
  }
  const height = Math.max(1, Math.round(sourceW / targetAspect));
  const y = Math.floor((sourceH - height) / 2);
  return { x: 0, y, width: sourceW, height };
}

function resizeNearest(image, crop, outW, outH) {
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y += 1) {
    const sy = crop.y + clamp(Math.floor(((y + 0.5) * crop.height) / outH), 0, crop.height - 1);
    for (let x = 0; x < outW; x += 1) {
      const sx = crop.x + clamp(Math.floor(((x + 0.5) * crop.width) / outW), 0, crop.width - 1);
      const src = (sy * image.width + sx) * 4;
      const dst = (y * outW + x) * 4;
      out[dst] = image.data[src];
      out[dst + 1] = image.data[src + 1];
      out[dst + 2] = image.data[src + 2];
      out[dst + 3] = image.data[src + 3];
    }
  }
  return { width: outW, height: outH, data: out };
}

function keyToAlpha(image, key, tolerance, edgeConnectedKey) {
  if (edgeConnectedKey) return edgeConnectedKeyToAlpha(image, key, tolerance);
  return globalKeyToAlpha(image.data, key, tolerance);
}

function clearUnusedCells(image, grid, key) {
  const { width, height, data } = image;
  let cleared = 0;
  for (let row = 0; row < grid.rows; row += 1) {
    const frames = grid.frames?.[row] ?? grid.cols;
    for (let col = frames; col < grid.cols; col += 1) {
      const startX = col * grid.cellW;
      const startY = row * grid.cellH;
      for (let y = startY; y < Math.min(startY + grid.cellH, height); y += 1) {
        for (let x = startX; x < Math.min(startX + grid.cellW, width); x += 1) {
          const offset = (y * width + x) * 4;
          if (data[offset + 3] !== 0) cleared += 1;
          makeTransparent(data, offset, key);
        }
      }
    }
  }
  return cleared;
}

function clearGridLines(image, grid, radius, key) {
  const { width, height, data } = image;
  let cleared = 0;
  const clear = (x, y) => {
    if (x <= 0 || y <= 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    if (data[offset + 3] !== 0) cleared += 1;
    makeTransparent(data, offset, key);
  };

  for (let col = 1; col < grid.cols; col += 1) {
    const x = col * grid.cellW;
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let y = 0; y < height; y += 1) clear(x + dx, y);
    }
  }
  for (let row = 1; row < grid.rows; row += 1) {
    const y = row * grid.cellH;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let x = 0; x < width; x += 1) clear(x, y + dy);
    }
  }
  return cleared;
}

function globalKeyToAlpha(data, key, tolerance) {
  let keyed = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (isNearKey(data, i, key, tolerance)) {
      makeTransparent(data, i, key);
      keyed += 1;
    }
  }
  return keyed;
}

function edgeConnectedKeyToAlpha(image, key, tolerance) {
  const { width, height, data } = image;
  const seen = new Uint8Array(width * height);
  const stack = [];
  const pushIfKey = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idx = y * width + x;
    if (seen[idx]) return;
    const px = idx * 4;
    if (!isNearKey(data, px, key, tolerance)) return;
    seen[idx] = 1;
    stack.push(idx);
  };

  for (let x = 0; x < width; x += 1) {
    pushIfKey(x, 0);
    pushIfKey(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    pushIfKey(0, y);
    pushIfKey(width - 1, y);
  }

  let keyed = 0;
  while (stack.length > 0) {
    const idx = stack.pop();
    const x = idx % width;
    const y = Math.floor(idx / width);
    const px = idx * 4;
    makeTransparent(data, px, key);
    keyed += 1;
    pushIfKey(x + 1, y);
    pushIfKey(x - 1, y);
    pushIfKey(x, y + 1);
    pushIfKey(x, y - 1);
  }
  return keyed;
}

function makeTransparent(data, offset, key) {
  // Store a neutral matte under fully-transparent pixels. Keeping the
  // original magenta RGB is technically valid PNG, but it can leak in
  // alpha-unsafe previews or later resampling passes as pink fringe.
  data[offset] = 0;
  data[offset + 1] = 0;
  data[offset + 2] = 0;
  data[offset + 3] = 0;
}

function normalizeTransparentMatte(image) {
  let changed = 0;
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 0) continue;
    if (data[i] || data[i + 1] || data[i + 2]) changed += 1;
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
  }
  return changed;
}

function despillKeyFringe(image, passes, key) {
  const { width, height, data } = image;
  let total = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    const clearOffsets = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        if (data[offset + 3] === 0) continue;
        if (!isMagentaFringe(data, offset)) continue;
        if (!touchesTransparent(data, width, height, x, y)) continue;
        clearOffsets.push(offset);
      }
    }
    if (!clearOffsets.length) break;
    for (const offset of clearOffsets) makeTransparent(data, offset, key);
    total += clearOffsets.length;
  }
  return total;
}

function scrubKeyArtifacts(image, key) {
  const { data } = image;
  let scrubbed = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 0) continue;
    if (!isMagentaFringe(data, offset)) continue;
    makeTransparent(data, offset, key);
    scrubbed += 1;
  }
  return scrubbed;
}

function isMagentaFringe(data, offset) {
  const r = data[offset];
  const g = data[offset + 1];
  const b = data[offset + 2];
  const maxRB = Math.max(r, b);
  return maxRB >= 36
    && Math.abs(r - b) <= 96
    && r >= g + 18
    && b >= g + 18
    && g <= maxRB * 0.68;
}

function touchesTransparent(data, width, height, x, y) {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (data[(ny * width + nx) * 4 + 3] === 0) return true;
    }
  }
  return false;
}

function isNearKey(data, offset, key, tolerance) {
  const dr = data[offset] - key.r;
  const dg = data[offset + 1] - key.g;
  const db = data[offset + 2] - key.b;
  return dr * dr + dg * dg + db * db <= tolerance * tolerance;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function decodePng(buffer) {
  const signature = buffer.subarray(0, 8);
  if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    fail("input is not a PNG");
  }

  let offset = 8;
  let ihdr = null;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (!ihdr) fail("PNG missing IHDR");
  if (ihdr.bitDepth !== 8) fail(`unsupported PNG bit depth ${ihdr.bitDepth}; expected 8`);
  if (ihdr.compression !== 0 || ihdr.filter !== 0) fail("unsupported PNG compression/filter method");
  if (ihdr.interlace !== 0) fail("interlaced PNGs are not supported");

  const channels = channelsForColorType(ihdr.colorType);
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const rowBytes = ihdr.width * channels;
  const expected = ihdr.height * (rowBytes + 1);
  if (inflated.length < expected) fail("PNG data ended before expected image size");

  const recon = new Uint8Array(ihdr.height * rowBytes);
  let inOffset = 0;
  let outOffset = 0;
  for (let y = 0; y < ihdr.height; y += 1) {
    const filter = inflated[inOffset];
    inOffset += 1;
    const row = inflated.subarray(inOffset, inOffset + rowBytes);
    const prev = y === 0 ? null : recon.subarray(outOffset - rowBytes, outOffset);
    unfilterRow(filter, row, recon.subarray(outOffset, outOffset + rowBytes), prev, channels);
    inOffset += rowBytes;
    outOffset += rowBytes;
  }

  return {
    width: ihdr.width,
    height: ihdr.height,
    data: toRgba(recon, ihdr.width, ihdr.height, ihdr.colorType),
  };
}

function channelsForColorType(colorType) {
  if (colorType === 6) return 4;
  if (colorType === 2) return 3;
  if (colorType === 0) return 1;
  fail(`unsupported PNG color type ${colorType}; expected RGB or RGBA`);
}

function unfilterRow(filter, row, out, prev, bpp) {
  for (let i = 0; i < row.length; i += 1) {
    const x = row[i];
    const left = i >= bpp ? out[i - bpp] : 0;
    const up = prev ? prev[i] : 0;
    const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
    let value;
    if (filter === 0) {
      value = x;
    } else if (filter === 1) {
      value = x + left;
    } else if (filter === 2) {
      value = x + up;
    } else if (filter === 3) {
      value = x + Math.floor((left + up) / 2);
    } else if (filter === 4) {
      value = x + paeth(left, up, upLeft);
    } else {
      fail(`unsupported PNG row filter ${filter}`);
    }
    out[i] = value & 0xff;
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function toRgba(data, width, height, colorType) {
  if (colorType === 6) return data;
  const out = new Uint8Array(width * height * 4);
  if (colorType === 2) {
    for (let src = 0, dst = 0; src < data.length; src += 3, dst += 4) {
      out[dst] = data[src];
      out[dst + 1] = data[src + 1];
      out[dst + 2] = data[src + 2];
      out[dst + 3] = 255;
    }
    return out;
  }
  if (colorType === 0) {
    for (let src = 0, dst = 0; src < data.length; src += 1, dst += 4) {
      out[dst] = data[src];
      out[dst + 1] = data[src];
      out[dst + 2] = data[src];
      out[dst + 3] = 255;
    }
    return out;
  }
  fail(`unsupported PNG color type ${colorType}`);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  let src = 0;
  let dst = 0;
  for (let y = 0; y < height; y += 1) {
    raw[dst] = 0;
    dst += 1;
    for (let x = 0; x < width * 4; x += 1) {
      raw[dst] = rgba[src];
      dst += 1;
      src += 1;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
