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

import { WS_ORIGIN, leaderboardPage } from "../lib/api.js";
import { STAGES } from "../lib/public-sim.js";
import { createFrameRenderer, W, H } from "../render/index.js";
import { getComputeClient } from "../lib/compute.js";
import { getAudio, audioEnabledStored } from "../lib/audio.js";
import { escapeHtml } from "../ui/html.js";
import { contextCardHtml, pageHeaderHtml, disclosureHtml } from "../ui/shell.js";
import { statListHtml } from "../ui/stats.js";
import { toggleSwitchHtml } from "../ui/actions.js";
import gameCopy from "../content/game-copy.v1.json" with { type: "json" };
import rosterCatalog from "../content/roster-catalog.v1.json" with { type: "json" };
import { BODY_VARIANTS, BODY_PORTRAIT_SHEETS } from "../content/character-presentation.js";
import { createSpectateComputeDash } from "./spectate-compute-dash.js";
// When true, the spectator subscribes to a Firestore `matches` collection
// (Functions-driven live matches). When false but `__M3T4_USE_STATIC_MATCHES__`
// is true, the spectator fetches pre-generated matches from /matches/index.json
// and replays them on a wall-clock virtual schedule. Default: static mode if
// neither flag is set (the cheapest path).
function useFirebaseFeed() {
  return Boolean(globalThis.window?.__M3T4_USE_FIREBASE_FEED__);
}
function useStaticFeed() {
  // Default to static if no other feed is selected.
  if (useFirebaseFeed()) return false;
  if (globalThis.window?.__M3T4_USE_STATIC_MATCHES__ === false) return false;
  return true;
}
function useMeshFeed() {
  return useFirebaseFeed() && globalThis.window?.__M3T4_USE_P2P_MESH__ !== false;
}

let matchFeedModulePromise = null;
function matchFeed() {
  if (!matchFeedModulePromise) matchFeedModulePromise = import("../lib/match-feed.js");
  return matchFeedModulePromise;
}

function peerMesh() {
  return import("../lib/peer-mesh.js");
}

function submitApi() {
  return import("../lib/submit.js");
}

const SIM_HZ = 120;                // canonical sim rate
const JITTER_BUFFER_FRAMES = 24;   // ~8 chunks at STRIDE=3 -> ~200ms
const LIVE_BUFFER_FRAMES = 36;     // target after trimming -> ~300ms
const MAX_BUFFER_FRAMES = 90;      // hard cap -> ~750ms
const TELEPORT_PX = 200;           // position jump above this snaps instead of lerps
const LEADERBOARD_PAGE_SIZE = 25;
const COUNTDOWN_PORTRAIT_ACCENTS = [
  { accentVar: "--arena-p1", fallback: "#6ee7b7" },
  { accentVar: "--arena-p2", fallback: "#fb923c" },
];
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
let leaderboardCountEl = null;
let leaderboardMoreBtn = null;
let leaderboardRows = [];
let leaderboardCursor = null;
let leaderboardHasMore = false;
let leaderboardLoading = false;
let leaderboardSource = null;
let leaderboardRequestId = 0;
let botDirectoryEl = null;
let botEventsEl = null;
let botMoreBtn = null;
let botPageCursor = null;
let botRows = [];
let botPageLoading = false;
let canvas = null;

// Four-state cycle for the compute dash PIP. Each state is a single
// number stored in localStorage so the user's preference sticks.
//   1 = battle only (dash unmounted)
//   2 = compute only (canvas suppressed, WS kept)
//   3 = battle primary, compute PIP bottom-right
//   4 = compute primary, battle PIP bottom-right
const DASH_STATE_KEY = "m3t4:spectateComputePip";
const DASH_STATES = [1, 2, 3, 4];
let dashState = 1;
let computeDash = null;
let dashWrapper = null;
let pipWrapper = null;
let stageWrapper = null;
let canvasParked = false;
// Remember bundle info from the most recent matchStart so state flips to
// 2/3/4 after the event still seed the dash correctly.
let pendingMatchStart = null;
let pendingMatchEnd = null;
let dashKeyHandler = null;
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

// Audio edge-detection state. Reset on primePlayback/trim so we don't fire
// cued-up events when jumping to live.
let prevAudioFrame = null;
let audioCharKeys = [null, null];
let audioWeaponKeys = [null, null];
let lastGruntMs = [0, 0];
const GRUNT_THROTTLE_MS = 400;

function resetPlayback() {
  frameBuf = [];
  baselineWallMs = 0;
  baselineTick = 0;
  playbackStarted = false;
  prevAudioFrame = null;
  updateBufferStat("idle");
}

