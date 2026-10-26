// Source pieces come from imagegen; only the renderer places/rotates them.
// No generated bitmap is rewritten, resized or recolored on disk.
import {imageState,loadImage} from './image-assets.js';
import {swordSeg} from '../sim/combat-geometry.js';
import {articulatedWeaponPose,weaponProfile,attackProgress} from '../sim/weapon-kinematics.js';
import {WEAPON_MOTION} from './weapon-motion.js';
export const FIGHTER_RIGS = {
  sama:{url:'assets/chars/rig-v1/sama.png', head:[270,107,180,212],torso:[247,310,203,267],upperArm:[893,284,100,164],forearm:[907,448,81,106],fist:[916,955,75,77],thigh:[303,734,100,215],shin:[315,949,143,217]},
};
for(const body of ['darrius','demis','mark','jensen','elon']) FIGHTER_RIGS[body]={...FIGHTER_RIGS.sama,url:`assets/chars/rig-v1/${body}.png`};
FIGHTER_RIGS.darrius.headScale=1.1;
// Hosting caches PNGs for an hour; revised art must not reuse the old URL.
FIGHTER_RIGS.darrius.url+='?v=appearance-20261026a';
for(const body of ['jensen','elon'])FIGHTER_RIGS[body].url+='?v=appearance-20261023c';
const images=new Map();
const stateFor=(body)=>{const spec=FIGHTER_RIGS[body];if(!spec)return null;let state=images.get(body);if(!state){state=imageState(spec.url);images.set(body,state);}return {spec,img:loadImage(state)};};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

