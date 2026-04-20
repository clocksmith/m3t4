// Deterministic match simulator. Given two compiled brains + stage + seed,
// runs a complete match tick-by-tick and returns a full MatchResult with
// an input-log that's sufficient to re-render the match anywhere.

import {
  ARENA_L,
  ARENA_R,
  ARENA_T,
  CLASH_FREEZE,
  COYOTE_TIME,
  FLOOR_Y,
  GOAL_DWELL_RADIUS,
  GOAL_DWELL_S,
  GOAL_TIMER_START,
  GRAVITY,
  HIT_FREEZE,
  JUMP_BUFFER_TIME,
  DOUBLE_KO_RESPAWN_S,
  KILL_RESPAWN_S,
  POINTS_TO_WIN_ROUND,
  RESPAWN_INVULN_S,
  ROUNDS_TO_WIN_MATCH,
  ROUND_TIMER_MAX_TICKS,
  STATS,
  STEP,
  WALL_SLIDE,
} from "./constants.js";
import { createBrainState, resetBrainStateForRound, runParamBrain } from "./brain.js";
import { RANGES } from "./budget.js";
import { compileBrain, evaluateParams, type CompiledBrain } from "./dsl.js";
import { makeRng, type Rng, rngRange } from "./rng.js";
import { PARAM_KEYS } from "./types.js";
import type {
  Action,
  BrainConfig,
  BrainMode,
  Character,
  FighterTelemetry,
  Fighter,
  Gold,
  MatchResult,
  Observation,
  ParamKey,
  Params,
  Stage,
  World,
} from "./types.js";
import { emptyFighterTelemetry } from "./types.js";

// ---------- Characters (visual only; stats identical) ----------

export const DEFAULT_CHARS: [Character, Character] = [
  { name: "Sama", label: "OpenAL", col: "#6ee7b7", trim: "#d1fae5", shadow: "#047857" },
  { name: "Darrius", label: "Anthropos", col: "#fb923c", trim: "#fed7aa", shadow: "#9a3412" },
];

// ---------- Fighter helpers ----------

