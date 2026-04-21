// Public client constants and UX validation. This file intentionally
// contains no brain evaluator, strategy roster, or canonical simulator.

export const W = 1280;
export const H = 720;

export const STATS = {
  speed: 380,
  accel: 5600,
  airAccel: 2300,
  friction: 5400,
  airDrag: 720,
  jump: 1200,
  jumpCut: 0.44,
  wallJumpX: 480,
  wallJumpY: 1100,
  climbSpeed: 170,
  sword: 52,
  bodyW: 26,
  bodyH: 52,
  swipeTime: 0.12,
  diveSpeed: 900,
  diveDrift: 0.78,
  hitPush: 380,
  resistance: 1.0,
};

export const GOAL_TIMER_START = 10;
export const SIM_HZ = 120;
export const POINTS_TO_WIN_ROUND = 2;
export const ROUNDS_TO_WIN_MATCH = 2;
export const ROUND_TIMER_MAX_TICKS = 60 * SIM_HZ;
export const USER_BUDGET = 360;
export const HALLUCINATION_PER_OVERAGE = 10;
export const MIN_CLEAN_SPEND = 180;
export const HALLUCINATION_PER_UNDERSPEND = 3;
export const MAX_DERIVED_HALLUCINATION = 300;
export const MAX_USER_SPEND = USER_BUDGET + Math.floor(MAX_DERIVED_HALLUCINATION / HALLUCINATION_PER_OVERAGE);
export const USER_SUBMISSION_EPSILON = 1e-6;

export const USER_KNOBS = [
  "burnRate",
  "moat",
  "shipRate",
  "foresight",
  "pivotSpeed",
  "leverage",
  "networking",
  "spite",
  "greed",
  "pacing",
  "cunning",
  "lift",
  "parry",
  "chase",
  "discipline",
];

export const RANGES = {
  burnRate: [0, 1],
  moat: [0, 300],
  shipRate: [0, 1],
  foresight: [0, 0.25],
  pivotSpeed: [0, 1],
  leverage: [-1, 1],
  networking: [0, 1],
  spite: [-1, 1],
  greed: [0, 1],
  pacing: [0, 1],
  cunning: [0, 1],
  lift: [0, 1],
  parry: [0, 1],
  chase: [0, 1],
  discipline: [0, 1],
  hallucination: [0, MAX_DERIVED_HALLUCINATION],
};

export const STAGES = {
  datacenter: {
    id: "datacenter",
    name: "Datacenter",
    platforms: [
      { x: 56, y: 640, w: 1168, h: 80, solid: true },
      { x: 110, y: 524, w: 200, h: 14, solid: false },
      { x: 970, y: 524, w: 200, h: 14, solid: false },
      { x: 470, y: 414, w: 340, h: 14, solid: false },
      { x: 200, y: 304, w: 180, h: 14, solid: false },
      { x: 900, y: 304, w: 180, h: 14, solid: false },
      { x: 540, y: 194, w: 200, h: 14, solid: false },
    ],
    goals: [
      { x: 210, y: 494, sx: 210, sy: 476, label: "CUSTOMERS" },
      { x: 1070, y: 494, sx: 1070, sy: 476, label: "RUNWAY" },
      { x: 640, y: 164, sx: 640, sy: 148, label: "COMPUTE" },
    ],
    spawnL: { x: 300, y: 590 },
    spawnR: { x: 980, y: 590 },
  },
  boardroom: {
    id: "boardroom",
    name: "Boardroom",
    platforms: [
      { x: 56, y: 640, w: 1168, h: 80, solid: true },
      { x: 380, y: 480, w: 520, h: 16, solid: false },
      { x: 150, y: 340, w: 220, h: 14, solid: false },
      { x: 910, y: 340, w: 220, h: 14, solid: false },
      { x: 540, y: 220, w: 200, h: 14, solid: false },
    ],
    goals: [
      { x: 260, y: 310, sx: 260, sy: 292, label: "CUSTOMERS" },
      { x: 1020, y: 310, sx: 1020, sy: 292, label: "RUNWAY" },
      { x: 640, y: 190, sx: 640, sy: 172, label: "COMPUTE" },
    ],
    spawnL: { x: 300, y: 590 },
    spawnR: { x: 980, y: 590 },
  },
  demoday: {
    id: "demoday",
    name: "Demo Day",
    platforms: [
      { x: 56, y: 640, w: 1168, h: 80, solid: true },
      { x: 520, y: 540, w: 240, h: 14, solid: false },
      { x: 100, y: 420, w: 180, h: 14, solid: false },
      { x: 1000, y: 420, w: 180, h: 14, solid: false },
      { x: 380, y: 300, w: 180, h: 14, solid: false },
      { x: 720, y: 300, w: 180, h: 14, solid: false },
      { x: 540, y: 160, w: 200, h: 14, solid: false },
    ],
    goals: [
      { x: 190, y: 390, sx: 190, sy: 372, label: "CUSTOMERS" },
      { x: 1090, y: 390, sx: 1090, sy: 372, label: "RUNWAY" },
      { x: 640, y: 130, sx: 640, sy: 112, label: "COMPUTE" },
    ],
    spawnL: { x: 280, y: 590 },
    spawnR: { x: 1000, y: 590 },
  },
};

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function nativeToUI(k, nativeVal) {
  const [lo, hi] = RANGES[k] ?? [0, 1];
  if (hi === lo) return 0;
  return clamp(((nativeVal - lo) / (hi - lo)) * 100, 0, 100);
}

