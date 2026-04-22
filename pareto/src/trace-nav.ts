// trace-nav — navigation / clash / chase diagnostics for candidate knob selection.
//
// This is intentionally read-only: it runs current presets through the
// deterministic sim and records derived events. It does not change brain
// behavior or replay semantics.
//
// Usage:
//   node pareto/dist/trace-nav.js --seeds 30 --out /tmp/trace-nav-v7.json
//
// Pre-registered poise gate:
//   1. Bucket per-tick mode switches by score-deficit inside each
//      (preset, opponent, stage) stratum.
//   2. Estimate a within-stratum slope:
//        mode-switches/minute = intercept + slope * scoreDeficit
//   3. Estimate the noise floor from mirror self-play strata only.
//   4. poise ships only if >=4/16 presets have:
//        abs(mean non-mirror slope) >= max(0.20, 2 * mirrorNoiseP95)
//        and >=65% of non-mirror strata agree on the slope sign.
//   This prevents deciding the threshold after seeing the poise result.

import fs from "node:fs";
import {
  GRAVITY,
  POINTS_TO_WIN_ROUND,
  ROUND_TIMER_MAX_TICKS,
  ROUNDS_TO_WIN_MATCH,
  STAGES,
  STATS,
  STRATEGIES,
  STRATEGY_NAMES,
  compileBrain,
  createStepperWorld,
  emptyFighterTelemetry,
  runBrainForWorld,
  stepWorld,
  type Action,
  type BrainMode,
  type Fighter,
  type Goal,
  type Stage,
  type StrategyName,
  type World,
} from "@m3t4/sim";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const name = k.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[name] = v;
  }
  return out;
}

const args = parseArgs(process.argv);
const SEEDS = parseInt(args.seeds ?? "30", 10);
const OUT = args.out ?? "/tmp/trace-nav.json";
const MAX_TICKS = ROUND_TIMER_MAX_TICKS * ROUNDS_TO_WIN_MATCH * 2;
const CHASE_WINDOW_TICKS = 180;
const ROUTE_DETOUR_EPISODE_TICKS = 24;

type SideStats = {
  matches: number;
  ticks: number;
  actionTicks: number;
  upTicks: number;
  downTicks: number;
  swipes: number;
  dives: number;
  clashes: number;
  kills: number;
  deliveries: number;
  deliveryCancels: number;
  deliveryFeintCancels: number;
  deliveryKillFirstCancels: number;
  modeSwitches: number;
  escapeEntries: number;
  firstActionTicks: number[];
  firstOffenseTicks: number[];

  directJumpOpportunityTicks: number;
  directJumpCommandedTicks: number;
  directJumpMissedTicks: number;
  directJumpEpisodes: number;
  directJumpMissedEpisodes: number;
  directJumpDelayTicks: number;
  directJumpDelayEpisodes: number;
  deliveryTicksAfterDirectAvailable: number;
  deliveryEpisodesAfterDirectAvailable: number;

  horizontalRouteOpportunityTicks: number;
  horizontalRouteDetourTicks: number;
  horizontalRouteDetourEpisodes: number;
  horizontalRouteDetourOverlapWithLift: number;

  parryWindowTicks: number;
  parryWindowCounterTicks: number;
  postClashCounterTicks: number;

  chaseWindowTicks: number;
  chaseTowardTicks: number;
  chaseAwayTicks: number;
  chaseActionTicks: number;
};

type DeficitBucket = { ticks: number; switches: number };
type DeficitStratum = {
  preset: string;
  opponent: string;
  stage: string;
  mirror: boolean;
  buckets: Map<number, DeficitBucket>;
};

