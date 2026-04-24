// Minimal PNG decode/encode. Extracted from tools/postprocess-generation.mjs
// so other tools can share it. Supports 8-bit RGB / RGBA / Grayscale input,
// emits 8-bit RGBA output.

import zlib from "node:zlib";

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let crcTable = null;

export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIG)) throw new Error("input is not a PNG");
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
  if (!ihdr) throw new Error("PNG missing IHDR");
  if (ihdr.bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${ihdr.bitDepth}; expected 8`);
  if (ihdr.compression !== 0 || ihdr.filter !== 0) throw new Error("unsupported PNG compression/filter method");
  if (ihdr.interlace !== 0) throw new Error("interlaced PNGs are not supported");

  const channels = channelsForColorType(ihdr.colorType);
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const rowBytes = ihdr.width * channels;
  const expected = ihdr.height * (rowBytes + 1);
  if (inflated.length < expected) throw new Error("PNG data ended before expected image size");

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

  return { width: ihdr.width, height: ihdr.height, data: toRgba(recon, ihdr.width, ihdr.height, ihdr.colorType) };
}

export function encodePng(width, height, rgba) {
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
    SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function channelsForColorType(colorType) {
  if (colorType === 6) return 4;
  if (colorType === 2) return 3;
  if (colorType === 0) return 1;
  throw new Error(`unsupported PNG color type ${colorType}; expected RGB, RGBA, or grayscale`);
}

function unfilterRow(filter, row, out, prev, bpp) {
  for (let i = 0; i < row.length; i += 1) {
    const x = row[i];
    const left = i >= bpp ? out[i - bpp] : 0;
    const up = prev ? prev[i] : 0;
    const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
    let value;
    if (filter === 0) value = x;
    else if (filter === 1) value = x + left;
    else if (filter === 2) value = x + up;
    else if (filter === 3) value = x + Math.floor((left + up) / 2);
    else if (filter === 4) value = x + paeth(left, up, upLeft);
    else throw new Error(`unsupported PNG row filter ${filter}`);
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
      out[dst] = data[src]; out[dst + 1] = data[src + 1]; out[dst + 2] = data[src + 2]; out[dst + 3] = 255;
    }
    return out;
  }
  if (colorType === 0) {
    for (let src = 0, dst = 0; src < data.length; src += 1, dst += 4) {
      out[dst] = data[src]; out[dst + 1] = data[src]; out[dst + 2] = data[src]; out[dst + 3] = 255;
    }
    return out;
  }
  throw new Error(`unsupported PNG color type ${colorType}`);
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
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
