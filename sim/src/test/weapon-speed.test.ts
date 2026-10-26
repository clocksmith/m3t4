import test from 'node:test';
import assert from 'node:assert/strict';
import { WEAPON_PROFILES_V1, WEAPON_PROFILES_V2, attackDuration, attackCooldown, attackCooldownLegacy, articulatedWeaponPose } from '../weapon-kinematics.js';
import { swordHits } from '../combat-geometry.js';
import { sweptSwordHits, sweptCombatContact } from '../combat-sweep.js';
import { STEP } from '../constants.js';
import { createStepperWorld, stepWorld, worldToFrame, DEFAULT_CHARS } from '../simulate.js';
import { STAGES } from '../stage.js';
const close=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const previousDurations={worldcoin_orb_flail:.48,backpack_maul:.5,gpu_server_blade:.32,heat_sink_greatsword:.42,
  rolled_constitution_bat:.34,alignment_baton:.28,red_team_pike:.4,guardrail_greatsword:.44,
  nobel_medal_flail:.46,folded_chess_axe:.4,go_board_maul:.52,alphafold_blade:.3,
  sunscreen_bottle_club:.34,controller_nunchucks:.36,shareholder_sauce_club:.36,quest_flail:.5,
  compute_bat:.34,heatsink_hammer:.5,silicon_cleaver:.38,rack_greatsword:.44,
  coil_bat:.34,orbit_lance:.38,satellite_axe:.42,angular_greatsword:.42};
const base={x:450,y:420,facing:1,swipeT:0,diveT:0,weaponMotionVersion:2 as const};
const none={left:false,right:false,up:false,down:false,action:false};

test('all 24 swings take exactly half the old duration, retain cooldown/reach, and double trajectory velocity',()=>{
  for(const [weapon,oldDuration] of Object.entries(previousDurations)){
    const old={...base,weapon,weaponMotionVersion:1},fast={...base,weapon};
    assert.equal(WEAPON_PROFILES_V1[weapon].duration,oldDuration);
    assert.equal(WEAPON_PROFILES_V2[weapon].duration,oldDuration/2);
    assert.equal(attackDuration(old),oldDuration);assert.equal(attackDuration(fast),oldDuration/2);
    assert.equal(attackCooldown(fast),0);assert.equal(attackCooldownLegacy(fast),oldDuration*1.6);
    assert.equal(WEAPON_PROFILES_V2[weapon].reach,WEAPON_PROFILES_V1[weapon].reach);
    for(const p of [.1,.3,.5,.8]){
      const sample=(version:number,progress:number)=>articulatedWeaponPose({...base,weapon,weaponMotionVersion:version,swipeT:attackDuration({...base,weapon,weaponMotionVersion:version})*(1-progress)})!;
      const a=sample(1,p),b=sample(2,p),a1=sample(1,p+1e-5),b1=sample(2,p+1e-5);
      assert.deepEqual(b.tip,a.tip);assert.deepEqual(b.grip,a.grip);assert.equal(b.active,a.active);
      close((b1.tip.x-b.tip.x)/(oldDuration/2*1e-5),2*(a1.tip.x-a.tip.x)/(oldDuration*1e-5));
      close((b1.tip.y-b.tip.y)/(oldDuration/2*1e-5),2*(a1.tip.y-a.tip.y)/(oldDuration*1e-5));
    }
  }
  assert.equal(attackDuration({...base,weaponMotionVersion:undefined}),.12,'unversioned archives keep legacy timing');
});

test('continuous capsule sweep catches tunneling from weapon and target movement without widening hurtboxes',()=>{
  const a={bx:-40,by:0,tx:-40,ty:0,radius:6},b={...a,bx:40,tx:40},target={x:0,y:15.68};
  assert.equal(swordHits(a,target),false);assert.equal(swordHits(b,target),false);
  assert.equal(sweptSwordHits(a,b,target,target),true);
  assert.equal(sweptSwordHits(a,a,{x:-80,y:15.68},{x:0,y:15.68}),true);
  assert.equal(sweptSwordHits(a,b,{x:0,y:50},{x:0,y:50}),false);
});

