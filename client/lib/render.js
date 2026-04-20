// Shared canvas renderer. Takes a TraceFrame (from sim) + stage and draws
// the scene. Used by both Spectate (server frames) and Practice (local).

import { STAGES, STATS, GOAL_TIMER_START } from "../sim/index.js";

export const W = 1280;
export const H = 720;

function cssColor(name, fallback = "black") {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function hexToRgb(hex, fallback) {
  const raw = String(hex || "").trim();
  const short = /^#([0-9a-f]{3})$/i.exec(raw);
  if (short) {
    return short[1].split("").map((ch) => parseInt(ch + ch, 16));
  }
  const long = /^#([0-9a-f]{6})$/i.exec(raw);
  if (long) {
    return [
      parseInt(long[1].slice(0, 2), 16),
      parseInt(long[1].slice(2, 4), 16),
      parseInt(long[1].slice(4, 6), 16),
    ];
  }
  return fallback;
}

function cssRgb(name, fallback) {
  return hexToRgb(cssColor(name, ""), fallback);
}

function fighterPalette(side) {
  const prefix = side === 0 ? "--arena-p1" : "--arena-p2";
  return {
    body: cssColor(prefix, side === 0 ? "mediumaquamarine" : "sandybrown"),
    trim: cssColor(`${prefix}-trim`, "white"),
    shadow: cssColor(`${prefix}-shadow`, "black"),
  };
}

const CHARACTER_SPRITES = [
  {
    url: "assets/chars/sama/monastic_infra/sprite.png",
    frameW: 64,
    frameH: 64,
    anims: spriteAnims(),
  },
  {
    url: "assets/chars/darrius/legal_department_midnight/sprite.png",
    frameW: 64,
    frameH: 64,
    anims: spriteAnims(),
  },
];

const WEAPON_SHEETS = [
  { url: "assets/weapons/sama/launch.png", frameW: 48, frameH: 48, cell: 0 },
  { url: "assets/weapons/darrius/launch.png", frameW: 48, frameH: 48, cell: 0 },
];

const spriteState = CHARACTER_SPRITES.map((kit) => ({
  kit,
  image: null,
  loaded: false,
  failed: false,
  anim: "idle",
  startTick: 0,
  lastTick: null,
  lastX: null,
  lastY: null,
}));

const weaponState = WEAPON_SHEETS.map((kit) => ({
  ...imageState(kit.url),
  kit,
}));

const OBJECTIVE_IMAGES = {
  payload: imageState("assets/objectives/proof_core/payload.png"),
  target: imageState("assets/objectives/demand_node/target.png"),
};

function imageState(url) {
  return { url, image: null, loaded: false, failed: false };
}

function loadImage(state) {
  if (state.failed) return null;
  if (state.loaded) return state.image;
  if (!state.image && typeof Image !== "undefined") {
    const img = new Image();
    img.onload = () => { state.loaded = true; };
    img.onerror = () => { state.failed = true; };
    img.src = state.url;
    state.image = img;
  }
  return state.loaded ? state.image : null;
}

function spriteAnims() {
  return {
    idle:      { row: 0, frames: 4, fps: 6,  loop: true  },
    run:       { row: 1, frames: 6, fps: 12, loop: true  },
    jump:      { row: 2, frames: 2, fps: 10, loop: false },
    fall:      { row: 3, frames: 2, fps: 10, loop: false },
    wallSlide: { row: 4, frames: 2, fps: 8,  loop: true  },
    dive:      { row: 5, frames: 2, fps: 12, loop: false },
    swing:     { row: 6, frames: 6, fps: 60, loop: false },
    hit:       { row: 7, frames: 3, fps: 20, loop: false },
    ko:        { row: 8, frames: 4, fps: 10, loop: false },
    carry:     { row: 9, frames: 2, fps: 4,  loop: true  },
    taunt:     { row: 10, frames: 4, fps: 8, loop: false },
    victory:   { row: 11, frames: 4, fps: 8, loop: true  },
  };
}

function spriteImage(state) {
  state.url = state.kit.url;
  return loadImage(state);
}

export function setupCanvas(canvas) {
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = false;
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    // Fit the canvas to its parent column (or the viewport, whichever
    // is smaller) while preserving the 16:9 internal aspect. Falling
    // back to viewport width was fine for the old full-width layouts
    // (spectate/practice) but caused the canvas to overflow narrow
    // columns in the build page grid.
    const parent = canvas.parentElement;
    const parentW = parent ? parent.clientWidth : Infinity;
    const viewportW = document.documentElement.clientWidth - 40;
    const cssW = Math.max(160, Math.min(W, parentW || viewportW, viewportW));
    const cssH = cssW * (H / W);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = Math.round(cssW) + "px";
    canvas.style.height = Math.round(cssH) + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }
  window.addEventListener("resize", resize);
  // The parent column can reflow even when the window doesn't (grid
  // layouts, dev-tools docking). A ResizeObserver on the parent keeps
  // the canvas consistent with its available space.
  let ro = null;
  if (typeof ResizeObserver !== "undefined" && canvas.parentElement) {
    ro = new ResizeObserver(() => resize());
    ro.observe(canvas.parentElement);
  }
  resize();
  return { ctx, resize, teardown: () => { window.removeEventListener("resize", resize); ro?.disconnect(); } };
}

