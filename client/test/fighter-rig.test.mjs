import test from 'node:test';
import assert from 'node:assert/strict';
import {FIGHTER_RIGS,drawRigFighter,rigGripSockets,solveArm} from '../render/fighter-rig.js';
import {WEAPON_PROFILES_V1,attackDuration,articulatedWeaponPose} from '../sim/weapon-kinematics.js';
import {readRgbaPng} from './png-rgba.mjs';
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
const base={x:450,y:420,facing:1,onGround:true,vx:0,vy:0,wall:0,stun:0,dead:false,swipeT:0,diveT:0,weaponMotionVersion:1};

test('every generated rig has real transparent separate body and limb pieces at validated source rectangles',()=>{
  for(const [body,spec] of Object.entries(FIGHTER_RIGS)){
    const png=readRgbaPng(new URL('../'+spec.url,import.meta.url));
    assert.equal(png.alpha(0,0),0,body);
    assert.equal(png.width,1254);assert.equal(png.height,1254);
    for(const key of ['head','torso','upperArm','forearm','fist','thigh','shin']){
      const [x,y,w,h]=spec[key];assert.ok(x>=0&&y>=0&&x+w<=png.width&&y+h<=png.height,`${body}:${key}`);
      let opaque=0;for(let py=y;py<y+h;py++)for(let px=x;px<x+w;px++)opaque+=png.alpha(px,py)>128?1:0;
      assert.ok(opaque>w*h*.1,`${body}:${key} is empty`);
    }
  }
});
test('weapon wrists, support sockets and solved elbows remain exact and mirrored for every attack sample',()=>{
  for(const weaponMotionVersion of [1,2])for(const weapon of Object.keys(WEAPON_PROFILES_V1))for(let i=0;i<=100;i++){
    const f={...base,weapon,weaponMotionVersion,swipeT:attackDuration({weapon,weaponMotionVersion})*(1-i/101)};
    const pose=articulatedWeaponPose(f),right=rigGripSockets(f),left=rigGripSockets({...f,facing:-1});
    close(right[0].x,pose.grip.x);close(right[0].y,pose.grip.y);
    for(let n=0;n<right.length;n++){
      close(right[n].x+left[n].x,900);close(right[n].y,left[n].y);
      const shoulder={x:f.x+(n?-4:4),y:f.y-13};
      const arm=solveArm(shoulder,right[n]);
      close(Math.hypot(arm.elbow.x-shoulder.x,arm.elbow.y-shoulder.y),11);
      close(Math.hypot(arm.elbow.x-right[n].x,arm.elbow.y-right[n].y),11);
    }
  }
});
function context(){
  let m=[1,0,0,1,0,0];const stack=[],draws=[];
  const mul=n=>{const[a,b,c,d,e,f]=m,[g,h,i,j,k,l]=n;m=[a*g+c*h,b*g+d*h,a*i+c*j,b*i+d*j,a*k+c*l+e,b*k+d*l+f];};
  return {draws,save(){stack.push([...m]);},restore(){m=stack.pop();},translate(x,y){mul([1,0,0,1,x,y]);},rotate(a){mul([Math.cos(a),Math.sin(a),-Math.sin(a),Math.cos(a),0,0]);},scale(x,y){mul([x,0,0,y,0,0]);},drawImage(image,...args){draws.push({image,args,m:[...m]});}};
}
test('actual rig draw calls plant a grounded foot throughout running and draw exactly two articulated arms',()=>{
  const OriginalImage=globalThis.Image;
  globalThis.Image=class{set src(value){this._src=value;this.onload?.();}get src(){return this._src;}};
  try{
    for(const body of Object.keys(FIGHTER_RIGS))for(const facing of [-1,1])for(let tick=0;tick<120;tick+=3){
      const ctx=context(),spec=FIGHTER_RIGS[body];
      assert.equal(drawRigFighter(ctx,{...base,weapon:'alignment_baton',facing,vx:200},body,{tick}),true);
      const rectDraws=rect=>ctx.draws.filter(d=>d.args.slice(0,4).every((v,i)=>v===rect[i]));
      assert.equal(rectDraws(spec.upperArm).length,2);assert.equal(rectDraws(spec.forearm).length,2);assert.equal(rectDraws(spec.fist).length,2);
      const footYs=rectDraws(spec.shin).map(({args:a,m})=>m[1]*(a[4]+a[6]/2)+m[3]*(a[5]+a[7])+m[5]);
      close(Math.max(...footYs),448);assert.ok(footYs.every(y=>y<=448+1e-7));
    }
  }finally{globalThis.Image=OriginalImage;}
});


test('Darrius head grows around the same neck without moving limbs or weapon wrists',()=>{
  const OriginalImage=globalThis.Image;
  globalThis.Image=class{set src(value){this._src=value;this.onload?.();}get src(){return this._src;}};
  try{
    for(const facing of [-1,1])for(const patch of [{},{swipeT:.14},{onGround:false,wall:facing,vy:100},{dead:true}]){
      const draws=body=>{
        const ctx=context();
        assert.equal(drawRigFighter(ctx,{...base,weapon:'alignment_baton',facing,...patch},body,{tick:33}),true);
        return ctx.draws.map(({args,m})=>({args,m}));
      };
      const original=draws('sama'),larger=draws('darrius');
      const isHead=d=>d.args.slice(0,4).every((v,i)=>v===FIGHTER_RIGS.sama.head[i]);
      const a=original.find(isHead),b=larger.find(isHead);
      close(b.args[6]/a.args[6],1.1);close(b.args[7]/a.args[7],1.1);
      close(b.args[4]+b.args[6]/2,a.args[4]+a.args[6]/2);
      close(b.args[5]+b.args[7],a.args[5]+a.args[7]);
      assert.deepEqual(b.m,a.m);
      assert.deepEqual(larger.filter(d=>!isHead(d)),original.filter(d=>!isHead(d)));
    }
  }finally{globalThis.Image=OriginalImage;}
});

test('enlarged Darrius head remains inside the shared hittable circle in every living pose',async()=>{
  const {fighterHurtbox}=await import('../sim/combat-geometry.js');
  const OriginalImage=globalThis.Image;
  globalThis.Image=class{set src(value){this._src=value;this.onload?.();}get src(){return this._src;}};
  try{
    for(const facing of [-1,1])for(const patch of [{},{vx:200},{swipeT:.07},{diveT:.1,onGround:false},{onGround:false,wall:facing,vy:100}])for(let tick=0;tick<120;tick+=3){
      const f={...base,weapon:'alignment_baton',weaponMotionVersion:2,facing,...patch},ctx=context(),hurt=fighterHurtbox(f);
      drawRigFighter(ctx,f,'darrius',{tick});
      const head=ctx.draws.find(d=>d.args.slice(0,4).every((v,i)=>v===FIGHTER_RIGS.darrius.head[i]));
      const [,,,,x,y,w,h]=head.args,[a,b,c,d,e,g]=head.m;
      for(const [px,py] of [[x,y],[x+w,y],[x,y+h],[x+w,y+h]]){
        assert.ok(Math.hypot(a*px+c*py+e-hurt.x,b*px+d*py+g-hurt.y)<=hurt.radius+1e-8,'head must stay hittable');
      }
    }
  }finally{globalThis.Image=OriginalImage;}
});