function primePlayback() {
  // Anchor to the newest frame so (re)mounts and trims jump to live
  // instead of replaying the back of the jitter buffer at real time.
  baselineWallMs = performance.now();
  baselineTick = frameBuf[frameBuf.length - 1].tick;
  playbackStarted = true;
  prevAudioFrame = null;
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
  prevAudioFrame = null;
}

export function mount(root, { setStatus }) {
  statusCb = setStatus;
  root.innerHTML = `
    <div class="page">
      ${pageHeaderHtml({ title: "Watch", subtitle: useFirebaseFeed() ? "live arena · server-authoritative matches" : useStaticFeed() ? "match archive · recorded fights, not a live ranked feed" : "arena feed · server playback" })}
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
          <div class="leaderboard-head">
            <h3>Stable leaderboard</h3>
            <span id="leaderboard-count" class="leaderboard-count" aria-live="polite"></span>
          </div>
          <div id="leaderboard" class="leaderboard-scroll" role="region" aria-label="Stable leaderboard rankings" tabindex="0">loading…</div>
          <button id="leaderboard-more" type="button" class="live-bots-more leaderboard-more" hidden>more</button>
          <div class="live-bots-head">
            <h3>Named bots</h3>
            <button id="live-bots-more" type="button" class="live-bots-more">more</button>
          </div>
          <div id="live-bots-list" class="live-bots-list">loading…</div>
        </aside>
        <div class="spectate-center">
          <div id="spectate-stage" class="spectate-stage" data-dash-state="1">
            <div id="spectate-stage-canvas-wrap" class="spectate-stage-canvas-wrap">
              <canvas id="stage-canvas" width="${W}" height="${H}" tabindex="0"></canvas>
            </div>
            <div id="spectate-stage-dash-wrap" class="spectate-stage-dash-wrap" hidden></div>
          </div>
        </div>
        <aside class="panel spectate-stats spectate-side">
          <div class="spectate-stats-head">
            <h3>${useStaticFeed() && !useFirebaseFeed() ? "Archive" : "Live"}</h3>
            <button id="spectate-dash-cycle" type="button" class="spectate-dash-cycle" title="Cycle: battle / compute / both">
              <span class="spectate-dash-cycle-label">view</span>
              <span id="spectate-dash-cycle-state" class="spectate-dash-cycle-state">1</span>
            </button>
          </div>
          ${statListHtml([
            { label: "P1", id: "stat-p1", className: "p1-accent" },
            { label: "P2", id: "stat-p2", className: "p2-accent" },
            { label: "stage", id: "stat-stage" },
            { label: "source", id: "stat-ws", value: "connecting…" },
            { label: "next match", id: "stat-countdown" },
            { label: "buffer", id: "stat-buf" },
            { label: "last result", id: "stat-result" },
            { label: "receipt", id: "stat-verify" },
          ])}
          ${toggleSwitchHtml({ id: "spectate-audio", label: "Audio", title: "Play sound effects and stage music", checked: audioEnabledStored() })}
        </aside>
      </div>
      <div class="spectate-feed-grid">
        <div class="panel">
          <h3>Stream</h3>
          <div id="stream-log" class="tight stream-log"></div>
        </div>
        <div class="panel">
          <h3>New bots</h3>
          <div id="live-bot-events" class="live-bot-events">loading…</div>
        </div>
      </div>
    </div>`;
  canvas = root.querySelector("#stage-canvas");
  leaderboardEl = root.querySelector("#leaderboard");
  leaderboardCountEl = root.querySelector("#leaderboard-count");
  leaderboardMoreBtn = root.querySelector("#leaderboard-more");
  botDirectoryEl = root.querySelector("#live-bots-list");
  botEventsEl = root.querySelector("#live-bot-events");
  botMoreBtn = root.querySelector("#live-bots-more");
  stageWrapper = root.querySelector("#spectate-stage");
  dashWrapper = root.querySelector("#spectate-stage-dash-wrap");
  const rendererId = ++rendererMountId;
  void attachRenderer(rendererId, canvas);
  computeClient = getComputeClient();
  computeClient.setMatchPhase(matchActive ? "active" : "intermission");
  void computeClient.maybeAutoStart().catch(error => {
    console.warn("[m3t4] optional compute unavailable; playback continues", error);
  });

  running = true;
  const audioToggle = root.querySelector("#spectate-audio");
  audioToggle?.addEventListener("change", () => getAudio().setEnabled(audioToggle.checked));
  const cycleBtn = root.querySelector("#spectate-dash-cycle");
  cycleBtn?.addEventListener("click", () => setDashState(nextDashState(dashState)));
  dashKeyHandler = (ev) => {
    if (ev.key !== "v" && ev.key !== "V") return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const target = ev.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
    }
    ev.preventDefault();
    setDashState(nextDashState(dashState));
  };
  window.addEventListener("keydown", dashKeyHandler);
  leaderboardMoreBtn?.addEventListener("click", () => { void refreshLeaderboard({ append: true }); });
  leaderboardEl?.addEventListener("scroll", () => {
    const remaining = leaderboardEl.scrollHeight - leaderboardEl.scrollTop - leaderboardEl.clientHeight;
    if (remaining <= 32) void refreshLeaderboard({ append: true });
  });
  botMoreBtn?.addEventListener("click", () => { void refreshBotDirectory(); });
  dashState = sanitizeStartupDashState(readStoredDashState());
  applyDashState(dashState);
  connect();
  void refreshLeaderboard({ reset: true });
  void refreshBotDirectory({ reset: true });
  void refreshBotEvents();
  lbTimer = setInterval(() => {
    if (leaderboardRows.length <= LEADERBOARD_PAGE_SIZE) void refreshLeaderboard({ reset: true });
    void refreshBotEvents();
  }, 30000);
  loop();
}

