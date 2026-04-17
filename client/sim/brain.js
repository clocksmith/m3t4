// Parameterized brain: single function that reads the per-tick params and
// emits an Action. The DSL layer produces those params from the raw config.
const REACH_UP = 260;
function climbStep(obs) {
    let best = null;
    let bestY = obs.self.y;
    for (const p of obs.platforms) {
        if (p.solid)
            continue;
        if (p.y >= obs.self.y - 30)
            continue;
        if (p.y < obs.self.y - REACH_UP)
            continue;
        if (p.y < bestY) {
            best = p;
            bestY = p.y;
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
        const step = climbStep(obs);
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
    }
    const dx = tx - obs.self.x;
    return { left: dx < -10, right: dx > 10 };
}
export function runParamBrain(obs, params) {
    if (obs.self.dead)
        return {};
    // 1. Carrying tokens → deliver — but greed modulates whether danger aborts it.
    //    Abort only if opp is *between me and the goal*. That check is stable
    //    tick-to-tick. Checking opp.swipeT/diveT flickers as animations cycle
    //    and causes sub-second deliver/fight oscillation at the goal.
    if (obs.self.hasToken && obs.goal.exists && params.shipRate > 0.3) {
        const toGoal = obs.goal.x - obs.self.x;
        const toOpp = obs.opp.x - obs.self.x;
        const oppInPath = Math.sign(toGoal) === Math.sign(toOpp)
            && Math.abs(toOpp) < Math.abs(toGoal);
        const oppClose = obs.absDx < 150;
        const abortThreshold = 1 - (params.greed ?? 0.5); // low greed = early abort
        if (oppInPath && oppClose && abortThreshold > 0.6) {
            // Opp blocks the delivery corridor — fight first.
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
    // Memory-driven tactics. All three use recent-world-tick stamps from
    // simulate.ts — no user-visible attribute, but enables reactive play.
    const ticksSinceClash = obs.tick - obs.self.lastClashTick;
    const ticksSinceOppAttack = obs.tick - obs.opp.lastAttackStartTick;
    const recentClash = ticksSinceClash < 36; // ~0.3s — avoid immediate re-clash
    const oppCommitted = ticksSinceOppAttack < 10 && oppActive; // opp just swung
    const cun = params.cunning ?? 0.5;
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
    // Wall-flank: networking specialists actively seek the far wall for an
    // altitude advantage when opp holds the token. Complements the existing
    // reactive wall-jump assist below.
    if (obs.opp.hasToken && E.networking > 0.5 && obs.self.onGround
        && altitudeOff > 40 && obs.self.wall === 0) {
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
    if (recentClash && dist < 110) {
        // Just clashed — both fighters stunned and bounced back. Don't walk
        // straight back in; give blades a beat to reset. Pivot-high bots
        // recover faster (they were already retreating).
        move = -dir;
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
        action: safeStrike && (E.burnRate > 0.15 || oppOpen),
    };
}
