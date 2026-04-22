#!/usr/bin/env node
// Assemble three promoted packed character sheets into the final 384x768
// sprite sheet expected by the visual manifest.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const args = process.argv.slice(2);
let crcTable = null;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const themePath = path.resolve(__dirname, "../theming/visual-theme.v1.json");
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(args.length === 0 ? 1 : 0);
}

const shared = readSharedRules();
const promptCols = shared.promptCols ?? shared.cols;
const promptRows = shared.promptRows ?? 2;
const promptPopulatedCells = shared.promptPopulatedCells ?? promptCols * promptRows - 1;
const runtimeFrames = flattenAnimationFrames(shared);
const promptCount = shared.promptCount ?? Math.ceil(runtimeFrames.length / promptPopulatedCells);
const packNames = Array.from({ length: promptCount }, (_, i) => `pack-${String(i).padStart(2, "0")}.png`);

for (const input of args) {
  const dir = path.resolve(input);
  const packDir = path.basename(dir) === "packed" ? dir : path.join(dir, "packed");
  const outPath = path.basename(dir) === "packed"
    ? path.join(path.dirname(dir), "sprite.png")
    : path.join(dir, "sprite.png");
  assemble(packDir, outPath);
}

function printUsage() {
  process.stdout.write(`Usage:
  node tools/assemble-character-sheet.mjs <promoted-character-dir> [...]

Examples:
  node tools/assemble-character-sheet.mjs client/assets/chars/sama/monastic_infra
  node tools/assemble-character-sheet.mjs client/assets/chars/sama/monastic_infra client/assets/chars/darrius/legal_department_midnight
`);
}

function assemble(packDir, outPath) {
  const packs = packNames.map((name) => {
    const file = path.join(packDir, name);
    if (!fs.existsSync(file)) fail(`missing packed sheet ${file}`);
    return { file, image: decodePng(fs.readFileSync(file)) };
  });

  const expectedPackW = promptCols * shared.cellW;
  const expectedPackH = promptRows * shared.cellH;
  for (const { file, image } of packs) {
    if (image.width !== expectedPackW || image.height !== expectedPackH) {
      fail(`packed sheet size mismatch in ${file}; expected ${expectedPackW}x${expectedPackH}, got ${image.width}x${image.height}`);
    }
  }

  const width = shared.outW;
  const height = shared.outH;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < runtimeFrames.length; i += 1) {
    const frame = runtimeFrames[i];
    const packIndex = Math.floor(i / promptPopulatedCells);
    const cellIndex = i % promptPopulatedCells;
    const pack = packs[packIndex]?.image;
    if (!pack) fail(`missing packed sheet for runtime frame ${i}`);
    copyCell({
      src: pack,
      dst: { width, height, data },
      srcX: (cellIndex % promptCols) * shared.cellW,
      srcY: Math.floor(cellIndex / promptCols) * shared.cellH,
      dstX: frame.destCol * shared.cellW,
      dstY: frame.destRow * shared.cellH,
      cellW: shared.cellW,
      cellH: shared.cellH,
    });
  }
  normalizeTransparentMatte(data);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, encodePng(width, height, data));
  process.stdout.write(`assembled ${path.relative(process.cwd(), outPath)} (${width}x${height})\n`);
}

function readSharedRules() {
  const doc = JSON.parse(fs.readFileSync(themePath, "utf8"));
  const rules = doc.prompts?.characterSheets?._sharedRules;
  if (!rules) fail("missing prompts.characterSheets._sharedRules in visual theme");
  return rules;
}

function flattenAnimationFrames(rules) {
  const frames = [];
  for (const row of rules.animationRows) {
    for (let frame = 0; frame < row.frames; frame += 1) {
      frames.push({ destRow: row.row, destCol: frame });
    }
  }
  return frames;
}

function copyCell({ src, dst, srcX, srcY, dstX, dstY, cellW, cellH }) {
  for (let y = 0; y < cellH; y += 1) {
    const srcOffset = ((srcY + y) * src.width + srcX) * 4;
    const dstOffset = ((dstY + y) * dst.width + dstX) * 4;
    dst.data.set(src.data.subarray(srcOffset, srcOffset + cellW * 4), dstOffset);
  }
}

function fail(message) {
  process.stderr.write(`assemble-character-sheet: ${message}\n`);
  process.exit(1);
}

function normalizeTransparentMatte(data) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 0) continue;
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
  }
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
