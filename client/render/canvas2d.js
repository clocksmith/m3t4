import { BODY_PORTRAIT_SHEETS } from "../content/character-presentation.js";
import { drawStageScenery } from "./stage-art.js";
import { drawGoalHoldRing } from "./goal-progress.js";
import { imageState, loadImage } from "./image-assets.js";
import { swordSeg, fighterHurtbox } from "../sim/combat-geometry.js";
import { DOUBLE_KO_RESPAWN_S } from "../sim/constants.js";
import { bodyFramePlacement, WEAPON_ART, weaponArtTransform } from "./fighter-art.js";
// Shared canvas renderer. Takes a TraceFrame (from sim) + stage and draws
// the scene. Used by both Spectate (server frames) and Practice (local).

import {
  STAGES,
  STATS,
  GOAL_TIMER_START,
  POINTS_TO_WIN_ROUND,
  ROUNDS_TO_WIN_MATCH,
  ROUND_TIMER_MAX_TICKS,
  SIM_HZ,
} from "../lib/public-sim.js";
import { H, W, setupCanvasSurface } from "./surface.js";
import rosterCatalog from "../content/roster-catalog.v1.json" with { type: "json" };

export { H, W };

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

// Body atlas identity and animation timing. Per-frame calibration lives in fighter-art.
const CHARACTER_SPRITES = [
  ["sama", {
    url: "assets/chars/sama/monastic_infra/sprite.png",
    frameW: 64,
    frameH: 64,
    anims: spriteAnims(),
  }],
  ["darrius", {
    url: "assets/chars/darrius/legal_department_midnight/sprite.png",
    frameW: 64,
    frameH: 64,
    anims: spriteAnims(),
  }],
  ["demis", {
    url: "assets/chars/demis/chalk_and_static/sprite.png",
    frameW: 64,
    frameH: 64,
    anims: spriteAnims(),
  }],
  ["mark", {
    url: "assets/chars/mark/wellness_berserker/sprite.png",
    frameW: 64,
    frameH: 64,
    anims: spriteAnims(),
  }],
  ["jensen", { url: "assets/chars/jensen/silicon_sovereign/sprite.png", frameW: 64, frameH: 64, anims: spriteAnims() }],
  ["elon", { url: "assets/chars/elon/orbital_showman/sprite.png", frameW: 64, frameH: 64, anims: spriteAnims() }],
];

const BODY_KITS = Object.fromEntries(CHARACTER_SPRITES);
const DEFAULT_BODIES = ["sama", "darrius"];
const DEFAULT_WEAPONS = Object.fromEntries(
  rosterCatalog.bodies.map((body) => [
    body,
    (rosterCatalog.weapons[body] ?? []).find((weapon) => weapon.available)?.id,
  ]),
);

const AVAILABLE_WEAPONS = Object.fromEntries(
  rosterCatalog.bodies.map((body) => [
    body,
    (rosterCatalog.weapons[body] ?? [])
      .filter((weapon) => weapon.available)
      .map((weapon) => weapon.id),
  ]),
);

const WEAPON_SHEETS = Object.fromEntries(
  rosterCatalog.bodies.map((body) => [
    body,
    Object.fromEntries((rosterCatalog.weapons[body] ?? [])
      .filter((weapon) => weapon.available && weapon.asset)
      .map((weapon) => [weapon.id, weapon.asset])),
  ]),
);

const PORTRAIT_SHEETS = Object.fromEntries(Object.entries(BODY_PORTRAIT_SHEETS).map(([body,url]) => [body,{url,cellW:96,cellH:96}]));
const HUD_PORTRAIT_CELL = {
  neutral: 0, // top-left: neutral head/shoulders
  hurt: 1,    // top-right: hurt head/shoulders
  ko: 2,      // bottom-left: KO head/shoulders
  fullBody: 3, // bottom-right: full-body character-select portrait
};
const HUD_HURT_HOLD_TICKS = Math.round(0.24 * SIM_HZ);
const HUD_KO_HOLD_TICKS = Math.round(0.42 * SIM_HZ);

const characterImages = Object.fromEntries(Object.entries(BODY_KITS).map(([body, kit]) => [
  body,
  { ...imageState(kit.url), kit },
]));

const createSpriteState = () => DEFAULT_BODIES.map((bodyId) => ({
  bodyId,
  kit: BODY_KITS[bodyId],
  pose: null,
}));

