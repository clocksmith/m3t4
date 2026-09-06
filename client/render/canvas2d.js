import { imageState, loadImage } from "./image-assets.js";
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

// footY = frame-pixel y where the visible feet touch ground in standing
// poses (measured from each sheet's idle/run frames). The renderer aligns
// this to f.y + STATS.bodyH/2 so visible feet sit on the floor instead of
// overhanging it. handBiasX/Y nudges the shared weapon-anchor table to
// match each character's actual hand pixels (sama runs slightly narrower,
// mark wider, etc.). All four sheets are 64×64 with feet at y≈62-63.
const CHARACTER_SPRITES = [
  ["sama", {
    url: "assets/chars/sama/monastic_infra/sprite.png",
    frameW: 64,
    frameH: 64,
    footY: 62,
    handBiasX: 0,
    handBiasY: 0,
    anims: spriteAnims(),
    weaponAnchors: weaponAnchors(),
  }],
  ["darrius", {
    url: "assets/chars/darrius/legal_department_midnight/sprite.png",
    frameW: 64,
    frameH: 64,
    footY: 62,
    handBiasX: 0,
    handBiasY: 0,
    anims: spriteAnims(),
    weaponAnchors: weaponAnchors(),
  }],
  ["demis", {
    url: "assets/chars/demis/chalk_and_static/sprite.png",
    frameW: 64,
    frameH: 64,
    footY: 63,
    handBiasX: 1,
    handBiasY: 0,
    anims: spriteAnims(),
    weaponAnchors: weaponAnchors(),
  }],
  ["mark", {
    url: "assets/chars/mark/wellness_berserker/sprite.png",
    frameW: 64,
    frameH: 64,
    footY: 63,
    handBiasX: 2,
    handBiasY: 0,
    anims: spriteAnims(),
    weaponAnchors: weaponAnchors(),
  }],
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

const PORTRAIT_SHEETS = {
  sama: { url: "assets/chars/sama/monastic_infra/portraits/sheet.png", cellW: 96, cellH: 96 },
  darrius: { url: "assets/chars/darrius/legal_department_midnight/portraits/sheet.png", cellW: 96, cellH: 96 },
  demis: { url: "assets/chars/demis/chalk_and_static/portraits/sheet.png", cellW: 96, cellH: 96 },
  mark: { url: "assets/chars/mark/wellness_berserker/portraits/sheet.png", cellW: 96, cellH: 96 },
};
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

const spriteState = DEFAULT_BODIES.map((bodyId) => ({
  bodyId,
  kit: BODY_KITS[bodyId],
  anim: "idle",
  startTick: 0,
  pose: null,
  lastTick: null,
  lastX: null,
  lastY: null,
}));

const weaponState = new Map();
const portraitState = new Map(Object.entries(PORTRAIT_SHEETS).map(([body, kit]) => [body, { ...imageState(kit.url), kit }]));
const hudPortraitState = [hudPortraitInitialState(), hudPortraitInitialState()];
let sideCosmetics = DEFAULT_BODIES.map((body) => ({ body, weapon: DEFAULT_WEAPONS[body] }));

const OBJECTIVE_IMAGES = {
  payload: imageState("assets/objectives/proof_core/payload.png"),
  target: imageState("assets/objectives/demand_node/target.png"),
};

const DATACENTER_PACK = {
  sky: imageState("assets/stages/datacenter/cold_aisle_chapel/layers/sky.webp", "assets/stages/datacenter/cold_aisle_chapel/layers/sky.png"),
  farParallax: imageState("assets/stages/datacenter/cold_aisle_chapel/layers/far_parallax.webp", "assets/stages/datacenter/cold_aisle_chapel/layers/far_parallax.png"),
  midParallax: imageState("assets/stages/datacenter/cold_aisle_chapel/layers/mid_parallax.webp", "assets/stages/datacenter/cold_aisle_chapel/layers/mid_parallax.png"),
  nearParallax: imageState("assets/stages/datacenter/cold_aisle_chapel/layers/near_parallax.webp", "assets/stages/datacenter/cold_aisle_chapel/layers/near_parallax.png"),
  platform: imageState("assets/stages/datacenter/cold_aisle_chapel/textures/platform.png"),
  platformEdge: imageState("assets/stages/datacenter/cold_aisle_chapel/textures/platform_edge.png"),
  wall: imageState("assets/stages/datacenter/cold_aisle_chapel/textures/wall.png"),
};

const BOARDROOM_PACK = {
  sky: imageState("assets/stages/boardroom/fiduciary_basement/layers/sky.webp", "assets/stages/boardroom/fiduciary_basement/layers/sky.png"),
  farParallax: imageState("assets/stages/boardroom/fiduciary_basement/layers/far_parallax.webp", "assets/stages/boardroom/fiduciary_basement/layers/far_parallax.png"),
  midParallax: imageState("assets/stages/boardroom/fiduciary_basement/layers/mid_parallax.webp", "assets/stages/boardroom/fiduciary_basement/layers/mid_parallax.png"),
  nearParallax: imageState("assets/stages/boardroom/fiduciary_basement/layers/near_parallax.webp", "assets/stages/boardroom/fiduciary_basement/layers/near_parallax.png"),
  platform: imageState("assets/stages/boardroom/fiduciary_basement/textures/platform.png"),
  platformEdge: imageState("assets/stages/boardroom/fiduciary_basement/textures/platform_edge.png"),
  wall: imageState("assets/stages/boardroom/fiduciary_basement/textures/wall.png"),
};

const DEMODAY_PACK = {
  sky: imageState("assets/stages/demoday/demo_day_afterparty/layers/sky.webp", "assets/stages/demoday/demo_day_afterparty/layers/sky.png"),
  farParallax: imageState("assets/stages/demoday/demo_day_afterparty/layers/far_parallax.webp", "assets/stages/demoday/demo_day_afterparty/layers/far_parallax.png"),
  midParallax: imageState("assets/stages/demoday/demo_day_afterparty/layers/mid_parallax.webp", "assets/stages/demoday/demo_day_afterparty/layers/mid_parallax.png"),
  nearParallax: imageState("assets/stages/demoday/demo_day_afterparty/layers/near_parallax.webp", "assets/stages/demoday/demo_day_afterparty/layers/near_parallax.png"),
  platform: imageState("assets/stages/demoday/demo_day_afterparty/textures/platform.png"),
  platformEdge: imageState("assets/stages/demoday/demo_day_afterparty/textures/platform_edge.png"),
  wall: imageState("assets/stages/demoday/demo_day_afterparty/textures/wall.png"),
};

const STAGE_ASSETS = {
  datacenter: { ...DATACENTER_PACK, tint: null },
  boardroom: { ...BOARDROOM_PACK, tint: null },
  demoday: { ...DEMODAY_PACK, tint: null },
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

// Anchor x is offset from f.x (positive = forward of facing); anchor y is
// offset from f.y (negative = above center). Tuned against the current
// 64×64 sheets where the visible character spans ~y4-63, hands sit at
// hip band (frame y≈42, i.e. anchor y≈+10), and the body bbox is x22-41
// (so a hand reaching forward sits at frame x≈40-44, anchor x≈8-12).
// Per-anim deltas mirror the original table's intent: arms raised on
// jump/swing, dropped on KO, lifted overhead on carry.
function weaponAnchors() {
  const a = (x, y, angleBias = 0) => ({ x, y, angleBias });
  return {
    idle:      [a(10, 10, -0.03), a(11, 10, -0.02), a(10, 11, -0.03), a( 9, 10, -0.04)],
    run:       [a(12, 11, -0.04), a(10, 10, -0.02), a( 8,  9,  0.00), a(10, 10, -0.02), a(12, 11, -0.04), a( 9, 10, -0.02)],
    jump:      [a(11,  4, -0.10), a(13, -2, -0.16)],
    fall:      [a(11, 10,  0.06), a(10, 13,  0.10)],
    wallSlide: [a( 8, 12,  0.08), a( 8, 11,  0.08)],
    dive:      [a(16,  2,  0.18), a(18,  4,  0.20)],
    swing:     [a( 9,  6,  0.02), a(13,  2, -0.04), a(16, -2, -0.08), a(18, -4, -0.10), a(15,  2, -0.06), a(11,  6,  0.00)],
    hit:       [a( 5, 10,  0.20), a( 4, 12,  0.24), a( 7, 11,  0.12)],
    ko:        [a( 3, 18,  0.35), a( 1, 24,  0.55), a( 6, 28,  0.80), a( 6, 28,  0.80)],
    carry:     [a( 8, -6, -0.45), a( 9, -7, -0.45)],
    taunt:     [a( 7,  2, -0.25), a( 6,  0, -0.35), a( 7,  2, -0.25), a( 9,  6, -0.08)],
    victory:   [a( 9,  4, -0.20), a(10,  2, -0.25), a(10,  3, -0.22), a( 8,  6, -0.15)],
  };
}

function spriteImage(state) {
  const primary = characterImages[state.bodyId] ?? characterImages[DEFAULT_BODIES[0]];
  const img = loadImage(primary);
  if (img) {
    state.kit = primary.kit;
    return img;
  }
  if (!primary.failed) return null;

  const fallbackBody = DEFAULT_BODIES[state.bodyId === DEFAULT_BODIES[0] ? 1 : 0] ?? DEFAULT_BODIES[0];
  const fallback = characterImages[fallbackBody];
  const fallbackImg = fallback ? loadImage(fallback) : null;
  if (fallbackImg) state.kit = fallback.kit;
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
  sideCosmetics = [cosmeticsForSide(labels, 0), cosmeticsForSide(labels, 1)];
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
  if (far) drawHorizontalCoverImage(ctx, far, 0, 0, W, H, parallaxOffset(tick, 0.035));
  const mid = loadImage(pack.midParallax);
  if (mid) drawHorizontalCoverImage(ctx, mid, 0, 0, W, H, parallaxOffset(tick, 0.07));
  const near = loadImage(pack.nearParallax);
  if (near) drawHorizontalCoverImage(ctx, near, 0, 0, W, H, parallaxOffset(tick, 0.12));
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

function drawHorizontalCoverImage(ctx, img, x, y, w, h, offsetX = 0) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih || w <= 0 || h <= 0) return;

  const scale = h / ih;
  const drawW = iw * scale;
  if (!Number.isFinite(drawW) || drawW <= 0) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  let startX = Math.round(x - positiveMod(offsetX, drawW));
  while (startX > x) startX -= drawW;
  for (let xx = startX; xx < x + w; xx += drawW) {
    ctx.drawImage(img, 0, 0, iw, ih, Math.round(xx), y, drawW, h);
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
    state.anim = "idle";
    state.startTick = frame.tick ?? 0;
    state.pose = null;
  }
  const img = spriteImage(state);
  if (!img) {
    state.pose = null;
    return false;
  }

  const animName = chooseSpriteAnim(f, side, frame);
  if (state.anim !== animName) {
    state.anim = animName;
    state.startTick = frame.tick ?? 0;
  }
  const anim = state.kit.anims[animName] ?? state.kit.anims.idle;
  const frameIdx = spriteFrameIndex(animName, anim, f, frame, state);
  const sx = frameIdx * state.kit.frameW;
  const sy = anim.row * state.kit.frameH;

  // Align visible feet (frame-y = footY) with the body bbox bottom
  // (f.y + bodyH/2). Positive shift moves the sprite down; the default
  // footY = frameH centers the sprite on f.y as before.
  const renderW = state.kit.frameW;
  const renderH = state.kit.frameH;
  const footY = state.kit.footY ?? renderH;
  const verticalShift = STATS.bodyH / 2 + renderH / 2 - footY;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(Math.round(f.x), Math.round(f.y) + verticalShift);
  // Source sheets face camera-right. Facing left is a horizontal flip.
  // Wall-slide art should face the contacted wall, not whatever the brain was
  // aiming at that tick. Do not flip Y; canvas Y grows downward and a Y flip
  // would invert the body.
  const renderFacing = animName === "wallSlide" && f.wall ? f.wall : f.facing;
  state.pose = { animName, frameIdx, renderFacing };
  if (renderFacing < 0) ctx.scale(-1, 1);
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
  const clashAge = clashVisualAge(f, frame);
  const clashing = Number.isFinite(clashAge);
  const active = f.swipeT > 0 || f.diveT > 0 || clashing;
  const base = weaponBasePoint(f, side, active);
  let angle = base.angleBias ?? 0;
  if (f.diveT > 0) angle += Math.PI * 0.46;
  else if (clashing) angle += 0;
  else if (f.swipeT > 0) {
    const t = 1 - f.swipeT / STATS.swipeTime;
    // Upward anti-air slash: horizontal-forward → ~57° up (must match sim/swordSeg).
    const ease = 1 - (1 - t) ** 3;
    angle += 0.0 + (-1.0 - 0.0) * ease;
  }
  const dx = Math.cos(angle) * base.facing;
  const dy = Math.sin(angle);
  const len = STATS.sword;
  const bx = base.x;
  const by = base.y;
  const tx = bx + dx * len;
  const ty = by + dy * len;
  if (drawWeaponSprite(ctx, side, bx, by, tx, ty, active)) {
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
  drawWeaponAnchorDebug(ctx, { bx, by, tx, ty, side, active, animName: base.animName, frameIdx: base.frameIdx });
}

function weaponBasePoint(f, side, active) {
  const state = spriteState[side];
  const pose = state?.pose;
  const anchor = pose ? weaponAnchorForPose(state.kit.weaponAnchors, pose.animName, pose.frameIdx) : null;
  const facing = active ? f.facing : (pose?.renderFacing ?? f.facing);
  if (!anchor) {
    return {
      x: f.x + facing * STATS.bodyW * 0.35,
      y: f.y - STATS.bodyH * 0.3,
      facing,
      angleBias: 0,
      animName: pose?.animName ?? "fallback",
      frameIdx: pose?.frameIdx ?? 0,
    };
  }
  // Match the sprite renderer's footY-driven vertical translation so the
  // weapon follows the body when the sprite is shifted up/down to align
  // feet with the floor. handBiasX/Y nudge per character.
  const kit = state.kit;
  const footY = kit.footY ?? kit.frameH;
  const verticalShift = STATS.bodyH / 2 + kit.frameH / 2 - footY;
  return {
    x: f.x + (anchor.x + (kit.handBiasX ?? 0)) * facing,
    y: f.y + verticalShift + anchor.y + (kit.handBiasY ?? 0),
    facing,
    angleBias: anchor.angleBias ?? 0,
    animName: pose.animName,
    frameIdx: pose.frameIdx,
  };
}

function weaponAnchorForPose(anchors, animName, frameIdx) {
  const frames = anchors?.[animName] ?? anchors?.idle;
  if (!frames?.length) return null;
  return frames[Math.max(0, Math.min(frames.length - 1, frameIdx))] ?? frames[0];
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

function drawWeaponSprite(ctx, side, bx, by, tx, ty, active) {
  const selected = sideCosmetics[side] ?? cosmeticsForSide(null, side);
  const state = weaponImageState(selected.body, selected.weapon);
  if (!state) return false;
  const img = loadImage(state);
  if (!img) return false;

  const kit = state.kit;
  const angle = Math.atan2(ty - by, tx - bx);
  const scale = active ? 1.12 : 0.96;
  const dw = kit.frameW * scale;
  const dh = kit.frameH * scale;
  const gripX = kit.gripX ?? 6;
  const gripY = kit.gripY ?? kit.frameH / 2;

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
  const cols = kit.cols ?? 2;
  const sx = (kit.cell % cols) * kit.frameW;
  const sy = Math.floor(kit.cell / cols) * kit.frameH;
  ctx.drawImage(
    img,
    sx, sy, kit.frameW, kit.frameH,
    -gripX * scale, -gripY * scale,
    dw, dh
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
