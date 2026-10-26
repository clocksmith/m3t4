import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomizeWeapons } from '../lib/random-weapons.js';
const roster=JSON.parse(fs.readFileSync(new URL('../content/roster-catalog.v1.json',import.meta.url),'utf8'));
const weapons=body=>(roster.weapons[body]??[]).filter(w=>w.available).map(w=>w.id);

test('seeded loadouts preserve bodies, use available weapons and repeat exactly',()=>{
  const pair=roster.bodies.map(body=>({body,weapon:weapons(body)[0]}));
  const original=structuredClone(pair);
  const first=randomizeWeapons(pair,weapons,12345);
  assert.deepEqual(first,randomizeWeapons(pair,weapons,12345));
  assert.deepEqual(pair,original);
  for(let side=0;side<pair.length;side++){
    assert.equal(first[side].body,pair[side].body);
    assert.ok(weapons(first[side].body).includes(first[side].weapon));
    const choices=new Set(Array.from({length:100},(_,seed)=>randomizeWeapons(pair,weapons,seed)[side].weapon));
    assert.deepEqual(choices,new Set(weapons(pair[side].body)));
  }
});