const renderStateByContext = new WeakMap();
let spriteState = createSpriteState();
const weaponState = new Map();
const portraitState = new Map(Object.entries(PORTRAIT_SHEETS).map(([body, kit]) => [body, { ...imageState(kit.url), kit }]));
let hudPortraitState = [hudPortraitInitialState(), hudPortraitInitialState()];
let sideCosmetics = DEFAULT_BODIES.map((body) => ({ body, weapon: DEFAULT_WEAPONS[body] }));

const OBJECTIVE_IMAGES = {
  payload: imageState("assets/objectives/proof_core/payload.png"),
  target: imageState("assets/objectives/demand_node/target.png"),
};

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
  const primary = characterImages[state.bodyId] ?? characterImages[DEFAULT_BODIES[0]];
  const img = loadImage(primary);
  if (img) {
    state.kit = primary.kit;
    state.artBodyId = state.bodyId;
    return img;
  }
  if (!primary.failed) return null;

  const fallbackBody = DEFAULT_BODIES[state.bodyId === DEFAULT_BODIES[0] ? 1 : 0] ?? DEFAULT_BODIES[0];
  const fallback = characterImages[fallbackBody];
  const fallbackImg = fallback ? loadImage(fallback) : null;
  if (fallbackImg) {
    state.kit = fallback.kit;
    state.artBodyId = fallbackBody;
  }
  return fallbackImg;
}

function cosmeticsForSide(labels, side) {
  const fallbackBody = DEFAULT_BODIES[side] ?? DEFAULT_BODIES[0];
  const raw = labels?.cosmetics?.[side] ?? labels?.[`p${side + 1}Cosmetics`] ?? {};
  const body = BODY_KITS[raw.body] ? raw.body : fallbackBody;
  const weapon = AVAILABLE_WEAPONS[body]?.includes(raw.weapon) ? raw.weapon : DEFAULT_WEAPONS[body];
  return { body, weapon };
}

export function setupCanvas(canvas) {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas2D renderer requires a 2D canvas context.");
  ctx.imageSmoothingEnabled = false;
  const surface = setupCanvasSurface(canvas, {
    onResize: ({ dpr }) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
    },
  });
  return { ctx, resize: surface.resize, teardown: surface.teardown };
}

export function drawFrame(ctx, stage, frame, labels) {
  let state = renderStateByContext.get(ctx);
  if (!state) {
    state = { sprites: createSpriteState(), portraits: [hudPortraitInitialState(), hudPortraitInitialState()] };
    renderStateByContext.set(ctx, state);
  }
  spriteState = state.sprites;
  hudPortraitState = state.portraits;
  sideCosmetics = [cosmeticsForSide(labels, 0), cosmeticsForSide(labels, 1)];
  const p1 = fighterPalette(0);
  const p2 = fighterPalette(1);
  ctx.fillStyle = cssColor("--arena-bg");
  ctx.fillRect(0, 0, W, H);
  drawStageScenery(ctx, stage, frame, { reducedMotion: labels?.reducedMotion });
  drawGoal(ctx, frame);
  drawToken(ctx, frame.token);
  drawFighter(ctx, frame.p0, p1.body, p1.trim, p1.shadow, 0, frame);
  drawFighter(ctx, frame.p1, p2.body, p2.trim, p2.shadow, 1, frame);
  drawClashFx(ctx, frame);
  drawFighterNameplates(ctx, frame, labels);
  drawHUD(ctx, frame, labels, p1.body, p2.body);
}

export function createCanvas2DRenderer(canvas) {
  const surface = setupCanvas(canvas);
  canvas.dataset.renderer = "canvas2d";
  return {
    backend: "canvas2d",
    capability: "canvas2d",
    canvas,
    ctx: surface.ctx,
    resize: surface.resize,
    drawFrame: (stage, frame, labels) => {
      drawFrame(surface.ctx, stage, frame, labels);
    },
    present2D() {},
    destroy() {
      surface.teardown?.();
    },
  };
}

// Goal ring = radial countdown. Starts full, sweeps down as the
// GOAL_TIMER_START-second window drains. Theme purple until the last
// 20% (2s at the default 10s window), then interpolates to red so
// the player can feel a close deadline without reading numbers.
const GOAL_URGENT_FRAC = 0.20;
const GOAL_NORMAL_RGB = [217, 70, 239];
const GOAL_URGENT_RGB = [239, 68, 68];

