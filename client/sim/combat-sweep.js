// Version 2 continuous combat within a fixed simulation tick. Only collision
// queries are subdivided; movement integration, brains and timers still run once.
import { fighterHurtbox, weaponHitSegments, weaponSegmentsClash, weaponSegmentsIntersect, WEAPON_CLASH_TIP_DISTANCE } from './combat-geometry.js';
import { articulatedWeaponPose, attackDuration, weaponProfile, weaponDamageSegments } from './weapon-kinematics.js';
const empty = () => ({ clash: false, hitA: false, hitB: false });
const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function distance(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function inTriangle(p, a, b, c) {
    if (Math.abs(cross(a, b, c)) < 1e-12)
        return false;
    const d = [cross(a, b, p), cross(b, c, p), cross(c, a, p)];
    return d.every(n => n >= 0) || d.every(n => n <= 0);
}
const ends = (s) => [{ x: s.bx, y: s.by }, { x: s.tx, y: s.ty }];
// Sweep the full damaging segment/capsule, including a flexible weapon's head.
// Relative coordinates include target movement, not just the weapon trajectory.
export function sweptSwordHits(start, end, targetStart, targetEnd) {
    const h0 = fighterHurtbox(targetStart), h1 = fighterHurtbox(targetEnd);
    const [a, b] = ends(start).map(p => ({ x: p.x - h0.x, y: p.y - h0.y }));
    const [d, c] = ends(end).map(p => ({ x: p.x - h1.x, y: p.y - h1.y }));
    const origin = { x: 0, y: 0 }, radius = h0.radius + Math.max(start.radius ?? 0, end.radius ?? 0);
    return inTriangle(origin, a, b, c) || inTriangle(origin, a, c, d)
        || [[a, b], [b, c], [c, d], [d, a]].some(([p, q]) => distance(origin, p, q) <= radius);
}
function clash(a0, a1, b0, b1) {
    if (weaponSegmentsClash(a0, b0) || weaponSegmentsClash(a1, b1))
        return true;
    // Continuous relative tip path retains the established clash tolerance.
    const p = { x: a0.tx - b0.tx, y: a0.ty - b0.ty }, q = { x: a1.tx - b1.tx, y: a1.ty - b1.ty };
    if (distance({ x: 0, y: 0 }, p, q) < WEAPON_CLASH_TIP_DISTANCE + (a0.radius ?? 0) + (b0.radius ?? 0))
        return true;
    // Catch a blade crossing another between samples, including interior contact.
    const [a, b] = ends(a0), [d, c] = ends(a1), mid = { bx: (b0.bx + b1.bx) / 2, by: (b0.by + b1.by) / 2, tx: (b0.tx + b1.tx) / 2, ty: (b0.ty + b1.ty) / 2 };
    return [[a, b], [b, c], [c, d], [d, a]].some(([p, q]) => weaponSegmentsIntersect({ bx: p.x, by: p.y, tx: q.x, ty: q.y }, mid));
}
function startTimer(before, after, key, step) {
    return before[key] > 0 ? before[key] : after[key] > 0 ? after[key] + step : 0;
}
function at(before, after, t, step) {
    return { ...after, x: before.x + (after.x - before.x) * t, y: before.y + (after.y - before.y) * t,
        swipeT: Math.max(0, startTimer(before, after, 'swipeT', step) - step * t),
        diveT: Math.max(0, startTimer(before, after, 'diveT', step) - step * t) };
}
function segments(p, activePose) {
    const active = articulatedWeaponPose(activePose), pose = articulatedWeaponPose(p);
    if (!pose || !active)
        return weaponHitSegments(p);
    return weaponDamageSegments(pose.spec.kind, active.active, pose.segment, pose.link, pose.tip);
}
function canDamage(before, after, step) {
    const spec = weaponProfile(after);
    if (!spec)
        return true; // Historical passive foil.
    if (before.diveT > 0 || after.diveT > 0)
        return true;
    const timer = startTimer(before, after, 'swipeT', step);
    return timer > 0 && timer >= spec.duration * (1 - spec.strikeEnd)
        && timer - step <= spec.duration * (1 - spec.windup);
}
export function sweptCombatContact(before, after, step) {
    if (!canDamage(before[0], after[0], step) && !canDamage(before[1], after[1], step))
        return empty();
    // Bound curved motion with deterministic short linear sweeps, splitting at
    // exact active-window boundaries so windup/recovery never gain damage.
    const times = new Set(Array.from({ length: 17 }, (_, i) => i / 16));
    for (let side = 0; side < 2; side++) {
        const spec = weaponProfile(after[side]);
        if (!spec)
            continue;
        const timer = startTimer(before[side], after[side], 'swipeT', step);
        if (timer <= 0)
            continue;
        for (const progress of [spec.windup, spec.strikeEnd, 1]) {
            const t = (timer - attackDuration(after[side]) * (1 - progress)) / step;
            if (t > 0 && t < 1)
                times.add(t);
        }
    }
    const sorted = [...times].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
        const lo = sorted[i - 1], hi = sorted[i], mid = (lo + hi) / 2;
        const a0 = at(before[0], after[0], lo, step), a1 = at(before[0], after[0], hi, step);
        const b0 = at(before[1], after[1], lo, step), b1 = at(before[1], after[1], hi, step);
        const am = at(before[0], after[0], mid, step), bm = at(before[1], after[1], mid, step);
        const sa0 = segments(a0, am), sa1 = segments(a1, am), sb0 = segments(b0, bm), sb1 = segments(b1, bm);
        if (sa0.some((a, n) => sb0.some((b, m) => clash(a, sa1[n], b, sb1[m]))))
            return { clash: true, hitA: false, hitB: false };
        const hitA = sa0.some((a, n) => sweptSwordHits(a, sa1[n], b0, b1));
        const hitB = sb0.some((b, n) => sweptSwordHits(b, sb1[n], a0, a1));
        if (hitA || hitB)
            return { clash: false, hitA, hitB };
    }
    return empty();
}
