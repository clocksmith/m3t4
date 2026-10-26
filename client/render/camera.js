import { W, H } from './surface.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Presentation only: fit both fighters and live objectives, then zoom up to
// 15%. Derive framing from this frame so replay seeks need no camera history.
export function arenaCamera(frame, execution = null) {
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
  const scale = Math.max(1, Math.min(1.15, (W - 32) / (right - left),
    (H - 128) / (bottom - top)));
  // Bias subjects below the fixed HUD without exposing space outside the arena.
  const centerX = clamp((left + right) / 2, W / (2 * scale), W - W / (2 * scale));
  const centerY = clamp((top + bottom) / 2 - 56 / scale,
    H / (2 * scale), H - H / (2 * scale));
  if (Number.isFinite(execution?.x) && Number.isFinite(execution?.y)) {
    const strength = clamp(execution.strength ?? 0, 0, 1);
    const zoom = scale + (1.9 - scale) * strength;
    const focusX = clamp(centerX + (execution.x - centerX) * strength, W / (2 * zoom), W - W / (2 * zoom));
    const focusY = clamp(centerY + (execution.y - centerY) * strength, H / (2 * zoom), H - H / (2 * zoom));
    return { scale: zoom, x: W / 2 - focusX * zoom, y: H / 2 - focusY * zoom };
  }
  return { scale, x: W / 2 - centerX * scale, y: H / 2 - centerY * scale };
}

export function arenaScreenPoint(camera, point) {
  return { x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y };
}

// Presentation history belongs to one renderer, never the simulation or replay.
// The exact critically damped spring uses elapsed seconds, so 30/60/144 Hz
// displays get the same response. Pull back faster than we push in.
export function createArenaCamera() {
  let view = null;
  let lastTime = null;
  const velocity = { scale: 0, cx: 0, cy: 0 };
  const aim = { scale: 1, cx: W / 2, cy: H / 2 };
  function spring(key, target, speed, dt) {
    const delta = view[key] - target;
    const step = (velocity[key] + speed * delta) * dt;
    const decay = Math.exp(-speed * dt);
    view[key] = target + (delta + step) * decay;
    velocity[key] = (velocity[key] - speed * step) * decay;
  }
  return {
    update(frame, execution = null, nowMs = performance.now(), reducedMotion = false) {
      const target = reducedMotion ? { scale: 1, x: 0, y: 0 } : arenaCamera(frame, execution);
      const desired = {
        scale: target.scale,
        cx: (W / 2 - target.x) / target.scale,
        cy: (H / 2 - target.y) / target.scale,
      };
      if (!view || reducedMotion) {
        view = { ...desired };
        Object.assign(aim, desired);
        velocity.scale = velocity.cx = velocity.cy = 0;
      }
      // Keep real elapsed time down to 10 FPS on phones; cap background gaps.
      const dt = lastTime === null ? 0 : clamp((nowMs - lastTime) / 1000, 0, 0.1);
      lastTime = nowMs;
      // Ignore tiny target fluctuations instead of making the scenery breathe.
      for (const key of ['scale', 'cx', 'cy']) {
        const threshold = key === 'scale' ? 0.003 : 3;
        if (execution || Math.abs(desired[key] - aim[key]) > threshold) aim[key] = desired[key];
      }
      spring('scale', aim.scale, aim.scale < view.scale ? 14 : execution ? 22 : 5.5, dt);
      spring('cx', aim.cx, execution ? 18 : 9, dt);
      spring('cy', aim.cy, execution ? 18 : 9, dt);
      view.scale = clamp(view.scale, 1, 1.9);
      view.cx = clamp(view.cx, W / (2 * view.scale), W - W / (2 * view.scale));
      view.cy = clamp(view.cy, H / (2 * view.scale), H - H / (2 * view.scale));
      return { scale: view.scale, x: W / 2 - view.cx * view.scale, y: H / 2 - view.cy * view.scale };
    },
    reset() { view = null; lastTime = null; velocity.scale = velocity.cx = velocity.cy = 0; },
  };
}