function goalRingColor(fracRemaining) {
  // Constant purple until we enter the urgent window, then lerp purple -> red
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

function drawGoal(ctx, frame) {
  const goal = frame.goal;
  if (!goal.exists) return;
  const timer = Math.max(0, Number(goal.timer ?? GOAL_TIMER_START));
  const frac = Math.min(1, timer / GOAL_TIMER_START);
  const [r, g, b] = goalRingColor(frac);
  const urgent = frac < GOAL_URGENT_FRAC;
  const pulse = 1 + Math.sin((frame.tick / SIM_HZ * 1000) * (urgent ? 0.032 : 0.008)) * (urgent ? 0.34 : 0.06);

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
  ctx.fillStyle = `rgba(${r},${g},${b},${urgent ? 0.16 : 0.08})`;
  ctx.beginPath();
  ctx.arc(0, 0, (urgent ? 66 : 60) * pulse, 0, Math.PI * 2);
  ctx.fill();

  // Dim background track so the radial sweep reads even at low time.
  ctx.strokeStyle = `rgba(${r},${g},${b},0.15)`;
  ctx.lineWidth = urgent ? 5 : 4;
  ctx.beginPath();
  ctx.arc(0, 0, 28, 0, Math.PI * 2);
  ctx.stroke();

  // Radial countdown arc: starts at 12 o'clock (−π/2), sweeps clockwise,
  // length proportional to remaining time.
  const start = -Math.PI / 2;
  const end = start + Math.PI * 2 * frac;
  ctx.strokeStyle = `rgba(${r},${g},${b},0.95)`;
  ctx.lineWidth = urgent ? 6 : 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(0, 0, 28, start, end);
  ctx.stroke();

  // Intake ring (the smaller "still accepts tender" core).
  ctx.strokeStyle = `rgba(${r},${g},${b},0.7)`;
  ctx.lineWidth = urgent ? 5 : 3;
  ctx.beginPath();
  ctx.arc(0, 0, 16 * pulse, 0, Math.PI * 2);
  ctx.stroke();

  drawGoalHoldRing(ctx, frame);

  // Label above, tracking color so urgency reads even without the arc.
  ctx.fillStyle = `rgba(${r},${g},${b},0.92)`;
  ctx.font = "700 13px monospace";
  ctx.textAlign = "center";
  ctx.fillText(goal.label, 0, -42);
  ctx.restore();
}

// Render-only smoothing for the Proof Core's displayed position. The
// sim still springs the token at k=28 above the carrier's head, which
// reads as visible jiggle with every walk-bob or jump. We keep the sim
// untouched (no BEHAVIOR_VERSION impact) and low-pass the rendered xy
// at the draw layer. SMOOTH = 1 restores raw sim position; lower values
// calm the bounce without breaking determinism.
// Lower = calmer (more heavy-handed client-side low-pass on the sim's
// spring-attached token position). 0.22 still read as springy; 0.12
// dampens walk-bob jitter and jump overshoot visibly without making
// the token feel laggy. Pure render smoothing — sim is untouched.
const TOKEN_SMOOTH = 0.12;
let tokenRenderX = null;
let tokenRenderY = null;
export function resetTokenSmoothing() { tokenRenderX = tokenRenderY = null; }

function drawToken(ctx, t) {
  if (!t.exists) { tokenRenderX = tokenRenderY = null; return; }
  if (tokenRenderX === null) { tokenRenderX = t.x; tokenRenderY = t.y; }
  tokenRenderX += (t.x - tokenRenderX) * TOKEN_SMOOTH;
  tokenRenderY += (t.y - tokenRenderY) * TOKEN_SMOOTH;
  ctx.save();
  ctx.translate(tokenRenderX, tokenRenderY);
  // 30% reduction vs. the previous 18px glow + 14x20 diamond + 48px PNG.
  // Keeps the source PNG asset 48x48 (future-proof for HUD/collection
  // slots) but renders it at 34x34 in-world.
  ctx.fillStyle = cssColor("--arena-token-glow", "yellow");
  ctx.beginPath();
  ctx.arc(0, 0, 13, 0, Math.PI * 2);
  ctx.fill();
  const payloadImg = loadImage(OBJECTIVE_IMAGES.payload);
  if (payloadImg) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(payloadImg, -17, -17, 34, 34);
  } else {
    ctx.fillStyle = cssColor("--arena-token", "gold");
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(5, 0); ctx.lineTo(0, 7); ctx.lineTo(-5, 0);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function drawFighter(ctx, f, col, trim, shadow, side, frame) {
  if (f.dead) {
    drawSpriteFighter(ctx, f, side, frame);
    return;
  }
  const drewSprite = drawSpriteFighter(ctx, f, side, frame);
  if (!drewSprite) drawPrimitiveBody(ctx, f, col, trim, shadow);
  drawSword(ctx, f, shadow, side, frame);
  drawCombatDebug(ctx, f);
}

// Character sprites render at native sheet size. Fighter scale belongs in
// the sim hitbox and art prompt contract, not a hidden renderer multiplier.
const CLASH_VISUAL_TICKS = 10;

function drawSpriteFighter(ctx, f, side, frame) {
  const state = spriteState[side];
  if (!state) return false;
  const selectedBody = sideCosmetics[side]?.body ?? DEFAULT_BODIES[side] ?? DEFAULT_BODIES[0];
  if (state.bodyId !== selectedBody) {
    state.bodyId = selectedBody;
    state.kit = BODY_KITS[selectedBody] ?? BODY_KITS[DEFAULT_BODIES[side] ?? DEFAULT_BODIES[0]];
    state.pose = null;
  }
  const img = spriteImage(state);
  if (!img) {
    state.pose = null;
    return false;
  }

  const animName = chooseSpriteAnim(f, side, frame);
  const anim = state.kit.anims[animName] ?? state.kit.anims.idle;
  const frameIdx = spriteFrameIndex(animName, anim, f, frame);
  const placement = bodyFramePlacement(state.artBodyId ?? state.bodyId, animName, frameIdx, { grounded: f.onGround, dead: f.dead });
  const { crop } = placement;
  const sx = placement.sourceFrame * state.kit.frameW + crop.x;
  const sy = anim.row * state.kit.frameH + crop.y;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(Math.round(f.x), Math.round(f.y) + STATS.bodyH / 2);
  const renderFacing = animName === "wallSlide" && f.wall ? f.wall : f.facing;
  state.pose = { animName, frameIdx, renderFacing };
  ctx.scale(renderFacing * placement.sourceFacing < 0 ? -1 : 1, 1);
  ctx.drawImage(img, sx, sy, crop.w, crop.h,
    crop.x - placement.rootX, crop.y - placement.footY, crop.w, crop.h);
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

  // Legacy traces without motion fields use a stable idle pose. Inferring
  // motion from the previously rendered sample makes seeks non-deterministic.
  return "idle";
}

function spriteFrameIndex(animName, anim, f, frame) {
  const bounded = index => Number.isFinite(index)
    ? Math.max(0, Math.min(anim.frames - 1, Math.floor(index))) : anim.frames - 1;
  if (animName === "swing" && STATS.swipeTime > 0) {
    const progress = 1 - Math.max(0, Math.min(1, f.swipeT / STATS.swipeTime));
    return bounded(progress * anim.frames);
  }
  const tick = Math.floor(frame.tick ?? 0);
  const ticksPerFrame = Math.max(1, Math.round(SIM_HZ / anim.fps));
  if (animName === "jump") return f.vy < -STATS.jump * 0.4 ? 0 : anim.frames - 1;
  if (animName === "fall") return f.vy < STATS.diveSpeed * 0.35 ? 0 : anim.frames - 1;
  if (animName === "dive") {
    return Number.isFinite(f.lastAttackStartTick)
      ? bounded((tick - f.lastAttackStartTick) / ticksPerFrame)
      : (f.diveT > 0.18 ? 0 : anim.frames - 1);
  }
  if (animName === "hit") return bounded((tick - f.lastClashTick) / ticksPerFrame);
  if (animName === "ko") {
    return Number.isFinite(f.respawnT)
      ? bounded((1 - f.respawnT / DOUBLE_KO_RESPAWN_S) * anim.frames)
      : anim.frames - 1;
  }
  // A frame has the same pose after seeking, dropping render frames, loading
  // images late or drawing into a second canvas. Wall time only schedules paint.
  const elapsed = Math.max(0, tick - Math.floor(frame.roundStartTick ?? 0));
  const index = Math.floor(elapsed / ticksPerFrame);
  return anim.loop ? index % anim.frames : bounded(index);
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

function drawSword(ctx, f, shadow, side, frame) {
  const clashAge = clashVisualAge(f, frame);
  const clashing = Number.isFinite(clashAge);
  const active = f.swipeT > 0 || f.diveT > 0 || clashing;
  const { bx, by, tx, ty } = swordSeg(f);
  const pose = spriteState[side]?.pose;
  const base = { animName: pose?.animName ?? "fallback", frameIdx: pose?.frameIdx ?? 0 };
  drawSwingTrail(ctx, f);
  if (drawWeaponSprite(ctx, side, bx, by, tx, ty, active, f.facing)) {
    drawWeaponHand(ctx, f, side, shadow);
    drawWeaponAnchorDebug(ctx, { bx, by, tx, ty, side, active, animName: base.animName, frameIdx: base.frameIdx });
    return;
  }

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
  drawWeaponHand(ctx, f, side, shadow);
  drawWeaponAnchorDebug(ctx, { bx, by, tx, ty, side, active, animName: base.animName, frameIdx: base.frameIdx });
}

function drawWeaponHand(ctx, f, side, shadow) {
  // A tiny forearm/cuff bridges the source body's shoulder to the shared grip.
  // Do not drag the weapon to whichever hand happens to be in a sprite cell.
  const { bx, by, tx, ty } = swordSeg(f);
  const hx = bx + (tx - bx) * 3 / STATS.sword;
  const hy = by + (ty - by) * 3 / STATS.sword;
  const body = sideCosmetics[side]?.body;
  ctx.save();
  ctx.lineCap = "round"; ctx.lineWidth = 5; ctx.strokeStyle = shadow;
  ctx.beginPath(); ctx.moveTo(f.x + f.facing * 6, f.y - 7); ctx.lineTo(hx, hy); ctx.stroke();
  ctx.fillStyle = ({ sama: "#d7b4aa", darrius: "#bf8d59", demis: "#b99059", mark: "#d9aa96" })[body] ?? "#d7b4aa";
  ctx.fillRect(Math.round(hx) - 2, Math.round(hy) - 2, 4, 4);
  ctx.restore();
}

function drawSwingTrail(ctx, f) {
  if (!(f.swipeT > 0) || f.diveT > 0) return;
  const current = swordSeg(f);
  const previous = swordSeg({ ...f, swipeT: Math.min(STATS.swipeTime, f.swipeT + 2 / SIM_HZ) });
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = cssColor("--arena-weapon-active", "white");
  ctx.beginPath();
  ctx.moveTo(current.bx, current.by);
  ctx.lineTo(previous.tx, previous.ty);
  ctx.lineTo(current.tx, current.ty);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawCombatDebug(ctx, f) {
  if (!combatDebugEnabled()) return;
  const hurt = fighterHurtbox(f);
  const sword = swordSeg(f);
  ctx.save(); ctx.lineWidth = 1;
  ctx.strokeStyle = "#67e8f9";
  ctx.strokeRect(f.x - STATS.bodyW / 2, f.y - STATS.bodyH / 2, STATS.bodyW, STATS.bodyH);
  ctx.strokeStyle = "#fb7185";
  ctx.beginPath(); ctx.arc(hurt.x, hurt.y, hurt.radius, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "#fde047";
  ctx.beginPath(); ctx.moveTo(sword.bx, sword.by); ctx.lineTo(sword.tx, sword.ty); ctx.stroke();
  ctx.restore();
}

function combatDebugEnabled() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location?.search ?? "").get("combatDebug") === "1";
}

function clashVisualAge(f, frame) {
  const tick = frame?.tick;
  const clashTick = f?.lastClashTick;
  if (typeof tick !== "number" || typeof clashTick !== "number" || clashTick < 0) return Infinity;
  const age = tick - clashTick;
  return age >= 0 && age <= CLASH_VISUAL_TICKS ? age : Infinity;
}

function drawClashFx(ctx, frame) {
  const p0 = frame?.p0;
  const p1 = frame?.p1;
  const a0 = clashVisualAge(p0, frame);
  const a1 = clashVisualAge(p1, frame);
  if (!Number.isFinite(a0) || !Number.isFinite(a1)) return;
  if (Math.abs((p0.lastClashTick ?? -9999) - (p1.lastClashTick ?? -9999)) > 1) return;

  const age = Math.max(a0, a1);
  const fade = Math.max(0, 1 - age / CLASH_VISUAL_TICKS);
  const x = (p0.x + p1.x) * 0.5;
  const y = (p0.y + p1.y) * 0.5 - STATS.bodyH * 0.3;
  const r = 18 + (1 - fade) * 8;

  ctx.save();
  ctx.globalAlpha = Math.min(1, 0.95 * fade + 0.15);
  ctx.translate(x, y);
  ctx.strokeStyle = cssColor("--arena-weapon-active", "#fffaf0");
  ctx.fillStyle = cssColor("--arena-weapon-active", "#fffaf0");
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-r, 0);
  ctx.lineTo(r, 0);
  ctx.moveTo(0, -r);
  ctx.lineTo(0, r);
  ctx.moveTo(-r * 0.65, -r * 0.65);
  ctx.lineTo(r * 0.65, r * 0.65);
  ctx.moveTo(-r * 0.65, r * 0.65);
  ctx.lineTo(r * 0.65, -r * 0.65);
  ctx.stroke();
  ctx.globalAlpha = Math.min(1, 0.75 * fade + 0.1);
  ctx.beginPath();
  ctx.arc(0, 0, 5 + (1 - fade) * 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawFighterNameplates(ctx, frame, labels) {
  drawFighterNameplate(ctx, frame?.p0, 0, frame, labels);
  drawFighterNameplate(ctx, frame?.p1, 1, frame, labels);
}

function drawFighterNameplate(ctx, fighter, side, frame, labels) {
  if (!fighter) return;
  let text = fighterNameplateText(labels, side);
  if (!text) return;

  const carrying = frame?.token?.carrier === side;
  const accent = side === 0 ? cssColor("--ui-blue", "#3b82f6") : cssColor("--ui-purple", "#a855f7");
  const x = Math.round(fighter.x + (carrying ? (side === 0 ? -62 : 62) : 0));
  const y = Math.max(72, Math.round(fighter.y - STATS.bodyH * 0.9 - (carrying ? 6 : 0)));

  ctx.save();
  ctx.font = "700 12px ui-monospace, Menlo, monospace";
  text = fitCanvasText(ctx, text, 144);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const maxWidth = 160;
  const rawWidth = ctx.measureText(text).width;
  const width = Math.min(maxWidth, Math.ceil(rawWidth + 16));
  const height = 20;

  ctx.fillStyle = "rgba(3, 7, 18, 0.78)";
  ctx.fillRect(x - width / 2, y - height / 2, width, height);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(x - width / 2 + 0.5, y - height / 2 + 0.5, width - 1, height - 1);
  ctx.fillStyle = cssColor("--ui-text", "#f4f4ff");
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

function fighterNameplateText(labels, side) {
  const explicit = labels?.nameplates?.[side];
  const fallback = labels?.[`p${side + 1}`];
  return normalizeNameplateText(explicit || fallback || `P${side + 1}`);
}

function normalizeNameplateText(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withoutBracket = raw.replace(/\s*\[[^\]]*\]\s*$/u, "");
  const trimmed = withoutBracket.replace(/\s*·.*$/u, "");
  return trimmed.length > 18 ? `${trimmed.slice(0, 17)}…` : trimmed;
}

export function fitCanvasText(ctx, value, maxWidth) {
  const text = String(value ?? "");
  if (ctx.measureText(text).width <= maxWidth) return text;
  if (ctx.measureText("…").width > maxWidth) return "";
  const chars = Array.from(text);
  while (chars.length && ctx.measureText(chars.join("") + "…").width > maxWidth) chars.pop();
  return chars.join("") + "…";
}

function drawWeaponSprite(ctx, side, bx, by, tx, ty, active, facing) {
  const selected = sideCosmetics[side] ?? cosmeticsForSide(null, side);
  const state = weaponImageState(selected.body, selected.weapon);
  if (!state) return false;
  const img = loadImage(state);
  if (!img) return false;

  const kit = state.kit;
  const art = WEAPON_ART[selected.body]?.[kit.cell];
  if (!art) return false;
  const transform = weaponArtTransform({ bx, by, tx, ty }, art, facing);

  if (active) {
    ctx.save();
    ctx.strokeStyle = cssColor("--arena-weapon-glow", "white");
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(bx, by);
  ctx.rotate(transform.worldAngle);
  ctx.scale(transform.scale, transform.scale * transform.aspect);
  ctx.rotate(-transform.sourceAngle);
  ctx.scale(transform.mirror, 1);
  ctx.globalAlpha = active ? 1 : 0.9;
  const cols = kit.cols ?? 2;
  const [cx, cy, cw, ch] = art.crop;
  const sx = (kit.cell % cols) * kit.frameW + cx;
  const sy = Math.floor(kit.cell / cols) * kit.frameH + cy;
  ctx.drawImage(
    img,
    sx, sy, cw, ch,
    cx - art.gripX, cy - art.gripY,
    cw, ch
  );
  ctx.restore();
  return true;
}

function weaponImageState(body, weapon) {
  const selectedKit = WEAPON_SHEETS[body]?.[weapon];
  if (!selectedKit) return null;
  const state = weaponImageStateForKit(`${body}:${weapon}`, selectedKit);
  if (state) return state;
  return weaponImageStateForKit(`${body}:${weapon}:fallback`, fallbackWeaponKit(selectedKit));
}

function weaponImageStateForKit(key, kit) {
  if (!kit) return null;
  let state = weaponState.get(key);
  if (!state) {
    state = { ...imageState(kit.url), kit };
    weaponState.set(key, state);
  }
  return state.failed ? null : state;
}

function fallbackWeaponKit(kit) {
  if (!kit?.fallbackUrl) return null;
  return {
    ...kit,
    url: kit.fallbackUrl,
    cell: kit.fallbackCell ?? kit.cell,
    cols: kit.fallbackCols ?? kit.cols,
  };
}

function weaponAnchorDebugEnabled() {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location?.search ?? "");
    if (params.get("weaponAnchors") === "1") return true;
    return window.localStorage?.getItem("m3t4:debug:weaponAnchors") === "1";
  } catch {
    return false;
  }
}

function drawWeaponAnchorDebug(ctx, { bx, by, tx, ty, side, active, animName, frameIdx }) {
  if (!weaponAnchorDebugEnabled()) return;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.lineWidth = 1;
  ctx.strokeStyle = active ? "#fffb00" : "#67e8f9";
  ctx.fillStyle = side === 0 ? "#6ee7b7" : "#fb923c";
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tx, ty); ctx.stroke();
  ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = active ? "#fffb00" : "#67e8f9";
  ctx.beginPath(); ctx.arc(tx, ty, 3, 0, Math.PI * 2); ctx.fill();
  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(`${animName}:${frameIdx}`, bx, by - 7);
  ctx.restore();
}

function drawHUD(ctx, frame, labels, p1Color, p2Color) {
  const L = labels || {};
  drawHudPortrait(ctx, 0, frame.p0, frame, 36, 20, p1Color);
  drawHudPortrait(ctx, 1, frame.p1, frame, W - 100, 20, p2Color);
  drawRoundHud(ctx, frame);

  ctx.font = "700 20px monospace";
  // Reserve the central round/timer panel. Long handles must not paint over it.
  const nameWidth = W / 2 - 168 - 112 - 16;
  ctx.fillStyle = p1Color;
  ctx.textAlign = "left";
  ctx.fillText(fitCanvasText(ctx, L.p1 || "P1", nameWidth), 112, 38);
  ctx.fillStyle = p2Color;
  ctx.textAlign = "right";
  ctx.fillText(fitCanvasText(ctx, L.p2 || "P2", nameWidth), W - 112, 38);

  ctx.font = "700 44px monospace";
  ctx.fillStyle = cssColor("--arena-hud-text", "white");
  ctx.textAlign = "left";
  ctx.fillText(String(frame.scoreboard[0]), 114, 88);
  ctx.textAlign = "right";
  ctx.fillText(String(frame.scoreboard[1]), W - 114, 88);

  // Round dots
  ctx.font = "600 14px monospace";
  ctx.fillStyle = cssColor("--arena-hud-soft", "white");
  const dots0 = Array.from({ length: 2 }, (_, i) => (i < frame.rounds[0] ? "\u25CF" : "\u25CB")).join(" ");
  const dots1 = Array.from({ length: 2 }, (_, i) => (i < frame.rounds[1] ? "\u25CF" : "\u25CB")).join(" ");
  ctx.textAlign = "left";
  ctx.fillText(dots0, 116, 108);
  ctx.textAlign = "right";
  ctx.fillText(dots1, W - 116, 108);

  if (L.tick !== undefined) {
    ctx.font = "500 12px monospace";
    ctx.fillStyle = cssColor("--arena-idle-text", "gray");
    ctx.textAlign = "center";
    ctx.fillText(`tick ${frame.tick ?? L.tick}`, W / 2, 24);
  }
}

function drawRoundHud(ctx, frame) {
  const roundWins = frame.rounds ?? [0, 0];
  const roundScore = frame.scoreboard ?? [0, 0];
  const totalRoundsPlayed = Math.min(ROUNDS_TO_WIN_MATCH * 2 - 1, roundWins[0] + roundWins[1]);
  const roundNumber = Math.min(ROUNDS_TO_WIN_MATCH * 2 - 1, totalRoundsPlayed + 1);
  const startTick = Number.isFinite(frame.roundStartTick) ? frame.roundStartTick : 0;
  const elapsed = Math.max(0, (frame.tick ?? 0) - startTick);
  const remainingTicks = Math.max(0, ROUND_TIMER_MAX_TICKS - elapsed);
  const remainingSeconds = Math.ceil(remainingTicks / SIM_HZ);
  const danger = remainingSeconds <= 5;
  const warn = remainingSeconds <= 10;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = "800 15px monospace";
  ctx.fillStyle = "rgba(0, 0, 0, 0.48)";
  ctx.fillRect(W / 2 - 168, 16, 336, 48);
  ctx.strokeStyle = danger
    ? cssColor("--ui-red", "#ef4444")
    : warn
      ? cssColor("--ui-amber", "#f59e0b")
      : cssColor("--arena-hud-soft", "#d7dfef");
  ctx.lineWidth = danger && Math.floor((frame.tick ?? 0) / 10) % 2 === 0 ? 2 : 1;
  ctx.strokeRect(W / 2 - 168.5, 16.5, 337, 48);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fillText(`ROUND ${roundNumber} / ${ROUNDS_TO_WIN_MATCH * 2 - 1}  ·  ${formatClock(remainingSeconds)}  ·  ${roundWins[0]}-${roundWins[1]}`, W / 2, 23);
  ctx.font = "700 11px monospace";
  ctx.fillStyle = cssColor("--arena-hud-text", "#f8fafc");
  ctx.fillText(`THIS ROUND ${roundScore[0]}-${roundScore[1]}  ·  FIRST TO ${POINTS_TO_WIN_ROUND}`, W / 2, 44);
  ctx.restore();
}

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(s / 60);
  const seconds = String(s % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function drawHudPortrait(ctx, side, fighter, frame, x, y, accent) {
  const body = sideCosmetics[side]?.body ?? DEFAULT_BODIES[side] ?? DEFAULT_BODIES[0];
  const state = portraitImageState(body, side);
  const img = state ? loadImage(state) : null;
  const size = 64;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.42)";
  ctx.fillRect(x - 4, y - 4, size + 8, size + 8);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(x - 4, y - 4, size + 8, size + 8);

  if (img && state) {
    const idx = portraitIndex(side, fighter, frame);
    const sx = (idx % 2) * state.kit.cellW;
    const sy = Math.floor(idx / 2) * state.kit.cellH;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, sx, sy, state.kit.cellW, state.kit.cellH, x, y, size, size);
  } else {
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.18;
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

function portraitImageState(body, side) {
  const selected = portraitState.get(body);
  if (selected && !selected.failed) return selected;
  return portraitState.get(DEFAULT_BODIES[side] ?? DEFAULT_BODIES[0]) ?? selected;
}

function hudPortraitInitialState() {
  return {
    lastTick: null,
    hurtUntil: -Infinity,
    koUntil: -Infinity,
    wasDead: false,
    wasHurt: false,
  };
}

export function portraitCellForHudState(fighter, frame = {}, side = 0) {
  const state = hudPortraitState[side] ?? hudPortraitInitialState();
  hudPortraitState[side] = state;
  const tick = Number.isFinite(frame.tick) ? frame.tick : 0;
  if (state.lastTick == null || tick < state.lastTick) {
    Object.assign(state, hudPortraitInitialState());
  }
  state.lastTick = tick;

  const dead = !!fighter?.dead;
  const hurt = Number(fighter?.stun ?? 0) > 0;
  if (dead && !state.wasDead) state.koUntil = Math.max(state.koUntil, tick + HUD_KO_HOLD_TICKS);
  if (hurt && !dead && !state.wasHurt) state.hurtUntil = Math.max(state.hurtUntil, tick + HUD_HURT_HOLD_TICKS);
  state.wasDead = dead;
  state.wasHurt = hurt;

  if (dead || tick <= state.koUntil) return HUD_PORTRAIT_CELL.ko;
  if (hurt || tick <= state.hurtUntil) return HUD_PORTRAIT_CELL.hurt;
  return HUD_PORTRAIT_CELL.neutral;
}

function portraitIndex(side, fighter, frame) {
  return portraitCellForHudState(fighter, frame, side);
}
