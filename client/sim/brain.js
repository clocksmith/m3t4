import { GOAL_DWELL_RADIUS, GOAL_DWELL_S, KILL_RESPAWN_S, GRAVITY, RESPAWN_INVULN_S, STATS, STEP, } from "./constants.js";
// v3: Intent state machine. Five modes — neutral, offense, zone,
// objective, escape — each with its own behavior loop and minimum
// commitment window. Replaces v2's per-tick reactive ladder. Params
// bias mode transitions and tactical details within each mode; they no
// longer drive behavior directly via a flat if/else.
// v16: objective navigation gets a tiny platform graph, and clash-loop
// symmetry breaking treats near-dominant anti-loop traits as equivalent.
// v17: physics integration order is seed-flipped by the simulator, so
// fighter 0 no longer always receives first integration order. Brain
// anti-mirror policy remains id-asymmetric to preserve counter-cycles.
// v18: repeated-clash mixups trigger sooner, so fights leave foil-locks
// before they read as the same collision loop.
// v19: fighter body hitbox grows modestly to 28x56 so gameplay scale and
// unscaled 64x64 character sheets align without a hidden render multiplier.
// v20: platform routing weighs bounded tactical intent, so equally
// reachable steps prefer goal progress without ignoring landing danger.
// v21: direct delivery plans cancel into a feint or kill-first answer when
// the carrier has stopped making goal progress behind a live blocker.
export const BEHAVIOR_VERSION = 21;
// ---------- Opp-model buffer sizing ----------
//
// Bounded ring: max 16 entries per stream, hard decay at 240 ticks (2 s).
// That's enough to see "opp threw 8 swipes in the last second" without
// letting the buffer grow unbounded. oppAggression = count / 2.0 → 0..1
// when spam is sustained.
const OPP_BUFFER_MAX = 16;
const OPP_BUFFER_DECAY_TICKS = 240;
// ---------- Mode commitment math ----------
//
// Each mode has a minimum duration before it can yield to a non-emergency
// transition. Emergency triggers (imminent death, token state change)
// bypass this. Pacing scales these: low pacing → longer commits (patient),
// high pacing → shorter (mixup-y). Effective = base * (1.5 - pacing).
const MIN_DURATION = {
    neutral: 0,
    offense: 20,
    zone: 40,
    objective: 10,
    escape: 45,
};
// Derived from STATS.swipeTime (0.12s = ~14.4 ticks) and swipeCD (0.192s
// = ~23 ticks). Recovery window = ticks after a swipe starts during which
// opp is no longer active (swipeT=0) but can't yet restart (swipeCD>0).
const SWIPE_ACTIVE_TICKS = Math.ceil(STATS.swipeTime / STEP);
const SWIPE_FULL_CD_TICKS = Math.ceil(STATS.swipeTime * 1.6 / STEP);
const RECOVERY_WINDOW_START = SWIPE_ACTIVE_TICKS;
const RECOVERY_WINDOW_END = SWIPE_FULL_CD_TICKS + 2; // small slack
const PASSIVE_FOIL_DANGER_RANGE = STATS.sword + STATS.bodyW;
const CLASH_LOOP_THRESHOLD = 8;
// v5.1 anti-stalemate constants
//
// OFFENSE_COMMIT_TIMEOUT_TICKS: if a bot has been in OFFENSE for this
// many ticks with zero attacks issued, force a commit on the next
// canSwing tick regardless of safety gates. Breaks "approach but never
// commit" loops that produce the aerial-family 0-0 stalemate.
//
// ESCAPE_LOOP_CAP: once a bot has entered ESCAPE this many times in the
// current round, decideMode no longer routes to ESCAPE — hard-danger
// becomes commit-into-trade instead. Prevents indefinite mutual flight.
const OFFENSE_COMMIT_TIMEOUT_TICKS = 90;
const ESCAPE_LOOP_CAP = 4;
// v5.2 max-duration caps. When cumulative ticks in a mode exceed these,
// decideMode force-exits to NEUTRAL and blocks re-entry until round
// reset. Addresses the "stuck in safe attractor" pattern where a bot
// hides in ESCAPE or camps in ZONE indefinitely because the normal
// exit conditions (distance > 280, opp aggression < 0.2) never fire.
// Calibrated to let the mode DO its job in a real situation without
// becoming a permanent resting state.
const ESCAPE_MAX_TICKS_PER_ROUND = 540; // 4.5s — escape is emergency only
const ZONE_MAX_TICKS_PER_ROUND = 720; // 6s — zone can be sustained longer
const INITIAL_IDLE_PRESSURE_TICKS = { 0: 500, 1: 400 };
const INITIAL_IDLE_PRESSURE_MIN_MOAT = 120;
// Distance band used by several modes' "close enough to commit"
// thresholds. burnRate extends effective swing reach.
function swingRange(params) {
    return 50 + params.burnRate * 80;
}
function unit(v, fallback = 0) {
    const x = v ?? fallback;
    return x < 0 ? 0 : x > 1 ? 1 : x;
}
function resetDeliveryProgress(state) {
    state.deliveryProgressGoalKey = null;
    state.deliveryBestDxGoal = Infinity;
    state.deliveryProgressTick = 0;
}
// ---------- State lifecycle ----------
export function createBrainState(id) {
    return {
        id,
        mode: "neutral",
        substate: null,
        modeEnterTick: 0,
        recentOppSwipeTicks: [],
        recentOppDiveTicks: [],
        lastKnownOppAttackStartTick: -9999,
        recentSelfClashTicks: [],
        lastKnownSelfClashTick: -9999,
        deliveryPlan: null,
        deliveryProgressGoalKey: null,
        deliveryBestDxGoal: Infinity,
        deliveryProgressTick: 0,
        lastDeliveryCancelTick: -9999,
        lastDeliveryCancelTactic: null,
        escapeEntriesThisRound: 0,
        escapeTicksThisRound: 0,
        zoneTicksThisRound: 0,
        lastTransitionReason: "init",
    };
}
// Reset on round boundary and on own respawn. Keeps opp-model buffers
// (bounded and decay-clamped) so cross-life reads of opp behavior
// survive; resets plan-layer so we don't carry stale intent into a new
// spacing situation.
export function resetBrainStateForRound(state, tick) {
    state.mode = "neutral";
    state.substate = null;
    state.modeEnterTick = tick;
    state.deliveryPlan = null; // plan's timing estimates are stale across respawn
    resetDeliveryProgress(state);
    state.lastDeliveryCancelTick = -9999;
    state.lastDeliveryCancelTactic = null;
    state.escapeEntriesThisRound = 0; // escape cap resets per round
    state.escapeTicksThisRound = 0; // max-duration cap resets per round
    state.zoneTicksThisRound = 0;
    state.lastTransitionReason = "round-reset";
}
// ---------- Opp-model update ----------
function pushBounded(buf, tick) {
    buf.push(tick);
    if (buf.length > OPP_BUFFER_MAX)
        buf.shift();
}
function decayBuffer(buf, now) {
    while (buf.length > 0 && now - buf[0] > OPP_BUFFER_DECAY_TICKS)
        buf.shift();
}
function updateOppModel(state, obs) {
    decayBuffer(state.recentOppSwipeTicks, obs.tick);
    decayBuffer(state.recentOppDiveTicks, obs.tick);
    decayBuffer(state.recentSelfClashTicks, obs.tick);
    const oppAttackStart = obs.opp.lastAttackStartTick;
    if (oppAttackStart !== state.lastKnownOppAttackStartTick && oppAttackStart >= 0) {
        // Classify: dive started mid-air, swipe started on ground. We don't
        // know which happened from lastAttackStartTick alone, but we can
        // peek at current state: if opp.diveT > 0 this frame, it was a dive.
        if (obs.opp.diveT > 0)
            pushBounded(state.recentOppDiveTicks, oppAttackStart);
        else
            pushBounded(state.recentOppSwipeTicks, oppAttackStart);
        state.lastKnownOppAttackStartTick = oppAttackStart;
    }
    // Self-clash detection: obs.self.lastClashTick advances when sim
    // resolves a clash (both committed collinear, or both passive-foil
    // collinear). We record each advance into the buffer so v4.1 can
    // detect clash loops without the brain computing geometry itself.
    const selfClashTick = obs.self.lastClashTick;
    if (selfClashTick !== state.lastKnownSelfClashTick && selfClashTick >= 0) {
        pushBounded(state.recentSelfClashTicks, selfClashTick);
        state.lastKnownSelfClashTick = selfClashTick;
    }
}
function deriveSignals(obs, params, state) {
    const predX = obs.opp.x + obs.opp.vx * params.foresight;
    const predDx = predX - obs.self.x;
    const predDist = Math.abs(predDx);
    const predDir = (Math.sign(predDx) || 1);
    const absDist = obs.absDx;
    const absDir = (Math.sign(obs.dx) || 1);
    const desiredY = obs.opp.y + params.leverage * 150;
    const altitudeOff = obs.self.y - desiredY;
    const reach = swingRange(params);
    const inReach = absDist < reach && Math.abs(obs.dy) < 80;
    const canSwing = obs.self.swipeCD <= 0 && inReach;
    const oppActive = obs.opp.swipeT > 0 || obs.opp.diveT > 0;
    const oppCommittedAtUs = oppActive && Math.abs(obs.dy) < 80 && absDist < reach + 60;
    const passiveFoilDanger = !oppActive &&
        Math.abs(obs.dy) < STATS.bodyH &&
        absDist < PASSIVE_FOIL_DANGER_RANGE;
    const ticksSinceOppAttack = obs.tick - obs.opp.lastAttackStartTick;
    const oppRecovering = ticksSinceOppAttack >= RECOVERY_WINDOW_START &&
        ticksSinceOppAttack <= RECOVERY_WINDOW_END &&
        !oppActive;
    const oppOpen = obs.opp.stun > 0 ||
        (!oppActive && !passiveFoilDanger && Math.abs(obs.opp.vx) < 120 && Math.abs(obs.opp.vy) < 80);
    // Opp closing fast: their velocity component toward us is significant
    // AND they're within one swing-range of contact.
    const oppClosingFast = Math.sign(obs.opp.vx) === -absDir &&
        Math.abs(obs.opp.vx) > 260 &&
        absDist < reach + 80;
    const oppAggression = Math.min(1, state.recentOppSwipeTicks.length / (OPP_BUFFER_DECAY_TICKS / 120));
    const clashLoop = state.recentSelfClashTicks.length >= CLASH_LOOP_THRESHOLD;
    const oppDivingAtUs = obs.opp.diveT > 0 && absDist < 110 && obs.opp.y < obs.self.y + 20;
    const selfBehindOpp = (obs.self.x - obs.opp.x) * obs.opp.facing < 0 && absDist < 100;
    const verticalAdvantage = obs.self.y < obs.opp.y - 30 && absDist < 140;
    const freeSwing = oppDivingAtUs || selfBehindOpp || verticalAdvantage;
    const wallDistLeft = obs.self.x - obs.arena.left;
    const wallDistRight = obs.arena.right - obs.self.x;
    const nearWall = Math.min(wallDistLeft, wallDistRight) < 80;
    const oppBetweenUsAndCenter = (wallDistLeft < wallDistRight && obs.opp.x > obs.self.x) ||
        (wallDistRight < wallDistLeft && obs.opp.x < obs.self.x);
    const cornered = nearWall && oppBetweenUsAndCenter && absDist < 240;
    const ticksSinceClash = obs.tick - obs.self.lastClashTick;
    const ticksSinceKill = obs.tick - obs.self.lastKillTick;
    const ticksSinceMove = obs.tick - obs.self.lastMoveTick;
    const stuck = ticksSinceMove > 90;
    return {
        predDist, predDir, absDist, absDir, altitudeOff,
        inReach, canSwing,
        oppActive, oppCommittedAtUs, oppRecovering, oppOpen, oppClosingFast,
        oppAggression, passiveFoilDanger, clashLoop, freeSwing, cornered,
        ticksSinceOppAttack, ticksSinceClash, ticksSinceKill, stuck,
    };
}
// ---------- Platform helpers ----------
function climbStep(obs, targetY) {
    let best = null;
    let bestScore = Infinity;
    for (const p of obs.platforms) {
        if (p.solid)
            continue;
        if (p.y >= obs.self.y - 30)
            continue;
        if (p.y < obs.self.y - 260)
            continue;
        const score = targetY !== undefined ? Math.abs(p.y - targetY) : p.y;
        if (score < bestScore) {
            best = p;
            bestScore = score;
        }
    }
    return best;
}
function onDropThroughPlatform(obs) {
    for (const p of obs.platforms) {
        if (p.solid)
            continue;
        const overX = obs.self.x > p.x && obs.self.x < p.x + p.w;
        const nearY = Math.abs(obs.self.y + STATS.bodyH * 0.5 - p.y) < 4;
        if (overX && nearY && obs.self.onGround)
            return p;
    }
    return null;
}
const NAV_MARGIN = 14;
const NAV_SURFACE_Y_TOLERANCE = 9;
const NAV_TARGET_SUPPORT_MAX_SCORE = 130;
function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}
function rangeGap(a1, a2, b1, b2) {
    if (a2 < b1)
        return b1 - a2;
    if (b2 < a1)
        return a1 - b2;
    return 0;
}
function pointRangeGap(x, s) {
    if (x < s.x1)
        return s.x1 - x;
    if (x > s.x2)
        return x - s.x2;
    return 0;
}
function surfaceTargetDistance(s, tx, ty) {
    return Math.hypot(pointRangeGap(tx, s), (s.y - ty) * 0.9);
}
function buildNavSurfaces(obs) {
    const surfaces = [];
    let floorAdded = false;
    for (const p of obs.platforms) {
        const usableW = p.w - NAV_MARGIN * 2;
        if (usableW <= STATS.bodyW)
            continue;
        surfaces.push({
            id: surfaces.length,
            x1: p.x + NAV_MARGIN,
            x2: p.x + p.w - NAV_MARGIN,
            y: p.y - STATS.bodyH * 0.5,
            platform: p,
        });
        if (p.solid)
            floorAdded = true;
    }
    if (!floorAdded) {
        surfaces.push({
            id: surfaces.length,
            x1: obs.arena.left + NAV_MARGIN,
            x2: obs.arena.right - NAV_MARGIN,
            y: obs.arena.floor - STATS.bodyH * 0.5,
            platform: null,
        });
    }
    return surfaces;
}
function currentSurface(obs, surfaces) {
    if (!obs.self.onGround)
        return null;
    let best = null;
    let bestScore = Infinity;
    const feetY = obs.self.y + STATS.bodyH * 0.5;
    for (const s of surfaces) {
        const surfaceY = s.platform?.y ?? obs.arena.floor;
        const yDiff = Math.abs(feetY - surfaceY);
        const xGap = pointRangeGap(obs.self.x, s);
        if (yDiff > NAV_SURFACE_Y_TOLERANCE || xGap > STATS.bodyW)
            continue;
        const score = yDiff * 10 + xGap;
        if (score < bestScore) {
            best = s;
            bestScore = score;
        }
    }
    return best;
}
function targetSurface(tx, ty, surfaces) {
    let best = null;
    let bestScore = Infinity;
    for (const s of surfaces) {
        const yDiff = Math.abs(s.y - ty);
        const xGap = pointRangeGap(tx, s);
        const score = yDiff + xGap * 0.35;
        if (score < bestScore) {
            best = s;
            bestScore = score;
        }
    }
    return bestScore <= NAV_TARGET_SUPPORT_MAX_SCORE ? best : null;
}
function surfaceContestedCost(obs, s, params) {
    if (obs.opp.dead)
        return 0;
    const x = clamp(obs.opp.x, s.x1, s.x2);
    const dx = Math.abs(obs.opp.x - x);
    const dy = Math.abs(obs.opp.y - s.y);
    if (dx > 110 || dy > 90)
        return 0;
    const discipline = unit(params.discipline);
    const greed = unit(params.greed, 0.5);
    return Math.max(0.15, 0.55 + discipline * 0.65 - greed * 0.35);
}
function surfaceIntentCost(obs, params, from, to, tx, ty) {
    const fromDist = surfaceTargetDistance(from, tx, ty);
    const toDist = surfaceTargetDistance(to, tx, ty);
    const progress = clamp((fromDist - toDist) / 260, -1, 1);
    const shipRate = unit(params.shipRate, 0.5);
    const discipline = unit(params.discipline);
    const leverage = clamp(params.leverage ?? 0, -1, 1);
    const goalUrgency = obs.goal.exists ? clamp((6 - obs.goal.timer) / 6, 0, 1) : 0;
    const deliveryRoute = obs.self.hasToken && obs.goal.exists;
    let cost = surfaceContestedCost(obs, to, params);
    if (!deliveryRoute)
        return cost;
    if (progress > 0 && cost <= 0.05) {
        cost -= progress * (0.18 + shipRate * 0.12 + discipline * 0.08 + goalUrgency * 0.1);
    }
    else {
        cost += (-progress) * (0.08 + shipRate * 0.12 + discipline * 0.12);
    }
    const climb = from.y - to.y;
    if (cost <= 0.05 && climb > 30 && leverage > 0)
        cost -= leverage * 0.1;
    else if (cost <= 0.05 && climb < -30 && leverage < 0)
        cost -= (-leverage) * 0.08;
    else if (Math.abs(climb) > 30)
        cost += Math.abs(leverage) * 0.05;
    return clamp(cost, -0.35, 0.9);
}
function navEdge(obs, params, from, to, targetX, targetY) {
    if (from.id === to.id)
        return null;
    const gap = rangeGap(from.x1, from.x2, to.x1, to.x2);
    const rise = from.y - to.y;
    const absRise = Math.abs(rise);
    const lift = unit(params.lift);
    const networking = unit(params.networking);
    const intent = surfaceIntentCost(obs, params, from, to, targetX, targetY);
    if (absRise <= 34) {
        if (gap > 120 + networking * 80)
            return null;
        const move = gap <= 24 ? "walk" : "jump";
        const cost = 1 + gap / 120 + (move === "jump" ? 0.8 - lift * 0.25 : 0) + intent;
        return { to: to.id, move, cost };
    }
    if (rise > 0) {
        const maxRise = 220 + lift * 45;
        const maxGap = 145 + networking * 90 + lift * 80;
        if (rise > maxRise || gap > maxGap)
            return null;
        const cost = 1.25 + rise / 130 + gap / 110 + (1 - lift) * 0.45 + intent;
        return { to: to.id, move: "jump", cost };
    }
    const drop = -rise;
    const maxDrift = 135 + networking * 90;
    if (gap > maxDrift)
        return null;
    const cunning = unit(params.cunning, 0.5);
    const cost = 0.8 + drop / 240 + gap / 140 + (1 - cunning) * 0.15 + intent;
    return { to: to.id, move: "drop", cost };
}
function nextSurfaceOnRoute(obs, params, surfaces, start, target, targetX, targetY) {
    const dist = surfaces.map(() => Infinity);
    const prev = surfaces.map(() => -1);
    const prevMove = surfaces.map(() => null);
    const seen = surfaces.map(() => false);
    dist[start.id] = 0;
    for (;;) {
        let at = -1;
        let best = Infinity;
        for (const s of surfaces) {
            if (!seen[s.id] && dist[s.id] < best) {
                at = s.id;
                best = dist[s.id];
            }
        }
        if (at < 0 || at === target.id)
            break;
        seen[at] = true;
        const from = surfaces[at];
        for (const to of surfaces) {
            const edge = navEdge(obs, params, from, to, targetX, targetY);
            if (!edge)
                continue;
            const next = dist[at] + edge.cost;
            if (next < dist[edge.to]) {
                dist[edge.to] = next;
                prev[edge.to] = at;
                prevMove[edge.to] = edge.move;
            }
        }
    }
    if (!Number.isFinite(dist[target.id]))
        return null;
    let cursor = target.id;
    while (prev[cursor] !== start.id) {
        cursor = prev[cursor];
        if (cursor < 0)
            return null;
    }
    const move = prevMove[cursor];
    if (!move)
        return null;
    return { surface: surfaces[cursor], move };
}
function platformRouteStep(obs, tx, ty, params) {
    const surfaces = buildNavSurfaces(obs);
    const start = currentSurface(obs, surfaces);
    if (!start)
        return null;
    const target = targetSurface(tx, ty, surfaces);
    if (!target || target.id === start.id)
        return null;
    return nextSurfaceOnRoute(obs, params, surfaces, start, target, tx, ty);
}
function driveTowardRouteStep(obs, tx, step) {
    const s = step.surface;
    const waypointX = clamp(tx, s.x1, s.x2);
    const nearestX = clamp(obs.self.x, s.x1, s.x2);
    const dx = (obs.self.x < s.x1 || obs.self.x > s.x2) ? nearestX - obs.self.x : waypointX - obs.self.x;
    const left = dx < -10;
    const right = dx > 10;
    if (step.move === "drop") {
        const overTarget = obs.self.x > s.x1 - 20 && obs.self.x < s.x2 + 20;
        return { left, right, down: overTarget };
    }
    if (step.move === "jump") {
        const launchSlack = 105;
        const inLaunchRange = obs.self.x > s.x1 - launchSlack && obs.self.x < s.x2 + launchSlack;
        const stillRising = !obs.self.onGround && obs.self.vy < -150;
        return { left, right, up: (obs.self.onGround && inLaunchRange) || stillRising };
    }
    return { left, right };
}
function directJumpReachable(obs, tx, ty, lift, forceEligible = false) {
    if ((!forceEligible && lift <= 0.05) || !obs.self.onGround)
        return false;
    const height = obs.self.y - ty;
    const maxHeight = (STATS.jump * STATS.jump) / (2 * GRAVITY);
    if (height < 35 || height > maxHeight - 8)
        return false;
    const disc = STATS.jump * STATS.jump - 2 * GRAVITY * height;
    if (disc <= 0)
        return false;
    const timeToTargetY = (STATS.jump - Math.sqrt(disc)) / GRAVITY;
    const usefulAirTime = Math.max(0.25, timeToTargetY + 0.22);
    const dx = Math.abs(tx - obs.self.x);
    const plumbLine = 55 + lift * 75;
    const airControl = STATS.speed * usefulAirTime * (0.45 + lift * 0.35);
    return dx <= plumbLine || dx <= airControl;
}
function navigateTo(obs, tx, ty, params, forceDirectJumpEligible = false) {
    if (ty > obs.self.y + 80) {
        const dx = tx - obs.self.x;
        return { left: dx < -10, right: dx > 10, down: true };
    }
    if (ty < obs.self.y - 50) {
        const lift = unit(params?.lift);
        if (directJumpReachable(obs, tx, ty, lift, forceDirectJumpEligible)) {
            const dx = tx - obs.self.x;
            return { left: dx < -10, right: dx > 10, up: true };
        }
        if (params) {
            const route = platformRouteStep(obs, tx, ty, params);
            if (route)
                return driveTowardRouteStep(obs, tx, route);
        }
        const step = climbStep(obs, ty);
        if (step) {
            const platL = step.x + 12;
            const platR = step.x + step.w - 12;
            let dir = 0;
            if (obs.self.x < platL)
                dir = 1;
            else if (obs.self.x > platR)
                dir = -1;
            const launchZone = obs.self.x > platL - 110 && obs.self.x < platR + 110;
            const stillRising = !obs.self.onGround && obs.self.vy < -150;
            const jump = (obs.self.onGround && launchZone) || stillRising;
            return { left: dir < 0, right: dir > 0, up: jump };
        }
        const dx2 = tx - obs.self.x;
        const stillRising = !obs.self.onGround && obs.self.vy < -150;
        return { left: dx2 < -10, right: dx2 > 10, up: obs.self.onGround || stillRising };
    }
    const dx = tx - obs.self.x;
    return { left: dx < -10, right: dx > 10 };
}
function goalBodyY(obs) {
    return obs.goal.y + STATS.bodyH * 0.5;
}
function dwellDistance(obs) {
    return Math.hypot(obs.self.x - obs.goal.x, obs.self.y - STATS.bodyH * 0.5 - obs.goal.y);
}
function chaseTargetX(obs) {
    if (!obs.opp.dead)
        return obs.opp.x;
    // Observation deliberately hides stage spawn points. Approximate the
    // opponent's home-side respawn from arena bounds; this is close enough
    // for a pressure route and stays deterministic across stages.
    return obs.self.id === 0 ? obs.arena.right - 244 : obs.arena.left + 244;
}
// ---------- Mode transition ----------
function enterMode(state, mode, substate, tick, reason) {
    state.mode = mode;
    state.substate = substate;
    state.modeEnterTick = tick;
    state.lastTransitionReason = reason;
}
function ticksInMode(state, tick) {
    return tick - state.modeEnterTick;
}
function effectiveMinDuration(mode, params) {
    const pacing = Math.max(0, Math.min(1, params.pacing ?? 0));
    return Math.round(MIN_DURATION[mode] * (1.5 - pacing));
}
// Global transition logic: picks the next mode for *this* tick. Called at
// the top of each brain tick before the mode-specific behavior fn. The
// rule is: check emergency triggers first (can fire regardless of
// min-duration), then check normal triggers (gated by min-duration).
function decideMode(obs, params, state, sig) {
    const tick = obs.tick;
    const t = ticksInMode(state, tick);
    const minDur = effectiveMinDuration(state.mode, params);
    // v5.2 max-duration force-exit. Fires before anything else so a bot
    // overhitting the escape/zone cap cannot remain even under emergency
    // triggers — the whole point is that the cap is final. After exit,
    // the usual transition logic runs this tick and picks a new mode.
    if (state.mode === "escape" && state.escapeTicksThisRound >= ESCAPE_MAX_TICKS_PER_ROUND) {
        enterMode(state, "neutral", null, tick, "escape-duration-exceeded");
    }
    else if (state.mode === "zone" && state.zoneTicksThisRound >= ZONE_MAX_TICKS_PER_ROUND) {
        enterMode(state, "neutral", null, tick, "zone-duration-exceeded");
    }
    // --- Emergency overrides (always fire) ---
    // Own respawn: mode should already have been reset externally; defensive.
    if (obs.self.dead) {
        if (state.mode !== "neutral")
            enterMode(state, "neutral", null, tick, "dead");
        return;
    }
    // Hard danger: opp committed at close range, we're not committed and
    // can't match. ESCAPE regardless of min-duration. Invuln is a free pass.
    const canMatchCommit = obs.self.swipeCD <= 0 && sig.inReach;
    const passiveWalkInDanger = sig.passiveFoilDanger &&
        obs.self.swipeT <= 0 &&
        obs.self.diveT <= 0 &&
        obs.self.invuln <= 0 &&
        !canMatchCommit;
    const hardDanger = passiveWalkInDanger ||
        (sig.oppCommittedAtUs &&
            sig.absDist < swingRange(params) + 20 &&
            obs.self.swipeT <= 0 &&
            obs.self.diveT <= 0 &&
            obs.self.invuln <= 0 &&
            !canMatchCommit);
    if (hardDanger && state.mode !== "escape") {
        // v5.1 escape-entry cap AND v5.2 escape-duration cap: stop fleeing
        // once either budget is exhausted for this round. Commit into the
        // trade instead — the whole point is that escape-as-safe-attractor
        // cannot be a permanent strategy.
        const escapeExhausted = state.escapeEntriesThisRound >= ESCAPE_LOOP_CAP ||
            state.escapeTicksThisRound >= ESCAPE_MAX_TICKS_PER_ROUND;
        if (escapeExhausted) {
            enterMode(state, "offense", "punish", tick, "escape-budget-commit");
        }
        else {
            enterMode(state, "escape", null, tick, "hard-danger");
            state.escapeEntriesThisRound++;
        }
        return;
    }
    // Token state change is authoritative: drops into OBJECTIVE.
    const objectiveActive = obs.self.hasToken ||
        (obs.opp.hasToken && obs.goal.exists) ||
        (obs.token.exists && !obs.self.hasToken && !obs.opp.hasToken);
    if (objectiveActive && state.mode !== "objective") {
        // Only preempt non-escape modes; escaping a kill threat trumps
        // objective routing.
        if (state.mode !== "escape" || t >= minDur) {
            enterMode(state, "objective", null, tick, "token-state");
        }
    }
    if (!objectiveActive && state.mode === "objective") {
        enterMode(state, "neutral", null, tick, "objective-cleared");
    }
    // --- Normal transitions (min-duration gated) ---
    if (t < minDur)
        return; // respect commitment window
    // OFFENSE-punish entry: opp in recovery window, we can swing.
    if (state.mode === "neutral" && sig.oppRecovering && obs.self.swipeCD <= 0
        && sig.absDist < swingRange(params) + 120) {
        enterMode(state, "offense", "punish", tick, "opp-recovery");
        return;
    }
    // OFFENSE-press entry: opp open / stunned / cornered / we have altitude.
    if (state.mode === "neutral" && (obs.opp.stun > 0 ||
        (sig.oppOpen && sig.absDist < 260) ||
        (obs.self.y < obs.opp.y - 40 && sig.absDist < 200))) {
        enterMode(state, "offense", "press", tick, "opp-open-or-altitude");
        return;
    }
    // ZONE entry: opp is a spammer and we're not pressured. v5.2 caps
    // cumulative zone time per round; once exceeded, denial posture is
    // not available for the rest of the round and we fall through to
    // other transitions (usually OFFENSE).
    if (state.mode === "neutral" && sig.oppAggression > 0.5 && sig.absDist > 120 &&
        state.zoneTicksThisRound < ZONE_MAX_TICKS_PER_ROUND) {
        enterMode(state, "zone", null, tick, "opp-spammer");
        return;
    }
    // OFFENSE-bait entry: moderate greed, foresight, opp not committed,
    // in the "just outside reach" band. Creates the bait window.
    if (state.mode === "neutral" && !sig.oppActive &&
        (params.greed ?? 0.5) > 0.4 && (params.cunning ?? 0.5) > 0.4 &&
        sig.absDist > swingRange(params) && sig.absDist < swingRange(params) + 80) {
        enterMode(state, "offense", "bait", tick, "bait-window");
        return;
    }
    // OFFENSE exit: stale window with no commitment opportunity.
    if (state.mode === "offense" && t > 80) {
        enterMode(state, "neutral", null, tick, "offense-stale");
        return;
    }
    // ZONE exit: opp stopped pressing OR we're no longer center-adjacent.
    if (state.mode === "zone" && (sig.oppAggression < 0.2 || sig.cornered)) {
        // v5.1 escape-entry cap AND v5.2 escape-duration cap apply here too.
        const escapeExhausted = state.escapeEntriesThisRound >= ESCAPE_LOOP_CAP ||
            state.escapeTicksThisRound >= ESCAPE_MAX_TICKS_PER_ROUND;
        if (sig.cornered && !escapeExhausted) {
            enterMode(state, "escape", null, tick, "zone-cleared-cornered");
            state.escapeEntriesThisRound++;
        }
        else {
            enterMode(state, "neutral", null, tick, "zone-cleared");
        }
        return;
    }
    // ESCAPE exit: spacing restored.
    if (state.mode === "escape" && sig.absDist > 280 && obs.self.stun <= 0) {
        enterMode(state, "neutral", null, tick, "escape-complete");
        return;
    }
}
// ---------- Mode behavior functions ----------
function runNeutralMode(obs, params, state, sig) {
    const chase = unit(params.chase);
    const chaseWindow = chase > 0.05 && sig.ticksSinceKill >= 0 && sig.ticksSinceKill < 180;
    if (chaseWindow && !obs.self.hasToken && !obs.opp.hasToken && !obs.token.exists) {
        const tx = chaseTargetX(obs);
        const dx = tx - obs.self.x;
        const nearLiveOpp = !obs.opp.dead && sig.absDist < swingRange(params) + chase * 70;
        return {
            left: dx < -10,
            right: dx > 10,
            action: nearLiveOpp && sig.canSwing && chase > 0.35,
        };
    }
    const noTokenIdle = !obs.token.exists && !obs.self.hasToken && !obs.opp.hasToken &&
        obs.self.score === 0 && obs.opp.score === 0 &&
        obs.self.rounds === 0 && obs.opp.rounds === 0 &&
        params.moat >= INITIAL_IDLE_PRESSURE_MIN_MOAT &&
        obs.tick > INITIAL_IDLE_PRESSURE_TICKS[obs.self.id] &&
        obs.self.lastAttackStartTick < 0 &&
        obs.opp.lastAttackStartTick < 0 &&
        obs.self.lastClashTick < 0 &&
        obs.self.lastKillTick < 0;
    if (noTokenIdle) {
        return {
            left: sig.absDir < 0,
            right: sig.absDir > 0,
            action: sig.canSwing,
        };
    }
    // Hold spacing at moat. Only swing on freeSwing opportunity.
    let move = 0;
    if (sig.predDist > params.moat + 15)
        move = sig.predDir;
    else if (sig.predDist < params.moat - 15)
        move = -sig.predDir;
    if (sig.passiveFoilDanger)
        move = -sig.absDir;
    let jump = false;
    let down = false;
    const stillRising = !obs.self.onGround && obs.self.vy < -150;
    if (sig.altitudeOff > 60 && obs.self.onGround)
        jump = true;
    if (sig.altitudeOff > 60 && stillRising)
        jump = true;
    if (sig.altitudeOff < -80)
        down = true;
    const takeFreeSwing = sig.canSwing && sig.freeSwing;
    return {
        left: move < 0,
        right: move > 0,
        up: jump,
        down,
        action: takeFreeSwing,
    };
}
// v5.1 symmetry breaker: when the top trait is close to the second,
// fighter id 0 picks #1 and fighter id 1 picks #2. This prevents mirror
// matches from mutually resolving to the same response (e.g. two aerials
// both picking "escape" forever). Keeping this fixed by id preserves
// roster counter-cycles; ranked side assignment is already randomized.
function dominantAntiLoopTrait(params, state) {
    const entries = [
        ["greed", params.greed ?? 0.5],
        ["cunning", params.cunning ?? 0.5],
        ["pivotSpeed", params.pivotSpeed ?? 0.5],
        ["shipRate", params.shipRate ?? 0.5],
        ["parry", params.parry ?? 0],
    ];
    entries.sort((a, b) => b[1] - a[1]);
    if (entries[0][1] - entries[1][1] < 0.25 && state.id === 1) {
        return entries[1][0];
    }
    return entries[0][0];
}
function runOffenseMode(obs, params, state, sig) {
    const sub = state.substate ?? "press";
    // v5.1 OFFENSE commit-timeout: if our last attack was more than
    // OFFENSE_COMMIT_TIMEOUT_TICKS ago, force a commit on the next
    // canSwing tick. Uses global tick arithmetic (obs.self.lastAttackStartTick)
    // so it survives OFFENSE ↔ NEUTRAL bouncing — the 8-bot aerial
    // stalemate clique triggers ~577 mode switches in a 28800-tick match,
    // so a per-OFFENSE-entry counter never accumulates. lastAttackStartTick
    // defaults to -9999 (never attacked); that's fine — force-commit will
    // fire on the first canSwing tick, which requires inReach AND cooldown
    // clear, so the bot still has to approach before committing.
    // v5.1 OFFENSE commit-timeout. Triggers on the specific pathology:
    // bot is in a clash loop OR inside passive-foil danger OR within
    // foil-reach, AND hasn't landed an attack in a long time. That scope
    // targets the stalemate cause (close-range but never committing)
    // without force-firing blind swipes when opp is far away.
    //
    // Uses global tick arithmetic (obs.self.lastAttackStartTick) so it
    // survives OFFENSE↔NEUTRAL mode bouncing — the aerial clique triggers
    // hundreds of mode switches per match, so a per-entry counter never
    // accumulates.
    //
    // Id-asymmetric threshold: fighter 0 commits 7 ticks earlier than
    // fighter 1. Identical-config mirror matches otherwise produce
    // perfectly synchronized swipes that always mutually parry. The
    // 7-tick offset is inside the swipe active window (14.4 ticks) so
    // fighter 0 can land before fighter 1 starts. Deterministic — ranked
    // side assignment and physics integration order are separately balanced.
    const asymOffset = state.id === 0 ? 0 : 7;
    const ticksSinceOwnAttack = obs.tick - obs.self.lastAttackStartTick;
    const swipeReady = obs.self.swipeCD <= 0 && obs.self.stun <= 0 &&
        obs.self.swipeT <= 0 && obs.self.diveT <= 0;
    // "Engaged" context: recently clashed (within 3s) OR currently in a
    // clash loop OR within passive-foil geometry OR within medium combat
    // range (2x normal max swing reach ≈ 260). Excludes the "opp is far
    // across the stage" case so we don't blind-swipe into thin air, while
    // still catching the aerial-clique pathology where bots oscillate at
    // medium range with intermittent clashes.
    const ticksSinceClash = obs.tick - obs.self.lastClashTick;
    const commitContext = sig.clashLoop ||
        sig.passiveFoilDanger ||
        ticksSinceClash < 360 ||
        sig.absDist < 260;
    if (commitContext &&
        ticksSinceOwnAttack > (OFFENSE_COMMIT_TIMEOUT_TICKS + asymOffset) &&
        swipeReady) {
        return {
            left: sig.absDir < 0,
            right: sig.absDir > 0,
            action: true,
        };
    }
    const parry = unit(params.parry);
    const parryWindow = parry > 0.05 &&
        (sig.passiveFoilDanger ||
            sig.clashLoop ||
            ticksSinceClash < 60 + parry * 80);
    const parryClose = sig.absDist < PASSIVE_FOIL_DANGER_RANGE + parry * 80 &&
        Math.abs(obs.dy) < STATS.bodyH + 24;
    if (parryWindow && parryClose && swipeReady && (sig.canSwing || parry > 0.35)) {
        return {
            left: sig.absDir < 0,
            right: sig.absDir > 0,
            action: true,
        };
    }
    if (sig.clashLoop && ticksInMode(state, obs.tick) > 60) {
        const trait = dominantAntiLoopTrait(params, state);
        if (trait === "pivotSpeed")
            return runEscapeMode(obs, params, sig);
        if (trait === "shipRate" && (obs.token.exists || obs.self.hasToken || obs.opp.hasToken)) {
            enterMode(state, "objective", null, obs.tick, "anti-loop-objective");
            return runObjectiveMode(obs, params, state, sig);
        }
        if (trait === "greed") {
            return {
                left: sig.absDir < 0,
                right: sig.absDir > 0,
                action: sig.canSwing,
            };
        }
        if (trait === "parry") {
            return {
                left: sig.absDir < 0,
                right: sig.absDir > 0,
                action: swipeReady && (sig.canSwing || parry > 0.35),
            };
        }
        const drop = onDropThroughPlatform(obs);
        return {
            left: sig.absDir > 0,
            right: sig.absDir < 0,
            up: obs.self.onGround,
            down: !!drop,
        };
    }
    // Shared close-gap movement.
    let move = sig.predDir;
    let jump = false;
    let down = false;
    const stillRising = !obs.self.onGround && obs.self.vy < -150;
    // Altitude press toward desiredY while closing.
    if (sig.altitudeOff > 60 && obs.self.onGround)
        jump = true;
    if (sig.altitudeOff > 60 && stillRising)
        jump = true;
    if (sig.altitudeOff < -80)
        down = true;
    // Dive as mobility when above opp (press substate only).
    if (sub === "press" && !obs.self.onGround &&
        obs.self.y < obs.opp.y - 40 && obs.self.diveCD <= 0 &&
        sig.absDist < 140 && Math.abs(obs.dy) > 30) {
        return { down: true, action: true, left: move < 0, right: move > 0 };
    }
    // Bait: hover just outside reach, mirror opp motion, don't close hard.
    if (sub === "bait") {
        const baitDist = swingRange(params) + 30;
        if (sig.predDist > baitDist + 20)
            move = sig.predDir;
        else if (sig.predDist < baitDist - 20)
            move = -sig.predDir;
        else
            move = 0;
        // Only commit if opp is now in our reach while we're not yet in theirs
        // (they committed and whiffed short, or they opened).
        const baitCommit = sig.canSwing && (sig.oppRecovering || sig.oppOpen || sig.freeSwing);
        return {
            left: move < 0, right: move > 0, up: jump, down,
            action: baitCommit,
        };
    }
    // Punish: sprint into opp, commit on arrival. No moat discipline.
    if (sub === "punish") {
        move = sig.absDir;
        const commit = sig.canSwing && (sig.oppRecovering || sig.oppOpen || sig.freeSwing || sig.absDist < 60);
        return {
            left: move < 0, right: move > 0, up: jump, down,
            action: commit,
        };
    }
    // Press: close gap, swing when in reach AND it's safe to commit.
    // Safe to commit means either (a) opp is not committed-at-us, so we
    // land first if we're faster, or (b) we're willing to trade (greed
    // high → doubleKO is acceptable), or (c) freeSwing / opp recovering.
    const safeCommit = sig.freeSwing ||
        sig.oppRecovering ||
        sig.oppOpen ||
        sig.passiveFoilDanger ||
        (!sig.oppCommittedAtUs) ||
        ((params.greed ?? 0.5) > 0.6 && sig.absDist < swingRange(params) * 0.7);
    // v5.2 progress-stalled close-override. When a match has gone 900+
    // ticks without a kill AND we're swinging but not hitting, we're in
    // a spacing equilibrium where swings whiff at ~150px. The normal
    // press logic keeps us at our natural spacing; we need to explicitly
    // close INSIDE swingRange to land. Override: move aggressively toward
    // opp until absDist < 70 (tight hit range), THEN swing. Id-asymmetric
    // (only fighter 1 overrides) so we don't create mutual close-and-swing
    // pressure that just produces new doubleKOs.
    const progressStalled = state.id === 1 &&
        obs.tick > 900 &&
        (obs.tick - obs.self.lastKillTick) > 900 &&
        obs.self.score === 0 && obs.opp.score === 0 &&
        obs.self.rounds === 0 && obs.opp.rounds === 0 &&
        obs.self.lastAttackStartTick > 0;
    if (progressStalled) {
        const tooFar = sig.absDist > 70;
        return {
            left: sig.absDir < 0,
            right: sig.absDir > 0,
            up: false,
            down: false,
            action: !tooFar && sig.canSwing,
        };
    }
    return {
        left: move < 0, right: move > 0, up: jump, down,
        action: sig.canSwing && safeCommit,
    };
}
function runZoneMode(obs, params, sig) {
    // Denial posture. Hold preferred altitude, let opp approach through our
    // preferred angle. Swipe only on opp recovery / freeSwing.
    let move = 0;
    // Preferred zone distance — wider than moat by +40 for zone discipline.
    const zoneDist = Math.max(params.moat + 40, 150);
    if (sig.predDist > zoneDist + 15)
        move = sig.predDir;
    else if (sig.predDist < zoneDist - 15)
        move = -sig.predDir;
    // Altitude preference (leverage-driven). Prefer the elevated side.
    let jump = false;
    let down = false;
    const stillRising = !obs.self.onGround && obs.self.vy < -150;
    if (sig.altitudeOff > 40 && (obs.self.onGround || stillRising))
        jump = true;
    if (sig.altitudeOff < -100)
        down = true;
    // Wall-climb-jump for altitude recovery when wall-bound and opp below.
    if (obs.self.wall !== 0 && sig.altitudeOff > 40 && (params.networking ?? 0) > 0.25) {
        return { left: obs.self.wall < 0, right: obs.self.wall > 0, up: true };
    }
    const zoneStrike = sig.canSwing && (sig.freeSwing || sig.oppRecovering);
    return {
        left: move < 0, right: move > 0, up: jump, down,
        action: zoneStrike,
    };
}
// ---------- Delivery planner (v4.2) ----------
//
// When the bot is carrying the token and the goal exists, pick ONE of a
// small set of tactical programs to execute for the next ~12 ticks
// instead of re-deciding per-tick. This is the narrow "objective
// conversion planner" from the v4.2 design. Deterministic closed-form
// scoring — no recursive bot-vs-bot simulation.
//
// Tactics (more can be added later):
//   direct      — sprint straight to goal, dwell when arrived
//   kill-first  — commit a swipe on the blocker first, then deliver
//   feint       — step back 18 ticks to bait opp commitment, then sprint
//
// Scoring compares each tactic's expected dwell-completion tick against
// the opp's interception tick. Trait weights bias which tactic is
// preferred (shipRate → direct; greed → kill-first; cunning → feint).
const PLAN_HORIZON_TICKS = 12;
const DWELL_COMPLETION_TICKS = Math.ceil(GOAL_DWELL_S / STEP);
const FEINT_DURATION_TICKS = 18;
const FEINT_PLAN_HORIZON_TICKS = FEINT_DURATION_TICKS + PLAN_HORIZON_TICKS;
const KILL_SETUP_TICKS = 20; // swipe commit + one recovery cycle
const DELIVERY_PROGRESS_EPS = 14;
const DELIVERY_STALL_BASE_TICKS = 72;
function estimateTicksToGoal(obs) {
    const dx = obs.goal.x - obs.self.x;
    const dy = goalBodyY(obs) - obs.self.y;
    const dist = Math.hypot(dx, dy);
    // Rough: top speed 380 px/s at 120 Hz = ~3.17 px/tick. Use 3.0 for
    // conservative estimate (covers accel ramp + platform detours).
    return Math.ceil(dist / 3.0);
}
function estimateOppInterceptTicks(obs) {
    // If opp is dead, they can't intercept until respawn + invuln is done.
    if (obs.opp.dead) {
        // Opp.dead in observation doesn't directly expose respawnT/invuln;
        // use the ruleset timing constants rather than hidden state.
        return Math.ceil((KILL_RESPAWN_S + RESPAWN_INVULN_S) / STEP);
    }
    // Alive opp: how long for them to reach the goal (upper bound on
    // their intercept threat). Distance / speed estimate.
    const dxG = obs.goal.x - obs.opp.x;
    const dyG = goalBodyY(obs) - obs.opp.y;
    const dist = Math.hypot(dxG, dyG);
    return Math.max(1, Math.ceil(dist / 3.0));
}
function scoreTactic(kind, params, directTicks, oppInterceptTicks, sig) {
    const discipline = unit(params.discipline);
    // Compute expected "time to dwell complete" for this tactic.
    let tacticTicks;
    switch (kind) {
        case "direct":
            tacticTicks = directTicks + DWELL_COMPLETION_TICKS;
            break;
        case "kill-first":
            tacticTicks = KILL_SETUP_TICKS + directTicks + DWELL_COMPLETION_TICKS;
            break;
        case "feint":
            tacticTicks = FEINT_DURATION_TICKS + directTicks + DWELL_COMPLETION_TICKS;
            break;
    }
    // Success probability based on whether we finish before opp can
    // intercept. Smooth rather than binary so trait weights still matter.
    const margin = oppInterceptTicks - tacticTicks;
    const success = 1 / (1 + Math.exp(-margin / 15)); // sigmoid, steep-ish
    // Trait weights (argmax bias). Each trait pushes toward ONE tactic
    // so there's no double-counting. shipRate/greed/cunning live here,
    // fulfilling the "dead knob" rehab for OBJECTIVE.
    let traitWeight = 1;
    switch (kind) {
        case "direct":
            traitWeight += (params.shipRate ?? 0.5) * 0.8;
            traitWeight += discipline * 0.7;
            break;
        case "kill-first":
            // Only meaningful if blocker is actually close AND we can swing
            if (!(sig.absDist < 200 && sig.canSwing))
                return 0;
            traitWeight += (params.greed ?? 0.5) * 1.0;
            // Spite negative (prefers denial over delivery) also pushes kill
            traitWeight += Math.max(0, -(params.spite ?? 0)) * 0.5;
            traitWeight *= 1 - discipline * 0.45;
            break;
        case "feint":
            // Only meaningful if opp is close enough to be baitable
            if (sig.absDist > 260)
                return 0;
            traitWeight += (params.cunning ?? 0.5) * 1.0;
            traitWeight *= 1 - discipline * 0.55;
            break;
    }
    return success * traitWeight;
}
function deliveryPlanHorizon(kind, params) {
    const discipline = unit(params.discipline);
    if (kind === "direct")
        return PLAN_HORIZON_TICKS + Math.round(discipline * 18);
    if (kind === "feint")
        return FEINT_PLAN_HORIZON_TICKS;
    return PLAN_HORIZON_TICKS + Math.round(discipline * 8);
}
function planDeliveryTactic(obs, params, sig) {
    const directTicks = estimateTicksToGoal(obs);
    const oppInterceptTicks = estimateOppInterceptTicks(obs);
    const kinds = ["direct", "kill-first", "feint"];
    let best = "direct";
    let bestScore = -Infinity;
    for (const k of kinds) {
        const s = scoreTactic(k, params, directTicks, oppInterceptTicks, sig);
        if (s > bestScore) {
            bestScore = s;
            best = k;
        }
    }
    return {
        tactic: best,
        startedAt: obs.tick,
        expiresAt: obs.tick + deliveryPlanHorizon(best, params),
        feintUntil: best === "feint" ? obs.tick + FEINT_DURATION_TICKS : undefined,
        score: bestScore,
    };
}
function deliveryStallTicks(params) {
    return DELIVERY_STALL_BASE_TICKS +
        Math.round(unit(params.discipline) * 72) +
        Math.round(unit(params.shipRate, 0.5) * 36);
}
function deliveryGoalKey(obs) {
    return `${obs.goal.label}:${Math.round(obs.goal.x)}:${Math.round(obs.goal.y)}`;
}
function updateDeliveryProgress(state, obs) {
    const key = deliveryGoalKey(obs);
    const absDxGoal = Math.abs(obs.goal.x - obs.self.x);
    if (state.deliveryProgressGoalKey !== key) {
        state.deliveryProgressGoalKey = key;
        state.deliveryBestDxGoal = absDxGoal;
        state.deliveryProgressTick = obs.tick;
        return absDxGoal;
    }
    if (absDxGoal < state.deliveryBestDxGoal - DELIVERY_PROGRESS_EPS) {
        state.deliveryBestDxGoal = absDxGoal;
        state.deliveryProgressTick = obs.tick;
    }
    return absDxGoal;
}
function stalledDeliveryTactic(plan, obs, params, state, sig, oppInPath, goalTimerUrgent, absDxGoal) {
    if (plan.tactic !== "direct")
        return null;
    if (!oppInPath || goalTimerUrgent || absDxGoal < 90)
        return null;
    if (obs.tick - state.deliveryProgressTick < deliveryStallTicks(params))
        return null;
    const cunning = unit(params.cunning, 0.5);
    const greed = unit(params.greed, 0.5);
    const discipline = unit(params.discipline);
    if (sig.absDist < 260 && cunning > greed + 0.12 && discipline < 0.85)
        return "feint";
    if (sig.absDist < 210 && greed >= 0.45)
        return "kill-first";
    return null;
}
function replaceDeliveryPlan(obs, params, tactic, score) {
    return {
        tactic,
        startedAt: obs.tick,
        expiresAt: obs.tick + deliveryPlanHorizon(tactic, params),
        feintUntil: tactic === "feint" ? obs.tick + FEINT_DURATION_TICKS : undefined,
        score,
    };
}
function runObjectiveMode(obs, params, state, sig) {
    // Token state drives the sub-behavior. state.substate is written here
    // so telemetry (v4.0-prep) can distinguish deliver vs intercept-block
    // vs intercept-kill vs pickup time. No behavior change from setting —
    // nothing in the brain branches on state.substate inside objective.
    const iHaveToken = obs.self.hasToken;
    const oppHasToken = obs.opp.hasToken;
    // DELIVER: I have the token. Route to goal. Once within 40px, stand
    // ground (the dwell window) and only swipe if opp tries to hit me.
    if (iHaveToken && obs.goal.exists) {
        state.substate = "deliver";
        const selfishBias = Math.max(0, Math.min(1, ((params.spite ?? 0) + 1) / 2));
        const deliveryResolve = (params.shipRate ?? 0.5) * 0.45 +
            (params.greed ?? 0.5) * 0.35 +
            selfishBias * 0.20;
        const dxGoal = obs.goal.x - obs.self.x;
        const targetY = goalBodyY(obs);
        const dyGoal = targetY - obs.self.y;
        const atGoal = dwellDistance(obs) < GOAL_DWELL_RADIUS;
        const discipline = unit(params.discipline);
        if (atGoal) {
            // Dwell hold. Don't chase opp. Defensive swing if opp walks into
            // reach while we dwell. Small altitude adjust if opp above.
            let action = false;
            if (sig.canSwing && sig.oppCommittedAtUs)
                action = true;
            if (sig.canSwing && sig.freeSwing)
                action = true;
            if (sig.canSwing && sig.passiveFoilDanger && deliveryResolve > 0.45)
                action = true;
            let jumpD = false;
            if (obs.opp.y < obs.self.y - 40 && obs.opp.diveT > 0)
                jumpD = true; // escape incoming dive
            return { action, up: jumpD };
        }
        // Committed route to goal. Shouldn't-fight-blocker unless dangerous
        // AND not time-urgent.
        const oppInPath = Math.sign(dxGoal) === Math.sign(obs.opp.x - obs.self.x)
            && Math.abs(obs.opp.x - obs.self.x) < Math.abs(dxGoal);
        const goalTimerUrgent = obs.goal.timer < 3;
        // v4.2 delivery planner: pick a short tactical program. Re-plan
        // if stale or missing. This addresses "brain makes same frame-local
        // choice every tick → no temporal commitment → stall." The plan
        // stays active across frames; each tick we only translate the
        // active plan into an action.
        if (!state.deliveryPlan || state.deliveryPlan.expiresAt <= obs.tick) {
            state.deliveryPlan = planDeliveryTactic(obs, params, sig);
        }
        let plan = state.deliveryPlan;
        const absDxGoal = updateDeliveryProgress(state, obs);
        const fallbackTactic = stalledDeliveryTactic(plan, obs, params, state, sig, oppInPath, goalTimerUrgent, absDxGoal);
        if (fallbackTactic) {
            state.deliveryPlan = replaceDeliveryPlan(obs, params, fallbackTactic, plan.score);
            state.lastDeliveryCancelTick = obs.tick;
            state.lastDeliveryCancelTactic = fallbackTactic;
            plan = state.deliveryPlan;
        }
        // Feint tactic: back-step AWAY from goal for feintUntil ticks, then
        // fall through to direct. Feint relies on opp reading the retreat
        // and committing; when they commit and miss, we sprint past.
        if (plan.tactic === "feint" && plan.feintUntil !== undefined && obs.tick < plan.feintUntil) {
            const backSign = -Math.sign(dxGoal) || 1;
            return {
                left: backSign < 0,
                right: backSign > 0,
                // defensive swing if opp walks into our reach during the feint
                action: sig.canSwing && (sig.oppCommittedAtUs || sig.passiveFoilDanger || sig.freeSwing),
            };
        }
        // Kill-first tactic or (any plan + emergent fight condition): commit
        // swipe when the blocker is close and we have the opportunity.
        const wantKill = plan.tactic === "kill-first";
        const blockerDetourRange = Math.max(70, 120 - discipline * 45);
        const shouldFight = (wantKill || (oppInPath && sig.absDist < blockerDetourRange)) &&
            sig.canSwing &&
            !sig.oppCommittedAtUs &&
            (sig.passiveFoilDanger ||
                sig.oppRecovering ||
                sig.oppOpen ||
                sig.freeSwing ||
                wantKill ||
                deliveryResolve > (goalTimerUrgent ? 0.35 : 0.50));
        if (shouldFight) {
            return {
                left: sig.absDir < 0,
                right: sig.absDir > 0,
                action: true,
            };
        }
        if (oppInPath && sig.absDist < blockerDetourRange && obs.self.onGround) {
            // Jump over blocker.
            const toGoalSign = Math.sign(dxGoal) || 1;
            return { left: toGoalSign < 0, right: toGoalSign > 0, up: true };
        }
        // Default (direct tactic, or fall-through): navigate to goal.
        return navigateTo(obs, obs.goal.x, targetY, params, plan.tactic === "direct");
    }
    // INTERCEPT: opp has token. Split on distance — far → block the goal
    // line; close → kill-for-reset.
    if (oppHasToken && obs.goal.exists) {
        state.deliveryPlan = null;
        resetDeliveryProgress(state);
        const denyBias = Math.max(0, Math.min(1, (1 - (params.spite ?? 0)) / 2));
        const targetY = goalBodyY(obs);
        const oppToGoal = Math.hypot(obs.goal.x - obs.opp.x, targetY - obs.opp.y);
        const goalTimerUrgent = obs.goal.timer < 3;
        const killRange = 150 + denyBias * 120;
        if (sig.absDist < killRange && obs.self.onGround) {
            // Kill-for-reset. Close and commit.
            state.substate = "intercept-kill";
            const move = sig.absDir;
            const commit = sig.canSwing && (sig.freeSwing ||
                sig.oppRecovering ||
                sig.oppOpen ||
                sig.passiveFoilDanger ||
                sig.absDist < 70 + denyBias * 35);
            return { left: move < 0, right: move > 0, action: commit };
        }
        state.substate = "intercept-block";
        // Block the goal. Position between opp and goal.
        // Target: a point closer to the goal than opp is.
        const blockX = obs.goal.x + Math.sign(obs.opp.x - obs.goal.x) * Math.max(60, Math.min(140, oppToGoal * 0.5));
        const tx = blockX;
        const ty = targetY;
        if (goalTimerUrgent) {
            // Urgent: commit to swipe opp if close.
            if (sig.absDist < 120)
                return { left: sig.absDir < 0, right: sig.absDir > 0, action: sig.canSwing };
        }
        return navigateTo(obs, tx, ty, params);
    }
    // PICKUP: token on ground, neither holds. Race.
    if (obs.token.exists && obs.token.carrier === -1) {
        state.deliveryPlan = null;
        resetDeliveryProgress(state);
        state.substate = "pickup";
        const tx = obs.token.x;
        const ty = obs.token.y;
        const myDist = Math.hypot(tx - obs.self.x, ty - obs.self.y);
        const oppDist = Math.hypot(tx - obs.opp.x, ty - obs.opp.y);
        const pickupCommit = 20 + (params.shipRate ?? 0.5) * 90 + Math.max(0, params.spite ?? 0) * 30;
        if (myDist <= oppDist + pickupCommit) {
            return navigateTo(obs, tx, ty, params);
        }
        // Opp will reach first. Preempt with a swipe if we can catch them.
        if (sig.canSwing && sig.absDist < swingRange(params)) {
            return { action: true, left: sig.absDir < 0, right: sig.absDir > 0 };
        }
        return navigateTo(obs, tx, ty, params);
    }
    // Fallback — shouldn't reach here because objective-active triggered
    // the mode entry.
    state.deliveryPlan = null;
    resetDeliveryProgress(state);
    return runNeutralMode(obs, params, state, sig);
}
function runEscapeMode(obs, params, sig) {
    // Priority ladder. NEVER swipe.
    // 1. Wall-bound → wall-jump away.
    if (obs.self.wall !== 0 && (params.networking ?? 0) > 0.2) {
        return { left: obs.self.wall > 0, right: obs.self.wall < 0, up: true };
    }
    // 2. On non-solid platform with opp on same level → drop-through.
    const dropPlat = onDropThroughPlatform(obs);
    if (dropPlat && Math.abs(obs.dy) < 40 && sig.absDist < 160) {
        return { down: true };
    }
    // 3. Airborne and opp below/level → horizontal drift toward nearest
    //    safe side (farther from opp).
    if (!obs.self.onGround) {
        const dir = obs.opp.x > obs.self.x ? -1 : 1;
        return { left: dir < 0, right: dir > 0 };
    }
    // 4. Cornered → straight-up stall-climb to a platform out of reach.
    if (sig.cornered) {
        const step = climbStep(obs);
        if (step) {
            const platL = step.x + 12;
            const platR = step.x + step.w - 12;
            let dir = 0;
            if (obs.self.x < platL)
                dir = 1;
            else if (obs.self.x > platR)
                dir = -1;
            return { left: dir < 0, right: dir > 0, up: true };
        }
        return { up: true, left: obs.opp.x > obs.self.x, right: obs.opp.x < obs.self.x };
    }
    // 5. Default: run perpendicular/away from opp at ground speed.
    const awayDir = obs.opp.x > obs.self.x ? -1 : 1;
    // Pivot-speed flavor: high pivotSpeed takes the longer path (more
    // distance) via an upward arc; low pivotSpeed hugs the ground.
    const useArc = (params.pivotSpeed ?? 0.5) > 0.5 && obs.self.onGround;
    return {
        left: awayDir < 0,
        right: awayDir > 0,
        up: useArc,
    };
}
// ---------- Dispatcher ----------
export function runParamBrain(obs, params, state) {
    if (obs.self.dead)
        return {};
    updateOppModel(state, obs);
    const sig = deriveSignals(obs, params, state);
    decideMode(obs, params, state, sig);
    // v5.2 mode-duration accumulation. Counts ticks spent in escape/zone
    // mode after decideMode resolves for this tick. The counter is read
    // by decideMode NEXT tick to decide whether to force-exit. Resets per
    // round / own respawn via resetBrainStateForRound.
    if (state.mode === "escape")
        state.escapeTicksThisRound++;
    else if (state.mode === "zone")
        state.zoneTicksThisRound++;
    switch (state.mode) {
        case "neutral": return runNeutralMode(obs, params, state, sig);
        case "offense": return runOffenseMode(obs, params, state, sig);
        case "zone": return runZoneMode(obs, params, sig);
        case "objective": return runObjectiveMode(obs, params, state, sig);
        case "escape": return runEscapeMode(obs, params, sig);
    }
}
