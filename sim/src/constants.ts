// Arena + physics constants — mirrors the SELF lab exactly.

export const W = 1280;
export const H = 720;
export const ARENA_L = 56;
export const ARENA_R = 1224;
export const ARENA_T = 48;
export const FLOOR_Y = 640; // top of the ground platform

export const STEP = 1 / 120; // fixed physics timestep
export const GRAVITY = 2600;
export const WALL_SLIDE = 160;
export const COYOTE_TIME = 0.08;
export const JUMP_BUFFER_TIME = 0.09;
export const HIT_FREEZE = 0.055;
export const CLASH_FREEZE = 0.03;

// Identical per-character stats — variation lives in the brain.
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
} as const;

export const POINTS_TO_WIN_ROUND = 3;
export const ROUNDS_TO_WIN_MATCH = 2;
export const GOAL_TIMER_START = 10;
export const ROUND_TIMER_MAX_TICKS = 60 * 120; // safety cap: 60 s per round
// Carrier must keep their body top within this goal radius long enough to score.
// Shorter than kill respawn so winning combat near goal can convert.
export const GOAL_DWELL_S = 0.35;
export const GOAL_DWELL_RADIUS = 40;
export const KILL_RESPAWN_S = 0.5;
export const DOUBLE_KO_RESPAWN_S = 0.6;
// Respawn invulnerability must be shorter than dwell, or every fresh defender
// can safely walk through a carrier's scoring window and force objective loops.
export const RESPAWN_INVULN_S = 0.3;