export function drawFrame(ctx, stage, frame, labels) {
  const p1 = fighterPalette(0);
  const p2 = fighterPalette(1);
  ctx.fillStyle = cssColor("--arena-bg");
  ctx.fillRect(0, 0, W, H);
  drawStage(ctx, stage);
  drawGoal(ctx, frame.goal);
  drawToken(ctx, frame.token);
  drawFighter(ctx, frame.p0, p1.body, p1.trim, p1.shadow, 0, frame);
  drawFighter(ctx, frame.p1, p2.body, p2.trim, p2.shadow, 1, frame);
  drawHUD(ctx, frame, labels, p1.body, p2.body);
}

function drawStage(ctx, stage) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, cssColor("--arena-sky-top"));
  g.addColorStop(0.5, cssColor("--arena-sky-mid"));
  g.addColorStop(1, cssColor("--arena-sky-bottom"));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (const p of stage.platforms) {
    ctx.fillStyle = p.solid ? cssColor("--arena-platform-solid") : cssColor("--arena-platform-soft");
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = cssColor("--arena-platform-highlight", "white");
    ctx.fillRect(p.x, p.y, p.w, 3);
  }
}

// Goal ring = radial countdown. Starts full, sweeps down as the
// GOAL_TIMER_START-second window drains. Theme blue until the last
// 20% (2s at the default 10s window), then interpolates to red so
// the player can feel a close deadline without reading numbers.
const GOAL_URGENT_FRAC = 0.20;
const GOAL_NORMAL_RGB = [96, 165, 250];
const GOAL_URGENT_RGB = [239, 68, 68];

function goalRingColor(fracRemaining) {
  // Constant blue until we enter the urgent window, then lerp blue -> red
  // as the remaining fraction goes from GOAL_URGENT_FRAC -> 0.
  const normal = cssRgb("--arena-goal-normal", GOAL_NORMAL_RGB);
  const urgent = cssRgb("--arena-goal-urgent", GOAL_URGENT_RGB);
  if (fracRemaining >= GOAL_URGENT_FRAC) return normal;
  const t = 1 - (fracRemaining / GOAL_URGENT_FRAC); // 0 at threshold, 1 at 0s
  const r = Math.round(normal[0] + (urgent[0] - normal[0]) * t);
  const g = Math.round(normal[1] + (urgent[1] - normal[1]) * t);
  const b = Math.round(normal[2] + (urgent[2] - normal[2]) * t);
  return [r, g, b];
}

