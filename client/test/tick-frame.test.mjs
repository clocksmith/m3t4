import test from 'node:test';
import assert from 'node:assert/strict';
import { completeTickFrame } from '../render/tick-frame.js';
import { swordSeg } from '../sim/combat-geometry.js';

test('sparse playback never mixes movement, facing, attacks or death from different ticks', () => {
  const previous={tick:30,p0:{x:450,y:612,facing:1,swipeT:0,diveT:0,dead:false},token:{carrier:-1}};
  const next={tick:33,p0:{x:459,y:600,facing:-1,swipeT:.1,diveT:0,dead:true},token:{carrier:1}};
  for(const time of [30,30.1,31,31.9,32.999]) {
    const frame=completeTickFrame(previous,next,time);
    assert.equal(frame,previous);
    assert.deepEqual(swordSeg(frame.p0),swordSeg(previous.p0));
  }
  assert.equal(completeTickFrame(previous,next,33),next);
  assert.equal(completeTickFrame(previous,next,1000),next);
  assert.equal(completeTickFrame(previous,undefined,1000),previous);
  assert.equal(completeTickFrame(previous,next,31),previous,'repeated seek restores the exact earlier sample');
});
