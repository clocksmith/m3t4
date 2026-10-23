import test from 'node:test';
import assert from 'node:assert/strict';
import catalog from '../content/roster-catalog.v1.json' with {type:'json'};
import {WEAPON_MOTION,weaponBodyFrame,weaponHandPoints} from '../render/weapon-motion.js';
import {swordSeg} from '../sim/combat-geometry.js';
import {STATS} from '../lib/public-sim.js';

test('heavy anticipation and fast thrusts use distinct body timing without skipping recovery',()=>{
  assert.equal(weaponBodyFrame('heatsink_hammer',.2),0);
  assert.equal(weaponBodyFrame('orbit_lance',.2),2);
  assert.equal(weaponBodyFrame('controller_nunchucks',.2),2);
  for(const body of catalog.bodies)for(const weapon of catalog.weapons[body]){
    assert.ok(WEAPON_MOTION[weapon.id],weapon.id);
    const frames=Array.from({length:101},(_,i)=>weaponBodyFrame(weapon.id,i/100));
    assert.deepEqual([...new Set(frames)],[0,1,2,3,4,5],`${weapon.id} reaches every authored pose`);
    assert.deepEqual(frames,frames.toSorted((a,b)=>a-b));
  }
});

test('primary hand stays at calibrated grip and support hands mirror behind it through the entire attack',()=>{
  for(const weapon of Object.keys(WEAPON_MOTION))for(const swipeT of [0,STATS.swipeTime,.08,.04,.001])for(const diveT of [0,.1]){
    const f={x:450,y:420,swipeT,diveT};
    const right=swordSeg({...f,facing:1}),left=swordSeg({...f,facing:-1});
    const a=weaponHandPoints(weapon,right),b=weaponHandPoints(weapon,left);
    assert.equal(a[0].x,right.bx);assert.equal(a[0].y,right.by);
    for(let i=0;i<a.length;i++){
      assert.ok(Math.abs(a[i].x+b[i].x-2*f.x)<1e-9);
      assert.equal(a[i].y,b[i].y);
      if(i)assert.ok((a[i].x-right.bx)*(right.tx-right.bx)+(a[i].y-right.by)*(right.ty-right.by)<0);
    }
    assert.equal(a.length,WEAPON_MOTION[weapon].support===null?1:2);
  }
});