function drawGoal(ctx, goal) {
  if (!goal.exists) return;
  const timer = Math.max(0, Number(goal.timer ?? GOAL_TIMER_START));
  const frac = Math.min(1, timer / GOAL_TIMER_START);
  const [r, g, b] = goalRingColor(frac);
  const urgent = frac < GOAL_URGENT_FRAC;
  const pulse = 1 + Math.sin(Date.now() * (urgent ? 0.02 : 0.008)) * (urgent ? 0.18 : 0.06);

  ctx.save();
  ctx.translate(goal.x, goal.y);

  const targetImg = loadImage(OBJECTIVE_IMAGES.target);
  if (targetImg) {
    ctx.imageSmoothingEnabled = false;
    // Art is a 96px receiver with the floor ring low in the frame.
    // Anchor that ring to the sim goal point; countdown rings then
    // overlay the actual scoring coordinate.
    ctx.drawImage(targetImg, -48, -72, 96, 96);
  }

  // Outer glow halo — faint, tinted by current urgency color.
  ctx.fillStyle = `rgba(${r},${g},${b},0.08)`;
  ctx.beginPath();
  ctx.arc(0, 0, 60 * pulse, 0, Math.PI * 2);
  ctx.fill();

  // Dim background track so the radial sweep reads even at low time.
  ctx.strokeStyle = `rgba(${r},${g},${b},0.15)`;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(0, 0, 28, 0, Math.PI * 2);
  ctx.stroke();

  // Radial countdown arc: starts at 12 o'clock (−π/2), sweeps clockwise,
  // length proportional to remaining time.
  const start = -Math.PI / 2;
  const end = start + Math.PI * 2 * frac;
  ctx.strokeStyle = `rgba(${r},${g},${b},0.95)`;
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(0, 0, 28, start, end);
  ctx.stroke();

  // Intake ring (the smaller "still accepts tender" core).
  ctx.strokeStyle = `rgba(${r},${g},${b},0.7)`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, 16 * pulse, 0, Math.PI * 2);
  ctx.stroke();

  // Label above, tracking color so urgency reads even without the arc.
  ctx.fillStyle = `rgba(${r},${g},${b},0.92)`;
  ctx.font = "700 13px monospace";
  ctx.textAlign = "center";
  ctx.fillText(goal.label, 0, -42);
  ctx.restore();
}

