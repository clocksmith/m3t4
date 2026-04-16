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
    //    Low greed: back off toward opp if opp is close (don't get caught at goal).
    //    High greed: push through regardless.
    if (obs.self.hasToken && obs.goal.exists && params.shipRate > 0.3) {
        const oppClose = obs.absDx < 120;
        const oppActiveHere = obs.opp.swipeT > 0 || obs.opp.diveT > 0;
        const abortThreshold = 1 - (params.greed ?? 0.5); // low greed = early abort
        if (oppClose && oppActiveHere && abortThreshold > 0.6) {
            // Don't commit to the delivery; fight instead
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
    // Wall-jump assist
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
    if (danger && E.pivotSpeed > 0.5) {
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
    const cun = params.cunning ?? 0.5;
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
