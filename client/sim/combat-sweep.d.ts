import { type CombatPose, type SwordSeg } from './combat-geometry.js';
type Point = {
    x: number;
    y: number;
};
export interface CombatContact {
    clash: boolean;
    hitA: boolean;
    hitB: boolean;
}
export declare function sweptSwordHits(start: SwordSeg, end: SwordSeg, targetStart: Point, targetEnd: Point): boolean;
export declare function sweptCombatContact(before: readonly CombatPose[], after: readonly CombatPose[], step: number): CombatContact;
export {};