function drawToken(ctx, t) {
  if (!t.exists) return;
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.fillStyle = cssColor("--arena-token-glow", "yellow");
  ctx.beginPath();
  ctx.arc(0, 0, 18, 0, Math.PI * 2);
  ctx.fill();
  const payloadImg = loadImage(OBJECTIVE_IMAGES.payload);
  if (payloadImg) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(payloadImg, -24, -24, 48, 48);
  } else {
    ctx.fillStyle = cssColor("--arena-token", "gold");
    ctx.beginPath();
    ctx.moveTo(0, -10); ctx.lineTo(7, 0); ctx.lineTo(0, 10); ctx.lineTo(-7, 0);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function drawFighter(ctx, f, col, trim, shadow, side, frame) {
  if (f.dead) {
    drawSpriteFighter(ctx, f, side, frame);
    updateSpriteMotion(side, f, frame);
    return;
  }
  const drewSprite = drawSpriteFighter(ctx, f, side, frame);
  if (!drewSprite) drawPrimitiveBody(ctx, f, col, trim, shadow);
  drawSword(ctx, f, shadow, side);
  updateSpriteMotion(side, f, frame);
}

function drawSpriteFighter(ctx, f, side, frame) {
  const state = spriteState[side];
  if (!state) return false;
  const img = spriteImage(state);
  if (!img) return false;

  const animName = chooseSpriteAnim(f, side, frame);
  if (state.anim !== animName) {
    state.anim = animName;
    state.startTick = frame.tick ?? 0;
  }
  const anim = state.kit.anims[animName] ?? state.kit.anims.idle;
  const frameIdx = spriteFrameIndex(animName, anim, f, frame, state);
  const sx = frameIdx * state.kit.frameW;
  const sy = anim.row * state.kit.frameH;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(Math.round(f.x), Math.round(f.y));
  // Source sheets face camera-right. Facing left is a horizontal flip.
  // Do not flip Y; canvas Y grows downward and a Y flip would invert the body.
  if (f.facing < 0) ctx.scale(-1, 1);
  ctx.drawImage(
    img,
    sx, sy, state.kit.frameW, state.kit.frameH,
    -state.kit.frameW / 2, -state.kit.frameH / 2,
    state.kit.frameW, state.kit.frameH
  );
  ctx.restore();
  return true;
}

function chooseSpriteAnim(f, side, frame) {
  if (f.dead) return "ko";
  if ((f.stun ?? 0) > 0) return "hit";
  if (f.diveT > 0) return "dive";
  if (f.swipeT > 0) return "swing";
  if (frame.token?.carrier === side) return "carry";

  if (typeof f.onGround === "boolean" && typeof f.vy === "number") {
    if (f.wall && !f.onGround) return "wallSlide";
    if (!f.onGround && f.vy < -20) return "jump";
    if (!f.onGround && f.vy > 20) return "fall";
    if (Math.abs(f.vx ?? 0) > 20) return "run";
    return "idle";
  }

  // Backward-compatible fallback for old trace streams that only carried x/y.
  const state = spriteState[side];
  const dx = state?.lastX == null ? 0 : f.x - state.lastX;
  const dy = state?.lastY == null ? 0 : f.y - state.lastY;
  if (dy < -0.8) return "jump";
  if (dy > 0.8) return "fall";
  if (Math.abs(dx) > 0.8) return "run";
  return "idle";
}

function spriteFrameIndex(animName, anim, f, frame, state) {
  if (animName === "swing" && STATS.swipeTime > 0) {
    const progress = 1 - Math.max(0, Math.min(1, f.swipeT / STATS.swipeTime));
    return Math.max(0, Math.min(anim.frames - 1, Math.floor(progress * anim.frames)));
  }
  const ticksPerFrame = Math.max(1, Math.round(120 / anim.fps));
  const elapsed = Math.max(0, (frame.tick ?? 0) - state.startTick);
  const idx = Math.floor(elapsed / ticksPerFrame);
  return anim.loop ? idx % anim.frames : Math.min(anim.frames - 1, idx);
}

function updateSpriteMotion(side, f, frame) {
  const state = spriteState[side];
  if (!state) return;
  state.lastTick = frame.tick ?? null;
  state.lastX = f.x;
  state.lastY = f.y;
}

function drawPrimitiveBody(ctx, f, col, trim, shadow) {
  const bw = STATS.bodyW;
  const bh = STATS.bodyH;
  ctx.strokeStyle = shadow;
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(f.x, f.y - bh * 0.5);
  ctx.lineTo(f.x, f.y + bh * 0.06);
  ctx.stroke();
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(f.x, f.y - bh * 0.66, bw * 0.36, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = trim;
  ctx.fillRect(f.x - bw * 0.48, f.y - bh * 0.54, bw * 0.96, bh * 0.74);
}

function drawSword(ctx, f, shadow, side) {
  const bw = STATS.bodyW;
  const bh = STATS.bodyH;
  // Sword
  const active = f.swipeT > 0 || f.diveT > 0;
  const bx = f.x + f.facing * bw * 0.35;
  const by = f.y - bh * 0.3;
  let angle = 0;
  if (f.diveT > 0) angle = Math.PI * 0.46;
  else if (f.swipeT > 0) {
    const t = 1 - f.swipeT / STATS.swipeTime;
    // Upward anti-air slash: horizontal-forward → ~57° up (must match sim/swordSeg).
    const ease = 1 - (1 - t) ** 3;
    angle = 0.0 + (-1.0 - 0.0) * ease;
  }
  const dx = Math.cos(angle) * f.facing;
  const dy = Math.sin(angle);
  const len = STATS.sword;
  const tx = bx + dx * len;
  const ty = by + dy * len;
  if (drawWeaponSprite(ctx, side, bx, by, tx, ty, active)) return;

  // Foil is ALWAYS extended. Active (swipe/dive) = bright + glow; idle = softer.
  if (active) {
    ctx.strokeStyle = cssColor("--arena-weapon-glow", "white");
    ctx.lineWidth = 12;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tx, ty); ctx.stroke();
  }
  ctx.strokeStyle = active
    ? (f.diveT > 0 ? cssColor("--arena-weapon-dive", "white") : cssColor("--arena-weapon-active", "white"))
    : cssColor("--arena-weapon-idle", "lightgray");
  ctx.lineWidth = active ? (f.diveT > 0 ? 7 : 6) : 4;
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tx, ty); ctx.stroke();
  ctx.fillStyle = active ? cssColor("--arena-weapon-active", "white") : cssColor("--arena-weapon-tip-idle", "lightgray");
  ctx.beginPath(); ctx.arc(tx, ty, active ? 4 : 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = shadow;
  ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2); ctx.fill();
}

