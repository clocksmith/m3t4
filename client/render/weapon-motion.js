// Cosmetic motion only. Combat reach and active time remain swordSeg/STATS.
// Timing knots map normalized attack time to the six authored body poses.
const motion = (kind, knots, support = null) => Object.freeze({kind,knots,support});
const club = motion('club',[0,.12,.28,.48,.72,.9]);
const maul = motion('maul',[0,.24,.42,.56,.78,.94],-5);
const blade = motion('blade',[0,.1,.24,.44,.7,.9],-4);
const pike = motion('pike',[0,.08,.18,.38,.64,.88],-8);
const flail = motion('flail',[0,.2,.38,.52,.8,.95]);
const axe = motion('axe',[0,.18,.34,.5,.76,.92],-5);
const nunchucks = motion('nunchucks',[0,.06,.18,.36,.6,.84]);
export const WEAPON_MOTION = Object.freeze({
  worldcoin_orb_flail:flail, backpack_maul:maul, gpu_server_blade:blade, heat_sink_greatsword:blade,
  rolled_constitution_bat:club, alignment_baton:club, red_team_pike:pike, guardrail_greatsword:blade,
  nobel_medal_flail:flail, folded_chess_axe:axe, go_board_maul:maul, alphafold_blade:blade,
  sunscreen_bottle_club:club, controller_nunchucks:nunchucks, shareholder_sauce_club:club, quest_flail:flail,
  compute_bat:club, heatsink_hammer:maul, silicon_cleaver:axe, rack_greatsword:blade,
  coil_bat:club, orbit_lance:pike, satellite_axe:axe, angular_greatsword:blade,
});

export function weaponBodyFrame(weapon, progress) {
  const knots=WEAPON_MOTION[weapon]?.knots;
  if(!knots) return Math.min(5,Math.floor(Math.max(0,Math.min(1,progress))*6));
  let frame=0;
  for(let i=1;i<knots.length;i++) if(progress>=knots[i])frame=i;
  return frame;
}

// Weapon-local distances, transformed by its actual angle rather than screen X.
// A second hand sits behind the primary grip; it must never float on the blade.
export function weaponHandPoints(weapon, segment) {
  const {bx,by,tx,ty}=segment;
  const length=Math.hypot(tx-bx,ty-by)||1;
  const support=WEAPON_MOTION[weapon]?.support;
  const points=[{x:bx,y:by,primary:true}];
  if(support!==null&&support!==undefined) points.push({x:bx+(tx-bx)*support/length,y:by+(ty-by)*support/length,primary:false});
  return points;
}

export const FIGHTER_ARM_PALETTE = Object.freeze({
  sama:{skin:'#d7b4aa',sleeve:'#252638'},
  darrius:{skin:'#bf8d59',sleeve:'#292c37'},
  demis:{skin:'#b99059',sleeve:'#172b52'},
  mark:{skin:'#d9aa96',sleeve:'#241d32'},
  jensen:{skin:'#d99455',sleeve:'#22252a'},
  elon:{skin:'#e6a36a',sleeve:'#24272b'},
});