// Exact two-bone IK: shoulder and wrist are sockets, elbow is solved, never
// guessed from fighter center. Both sides use the same facing-local solution.
export function solveArm(shoulder,wrist,upper=11,lower=11,bend=1){
  const dx=wrist.x-shoulder.x,dy=wrist.y-shoulder.y,d=Math.hypot(dx,dy);
  // Arms are authored for this bounded reach; reject an impossible target.
  if(d>upper+lower+.001)throw Error(`Unreachable weapon wrist: ${d}`);
  const a=Math.atan2(dy,dx)+bend*Math.acos(clamp((upper*upper+d*d-lower*lower)/(2*upper*Math.max(.001,d)),-1,1));
  return {shoulder,elbow:{x:shoulder.x+upper*Math.cos(a),y:shoulder.y+upper*Math.sin(a)},wrist};
}
export function rigGripSockets(f){
  const pose=articulatedWeaponPose(f),segment=swordSeg(f),grip=pose?.grip??{x:segment.bx,y:segment.by};
  const support=weaponProfile(f)?.support ?? WEAPON_MOTION[f.weapon]?.support;
  const angle=pose?.angle??Math.atan2(segment.ty-segment.by,(segment.tx-segment.bx)*f.facing);
  return [{...grip,primary:true},...(support==null?[]:[{x:grip.x+f.facing*Math.cos(angle)*support,y:grip.y+Math.sin(angle)*support,primary:false}])];
}
function piece(ctx,img,rect,x,y,w,h){ctx.drawImage(img,...rect,x,y,w,h);}
function bone(ctx,img,rect,a,b,width,bleed=1){
  ctx.save();ctx.translate(a.x,a.y);ctx.rotate(Math.atan2(b.y-a.y,b.x-a.x)-Math.PI/2);
  piece(ctx,img,rect,-width/2,-bleed,width,Math.hypot(b.x-a.x,b.y-a.y)+bleed*2);ctx.restore();
}
function poseFor(f,frame){
  const feet=f.y+28, tick=frame.tick??0, run=f.onGround&&Math.abs(f.vx??0)>20;
  const cycle=tick/120*12,step=run?Math.sin(cycle):0;
  const extension=side=>13*Math.cos(step*.55*side)+14*Math.cos(step*.55*side+Math.max(0,step*side)*.8);
  let hipY=run?-Math.max(extension(-1),extension(1)):-27,lean=run?.1:0;
  if(f.swipeT>0)lean=Math.sin(attackProgress(f)*Math.PI)*.08;
  if(f.diveT>0)lean=.32;
  if(f.stun>0)lean=-.16;
  return {feet,step,hipY,lean};
}
export function drawRigFighter(ctx,f,body,frame){
  const state=stateFor(body);if(!state?.img)return false;
  const {spec,img}=state,p=poseFor(f,frame),facing=f.facing<0?-1:1;
  ctx.save();ctx.imageSmoothingEnabled=false;ctx.translate(f.x,p.feet);ctx.scale(facing,1);
  if(f.dead){ctx.translate(0,-4);ctx.rotate(1.5);ctx.translate(0,27);}
  // Far leg first, then front leg. Source parts have genuine transparent edges.
  for(const side of [-1,1]){
    let angle=p.step*.55*side,knee=Math.max(0,p.step*side)*.8;
    if(!f.onGround){angle=side===1?-.65:.5;knee=side===1?1.2:.35;}
    if(f.wall&&!f.onGround){const direction=f.wall*facing;angle=side===1?direction*1.1:-direction*.2;knee=-direction;}
    if(f.dead){angle=side*.12;knee=.15;}
    const hip={x:side*2,y:p.hipY},kn={x:hip.x+Math.sin(angle)*13,y:hip.y+Math.cos(angle)*13};
    const ankle={x:kn.x+Math.sin(angle+knee)*14,y:kn.y+Math.cos(angle+knee)*14};
    bone(ctx,img,spec.thigh,hip,kn,6);bone(ctx,img,spec.shin,kn,ankle,9,0);
  }
  ctx.save();ctx.translate(0,p.hipY);ctx.rotate(p.lean);
  piece(ctx,img,spec.torso,-6,-18,12,19);
  const headScale=spec.headScale??1;
  // Keep the neck socket fixed while growing the head upward and sideways.
  piece(ctx,img,spec.head,-5*headScale,-17-12*headScale,10*headScale,12*headScale);ctx.restore();
  const sockets=f.dead?[]:rigGripSockets(f);
  const shoulders=[4,-4].map(x=>({x:x*Math.cos(p.lean)+14*Math.sin(p.lean),y:p.hipY+x*Math.sin(p.lean)-14*Math.cos(p.lean)}));
  const arms=sockets.length?[...sockets,...(sockets.length===1?[{x:f.x-facing*6,y:f.y+4,primary:false}]:[])]:[{x:f.x+facing*9,y:f.y+4,primary:true},{x:f.x-facing*8,y:f.y+4,primary:false}];
  if(f.wall&&!f.onGround&&sockets.length===1){arms[1].x=f.x+f.wall*12;arms[1].y=f.y-22;}
  for(const socket of arms.slice().reverse()){
    const shoulder=shoulders[socket.primary?0:1];
    const wrist={x:(socket.x-f.x)*facing,y:socket.y-p.feet};
    // Dead arms fold naturally beside the torso instead of following a weapon.
    if(f.dead){wrist.x=socket.primary?9:-8;wrist.y=-24;}
    const arm=solveArm(shoulder,wrist);
    bone(ctx,img,spec.upperArm,arm.shoulder,arm.elbow,5);
    bone(ctx,img,spec.forearm,arm.elbow,arm.wrist,4);
    piece(ctx,img,spec.fist,wrist.x-2,wrist.y-2,4,4);
  }
  ctx.restore();return true;
}
export function drawRigGrips(ctx,f,body){
  const state=stateFor(body);if(!state?.img||f.dead)return;
  for(const grip of rigGripSockets(f)){
    ctx.save();ctx.translate(grip.x,grip.y);ctx.scale(f.facing<0?-1:1,1);
    piece(ctx,state.img,state.spec.fist,-2,-2,4,4);ctx.restore();
  }
}
