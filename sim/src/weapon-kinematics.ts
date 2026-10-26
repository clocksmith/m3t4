// Version 1 is opt-in and immutable: replay characters pin this version.
// Archives without the version keep the historical always-extended foil.
export type WeaponKind = 'club' | 'maul' | 'blade' | 'pike' | 'axe' | 'flail' | 'nunchucks';
export interface WeaponProfile { kind: WeaponKind; duration: number; reach: number; windup: number; strikeEnd: number; support: number | null }
const profile = (kind: WeaponKind, duration: number, reach: number, windup: number, strikeEnd: number, support: number | null = null): WeaponProfile => ({kind,duration,reach,windup,strikeEnd,support});
export const WEAPON_PROFILES_V1: Readonly<Record<string, WeaponProfile>> = Object.freeze({
  worldcoin_orb_flail: profile('flail',.48,48,.3,.76),
  backpack_maul: profile('maul',.5,44,.4,.7,-6),
  gpu_server_blade: profile('blade',.32,50,.23,.66,-5),
  heat_sink_greatsword: profile('blade',.42,54,.34,.72,-7),
  rolled_constitution_bat: profile('club',.34,43,.25,.65),
  alignment_baton: profile('club',.28,38,.2,.62),
  red_team_pike: profile('pike',.4,56,.32,.64,-9),
  guardrail_greatsword: profile('blade',.44,54,.35,.72,-7),
  nobel_medal_flail: profile('flail',.46,46,.29,.74),
  folded_chess_axe: profile('axe',.4,46,.32,.67,-5),
  go_board_maul: profile('maul',.52,44,.42,.72,-6),
  alphafold_blade: profile('blade',.3,49,.22,.64,-4),
  sunscreen_bottle_club: profile('club',.34,42,.25,.66),
  controller_nunchucks: profile('nunchucks',.36,42,.22,.78),
  shareholder_sauce_club: profile('club',.36,43,.27,.66),
  quest_flail: profile('flail',.5,48,.33,.77),
  compute_bat: profile('club',.34,44,.26,.65),
  heatsink_hammer: profile('maul',.5,45,.4,.7,-6),
  silicon_cleaver: profile('axe',.38,46,.3,.66,-5),
  rack_greatsword: profile('blade',.44,54,.35,.72,-7),
  coil_bat: profile('club',.34,44,.25,.65),
  orbit_lance: profile('pike',.38,56,.3,.64,-9),
  satellite_axe: profile('axe',.42,47,.34,.69,-5),
  angular_greatsword: profile('blade',.42,54,.33,.7,-7),
});
// Version 2 halves only swing duration. Version 1 stays immutable for archives.
export const WEAPON_PROFILES_V2: Readonly<Record<string, WeaponProfile>> = Object.freeze(
  Object.fromEntries(Object.entries(WEAPON_PROFILES_V1).map(([weapon, spec]) =>
    [weapon, Object.freeze({...spec, duration: spec.duration / 2})])),
);
export const CURRENT_WEAPON_MOTION_VERSION = 2 as const;
const BODY_WEAPONS_V1: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sama:['worldcoin_orb_flail','backpack_maul','gpu_server_blade','heat_sink_greatsword'],
  darrius:['rolled_constitution_bat','alignment_baton','red_team_pike','guardrail_greatsword'],
  demis:['nobel_medal_flail','folded_chess_axe','go_board_maul','alphafold_blade'],
  mark:['sunscreen_bottle_club','controller_nunchucks','shareholder_sauce_club','quest_flail'],
  jensen:['compute_bat','heatsink_hammer','silicon_cleaver','rack_greatsword'],
  elon:['coil_bat','orbit_lance','satellite_axe','angular_greatsword'],
});
/** New-match boundary only. Never run this over archived replay characters. */
export function rosterCombatIdentity(cosmetics: unknown, side=0): {body:string;weapon:string;weaponMotionVersion:2} {
  const raw=cosmetics&&typeof cosmetics==='object'?cosmetics as Record<string,unknown>:{};
  const body=typeof raw.body==='string'&&Object.hasOwn(BODY_WEAPONS_V1,raw.body)?raw.body:side===1?'darrius':'sama';
  const weapons=BODY_WEAPONS_V1[body];
  const weapon=typeof raw.weapon==='string'&&weapons.includes(raw.weapon)?raw.weapon:weapons[0];
  return {body,weapon,weaponMotionVersion:CURRENT_WEAPON_MOTION_VERSION};
}
export interface KinematicPose {
  x: number; y: number; facing: number; swipeT: number; diveT: number;
  weapon?: string; weaponMotionVersion?: number;
  ch?: {weapon?: string; weaponMotionVersion?: number};
}
export interface WeaponPoint { x:number; y:number }
export interface WeaponSegment {bx:number;by:number;tx:number;ty:number;radius?:number}
const clamp = (n:number) => Math.max(0,Math.min(1,n));
const smooth = (n:number) => {const t=clamp(n);return t*t*(3-2*t);};
const lerp = (a:number,b:number,t:number) => a+(b-a)*t;
export function weaponProfile(f: Pick<KinematicPose,'weapon'|'weaponMotionVersion'|'ch'>): WeaponProfile | undefined {
  const version=f.weaponMotionVersion ?? f.ch?.weaponMotionVersion;
  const profiles=version===2?WEAPON_PROFILES_V2:version===1?WEAPON_PROFILES_V1:undefined;
  return profiles?.[f.weapon ?? f.ch?.weapon ?? ''];
}
export function attackDuration(f: Pick<KinematicPose,'weapon'|'weaponMotionVersion'|'ch'>): number {
  return weaponProfile(f)?.duration ?? .12;
}
// Legacy recovery cooldown for archived replay rules (< rulesVersion 2).
export function attackCooldownLegacy(f: Pick<KinematicPose,'weapon'|'weaponMotionVersion'|'ch'>): number {
  const old=WEAPON_PROFILES_V1[f.weapon ?? f.ch?.weapon ?? ''];
  return ((f.weaponMotionVersion ?? f.ch?.weaponMotionVersion)===2 && old
    ? old.duration : attackDuration(f)) * 1.6;
}
// Cooldown between swings: zero cooldown to allow rapid continuous swinging.
export function attackCooldown(f: Pick<KinematicPose,'weapon'|'weaponMotionVersion'|'ch'>): number {
  return 0;
}
export function attackProgress(f: KinematicPose): number {return clamp(1-f.swipeT/attackDuration(f));}
export function articulatedWeaponPose(f: KinematicPose) {
  const spec=weaponProfile(f);
  if(!spec)return null;
  const p=attackProgress(f), attacking=f.swipeT>0, diving=f.diveT>0;
  const wind=smooth(p/spec.windup), strike=smooth((p-spec.windup)/(spec.strikeEnd-spec.windup));
  const recover=smooth((p-spec.strikeEnd)/(1-spec.strikeEnd));
  const phase=diving?'dive':!attacking?'idle':p<spec.windup?'windup':p<=spec.strikeEnd?'strike':'recovery';
  let angle=spec.kind==='pike'?-.04:-.12, gx=10, gy=-16;
  if(attacking){
    if(spec.kind==='pike'){
      // Retract to the rear hip, thrust along a level axis, then withdraw.
      gx=p<spec.windup?lerp(10,1,wind):p<=spec.strikeEnd?lerp(1,18,strike):lerp(18,10,recover);
      angle=-.04;
    }else{
      const back=spec.kind==='blade'?-1.9:spec.kind==='nunchucks'?-1.35:-2.25;
      const through=spec.kind==='blade'?.55:spec.kind==='nunchucks'?1.5:.9;
      angle=p<spec.windup?lerp(-.12,back,wind):p<=spec.strikeEnd?lerp(back,through,strike):lerp(through,-.12,recover);
      // Raise the actual wrist above the shoulder, then drive it forward.
      // Rotating only the item at a fixed wrist looks like a propeller.
      gx=p<spec.windup?lerp(10,3,wind):p<=spec.strikeEnd?lerp(3,16,strike):lerp(16,10,recover);
      gy=p<spec.windup?lerp(-16,-29,wind):p<=spec.strikeEnd?lerp(-29,-12,strike):lerp(-12,-16,recover);
    }
  }
  if(diving){angle=1.3;gx=8;gy=-9;}
  const world=(x:number,y:number):WeaponPoint=>({x:f.x+f.facing*x,y:f.y+y});
  const grip=world(gx,gy), flexible=spec.kind==='flail'||spec.kind==='nunchucks';
  const handleLength=flexible?(spec.kind==='nunchucks'?14:18):spec.reach;
  const joint=world(gx+Math.cos(angle)*handleLength,gy+Math.sin(angle)*handleLength);
  let chainAngle=angle;
  if(flexible){
    // Head trails handle rotation. At rest gravity hangs the free end down.
    chainAngle=diving?1.55:!attacking?1.35:
      p<spec.windup?lerp(1.35,-2.8,wind):
      p<=spec.strikeEnd?lerp(-2.8,.3,smooth(Math.pow((p-spec.windup)/(spec.strikeEnd-spec.windup),2))):
      lerp(.3,1.35,recover);
  }
  const freeLength=spec.reach-handleLength;
  const link=spec.kind==='nunchucks'?{x:joint.x+f.facing*Math.cos(chainAngle)*8,y:joint.y+Math.sin(chainAngle)*8}:joint;
  const distalAngle=chainAngle+(attacking?Math.sin(p*Math.PI)*.65:0);
  const tip=spec.kind==='nunchucks'?{x:link.x+f.facing*Math.cos(distalAngle)*(freeLength-8),y:link.y+Math.sin(distalAngle)*(freeLength-8)}:
    flexible?{x:joint.x+f.facing*Math.cos(chainAngle)*freeLength,y:joint.y+Math.sin(chainAngle)*freeLength}:joint;
  const segment:WeaponSegment={bx:grip.x,by:grip.y,tx:tip.x,ty:tip.y};
  const active=diving||(attacking&&p>=spec.windup&&p<=spec.strikeEnd);
  // Flexible weapons damage with the head, never the empty handle-to-head chord.
  const hitSegments=weaponDamageSegments(spec.kind,active,segment,link,tip);
  return {spec,phase,progress:p,grip,joint,link,tip,angle,chainAngle,distalAngle,flexible,active,segment,hitSegments};
}

// One owner for damage shapes, also used at sweep interval boundaries.
export function weaponDamageSegments(kind:WeaponKind,active:boolean,segment:WeaponSegment,link:WeaponPoint,tip:WeaponPoint):WeaponSegment[] {
  return !active?[]:kind==='nunchucks'?
    [{bx:link.x,by:link.y,tx:tip.x,ty:tip.y,radius:3}]:kind==='flail'?
    [{bx:tip.x,by:tip.y,tx:tip.x,ty:tip.y,radius:6}]:[segment];
}