test('swept collision respects active windows and flexible head-only damage',()=>{
  const weapon='worldcoin_orb_flail',duration=attackDuration({...base,weapon});
  const attacker={...base,weapon,swipeT:duration*.9};
  const pose=articulatedWeaponPose(attacker)!;
  const target={...base,x:pose.tip.x,y:pose.tip.y+15.68,weapon:'alignment_baton'};
  assert.deepEqual(sweptCombatContact([attacker,target],[{...attacker,swipeT:attacker.swipeT-STEP},target],STEP),{clash:false,hitA:false,hitB:false});
  const idle={...base,weapon,swipeT:0};
  assert.deepEqual(sweptCombatContact([idle,target],[idle,target],STEP),{clash:false,hitA:false,hitB:false});
  const active={...attacker,swipeT:duration*.5},activePose=articulatedWeaponPose(active)!;
  const victim={...target,x:activePose.tip.x,y:activePose.tip.y+15.68};
  assert.equal(sweptCombatContact([active,victim],[{...active,swipeT:active.swipeT-STEP},victim],STEP).hitA,true);
});

test('new-world attack state uses fast duration and zero cooldown at the same 120 Hz',()=>{
  for(const [weapon,oldDuration] of Object.entries(previousDurations)){
    const world=createStepperWorld({stage:STAGES.datacenter,seed:1729,chars:[{...DEFAULT_CHARS[0],weapon,weaponMotionVersion:2},DEFAULT_CHARS[1]]});
    world.fighters[0].invuln=0;world.fighters[1].invuln=0;
    stepWorld(world,{...none,action:true},none);
    close(world.fighters[0].swipeT,oldDuration/2-STEP);
    close(world.fighters[0].swipeCD,0);
    assert.equal(world.tick,1);assert.equal(worldToFrame(world).p0.weaponMotionVersion,2);
  }
});

test('a new swing can start halfway through the middle of an existing swing', () => {
  const world = createStepperWorld({ stage: STAGES.datacenter, seed: 42, chars: DEFAULT_CHARS });
  const f = world.fighters[0];
  f.invuln = 0;
  stepWorld(world, { ...none, action: true }, none);
  const duration = attackDuration(f);
  close(f.swipeT, duration - STEP);
  // Before halfway: action cannot restart swing
  f.swipeT = duration * 0.75;
  stepWorld(world, { ...none, action: true }, none);
  close(f.swipeT, duration * 0.75 - STEP);
  // At or past halfway: action can restart swing
  f.swipeT = duration * 0.5;
  stepWorld(world, { ...none, action: true }, none);
  close(f.swipeT, duration - STEP);
});

test('fixed-step results are independent of display batching and repeat exactly with V2 identities',()=>{
  const opts={stage:STAGES.datacenter,seed:171,chars:[{...DEFAULT_CHARS[0],body:'elon',weapon:'orbit_lance',weaponMotionVersion:2 as const},{...DEFAULT_CHARS[1],body:'sama',weapon:'worldcoin_orb_flail',weaponMotionVersion:2 as const}] as typeof DEFAULT_CHARS};
  const run=(ticksPerDisplay:number)=>{
    const w=createStepperWorld(opts);
    for(let display=0;display<240/ticksPerDisplay;display++){
      for(let n=0;n<ticksPerDisplay;n++){
        const tick=display*ticksPerDisplay+n;
        stepWorld(w,{...none,right:tick<75,action:tick%20===0},{...none,left:tick<75,action:tick%31===0});
      }
      worldToFrame(w);
    }
    return worldToFrame(w);
  };
  assert.deepEqual(run(1),run(2));assert.deepEqual(run(1),run(4));assert.deepEqual(run(4),run(4));
});
