import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyFramePlacement, WEAPON_ART, weaponArtTransform } from '../render/fighter-art.js';
import { swordSeg } from '../sim/combat-geometry.js';
import { STATS } from '../lib/public-sim.js';
import { readRgbaPng } from './png-rgba.mjs';
const close = (a,b) => assert.ok(Math.abs(a-b) < 1e-9, `${a} != ${b}`);

test('calibrated weapon endpoints are real opaque pixels and silhouettes fit their reach', () => {
  for (const [body, weapons] of Object.entries(WEAPON_ART)) {
    const png = readRgbaPng(new URL(`../assets/weapons/${body}/sheet.png`, import.meta.url));
    for (const [cell, art] of weapons.entries()) {
      const label = `${body}:${cell}`, ox = cell % 2 * 48, oy = Math.floor(cell / 2) * 48;
      const [cx, cy, cw, ch] = art.crop;
      for (const [x,y] of [[art.gripX,art.gripY],[art.tipX,art.tipY]]) {
        assert.equal(png.alpha(ox+x,oy+y),255,`${label}: transparent grip/tip`);
        assert.ok(x>=cx&&x<cx+cw&&y>=cy&&y<cy+ch,`${label}: clipped endpoint`);
      }
      // Detached key-color sparkles are not the weapon. Measure its largest
      // connected silhouette so this catches bad axes without treating dirt as reach.
      const remaining = new Set();
      for(let y=cy;y<cy+ch;y++)for(let x=cx;x<cx+cw;x++)if(png.alpha(ox+x,oy+y)>=128)remaining.add(y*48+x);
      let principal=[];
      while(remaining.size){
        const component=[remaining.values().next().value];remaining.delete(component[0]);
        for(let i=0;i<component.length;i++){
          const x=component[i]%48,y=Math.floor(component[i]/48);
          for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
            const nx=x+dx,ny=y+dy,key=ny*48+nx;
            if(nx>=0&&nx<48&&ny>=0&&ny<48&&remaining.delete(key))component.push(key);
          }
        }
        if(component.length>principal.length)principal=component;
      }
      const ax=art.tipX-art.gripX,ay=art.tipY-art.gripY,len2=ax*ax+ay*ay;
      const projected=principal.map(key=>{
        const x=key%48-art.gripX,y=Math.floor(key/48)-art.gripY;
        return {along:(x*ax+y*ay)*STATS.sword/len2,across:(-x*ay+y*ax)*STATS.sword/len2*art.aspect};
      });
      const tip=Math.max(...projected.map(p=>p.along));
      assert.ok(Math.abs(tip-STATS.sword)<=1.5,`${label}: art tip ${tip} differs from collision`);
      assert.ok(projected.every(p=>Math.abs(p.across)<=18.5),`${label}: oversized weapon silhouette`);
    }
  }
});

test('all roster weapon grips and tips map onto collision for both facings and every attack phase', () => {
  for (const art of Object.values(WEAPON_ART).flat()) for (const facing of [-1,1]) {
    for (const [swipeT,diveT] of [[0,0],[STATS.swipeTime,0],[.08,0],[.04,0],[.001,0],[0,.2]]) {
      const segment=swordSeg({x:350.4,y:401.1,facing,swipeT,diveT});
      const t=weaponArtTransform(segment,art,facing);
      const map=(x,y)=>{
        x=(x-art.gripX)*t.mirror;y-=art.gripY;
        const u=(x*Math.cos(t.sourceAngle)+y*Math.sin(t.sourceAngle))*t.scale;
        const v=(-x*Math.sin(t.sourceAngle)+y*Math.cos(t.sourceAngle))*t.scale*t.aspect;
        return [t.x+u*Math.cos(t.worldAngle)-v*Math.sin(t.worldAngle),t.y+u*Math.sin(t.worldAngle)+v*Math.cos(t.worldAngle)];
      };
      const grip=map(art.gripX,art.gripY),tip=map(art.tipX,art.tipY);
      close(grip[0],segment.bx);close(grip[1],segment.by);close(tip[0],segment.tx);close(tip[1],segment.ty);
      close(t.scale,STATS.sword/Math.hypot(art.tipX-art.gripX,art.tipY-art.gripY));
      assert.equal(t.mirror,facing);
    }
  }
});

test('sprite placement plants grounded frames without fractional scaling or contaminated edges', () => {
  for (const body of Object.keys(WEAPON_ART)) for (const anim of ['idle','run','swing']) for(let frame=0;frame<(anim==='idle'?4:6);frame++) {
    const p=bodyFramePlacement(body,anim,frame,{grounded:true});
    assert.ok(Number.isInteger(p.rootX));assert.ok(Number.isInteger(p.footY));
    assert.deepEqual(p.crop,{x:1,y:1,w:62,h:62});
    assert.ok(p.sourceFrame>=0&&p.sourceFrame<6);
  }
  assert.equal(bodyFramePlacement('sama','run',4).sourceFacing,-1);
  assert.equal(bodyFramePlacement('sama','run',5).sourceFacing,-1);
  assert.equal(bodyFramePlacement('sama','wallSlide',1).sourceFacing,-1);
  for(const frame of [0,1,2,3,4,5]) assert.ok(![1,2,3].includes(bodyFramePlacement('demis','swing',frame).sourceFrame));
});

