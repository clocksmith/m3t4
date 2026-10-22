import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readRgbaPng } from './png-rgba.mjs';

// The palette-only revision must retain the shipped silhouette, frame positions,
// blank cells, and partially transparent edges byte-for-byte. These digests are
// from the pre-recolor atlases, not the new images' metadata.
test('Darrius palette revision preserves original atlas alpha and dimensions', () => {
  for (const [path,w,h,hash] of [
    ['sprite.png',384,768,'0dad5fb7f45e13b855fcf87aa3eb7b319b4d0107bad3805e2631c7185242912d'],
    ['portraits/sheet.png',192,192,'dc3b7cce8f519439e8b97e44a857aa0b5eac81d0fa502ed9c441bf807ab532bd'],
  ]) {
    const png = readRgbaPng(new URL(`../assets/chars/darrius/legal_department_midnight/${path}`,import.meta.url));
    assert.deepEqual([png.width,png.height],[w,h]);
    const alpha = Buffer.from(png.pixels.filter((_,i)=>i%4===3));
    assert.equal(createHash('sha256').update(alpha).digest('hex'),hash,path);
    for(let i=0;i<png.pixels.length;i+=4)if(!png.pixels[i+3])assert.deepEqual([...png.pixels.subarray(i,i+3)],[0,0,0],'transparent matte remains unchanged');
  }
});
