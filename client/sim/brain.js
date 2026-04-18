import { STATS, STEP } from "./constants.js";
// v3: Intent state machine. Five modes — neutral, offense, zone,
// objective, escape — each with its own behavior loop and minimum
// commitment window. Replaces v2's per-tick reactive ladder. Params
// bias mode transitions and tactical details within each mode; they no
// longer drive behavior directly via a flat if/else.
export const BEHAVIOR_VERSION = 3;
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
// Distance band used by several modes' "close enough to commit"
// thresholds. burnRate extends effective swing reach.
function swingRange(params) {
    return 50 + params.burnRate * 80;
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
    const ticksSinceOppAttack = obs.tick - obs.opp.lastAttackStartTick;
    const oppRecovering = ticksSinceOppAttack >= RECOVERY_WINDOW_START &&
        ticksSinceOppAttack <= RECOVERY_WINDOW_END &&
        !oppActive;
    const oppOpen = obs.opp.stun > 0 || (!oppActive && Math.abs(obs.opp.vx) < 120 && Math.abs(obs.opp.vy) < 80);
    // Opp closing fast: their velocity component toward us is significant
    // AND they're within one swing-range of contact.
    const oppClosingFast = Math.sign(obs.opp.vx) === -absDir &&
        Math.abs(obs.opp.vx) > 260 &&
        absDist < reach + 80;
    const oppAggression = Math.min(1, state.recentOppSwipeTicks.length / (OPP_BUFFER_DECAY_TICKS / 120));
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
        oppAggression, freeSwing, cornered,
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
function navigateTo(obs, tx, ty) {
    if (ty > obs.self.y + 80) {
        const dx = tx - obs.self.x;
        return { left: dx < -10, right: dx > 10, down: true };
    }
    if (ty < obs.self.y - 50) {
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
    const hardDanger = sig.oppCommittedAtUs &&
        sig.absDist < swingRange(params) + 20 &&
        obs.self.swipeT <= 0 &&
        obs.self.diveT <= 0 &&
        obs.self.invuln <= 0 &&
        !canMatchCommit;
    if (hardDanger && state.mode !== "escape") {
        enterMode(state, "escape", null, tick, "hard-danger");
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
    // ZONE entry: opp is a spammer and we're not pressured.
    if (state.mode === "neutral" && sig.oppAggression > 0.5 && sig.absDist > 120) {
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
        enterMode(state, sig.cornered ? "escape" : "neutral", null, tick, "zone-cleared");
        return;
    }
    // ESCAPE exit: spacing restored.
    if (state.mode === "escape" && sig.absDist > 280 && obs.self.stun <= 0) {
        enterMode(state, "neutral", null, tick, "escape-complete");
        return;
    }
}
// ---------- Mode behavior functions ----------
function runNeutralMode(obs, params, sig) {
    // Hold spacing at moat. Only swing on freeSwing opportunity.
    let move = 0;
    if (sig.predDist > params.moat + 15)
        move = sig.predDir;
    else if (sig.predDist < params.moat - 15)
        move = -sig.predDir;
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
function runOffenseMode(obs, params, state, sig) {
    const sub = state.substate ?? "press";
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
        (!sig.oppCommittedAtUs) ||
        ((params.greed ?? 0.5) > 0.6 && sig.absDist < swingRange(params) * 0.7);
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
    if (obs.self.wall !== 0 && sig.altitudeOff > 40) {
        return { left: obs.self.wall < 0, right: obs.self.wall > 0, up: true };
    }
    const zoneStrike = sig.canSwing && (sig.freeSwing || sig.oppRecovering);
    return {
        left: move < 0, right: move > 0, up: jump, down,
        action: zoneStrike,
    };
}
function runObjectiveMode(obs, params, sig) {
    // Token state drives the sub-behavior.
    const iHaveToken = obs.self.hasToken;
    const oppHasToken = obs.opp.hasToken;
    // DELIVER: I have the token. Route to goal. Once within 40px, stand
    // ground (the dwell window) and only swipe if opp tries to hit me.
    if (iHaveToken && obs.goal.exists) {
        const dxGoal = obs.goal.x - obs.self.x;
        const dyGoal = obs.goal.y - obs.self.y;
        const atGoal = Math.hypot(dxGoal, dyGoal) < 40;
        if (atGoal) {
            // Dwell hold. Don't chase opp. Defensive swing if opp walks into
            // reach while we dwell. Small altitude adjust if opp above.
            let action = false;
            if (sig.canSwing && sig.oppCommittedAtUs)
                action = true;
            if (sig.canSwing && sig.freeSwing)
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
        const shouldFight = oppInPath && sig.absDist < 120 &&
            !goalTimerUrgent && (params.greed ?? 0.5) < 0.4 && !sig.oppCommittedAtUs;
        if (oppInPath && sig.absDist < 120 && obs.self.onGround) {
            // Jump over blocker.
            const toGoalSign = Math.sign(dxGoal) || 1;
            return { left: toGoalSign < 0, right: toGoalSign > 0, up: true };
        }
        if (!shouldFight) {
            return navigateTo(obs, obs.goal.x, obs.goal.y);
        }
    }
    // INTERCEPT: opp has token. Split on distance — far → block the goal
    // line; close → kill-for-reset.
    if (oppHasToken && obs.goal.exists) {
        const dxGoal = obs.goal.x - obs.self.x;
        const oppToGoal = Math.hypot(obs.goal.x - obs.opp.x, obs.goal.y - obs.opp.y);
        const goalTimerUrgent = obs.goal.timer < 3;
        if (sig.absDist < 200 && obs.self.onGround) {
            // Kill-for-reset. Close and commit.
            const move = sig.absDir;
            const commit = sig.canSwing && (sig.freeSwing || sig.oppRecovering || sig.oppOpen || sig.absDist < 80);
            return { left: move < 0, right: move > 0, action: commit };
        }
        // Block the goal. Position between opp and goal.
        // Target: a point closer to the goal than opp is.
        const blockX = obs.goal.x + Math.sign(obs.opp.x - obs.goal.x) * Math.max(60, Math.min(140, oppToGoal * 0.5));
        const tx = blockX;
        const ty = obs.goal.y;
        if (goalTimerUrgent) {
            // Urgent: commit to swipe opp if close.
            if (sig.absDist < 120)
                return { left: sig.absDir < 0, right: sig.absDir > 0, action: sig.canSwing };
        }
        return navigateTo(obs, tx, ty);
    }
    // PICKUP: token on ground, neither holds. Race.
    if (obs.token.exists && obs.token.carrier === -1) {
        const tx = obs.token.x;
        const ty = obs.token.y;
        const myDist = Math.hypot(tx - obs.self.x, ty - obs.self.y);
        const oppDist = Math.hypot(tx - obs.opp.x, ty - obs.opp.y);
        if (myDist <= oppDist + 20) {
            return navigateTo(obs, tx, ty);
        }
        // Opp will reach first. Preempt with a swipe if we can catch them.
        if (sig.canSwing && sig.absDist < swingRange(params)) {
            return { action: true, left: sig.absDir < 0, right: sig.absDir > 0 };
        }
        return navigateTo(obs, tx, ty);
    }
    // Fallback — shouldn't reach here because objective-active triggered
    // the mode entry.
    return runNeutralMode(obs, params, sig);
}
function runEscapeMode(obs, params, sig) {
    // Priority ladder. NEVER swipe.
    // 1. Wall-bound → wall-jump away.
    if (obs.self.wall !== 0) {
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
    switch (state.mode) {
        case "neutral": return runNeutralMode(obs, params, sig);
        case "offense": return runOffenseMode(obs, params, state, sig);
        case "zone": return runZoneMode(obs, params, sig);
        case "objective": return runObjectiveMode(obs, params, sig);
        case "escape": return runEscapeMode(obs, params, sig);
    }
}
