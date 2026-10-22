import test from 'node:test';
import assert from 'node:assert/strict';
import { drawStageScenery, drawStagePlatform, stageSceneOffsets } from '../render/stage-art.js';
import { STAGES } from '../lib/public-sim.js';

function recordingContext() {
  const calls=[];let depth=0;
  const c={calls,canvas:{width:1280,height:720},save(){depth++;calls.push(['save']);},restore(){assert.ok(depth>0,'balanced canvas state');depth--;calls.push(['restore']);},get depth(){return depth;},
    createLinearGradient(...args){calls.push(['linear',...args]);return {addColorStop(...v){calls.push(['stop',...v]);}};},
    createRadialGradient(...args){calls.push(['radial',...args]);return {addColorStop(...v){calls.push(['stop',...v]);}};},
  };
  for(const name of ['fillRect','beginPath','moveTo','lineTo','closePath','fill','stroke','translate','scale','rect','clip','drawImage'])c[name]=(...args)=>calls.push([name,...args]);
  return new Proxy(c,{set(t,k,v){if(typeof v!=='function')calls.push(['set',k,typeof v==='object'?'gradient':v]);t[k]=v;return true;}});
}
const deepFreeze=o=>{for(const v of Object.values(o))if(v&&typeof v==='object')deepFreeze(v);return Object.freeze(o);};
const frame=deepFreeze({tick:360,p0:{x:210,y:490},p1:{x:980,y:612},goal:{holdTicks:60,holdRequiredTicks:120}});

test('parallax is bounded, deterministic across seeks, finite and frozen by reduced motion',()=>{
  const expected=stageSceneOffsets(frame);
  for(const tick of [0,360,17999,18000,1e8,Infinity,NaN,-50]){
    const offsets=stageSceneOffsets({tick,p0:{x:1e8},p1:{x:1e8}});
    assert.ok(offsets.every(Number.isFinite));assert.equal(offsets[0],0);
    assert.ok(Math.abs(offsets[1])<=7);assert.ok(Math.abs(offsets[2])<=15);
    assert.deepEqual(stageSceneOffsets({tick,p0:{x:1e8}},true),[0,0,0]);
  }
  assert.deepEqual(stageSceneOffsets(frame),expected);
  assert.deepEqual(stageSceneOffsets(),[0,0,0]);
});

test('every stage draws with balanced canvas state without changing geometry or frame',()=>{
  for(const stage of Object.values(STAGES)){
    const frozen=deepFreeze(structuredClone(stage)),before=JSON.stringify({frozen,frame});
    const a=recordingContext(),b=recordingContext();
    drawStageScenery(a,frozen,frame);drawStageScenery(b,frozen,frame);
    assert.equal(a.depth,0,`${stage.id} left a transform or clip active`);
    assert.deepEqual(a.calls,b.calls,`${stage.id} repeat/seek changed draw commands`);
    assert.equal(JSON.stringify({frozen,frame}),before);
    const clips=a.calls.filter(c=>c[0]==='rect');
    assert.deepEqual(clips,stage.platforms.map(p=>['rect',p.x,p.y,p.w,p.h]));
    assert.ok(a.calls.length>200,`${stage.id} scenery was not rendered`);
  }
});

test('platform top highlights and solid material are clipped to exact collision rectangles',()=>{
  for(const id of Object.keys(STAGES))for(const p of STAGES[id].platforms){
    const ctx=recordingContext();drawStagePlatform(ctx,p,id);
    assert.deepEqual(ctx.calls.find(c=>c[0]==='rect'),['rect',p.x,p.y,p.w,p.h]);
    assert.ok(ctx.calls.some(c=>c[0]==='fillRect'&&c[1]===p.x&&c[2]===p.y&&c[3]===p.w&&c[4]===2));
    assert.equal(ctx.depth,0);
  }
});

test('reduced motion keeps the same scene across ticks and fighter movement',()=>{
  for(const stage of Object.values(STAGES)){
    const a=recordingContext(),b=recordingContext();
    drawStageScenery(a,stage,frame,{reducedMotion:true});
    drawStageScenery(b,stage,{tick:9900,p0:{x:1100},p1:{x:1200}},{reducedMotion:true});
    assert.deepEqual(a.calls,b.calls);
  }
});

test('cached layers are shared across canvas contexts and bounded to the three stage kits',async()=>{
  const original=globalThis.document;let created=0;
  globalThis.document={createElement(tag){assert.equal(tag,'canvas');created++;return {getContext(){return recordingContext();}};}};
  try{
    const {drawStageScenery:draw}=await import('../render/stage-art.js?cache-test');
    for(let pass=0;pass<3;pass++)for(const stage of Object.values(STAGES))draw(recordingContext(),stage,frame);
    assert.equal(created,9);
    draw(recordingContext(),{id:'future-stage',platforms:[]},frame);
    assert.equal(created,9,'unknown stages must not grow the cache');
  }finally{globalThis.document=original;}
});
