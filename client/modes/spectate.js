// Spectate mode. Connects to /ws, renders server-streamed trace frames.
// No client-side sim — the whole point is config privacy.
//
// Playback: frames arrive in chunks (server STRIDE=3 sim frames per ~25ms).
// We buffer them in a FIFO and play back against a wall-clock baseline at
// the canonical sim rate (120Hz), interpolating fighter/token positions
// between adjacent frames on every RAF. This smooths:
//   - the 3:2 pulldown jank of 40Hz source on a 60Hz display
//   - network jitter (via a larger live buffer before playback starts;
//     bursts past MAX_BUFFER_FRAMES are trimmed back to the live window
//     so latency can't grow unbounded after a stall or tab background)

import { WS_ORIGIN, leaderboard } from "../lib/api.js";
import { STAGES } from "../lib/public-sim.js";
import { setupCanvas, drawFrame, W, H } from "../lib/render.js";
import { getComputeClient } from "../lib/compute.js";
import { auth } from "../lib/auth.js";

const SIM_HZ = 120;                // canonical sim rate
const JITTER_BUFFER_FRAMES = 24;   // ~8 chunks at STRIDE=3 -> ~200ms
const LIVE_BUFFER_FRAMES = 36;     // target after trimming -> ~300ms
const MAX_BUFFER_FRAMES = 90;      // hard cap -> ~750ms
const TELEPORT_PX = 200;           // position jump above this snaps instead of lerps

let ws = null;
let renderState = {
  matchLabel: "waiting…",
  stage: STAGES.datacenter,
  labels: { p1: "", p2: "" },
  handles: { a: "", b: "" },
  elos: { a: 0, b: 0 },
};
let waitState = null; // { reason, nextAttemptAt, intervalMs, skewMs }
let signalState = null; // { title, subtitle, stat, retryMs }
let matchActive = false;
let noiseCanvas = null;
let noiseCtx = null;
let noiseFrameCounter = 0;
let running = false;
let lbTimer = null;
let leaderboardEl = null;
let canvas = null;
let ctx = null;
let rafId = 0;
let statusCb = () => {};
let computeClient = null;
let reconnectTimer = null;

// Playback state — reset on every matchStart.
let frameBuf = [];
let baselineWallMs = 0;
let baselineTick = 0;
let playbackStarted = false;

function resetPlayback() {
  frameBuf = [];
  baselineWallMs = 0;
  baselineTick = 0;
  playbackStarted = false;
  updateBufferStat("idle");
}

function primePlayback() {
  baselineWallMs = performance.now();
  baselineTick = frameBuf[0].tick;
  playbackStarted = true;
}

function pausePlayback() {
  baselineWallMs = 0;
  baselineTick = 0;
  playbackStarted = false;
}

function trimPlaybackToLiveWindow() {
  // Large overflows usually mean a backgrounded tab or network burst.
  // Jump back near live once, then rebuild a normal playback baseline.
  frameBuf = frameBuf.slice(-LIVE_BUFFER_FRAMES);
  if (playbackStarted && frameBuf.length > 0) primePlayback();
}