function emptyStats(): SideStats {
  return {
    matches: 0,
    ticks: 0,
    actionTicks: 0,
    upTicks: 0,
    downTicks: 0,
    swipes: 0,
    dives: 0,
    clashes: 0,
    kills: 0,
    deliveries: 0,
    deliveryCancels: 0,
    deliveryFeintCancels: 0,
    deliveryKillFirstCancels: 0,
    modeSwitches: 0,
    escapeEntries: 0,
    firstActionTicks: [],
    firstOffenseTicks: [],
    directJumpOpportunityTicks: 0,
    directJumpCommandedTicks: 0,
    directJumpMissedTicks: 0,
    directJumpEpisodes: 0,
    directJumpMissedEpisodes: 0,
    directJumpDelayTicks: 0,
    directJumpDelayEpisodes: 0,
    deliveryTicksAfterDirectAvailable: 0,
    deliveryEpisodesAfterDirectAvailable: 0,
    horizontalRouteOpportunityTicks: 0,
    horizontalRouteDetourTicks: 0,
    horizontalRouteDetourEpisodes: 0,
    horizontalRouteDetourOverlapWithLift: 0,
    parryWindowTicks: 0,
    parryWindowCounterTicks: 0,
    postClashCounterTicks: 0,
    chaseWindowTicks: 0,
    chaseTowardTicks: 0,
    chaseAwayTicks: 0,
    chaseActionTicks: 0,
  };
}

function add(to: SideStats, key: keyof SideStats, value = 1): void {
  const cur = to[key];
  if (typeof cur !== "number") throw new Error(`cannot add to array field ${String(key)}`);
  (to as unknown as Record<string, number>)[key as string] = cur + value;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const a = xs.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const a = xs.slice().sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1));
  return a[idx];
}

function directJumpFeasible(f: Fighter, goal: Goal): boolean {
  const targetY = goal.y + STATS.bodyH * 0.5;
  const height = f.y - targetY;
  const maxJumpHeight = (STATS.jump * STATS.jump) / (2 * GRAVITY);
  if (!f.onGround || height < 35 || height > maxJumpHeight - 8) return false;
  const disc = STATS.jump * STATS.jump - 2 * GRAVITY * height;
  if (disc <= 0) return false;
  const timeToTargetY = (STATS.jump - Math.sqrt(disc)) / GRAVITY;
  const usefulAirTime = Math.max(0.25, timeToTargetY + 0.22);
  const dx = Math.abs(goal.x - f.x);
  return dx <= 95 || dx <= STATS.speed * usefulAirTime * 0.75;
}

function signedMove(act: Action): -1 | 0 | 1 {
  return (act.right ? 1 : 0) > (act.left ? 1 : 0)
    ? 1
    : (act.left ? 1 : 0) > (act.right ? 1 : 0) ? -1 : 0;
}

function scoreDeficit(w: World, id: 0 | 1): number {
  const self = w.fighters[id];
  const opp = w.fighters[1 - id];
  const roundDeficit = (opp.rounds - self.rounds) * POINTS_TO_WIN_ROUND;
  return Math.max(0, roundDeficit + (opp.score - self.score));
}

function distanceToOpp(w: World, id: 0 | 1): number {
  const self = w.fighters[id];
  const opp = w.fighters[1 - id];
  return Math.hypot(self.x - opp.x, self.y - opp.y);
}

function parryWindow(w: World, id: 0 | 1): boolean {
  const self = w.fighters[id];
  const opp = w.fighters[1 - id];
  const absDist = Math.hypot(opp.x - self.x, opp.y - self.y);
  const recentClash = w.tick - self.lastClashTick < 90;
  const incomingBlade = opp.swipeT > 0 && absDist < STATS.sword + 75;
  const passiveFoilRange = absDist < STATS.sword + 45 && Math.sign(self.x - opp.x) === opp.facing;
  return recentClash || incomingBlade || passiveFoilRange;
}

function horizontalRouteOpportunity(w: World, id: 0 | 1, directJump: boolean): boolean {
  if (directJump || !w.goal || !w.gold || w.gold.carrier !== id) return false;
  const f = w.fighters[id];
  const targetY = w.goal.y + STATS.bodyH * 0.5;
  const dx = Math.abs(w.goal.x - f.x);
  const dy = Math.abs(targetY - f.y);
  if (dx < 70 || dy > 75) return false;
  const opp = w.fighters[1 - id];
  const oppBetween = Math.sign(w.goal.x - f.x) === Math.sign(opp.x - f.x)
    && Math.abs(opp.x - f.x) < dx
    && Math.hypot(opp.x - f.x, opp.y - f.y) < 145;
  return !oppBetween;
}