function recordingContext() {
  let m=[1,0,0,1,0,0];const stack=[],draws=[];
  const multiply=(n)=>{const [a,b,c,d,e,f]=m;const [g,h,i,j,k,l]=n;m=[a*g+c*h,b*g+d*h,a*i+c*j,b*i+d*j,a*k+c*l+e,b*k+d*l+f];};
  return new Proxy({draws,canvas:{width:1280,height:720},
    save(){stack.push([...m]);},restore(){m=stack.pop()??m;},
    translate(x,y){multiply([1,0,0,1,x,y]);},rotate(a){multiply([Math.cos(a),Math.sin(a),-Math.sin(a),Math.cos(a),0,0]);},scale(x,y){multiply([x,0,0,y,0,0]);},
    drawImage(image,...args){draws.push({src:image.src,args,m:[...m]});},
    createLinearGradient(){return {addColorStop(){}};},createRadialGradient(){return {addColorStop(){}};},
    measureText(text){return {width:String(text).length*6};},
  },{get(target,key){return key in target?target[key]:()=>{};}});
}

const pose={x:450,y:612,vx:0,vy:0,onGround:true,wall:0,facing:1,stun:0,swipeT:0,diveT:0,lastClashTick:-9999,dead:false};
const makeFrame=(tick,patch={})=>({tick,roundStartTick:0,p0:{...pose,...patch},p1:{...pose,...patch,x:850,facing:-1},token:{exists:false,carrier:-1},goal:{exists:false},scoreboard:[0,0],rounds:[0,0]});

test('renderer maps actual atlas draw calls to collision, including wall facing and load failure', async () => {
  const OriginalImage=globalThis.Image;
  globalThis.Image=class {set src(value){this._src=value;this.width=96;this.height=96;value.includes('/rig-v1/')?this.onerror?.():this.onload?.();}get src(){return this._src;}};
  try {
    const { drawFrame }=await import('../render/canvas2d.js?renderer-test');
    const { STAGES }=await import('../lib/public-sim.js');
    const {default:catalog}=await import('../content/roster-catalog.v1.json',{with:{type:'json'}});
    const ctx=recordingContext();
    for(const body of catalog.bodies) for(const weapon of catalog.weapons[body]) for(const patch of [{},{swipeT:.06},{diveT:.2,onGround:false},{onGround:false,wall:-1,vy:100}]){
      ctx.draws.length=0;
      const frame=makeFrame(500,patch);
      drawFrame(ctx,STAGES.datacenter,frame,{cosmetics:[{body,weapon:weapon.id},{body,weapon:weapon.id}]});
      assert.equal(ctx.draws.filter(d=>d.src.includes(`/chars/${body}/`)&&d.src.endsWith('/sprite.png')).length,2,'requested body must not silently fall back');
      assert.equal(ctx.draws.filter(d=>d.src.includes(`/chars/${body}/`)&&d.src.split('?')[0].endsWith('/portraits/sheet.png')).length,2,'HUD must use the selected identity');
      const weaponDraws=ctx.draws.filter(d=>d.src.includes('/weapons/'));
      assert.equal(weaponDraws.length,2);
      for(let side=0;side<2;side++){
        const draw=weaponDraws[side],art=WEAPON_ART[body][weapon.asset.cell],segment=swordSeg(side===0?frame.p0:frame.p1);
        const [a,b,c,d,e,f]=draw.m;
        const point=(x,y)=>[a*x+c*y+e,b*x+d*y+f];
        const [gx,gy]=point(0,0),[tx,ty]=point(art.tipX-art.gripX,art.tipY-art.gripY);
        close(gx,segment.bx);close(gy,segment.by);close(tx,segment.tx);close(ty,segment.ty);
      }
    }
    // A new module lifetime with unavailable images must still use the same
    // authoritative foil endpoints, not a cosmetic/facing fallback anchor.
    globalThis.Image=class {set src(value){this._src=value;this.onerror?.();}get src(){return this._src;}};
    const fallback=await import('../render/canvas2d.js?failed-images');
    const paths=[];const failCtx=recordingContext();let current=[];
    failCtx.beginPath=()=>{current=[];};failCtx.moveTo=(...p)=>current.push(p);failCtx.lineTo=(...p)=>current.push(p);failCtx.stroke=()=>paths.push(current);
    const frame=makeFrame(500,{onGround:false,wall:-1,vy:100});
    fallback.drawFrame(failCtx,STAGES.datacenter,frame,{});
    const s=swordSeg(frame.p0);
    assert.ok(paths.some(p=>p.length===2&&p[0][0]===s.bx&&p[0][1]===s.by&&p[1][0]===s.tx&&p[1][1]===s.ty));
  }finally{globalThis.Image=OriginalImage;}
});

