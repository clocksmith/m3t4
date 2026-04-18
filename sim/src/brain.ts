import type { Action, Observation, Params, Platform } from "./types.js";

export const BEHAVIOR_VERSION = 2;

const REACH_UP = 260;

function climbStep(obs: Observation, targetY?: number): Platform | null {
  let best: Platform | null = null;
  let bestScore = Infinity;
  for (const p of obs.platforms) {
    if (p.solid) continue;
    if (p.y >= obs.self.y - 30) continue;
    if (p.y < obs.self.y - REACH_UP) continue;
    const score = targetY !== undefined ? Math.abs(p.y - targetY) : p.y;
    if (score < bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

function navigateTo(obs: Observation, tx: number, ty: number): Action {
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
      if (obs.self.x < platL) dir = 1;
      else if (obs.self.x > platR) dir = -1;
      const launchZone = obs.self.x > platL - 110 && obs.self.x < platR + 110;
      const stillRising = !obs.self.onGround && obs.self.vy < -150;
      const jump = (obs.self.onGround && launchZone) || stillRising;
      return { left: dir < 0, right: dir > 0, up: jump };
    }
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

export function runParamBrain(obs: Observation, params: Params): Action {
  if (obs.self.dead) return {};

  const losing =
    obs.self.rounds < obs.opp.rounds ||
    (obs.self.rounds === obs.opp.rounds && obs.self.score < obs.opp.score);
  const winning =
    obs.self.rounds > obs.opp.rounds ||
    (obs.self.rounds === obs.opp.rounds && obs.self.score > obs.opp.score);

  if (obs.self.hasToken && obs.goal.exists && params.shipRate > 0.3) {
    const toGoal = obs.goal.x - obs.self.x;
    const toOpp = obs.opp.x - obs.self.x;
    const oppInPath = Math.sign(toGoal) === Math.sign(toOpp)
      && Math.abs(toOpp) < Math.abs(toGoal);
    const oppClose = obs.absDx < 150;
    const oppDangerous = !obs.opp.dead && (obs.tick - obs.opp.lastAttackStartTick) > 5;
    const goalTimerUrgent = obs.goal.timer < 3;
    const mustCommit = goalTimerUrgent || losing;

    const atGoal = Math.hypot(obs.self.x - obs.goal.x, obs.self.y - obs.goal.y) < 30;
    if (atGoal && oppClose) {
      return {
        action: obs.absDx < 80 && obs.self.swipeCD <= 0,
      };
    }
    if (oppInPath && oppClose && obs.self.onGround && obs.absDx < 120) {
      const toGoalSign = Math.sign(toGoal) || 1;
      return {
        left: toGoalSign < 0, right: toGoalSign > 0,
        up: true,
      };
    }
    const abortThreshold = 1 - (params.greed ?? 0.5);
    const shouldFightBlocker = oppInPath && oppClose && oppDangerous && abortThreshold > 0.6 && !mustCommit;
    if (!shouldFightBlocker) {
      return navigateTo(obs, obs.goal.x, obs.goal.y);
    }
  }

  if (obs.opp.hasToken && obs.goal.exists && (params.spite ?? 0) < 0) {
    const dxOpp = obs.opp.x - obs.self.x;
    return {
      left: dxOpp < -10,
      right: dxOpp > 10,
      action: Math.abs(dxOpp) < 110 && Math.abs(obs.dy) < 80,
    };
  }

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

  if (losing) {
    E.burnRate = Math.min(1, E.burnRate * 1.25);
    E.moat = Math.max(20, E.moat * 0.8);
  } else if (winning) {
    E.moat = Math.min(240, E.moat * 1.2);
    E.burnRate = Math.max(0.2, E.burnRate * 0.9);
  }

  if ((params.pacing ?? 0) > 0.05) {
    const pacingMul = 1 + (params.pacing ?? 0) * 0.5 * Math.sin(obs.tick * 0.02);
    E.burnRate *= pacingMul;
  }

  const predX = obs.opp.x + obs.opp.vx * E.foresight;
  const predDx = predX - obs.self.x;
  const predDist = Math.abs(predDx);
  const predDir = Math.sign(predDx) || 1;

  const absDist = obs.absDx;
  const absDir = Math.sign(obs.dx) || 1;

  const oppActive = obs.opp.swipeT > 0 || obs.opp.diveT > 0;
  const danger = oppActive && absDist < 100;

  const desiredY = obs.opp.y + E.leverage * 150;
  const altitudeOff = obs.self.y - desiredY;

  let move = 0;
  let jump = false;
  let down = false;
  const stillRising = !obs.self.onGround && obs.self.vy < -150;

  const ticksSinceClash = obs.tick - obs.self.lastClashTick;
  const ticksSinceOppAttack = obs.tick - obs.opp.lastAttackStartTick;
  const ticksSinceKill = obs.tick - obs.self.lastKillTick;
  const recentClash = ticksSinceClash < 36;
  const oppCommitted = ticksSinceOppAttack < 10 && oppActive;
  const postKillMomentum = ticksSinceKill < 72;
  const cun = params.cunning ?? 0.5;

  if (postKillMomentum) {
    if (obs.self.hasToken && obs.goal.exists) {
      return navigateTo(obs, obs.goal.x, obs.goal.y);
    }
    if (obs.token.exists && !obs.self.hasToken) {
      const tx = obs.token.x - obs.self.x;
      return { left: tx < -10, right: tx > 10 };
    }
  }

  if (oppCommitted && cun > 0.5 && absDist < 160 && obs.self.swipeCD <= 0) {
    return {
      left: predDir < 0,
      right: predDir > 0,
      action: absDist < 90,
    };
  }

  const approachSpeed = Math.abs(obs.self.vx) + Math.abs(obs.opp.vx);
  const mutualImminent =
    absDist < 150 &&
    Math.abs(obs.dy) < 30 &&
    approachSpeed > 280 &&
    obs.self.swipeT <= 0 &&
    obs.opp.swipeT <= 0 &&
    obs.self.onGround;
  if (mutualImminent && E.foresight > 0.08) {
    const phase = (obs.tick + obs.self.id * 37) % 120;
    if (phase < 18) {
      const flip = obs.self.id === 0 ? 1 : -1;
      return { left: -absDir * flip < 0, right: -absDir * flip > 0, up: true };
    }
  }

  if (
    obs.opp.hasToken && E.networking > 0.5 && obs.self.onGround
    && altitudeOff > 40 && obs.self.wall === 0
    && obs.self.y > obs.opp.y - 60
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

  if (E.networking > 0.4 && obs.self.wall !== 0 && altitudeOff > 60) {
    return { left: obs.self.wall < 0, right: obs.self.wall > 0, up: true };
  }

  if (
    !obs.self.onGround &&
    E.leverage < -0.4 &&
    obs.self.y < obs.opp.y - 30 &&
    obs.absDx < 70
  ) {
    return { down: true, action: true };
  }

  const ticksSinceMove = obs.tick - obs.self.lastMoveTick;
  const stuck = ticksSinceMove > 90;
  if (stuck) {
    if (obs.self.onGround && absDist < 200) {
      return { left: absDir < 0, right: absDir > 0, up: true };
    }
    if (obs.self.onGround) {
      return { left: predDir < 0, right: predDir > 0, down: true };
    }
    if (obs.self.y < obs.opp.y - 20) return { down: true, action: true };
  }

  if (recentClash && absDist < 110) {
    const aggressive = (params.spite ?? 0) > 0.1 || (params.pacing ?? 0) > 0.5;
    const evasive = (params.pivotSpeed ?? 0) > 0.6;
    const phase = (ticksSinceClash + obs.self.id * 13) % 40;
    if (phase < 12) {
      move = -absDir;
    } else if (aggressive && obs.self.onGround) {
      move = absDir;
      jump = true;
    } else if (evasive) {
      return {
        left: -absDir < 0,
        right: -absDir > 0,
        action: (params.cunning ?? 0) > 0.5,
      };
    } else {
      if (phase < 24) {
        move = -absDir;
      } else {
        move = absDir;
        jump = obs.self.onGround;
      }
    }
  } else if (danger && E.pivotSpeed > 0.5) {
    move = -absDir;
    jump = obs.self.onGround || stillRising;
  } else if (altitudeOff > 60) {
    const nav = navigateTo(obs, obs.opp.x, desiredY);
    move = nav.left ? -1 : nav.right ? 1 : 0;
    jump = !!nav.up || stillRising;
    if (!nav.up && E.networking > 0.5 && obs.self.onGround) {
      const toLeft = obs.self.x - obs.arena.left;
      const toRight = obs.arena.right - obs.self.x;
      move = toLeft < toRight ? -1 : 1;
    }
  } else if (altitudeOff < -80) {
    down = true;
    if (obs.dx > 10) move = 1;
    else if (obs.dx < -10) move = -1;
  } else {
    if (predDist > E.moat + 15) move = predDir;
    else if (predDist < E.moat - 15) move = -predDir;
  }

  const swingRange = 50 + E.burnRate * 80;
  const inSwingReach = absDist < swingRange && Math.abs(obs.dy) < 80;
  const oppOpen = obs.opp.stun > 0 || (!oppActive && Math.abs(obs.opp.vx) < 120);

  const oppDivingAtUs = obs.opp.diveT > 0 && obs.absDx < 110 && obs.opp.y < obs.self.y + 20;
  const selfBehindOpp = (obs.self.x - obs.opp.x) * obs.opp.facing < 0 && obs.absDx < 100;
  const verticalAdvantage = obs.self.y < obs.opp.y - 30 && obs.absDx < 140;
  const freeSwing = oppDivingAtUs || selfBehindOpp || verticalAdvantage;

  const reckless = cun < 0.3;
  const patient = cun > 0.7;
  let safeStrike = inSwingReach && (!oppActive || absDist < 70);
  if (patient) safeStrike = safeStrike && oppOpen;
  else if (reckless) safeStrike = inSwingReach;

  if (stillRising && (altitudeOff > 60 || danger)) jump = true;

  return {
    left: move < 0,
    right: move > 0,
    up: jump,
    down,
    action: freeSwing || (safeStrike && (E.burnRate > 0.15 || oppOpen)),
  };
}
