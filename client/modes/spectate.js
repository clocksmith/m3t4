// Spectate mode. Connects to /ws, renders server-streamed trace frames.
// No client-side sim — the whole point is config privacy.

import { WS_ORIGIN, leaderboard } from "../lib/api.js";
import { STAGES } from "../sim/index.js";
import { setupCanvas, drawFrame, W, H } from "../lib/render.js";

let ws = null;
let renderState = {
  matchLabel: "waiting…",
  frame: null,
  stage: STAGES.datacenter,
  labels: { p1: "", p2: "" },
  lastEvent: null,
};
let running = false;
let lbTimer = null;
let leaderboardEl = null;
let canvas = null;
let ctx = null;
let rafId = 0;
let statusCb = () => {};

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
  } else if (m.type === "frames") {
    // Take the LAST frame in the chunk to render
    const last = m.frames?.[m.frames.length - 1];
    if (last) renderState.frame = last;
  } else if (m.type === "matchEnd") {
    renderState.matchLabel = `${renderState.matchLabel}  →  winner ${m.winner === -1 ? "draw" : m.winner === 0 ? "P1" : "P2"}`;
    const hudEl = document.getElementById("match-hud");
    if (hudEl) hudEl.textContent = renderState.matchLabel;
  }
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
  if (renderState.frame) {
    drawFrame(ctx, renderState.stage, renderState.frame, renderState.labels);
  } else {
    ctx.fillStyle = "#08080e"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#667"; ctx.font = "600 22px -apple-system, system-ui"; ctx.textAlign = "center";
    ctx.fillText("waiting for next match…", W / 2, H / 2);
  }
  rafId = requestAnimationFrame(loop);
}
