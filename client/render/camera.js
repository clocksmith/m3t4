import { W, H } from './surface.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Presentation only: fit both fighters and live objectives, then zoom up to
// 25%. Derive framing from this frame so replay seeks need no camera history.
export function arenaCamera(frame) {
  const bounds = [];
  for (const fighter of [frame?.p0, frame?.p1]) {
    if (!Number.isFinite(fighter?.x) || !Number.isFinite(fighter?.y)) continue;
    // Include nameplates, articulated weapons, and feet in either facing.
    bounds.push({ left: fighter.x - 80, right: fighter.x + 80,
      top: fighter.y - 96, bottom: fighter.y + 44 });
  }
  if (!bounds.length) return { scale: 1, x: 0, y: 0 };
  for (const objective of [frame?.goal, frame?.token]) {
    if (!objective?.exists || objective.carrier >= 0
      || !Number.isFinite(objective.x) || !Number.isFinite(objective.y)) continue;
    bounds.push({ left: objective.x - 36, right: objective.x + 36,
      top: objective.y - 36, bottom: objective.y + 36 });
  }
  const left = Math.min(...bounds.map(b => b.left));
  const right = Math.max(...bounds.map(b => b.right));
  const top = Math.min(...bounds.map(b => b.top));
  const bottom = Math.max(...bounds.map(b => b.bottom));
  const scale = Math.max(1, Math.min(1.25, (W - 32) / (right - left),
    (H - 128) / (bottom - top)));
  // Bias subjects below the fixed HUD without exposing space outside the arena.
  const centerX = clamp((left + right) / 2, W / (2 * scale), W - W / (2 * scale));
  const centerY = clamp((top + bottom) / 2 - 56 / scale,
    H / (2 * scale), H - H / (2 * scale));
  return { scale, x: W / 2 - centerX * scale, y: H / 2 - centerY * scale };
}

export function arenaScreenPoint(camera, point) {
  return { x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y };
}
