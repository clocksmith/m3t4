import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readRgbaPng} from './png-rgba.mjs';
import {bodyFramePlacement} from '../render/fighter-art.js';
import catalog from '../content/roster-catalog.v1.json' with {type:'json'};
const animations=[['idle',4],['run',6],['jump',2],['fall',2],['wallSlide',2],['dive',2],['swing',6],['hit',3],['ko',4],['carry',2],['taunt',4],['victory',4]];
for(const[body,pack]of[['jensen','silicon_sovereign'],['elon','orbital_showman']])test(`${body} legacy fallback retains 41 distinct poses; current portraits and weapons remain complete`,()=>{
 const image=readRgbaPng(new URL(`../assets/chars/${body}/${pack}/sprite.png`,import.meta.url));assert.deepEqual([image.width,image.height],[384,768]);const hashes=new Set();let count=0;
 for(let row=0;row<12;row++)for(let col=0;col<6;col++){
  const expected=col<animations[row][1],rgba=[];let opaque=0;
  for(let y=0;y<64;y++)for(let x=0;x<64;x++){
   const offset=((row*64+y)*384+col*64+x)*4,a=image.pixels[offset+3];rgba.push(...image.pixels.subarray(offset,offset+4));
   if(a>=128)opaque++;
   if(x===0||x===63||y===0||y===63)assert.equal(a,0,`${row}:${col}: no clipped limbs on cell cuts`);
   if(!expected)assert.equal(a,0,'unused runtime cells are transparent');
  }
  if(expected){assert.ok(opaque>500,`${row}:${col}: complete pose, not a fragment`);hashes.add(createHash('sha256').update(Buffer.from(rgba)).digest('hex'));count++;const p=bodyFramePlacement(body,animations[row][0],col,{grounded:true});assert.equal(p.sourceFrame,col,'no substituted idle or repeated frame');assert.deepEqual([p.rootX,p.footY,p.sourceFacing],[32,62,1]);}
 }
 assert.equal(count,41);assert.equal(hashes.size,41,'all requested animation poses authored');
 const portrait=readRgbaPng(new URL(`../assets/chars/${body}/${pack}/portraits/sheet.png`,import.meta.url));assert.equal(portrait.width,portrait.height);assert.equal(portrait.width%2,0,'four equal portrait cells');const size=portrait.width/2;for(let cell=0;cell<4;cell++){let opaque=0;for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(portrait.alpha(cell%2*size+x,Math.floor(cell/2)*size+y)>=128)opaque++;assert.ok(opaque>size*size*.1,'complete portrait/full-body cell');}
 assert.equal(catalog.weapons[body].length,4);assert.ok(catalog.weapons[body].every(w=>w.available));
});
