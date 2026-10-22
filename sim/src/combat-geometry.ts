// Public, deterministic geometry shared by combat and its visual projection.
// Cosmetic poses never move these shapes or change weapon reach.
import { STATS } from './constants.js';

export interface CombatPose {
  x: number;
  y: number;
  facing: number;
  swipeT: number;
  diveT: number;
}
export interface SwordSeg { bx: number; by: number; tx: number; ty: number }

export function swordSeg(f: CombatPose): SwordSeg {
  const bx = f.x + f.facing * STATS.bodyW * 0.35;
  const by = f.y - STATS.bodyH * 0.3;
  let angle = 0;
  if (f.diveT > 0) angle = Math.PI * 0.46;
  else if (f.swipeT > 0) {
    const t = 1 - f.swipeT / STATS.swipeTime;
    const ease = 1 - (1 - t) * (1 - t) * (1 - t);
    angle = 0.0 + (-1.0 - 0.0) * ease;
  }
  const dx = Math.cos(angle) * f.facing;
  const dy = Math.sin(angle);
  return { bx, by, tx: bx + dx * STATS.sword, ty: by + dy * STATS.sword };
}

export function fighterHurtbox(f: Pick<CombatPose, 'x' | 'y'>) {
  return { x: f.x, y: f.y - STATS.bodyH * 0.28, radius: STATS.bodyW * 0.65 };
}

export function swordHits(s: SwordSeg, target: Pick<CombatPose, 'x' | 'y'>): boolean {
  const { x, y, radius } = fighterHurtbox(target);
  const dx = s.tx - s.bx;
  const dy = s.ty - s.by;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - s.bx) * dx + (y - s.by) * dy) / len2));
  return Math.hypot(x - (s.bx + dx * t), y - (s.by + dy * t)) <= radius;
}