function readStoredDashState() {
  try {
    const raw = window.localStorage?.getItem(DASH_STATE_KEY);
    const n = Number(raw);
    return DASH_STATES.includes(n) ? n : 1;
  } catch { return 1; }
}
// On first load, we don't yet know whether a bundle will be supplied.
// If the user persisted state 2 (compute-only) or 4 (compute-primary)
// but no bundle ever arrives (feature flag off, empty match queue,
// relay offline), they'd stare at a blank compute panel with no battle.
// Downgrade those startup states to 3 (battle primary, compute PIP) so
// the canvas is always visible until a user-initiated cycle. The user
// still gets the compute view; it just starts as a corner PIP instead
// of taking the whole stage.
function sanitizeStartupDashState(state) {
  if (state === 2 || state === 4) return 3;
  return state;
}
function persistDashState(state) {
  try { window.localStorage?.setItem(DASH_STATE_KEY, String(state)); } catch {}
}
function nextDashState(current) {
  const idx = DASH_STATES.indexOf(current);
  return DASH_STATES[(idx + 1) % DASH_STATES.length];
}

function setDashState(state) {
  dashState = state;
  persistDashState(state);
  applyDashState(state);
}

function applyDashState(state) {
  if (!stageWrapper) return;
  stageWrapper.dataset.dashState = String(state);
  const cycleStateEl = document.getElementById("spectate-dash-cycle-state");
  if (cycleStateEl) cycleStateEl.textContent = String(state);

  // Lazy-mount the dash only when it's actually going to be visible.
  const dashVisible = state === 2 || state === 3 || state === 4;
  if (dashVisible && !computeDash && dashWrapper) {
    computeDash = createSpectateComputeDash({
      root: dashWrapper,
      computeLabOrigin: window.__M3T4_COMPUTE_LAB_ORIGIN__ ?? "",
    });
    computeDash.on((type) => {
      if (type === "expand-request") {
        // Clicking the PIP promotes it to primary. From state 3
        // (compute-as-PIP) go to state 4 (compute-primary). The user can
        // cycle again to get back to pure battle.
        if (dashState === 3) setDashState(4);
      }
    });
    if (pendingMatchStart) computeDash.onMatchStart(pendingMatchStart);
    if (pendingMatchEnd) computeDash.onMatchEnd(pendingMatchEnd);
  }
  if (!dashVisible && computeDash) {
    computeDash.destroy();
    computeDash = null;
  }

  if (!dashWrapper) return;
  if (!dashVisible) {
    dashWrapper.hidden = true;
    return;
  }
  dashWrapper.hidden = false;
  // Compact purpose-built layout for PIP, full three-column for primary.
  const pipMode = state === 3;
  computeDash?.setDisplay(pipMode ? "pip" : "full");
}

