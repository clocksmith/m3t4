export type WeaponKind = 'club' | 'maul' | 'blade' | 'pike' | 'axe' | 'flail' | 'nunchucks';
export interface WeaponProfile {
    kind: WeaponKind;
    duration: number;
    reach: number;
    windup: number;
    strikeEnd: number;
    support: number | null;
}
export declare const WEAPON_PROFILES_V1: Readonly<Record<string, WeaponProfile>>;
export declare const WEAPON_PROFILES_V2: Readonly<Record<string, WeaponProfile>>;
export declare const CURRENT_WEAPON_MOTION_VERSION: 2;
/** New-match boundary only. Never run this over archived replay characters. */
export declare function rosterCombatIdentity(cosmetics: unknown, side?: number): {
    body: string;
    weapon: string;
    weaponMotionVersion: 2;
};
export interface KinematicPose {
    x: number;
    y: number;
    facing: number;
    swipeT: number;
    diveT: number;
    weapon?: string;
    weaponMotionVersion?: number;
    ch?: {
        weapon?: string;
        weaponMotionVersion?: number;
    };
}
export interface WeaponPoint {
    x: number;
    y: number;
}
export interface WeaponSegment {
    bx: number;
    by: number;
    tx: number;
    ty: number;
    radius?: number;
}
export declare function weaponProfile(f: Pick<KinematicPose, 'weapon' | 'weaponMotionVersion' | 'ch'>): WeaponProfile | undefined;
export declare function attackDuration(f: Pick<KinematicPose, 'weapon' | 'weaponMotionVersion' | 'ch'>): number;
export declare function attackCooldown(f: Pick<KinematicPose, 'weapon' | 'weaponMotionVersion' | 'ch'>): number;
export declare function attackProgress(f: KinematicPose): number;
export declare function articulatedWeaponPose(f: KinematicPose): {
    spec: WeaponProfile;
    phase: string;
    progress: number;
    grip: WeaponPoint;
    joint: WeaponPoint;
    link: WeaponPoint;
    tip: WeaponPoint;
    angle: number;
    chainAngle: number;
    distalAngle: number;
    flexible: boolean;
    active: boolean;
    segment: WeaponSegment;
    hitSegments: WeaponSegment[];
} | null;
export declare function weaponDamageSegments(kind: WeaponKind, active: boolean, segment: WeaponSegment, link: WeaponPoint, tip: WeaponPoint): WeaponSegment[];
