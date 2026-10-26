import test from 'node:test';
import assert from 'node:assert/strict';
import { arenaCamera, arenaScreenPoint, createArenaCamera } from '../render/camera.js';
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
  assert.equal(camera.scale,1.15);
  for(const fighter of [a,b]) {
    inside(camera,{x:fighter.x-80,y:fighter.y-96});
    inside(camera,{x:fighter.x+80,y:fighter.y+44});
    const foot=arenaScreenPoint(camera,{x:fighter.x,y:fighter.y+28});
    const head=arenaScreenPoint(camera,{x:fighter.x,y:fighter.y-28});
    assert.ok(Math.abs(foot.y-head.y-64.4)<1e-6);
  }
});

test('framing pulls back for arena extremes, vertical separation and distant objectives', () => {
  for(const f of [
    frame({x:14,y:612},{x:1266,y:612}),
    frame({x:300,y:40},{x:980,y:680}),
    frame({x:300,y:612},{x:980,y:612},{goal:{exists:true,x:100,y:160},token:{exists:true,carrier:-1,x:1180,y:80}}),
  ]) {
    const camera=arenaCamera(f);
    assert.ok(camera.scale>=1 && camera.scale<1.15);
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


test('camera eases position and zoom after a sudden framing change', () => {
  const camera = createArenaCamera();
  const close = frame({x:400,y:612}, {x:800,y:612});
  const wide = frame({x:14,y:80}, {x:1266,y:680});
  const first = camera.update(close, null, 0);
  const next = camera.update(wide, null, 1000/60);
  assert.ok(next.scale < first.scale && next.scale > arenaCamera(wide).scale);
  assert.ok(Math.abs(next.scale - first.scale) < 0.01);
  const target = arenaCamera(wide);
  let settled;
  for (let i=2; i<=180; i++) settled=camera.update(wide, null, i*1000/60);
  assert.ok(Math.abs(settled.scale-target.scale)<1e-6);
  assert.ok(Math.abs(settled.x-target.x)<1e-6);
  assert.ok(Math.abs(settled.y-target.y)<1e-6);
});

test('camera response is consistent at 30, 60 and 144 frames per second', () => {
  const end=[];
  for (const fps of [30,60,144]) {
    const camera=createArenaCamera();
    camera.update(frame({x:14,y:80},{x:1266,y:680}),null,0);
    for(let i=1;i<=fps;i++) {
      const view=camera.update(frame({x:350,y:612},{x:700,y:612}),null,i*1000/fps);
      if(i===fps)end.push(view);
    }
  }
  for(const value of end.slice(1))for(const key of ['scale','x','y'])assert.ok(Math.abs(value[key]-end[0][key])<1e-6);
});

test('execution closeups ease in and out while the arena covers the screen', () => {
  const camera=createArenaCamera();const f=frame({x:300,y:612},{x:980,y:612});
  camera.update(f,null,0);
  const impact={x:100,y:100,strength:1};
  const first=camera.update(f,impact,1000/60);
  assert.ok(first.scale>1.15 && first.scale<1.3);
  let peak;
  for(let i=2;i<=18;i++)peak=camera.update(f,impact,i*1000/60);
  assert.ok(peak.scale>1.8 && peak.scale<=1.9);
  for(let i=19;i<=90;i++) {
    const view=camera.update(f,null,i*1000/60);
    assert.ok(view.x<=1e-8 && view.y<=1e-8);
    assert.ok(W*view.scale+view.x>=W-1e-8 && H*view.scale+view.y>=H-1e-8);
    if(i===90)assert.ok(Math.abs(view.scale-1.15)<1e-5);
  }
});

test('small target changes hold the camera still, and reduced motion uses a fixed arena', () => {
  const camera=createArenaCamera();const f=frame({x:350,y:612},{x:700,y:612});
  const first=camera.update(f,null,0);
  const tiny=frame({x:351,y:612},{x:701,y:612});
  assert.deepEqual(camera.update(tiny,null,1000/60),first);
  assert.deepEqual(camera.update(f,{x:400,y:500,strength:1},1000/30,true),{scale:1,x:0,y:0});
});