function drawWeaponSprite(ctx, side, bx, by, tx, ty, active) {
  const state = weaponState[side];
  if (!state) return false;
  const img = loadImage(state);
  if (!img) return false;

  const kit = state.kit;
  const angle = Math.atan2(ty - by, tx - bx);
  const scale = active ? 1.12 : 0.96;
  const dw = kit.frameW * scale;
  const dh = kit.frameH * scale;

  if (active) {
    ctx.save();
    ctx.strokeStyle = cssColor("--arena-weapon-glow", "white");
    ctx.lineWidth = 12;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(bx, by);
  ctx.rotate(angle);
  ctx.globalAlpha = active ? 1 : 0.78;
  ctx.drawImage(
    img,
    kit.cell * kit.frameW, 0, kit.frameW, kit.frameH,
    -6, -dh / 2,
    dw, dh
  );
  ctx.restore();
  return true;
}

function drawHUD(ctx, frame, labels, p1Color, p2Color) {
  const L = labels || {};
  ctx.font = "700 20px monospace";
  ctx.fillStyle = p1Color;
  ctx.textAlign = "left";
  ctx.fillText(L.p1 || "P1", 40, 36);
  ctx.fillStyle = p2Color;
  ctx.textAlign = "right";
  ctx.fillText(L.p2 || "P2", W - 40, 36);

  ctx.font = "700 44px monospace";
  ctx.fillStyle = cssColor("--arena-hud-text", "white");
  ctx.textAlign = "left";
  ctx.fillText(String(frame.scoreboard[0]), 48, 88);
  ctx.textAlign = "right";
  ctx.fillText(String(frame.scoreboard[1]), W - 48, 88);

  // Round dots
  ctx.font = "600 14px monospace";
  ctx.fillStyle = cssColor("--arena-hud-soft", "white");
  const dots0 = Array.from({ length: 2 }, (_, i) => (i < frame.rounds[0] ? "\u25CF" : "\u25CB")).join(" ");
  const dots1 = Array.from({ length: 2 }, (_, i) => (i < frame.rounds[1] ? "\u25CF" : "\u25CB")).join(" ");
  ctx.textAlign = "left";
  ctx.fillText(dots0, 50, 108);
  ctx.textAlign = "right";
  ctx.fillText(dots1, W - 50, 108);

  if (L.tick !== undefined) {
    ctx.font = "500 12px monospace";
    ctx.fillStyle = cssColor("--arena-idle-text", "gray");
    ctx.textAlign = "center";
    ctx.fillText(`tick ${frame.tick ?? L.tick}`, W / 2, 24);
  }
}
