// Shared canvas renderer. Takes a TraceFrame (from sim) + stage and draws
// the scene. Used by both Spectate (server frames) and Practice (local).

import { STAGES, STATS } from "../sim/index.js";

export const W = 1280;
export const H = 720;

const P1_COL = "#6ee7b7", P1_TRIM = "#d1fae5", P1_SHADOW = "#047857";
const P2_COL = "#fb923c", P2_TRIM = "#fed7aa", P2_SHADOW = "#9a3412";

export function setupCanvas(canvas) {
  const ctx = canvas.getContext("2d", { alpha: false });
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const cssW = Math.min(W, document.documentElement.clientWidth - 40);
    const cssH = cssW * (H / W);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = Math.round(cssW) + "px";
    canvas.style.height = Math.round(cssH) + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();
  return { ctx, resize };
}

export function drawFrame(ctx, stage, frame, labels) {
  ctx.fillStyle = "#14141e";
  ctx.fillRect(0, 0, W, H);
  drawStage(ctx, stage);
  drawGoal(ctx, frame.goal);
  drawToken(ctx, frame.token);
  drawFighter(ctx, frame.p0, P1_COL, P1_TRIM, P1_SHADOW);
  drawFighter(ctx, frame.p1, P2_COL, P2_TRIM, P2_SHADOW);
  drawHUD(ctx, frame, labels);
}

function drawStage(ctx, stage) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#141020");
  g.addColorStop(0.5, "#0e1520");
  g.addColorStop(1, "#080c14");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (const p of stage.platforms) {
    ctx.fillStyle = p.solid ? "#141c28" : "#151e2a";
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.fillRect(p.x, p.y, p.w, 3);
  }
}

function drawGoal(ctx, goal) {
  if (!goal.exists) return;
  ctx.save();
  ctx.translate(goal.x, goal.y);
  const pulse = 1 + Math.sin(Date.now() * 0.01) * 0.1;
  ctx.fillStyle = "rgba(255,215,0,0.08)";
  ctx.beginPath();
  ctx.arc(0, 0, 60 * pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,215,0,0.7)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, 22 * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,215,0,0.85)";
  ctx.font = "700 13px monospace";
  ctx.textAlign = "center";
  ctx.fillText(goal.label, 0, -36);
  ctx.restore();
}

function drawToken(ctx, t) {
  if (!t.exists) return;
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.fillStyle = "rgba(255,215,0,0.15)";
  ctx.beginPath();
  ctx.arc(0, 0, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffd700";
  ctx.beginPath();
  ctx.moveTo(0, -10); ctx.lineTo(7, 0); ctx.lineTo(0, 10); ctx.lineTo(-7, 0);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawFighter(ctx, f, col, trim, shadow) {
  if (f.dead) return;
  const bw = STATS.bodyW;
  const bh = STATS.bodyH;
  ctx.strokeStyle = shadow;
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(f.x, f.y - bh * 0.5);
  ctx.lineTo(f.x, f.y + bh * 0.06);
  ctx.stroke();
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(f.x, f.y - bh * 0.66, bw * 0.36, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = trim;
  ctx.fillRect(f.x - bw * 0.48, f.y - bh * 0.54, bw * 0.96, bh * 0.74);

  // Sword
  const active = f.swipeT > 0 || f.diveT > 0;
  const bx = f.x + f.facing * bw * 0.35;
  const by = f.y - bh * 0.3;
  let angle = 0;
  if (f.diveT > 0) angle = Math.PI * 0.46;
  else if (f.swipeT > 0) {
    const t = 1 - f.swipeT / STATS.swipeTime;
    angle = 0.5 + (-0.5 - 0.5) * (1 - (1 - t) ** 3);
  }
  const dx = Math.cos(angle) * f.facing;
  const dy = Math.sin(angle);
  const len = STATS.sword;
  const tx = bx + dx * len;
  const ty = by + dy * len;
  if (active) {
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 12;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.strokeStyle = f.diveT > 0 ? "#ffe8c0" : "#fffaf0";
    ctx.lineWidth = f.diveT > 0 ? 7 : 6;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.fillStyle = "#fffaf0";
    ctx.beginPath(); ctx.arc(tx, ty, 4, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.strokeStyle = "rgba(200,205,215,0.32)";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + f.facing * 12, by + 8); ctx.stroke();
  }
  ctx.fillStyle = shadow;
  ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2); ctx.fill();
}

function drawHUD(ctx, frame, labels) {
  const L = labels || {};
  ctx.font = "700 20px monospace";
  ctx.fillStyle = P1_COL;
  ctx.textAlign = "left";
  ctx.fillText(L.p1 || "P1", 40, 36);
  ctx.fillStyle = P2_COL;
  ctx.textAlign = "right";
  ctx.fillText(L.p2 || "P2", W - 40, 36);

  ctx.font = "700 44px monospace";
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.fillText(String(frame.scoreboard[0]), 48, 88);
  ctx.textAlign = "right";
  ctx.fillText(String(frame.scoreboard[1]), W - 48, 88);

  // Round dots
  ctx.font = "600 14px monospace";
  ctx.fillStyle = "rgba(248,247,244,0.6)";
  const dots0 = Array.from({ length: 2 }, (_, i) => (i < frame.rounds[0] ? "\u25CF" : "\u25CB")).join(" ");
  const dots1 = Array.from({ length: 2 }, (_, i) => (i < frame.rounds[1] ? "\u25CF" : "\u25CB")).join(" ");
  ctx.textAlign = "left";
  ctx.fillText(dots0, 50, 108);
  ctx.textAlign = "right";
  ctx.fillText(dots1, W - 50, 108);

  if (L.tick !== undefined) {
    ctx.font = "500 12px monospace";
    ctx.fillStyle = "#667";
    ctx.textAlign = "center";
    ctx.fillText(`tick ${frame.tick ?? L.tick}`, W / 2, 24);
  }
}