function summarizeStats(s: SideStats): Record<string, number | null> {
  const div = (n: number, d: number) => d > 0 ? n / d : 0;
  return {
    matches: s.matches,
    directJumpMissRate: +div(s.directJumpMissedTicks, s.directJumpOpportunityTicks).toFixed(3),
    directJumpEpisodeMissRate: +div(s.directJumpMissedEpisodes, s.directJumpEpisodes).toFixed(3),
    directJumpDelayTicksAvg: +(s.directJumpDelayEpisodes ? s.directJumpDelayTicks / s.directJumpDelayEpisodes : 0).toFixed(1),
    deliveryTicksAfterDirectAvailableAvg: +(s.deliveryEpisodesAfterDirectAvailable ? s.deliveryTicksAfterDirectAvailable / s.deliveryEpisodesAfterDirectAvailable : 0).toFixed(1),
    deliveryCancelsPerMatch: +div(s.deliveryCancels, s.matches).toFixed(3),
    deliveryFeintCancelsPerMatch: +div(s.deliveryFeintCancels, s.matches).toFixed(3),
    deliveryKillFirstCancelsPerMatch: +div(s.deliveryKillFirstCancels, s.matches).toFixed(3),
    directJumpEpisodesPerMatch: +div(s.directJumpEpisodes, s.matches).toFixed(2),
    horizontalRouteDetourRate: +div(s.horizontalRouteDetourTicks, s.horizontalRouteOpportunityTicks).toFixed(3),
    horizontalRouteDetoursPerMatch: +div(s.horizontalRouteDetourEpisodes, s.matches).toFixed(2),
    routeLiftOverlapRate: +div(s.horizontalRouteDetourOverlapWithLift, s.horizontalRouteDetourEpisodes).toFixed(3),
    parryCounterRate: +div(s.parryWindowCounterTicks, s.parryWindowTicks).toFixed(3),
    postClashCounterRate: +div(s.postClashCounterTicks, s.parryWindowTicks).toFixed(3),
    chaseTowardRate: +div(s.chaseTowardTicks, s.chaseWindowTicks).toFixed(3),
    chaseAwayRate: +div(s.chaseAwayTicks, s.chaseWindowTicks).toFixed(3),
    chaseActionRate: +div(s.chaseActionTicks, s.chaseWindowTicks).toFixed(3),
    firstActionMedian: median(s.firstActionTicks),
    firstOffenseMedian: median(s.firstOffenseTicks),
    clashPerMatch: +div(s.clashes, s.matches).toFixed(2),
    attackPerMatch: +div(s.swipes + s.dives, s.matches).toFixed(2),
    killPerMatch: +div(s.kills, s.matches).toFixed(2),
    deliveryPerMatch: +div(s.deliveries, s.matches).toFixed(2),
    modeSwitchPerMinute: +div(s.modeSwitches, s.ticks / 120 / 60).toFixed(3),
  };
}

function stratumKey(preset: string, opponent: string, stage: Stage): string {
  return `${preset}|${opponent}|${stage.id}`;
}

function bucketFor(
  strata: Map<string, DeficitStratum>,
  preset: string,
  opponent: string,
  stage: Stage,
  deficit: number,
): DeficitBucket {
  const key = stratumKey(preset, opponent, stage);
  let st = strata.get(key);
  if (!st) {
    st = { preset, opponent, stage: stage.id, mirror: preset === opponent, buckets: new Map() };
    strata.set(key, st);
  }
  let b = st.buckets.get(deficit);
  if (!b) {
    b = { ticks: 0, switches: 0 };
    st.buckets.set(deficit, b);
  }
  return b;
}

function weightedSlope(points: Array<{ x: number; y: number; w: number }>): number | null {
  const usable = points.filter((p) => p.w > 0);
  if (usable.length < 2) return null;
  const wsum = usable.reduce((s, p) => s + p.w, 0);
  const mx = usable.reduce((s, p) => s + p.x * p.w, 0) / wsum;
  const my = usable.reduce((s, p) => s + p.y * p.w, 0) / wsum;
  let cov = 0;
  let vx = 0;
  for (const p of usable) {
    cov += p.w * (p.x - mx) * (p.y - my);
    vx += p.w * (p.x - mx) * (p.x - mx);
  }
  return vx > 0 ? cov / vx : null;
}

