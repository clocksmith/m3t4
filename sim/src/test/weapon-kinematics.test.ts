import test from 'node:test';
import assert from 'node:assert/strict';
import {WEAPON_PROFILES_V1,articulatedWeaponPose,attackDuration,rosterCombatIdentity} from '../weapon-kinematics.js';
import {swordSeg,weaponHitSegments,swordHits} from '../combat-geometry.js';
import {createStepperWorld,worldToFrame,stepWorld,DEFAULT_CHARS} from '../simulate.js';
import {STAGES} from '../stage.js';
const close=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const base={x:450,y:420,facing:1,swipeT:0,diveT:0,weaponMotionVersion:1 as const};

test('all 24 weapons mirror grip, handle joint, flexible joint and tip at every timeline sample',()=>{
  assert.equal(Object.keys(WEAPON_PROFILES_V1).length,24);
  for(const [weapon,spec] of Object.entries(WEAPON_PROFILES_V1))for(let i=0;i<=120;i++){
    const f={...base,weapon,swipeT:i?spec.duration*(1-i/121):0};
    const a=articulatedWeaponPose(f)!,b=articulatedWeaponPose({...f,facing:-1})!;
    for(const key of ['grip','joint','link','tip'] as const){close(a[key].x+b[key].x,900);close(a[key].y,b[key].y);}
    assert.deepEqual(swordSeg(f),a.segment);
    assert.deepEqual(weaponHitSegments(f),a.hitSegments);
    assert.equal(a.active,a.phase==='strike');
    assert.ok(Math.hypot(a.tip.x-a.grip.x,a.tip.y-a.grip.y)<=spec.reach+1e-8);
  }
});
test('new-match identity rejects cross-character weapons and has stable side defaults',()=>{
  assert.deepEqual(rosterCombatIdentity({body:'elon',weapon:'orbit_lance'}),{body:'elon',weapon:'orbit_lance',weaponMotionVersion:1});
  assert.deepEqual(rosterCombatIdentity({body:'elon',weapon:'nobel_medal_flail'}),{body:'elon',weapon:'coil_bat',weaponMotionVersion:1});
  assert.deepEqual(rosterCombatIdentity(null,1),{body:'darrius',weapon:'rolled_constitution_bat',weaponMotionVersion:1});
});
test('lances retract, thrust level and recover; flail heads lag rather than being rigid chords',()=>{
  const sample=(weapon:string,p:number)=>articulatedWeaponPose({...base,weapon,swipeT:WEAPON_PROFILES_V1[weapon].duration*(1-p)})!;
  const wind=sample('orbit_lance',.3),strike=sample('orbit_lance',.64),rest=articulatedWeaponPose({...base,weapon:'orbit_lance'})!;
  assert.ok(wind.grip.x<rest.grip.x);assert.ok(strike.tip.x>rest.tip.x);
  close(strike.tip.y-strike.grip.y,wind.tip.y-wind.grip.y);
  for(const weapon of ['worldcoin_orb_flail','nobel_medal_flail','quest_flail','controller_nunchucks']){
    const p=sample(weapon,.5),a={x:p.joint.x-p.grip.x,y:p.joint.y-p.grip.y},b={x:p.tip.x-p.joint.x,y:p.tip.y-p.joint.y};
    assert.ok(Math.abs(a.x*b.y-a.y*b.x)>5,'flexible joint cannot be collinear');
    assert.deepEqual(weaponHitSegments({...base,weapon,swipeT:WEAPON_PROFILES_V1[weapon].duration*.9}),[],'windup cannot kill');
  }
});
test('flails damage at the head, not the shaft, and all profiles join without positional jumps',()=>{
  for(const [weapon,spec] of Object.entries(WEAPON_PROFILES_V1)){
    for(const p of [spec.windup,spec.strikeEnd,1-1e-7]){
      const sample=(t:number)=>articulatedWeaponPose({...base,weapon,swipeT:spec.duration*(1-t)})!;
      const a=sample(p-1e-7),b=sample(p+1e-7);
      assert.ok(Math.hypot(a.tip.x-b.tip.x,a.tip.y-b.tip.y)<.001,weapon);
    }
  }
  const f={...base,weapon:'nobel_medal_flail',swipeT:.46*.5};
  const p=articulatedWeaponPose(f)!;
  assert.equal(p.hitSegments[0].bx,p.tip.x);assert.equal(p.hitSegments[0].by,p.tip.y);
  assert.equal(swordHits(p.hitSegments[0],{x:p.tip.x,y:p.tip.y+15.68}),true);
});
test('new local combat identity survives trace snapshots and deterministic stepping; legacy defaults remain opt-out',()=>{
  const opts={stage:STAGES.datacenter,seed:171,chars:[{...DEFAULT_CHARS[0],body:'elon',weapon:'orbit_lance',weaponMotionVersion:1 as const},{...DEFAULT_CHARS[1],body:'sama',weapon:'worldcoin_orb_flail',weaponMotionVersion:1 as const}] as typeof DEFAULT_CHARS};
  const a=createStepperWorld(opts),b=createStepperWorld(opts);
  for(let tick=0;tick<150;tick++){
    const actions=[{left:false,right:false,up:false,down:false,action:tick===1},{left:false,right:false,up:false,down:false,action:tick===10}];
    stepWorld(a,actions[0],actions[1]);stepWorld(b,actions[0],actions[1]);assert.deepEqual(worldToFrame(a),worldToFrame(b));
  }
  const frame=worldToFrame(a);assert.equal(frame.p0.weaponMotionVersion,1);assert.equal(frame.p0.weapon,'orbit_lance');
  assert.equal(attackDuration(a.fighters[0]),.38);
  assert.equal(worldToFrame(createStepperWorld({stage:STAGES.datacenter,seed:17})).p0.weaponMotionVersion,undefined);
});
