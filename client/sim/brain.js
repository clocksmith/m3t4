// Parameterized brain: single function that reads the per-tick params and
// emits an Action. The DSL layer produces those params from the raw config.
const REACH_UP = 260;
function climbStep(obs, targetY) {
    // Pick the platform within jump range that's closest to the target y.
    // Without a target, default to the highest in range (most ambitious).
    // This fixes the "bot on floor jumps to highest platform instead of the
    // ledge right under the goal" bug that left bots orbiting mid-level
    // platforms when the actual goal was on a low side ledge.
    let best = null;
    let bestScore = Infinity;
    for (const p of obs.platforms) {
        if (p.solid)
            continue;
        if (p.y >= obs.self.y - 30)
            continue;
        if (p.y < obs.self.y - REACH_UP)
            continue;
        const score = targetY !== undefined ? Math.abs(p.y - targetY) : p.y;
        if (score < bestScore) {
            best = p;
            bestScore = score;
        }
    }
    return best;
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
        // No reachable platform but target is above — jump anyway and drift
        // toward tx. Next tick we'll likely see a platform in range.
        const dx2 = tx - obs.self.x;
        const stillRising = !obs.self.onGround && obs.self.vy < -150;
        return {
            left: dx2 < -10,
            right: dx2 > 10,
            up: obs.self.onGround || stillRising,
        };
    }
    const dx = tx - obs.self.x;
    return { left: dx < -10, right: dx > 10 };
}
export function runParamBrain(obs, params) {
    if (obs.self.dead)
        return {};
    // Score-state: losing bots commit harder; winning bots play safer.
    const losing = obs.self.rounds < obs.opp.rounds ||
        (obs.self.rounds === obs.opp.rounds && obs.self.score < obs.opp.score);
    const winning = obs.self.rounds > obs.opp.rounds ||
        (obs.self.rounds === obs.opp.rounds && obs.self.score > obs.opp.score);
    // 1. Carrying tokens → deliver.
    //    Abort only if opp is *between me and the goal*. Multiple escape
    //    hatches: (a) dwell defense if already at goal, (b) jump-over if
    //    opp blocks path on the ground, (c) skip abort entirely if goal
    //    timer is running out, (d) skip abort if losing (must commit).
    if (obs.self.hasToken && obs.goal.exists && params.shipRate > 0.3) {
        const toGoal = obs.goal.x - obs.self.x;
        const toOpp = obs.opp.x - obs.self.x;
        const oppInPath = Math.sign(toGoal) === Math.sign(toOpp)
            && Math.abs(toOpp) < Math.abs(toGoal);
        const oppClose = obs.absDx < 150;
        const oppDangerous = !obs.opp.dead && (obs.tick - obs.opp.lastAttackStartTick) > 5;
        const goalTimerUrgent = obs.goal.timer < 3; // goal about to disappear
        const mustCommit = goalTimerUrgent || losing;
        const atGoal = Math.hypot(obs.self.x - obs.goal.x, obs.self.y - obs.goal.y) < 30;
        if (atGoal && oppClose) {
            // Dwell defense: stay PUT inside the 32px scoring radius. The sim
            // auto-faces opp when no horizontal input (simulate.ts:289), so
            // pressing left/right toward opp is both unnecessary AND harmful —
            // it can push the body out of the dwell circle and reset progress.
            // Only swing when opp is actually in reach.
            return {
                action: obs.absDx < 80 && obs.self.swipeCD <= 0,
            };
        }
        // Jump-over: opp blocks the direct path on the ground. Instead of
        // aborting, use the vertical axis — leap over opp, keep committing
        // toward the goal. Fixes the "carrier dies en route" pattern where
        // carriers abandon delivery at 50% completion and lose their token.
        if (oppInPath && oppClose && obs.self.onGround && obs.absDx < 120) {
            const toGoalSign = Math.sign(toGoal) || 1;
            return {
                left: toGoalSign < 0, right: toGoalSign > 0,
                up: true,
            };
        }
        const abortThreshold = 1 - (params.greed ?? 0.5);
        if (oppInPath && oppClose && oppDangerous && abortThreshold > 0.6 && !mustCommit) {
            // Opp blocks, we're not desperate — fight first.
        }
        else {
            return navigateTo(obs, obs.goal.x, obs.goal.y);
        }
    }
    // 1b. Spite: if opp is delivering, actively chase them regardless of normal
    //     pivot/moat logic. Negative spite = pure denial. Positive = selfish.
    if (obs.opp.hasToken && obs.goal.exists && (params.spite ?? 0) < 0) {
        // Spite < 0: we care more about denying than our own strategy
        // Override: close in on the carrier aggressively
        const dxOpp = obs.opp.x - obs.self.x;
        return {
            left: dxOpp < -10,
            right: dxOpp > 10,
            action: Math.abs(dxOpp) < 110 && Math.abs(obs.dy) < 80,
        };
    }
    // 2. Anti-stall override, weakened by hallucination
    const E = { ...params };
    const overrideStr = 1 - Math.min(1, (E.hallucination || 0) / 100);
    if (!obs.self.hasToken) {
        E.moat += (Math.min(params.moat, 50) - E.moat) * overrideStr;
        E.pivotSpeed += (params.pivotSpeed * 0.3 - E.pivotSpeed) * overrideStr;
        E.burnRate += (Math.max(params.burnRate, 0.7) - E.burnRate) * overrideStr;
    }
    if (obs.opp.hasToken && obs.goal.exists) {
        E.moat += (0 - E.moat) * overrideStr;
        E.burnRate += (1.0 - E.burnRate) * overrideStr;
        E.pivotSpeed += (0 - E.pivotSpeed) * overrideStr;
    }
    // Score-state adjustments: losing bots push harder, winning bots camp
    // harder. Scales the effective aggression without changing the base
    // attributes — so the behavior shifts naturally without breaking the
    // attribute-orthogonality invariant.
    if (losing) {
        E.burnRate = Math.min(1, E.burnRate * 1.25);
        E.moat = Math.max(20, E.moat * 0.8);
    }
    else if (winning) {
        E.moat = Math.min(240, E.moat * 1.2);
        E.burnRate = Math.max(0.2, E.burnRate * 0.9);
    }
    // Pacing: rhythmic burst on burnRate. Low pacing = steady; high = burst+rest.
    if ((params.pacing ?? 0) > 0.05) {
        const pacingMul = 1 + (params.pacing ?? 0) * 0.5 * Math.sin(obs.tick * 0.02);
        E.burnRate *= pacingMul;
    }
    const predX = obs.opp.x + obs.opp.vx * E.foresight;
    const dx = predX - obs.self.x;
    const dist = Math.abs(dx);
    const dir = Math.sign(dx) || 1;
    const oppActive = obs.opp.swipeT > 0 || obs.opp.diveT > 0;
    const danger = oppActive && dist < 100;
    const desiredY = obs.opp.y + E.leverage * 150;
    const altitudeOff = obs.self.y - desiredY;
    let move = 0;
    let jump = false;
    let down = false;
    const stillRising = !obs.self.onGround && obs.self.vy < -150;
    // Memory-driven tactics. All four use recent-world-tick stamps from
    // simulate.ts — no user-visible attribute, but enables reactive play.
    const ticksSinceClash = obs.tick - obs.self.lastClashTick;
    const ticksSinceOppAttack = obs.tick - obs.opp.lastAttackStartTick;
    const ticksSinceKill = obs.tick - obs.self.lastKillTick;
    const recentClash = ticksSinceClash < 36; // ~0.3s — avoid immediate re-clash
    const oppCommitted = ticksSinceOppAttack < 10 && oppActive; // opp just swung
    const postKillMomentum = ticksSinceKill < 72; // ~0.6s — opp invuln, push now
    const cun = params.cunning ?? 0.5;
    // Post-kill momentum: opp just died and is invulnerable during respawn.
    // Use the free window to push toward the goal (if carrying) or toward
    // opp's upcoming spawn so we're there when invuln ends. Committed
    // decision — don't rethink until the window closes.
    if (postKillMomentum) {
        if (obs.self.hasToken && obs.goal.exists) {
            return navigateTo(obs, obs.goal.x, obs.goal.y);
        }
        // Head toward the token (dropped at kill point) or opp's last position.
        if (obs.token.exists && !obs.self.hasToken) {
            const tx = obs.token.x - obs.self.x;
            return { left: tx < -10, right: tx > 10 };
        }
    }
    // Counter-punish: opp just swung. Cunning bots close the gap so we're in
    // striking range when their swipe ends — they can't parry a recovering
    // blade. Low cunning bots can't read this and miss the window.
    if (oppCommitted && cun > 0.5 && dist < 160 && obs.self.swipeCD <= 0) {
        return {
            left: dir < 0,
            right: dir > 0,
            action: dist < 90,
        };
    }
    // Mutual-contact preemption: both bots approaching head-on at same Y
    // with passive foils is the classic walk-into-each-other setup. Bots
    // with foresight sometimes hop to break Y-symmetry — but not every
    // tick, or mirror matches hop-stalemate forever (observed intern-v-
    // intern: 0 kills in 4 min). Phase-gated so it fires ~15% of opportunity
    // windows; the other 85% the bot commits through (now safe after the
    // passive-mutual-clash fix in simulate.ts).
    const approachSpeed = Math.abs(obs.self.vx) + Math.abs(obs.opp.vx);
    const mutualImminent = dist < 150 &&
        Math.abs(obs.dy) < 30 &&
        approachSpeed > 280 &&
        obs.self.swipeT <= 0 &&
        obs.opp.swipeT <= 0 &&
        obs.self.onGround;
    if (mutualImminent && E.foresight > 0.08) {
        // Phase + id-offset: P0 juke chance peaks at different tick than P1.
        const phase = (obs.tick + obs.self.id * 37) % 120;
        if (phase < 18) {
            const flip = obs.self.id === 0 ? 1 : -1;
            return { left: -dir * flip < 0, right: -dir * flip > 0, up: true };
        }
    }
    // Wall-flank: networking specialists actively seek the far wall for an
    // altitude advantage when opp holds the token. Gated: only pursue a wall
    // if we're actually below opp (need the altitude) AND not already
    // committing to a flank (altitude gap hasn't stalled). Otherwise we
    // camp on the top platform forever and never come back for the delivery.
    if (obs.opp.hasToken && E.networking > 0.5 && obs.self.onGround
        && altitudeOff > 40 && obs.self.wall === 0
        && obs.self.y > obs.opp.y - 60 // only if still BELOW opp
    ) {
        const oppSide = obs.opp.x > obs.self.x ? 1 : -1;
        const targetWallX = oppSide > 0 ? obs.arena.right : obs.arena.left;
        const distToWall = Math.abs(obs.self.x - targetWallX);
        if (distToWall > 60) {
            return {
                left: targetWallX < obs.self.x,
                right: targetWallX > obs.self.x,
                up: true,
            };
        }
    }
    // Wall-jump assist (reactive: we're already on a wall)
    if (E.networking > 0.4 && obs.self.wall !== 0 && altitudeOff > 60) {
        return { left: obs.self.wall < 0, right: obs.self.wall > 0, up: true };
    }
    // Dive from air
    if (!obs.self.onGround &&
        E.leverage < -0.4 &&
        obs.self.y < obs.opp.y - 30 &&
        obs.absDx < 70) {
        return { down: true, action: true };
    }
    // Stuck detector: if we haven't moved meaningfully in ~1.5s, force a
    // mixup. Kills platform-camping, center-mirror stalemates, and goal-
    // orbit oscillation. Action depends on context — jumping over opp
    // breaks clash loops, dropping through breaks platform camps.
    const ticksSinceMove = obs.tick - obs.self.lastMoveTick;
    const stuck = ticksSinceMove > 90;
    if (stuck) {
        if (obs.self.onGround && dist < 200) {
            // Mirror-image clash loop. Commit: jump toward opp (setup for dive).
            return { left: dir < 0, right: dir > 0, up: true };
        }
        if (obs.self.onGround) {
            // Platform camp with opp elsewhere. Drop through (if possible) or
            // hop off and head toward opp's x.
            return { left: dir < 0, right: dir > 0, down: true };
        }
        // Airborne and stuck — commit a dive if we have altitude.
        if (obs.self.y < obs.opp.y - 20)
            return { down: true, action: true };
    }
    if (recentClash && dist < 110) {
        // Post-clash: response branches on attributes so bots with different
        // profiles don't mirror each other. Per-fighter id offset desyncs
        // even identical attribute sets — without it, mirror-match bots
        // loop-clash at the same cadence forever.
        const aggressive = (params.spite ?? 0) > 0.1 || (params.pacing ?? 0) > 0.5;
        const evasive = (params.pivotSpeed ?? 0) > 0.6;
        const phase = (ticksSinceClash + obs.self.id * 13) % 40;
        if (phase < 12) {
            move = -dir; // both retreat briefly during stun
        }
        else if (aggressive && obs.self.onGround) {
            move = dir;
            jump = true; // commit jump-over
        }
        else if (evasive) {
            // Retreat further + optional defensive swing. Upward slash covers
            // above; opp chasing high gets clipped.
            return {
                left: -dir < 0,
                right: -dir > 0,
                action: (params.cunning ?? 0) > 0.5,
            };
        }
        else {
            // Default: phase-varied mixup — not "hold position" because that
            // just lets opp reset the loop. Phase-gated jump-over breaks
            // horizontal stalemate by adding vertical axis.
            if (phase < 24) {
                move = -dir; // extended retreat
            }
            else {
                move = dir;
                jump = obs.self.onGround; // commit forward over opp
            }
        }
    }
    else if (danger && E.pivotSpeed > 0.5) {
        move = -dir;
        jump = obs.self.onGround || stillRising;
    }
    else if (altitudeOff > 60) {
        const nav = navigateTo(obs, obs.opp.x, desiredY);
        move = nav.left ? -1 : nav.right ? 1 : 0;
        jump = !!nav.up || stillRising;
        if (!nav.up && E.networking > 0.5 && obs.self.onGround) {
            const toLeft = obs.self.x - obs.arena.left;
            const toRight = obs.arena.right - obs.self.x;
            move = toLeft < toRight ? -1 : 1;
        }
    }
    else if (altitudeOff < -80) {
        down = true;
        if (dx > 10)
            move = 1;
        else if (dx < -10)
            move = -1;
    }
    else {
        if (dist > E.moat + 15)
            move = dir;
        else if (dist < E.moat - 15)
            move = -dir;
    }
    const swingRange = 50 + E.burnRate * 80;
    const inSwingReach = dist < swingRange && Math.abs(obs.dy) < 80;
    const oppOpen = obs.opp.stun > 0 || (!oppActive && Math.abs(obs.opp.vx) < 120);
    // Anti-air priority: opp diving at us. Upward slash catches their arc.
    const oppDivingAtUs = obs.opp.diveT > 0 && obs.absDx < 110 && obs.opp.y < obs.self.y + 20;
    // Advantage swings: no passive-foil retaliation possible here.
    const selfBehindOpp = (obs.self.x - obs.opp.x) * obs.opp.facing < 0 && obs.absDx < 100;
    const verticalAdvantage = obs.self.y < obs.opp.y - 30 && obs.absDx < 140;
    const freeSwing = oppDivingAtUs || selfBehindOpp || verticalAdvantage;
    // Cunning: how patient about swing timing.
    //   Low cunning (~0):  swing reflexively when in reach (even if opp is ready)
    //   High cunning (~1): wait for opp to be recovering/stunned/committed
    // (`cun` declared earlier for the counter-punish check.)
    const reckless = cun < 0.3;
    const patient = cun > 0.7;
    let safeStrike = inSwingReach && (!oppActive || dist < 70);
    if (patient)
        safeStrike = safeStrike && oppOpen;
    else if (reckless)
        safeStrike = inSwingReach; // no safety check
    if (stillRising && (altitudeOff > 60 || danger))
        jump = true;
    return {
        left: move < 0,
        right: move > 0,
        up: jump,
        down,
        action: freeSwing || (safeStrike && (E.burnRate > 0.15 || oppOpen)),
    };
}
