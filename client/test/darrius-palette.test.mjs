import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readRgbaPng } from './png-rgba.mjs';

// The legacy body remains a palette-only fallback. Its silhouette, frame
// positions and transparent edges must stay byte-for-byte intact. The current
// portrait is now an imagegen redraw; its shared 2x2 framing is tested by
// portrait-scale.test.mjs instead of pinning the retired portrait's alpha hash.
test('Darrius legacy body retains original atlas alpha and dimensions', () => {
  for (const [path,w,h,hash] of [
    ['sprite.png',384,768,'0dad5fb7f45e13b855fcf87aa3eb7b319b4d0107bad3805e2631c7185242912d'],
  ]) {
    const png = readRgbaPng(new URL(`../assets/chars/darrius/legal_department_midnight/${path}`,import.meta.url));
    assert.deepEqual([png.width,png.height],[w,h]);
    const alpha = Buffer.from(png.pixels.filter((_,i)=>i%4===3));
    assert.equal(createHash('sha256').update(alpha).digest('hex'),hash,path);
    for(let i=0;i<png.pixels.length;i+=4)if(!png.pixels[i+3])assert.deepEqual([...png.pixels.subarray(i,i+3)],[0,0,0],'transparent matte remains unchanged');
  }
});