export function unmount() {
  rendererMountId++;
  running = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  if (firebaseFeedStop) { try { firebaseFeedStop(); } catch {} firebaseFeedStop = null; }
  firebaseFeedSeenMatchId = null;
  if (lbTimer) { clearInterval(lbTimer); lbTimer = null; }
  leaderboardRequestId++;
  leaderboardEl = null;
  leaderboardCountEl = null;
  leaderboardMoreBtn = null;
  leaderboardRows = [];
  leaderboardCursor = null;
  leaderboardHasMore = false;
  leaderboardLoading = false;
  leaderboardSource = null;
  botPageCursor = null;
  botRows = [];
  botPageLoading = false;
  botDirectoryEl = null;
  botEventsEl = null;
  botMoreBtn = null;
  if (rafId) cancelAnimationFrame(rafId);
  if (computeDash) { computeDash.destroy(); computeDash = null; }
  if (dashKeyHandler) { window.removeEventListener("keydown", dashKeyHandler); dashKeyHandler = null; }
  stageWrapper = null;
  dashWrapper = null;
  pendingMatchStart = null;
  pendingMatchEnd = null;
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

// Firebase feed wiring: subscribes to Firestore matches, re-derives
// frames from the action log, and pushes synthetic events into the same
// onEvent() pipeline the WebSocket path uses. One subscription handles
// the entire spectate session; the unsubscribe is held in `firebaseFeedStop`
// and torn down by the existing close path.
let firebaseFeedStop = null;
let firebaseFeedSeenMatchId = null;

async function consumeMatchDoc(matchDoc, { replayFailureTitle = "BROADCAST REJECTED" } = {}) {
  if (!running) return;
  if (!matchDoc || matchDoc.matchId === firebaseFeedSeenMatchId) return;
  firebaseFeedSeenMatchId = matchDoc.matchId;
  onEvent({
    type: "matchStart",
    match: {
      matchId: matchDoc.matchId,
      a: matchDoc.a,
      b: matchDoc.b,
      stageId: matchDoc.stageId,
    },
    seed: matchDoc.seed,
    bundle: null,
  });
  let frames;
  try {
    frames = (await matchFeed()).framesFromActionLog(matchDoc);
  } catch (e) {
    setSignalFailure(
      replayFailureTitle,
      `Local replay failed: ${e instanceof Error ? e.message : String(e)}`,
      "decode-fail",
      15000,
    );
    return;
  }
  const tickMs = matchDoc.durationMs / Math.max(1, frames.length);
  const elapsedMs = Math.max(0, Date.now() - matchDoc.startedAt);
  const startIdx = Math.min(frames.length - 1, Math.floor(elapsedMs / tickMs));
  const STRIDE = 3;
  let idx = startIdx;
  const tick = () => {
    if (!running || firebaseFeedSeenMatchId !== matchDoc.matchId) return;
    if (idx >= frames.length) {
      onEvent({
        type: "matchEnd",
        matchId: matchDoc.matchId,
        winner: matchDoc.result.winner,
        finalScore: matchDoc.result.finalScore,
        eloBefore: matchDoc.eloDelta
          ? [matchDoc.a.eloBefore, matchDoc.b.eloBefore]
          : undefined,
        eloAfter: matchDoc.eloAfter
          ? [matchDoc.eloAfter.a, matchDoc.eloAfter.b]
          : undefined,
        bundles: null,
      });
      return;
    }
    const chunk = frames.slice(idx, idx + STRIDE);
    idx += chunk.length;
    onEvent({ type: "frames", matchId: matchDoc.matchId, frames: chunk });
    setTimeout(tick, STRIDE * tickMs);
  };
  tick();
}

async function connectMeshFeed() {
  if (firebaseFeedStop) return;
  signalState = null;
  setStat("stat-ws", "p2p");
  statusCb("p2p mesh");

  let stopHead = null;
  let stopMesh = null;
  let activeHeadId = null;
  let fellBack = false;
  let headTimer = setTimeout(() => {
    if (!activeHeadId) fallbackToDirect("match-chain empty");
  }, 4000);

  const fallbackToDirect = (reason) => {
    if (fellBack || !running) return;
    fellBack = true;
    if (headTimer) { clearTimeout(headTimer); headTimer = null; }
    if (stopMesh) { try { stopMesh(); } catch {} stopMesh = null; }
    if (stopHead) { try { stopHead(); } catch {} stopHead = null; }
    firebaseFeedStop = null;
    appendStreamLine(`p2p fallback — ${reason}`);
    void connectFirebaseFeed();
  };

  try {
    const [{ subscribeCurrentMatchId }, { joinMesh }] = await Promise.all([matchFeed(), peerMesh()]);
    stopHead = subscribeCurrentMatchId(
      ({ matchId }) => {
        if (!running || !matchId || matchId === activeHeadId) return;
        if (headTimer) { clearTimeout(headTimer); headTimer = null; }
        activeHeadId = matchId;
        firebaseFeedSeenMatchId = null;
        if (stopMesh) { try { stopMesh(); } catch {} stopMesh = null; }
        joinMesh({
          matchId,
          onMatchDoc: (matchDoc) => { void consumeMatchDoc(matchDoc); },
          onPayload: () => {},
          onError: (err) => {
            appendStreamLine(`p2p degraded — ${err?.message ?? err}`);
            setStat("stat-ws", "p2p/fallback");
          },
        })
          .then((stop) => { stopMesh = stop; })
          .catch((err) => fallbackToDirect(err?.message ?? "mesh unavailable"));
      },
      (err) => fallbackToDirect(err?.message ?? "match-chain unavailable"),
    );
    firebaseFeedStop = () => {
      if (headTimer) { clearTimeout(headTimer); headTimer = null; }
      if (stopHead) { try { stopHead(); } catch {} stopHead = null; }
      if (stopMesh) { try { stopMesh(); } catch {} stopMesh = null; }
    };
  } catch (e) {
    fallbackToDirect(e instanceof Error ? e.message : String(e));
  }
}

async function connectFirebaseFeed() {
  if (firebaseFeedStop) return;
  signalState = null;
  setStat("stat-ws", "live");
  statusCb("firebase live");
  try {
    const { framesFromActionLog, subscribeLatestMatch } = await matchFeed();
    firebaseFeedStop = subscribeLatestMatch((matchDoc) => {
      if (!running) return;
      if (!matchDoc || matchDoc.matchId === firebaseFeedSeenMatchId) return;
      firebaseFeedSeenMatchId = matchDoc.matchId;
      // Synthesize a matchStart event in the same shape as the legacy WS
      // payload so the existing onEvent() handler can consume it.
      onEvent({
        type: "matchStart",
        match: {
          matchId: matchDoc.matchId,
          a: matchDoc.a,
          b: matchDoc.b,
          stageId: matchDoc.stageId,
        },
        seed: matchDoc.seed,
        bundle: null,
      });
      // Reconstruct frames locally and feed them into the same buffer.
      let frames;
      try {
        frames = framesFromActionLog(matchDoc);
      } catch (e) {
        setSignalFailure(
          "BROADCAST REJECTED",
          `Local replay failed: ${e instanceof Error ? e.message : String(e)}`,
          "decode-fail",
          15000,
        );
        return;
      }
      // Time-align playback: skip frames that should already have played
      // based on the match's startedAt timestamp.
      const tickMs = matchDoc.durationMs / Math.max(1, frames.length);
      const elapsedMs = Math.max(0, Date.now() - matchDoc.startedAt);
      const startIdx = Math.min(frames.length - 1, Math.floor(elapsedMs / tickMs));
      // Drip frames into the existing playback buffer at the same rate
      // the WS path used (chunks of STRIDE).
      const STRIDE = 3;
      let idx = startIdx;
      const tick = () => {
        if (!running || firebaseFeedSeenMatchId !== matchDoc.matchId) return;
        if (idx >= frames.length) {
          onEvent({
            type: "matchEnd",
            matchId: matchDoc.matchId,
            winner: matchDoc.result.winner,
            finalScore: matchDoc.result.finalScore,
            eloBefore: matchDoc.eloDelta
              ? [matchDoc.a.eloBefore, matchDoc.b.eloBefore]
              : undefined,
            eloAfter: matchDoc.eloAfter
              ? [matchDoc.eloAfter.a, matchDoc.eloAfter.b]
              : undefined,
            bundles: null,
          });
          return;
        }
        const chunk = frames.slice(idx, idx + STRIDE);
        idx += chunk.length;
        onEvent({ type: "frames", matchId: matchDoc.matchId, frames: chunk });
        setTimeout(tick, STRIDE * tickMs);
      };
      tick();
    });
  } catch (e) {
    setSignalFailure(
      "BROADCAST UNAVAILABLE",
      `Firestore subscription failed: ${e instanceof Error ? e.message : String(e)}`,
      "unavailable",
      5000,
    );
  }
}

async function connectStaticFeed() {
  if (firebaseFeedStop) return;
  signalState = null;
  setStat("stat-ws", "archive");
  statusCb("static feed");
  try {
    const { framesFromActionLog, subscribeStaticMatch } = await matchFeed();
    firebaseFeedStop = subscribeStaticMatch((matchDoc) => {
      if (!running) return;
      if (!matchDoc || matchDoc.matchId === firebaseFeedSeenMatchId) return;
      firebaseFeedSeenMatchId = matchDoc.matchId;
      onEvent({
        type: "matchStart",
        match: {
          matchId: matchDoc.matchId,
          a: matchDoc.a,
          b: matchDoc.b,
          stageId: matchDoc.stageId,
        },
        seed: matchDoc.seed,
        bundle: null,
      });
      let frames;
      try {
        frames = framesFromActionLog(matchDoc);
      } catch (e) {
        setSignalFailure(
          "BROADCAST REJECTED",
          `Local replay failed: ${e instanceof Error ? e.message : String(e)}`,
          "decode-fail",
          15000,
        );
        return;
      }
      const tickMs = matchDoc.durationMs / Math.max(1, frames.length);
      const elapsedMs = Math.max(0, Date.now() - matchDoc.startedAt);
      const startIdx = Math.min(frames.length - 1, Math.floor(elapsedMs / tickMs));
      const STRIDE = 3;
      let idx = startIdx;
      const tick = () => {
        if (!running || firebaseFeedSeenMatchId !== matchDoc.matchId) return;
        if (idx >= frames.length) {
          onEvent({
            type: "matchEnd",
            matchId: matchDoc.matchId,
            winner: matchDoc.result.winner,
            finalScore: matchDoc.result.finalScore,
            eloAfter: matchDoc.eloAfter ? [matchDoc.eloAfter.a, matchDoc.eloAfter.b] : undefined,
            bundles: null,
          });
          return;
        }
        const chunk = frames.slice(idx, idx + STRIDE);
        idx += chunk.length;
        onEvent({ type: "frames", matchId: matchDoc.matchId, frames: chunk });
        setTimeout(tick, STRIDE * tickMs);
      };
      tick();
    });
  } catch (e) {
    setSignalFailure(
      "BROADCAST UNAVAILABLE",
      `Static feed unavailable: ${e instanceof Error ? e.message : String(e)}`,
      "unavailable",
      5000,
    );
  }
}

function connect() {
  if (!running) return;
  if (useFirebaseFeed()) {
    if (useMeshFeed()) void connectMeshFeed();
    else void connectFirebaseFeed();
    return;
  }
  if (useStaticFeed()) {
    void connectStaticFeed();
    return;
  }
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
    pendingMatchStart = {
      matchId: mt.matchId ?? null,
      bundle: m.bundle ?? null,
      match: mt,
    };
    pendingMatchEnd = null;
    computeDash?.onMatchStart(pendingMatchStart);
    const handleA = mt.a?.handle ?? "?";
    const handleB = mt.b?.handle ?? "?";
    const eloA = mt.a?.elo ?? "?";
    const eloB = mt.b?.elo ?? "?";
    renderState.handles = { a: handleA, b: handleB };
    renderState.elos = { a: eloA, b: eloB };
    renderState.matchLabel = `@${handleA} (${eloA}) vs @${handleB} (${eloB})`;
    const cosA = presentationCosmeticsForCompetitor(mt.a, 0);
    const cosB = presentationCosmeticsForCompetitor(mt.b, 1);
    audioCharKeys = [cosA?.body ?? null, cosB?.body ?? null];
    audioWeaponKeys = [cosA?.weapon ?? null, cosB?.weapon ?? null];
    renderState.labels = {
      p1: `@${handleA} [${botNameForMatchSide(mt.a)}]`,
      p2: `@${handleB} [${botNameForMatchSide(mt.b)}]`,
      nameplates: [`@${handleA}`, `@${handleB}`],
      cosmetics: [cosA, cosB],
    };
    renderState.stage = STAGES[mt.stageId] ?? STAGES.datacenter;
    const audio = getAudio();
    if (mt.stageId) audio.setStage(mt.stageId);
    if (m.type === "matchStart") audio.play("match_start");
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
    pendingMatchEnd = {
      matchId: m.matchId ?? null,
      winner: m.winner,
      bundles: m.bundles ?? null,
      a: renderState.handles?.a ? { handle: renderState.handles.a } : null,
      b: renderState.handles?.b ? { handle: renderState.handles.b } : null,
    };
    computeDash?.onMatchEnd(pendingMatchEnd);
    const audio = getAudio();
    if (m.winner === -1) {
      audio.play("match_end_draw");
    } else {
      audio.play("match_end_win");
      audio.play("win_applause", { when: 0.25 });
    }
    prevAudioFrame = null;
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
      if (badge?.status !== "verified") continue;
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
  const name = botNameForMatchSide(data);
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

async function refreshLeaderboard({ append = false, reset = false } = {}) {
  if (!leaderboardEl || leaderboardLoading) return;
  if (append && !leaderboardHasMore) return;
  const requestId = ++leaderboardRequestId;
  if (reset) {
    leaderboardCursor = null;
    leaderboardSource = null;
  }
  leaderboardLoading = true;
  syncLeaderboardMoreButton();
  try {
    const page = await loadLeaderboardPage({
      cursor: append ? leaderboardCursor : null,
      offset: append ? leaderboardRows.length : 0,
    });
    if (!leaderboardEl || requestId !== leaderboardRequestId) return;
    leaderboardRows = append
      ? mergeLeaderboardRows(leaderboardRows, page.rows)
      : page.rows;
    leaderboardCursor = page.cursor;
    leaderboardHasMore = page.hasMore === true;
    renderLeaderboardRows(leaderboardRows);
  } catch (e) {
    if (requestId === leaderboardRequestId && leaderboardRows.length === 0 && leaderboardEl) {
      leaderboardEl.innerHTML = unavailablePanelHtml("Ranked standings need a connection.", e);
    }
  } finally {
    if (requestId !== leaderboardRequestId) return;
    leaderboardLoading = false;
    syncLeaderboardMoreButton();
  }
}

async function loadLeaderboardPage({ cursor, offset }) {
  if (leaderboardSource === "rest") {
    return restLeaderboardPage(offset);
  }
  if (leaderboardSource === "firebase") {
    return firebaseLeaderboardPage(cursor);
  }
  try {
    const page = await restLeaderboardPage(offset);
    leaderboardSource = "rest";
    return page;
  } catch {
    const page = await firebaseLeaderboardPage(cursor);
    leaderboardSource = "firebase";
    return page;
  }
}

async function restLeaderboardPage(offset) {
  const page = await leaderboardPage({ limit: LEADERBOARD_PAGE_SIZE, offset });
  return {
    rows: page.rows,
    cursor: offset + page.rows.length,
    hasMore: page.hasMore === true,
  };
}

async function firebaseLeaderboardPage(cursor) {
  return (await submitApi()).getPublicLeaderboardPage({
    limitCount: LEADERBOARD_PAGE_SIZE,
    cursor,
  });
}

function mergeLeaderboardRows(currentRows, nextRows) {
  const seen = new Set(currentRows.map((row) => row.userId));
  const uniqueNextRows = nextRows.filter((row) => {
    if (seen.has(row.userId)) return false;
    seen.add(row.userId);
    return true;
  });
  return [...currentRows, ...uniqueNextRows];
}

function syncLeaderboardMoreButton() {
  if (!leaderboardMoreBtn) return;
  leaderboardMoreBtn.hidden = !leaderboardHasMore;
  leaderboardMoreBtn.disabled = leaderboardLoading;
  leaderboardMoreBtn.textContent = leaderboardLoading ? "loading" : "more";
  leaderboardEl?.setAttribute("aria-busy", String(leaderboardLoading));
}

async function refreshBotDirectory({ reset = false } = {}) {
  if (!botDirectoryEl || botPageLoading) return;
  botPageLoading = true;
  if (botMoreBtn) botMoreBtn.disabled = true;
  if (reset) {
    botPageCursor = null;
    botRows = [];
    botDirectoryEl.textContent = "loading…";
  }
  try {
    const page = await (await submitApi()).getPublicBotsPage({
      limitCount: 12,
      cursor: botPageCursor,
    });
    botPageCursor = page.cursor;
    botRows = reset ? page.rows : [...botRows, ...page.rows];
    renderBotDirectory(botRows, page);
  } catch (e) {
    if (botDirectoryEl) botDirectoryEl.innerHTML = unavailablePanelHtml("The fighter directory is unavailable.", e);
  } finally {
    botPageLoading = false;
  }
}

async function refreshBotEvents() {
  if (!botEventsEl) return;
  try {
    const rows = await (await submitApi()).getPublicBotEvents(10);
    renderBotEvents(rows);
  } catch (e) {
    if (botEventsEl) botEventsEl.innerHTML = unavailablePanelHtml("Fighter updates are unavailable.", e);
  }
}

function renderBotDirectory(rows, page = {}) {
  if (!botDirectoryEl) return;
  if (!rows.length) {
    botDirectoryEl.textContent = "no named bots yet";
  } else {
    botDirectoryEl.innerHTML = rows.map((bot) => `
      <article class="live-bot-row">
        <div class="live-bot-main">
          <strong title="${escapeHtml(botTitle(bot))}">${escapeHtml(bot.name)}</strong>
          <span>@${escapeHtml(bot.handle)}</span>
        </div>
        <div class="live-bot-meta">
          <span>${Math.round(bot.elo)} ELO</span>
          <span>${Number(bot.wins ?? 0)}-${Number(bot.losses ?? 0)}-${Number(bot.draws ?? 0)}</span>
        </div>
      </article>`).join("");
  }
  if (botMoreBtn) {
    botMoreBtn.hidden = page.hasMore === false;
    botMoreBtn.disabled = page.hasMore === false || botPageLoading;
    botMoreBtn.textContent = page.hasMore === false ? "all" : "more";
  }
}

function unavailablePanelHtml(message, error) {
  return `<p class="tight">${escapeHtml(message)}</p>` + disclosureHtml({
    label: "Connection details", body: `<p class="tight">${escapeHtml(error?.message ?? String(error))}</p>`,
  });
}

function renderBotEvents(rows) {
  if (!botEventsEl) return;
  if (!rows.length) {
    botEventsEl.textContent = "no arrivals yet";
    return;
  }
  botEventsEl.innerHTML = rows.map((bot) => `
    <article class="live-bot-event">
      <span class="live-bot-event-type">${escapeHtml(eventLabel(bot.eventType))}</span>
      <strong>${escapeHtml(bot.name)}</strong>
      <span>@${escapeHtml(bot.handle)}</span>
      <time>${escapeHtml(formatBotStamp(bot.eventAt || bot.submittedAt || bot.lastOnlineAt))}</time>
    </article>`).join("");
}

function botTitle(bot) {
  const source = bot.source === "system" ? "system" : "player";
  return `${bot.name} · @${bot.handle} · ${source} · ${Math.round(bot.elo)} ELO`;
}

function eventLabel(type) {
  if (type === "released") return "released";
  if (type === "revised") return "revised";
  return "online";
}

function formatBotStamp(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return "unknown";
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function botNameForMatchSide(side) {
  return side?.name ?? side?.slotName ?? "slot";
}

function renderLeaderboardRows(rows) {
  if (!leaderboardEl) return;
  if (leaderboardCountEl) {
    leaderboardCountEl.textContent = `${rows.length}${leaderboardHasMore ? "+" : ""}`;
  }
  if (rows.length === 0) {
    leaderboardEl.textContent = "no ranked players yet";
    return;
  }
  const scrollTop = leaderboardEl.scrollTop;
  leaderboardEl.innerHTML = `
    <table>
      <tbody>
        ${rows.map((r, i) => `
          <tr>
            <td class="rank">${i + 1}</td>
            <td class="handle" title="@${escapeHtml(r.handle)}">@${escapeHtml(r.handle)}</td>
            <td class="elo">${r.eloAggregate}</td>
            <td class="wl">${r.wins}-${r.losses}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
  leaderboardEl.scrollTop = scrollTop;
}

function formatDelta(n) {
  const r = Math.round(n);
  return r > 0 ? `+${r}` : `${r}`;
}

const WEAPON_CLASS = {
  worldcoin_orb_flail: "flail", backpack_maul: "maul", gpu_server_blade: "blade", heat_sink_greatsword: "greatsword",
  rolled_constitution_bat: "bat", alignment_baton: "club", red_team_pike: "pike", guardrail_greatsword: "greatsword",
  nobel_medal_flail: "flail", folded_chess_axe: "axe", go_board_maul: "maul", alphafold_blade: "blade",
  sunscreen_bottle_club: "club", controller_nunchucks: "nunchucks", shareholder_sauce_club: "club", quest_flail: "flail",
};

function detectAudioEdges(frame) {
  const audio = getAudio();
  if (!audio.isEnabled() || !audio.ready) { prevAudioFrame = frame; return; }
  if (!prevAudioFrame) { prevAudioFrame = frame; return; }
  for (let i = 0; i < 2; i++) {
    const key = i === 0 ? "p0" : "p1";
    const prev = prevAudioFrame[key];
    const curr = frame[key];
    if (!prev || !curr) continue;
    if ((prev.swipeT ?? 0) <= 0 && (curr.swipeT ?? 0) > 0) {
      const weapon = audioWeaponKeys[i];
      const cls = WEAPON_CLASS[weapon] ?? "blade";
      audio.play(`swipe_${cls}`);
      fireGrunt(audio, i, "effort");
    }
    if ((prev.diveT ?? 0) <= 0 && (curr.diveT ?? 0) > 0) {
      audio.play("dive_lunge");
    }
    if ((prev.hp ?? curr.hp ?? 0) > (curr.hp ?? 0)) {
      const attacker = 1 - i;
      const weapon = audioWeaponKeys[attacker];
      const char = audioCharKeys[attacker];
      if (char && weapon) audio.play(`hit_${char}_${weapon}`, { impact: true });
      fireGrunt(audio, i, "hurt");
    }
    if (!prev.dead && curr.dead) {
      audio.play("ko_flatline");
      fireGrunt(audio, i, "ko");
    }
  }
  prevAudioFrame = frame;
}

function fireGrunt(audio, side, kind) {
  const char = audioCharKeys[side];
  if (!char) return;
  const now = performance.now();
  if (kind !== "ko" && now - lastGruntMs[side] < GRUNT_THROTTLE_MS) return;
  lastGruntMs[side] = now;
  audio.play(`grunt_${char}_${kind}`);
}

function loop() {
  if (!running) return;
  if (!renderer || !ctx) {
    rafId = requestAnimationFrame(loop);
    return;
  }
  const frameStart = performance.now();
  const f = signalState ? null : currentFrame();
  if (f && matchActive) detectAudioEdges(f);
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
  drawLeftFit(`${botNameForMatchSide(meta)} · ${meta?.elo ?? "?"}`, x, y + h - 8, w, 700, 13);
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