export function mount(root, { setStatus }) {
  statusCb = setStatus;
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Live <small>— whatever match is happening right now</small></h1>
        <div id="match-hud" class="tight">—</div>
      </div>
      <section class="panel live-quickstart">
        <div class="live-scoring-strip">
          <span>Kill</span>
          <span>Proof Core</span>
          <span>Demand Node</span>
          <span>Delivery</span>
        </div>
        <a class="buttonish ${auth.user() ? "intro-cta-purple" : "primary"}" href="${auth.user() ? "#profile" : "#build"}">
          ${auth.user() ? "edit roster" : "build a bot"}
        </a>
      </section>
      <div class="spectate-grid">
        <aside class="panel lb spectate-side">
          <h3>Leaderboard</h3>
          <div id="leaderboard">loading…</div>
        </aside>
        <div class="spectate-center">
          <canvas id="stage-canvas" width="${W}" height="${H}" tabindex="0"></canvas>
        </div>
        <aside class="panel spectate-stats spectate-side">
          <h3>Live</h3>
          <dl class="stat-list">
            <div class="stat-row"><dt>P1</dt><dd class="p1-accent" id="stat-p1">—</dd></div>
            <div class="stat-row"><dt>P2</dt><dd class="p2-accent" id="stat-p2">—</dd></div>
            <div class="stat-row"><dt>stage</dt><dd id="stat-stage">—</dd></div>
            <div class="stat-row"><dt>ws</dt><dd id="stat-ws">connecting…</dd></div>
            <div class="stat-row"><dt>next match</dt><dd id="stat-countdown">—</dd></div>
            <div class="stat-row"><dt>buffer</dt><dd id="stat-buf">—</dd></div>
            <div class="stat-row"><dt>last result</dt><dd id="stat-result">—</dd></div>
          </dl>
        </aside>
      </div>
      <div class="panel">
        <h3>Stream</h3>
        <div id="stream-log" class="tight stream-log"></div>
      </div>
    </div>`;
  canvas = root.querySelector("#stage-canvas");
  leaderboardEl = root.querySelector("#leaderboard");
  const { ctx: c } = setupCanvas(canvas);
  ctx = c;
  computeClient = getComputeClient();
  computeClient.setMatchPhase(matchActive ? "active" : "intermission");
  void computeClient.maybeAutoStart();

  running = true;
  connect();
  refreshLeaderboard();
  lbTimer = setInterval(refreshLeaderboard, 8000);
  loop();
}

export function unmount() {
  running = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  if (lbTimer) { clearInterval(lbTimer); lbTimer = null; }
  if (rafId) cancelAnimationFrame(rafId);
  resetPlayback();
  computeClient = null;
}

function connect() {
  if (!running) return;
  try {
    ws = new WebSocket(WS_ORIGIN + "/ws");
  } catch (e) {
    setSignalFailure(
      "BROADCAST UNAVAILABLE",
      "The relay socket refused construction. Reopening the wound shortly.",
      "unavailable",
      3000,
    );
    return;
  }
  ws.onopen = () => {
    signalState = null;
    statusCb("ws live");
    setStat("stat-ws", "live");
  };
  ws.onclose = (ev) => {
    if (!running) return;
    const failure = signalFailureForClose(ev);
    setSignalFailure(failure.title, failure.subtitle, failure.stat, failure.retryMs);
  };
  ws.onerror = () => { /* handled by onclose */ };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      setSignalFailure(
        "BROADCAST REJECTED",
        "The signal arrived malformed. The client declined to hallucinate.",
        "malformed",
        15000,
      );
      try { ws.close(1003, "protocol"); } catch {}
      return;
    }
    onEvent(msg);
  };
}

function onEvent(m) {
  signalState = null;
  if (m.type !== "frames") logStreamEvent(m);
  if (m.type === "waiting") {
    const skewMs = typeof m.serverNow === "number" ? (Date.now() - m.serverNow) : 0;
    waitState = { reason: m.reason, nextAttemptAt: m.nextAttemptAt, intervalMs: m.intervalMs, skewMs, nextMatch: m.nextMatch };
    matchActive = false;
    computeClient?.setMatchPhase("intermission");
    resetPlayback();
    if (m.nextMatch) {
      const next = m.nextMatch;
      const label = nextMatchLabel(next);
      const hudEl = document.getElementById("match-hud");
      if (hudEl) hudEl.textContent = `Next: ${label}`;
      setStat("stat-p1", `@${next.a?.handle ?? "p1"} · ${next.a?.elo ?? "?"}`);
      setStat("stat-p2", `@${next.b?.handle ?? "p2"} · ${next.b?.elo ?? "?"}`);
      setStat("stat-stage", next.stageId ?? "datacenter");
      setStat("stat-result", "queued");
      renderState.stage = STAGES[next.stageId] ?? STAGES.datacenter;
    }
    return;
  }
  if (m.type === "matchStart" || m.type === "matchInProgress") {
    waitState = null;
    matchActive = true;
    computeClient?.setMatchPhase("active");
    const mt = m.match || m;
    const handleA = mt.a?.handle ?? "?";
    const handleB = mt.b?.handle ?? "?";
    const eloA = mt.a?.elo ?? "?";
    const eloB = mt.b?.elo ?? "?";
    renderState.handles = { a: handleA, b: handleB };
    renderState.elos = { a: eloA, b: eloB };
    renderState.matchLabel = `@${handleA} (${eloA}) vs @${handleB} (${eloB})`;
    renderState.labels = {
      p1: `@${handleA} [${mt.a?.name ?? "slot"}]`,
      p2: `@${handleB} [${mt.b?.name ?? "slot"}]`,
    };
    renderState.stage = STAGES[mt.stageId] ?? STAGES.datacenter;
    const hudEl = document.getElementById("match-hud");
    if (hudEl) hudEl.textContent = renderState.matchLabel;
    setStat("stat-p1", `@${mt.a?.handle ?? "p1"} · ${mt.a?.elo ?? "?"}`);
    setStat("stat-p2", `@${mt.b?.handle ?? "p2"} · ${mt.b?.elo ?? "?"}`);
    setStat("stat-stage", mt.stageId ?? "datacenter");
    setStat("stat-result", "in progress");
    resetPlayback();
  } else if (m.type === "frames") {
    if (!Array.isArray(m.frames)) return;
    appendFrames(m.frames);
    if (frameBuf.length > MAX_BUFFER_FRAMES) trimPlaybackToLiveWindow();
    // Start playback once the jitter buffer is primed.
    if (!playbackStarted && frameBuf.length >= JITTER_BUFFER_FRAMES) primePlayback();
    updateBufferStat(playbackStarted ? "live" : "priming");
  } else if (m.type === "matchEnd") {
    matchActive = false;
    computeClient?.setMatchPhase("intermission");
    const { a, b } = renderState.handles;
    const eloDelta = m.eloAfter && m.eloBefore
      ? ` · Δ @${a} ${formatDelta(m.eloAfter[0] - m.eloBefore[0])} · @${b} ${formatDelta(m.eloAfter[1] - m.eloBefore[1])}`
      : "";
    let outcome;
    if (m.winner === -1) outcome = "draw";
    else if (m.winner === 0) outcome = `@${a} beat @${b}`;
    else outcome = `@${b} beat @${a}`;
    renderState.matchLabel = `${outcome}${eloDelta}`;
    const hudEl = document.getElementById("match-hud");
    if (hudEl) hudEl.textContent = renderState.matchLabel;
    const resEl = document.getElementById("stat-result");
    if (resEl) {
      resEl.textContent = m.winner === -1 ? "draw" : m.winner === 0 ? `@${a} won` : `@${b} won`;
      resEl.className = m.winner === 0 ? "p1-accent" : m.winner === 1 ? "p2-accent" : "";
    }
  }
}

function appendFrames(frames) {
  const lastTick = frameBuf.length ? frameBuf[frameBuf.length - 1].tick : -Infinity;
  for (const f of frames) {
    if (typeof f?.tick !== "number") continue;
    if (f.tick <= lastTick) continue;
    frameBuf.push(f);
  }
}

// Compute the frame to display at this RAF tick.
// Wall-clock paced against the canonical SIM_HZ; interpolates positions
// between the two adjacent buffered frames that bracket the target tick.
function currentFrame() {
  if (!playbackStarted) return null;
  if (frameBuf.length === 0) {
    pausePlayback();
    updateBufferStat("empty");
    return null;
  }
  const elapsedMs = performance.now() - baselineWallMs;
  const targetTick = baselineTick + (elapsedMs * SIM_HZ) / 1000;

  // Advance head past consumed frames, keeping at least 1 frame for
  // the "stall — hold last" fallback.
  while (frameBuf.length > 1 && frameBuf[1].tick <= targetTick) frameBuf.shift();

  const a = frameBuf[0];
  const b = frameBuf[1];
  if (!b) {
    // Only one frame buffered — stream stalled briefly. Hold last frame
    // and keep targetTick pinned near it. If wall time keeps advancing
    // while the buffer is empty, the next packet would otherwise be
    // consumed immediately, producing the visible "skip" stutter.
    baselineWallMs = performance.now();
    baselineTick = a.tick;
    updateBufferStat("refilling");
    return a;
  }
  if (targetTick >= b.tick) return b;

  const span = (b.tick - a.tick) || 1;
  const raw = (targetTick - a.tick) / span;
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  return interpolateFrame(a, b, t);
}

function lerp(a, b, t) { return a + (b - a) * t; }

function interpFighter(a, b, t) {
  const snap = Math.abs(b.x - a.x) > TELEPORT_PX || Math.abs(b.y - a.y) > TELEPORT_PX;
  return {
    ...b,                         // discrete state (facing, dead, swipeT, diveT) from newer frame
    x: snap ? b.x : lerp(a.x, b.x, t),
    y: snap ? b.y : lerp(a.y, b.y, t),
  };
}

function interpolateFrame(a, b, t) {
  const out = { ...b };
  out.p0 = interpFighter(a.p0, b.p0, t);
  out.p1 = interpFighter(a.p1, b.p1, t);
  if (b.token?.exists && a.token?.exists) {
    out.token = { ...b.token, x: lerp(a.token.x, b.token.x, t), y: lerp(a.token.y, b.token.y, t) };
  }
  return out;
}

async function refreshLeaderboard() {
  try {
    const rows = await leaderboard(10);
    leaderboardEl.innerHTML = `
      <table>
        ${rows.map((r, i) => `
          <tr>
            <td class="rank">${i + 1}</td>
            <td class="handle" title="@${escapeHtml(r.handle)}">@${escapeHtml(r.handle)}</td>
            <td class="elo">${r.eloAggregate}</td>
            <td class="wl">${r.wins}-${r.losses}</td>
          </tr>`).join("")}
      </table>`;
  } catch (e) {
    leaderboardEl.textContent = `offline — ${e.message}`;
  }
}

function formatDelta(n) {
  const r = Math.round(n);
  return r > 0 ? `+${r}` : `${r}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function loop() {
  if (!running) return;
  const frameStart = performance.now();
  const f = signalState ? null : currentFrame();
  if (signalState) {
    drawSignalScreen(signalState.title, signalState.subtitle);
  } else if (f) {
    drawFrame(ctx, renderState.stage, f, renderState.labels);
  } else if (matchActive) {
    drawSignalScreen("SIGNAL DEGRADED", "Holding the last verified frame.");
  } else {
    // Between matches: idle bg + countdown.
    ctx.fillStyle = cssColor("--arena-idle-bg", "black"); ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = cssColor("--arena-idle-text", "gray");
    ctx.textAlign = "center";
    const secs = waitSecondsLeft();
    if (secs !== null) {
      ctx.font = "600 22px -apple-system, system-ui";
      ctx.fillText(waitState.reason === "no-pair" && !waitState.nextMatch ? "no eligible pair — retry in" : "next match in", W / 2, H / 2 - 68);
      if (waitState.nextMatch) {
        const next = waitState.nextMatch;
        const a = next.a?.handle ?? "p1";
        const b = next.b?.handle ?? "p2";
        const delta = typeof next.eloDelta === "number" ? ` · Δ${Math.round(next.eloDelta)}` : "";
        ctx.fillStyle = cssColor("--ui-text", "#f4f4ff");
        ctx.font = "700 26px -apple-system, system-ui";
        ctx.fillText(`@${a} vs @${b}${delta}`, W / 2, H / 2 - 36);
        if (next.stageId) {
          ctx.fillStyle = cssColor("--ui-purple", "#a855f7");
          ctx.font = "600 16px ui-monospace, Menlo, monospace";
          ctx.fillText(`STAGE · ${next.stageId.toUpperCase()}`, W / 2, H / 2 - 10);
        }
      }
      ctx.fillStyle = cssColor("--ui-blue", "#3b82f6");
      ctx.font = "700 56px ui-monospace, Menlo, monospace";
      ctx.fillText(`${secs}s`, W / 2, H / 2 + 48);
    } else {
      ctx.font = "600 22px -apple-system, system-ui";
      ctx.fillText("waiting for next match…", W / 2, H / 2);
    }
  }
  computeClient?.recordFrame(performance.now() - frameStart);
  updateWaitStat();
  rafId = requestAnimationFrame(loop);
}

// Procedural 2D noise scramble. Lo-res offscreen buffer painted with
// blue/purple/red/white static that we upscale (no smoothing) into the
// main canvas. Regenerated every 3 frames so it shimmers without
// burning CPU during a real stall.
const NOISE_W = 160;
const NOISE_H = 90;
function drawSignalScreen(title, subtitle = "") {
  drawNoiseScramble(ctx);
  ctx.fillStyle = "rgba(4,4,4,0.64)";
  ctx.fillRect(0, H / 2 - 70, W, 118);
  ctx.textAlign = "center";
  ctx.fillStyle = cssColor("--ui-purple-bright", "#c084fc");
  ctx.font = "800 25px -apple-system, system-ui";
  ctx.fillText(title, W / 2, H / 2 - 16);
  if (subtitle) {
    ctx.fillStyle = cssColor("--arena-idle-text", "#cbd5e1");
    ctx.font = "600 15px -apple-system, system-ui";
    ctx.fillText(subtitle, W / 2, H / 2 + 18);
  }
}

function drawNoiseScramble(destCtx) {
  if (!noiseCanvas) {
    noiseCanvas = document.createElement("canvas");
    noiseCanvas.width = NOISE_W;
    noiseCanvas.height = NOISE_H;
    noiseCtx = noiseCanvas.getContext("2d", { alpha: false });
  }
  if ((noiseFrameCounter++ % 3) === 0) {
    const img = noiseCtx.createImageData(NOISE_W, NOISE_H);
    const d = img.data;
    const palette = [
      [10, 10, 18],      // near-black
      [10, 10, 18],
      [10, 10, 18],
      [29, 78, 216],     // blue-ink
      [59, 130, 246],    // blue
      [124, 58, 237],    // purple-ink
      [168, 85, 247],    // purple
      [185, 28, 28],     // red-ink (sparingly)
      [244, 244, 255],   // white (rare)
    ];
    for (let i = 0; i < d.length; i += 4) {
      const c = palette[(Math.random() * palette.length) | 0];
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    }
    noiseCtx.putImageData(img, 0, 0);
  }
  const prevSmoothing = destCtx.imageSmoothingEnabled;
  destCtx.imageSmoothingEnabled = false;
  destCtx.drawImage(noiseCanvas, 0, 0, NOISE_W, NOISE_H, 0, 0, W, H);
  destCtx.imageSmoothingEnabled = prevSmoothing;
}

function waitSecondsLeft() {
  if (!waitState) return null;
  const remaining = waitState.nextAttemptAt - (Date.now() - waitState.skewMs);
  return Math.max(0, Math.ceil(remaining / 1000));
}

function updateWaitStat() {
  const el = document.getElementById("stat-countdown");
  if (!el) return;
  const secs = waitSecondsLeft();
  if (secs === null) {
    el.textContent = "live";
  } else if (waitState.nextMatch) {
    el.textContent = `${secs}s · ${nextMatchLabel(waitState.nextMatch)}`;
  } else {
    el.textContent = `${secs}s (${waitState.reason})`;
  }
}

function nextMatchLabel(next) {
  const a = next?.a?.handle ?? "p1";
  const b = next?.b?.handle ?? "p2";
  const delta = typeof next?.eloDelta === "number" ? ` · Δ${Math.round(next.eloDelta)}` : "";
  const stage = next?.stageId ? ` · ${next.stageId}` : "";
  return `@${a} vs @${b}${delta}${stage}`;
}

function cssColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function setStat(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function signalFailureForClose(ev) {
  const reason = String(ev.reason || "").toLowerCase();
  if (ev.code === 1013 || reason.includes("capacity")) {
    return {
      title: "SPECTATOR CAPACITY EXHAUSTED",
      subtitle: "The relay chose execution over applause. Try again shortly.",
      stat: "capacity",
      retryMs: 30000,
    };
  }
  if (ev.code === 1003 || reason.includes("protocol")) {
    return {
      title: "BROADCAST REJECTED",
      subtitle: "The signal arrived malformed. The client declined to hallucinate.",
      stat: "malformed",
      retryMs: 15000,
    };
  }
  return {
    title: "BROADCAST LOST",
    subtitle: "Reconnecting to the arena relay.",
    stat: "reconnecting",
    retryMs: 3000,
  };
}

function setSignalFailure(title, subtitle, stat, retryMs) {
  signalState = { title, subtitle, stat, retryMs };
  resetPlayback();
  setStat("stat-ws", stat);
  statusCb(`${stat} — retry in ${Math.ceil(retryMs / 1000)}s`);
  appendStreamLine(`${title} — ${subtitle}`);
  scheduleReconnect(retryMs);
}

function scheduleReconnect(delayMs) {
  if (!running) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delayMs);
}

function updateBufferStat(state = "live") {
  const n = frameBuf.length;
  if (state === "idle") return setStat("stat-buf", "idle");
  if (state === "empty") return setStat("stat-buf", "0f");
  return setStat("stat-buf", `${n}f`);
}

const STREAM_LOG_MAX = 8;
function logStreamEvent(m) {
  const t = new Date().toLocaleTimeString();
  let extra = "";
  if (m.type === "matchStart" || m.type === "matchInProgress") {
    const mt = m.match || m;
    extra = `  @${mt.a?.handle ?? "?"} vs @${mt.b?.handle ?? "?"} · ${mt.stageId ?? "stage"}`;
  } else if (m.type === "matchEnd") {
    const { a, b } = renderState.handles;
    const w = m.winner === -1 ? "draw" : m.winner === 0 ? `@${a} beat @${b}` : `@${b} beat @${a}`;
    const e = m.eloAfter && m.eloBefore
      ? `  Δ[${formatDelta(m.eloAfter[0] - m.eloBefore[0])},${formatDelta(m.eloAfter[1] - m.eloBefore[1])}]`
      : "";
    extra = `  ${w}${e}`;
  } else if (m.type === "waiting") {
    const next = m.nextMatch ? ` · ${nextMatchLabel(m.nextMatch)}` : "";
    extra = `  ${m.reason} · next ~${Math.max(0, Math.round((m.nextAttemptAt - (m.serverNow ?? Date.now())) / 1000))}s${next}`;
  }
  appendStreamLine(`[${t}] ${m.type}${extra}`);
}

function appendStreamLine(text) {
  const logEl = document.getElementById("stream-log");
  if (!logEl) return;
  const row = document.createElement("div");
  row.textContent = text;
  logEl.prepend(row);
  while (logEl.childElementCount > STREAM_LOG_MAX) logEl.lastElementChild.remove();
}