function poiseReport(strata: Map<string, DeficitStratum>): {
  threshold: number;
  mirrorNoiseP95: number;
  clears: boolean;
  clearCount: number;
  requiredCount: number;
  presetSlopes: Array<{
    name: string;
    meanSlope: number;
    medianSlope: number | null;
    signAgreement: number;
    strata: number;
    clears: boolean;
  }>;
} {
  const perPreset = new Map<string, number[]>();
  const mirrorSlopes: number[] = [];

  for (const st of strata.values()) {
    const points = Array.from(st.buckets.entries())
      .filter(([, b]) => b.ticks >= 120)
      .map(([deficit, b]) => ({
        x: deficit,
        y: b.switches / (b.ticks / 120 / 60),
        w: b.ticks,
      }));
    const slope = weightedSlope(points);
    if (slope === null || !Number.isFinite(slope)) continue;
    if (st.mirror) mirrorSlopes.push(Math.abs(slope));
    else {
      const arr = perPreset.get(st.preset) ?? [];
      arr.push(slope);
      perPreset.set(st.preset, arr);
    }
  }

  const mirrorNoiseP95 = percentile(mirrorSlopes, 0.95);
  const threshold = Math.max(0.20, mirrorNoiseP95 * 2);
  const presetSlopes = STRATEGY_NAMES.map((name) => {
    const slopes = perPreset.get(name) ?? [];
    const meanSlope = slopes.length ? slopes.reduce((s, v) => s + v, 0) / slopes.length : 0;
    const sign = Math.sign(meanSlope);
    const signAgreement = slopes.length && sign !== 0
      ? slopes.filter((s) => Math.sign(s) === sign).length / slopes.length
      : 0;
    const clears = Math.abs(meanSlope) >= threshold && signAgreement >= 0.65;
    return {
      name,
      meanSlope: +meanSlope.toFixed(3),
      medianSlope: median(slopes)?.toFixed(3) ? +(median(slopes) as number).toFixed(3) : null,
      signAgreement: +signAgreement.toFixed(3),
      strata: slopes.length,
      clears,
    };
  });
  const clearCount = presetSlopes.filter((p) => p.clears).length;
  return {
    threshold: +threshold.toFixed(3),
    mirrorNoiseP95: +mirrorNoiseP95.toFixed(3),
    clears: clearCount >= 4,
    clearCount,
    requiredCount: 4,
    presetSlopes,
  };
}

const names = STRATEGY_NAMES as readonly StrategyName[];
const stages = Object.values(STAGES);
const brains = new Map(names.map((n) => [n, compileBrain(STRATEGIES[n])]));
const perPreset = new Map<string, SideStats>(names.map((n) => [n, emptyStats()]));
const globalStats = emptyStats();
const strata = new Map<string, DeficitStratum>();

function mergeGlobal(from: SideStats): void {
  for (const [key, value] of Object.entries(from)) {
    if (Array.isArray(value)) (globalStats as unknown as Record<string, number[]>)[key].push(...value);
    else (globalStats as unknown as Record<string, number>)[key] += value;
  }
}

const totalMatches = names.length * names.length * stages.length * SEEDS;
let done = 0;
const started = Date.now();
console.log(`[trace-nav] presets=${names.length} stages=${stages.length} seeds=${SEEDS} matches=${totalMatches}`);

