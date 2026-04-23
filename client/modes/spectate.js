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
import { createFrameRenderer, W, H } from "../render/index.js";
import { getComputeClient } from "../lib/compute.js";
import { escapeHtml } from "../ui/html.js";
import { contextCardHtml, pageHeaderHtml } from "../ui/shell.js";
import { statListHtml } from "../ui/stats.js";
import gameCopy from "../content/game-copy.v1.json" with { type: "json" };
import rosterCatalog from "../content/roster-catalog.v1.json" with { type: "json" };

const SIM_HZ = 120;                // canonical sim rate
const JITTER_BUFFER_FRAMES = 24;   // ~8 chunks at STRIDE=3 -> ~200ms
const LIVE_BUFFER_FRAMES = 36;     // target after trimming -> ~300ms
const MAX_BUFFER_FRAMES = 90;      // hard cap -> ~750ms
const TELEPORT_PX = 200;           // position jump above this snaps instead of lerps
const COUNTDOWN_PORTRAIT_ACCENTS = [
  { accentVar: "--arena-p1", fallback: "#6ee7b7" },
  { accentVar: "--arena-p2", fallback: "#fb923c" },
];
const BODY_VARIANTS = {
  sama: "capacity_mystic",
  darrius: "policy_undertaker",
  demis: "quiet_solver",
  mark: "sunlit_operator",
};
const BODY_PORTRAIT_SHEETS = {
  sama: "assets/chars/sama/monastic_infra/portraits/sheet.png",
  darrius: "assets/chars/darrius/legal_department_midnight/portraits/sheet.png",
  demis: "assets/chars/demis/chalk_and_static/portraits/sheet.png",
  mark: "assets/chars/mark/wellness_berserker/portraits/sheet.png",
};
const WEAPON_SHEETS = Object.fromEntries(
  rosterCatalog.bodies.map((body) => [
    body,
    Object.fromEntries((rosterCatalog.weapons?.[body] ?? [])
      .filter((weapon) => weapon.available && weapon.asset)
      .map((weapon) => [weapon.id, weapon.asset])),
  ]),
);
const SIDE_BINDINGS = [
  bindingInfo("sama", "capacity_mystic", "worldcoin_orb_flail"),
  bindingInfo("darrius", "policy_undertaker", "rolled_constitution_bat"),
];

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
let renderer = null;
let rendererMountId = 0;
let rafId = 0;
let statusCb = () => {};
let computeClient = null;
let reconnectTimer = null;
const countdownPortraitState = new Map();

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
      ${pageHeaderHtml({ title: "Live", subtitle: "whatever match is happening right now" })}
      ${contextCardHtml({
        className: "live-briefing-card",
        body: `
        <div class="live-briefing-sides">
          ${liveBriefingSideHtml(0)}
          <div class="live-briefing-vs">VS</div>
          ${liveBriefingSideHtml(1)}
        </div>`,
      })}
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
          ${statListHtml([
            { label: "P1", id: "stat-p1", className: "p1-accent" },
            { label: "P2", id: "stat-p2", className: "p2-accent" },
            { label: "stage", id: "stat-stage" },
            { label: "ws", id: "stat-ws", value: "connecting…" },
            { label: "next match", id: "stat-countdown" },
            { label: "buffer", id: "stat-buf" },
            { label: "last result", id: "stat-result" },
            { label: "receipt", id: "stat-verify" },
          ])}
        </aside>
      </div>
      <div class="panel">
        <h3>Stream</h3>
        <div id="stream-log" class="tight stream-log"></div>
      </div>
    </div>`;
  canvas = root.querySelector("#stage-canvas");
  leaderboardEl = root.querySelector("#leaderboard");
  const rendererId = ++rendererMountId;
  void attachRenderer(rendererId, canvas);
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
  rendererMountId++;
  running = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  if (lbTimer) { clearInterval(lbTimer); lbTimer = null; }
  if (rafId) cancelAnimationFrame(rafId);
  renderer?.destroy();
  renderer = null;
  ctx = null;
  resetPlayback();
  computeClient = null;
}

async function attachRenderer(rendererId, targetCanvas) {
  let nextRenderer = null;
  try {
    nextRenderer = await createFrameRenderer(targetCanvas);
  } catch (error) {
    console.error("[m3t4] failed to initialize live renderer", error);
    return;
  }
  if (rendererId !== rendererMountId || !canvas) {
    nextRenderer.destroy();
    return;
  }
  renderer?.destroy();
  renderer = nextRenderer;
  canvas = nextRenderer.canvas ?? targetCanvas;
  ctx = nextRenderer.ctx;
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
      updateLiveBriefing(next);
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
      nameplates: [`@${handleA}`, `@${handleB}`],
      cosmetics: [presentationCosmeticsForCompetitor(mt.a, 0), presentationCosmeticsForCompetitor(mt.b, 1)],
    };
    renderState.stage = STAGES[mt.stageId] ?? STAGES.datacenter;
    const hudEl = document.getElementById("match-hud");
    if (hudEl) hudEl.textContent = renderState.matchLabel;
    setStat("stat-p1", `@${mt.a?.handle ?? "p1"} · ${mt.a?.elo ?? "?"}`);
    setStat("stat-p2", `@${mt.b?.handle ?? "p2"} · ${mt.b?.elo ?? "?"}`);
    setStat("stat-stage", mt.stageId ?? "datacenter");
    setStat("stat-result", "in progress");
    setStat("stat-verify", "pending");
    updateLiveBriefing(mt);
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
    if (m.matchId) void updateReplayBadge(m.matchId);
  }
}

async function updateReplayBadge(matchId) {
  const el = document.getElementById("stat-verify");
  if (!el) return;
  const origin = String(window.__M3T4_COMPUTE_LAB_ORIGIN__ || "").replace(/\/+$/, "");
  if (!origin || window.__M3T4_FEATURES__?.computeLiveBadges !== true) {
    el.textContent = "archived";
    el.className = "";
    return;
  }
  el.textContent = "checking";
  el.className = "";
  for (const waitMs of [0, 5000, 15000, 30000]) {
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (!running) return;
    try {
      const res = await fetch(`${origin}/compute/public/replay-badges/${encodeURIComponent(matchId)}`, { cache: "no-store" });
      if (!res.ok) continue;
      const badge = await res.json();
      el.textContent = `verified ${badge.agreedReceipts}/${badge.requiredReceipts}`;
      el.className = "ok";
      el.title = [badge.rulesHash ? `rules ${badge.rulesHash}` : "", badge.stageHash ? `stage ${badge.stageHash}` : ""]
        .filter(Boolean)
        .join(" · ");
      return;
    } catch {
      // Volunteer verification is advisory; Live should never wait on it.
    }
  }
  el.textContent = "queued";
  el.className = "";
}

function bindingInfo(characterKey, characterVariant, weaponKey) {
  const character = gameCopy.characters?.[characterKey]?.[characterVariant] ?? {};
  const weapon = gameCopy.weapons?.[characterKey]?.[weaponKey] ?? {};
  return {
    body: characterKey,
    weaponKey,
    characterName: character.name ?? characterKey,
    characterLabel: character.label ?? characterVariant,
    weaponName: weapon.name ?? weaponKey,
    portraitStyle: briefingPortraitStyle(characterKey),
    weaponStyle: briefingWeaponStyle(characterKey, weaponKey),
  };
}

function liveBriefingSideHtml(side) {
  const binding = SIDE_BINDINGS[side];
  return `
    <article class="live-briefing-side is-p${side + 1}">
      <div class="live-briefing-binding" id="brief-p${side + 1}-binding">${liveBindingHtml(binding, side, `P${side + 1} · @${side === 0 ? "p1" : "p2"} · slot · ?`)}</div>
    </article>`;
}

function updateLiveBriefing(match) {
  updateBriefingSide(0, match?.a);
  updateBriefingSide(1, match?.b);
}

function updateBriefingSide(side, data) {
  const handle = data?.handle ?? (side === 0 ? "p1" : "p2");
  const name = data?.name ?? "slot";
  const elo = data?.elo ?? "?";
  const binding = bindingForCompetitor(data, side);
  const bindingEl = document.getElementById(`brief-p${side + 1}-binding`);
  if (bindingEl) bindingEl.innerHTML = liveBindingHtml(binding, side, `P${side + 1} · @${handle} · ${name} · ${elo}`);
}

function bindingForCompetitor(data, side) {
  const cosmetics = presentationCosmeticsForCompetitor(data, side);
  return bindingInfo(cosmetics.body, BODY_VARIANTS[cosmetics.body] ?? cosmetics.body, cosmetics.weapon);
}

function liveBindingHtml(binding, side = 0, identity = `P${side + 1}`) {
  return `
    <span class="live-briefing-weapon-tile${binding.weaponStyle ? "" : " is-missing"}"${binding.weaponStyle ? ` style="${binding.weaponStyle}"` : ""} aria-hidden="true"></span>
    <span class="live-briefing-copy">
      <strong class="live-briefing-identity" id="brief-p${side + 1}-identity">${escapeHtml(identity)}</strong>
      <span class="live-briefing-character">${escapeHtml(binding.characterName)} · ${escapeHtml(binding.characterLabel)}</span>
      <span class="live-briefing-weapon-name">${escapeHtml(binding.weaponName)}</span>
    </span>
    <span class="live-briefing-portrait${binding.portraitStyle ? "" : " is-missing"}"${binding.portraitStyle ? ` style="${binding.portraitStyle}"` : ""} aria-hidden="true"></span>`;
}

function briefingPortraitStyle(body) {
  const url = BODY_PORTRAIT_SHEETS[body];
  return url ? spriteSheetStyle({ url, cols: 2, rows: 2, cell: 3 }) : "";
}

function briefingWeaponStyle(body, weaponKey) {
  const asset = WEAPON_SHEETS[body]?.[weaponKey];
  if (!asset?.url) return "";
  const cols = Math.max(1, Number(asset.cols ?? 1) || 1);
  return spriteSheetStyle({
    url: asset.url,
    cols,
    rows: briefingWeaponRows(body, asset, cols),
    cell: Math.max(0, Number(asset.cell ?? 0) || 0),
  });
}

function briefingWeaponRows(body, asset, cols) {
  const maxCell = (rosterCatalog.weapons?.[body] ?? [])
    .filter((weapon) => weapon.available && weapon.asset?.url === asset.url)
    .reduce((max, weapon) => Math.max(max, Number(weapon.asset?.cell ?? 0) || 0), Number(asset.cell ?? 0) || 0);
  return Math.max(1, Math.floor(maxCell / cols) + 1);
}

function spriteSheetStyle({ url, cols = 1, rows = 1, cell = 0 }) {
  const col = cols > 0 ? cell % cols : 0;
  const row = cols > 0 ? Math.floor(cell / cols) : 0;
  const x = cols > 1 ? (col / (cols - 1)) * 100 : 0;
  const y = rows > 1 ? (row / (rows - 1)) * 100 : 0;
  return [
    `background-image:url('${escapeHtml(url)}')`,
    `background-size:${cols * 100}% ${rows * 100}%`,
    `background-position:${x}% ${y}%`,
  ].join(";");
}

function fallbackCosmeticsForSide(side) {
  return side === 0
    ? { body: "sama", weapon: "worldcoin_orb_flail" }
    : { body: "darrius", weapon: "rolled_constitution_bat" };
}

function presentationCosmeticsForCompetitor(data, side) {
  const fallback = fallbackCosmeticsForSide(side);
  const body = BODY_VARIANTS[data?.cosmetics?.body] ? data.cosmetics.body : fallback.body;
  return {
    body,
    weapon: highestUnlockedWeapon(body, data?.elo, data?.cosmetics?.weapon ?? fallback.weapon),
  };
}

function highestUnlockedWeapon(body, elo, preferredWeapon) {
  const unlockElo = Math.max(1000, Number(elo) || 1000);
  const options = (rosterCatalog.weapons?.[body] ?? []).filter((weapon) => weapon.available);
  const unlocked = options.filter((weapon) => Number(weapon.minElo ?? 0) <= unlockElo);
  if (!unlocked.length) return preferredWeapon;
  const maxMinElo = Math.max(...unlocked.map((weapon) => Number(weapon.minElo ?? 0)));
  if (preferredWeapon && unlocked.some((weapon) => weapon.id === preferredWeapon && Number(weapon.minElo ?? 0) === maxMinElo)) {
    return preferredWeapon;
  }
  for (let i = unlocked.length - 1; i >= 0; i -= 1) {
    if (Number(unlocked[i].minElo ?? 0) === maxMinElo) return unlocked[i].id;
  }
  return unlocked[unlocked.length - 1]?.id ?? preferredWeapon;
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

function loop() {
  if (!running) return;
  if (!renderer || !ctx) {
    rafId = requestAnimationFrame(loop);
    return;
  }
  const frameStart = performance.now();
  const f = signalState ? null : currentFrame();
  if (signalState) {
    drawSignalScreen(signalState.title, signalState.subtitle);
    renderer.present2D?.();
  } else if (f) {
    renderer?.drawFrame(renderState.stage, f, renderState.labels);
  } else if (matchActive) {
    drawSignalScreen("SIGNAL DEGRADED", "Holding the last verified frame.");
    renderer.present2D?.();
  } else {
    drawWaitingScreen();
    renderer.present2D?.();
  }
  computeClient?.recordFrame(performance.now() - frameStart);
  updateWaitStat();
  rafId = requestAnimationFrame(loop);
}

function drawWaitingScreen() {
  const secs = waitSecondsLeft();
  ctx.fillStyle = cssColor("--arena-idle-bg", "#08080e");
  ctx.fillRect(0, 0, W, H);
  drawCountdownBackdrop();

  if (secs === null) {
    ctx.textAlign = "center";
    ctx.fillStyle = cssColor("--arena-idle-text", "#667");
    ctx.font = "600 22px -apple-system, system-ui";
    ctx.fillText("waiting for next match…", W / 2, H / 2);
    return;
  }

  const hasPair = !!waitState?.nextMatch;
  if (hasPair) {
    drawCountdownPortrait(0, 168, 170, 245, 368, waitState.nextMatch.a);
    drawCountdownPortrait(1, W - 413, 170, 245, 368, waitState.nextMatch.b);
  }

  ctx.textAlign = "center";
  ctx.fillStyle = cssColor("--arena-idle-text", "#667");
  ctx.font = "700 16px ui-monospace, Menlo, monospace";
  ctx.fillText(hasPair ? "NEXT EXECUTION WINDOW" : "NO ELIGIBLE PAIR", W / 2, 204);

  if (hasPair) {
    const next = waitState.nextMatch;
    const delta = typeof next.eloDelta === "number" ? `DELTA ${Math.round(next.eloDelta)}` : "DELTA ?";
    ctx.fillStyle = cssColor("--ui-purple-bright", "#c084fc");
    ctx.font = "900 54px -apple-system, system-ui";
    ctx.fillText("VS", W / 2, 318);
    ctx.fillStyle = cssColor("--ui-text", "#f4f4ff");
    drawCenteredFit(`@${next.a?.handle ?? "p1"} / @${next.b?.handle ?? "p2"}`, W / 2, 370, 390, 700, 24);
    ctx.fillStyle = cssColor("--arena-idle-text", "#99a");
    ctx.font = "700 14px ui-monospace, Menlo, monospace";
    ctx.fillText(`${next.stageId ?? "datacenter"} · ${delta}`, W / 2, 398);
  } else {
    ctx.fillStyle = cssColor("--ui-text", "#f4f4ff");
    ctx.font = "800 29px -apple-system, system-ui";
    ctx.fillText("candidate pool refused reconciliation", W / 2, 328);
  }

  const pulse = 1 + Math.sin(performance.now() / 180) * 0.035;
  ctx.save();
  ctx.translate(W / 2, 500);
  ctx.scale(pulse, pulse);
  ctx.fillStyle = cssColor("--ui-blue", "#3b82f6");
  ctx.font = "900 72px ui-monospace, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.fillText(`${secs}s`, 0, 0);
  ctx.restore();

  ctx.fillStyle = cssColor("--arena-idle-text", "#889");
  ctx.font = "600 15px -apple-system, system-ui";
  ctx.fillText(hasPair ? "server has selected the next bodies" : `${waitState?.reason ?? "waiting"} — retry pending`, W / 2, 536);
}

function drawCountdownBackdrop() {
  const g = ctx.createRadialGradient(W / 2, H / 2, 70, W / 2, H / 2, 620);
  g.addColorStop(0, "rgba(168,85,247,0.18)");
  g.addColorStop(0.45, "rgba(59,130,246,0.08)");
  g.addColorStop(1, "rgba(8,8,14,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(192,132,252,0.18)";
  ctx.lineWidth = 2;
  for (let x = -W; x < W * 2; x += 96) {
    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(x + 420, 0);
    ctx.stroke();
  }
}

function drawCountdownPortrait(side, x, y, w, h, meta) {
  const kit = countdownPortraitKit(meta, side);
  const accent = cssColor(kit.accentVar, kit.fallback);
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.52)";
  ctx.fillRect(x - 14, y - 14, w + 28, h + 28);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.strokeRect(x - 14, y - 14, w + 28, h + 28);

  const img = loadCountdownImage(kit);
  if (img) {
    ctx.imageSmoothingEnabled = false;
    const cell = kit.cell ?? 0;
    const cellW = kit.cellW ?? img.width;
    const cellH = kit.cellH ?? img.height;
    const cols = Math.max(1, Math.floor(img.width / cellW));
    const sx = (cell % cols) * cellW;
    const sy = Math.floor(cell / cols) * cellH;
    const drawSize = Math.min(w, h);
    ctx.drawImage(img, sx, sy, cellW, cellH, x + (w - drawSize) / 2, y + (h - drawSize) / 2, drawSize, drawSize);
  } else {
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = accent;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.fillRect(x - 14, y + h - 54, w + 28, 68);
  ctx.fillStyle = accent;
  ctx.font = "800 15px ui-monospace, Menlo, monospace";
  ctx.textAlign = "left";
  ctx.fillText(side === 0 ? "P1" : "P2", x, y + h - 28);
  ctx.fillStyle = cssColor("--ui-text", "#f4f4ff");
  drawLeftFit(`@${meta?.handle ?? (side === 0 ? "p1" : "p2")}`, x + 36, y + h - 28, w - 42, 800, 17);
  ctx.fillStyle = cssColor("--arena-idle-text", "#99a");
  drawLeftFit(`${meta?.name ?? "slot"} · ${meta?.elo ?? "?"}`, x, y + h - 8, w, 700, 13);
  ctx.restore();
}

function countdownPortraitKit(meta, side) {
  const cosmetics = presentationCosmeticsForCompetitor(meta, side);
  const body = cosmetics.body;
  const accent = COUNTDOWN_PORTRAIT_ACCENTS[side] ?? COUNTDOWN_PORTRAIT_ACCENTS[0];
  return {
    url: BODY_PORTRAIT_SHEETS[body] ?? BODY_PORTRAIT_SHEETS[fallbackCosmeticsForSide(side).body],
    cell: 3,
    cellW: 96,
    cellH: 96,
    accentVar: accent.accentVar,
    fallback: accent.fallback,
  };
}

function loadCountdownImage(kit) {
  let state = countdownPortraitState.get(kit.url);
  if (!state) {
    state = { image: null, loaded: false, failed: false };
    countdownPortraitState.set(kit.url, state);
  }
  if (state.failed) return null;
  if (state.loaded) return state.image;
  if (!state.image && typeof Image !== "undefined") {
    const img = new Image();
    img.onload = () => { state.loaded = true; };
    img.onerror = () => { state.failed = true; };
    img.src = kit.url;
    state.image = img;
  }
  return state.loaded ? state.image : null;
}

function drawCenteredFit(text, x, y, maxWidth, weight, maxPx) {
  const size = fitTextSize(text, maxWidth, weight, maxPx);
  ctx.font = `${weight} ${size}px -apple-system, system-ui`;
  ctx.textAlign = "center";
  ctx.fillText(text, x, y);
}

function drawLeftFit(text, x, y, maxWidth, weight, maxPx) {
  const size = fitTextSize(text, maxWidth, weight, maxPx);
  ctx.font = `${weight} ${size}px -apple-system, system-ui`;
  ctx.textAlign = "left";
  ctx.fillText(text, x, y);
}

function fitTextSize(text, maxWidth, weight, maxPx) {
  let size = maxPx;
  while (size > 10) {
    ctx.font = `${weight} ${size}px -apple-system, system-ui`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 1;
  }
  return size;
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
