// Calibration of the existing 64px body cells and 48px weapon atlas art.
// These are presentation-only: collision comes from sim/combat-geometry.js.
export const BODY_FRAME_ORIGINS = {
  sama: {
    idle: [[32,63],[32,63],[32,63],[32,63]],
    run: [[31,63],[31,63],[30,62],[32,63],[35,63,-1],[32,63,-1]],
    wallSlide: [[32,63],[32,63,-1]],
    swing: [[32,63],[32,63],[32,63],[32,63],[33,63],[33,63]],
    ko: [[32,63],[32,62],[32,62],[32,53]],
  },
  darrius: {
    idle: [[30,62],[31,62],[33,62],[34,62]],
    run: [[30,63],[30,63],[33,63],[33,63],[37,63],[34,63]],
    swing: [[30,62],[30,62],[33,62],[34,62],[35,62],[34,62]],
  },
  demis: {
    idle: [[31,63],[31,63],[31,63],[32,63]],
    run: [[33,63],[33,63],[33,62],[32,62],[33,63],[32,63]],
    // Cells 1–3 have a baked slash that disagrees with the live weapon arc.
    // Use the clean anticipation/recovery poses; the renderer supplies the arc.
    swing: [[32,63,1,0],[32,63,1,0],[33,63,1,4],[33,63,1,4],[32,63,1,5],[32,63,1,5]],
  },
  mark: {
    idle: [[32,63],[32,63],[32,63],[32,63]],
    run: [[32,63],[32,63],[32,63],[32,63],[32,63],[31,63]],
    wallSlide: [[32,63],[32,63,-1]],
    ko: [[32,63],[32,63],[32,63],[32,62]],
  },
};

export function bodyFramePlacement(body, anim, frame, { grounded = false, dead = false } = {}) {
  const entry = BODY_FRAME_ORIGINS[body]?.[anim]?.[frame];
  const fallbackFoot = body === 'darrius' ? 62 : 63;
  return {
    rootX: entry?.[0] ?? 32,
    // Grounded poses plant their feet. Air poses keep a stable body origin.
    footY: grounded || dead ? entry?.[1] ?? fallbackFoot : fallbackFoot,
    sourceFacing: entry?.[2] ?? 1,
    sourceFrame: entry?.[3] ?? frame,
    // Exclude generated border/separator contamination without resampling art.
    crop: { x: 1, y: 1, w: 62, h: 62 },
  };
}

const point = (gripX, gripY, tipX, tipY, crop = [1, 1, 46, 46], aspect = 1) => ({ gripX, gripY, tipX, tipY, crop, aspect });
export const WEAPON_ART = {
  sama: [point(38,8,5,44), point(10,37,36,11), point(5,42,44,2), point(5,42,40,6,[1,1,42,46])],
  darrius: [point(5,24,45,24,[2,18,45,13]), point(11,24,38,24,[8,21,33,11]), point(3,24,45,24,[1,19,46,13]), point(5,24,45,24,[1,16,46,16])],
  demis: [point(4,40,45,34,[1,1,46,46],0.45), point(3,23,45,23,[1,11,46,26]), point(4,23,46,23,[1,11,46,25]), point(3,23,46,22,[1,15,46,17])],
  mark: [point(5,41,46,7), point(10,35,46,11,[1,1,46,46],0.9), point(5,41,43,3), point(5,16,46,35,[1,1,46,46],0.8)],
};

// Map calibrated grip->tip onto the authoritative segment. Mirror in local X
// before rotating so a left-facing weapon is mirrored, not upside down.
// Bent flails compress only across their axis; reach and endpoint never change.
export function weaponArtTransform(segment, art, facing) {
  const ax = art.tipX - art.gripX;
  const ay = art.tipY - art.gripY;
  const sourceLength = Math.hypot(ax, ay);
  const mirror = facing < 0 ? -1 : 1;
  return {
    x: segment.bx, y: segment.by, mirror,
    scale: Math.hypot(segment.tx - segment.bx, segment.ty - segment.by) / sourceLength,
    worldAngle: Math.atan2(segment.ty - segment.by, segment.tx - segment.bx),
    sourceAngle: Math.atan2(ay, ax * mirror),
    aspect: art.aspect,
  };
}
