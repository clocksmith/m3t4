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
} from "./public-sim.js";

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
  { url: "assets/weapons/sama/launch.png", frameW: 48, frameH: 48, cell: 0, visualYOffset: 16 },
  { url: "assets/weapons/darrius/launch.png", frameW: 48, frameH: 48, cell: 0 },
];

const PORTRAIT_SHEETS = [
  { url: "assets/chars/sama/monastic_infra/portraits/sheet.png", cellW: 96, cellH: 96 },
  { url: "assets/chars/darrius/legal_department_midnight/portraits/sheet.png", cellW: 96, cellH: 96 },
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

const portraitState = PORTRAIT_SHEETS.map((kit) => ({
  ...imageState(kit.url),
  kit,
}));

const OBJECTIVE_IMAGES = {
  payload: imageState("assets/objectives/proof_core/payload.png"),
  target: imageState("assets/objectives/demand_node/target.png"),
};

const DATACENTER_PACK = {
  sky: imageState("assets/stages/datacenter/cold_aisle_chapel/layers/sky.png"),
  farParallax: imageState("assets/stages/datacenter/cold_aisle_chapel/layers/far_parallax.png"),
  midParallax: imageState("assets/stages/datacenter/cold_aisle_chapel/layers/mid_parallax.png"),
  nearParallax: imageState("assets/stages/datacenter/cold_aisle_chapel/layers/near_parallax.png"),
  platform: imageState("assets/stages/datacenter/cold_aisle_chapel/textures/platform.png"),
  platformEdge: imageState("assets/stages/datacenter/cold_aisle_chapel/textures/platform_edge.png"),
  wall: imageState("assets/stages/datacenter/cold_aisle_chapel/textures/wall.png"),
  floorDetail: imageState("assets/stages/datacenter/cold_aisle_chapel/textures/floor_detail.png"),
};

const BOARDROOM_PACK = {
  sky: imageState("assets/stages/boardroom/fiduciary_basement/layers/sky.png"),
  farParallax: imageState("assets/stages/boardroom/fiduciary_basement/layers/far_parallax.png"),
  midParallax: imageState("assets/stages/boardroom/fiduciary_basement/layers/mid_parallax.png"),
  nearParallax: imageState("assets/stages/boardroom/fiduciary_basement/layers/near_parallax.png"),
  platform: imageState("assets/stages/boardroom/fiduciary_basement/textures/platform.png"),
  platformEdge: imageState("assets/stages/boardroom/fiduciary_basement/textures/platform_edge.png"),
  wall: imageState("assets/stages/boardroom/fiduciary_basement/textures/wall.png"),
  floorDetail: imageState("assets/stages/boardroom/fiduciary_basement/textures/floor_detail.png"),
};

const DEMODAY_PACK = {
  sky: imageState("assets/stages/demoday/demo_day_afterparty/layers/sky.png"),
  farParallax: imageState("assets/stages/demoday/demo_day_afterparty/layers/far_parallax.png"),
  midParallax: imageState("assets/stages/demoday/demo_day_afterparty/layers/mid_parallax.png"),
  nearParallax: imageState("assets/stages/demoday/demo_day_afterparty/layers/near_parallax.png"),
  platform: imageState("assets/stages/demoday/demo_day_afterparty/textures/platform.png"),
  platformEdge: imageState("assets/stages/demoday/demo_day_afterparty/textures/platform_edge.png"),
  wall: imageState("assets/stages/demoday/demo_day_afterparty/textures/wall.png"),
  floorDetail: imageState("assets/stages/demoday/demo_day_afterparty/textures/floor_detail.png"),
};

const STAGE_ASSETS = {
  datacenter: { ...DATACENTER_PACK, tint: null },
  boardroom: { ...BOARDROOM_PACK, tint: null },
  demoday: { ...DEMODAY_PACK, tint: null },
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
    const parentW = parent ? parentContentWidth(parent) : Infinity;
    const viewportW = document.documentElement.clientWidth - 40;
    const cssW = Math.max(160, Math.min(parentW || viewportW, viewportW));
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

function parentContentWidth(el) {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const px = (value) => Number.parseFloat(value) || 0;
  return Math.max(0,
    rect.width
    - px(style.paddingLeft)
    - px(style.paddingRight)
    - px(style.borderLeftWidth)
    - px(style.borderRightWidth),
  );
}

export function drawFrame(ctx, stage, frame, labels) {
  const p1 = fighterPalette(0);
  const p2 = fighterPalette(1);
  ctx.fillStyle = cssColor("--arena-bg");
  ctx.fillRect(0, 0, W, H);
  drawStage(ctx, stage, frame);
  drawGoal(ctx, frame.goal);
  drawToken(ctx, frame.token);
  drawFighter(ctx, frame.p0, p1.body, p1.trim, p1.shadow, 0, frame);
  drawFighter(ctx, frame.p1, p2.body, p2.trim, p2.shadow, 1, frame);
  drawClashFx(ctx, frame);
  drawHUD(ctx, frame, labels, p1.body, p2.body);
}

function drawStage(ctx, stage, frame) {
  const pack = STAGE_ASSETS[stage.id];
  drawStageGradient(ctx);
  // Apply the per-stage tint across the whole stage (backdrop + platforms
  // + walls + floor detail) so the subtle hue shift reads consistently.
  // Sprites, token, and HUD render after this returns, unfiltered, so
  // P1/P2 identity colors stay true.
  if (pack?.tint) ctx.filter = pack.tint;
  drawStageBackdrop(ctx, pack, frame);
  for (const p of stage.platforms) drawPlatform(ctx, p, pack);
  if (pack?.tint) ctx.filter = "none";
}

function drawStageGradient(ctx) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, cssColor("--arena-sky-top"));
  g.addColorStop(0.5, cssColor("--arena-sky-mid"));
  g.addColorStop(1, cssColor("--arena-sky-bottom"));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function drawStageBackdrop(ctx, pack, frame) {
  if (!pack) return;
  ctx.imageSmoothingEnabled = false;
  const sky = loadImage(pack.sky);
  if (sky) ctx.drawImage(sky, 0, 0, W, H);

  const tick = frame?.tick ?? 0;
  const far = loadImage(pack.farParallax);
  if (far) drawTiledImage(ctx, far, 0, 0, W, H, parallaxOffset(tick, 0.035), 0);
  const mid = loadImage(pack.midParallax);
  if (mid) drawTiledImage(ctx, mid, 0, 0, W, H, parallaxOffset(tick, 0.07), 0);
  const near = loadImage(pack.nearParallax);
  if (near) drawTiledImage(ctx, near, 0, 0, W, H, parallaxOffset(tick, 0.12), 0);
}

function parallaxOffset(tick, pxPerTick) {
  // Pixel art backdrops shimmer when canvas draws them at subpixel x
  // positions. Snap to integer pixels and let depth come from speed.
  return -Math.floor(tick * pxPerTick);
}

function drawPlatform(ctx, p, pack) {
  const platform = pack ? loadImage(pack.platform) : null;
  const edge = pack ? loadImage(pack.platformEdge) : null;
  const wall = pack ? loadImage(pack.wall) : null;
  const detail = pack ? loadImage(pack.floorDetail) : null;

  if (p.solid && wall && p.h > 18) {
    drawTiledImage(ctx, wall, p.x, p.y + 16, p.w, p.h - 16);
  } else {
    ctx.fillStyle = p.solid ? cssColor("--arena-platform-solid") : cssColor("--arena-platform-soft");
    ctx.fillRect(p.x, p.y, p.w, p.h);
  }

  if (platform) {
    drawTiledImage(ctx, platform, p.x, p.y, p.w, p.solid ? Math.min(36, p.h) : p.h);
  }

  if (edge) {
    drawTiledImage(ctx, edge, p.x, p.y, p.w, Math.min(16, p.h));
  } else {
    ctx.fillStyle = cssColor("--arena-platform-highlight", "white");
    ctx.fillRect(p.x, p.y, p.w, 3);
  }

  if (detail && p.solid && p.w > 260) {
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.imageSmoothingEnabled = false;
    const w = Math.min(256, p.w);
    ctx.drawImage(detail, 0, 0, w, Math.min(64, p.h), p.x + (p.w - w) / 2, p.y + 4, w, Math.min(64, p.h));
    ctx.restore();
  }
}

function drawTiledImage(ctx, img, x, y, w, h, offsetX = 0, offsetY = 0) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih || w <= 0 || h <= 0) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  const stepX = iw;
  const stepY = ih;
  let startX = Math.round(x - positiveMod(offsetX, stepX));
  let startY = Math.round(y - positiveMod(offsetY, stepY));
  while (startX > x) startX -= stepX;
  while (startY > y) startY -= stepY;

  for (let yy = startY; yy < y + h; yy += stepY) {
    for (let xx = startX; xx < x + w; xx += stepX) {
      ctx.drawImage(img, 0, 0, stepX, stepY, Math.round(xx), Math.round(yy), stepX, stepY);
    }
  }
  ctx.restore();
}

