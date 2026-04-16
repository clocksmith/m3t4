// Spectate mode. Connects to /ws, renders server-streamed trace frames.
// No client-side sim — the whole point is config privacy.
//
// Playback: frames arrive in chunks (server STRIDE=3 sim frames per ~25ms).
// We buffer them in a FIFO and play back against a wall-clock baseline at
// the canonical sim rate (120Hz), interpolating fighter/token positions
// between adjacent frames on every RAF. This smooths:
//   - the 3:2 pulldown jank of 40Hz source on a 60Hz display
//   - network jitter (via ~50ms jitter buffer before playback starts;
//     bursts past MAX_BUFFER_FRAMES are trimmed back to the live window
//     so latency can't grow unbounded after a stall or tab background)

import { WS_ORIGIN, leaderboard } from "../lib/api.js";
import { STAGES } from "../sim/index.js";
import { setupCanvas, drawFrame, W, H } from "../lib/render.js";

const SIM_HZ = 120;                // canonical sim rate
const JITTER_BUFFER_FRAMES = 6;    // ~2 chunks at STRIDE=3 → ~50ms
const MAX_BUFFER_FRAMES = JITTER_BUFFER_FRAMES * 2;
const TELEPORT_PX = 200;           // position jump above this snaps instead of lerps

let ws = null;
let renderState = {
  matchLabel: "waiting…",
  stage: STAGES.datacenter,
  labels: { p1: "", p2: "" },
};
let running = false;
let lbTimer = null;
let leaderboardEl = null;
let canvas = null;
let ctx = null;
let rafId = 0;
let statusCb = () => {};

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
  frameBuf = frameBuf.slice(-JITTER_BUFFER_FRAMES);
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
      <div class="grid-2">
        <canvas id="stage-canvas" width="${W}" height="${H}" tabindex="0"></canvas>
        <aside class="panel lb">
          <h3>Leaderboard</h3>
          <div id="leaderboard">loading…</div>
        </aside>
      </div>
      <div class="panel">
        <h3>Stream</h3>
        <div id="stream-log" class="tight" style="max-height:120px; overflow:auto"></div>
      </div>
    </div>`;
  canvas = root.querySelector("#stage-canvas");
  leaderboardEl = root.querySelector("#leaderboard");
  const { ctx: c } = setupCanvas(canvas);
  ctx = c;

  running = true;
  connect();
  refreshLeaderboard();
  lbTimer = setInterval(refreshLeaderboard, 8000);
  loop();
}

export function unmount() {
  running = false;
  if (ws) { try { ws.close(); } catch {} ws = null; }
  if (lbTimer) { clearInterval(lbTimer); lbTimer = null; }
  if (rafId) cancelAnimationFrame(rafId);
  resetPlayback();
}

function connect() {
  try {
    ws = new WebSocket(WS_ORIGIN + "/ws");
  } catch (e) {
    statusCb(`ws: ${e.message}`);
    setTimeout(connect, 3000);
    return;
  }
  ws.onopen = () => statusCb("ws live");
  ws.onclose = () => {
    statusCb("ws disconnected — retry in 3s");
    if (running) setTimeout(connect, 3000);
  };
  ws.onerror = () => { /* handled by onclose */ };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    onEvent(msg);
  };
}

function onEvent(m) {
  const logEl = document.getElementById("stream-log");
  if (logEl) {
    const t = new Date().toLocaleTimeString();
    logEl.innerHTML = `<div>[${t}] ${m.type} ${m.matchId ? m.matchId.slice(0, 8) : ""}</div>` + logEl.innerHTML;
  }
  if (m.type === "matchStart" || m.type === "matchInProgress") {
    const mt = m.match || m;
    renderState.matchLabel = `${mt.a?.handle ?? "?"} (${mt.a?.elo ?? "?"}) vs ${mt.b?.handle ?? "?"} (${mt.b?.elo ?? "?"})`;
    renderState.labels = {
      p1: `@${mt.a?.handle ?? "p1"} [${mt.a?.name ?? "slot"}]`,
      p2: `@${mt.b?.handle ?? "p2"} [${mt.b?.name ?? "slot"}]`,
    };
    renderState.stage = STAGES[mt.stageId] ?? STAGES.datacenter;
    const hudEl = document.getElementById("match-hud");
    if (hudEl) hudEl.textContent = renderState.matchLabel;
    resetPlayback();
  } else if (m.type === "frames") {
    if (!Array.isArray(m.frames)) return;
    for (const f of m.frames) frameBuf.push(f);
    if (frameBuf.length > MAX_BUFFER_FRAMES) trimPlaybackToLiveWindow();
    // Start playback once the jitter buffer is primed.
    if (!playbackStarted && frameBuf.length >= JITTER_BUFFER_FRAMES) primePlayback();
  } else if (m.type === "matchEnd") {
    renderState.matchLabel = `${renderState.matchLabel}  →  winner ${m.winner === -1 ? "draw" : m.winner === 0 ? "P1" : "P2"}`;
    const hudEl = document.getElementById("match-hud");
    if (hudEl) hudEl.textContent = renderState.matchLabel;
  }
}

// Compute the frame to display at this RAF tick.
// Wall-clock paced against the canonical SIM_HZ; interpolates positions
// between the two adjacent buffered frames that bracket the target tick.
function currentFrame() {
  if (!playbackStarted) return null;
  if (frameBuf.length === 0) {
    pausePlayback();
    return null;
  }
  const elapsedMs = performance.now() - baselineWallMs;
  const targetTick = baselineTick + (elapsedMs * SIM_HZ) / 1000;

  // Advance head of buffer, keeping at least 2 frames for interpolation.
  while (frameBuf.length > 2 && frameBuf[1].tick <= targetTick) frameBuf.shift();

  const a = frameBuf[0];
  const b = frameBuf[1];
  const last = frameBuf[frameBuf.length - 1] ?? a;
  if (!b || targetTick >= last.tick) {
    // The wall clock has outrun the received stream. Drop stale frames so
    // the next incoming chunk rebuilds a real jitter buffer before playback.
    frameBuf = [];
    pausePlayback();
    return last;
  }

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
    const rows = await leaderboard(12);
    leaderboardEl.innerHTML = `
      <table>
        ${rows.map((r, i) => `
          <tr>
            <td class="rank">${i + 1}</td>
            <td>@${r.handle}</td>
            <td class="elo">${r.eloAggregate}</td>
            <td class="wl">${r.wins}w ${r.losses}l</td>
          </tr>`).join("")}
      </table>`;
  } catch (e) {
    leaderboardEl.textContent = `offline — ${e.message}`;
  }
}

function loop() {
  if (!running) return;
  const f = currentFrame();
  if (f) {
    drawFrame(ctx, renderState.stage, f, renderState.labels);
  } else {
    ctx.fillStyle = "#08080e"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#667"; ctx.font = "600 22px -apple-system, system-ui"; ctx.textAlign = "center";
    ctx.fillText("waiting for next match…", W / 2, H / 2);
  }
  rafId = requestAnimationFrame(loop);
}