for (const aName of names) {
  for (const bName of names) {
    for (const stage of stages) {
      for (let si = 0; si < SEEDS; si++) {
        const seed = ((si + 1) * 1009 + names.indexOf(aName) * 97 + names.indexOf(bName) * 389 + stage.id.length * 53) >>> 0;
        const w = createStepperWorld({ stage, seed });
        w.telemetry = [emptyFighterTelemetry(), emptyFighterTelemetry()];
        const matchStats = [emptyStats(), emptyStats()] as const;
        const pairNames = [aName, bName] as const;
        const prevMode: [BrainMode, BrainMode] = [w.brainStates[0].mode, w.brainStates[1].mode];
        const firstAction: [number, number] = [-1, -1];
        const firstOffense: [number, number] = [-1, -1];
        const directEpisode = [false, false];
        const directEpisodeHadJump = [false, false];
        const directEpisodeDelay = [0, 0];
        const directDeliveryEpisode = [false, false];
        const directDeliveryTicks = [0, 0];
        const routeDetourRun = [0, 0];
        const routeDetourOverlappedLift = [false, false];
        const chaseUntil = [-1, -1];
        const chaseStartDist = [0, 0];
        const chaseLiveBaseline = [false, false];

        while (w.matchWinner === -1 && w.tick < MAX_TICKS) {
          let acts: [Action, Action] = [{}, {}];
          if (w.freeze <= 0 && w.roundPause <= 0) {
            acts = [
              runBrainForWorld(w, brains.get(aName)!, 0),
              runBrainForWorld(w, brains.get(bName)!, 1),
            ];

            for (const id of [0, 1] as const) {
              const ms = matchStats[id];
              const f = w.fighters[id];
              const name = pairNames[id];
              const oppName = pairNames[1 - id];
              const act = acts[id];
              add(ms, "ticks");
              if (act.action || act.up || act.down || act.left || act.right) add(ms, "actionTicks");
              if (act.up) add(ms, "upTicks");
              if (act.down) add(ms, "downTicks");
              if (act.action && firstAction[id] < 0) firstAction[id] = w.tick;
              if (w.brainStates[id].mode === "offense" && firstOffense[id] < 0) firstOffense[id] = w.tick;

              const deficit = scoreDeficit(w, id);
              const modeChanged = w.brainStates[id].mode !== prevMode[id];
              const db = bucketFor(strata, name, oppName, stage, deficit);
              db.ticks++;
              if (modeChanged) {
                db.switches++;
                add(ms, "modeSwitches");
                prevMode[id] = w.brainStates[id].mode;
              }
              if (w.brainStates[id].lastDeliveryCancelTick === w.tick) {
                add(ms, "deliveryCancels");
                if (w.brainStates[id].lastDeliveryCancelTactic === "feint") add(ms, "deliveryFeintCancels");
                else if (w.brainStates[id].lastDeliveryCancelTactic === "kill-first") add(ms, "deliveryKillFirstCancels");
              }

              const carrying = !!(w.gold && w.gold.carrier === id && w.goal);
              const directJump = carrying ? directJumpFeasible(f, w.goal!) : false;
              if (directJump) {
                add(ms, "directJumpOpportunityTicks");
                if (act.up) add(ms, "directJumpCommandedTicks");
                else add(ms, "directJumpMissedTicks");
                if (!directEpisode[id]) {
                  directEpisode[id] = true;
                  directEpisodeHadJump[id] = false;
                  directEpisodeDelay[id] = 0;
                  add(ms, "directJumpEpisodes");
                }
                if (!directEpisodeHadJump[id]) {
                  if (act.up) {
                    directEpisodeHadJump[id] = true;
                    add(ms, "directJumpDelayTicks", directEpisodeDelay[id]);
                    add(ms, "directJumpDelayEpisodes");
                  } else {
                    directEpisodeDelay[id]++;
                  }
                }
                if (!directDeliveryEpisode[id]) {
                  directDeliveryEpisode[id] = true;
                  directDeliveryTicks[id] = 0;
                }
              } else if (directEpisode[id]) {
                if (!directEpisodeHadJump[id]) add(ms, "directJumpMissedEpisodes");
                directEpisode[id] = false;
              }

              if (directDeliveryEpisode[id]) {
                directDeliveryTicks[id]++;
                const atGoal = w.goal
                  ? Math.hypot(f.x - w.goal.x, f.y - STATS.bodyH * 0.5 - w.goal.y) < 40
                  : false;
                if (!carrying || atGoal) {
                  add(ms, "deliveryTicksAfterDirectAvailable", directDeliveryTicks[id]);
                  add(ms, "deliveryEpisodesAfterDirectAvailable");
                  directDeliveryEpisode[id] = false;
                }
              }

              const routeOpp = horizontalRouteOpportunity(w, id, directJump);
              if (routeOpp) {
                add(ms, "horizontalRouteOpportunityTicks");
                const goalDir = Math.sign(w.goal!.x - f.x);
                const move = signedMove(act);
                const detour = move === 0 || move !== goalDir;
                if (detour) {
                  add(ms, "horizontalRouteDetourTicks");
                  routeDetourRun[id]++;
                  routeDetourOverlappedLift[id] ||= directEpisode[id];
                } else if (routeDetourRun[id] > 0) {
                  if (routeDetourRun[id] >= ROUTE_DETOUR_EPISODE_TICKS) {
                    add(ms, "horizontalRouteDetourEpisodes");
                    if (routeDetourOverlappedLift[id]) add(ms, "horizontalRouteDetourOverlapWithLift");
                  }
                  routeDetourRun[id] = 0;
                  routeDetourOverlappedLift[id] = false;
                }
              } else if (routeDetourRun[id] > 0) {
                if (routeDetourRun[id] >= ROUTE_DETOUR_EPISODE_TICKS) {
                  add(ms, "horizontalRouteDetourEpisodes");
                  if (routeDetourOverlappedLift[id]) add(ms, "horizontalRouteDetourOverlapWithLift");
                }
                routeDetourRun[id] = 0;
                routeDetourOverlappedLift[id] = false;
              }

              if (parryWindow(w, id)) {
                add(ms, "parryWindowTicks");
                if (act.action) add(ms, "parryWindowCounterTicks");
                if (w.tick - f.lastClashTick < 90 && act.action) add(ms, "postClashCounterTicks");
              }

              if (chaseUntil[id] > w.tick && !w.fighters[1 - id].dead) {
                const distNow = distanceToOpp(w, id);
                if (!chaseLiveBaseline[id]) {
                  chaseStartDist[id] = distNow;
                  chaseLiveBaseline[id] = true;
                }
                add(ms, "chaseWindowTicks");
                const toward = distNow < chaseStartDist[id] - 8;
                const away = distNow > chaseStartDist[id] + 40;
                if (toward) add(ms, "chaseTowardTicks");
                if (away) add(ms, "chaseAwayTicks");
                if (act.action) add(ms, "chaseActionTicks");
              }
            }
          }

          const beforeKills: [number, number] = [w.killCounts[0], w.killCounts[1]];
          stepWorld(w, acts[0], acts[1]);
          for (const id of [0, 1] as const) {
            if (w.killCounts[id] > beforeKills[id]) {
              add(matchStats[id], "kills", w.killCounts[id] - beforeKills[id]);
              chaseUntil[id] = w.tick + CHASE_WINDOW_TICKS;
              chaseStartDist[id] = distanceToOpp(w, id);
              chaseLiveBaseline[id] = false;
            }
          }
        }

        for (const id of [0, 1] as const) {
          const ms = matchStats[id];
          const t = w.telemetry[id];
          add(ms, "matches");
          add(ms, "swipes", t.swipes);
          add(ms, "dives", t.dives);
          add(ms, "clashes", t.clashes);
          add(ms, "deliveries", t.deliveries);
          add(ms, "escapeEntries", t.escapeEntries);
          if (firstAction[id] >= 0) ms.firstActionTicks.push(firstAction[id]);
          if (firstOffense[id] >= 0) ms.firstOffenseTicks.push(firstOffense[id]);
          if (directEpisode[id] && !directEpisodeHadJump[id]) add(ms, "directJumpMissedEpisodes");
          if (routeDetourRun[id] >= ROUTE_DETOUR_EPISODE_TICKS) {
            add(ms, "horizontalRouteDetourEpisodes");
            if (routeDetourOverlappedLift[id]) add(ms, "horizontalRouteDetourOverlapWithLift");
          }

          const presetStats = perPreset.get(pairNames[id])!;
          mergeInto(presetStats, ms);
        }

        done++;
        if (done % Math.max(1, Math.floor(totalMatches / 20)) === 0) {
          const elapsed = (Date.now() - started) / 1000;
          const eta = elapsed / done * (totalMatches - done);
          console.log(`[trace-nav] ${done}/${totalMatches} elapsed=${elapsed.toFixed(0)}s eta=${eta.toFixed(0)}s`);
        }
      }
    }
  }
}

