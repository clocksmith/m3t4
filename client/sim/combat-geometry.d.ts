import { type KinematicPose } from './weapon-kinematics.js';
export interface CombatPose extends KinematicPose {
    x: number;
    y: number;
    facing: number;
    swipeT: number;
    diveT: number;
}
export interface SwordSeg {
    bx: number;
    by: number;
    tx: number;
    ty: number;
    radius?: number;
}
export declare function swordSeg(f: CombatPose): SwordSeg;
export declare function weaponHitSegments(f: CombatPose): SwordSeg[];
export declare function fighterHurtbox(f: Pick<CombatPose, 'x' | 'y'>): {
    x: number;
    y: number;
    radius: number;
};
export declare function swordHits(s: SwordSeg, target: Pick<CombatPose, 'x' | 'y'>): boolean;
