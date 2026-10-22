import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

// Small dependency-free decoder for the repository's non-interlaced RGBA8 atlases.
// Pixel assertions should test the actual art, not a second copy of its metadata.
export function readRgbaPng(path) {
  const file = readFileSync(path);
  if (!file.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Not a PNG');
  let width, height;
  const compressed = [];
  for (let offset = 8; offset < file.length;) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('ascii', offset + 4, offset + 8);
    const data = file.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('Expected non-interlaced RGBA8 PNG');
    }
    if (type === 'IDAT') compressed.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(compressed)), stride = width * 4;
  const pixels = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p-a), pb = Math.abs(p-b), pc = Math.abs(p-c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error('Unsupported PNG row filter');
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, left = x >= 4 ? pixels[i-4] : 0;
      const up = y ? pixels[i-stride] : 0, upperLeft = y && x >= 4 ? pixels[i-stride-4] : 0;
      const predictor = [0, left, up, Math.floor((left+up)/2), paeth(left,up,upperLeft)][filter];
      pixels[i] = (raw[y * (stride+1) + x + 1] + predictor) & 255;
    }
  }
  return { width, height, pixels, alpha: (x,y) => pixels[(y*width+x)*4+3] };
}