function makeFighter(id: 0 | 1, ch: Character, spawn: { x: number; y: number }, face: -1 | 1): Fighter {
  return {
    id,
    ch,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    facing: face,
    onGround: false,
    wall: 0,
    coyote: 0,
    jumpBuf: 0,
    swipeT: 0,
    swipeCD: 0,
    diveT: 0,
    diveCD: 0,
    stun: 0,
    invuln: 0,
    respawnT: 0,
    dead: false,
    score: 0,
    rounds: 0,
    giant: 0,
    hp: 100,
    lastClashTick: -9999,
    lastAttackStartTick: -9999,
    lastKillTick: -9999,
    lastSignificantX: spawn.x,
    lastSignificantY: spawn.y,
    lastMoveTick: 0,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function mix32(x: number): number {
  x >>>= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function noiseSeedFromMatchSeed(seed: number): number {
  return mix32((seed >>> 0) ^ 0xa511e9b3);
}

function noiseUnit(seed: number, tick: number, fighterId: 0 | 1, paramIndex: number): number {
  let x = seed >>> 0;
  x ^= Math.imul(tick + 1, 0x9e3779b9) >>> 0;
  x ^= Math.imul(fighterId + 1, 0x85ebca6b) >>> 0;
  x ^= Math.imul(paramIndex + 1, 0xc2b2ae35) >>> 0;
  return mix32(x) / 0x100000000;
}

const NOISE_KEYS = PARAM_KEYS.filter((k): k is Exclude<ParamKey, "hallucination"> => k !== "hallucination");

export function applyHallucinationNoise(
  params: Params,
  tick: number,
  fighterId: 0 | 1,
  noiseSeed: number,
): Params {
  const hallucination = Math.max(0, Number.isFinite(params.hallucination) ? params.hallucination : 0);
  if (hallucination <= 0) return params;

  const jitterScale = (hallucination / 100) * 0.5;
  const out: Params = { ...params };
  for (let i = 0; i < NOISE_KEYS.length; i++) {
    const k = NOISE_KEYS[i];
    const [lo, hi] = RANGES[k];
    const delta = (noiseUnit(noiseSeed, tick, fighterId, i) * 2 - 1) * jitterScale * (hi - lo);
    out[k] = clamp(params[k] + delta, lo, hi);
  }
  return out;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function ease3(t: number): number {
  return 1 - (1 - t) * (1 - t) * (1 - t);
}

function toward(v: number, t: number, d: number): number {
  return v < t ? Math.min(v + d, t) : Math.max(v - d, t);
}

function segIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number
): boolean {
  const det = (p1x: number, p1y: number, p2x: number, p2y: number, p3x: number, p3y: number) =>
    (p2x - p1x) * (p3y - p1y) - (p2y - p1y) * (p3x - p1x);
  const d1 = det(ax, ay, bx, by, cx, cy);
  const d2 = det(ax, ay, bx, by, dx, dy);
  const d3 = det(cx, cy, dx, dy, ax, ay);
  const d4 = det(cx, cy, dx, dy, bx, by);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

function ptSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

interface SwordSeg {
  bx: number;
  by: number;
  tx: number;
  ty: number;
}

function swordSeg(f: Fighter): SwordSeg {
  const bx = f.x + f.facing * STATS.bodyW * 0.35;
  const by = f.y - STATS.bodyH * 0.3;
  let angle = 0;
  if (f.diveT > 0) angle = Math.PI * 0.46;
  else if (f.swipeT > 0) {
    const t = 1 - f.swipeT / STATS.swipeTime;
    // Upward anti-air slash (Foiled!-faithful): flick up from the passive
    // horizontal-forward pose to ~57° above horizontal. 57° sweep is brisk
    // and defensive, tip reaches ~28px above head to catch divers.
    angle = lerp(0.0, -1.0, ease3(t));
  }
  const dx = Math.cos(angle) * f.facing;
  const dy = Math.sin(angle);
  return {
    bx,
    by,
    tx: bx + dx * STATS.sword,
    ty: by + dy * STATS.sword,
  };
}

function swordHits(s: SwordSeg, t: Fighter): boolean {
  const cx = t.x;
  const cy = t.y - STATS.bodyH * 0.28;
  const r = STATS.bodyW * 0.65;
  return ptSegDist(cx, cy, s.bx, s.by, s.tx, s.ty) <= r;
}

// ---------- Observation ----------

function makeObs(self: Fighter, opp: Fighter, w: World): Observation {
  return {
    self: {
      id: self.id,
      x: self.x, y: self.y, vx: self.vx, vy: self.vy,
      facing: self.facing, hp: self.hp,
      onGround: self.onGround, wall: self.wall, stun: self.stun, invuln: self.invuln, dead: self.dead,
      swipeT: self.swipeT, swipeCD: self.swipeCD, diveT: self.diveT, diveCD: self.diveCD,
      hasToken: !!(w.gold && w.gold.carrier === self.id),
      lastClashTick: self.lastClashTick,
      lastAttackStartTick: self.lastAttackStartTick,
      lastKillTick: self.lastKillTick,
      lastMoveTick: self.lastMoveTick,
      score: self.score,
      rounds: self.rounds,
    },
    opp: {
      x: opp.x, y: opp.y, vx: opp.vx, vy: opp.vy,
      facing: opp.facing, hp: opp.hp,
      onGround: opp.onGround, stun: opp.stun, dead: opp.dead,
      swipeT: opp.swipeT, diveT: opp.diveT,
      hasToken: !!(w.gold && w.gold.carrier === opp.id),
      lastAttackStartTick: opp.lastAttackStartTick,
      score: opp.score,
      rounds: opp.rounds,
    },
    token: w.gold
      ? { exists: true, x: w.gold.x, y: w.gold.y, carrier: w.gold.carrier, dwellT: w.gold.dwellT }
      : { exists: false, x: 0, y: 0, carrier: -1, dwellT: 0 },
    goal: w.goal
      ? { exists: true, x: w.goal.x, y: w.goal.y, label: w.goal.label, timer: w.goal.timer }
      : { exists: false, x: 0, y: 0, label: "", timer: 0 },
    platforms: w.stage.platforms,
    arena: { left: ARENA_L, right: ARENA_R, top: ARENA_T, floor: FLOOR_Y },
    dx: opp.x - self.x,
    absDx: Math.abs(opp.x - self.x),
    dy: opp.y - self.y,
    tick: w.tick,
  };
}

// ---------- Fighter physics step ----------

function startAttack(f: Fighter, type: "swipe" | "dive", tick: number): void {
  f.lastAttackStartTick = tick;
  if (type === "dive") {
    f.diveT = 0.28;
    f.diveCD = 0.55;
    f.swipeT = 0;
    f.vy = Math.max(f.vy, STATS.diveSpeed);
    f.vx *= STATS.diveDrift;
  } else {
    f.swipeT = STATS.swipeTime;
    f.swipeCD = STATS.swipeTime * 1.6;
    f.diveT = 0;
    if (!f.onGround) f.vy -= 60;
  }
}

function tickFighter(f: Fighter, opp: Fighter, input: Action, w: World): void {
  if (f.dead) {
    if (f.respawnT > 0) {
      f.respawnT -= STEP;
      if (f.respawnT <= 0) respawn(f, w);
    }
    return;
  }

  f.invuln = Math.max(0, f.invuln - STEP);
  f.swipeCD = Math.max(0, f.swipeCD - STEP);
  f.diveCD = Math.max(0, f.diveCD - STEP);
  f.stun = Math.max(0, f.stun - STEP);
  f.coyote = f.onGround ? COYOTE_TIME : Math.max(0, f.coyote - STEP);
  f.jumpBuf = Math.max(0, f.jumpBuf - STEP);
  f.giant = Math.max(0, f.giant - STEP);

  // Brain inputs count as held AND pressed every frame; the engine gates
  // by cooldowns, so "held" is sufficient for all transitions.
  if (input.up) f.jumpBuf = JUMP_BUFFER_TIME;

  const mx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const carrying = w.gold && w.gold.carrier === f.id;

  if (mx !== 0) f.facing = mx < 0 ? -1 : 1;
  else if (!opp.dead) f.facing = opp.x > f.x ? 1 : -1;

  if (f.stun <= 0) {
    const top = STATS.speed * (carrying ? 0.92 : 1);
    const target = mx * top;
    const acc = f.onGround ? STATS.accel : STATS.airAccel;
    f.vx = toward(f.vx, target, acc * STEP);
    if (mx === 0) {
      const drag = f.onGround ? STATS.friction : STATS.airDrag;
      f.vx = toward(f.vx, 0, drag * STEP);
    }
  }

  if (f.jumpBuf > 0) {
    if (f.onGround || f.coyote > 0) {
      f.vy = -STATS.jump;
      f.onGround = false;
      f.coyote = 0;
      f.jumpBuf = 0;
    } else if (f.wall !== 0) {
      f.vx = -f.wall * STATS.wallJumpX;
      f.vy = -STATS.wallJumpY;
      f.onGround = false;
      f.jumpBuf = 0;
      f.wall = 0;
    }
  }

  if (!input.up && f.vy < -STATS.jump * STATS.jumpCut) {
    f.vy = -STATS.jump * STATS.jumpCut;
  }

  // Attack state machine: committed animations finish before a new one
  // can start. No mid-dive cancel via swipe, no re-swipe during swipe.
  // Dive requires an explicit down-press while airborne — otherwise an
  // airborne attack is the upward aerial swipe.
  if (input.action && f.stun <= 0 && f.diveT <= 0 && f.swipeT <= 0) {
    if (!f.onGround && input.down && f.diveCD <= 0) {
      startAttack(f, "dive", w.tick);
      if (w.telemetry) {
        const t = w.telemetry[f.id];
        const m = w.brainStates[f.id].mode;
        t.dives++;
        t.modeDives[m]++;
      }
    } else if (f.swipeCD <= 0) {
      startAttack(f, "swipe", w.tick);
      if (w.telemetry) {
        const t = w.telemetry[f.id];
        const m = w.brainStates[f.id].mode;
        t.swipes++;
        t.modeSwipes[m]++;
      }
    }
  }

  if (!f.onGround && input.down) f.vy += 1200 * STEP;

  if (f.swipeT > 0) f.swipeT = Math.max(0, f.swipeT - STEP);
  if (f.diveT > 0) {
    f.diveT = Math.max(0, f.diveT - STEP);
    f.vy = Math.max(f.vy, STATS.diveSpeed);
  }

  f.vy += GRAVITY * STEP;

  const hw = STATS.bodyW * 0.5;
  const hh = STATS.bodyH * 0.5;
  const prevY = f.y;

  f.x += f.vx * STEP;
  f.wall = 0;

  if (f.x - hw < ARENA_L) {
    f.x = ARENA_L + hw;
    f.vx = Math.max(f.vx, 0);
    if (!f.onGround && input.left) {
      f.wall = -1;
      if (input.up) f.vy = toward(f.vy, -STATS.climbSpeed, 3600 * STEP);
      else f.vy = Math.min(f.vy, WALL_SLIDE);
    }
  } else if (f.x + hw > ARENA_R) {
    f.x = ARENA_R - hw;
    f.vx = Math.min(f.vx, 0);
    if (!f.onGround && input.right) {
      f.wall = 1;
      if (input.up) f.vy = toward(f.vy, -STATS.climbSpeed, 3600 * STEP);
      else f.vy = Math.min(f.vy, WALL_SLIDE);
    }
  }

  f.y += f.vy * STEP;
  f.onGround = false;

  if (f.y - hh < ARENA_T) {
    f.y = ARENA_T + hh;
    f.vy = Math.max(f.vy, 0);
  }

  for (const plat of w.stage.platforms) {
    const prevBot = prevY + hh;
    const nowBot = f.y + hh;
    const overX = f.x + hw > plat.x && f.x - hw < plat.x + plat.w;
    if (overX && prevBot <= plat.y && nowBot >= plat.y && f.vy >= 0) {
      if (!plat.solid && input.down) continue;
      f.y = plat.y - hh;
      f.vy = 0;
      f.onGround = true;
      f.wall = 0;
      break;
    }
  }

  if (f.onGround) f.diveT = 0;

  // Stuck detector — sample position every 30 ticks. If displacement
  // since the last sample is meaningful, advance lastMoveTick; otherwise
  // the brain sees a stale value and knows to force a mixup.
  if (w.tick % 30 === 0) {
    const moved = Math.hypot(f.x - f.lastSignificantX, f.y - f.lastSignificantY);
    if (moved > 40) {
      f.lastSignificantX = f.x;
      f.lastSignificantY = f.y;
      f.lastMoveTick = w.tick;
    }
  }
}

// ---------- Combat resolution ----------

function resolveCombat(w: World): void {
  const a = w.fighters[0];
  const b = w.fighters[1];
  if (a.dead || b.dead || a.invuln > 0 || b.invuln > 0) return;

  // Foiled-faithful combat: the foil is ALWAYS extended (at angle=0 when
  // idle, swiping arc during swipe, angled-down during dive). Weapons-on-
  // weapon clash (deflect); weapon-on-body kill. No "active" gating —
  // positioning is the attack.
  const sa = swordSeg(a);
  const sb = swordSeg(b);

  const clash =
    segIntersect(sa.bx, sa.by, sa.tx, sa.ty, sb.bx, sb.by, sb.tx, sb.ty) ||
    Math.hypot(sa.tx - sb.tx, sa.ty - sb.ty) < 10;
  if (clash) {
    a.vx = -a.facing * 260 / STATS.resistance;
    b.vx = -b.facing * 260 / STATS.resistance;
    a.vy = Math.min(a.vy, -150);
    b.vy = Math.min(b.vy, -150);
    a.stun = 0.09;
    b.stun = 0.09;
    a.swipeT = 0;
    b.swipeT = 0;
    a.lastClashTick = w.tick;
    b.lastClashTick = w.tick;
    if (w.telemetry) {
      w.telemetry[0].clashes++;
      w.telemetry[1].clashes++;
      w.telemetry[0].modeClashes[w.brainStates[0].mode]++;
      w.telemetry[1].modeClashes[w.brainStates[1].mode]++;
    }
    w.freeze = Math.max(w.freeze, CLASH_FREEZE);
    return;
  }

  const hitA = swordHits(sa, b);
  const hitB = swordHits(sb, a);

  if (hitA && hitB) {
    // Both passive foils hit bodies at the same tick — classic Foiled
    // head-on walk-in. The clash check missed it because parallel
    // collinear segments don't intersect. Resolve as a mutual parry,
    // not a double KO. True double-KO is reserved for committed trades
    // (both mid-swipe/dive — they can't parry during the commit).
    const aCommitted = a.swipeT > 0 || a.diveT > 0;
    const bCommitted = b.swipeT > 0 || b.diveT > 0;
    if (!aCommitted && !bCommitted) {
      a.vx = -a.facing * 260 / STATS.resistance;
      b.vx = -b.facing * 260 / STATS.resistance;
      a.vy = Math.min(a.vy, -150);
      b.vy = Math.min(b.vy, -150);
      a.stun = 0.09;
      b.stun = 0.09;
      a.lastClashTick = w.tick;
      b.lastClashTick = w.tick;
      if (w.telemetry) {
        w.telemetry[0].clashes++;
        w.telemetry[1].clashes++;
        w.telemetry[0].modeClashes[w.brainStates[0].mode]++;
        w.telemetry[1].modeClashes[w.brainStates[1].mode]++;
      }
      w.freeze = Math.max(w.freeze, CLASH_FREEZE);
      return;
    }
    doubleKO(w);
    return;
  }
  if (hitA) {
    b.vx = a.facing * STATS.hitPush / STATS.resistance;
    b.vy = -240;
    killPlayer(w, 1, 0);
  } else if (hitB) {
    a.vx = b.facing * STATS.hitPush / STATS.resistance;
    a.vy = -240;
    killPlayer(w, 0, 1);
  }
}

function respawn(f: Fighter, w: World): void {
  // Always home-side. Spawning on the goal when gold is in play drops the
  // victim on top of the carrier's delivery zone, creating an endless
  // contest loop and robbing the defender of the chance to intercept
  // mid-field. Home-side respawns let the carrier earn delivery.
  const sp = f.id === 0 ? w.stage.spawnL : w.stage.spawnR;
  f.x = sp.x;
  f.y = sp.y;
  f.vx = 0;
  f.vy = 0;
  f.dead = false;
  f.invuln = RESPAWN_INVULN_S;
  f.swipeT = 0;
  f.diveT = 0;
  f.coyote = 0;
  f.jumpBuf = 0;
  f.stun = 0;
  f.hp = 100;
}

function pickGoal(w: World): void {
  const goals = w.stage.goals;
  let i = Math.floor(w.rng() * goals.length);
  if (i === w.lastGoalIdx) i = (i + 1) % goals.length;
  w.lastGoalIdx = i;
  const g = goals[i];
  w.goal = { x: g.x, y: g.y, sx: g.sx, sy: g.sy, label: g.label, timer: GOAL_TIMER_START };
}

function killPlayer(w: World, vid: 0 | 1, kid: 0 | 1): void {
  const v = w.fighters[vid];
  const k = w.fighters[kid];
  if (v.dead || k.dead) return;
  v.dead = true;
  v.respawnT = KILL_RESPAWN_S;
  v.vx = 0;
  v.vy = 0;
  v.swipeT = 0;
  v.diveT = 0;
  v.hp = 0;
  k.lastKillTick = w.tick;
  w.killCounts[kid]++;
  w.roundKillCounts[kid]++;
  if (w.telemetry) { w.telemetry[kid].kills++; w.telemetry[vid].deaths++; }
  w.freeze = Math.max(w.freeze, HIT_FREEZE);

  if (!w.goal) pickGoal(w);

  if (!w.gold) {
    w.gold = { carrier: kid, x: k.x, y: k.y - 50, vx: 0, vy: 0, dwellT: 0 };
    if (w.goal) w.goal.timer = GOAL_TIMER_START;
    return;
  }
  if (w.gold.carrier === vid) {
    w.gold.carrier = kid;
    w.gold.dwellT = 0; // steal resets the dwell accumulator
    if (w.goal) w.goal.timer = Math.min(GOAL_TIMER_START, w.goal.timer + 1.5);
  }
}

function doubleKO(w: World): void {
  for (const p of w.fighters) {
    p.dead = true;
    p.respawnT = DOUBLE_KO_RESPAWN_S;
    p.vx = 0;
    p.vy = 0;
    p.hp = 0;
  }
  if (w.telemetry) { w.telemetry[0].deaths++; w.telemetry[1].deaths++; }
  w.gold = null;
  w.goal = null;
  w.freeze = Math.max(w.freeze, HIT_FREEZE * 1.4);
}

function scorePoint(w: World, pid: 0 | 1): void {
  const p = w.fighters[pid];
  p.score += 1;
  if (w.telemetry) w.telemetry[pid].deliveries++;
  if (p.score >= POINTS_TO_WIN_ROUND) {
    p.giant = 1.8;
    finishRound(w, pid, p.rounds + 1 >= ROUNDS_TO_WIN_MATCH ? 2.8 : 2.2);
    return;
  }
  w.roundPause = 1.0;
}

function updateGold(w: World): void {
  if (!w.gold || !w.goal) return;
  const c = w.fighters[w.gold.carrier];
  if (!c.dead) {
    const tx = c.x;
    const ty = c.y - STATS.bodyH - 12;
    w.gold.vx += (tx - w.gold.x) * 28;
    w.gold.vy += (ty - w.gold.y) * 28;
    w.gold.vx *= Math.pow(0.00005, STEP);
    w.gold.vy *= Math.pow(0.00005, STEP);
    w.gold.x += w.gold.vx * STEP;
    w.gold.y += w.gold.vy * STEP;
  }
  w.goal.timer = Math.max(0, w.goal.timer - STEP);
  if (w.goal.timer <= 0) {
    w.gold = null;
    w.goal = null;
    w.roundPause = Math.max(w.roundPause, 0.8);
    return;
  }
  if (!c.dead) {
    const dx = c.x - w.goal.x;
    const dy = c.y - STATS.bodyH * 0.5 - w.goal.y;
    const atGoal = Math.hypot(dx, dy) < GOAL_DWELL_RADIUS;
    if (atGoal) {
      w.gold.dwellT += STEP;
      if (w.gold.dwellT >= GOAL_DWELL_S) scorePoint(w, w.gold.carrier);
    } else {
      w.gold.dwellT = 0;
    }
  } else {
    w.gold.dwellT = 0;
  }
}

function resetDuel(w: World, chars: [Character, Character]): void {
  const s0 = w.fighters[0]?.score ?? 0;
  const s1 = w.fighters[1]?.score ?? 0;
  const r0 = w.fighters[0]?.rounds ?? 0;
  const r1 = w.fighters[1]?.rounds ?? 0;
  const p0 = makeFighter(0, chars[0], w.stage.spawnL, 1);
  const p1 = makeFighter(1, chars[1], w.stage.spawnR, -1);
  p0.score = s0;
  p0.rounds = r0;
  p1.score = s1;
  p1.rounds = r1;
  w.fighters[0] = p0;
  w.fighters[1] = p1;
  w.gold = null;
  w.goal = null;
  w.roundStartTick = w.tick;
  w.roundKillCounts = [0, 0];
}

export function settleWorldWinner(w: World): void {
  if (w.matchWinner !== -1) return;
  const [a, b] = w.fighters;
  if (a.rounds > b.rounds) w.matchWinner = 0;
  else if (b.rounds > a.rounds) w.matchWinner = 1;
  else if (a.score > b.score) w.matchWinner = 0;
  else if (b.score > a.score) w.matchWinner = 1;
  else if (w.killCounts[0] > w.killCounts[1]) w.matchWinner = 0;
  else if (w.killCounts[1] > w.killCounts[0]) w.matchWinner = 1;
}

function roundTimeoutWinner(w: World): -1 | 0 | 1 {
  const [a, b] = w.fighters;
  if (a.score > b.score) return 0;
  if (b.score > a.score) return 1;
  if (w.roundKillCounts[0] > w.roundKillCounts[1]) return 0;
  if (w.roundKillCounts[1] > w.roundKillCounts[0]) return 1;
  return -1;
}

function finishRound(w: World, winner: -1 | 0 | 1, pause = 1.0): void {
  if (winner !== -1) {
    w.fighters[winner].rounds += 1;
    w.roundWinner = winner;
    if (w.fighters[winner].rounds >= ROUNDS_TO_WIN_MATCH) {
      w.matchWinner = winner;
    }
  } else {
    w.roundWinner = -1;
  }
  w.gold = null;
  w.goal = null;
  w.roundPause = Math.max(w.roundPause, pause);
}

function updateRoundTimer(w: World): void {
  if (w.matchWinner !== -1 || w.roundPause > 0 || w.roundWinner !== -1) return;
  if (w.tick - w.roundStartTick < ROUND_TIMER_MAX_TICKS) return;
  finishRound(w, roundTimeoutWinner(w), 0.8);
}

// ---------- Frame log packing ----------

function packAction(a: Action): number {
  return (
    (a.left ? 1 : 0) |
    (a.right ? 2 : 0) |
    (a.up ? 4 : 0) |
    (a.down ? 8 : 0) |
    (a.action ? 16 : 0)
  );
}

function unpackAction(byte: number): Action {
  return {
    left: !!(byte & 1),
    right: !!(byte & 2),
    up: !!(byte & 4),
    down: !!(byte & 8),
    action: !!(byte & 16),
  };
}

// ---------- Public: simulate a whole match ----------

export interface SimulateOptions {
  stage: Stage;
  brainA: BrainConfig;
  brainB: BrainConfig;
  seed: number;
  chars?: [Character, Character];
  maxTicks?: number;
  // v4.0 telemetry opt-in. Default false → sim output is bit-identical to
  // the pre-telemetry behavior (no MatchResult.telemetry field set). When
  // true, tally per-fighter mode/action stats into MatchResult.telemetry.
  // The tally is pure READ of existing state; simulation is deterministic
  // and unchanged either way. BEHAVIOR_VERSION + REPLAY_CONSTANTS_HASH
  // are not affected by this flag.
  telemetry?: boolean;
}

// Opt-in per-tick telemetry. Reads BrainState.mode + substate for both
// fighters; increments mode/substate tick counters + mode-switch counter
// + zone/objective/escape entry counters when mode changes transition.
// Pure read — no behavior change.
function tallyBrainTurn(
  telemetry: [FighterTelemetry, FighterTelemetry],
  brainStates: readonly [{ mode: BrainMode; substate: string | null }, { mode: BrainMode; substate: string | null }],
  prevMode: [BrainMode | null, BrainMode | null],
): void {
  for (let i = 0; i < 2; i++) {
    const st = brainStates[i];
    const t = telemetry[i];
    t.ticks++;
    t.modeTicks[st.mode]++;
    // Substate tallying: normalize intercept-block / intercept-kill to
    // one "intercept" bucket since both serve the same diagnostic
    // question ("was time spent defending goal?").
    const sub = st.substate;
    if (sub === "press" || sub === "bait" || sub === "punish") t.substateTicks[sub]++;
    else if (sub === "deliver") t.substateTicks.deliver++;
    else if (sub === "intercept-block" || sub === "intercept-kill") t.substateTicks.intercept++;
    else if (sub === "pickup") t.substateTicks.pickup++;
    const prev = prevMode[i];
    if (prev !== null && prev !== st.mode) {
      t.modeSwitches++;
      if (st.mode === "zone") t.zoneEntries++;
      else if (st.mode === "objective") t.objectiveEntries++;
      else if (st.mode === "escape") t.escapeEntries++;
    } else if (prev === null) {
      // First observation of each mode counts as entry.
      if (st.mode === "zone") t.zoneEntries++;
      else if (st.mode === "objective") t.objectiveEntries++;
      else if (st.mode === "escape") t.escapeEntries++;
    }
    prevMode[i] = st.mode;
  }
}

export function simulate(opts: SimulateOptions): MatchResult {
  const stage = opts.stage;
  const chars = opts.chars ?? DEFAULT_CHARS;
  const maxTicks = opts.maxTicks ?? ROUND_TIMER_MAX_TICKS * ROUNDS_TO_WIN_MATCH * 2;

  const rng = makeRng(opts.seed);
  const noiseSeed = noiseSeedFromMatchSeed(opts.seed);
  const telemetry: [FighterTelemetry, FighterTelemetry] | undefined = opts.telemetry
    ? [emptyFighterTelemetry(), emptyFighterTelemetry()]
    : undefined;
  const w: World = {
    tick: 0,
    stage,
    fighters: [
      makeFighter(0, chars[0], stage.spawnL, 1),
      makeFighter(1, chars[1], stage.spawnR, -1),
    ],
    gold: null,
    goal: null,
    lastGoalIdx: -1,
    roundStartTick: 0,
    roundPause: 0,
    roundWinner: -1,
    matchWinner: -1,
    killCounts: [0, 0],
    roundKillCounts: [0, 0],
    freeze: 0,
    rng,
    noiseSeed,
    brainStates: [createBrainState(0), createBrainState(1)],
    telemetry,
  };

  const brainA = compileBrain(opts.brainA);
  const brainB = compileBrain(opts.brainB);
  // Track previous mode per fighter for switch/entry counting.
  const prevMode: [BrainMode | null, BrainMode | null] = [null, null];

  // Frame log: 2 bytes per tick (one per fighter), packed Action bitmasks
  const log: number[] = [];
  let hashAcc = 2166136261 >>> 0;

  while (w.tick < maxTicks && w.matchWinner === -1) {
    if (w.freeze > 0) {
      w.freeze -= STEP;
      w.tick++;
      continue;
    }
    if (w.roundPause > 0) {
      w.roundPause -= STEP;
      if (w.roundPause <= 0 && w.matchWinner === -1) {
        if (w.roundWinner !== -1) {
          const r0 = w.fighters[0].rounds;
          const r1 = w.fighters[1].rounds;
          resetDuel(w, chars);
          w.fighters[0].score = 0;
          w.fighters[1].score = 0;
          w.fighters[0].rounds = r0;
          w.fighters[1].rounds = r1;
          w.roundWinner = -1;
          resetBrainStateForRound(w.brainStates[0], w.tick);
          resetBrainStateForRound(w.brainStates[1], w.tick);
        } else {
          resetDuel(w, chars);
          resetBrainStateForRound(w.brainStates[0], w.tick);
          resetBrainStateForRound(w.brainStates[1], w.tick);
        }
      }
      // Respawn timers still tick during pause
      for (const p of w.fighters)
        if (p.dead && p.respawnT > 0) {
          p.respawnT -= STEP;
          if (p.respawnT <= 0) {
            respawn(p, w);
            // Own respawn = fresh neutral, but keep opp-model buffers.
            resetBrainStateForRound(w.brainStates[p.id], w.tick);
          }
        }
      w.tick++;
      continue;
    }

    const obsA = makeObs(w.fighters[0], w.fighters[1], w);
    const obsB = makeObs(w.fighters[1], w.fighters[0], w);
    const paramsA = applyHallucinationNoise(evaluateParams(brainA, obsA), w.tick, 0, w.noiseSeed);
    const paramsB = applyHallucinationNoise(evaluateParams(brainB, obsB), w.tick, 1, w.noiseSeed);
    const actA = runParamBrain(obsA, paramsA, w.brainStates[0]);
    const actB = runParamBrain(obsB, paramsB, w.brainStates[1]);

    if (telemetry) tallyBrainTurn(telemetry, w.brainStates, prevMode);

    const pa = packAction(actA);
    const pb = packAction(actB);
    log.push(pa, pb);
    // FNV-1a hash over log stream — useful for determinism checks
    hashAcc ^= pa;
    hashAcc = Math.imul(hashAcc, 16777619) >>> 0;
    hashAcc ^= pb;
    hashAcc = Math.imul(hashAcc, 16777619) >>> 0;

    tickFighter(w.fighters[0], w.fighters[1], actA, w);
    tickFighter(w.fighters[1], w.fighters[0], actB, w);
    resolveCombat(w);
    updateGold(w);
    updateRoundTimer(w);

    w.tick++;
  }

  settleWorldWinner(w);

  return {
    winner: w.matchWinner,
    finalScore: [w.fighters[0].score, w.fighters[1].score],
    finalRounds: [w.fighters[0].rounds, w.fighters[1].rounds],
    ticks: w.tick,
    seed: opts.seed,
    logHash: hashAcc.toString(16).padStart(8, "0"),
    frameLog: Uint8Array.from(log),
    ...(telemetry ? { telemetry } : {}),
  };
}

export { unpackAction, packAction };

// ========== Interactive stepper API ==========
//
// For clients (practice mode, local play) that want to drive the engine
// tick-by-tick with mixed human + AI input — not via the all-or-nothing
// simulate() function.
//
//   const w = createStepperWorld({ stage, seed });
//   while (w.matchWinner === -1) {
//     const obs = worldObservation(w, 0);
//     const actA = humanInputFromKeyboard();           // or runBrainForWorld(w, brain, 0)
//     const actB = runBrainForWorld(w, brain, 1);
//     stepWorld(w, actA, actB);
//     render(w);
//     await nextFrame();
//   }

export function createStepperWorld(opts: {
  stage: Stage;
  seed: number;
  chars?: [Character, Character];
}): World {
  const chars = opts.chars ?? DEFAULT_CHARS;
  const rng = makeRng(opts.seed);
  return {
    tick: 0,
    stage: opts.stage,
    fighters: [
      makeFighter(0, chars[0], opts.stage.spawnL, 1),
      makeFighter(1, chars[1], opts.stage.spawnR, -1),
    ],
    gold: null,
    goal: null,
    lastGoalIdx: -1,
    roundStartTick: 0,
    roundPause: 0,
    roundWinner: -1,
    matchWinner: -1,
    killCounts: [0, 0],
    roundKillCounts: [0, 0],
    freeze: 0,
    rng,
    noiseSeed: noiseSeedFromMatchSeed(opts.seed),
    brainStates: [createBrainState(0), createBrainState(1)],
  };
}

export function worldObservation(w: World, selfIdx: 0 | 1): Observation {
  return makeObs(w.fighters[selfIdx], w.fighters[1 - selfIdx], w);
}

export function runBrainForWorld(w: World, brain: CompiledBrain, selfIdx: 0 | 1): Action {
  const obs = worldObservation(w, selfIdx);
  const params = applyHallucinationNoise(evaluateParams(brain, obs), w.tick, selfIdx, w.noiseSeed);
  return runParamBrain(obs, params, w.brainStates[selfIdx]);
}

export interface StepResult {
  matchWinner: -1 | 0 | 1;
  tick: number;
}

export function stepWorld(w: World, actA: Action, actB: Action): StepResult {
  if (w.matchWinner !== -1) return { matchWinner: w.matchWinner, tick: w.tick };
  if (w.freeze > 0) {
    w.freeze -= STEP;
    w.tick++;
    return { matchWinner: w.matchWinner, tick: w.tick };
  }
  if (w.roundPause > 0) {
    w.roundPause -= STEP;
    if (w.roundPause <= 0 && w.matchWinner === -1) {
      const chars: [Character, Character] = [w.fighters[0].ch, w.fighters[1].ch];
      if (w.roundWinner !== -1) {
        const r0 = w.fighters[0].rounds;
        const r1 = w.fighters[1].rounds;
        resetDuel(w, chars);
        w.fighters[0].score = 0;
        w.fighters[1].score = 0;
        w.fighters[0].rounds = r0;
        w.fighters[1].rounds = r1;
        w.roundWinner = -1;
        resetBrainStateForRound(w.brainStates[0], w.tick);
        resetBrainStateForRound(w.brainStates[1], w.tick);
      } else {
        resetDuel(w, chars);
        resetBrainStateForRound(w.brainStates[0], w.tick);
        resetBrainStateForRound(w.brainStates[1], w.tick);
      }
    }
    for (const p of w.fighters) {
      if (p.dead && p.respawnT > 0) {
        p.respawnT -= STEP;
        if (p.respawnT <= 0) {
          respawn(p, w);
          resetBrainStateForRound(w.brainStates[p.id], w.tick);
        }
      }
    }
    w.tick++;
    return { matchWinner: w.matchWinner, tick: w.tick };
  }
  tickFighter(w.fighters[0], w.fighters[1], actA, w);
  tickFighter(w.fighters[1], w.fighters[0], actB, w);
  resolveCombat(w);
  updateGold(w);
  updateRoundTimer(w);
  w.tick++;
  return { matchWinner: w.matchWinner, tick: w.tick };
}

/** Pull the current world state into a TraceFrame (for renderers). */
export function worldToFrame(w: World): TraceFrame {
  return {
    tick: w.tick,
    p0: fighterToFrame(w.fighters[0]),
    p1: fighterToFrame(w.fighters[1]),
    token: w.gold
      ? { exists: true, x: w.gold.x, y: w.gold.y, carrier: w.gold.carrier, dwellT: w.gold.dwellT }
      : { exists: false, x: 0, y: 0, carrier: -1, dwellT: 0 },
    goal: w.goal
      ? { exists: true, x: w.goal.x, y: w.goal.y, label: w.goal.label, timer: w.goal.timer }
      : { exists: false, x: 0, y: 0, label: "", timer: 0 },
    scoreboard: [w.fighters[0].score, w.fighters[1].score],
    rounds: [w.fighters[0].rounds, w.fighters[1].rounds],
  };
}

function fighterToFrame(f: Fighter): TraceFighterFrame {
  return {
    x: f.x,
    y: f.y,
    vx: f.vx,
    vy: f.vy,
    facing: f.facing,
    onGround: f.onGround,
    wall: f.wall,
    stun: f.stun,
    swipeT: f.swipeT,
    diveT: f.diveT,
    dead: f.dead,
  };
}

export { STATS } from "./constants.js";

// ---------- simulateTrace: same as simulate but returns per-tick snapshots ----------

export interface TraceFighterFrame {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: -1 | 1;
  onGround: boolean;
  wall: -1 | 0 | 1;
  stun: number;
  swipeT: number;
  diveT: number;
  dead: boolean;
}

export interface TraceFrame {
  tick: number;
  p0: TraceFighterFrame;
  p1: TraceFighterFrame;
  token: { exists: boolean; x: number; y: number; carrier: 0 | 1 | -1; dwellT: number };
  goal: { exists: boolean; x: number; y: number; label: string; timer: number };
  scoreboard: [number, number];
  rounds: [number, number];
}

export interface TraceResult {
  result: MatchResult;
  frames: TraceFrame[];
  stage: Stage;
}

export function simulateTrace(opts: SimulateOptions): TraceResult {
  const stage = opts.stage;
  const chars = opts.chars ?? DEFAULT_CHARS;
  const maxTicks = opts.maxTicks ?? ROUND_TIMER_MAX_TICKS * ROUNDS_TO_WIN_MATCH * 2;
  const rng = makeRng(opts.seed);
  const noiseSeed = noiseSeedFromMatchSeed(opts.seed);
  const w: World = {
    tick: 0,
    stage,
    fighters: [makeFighter(0, chars[0], stage.spawnL, 1), makeFighter(1, chars[1], stage.spawnR, -1)],
    gold: null, goal: null, lastGoalIdx: -1, roundStartTick: 0,
    roundPause: 0, roundWinner: -1, matchWinner: -1,
    killCounts: [0, 0], roundKillCounts: [0, 0], freeze: 0, rng, noiseSeed,
    brainStates: [createBrainState(0), createBrainState(1)],
  };
  const brainA = compileBrain(opts.brainA);
  const brainB = compileBrain(opts.brainB);
  const log: number[] = [];
  const frames: TraceFrame[] = [];
  let hashAcc = 2166136261 >>> 0;

  const snap = (): TraceFrame => ({
    tick: w.tick,
    p0: fighterToFrame(w.fighters[0]),
    p1: fighterToFrame(w.fighters[1]),
    token: w.gold ? { exists: true, x: w.gold.x, y: w.gold.y, carrier: w.gold.carrier, dwellT: w.gold.dwellT } : { exists: false, x: 0, y: 0, carrier: -1, dwellT: 0 },
    goal: w.goal ? { exists: true, x: w.goal.x, y: w.goal.y, label: w.goal.label, timer: w.goal.timer } : { exists: false, x: 0, y: 0, label: "", timer: 0 },
    scoreboard: [w.fighters[0].score, w.fighters[1].score],
    rounds: [w.fighters[0].rounds, w.fighters[1].rounds],
  });

  while (w.tick < maxTicks && w.matchWinner === -1) {
    if (w.freeze > 0) { w.freeze -= STEP; frames.push(snap()); w.tick++; continue; }
    if (w.roundPause > 0) {
      w.roundPause -= STEP;
      if (w.roundPause <= 0 && w.matchWinner === -1) {
        if (w.roundWinner !== -1) {
          const r0 = w.fighters[0].rounds, r1 = w.fighters[1].rounds;
          resetDuel(w, chars);
          w.fighters[0].score = 0; w.fighters[1].score = 0;
          w.fighters[0].rounds = r0; w.fighters[1].rounds = r1;
          w.roundWinner = -1;
          resetBrainStateForRound(w.brainStates[0], w.tick);
          resetBrainStateForRound(w.brainStates[1], w.tick);
        } else {
          resetDuel(w, chars);
          resetBrainStateForRound(w.brainStates[0], w.tick);
          resetBrainStateForRound(w.brainStates[1], w.tick);
        }
      }
      for (const p of w.fighters) if (p.dead && p.respawnT > 0) {
        p.respawnT -= STEP;
        if (p.respawnT <= 0) {
          respawn(p, w);
          resetBrainStateForRound(w.brainStates[p.id], w.tick);
        }
      }
      frames.push(snap());
      w.tick++;
      continue;
    }
    const obsA = makeObs(w.fighters[0], w.fighters[1], w);
    const obsB = makeObs(w.fighters[1], w.fighters[0], w);
    const paramsA = applyHallucinationNoise(evaluateParams(brainA, obsA), w.tick, 0, w.noiseSeed);
    const paramsB = applyHallucinationNoise(evaluateParams(brainB, obsB), w.tick, 1, w.noiseSeed);
    const actA = runParamBrain(obsA, paramsA, w.brainStates[0]);
    const actB = runParamBrain(obsB, paramsB, w.brainStates[1]);
    const pa = packAction(actA), pb = packAction(actB);
    log.push(pa, pb);
    hashAcc ^= pa; hashAcc = Math.imul(hashAcc, 16777619) >>> 0;
    hashAcc ^= pb; hashAcc = Math.imul(hashAcc, 16777619) >>> 0;
    tickFighter(w.fighters[0], w.fighters[1], actA, w);
    tickFighter(w.fighters[1], w.fighters[0], actB, w);
    resolveCombat(w);
    updateGold(w);
    updateRoundTimer(w);
    frames.push(snap());
    w.tick++;
  }

  settleWorldWinner(w);

  return {
    result: {
      winner: w.matchWinner,
      finalScore: [w.fighters[0].score, w.fighters[1].score],
      finalRounds: [w.fighters[0].rounds, w.fighters[1].rounds],
      ticks: w.tick, seed: opts.seed,
      logHash: hashAcc.toString(16).padStart(8, "0"),
      frameLog: Uint8Array.from(log),
    },
    frames,
    stage,
  };
}