export function uiToNative(k, ui) {
  const [lo, hi] = RANGES[k] ?? [0, 1];
  return lo + (hi - lo) * (clamp(ui, 0, 100) / 100);
}

export function computedHallucinationForSpend(spent) {
  const rounded = Math.round(spent);
  const overage = Math.max(0, rounded - USER_BUDGET);
  const underage = Math.max(0, MIN_CLEAN_SPEND - rounded);
  const penalty = overage * HALLUCINATION_PER_OVERAGE + underage * HALLUCINATION_PER_UNDERSPEND;
  return Math.min(MAX_DERIVED_HALLUCINATION, penalty);
}

export function budgetSpent(cfg) {
  let spent = 0;
  for (const k of USER_KNOBS) spent += nativeToUI(k, Number(cfg?.attributes?.[k] ?? 0));
  return Math.round(spent);
}

export function validateUserSubmission(cfg) {
  const errors = [];
  const attrs = {};
  for (const k of USER_KNOBS) {
    const raw = cfg?.attributes?.[k];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      errors.push(`${k} must be a finite numeric scalar`);
      continue;
    }
    const [lo, hi] = RANGES[k];
    if (raw < lo - USER_SUBMISSION_EPSILON || raw > hi + USER_SUBMISSION_EPSILON) {
      errors.push(`${k} must be within [${lo}, ${hi}]`);
      continue;
    }
    attrs[k] = clamp(raw, lo, hi);
  }

  const spent = errors.length === 0 ? budgetSpent({ attributes: attrs }) : 0;
  const hallucination = computedHallucinationForSpend(spent);
  const rawHallucination = cfg?.attributes?.hallucination;
  if (typeof rawHallucination !== "number" || !Number.isFinite(rawHallucination)) {
    errors.push(`hallucination must be the computed numeric scalar ${hallucination}`);
  } else if (errors.length === 0 && Math.abs(rawHallucination - hallucination) > USER_SUBMISSION_EPSILON) {
    errors.push(`hallucination must equal computed value ${hallucination}`);
  }
  if (errors.length === 0 && spent > MAX_USER_SPEND) {
    errors.push(`total budget spend ${spent} exceeds hallucination cap ${MAX_USER_SPEND}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    spent,
    hallucination,
    config: errors.length === 0 ? { ...cfg, attributes: { ...attrs, hallucination } } : undefined,
  };
}