function mergeInto(to: SideStats, from: SideStats): void {
  for (const [key, value] of Object.entries(from)) {
    if (Array.isArray(value)) (to as unknown as Record<string, number[]>)[key].push(...value);
    else (to as unknown as Record<string, number>)[key] += value;
  }
}

for (const stats of perPreset.values()) mergeGlobal(stats);

type ReportRow = { name: string } & Record<string, number | string | null>;

const rows: ReportRow[] = Array.from(perPreset.entries()).map(([name, stats]) => ({
  name,
  ...summarizeStats(stats),
}));
const poise = poiseReport(strata);

const routeDetourRows = rows
  .slice()
  .sort((a, b) => Number(b.horizontalRouteDetourRate) - Number(a.horizontalRouteDetourRate));
const liftRows = rows
  .slice()
  .sort((a, b) => Number(b.directJumpEpisodeMissRate) - Number(a.directJumpEpisodeMissRate));
const parryRows = rows
  .slice()
  .sort((a, b) => Number(b.clashPerMatch) - Number(a.clashPerMatch));
const chaseRows = rows
  .slice()
  .sort((a, b) => Number(a.chaseTowardRate) - Number(b.chaseTowardRate));

const routeIndependent =
  (summarizeStats(globalStats).horizontalRouteDetourRate as number) >= 0.12 &&
  (summarizeStats(globalStats).routeLiftOverlapRate as number) <= 0.35;

