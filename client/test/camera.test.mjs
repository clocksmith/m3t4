import test from 'node:test';
import assert from 'node:assert/strict';
import { arenaCamera, arenaScreenPoint } from '../render/camera.js';
import { W, H } from '../render/surface.js';

const frame = (p0, p1, extra = {}) => ({p0, p1, ...extra});
const inside = (camera, point) => {
  const p = arenaScreenPoint(camera, point);
  assert.ok(p.x >= -1e-8 && p.x <= W + 1e-8, JSON.stringify(p));
  assert.ok(p.y >= -1e-8 && p.y <= H + 1e-8, JSON.stringify(p));
};

test('normal duel framing increases screen dimensions while preserving relative geometry', () => {
  const a={x:300,y:612}, b={x:980,y:612};
  const camera=arenaCamera(frame(a,b));
  assert.equal(camera.scale,1.25);
  for(const fighter of [a,b]) {
    inside(camera,{x:fighter.x-80,y:fighter.y-96});
    inside(camera,{x:fighter.x+80,y:fighter.y+44});
    const foot=arenaScreenPoint(camera,{x:fighter.x,y:fighter.y+28});
    const head=arenaScreenPoint(camera,{x:fighter.x,y:fighter.y-28});
    assert.equal(foot.y-head.y,70);
  }
});

test('framing pulls back for arena extremes, vertical separation and distant objectives', () => {
  for(const f of [
    frame({x:14,y:612},{x:1266,y:612}),
    frame({x:300,y:40},{x:980,y:680}),
    frame({x:300,y:612},{x:980,y:612},{goal:{exists:true,x:100,y:160},token:{exists:true,carrier:-1,x:1180,y:80}}),
  ]) {
    const camera=arenaCamera(f);
    assert.ok(camera.scale>=1 && camera.scale<1.25);
    for(const point of [f.p0,f.p1,f.goal,f.token].filter(Boolean))inside(camera,point);
    inside(camera,{x:0,y:0}); // At full pullback, the complete arena remains visible.
    inside(camera,{x:W,y:H});
  }
});

test('camera is seek-independent and never changes simulation frames', () => {
  const f=frame({x:300,y:612},{x:980,y:612});
  const before=structuredClone(f), first=arenaCamera(f);
  arenaCamera(frame({x:14,y:50},{x:1266,y:680}));
  assert.deepEqual(arenaCamera(f),first);
  assert.deepEqual(f,before);
  assert.deepEqual(arenaCamera({}),{scale:1,x:0,y:0});
});