test('animation is identical after rewind, skipped frames and independent canvas draws', async () => {
  const OriginalImage=globalThis.Image;
  globalThis.Image=class {set src(value){this._src=value;this.width=384;this.height=768;value.includes('/rig-v1/')?this.onerror?.():this.onload?.();}get src(){return this._src;}};
  try {
    const {drawFrame}=await import('../render/canvas2d.js?timelines');
    const {STAGES}=await import('../lib/public-sim.js');
    const a=recordingContext(),b=recordingContext();
    const render=(ctx,tick)=>{ctx.draws.length=0;drawFrame(ctx,STAGES.datacenter,makeFrame(tick),{});return ctx.draws.filter(d=>d.src.endsWith('/sprite.png'))[0].args[0];};
    assert.equal(render(a,500),65);assert.equal(render(a,540),193);
    assert.equal(render(b,540),193); // same simulation tick, same pose
    assert.equal(render(a,0),1);assert.equal(render(a,20),65);
  }finally{globalThis.Image=OriginalImage;}
});

test('fallback body uses its own sprite calibration, not the requested missing body', async () => {
  const OriginalImage=globalThis.Image;
  globalThis.Image=class {set src(value){this._src=value;this.width=384;this.height=768;value.includes('/chars/demis/')?this.onerror?.():value.includes('/rig-v1/')?this.onerror?.():this.onload?.();}get src(){return this._src;}};
  try{
    const {drawFrame}=await import('../render/canvas2d.js?body-fallback');
    const {STAGES}=await import('../lib/public-sim.js');
    const ctx=recordingContext(),labels={cosmetics:[{body:'demis'},{body:'demis'}]};
    drawFrame(ctx,STAGES.datacenter,makeFrame(0,{vx:180}),labels);ctx.draws.length=0;
    drawFrame(ctx,STAGES.datacenter,makeFrame(40,{vx:180}),labels);
    const body=ctx.draws.find(d=>d.src.endsWith('/sprite.png'));
    assert.ok(body.src.includes('/sama/'));
    assert.equal(body.args[0],4*64+1);
    assert.equal(body.m[0],-1,'Sama backward-authored run cell must still face forward');
  }finally{globalThis.Image=OriginalImage;}
});

test('body anchors and weapon matrices are pure simulation-frame projections for every pose', async () => {
  const OriginalImage=globalThis.Image;
  globalThis.Image=class {set src(value){this._src=value;this.width=384;this.height=768;value.includes('/rig-v1/')?this.onerror?.():this.onload?.();}get src(){return this._src;}};
  try {
    const {drawFrame}=await import('../render/canvas2d.js?tick-purity');
    const {STAGES}=await import('../lib/public-sim.js');
    const a=recordingContext(),b=recordingContext();
    const signature=(ctx,frame)=>{
      ctx.draws.length=0;drawFrame(ctx,STAGES.datacenter,frame,{});
      return ctx.draws.filter(d=>d.src.endsWith('/sprite.png')||d.src.includes('/weapons/'));
    };
    for(const patch of [{},{vx:180},{onGround:false,vy:-500},{onGround:false,vy:400},{onGround:false,wall:-1,vy:100},{swipeT:.06},{onGround:false,diveT:.14,lastAttackStartTick:120},{stun:.03,lastClashTick:131},{dead:true,respawnT:.32}]) {
      const target=makeFrame(137,patch),snapshot=structuredClone(target);
      for(const tick of [0,20,45,90,136]) signature(a,makeFrame(tick,{vx:180}));
      const fromHistory=signature(a,target);
      assert.deepEqual(signature(b,target),fromHistory);
      signature(b,makeFrame(1000,{dead:true}));
      assert.deepEqual(signature(b,target),fromHistory,'rewind is independent of previous paints');
      assert.deepEqual(signature(b,target),fromHistory,'repainting cannot advance pose');
      assert.deepEqual(target,snapshot,'rendering must not mutate the simulation snapshot');
    }
  } finally { globalThis.Image=OriginalImage; }
});

test('KO poses do not retain a floating weapon at the standing combat origin', async () => {
  const OriginalImage=globalThis.Image;
  globalThis.Image=class {set src(value){this._src=value;value.includes('/rig-v1/')?this.onerror?.():this.onload?.();}get src(){return this._src;}};
  try {
    const {drawFrame}=await import('../render/canvas2d.js?ko-weapon');
    const {STAGES}=await import('../lib/public-sim.js');
    const ctx=recordingContext();
    drawFrame(ctx,STAGES.datacenter,makeFrame(100,{dead:true}),{});
    assert.equal(ctx.draws.filter(d=>d.src.includes('/weapons/')).length,0);
    assert.equal(ctx.draws.filter(d=>d.src.endsWith('/sprite.png')).length,2);
  } finally {globalThis.Image=OriginalImage;}
});