const recommendation = {
  ship: [
    "lift",
    "parry",
    "chase",
    ...(poise.clears ? ["poise"] : routeIndependent ? ["discipline"] : []),
  ],
  hold: [
    ...(poise.clears ? [] : ["poise"]),
    ...(routeIndependent ? [] : ["discipline"]),
  ],
  rationale: {
    poiseGateCleared: poise.clears,
    disciplineIndependent: routeIndependent,
    threeRealBeatsFourWithOneParasite: !poise.clears && !routeIndependent,
  },
};

const report = {
  generatedAt: new Date().toISOString(),
  seeds: SEEDS,
  totalMatches,
  maxTicks: MAX_TICKS,
  preRegisteredGates: {
    poise: {
      rule: "ship iff >=4 presets have abs(mean non-mirror slope) >= max(0.20, 2*mirrorNoiseP95) and signAgreement >= 0.65",
      units: "mode-switches/minute per score-deficit point",
    },
    discipline: {
      rule: "candidate only if horizontalRouteDetourRate >= 0.12 and routeLiftOverlapRate <= 0.35",
      split: "lift owns high-goal direct-jump opportunities; discipline owns same-height/low-height shortest-route detours only",
    },
  },
  summary: summarizeStats(globalStats),
  poise,
  recommendation,
  topLiftDelay: liftRows.slice(0, 8),
  topRouteDetour: routeDetourRows.slice(0, 8),
  topClashPressure: parryRows.slice(0, 8),
  weakestChase: chaseRows.slice(0, 8),
  presets: rows,
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log("\n=== Trace nav report ===");
console.log(`matches: ${totalMatches}`);
console.log(`summary: ${JSON.stringify(report.summary)}`);
console.log(`poise gate: ${poise.clears ? "PASS" : "FAIL"} (${poise.clearCount}/${poise.requiredCount}), threshold=${poise.threshold}, mirrorNoiseP95=${poise.mirrorNoiseP95}`);
console.log(`discipline independent: ${routeIndependent ? "yes" : "no"}`);
console.log(`recommendation: ship ${recommendation.ship.join(", ") || "none"}; hold ${recommendation.hold.join(", ") || "none"}`);
console.log(`report: ${OUT}`);