function positiveMod(value, mod) {
  return ((value % mod) + mod) % mod;
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

function drawGoal(ctx, goal) {
  if (!goal.exists) return;
  const timer = Math.max(0, Number(goal.timer ?? GOAL_TIMER_START));
  const frac = Math.min(1, timer / GOAL_TIMER_START);
  const [r, g, b] = goalRingColor(frac);
  const urgent = frac < GOAL_URGENT_FRAC;
  const pulse = 1 + Math.sin(Date.now() * (urgent ? 0.032 : 0.008)) * (urgent ? 0.34 : 0.06);

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
    updateSpriteMotion(side, f, frame);
    return;
  }
  const drewSprite = drawSpriteFighter(ctx, f, side, frame);
  if (!drewSprite) drawPrimitiveBody(ctx, f, col, trim, shadow);
  drawSword(ctx, f, shadow, side, frame);
  updateSpriteMotion(side, f, frame);
}

// Visual scale for character sprites. Sim hitbox is sim-authoritative
// at bodyW=26, bodyH=52; the rendered sprite is just art. 1.25x reads
// at ~11% of stage height vs. 8.9% at 1:1, closer to genre norm.
const SPRITE_RENDER_SCALE = 1.25;
const CLASH_VISUAL_TICKS = 10;

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
  // Wall-slide art should face the contacted wall, not whatever the brain was
  // aiming at that tick. Do not flip Y; canvas Y grows downward and a Y flip
  // would invert the body.
  const renderFacing = animName === "wallSlide" && f.wall ? f.wall : f.facing;
  if (renderFacing < 0) ctx.scale(-1, 1);
  // Render scale: draw the 64x64 sprite cell at ~1.25x so fighters read
  // at a closer-to-genre-norm stage proportion (~11% of stage height
  // vs. 8.9% at 1:1). The hitbox stays sim-authoritative — visual only.
  // Combined with the narrow-silhouette prompt update, the visible body
  // stays aligned with the 26x52 hitbox even after upscaling.
  const renderW = state.kit.frameW * SPRITE_RENDER_SCALE;
  const renderH = state.kit.frameH * SPRITE_RENDER_SCALE;
  ctx.drawImage(
    img,
    sx, sy, state.kit.frameW, state.kit.frameH,
    -renderW / 2, -renderH / 2,
    renderW, renderH
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

function drawSword(ctx, f, shadow, side, frame) {
  const bw = STATS.bodyW;
  const bh = STATS.bodyH;
  // Sword
  const clashAge = clashVisualAge(f, frame);
  const clashing = Number.isFinite(clashAge);
  const active = f.swipeT > 0 || f.diveT > 0 || clashing;
  const bx = f.x + f.facing * bw * 0.35;
  const by = f.y - bh * 0.3;
  let angle = 0;
  if (f.diveT > 0) angle = Math.PI * 0.46;
  else if (clashing) angle = 0;
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

function drawWeaponSprite(ctx, side, bx, by, tx, ty, active) {
  const state = weaponState[side];
  if (!state) return false;
  const img = loadImage(state);
  if (!img) return false;

  const kit = state.kit;
  const visualYOffset = kit.visualYOffset ?? 0;
  const vbx = bx;
  const vby = by + visualYOffset;
  const vtx = tx;
  const vty = ty + visualYOffset;
  const angle = Math.atan2(vty - vby, vtx - vbx);
  const scale = active ? 1.12 : 0.96;
  const dw = kit.frameW * scale;
  const dh = kit.frameH * scale;

  if (active) {
    ctx.save();
    ctx.strokeStyle = cssColor("--arena-weapon-glow", "white");
    ctx.lineWidth = 12;
    ctx.beginPath(); ctx.moveTo(vbx, vby); ctx.lineTo(vtx, vty); ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(vbx, vby);
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
  drawHudPortrait(ctx, 0, frame.p0, frame, 36, 20, p1Color);
  drawHudPortrait(ctx, 1, frame.p1, frame, W - 100, 20, p2Color);
  drawRoundHud(ctx, frame);

  ctx.font = "700 20px monospace";
  ctx.fillStyle = p1Color;
  ctx.textAlign = "left";
  ctx.fillText(L.p1 || "P1", 112, 38);
  ctx.fillStyle = p2Color;
  ctx.textAlign = "right";
  ctx.fillText(L.p2 || "P2", W - 112, 38);

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
  const state = portraitState[side];
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

function portraitIndex(side, fighter, frame) {
  if (frame.rounds?.[side] >= 2) return 3; // victory
  if (fighter.dead) return 2;              // ko
  if ((fighter.stun ?? 0) > 0) return 1;   // hurt
  return 0;                                // neutral
}
