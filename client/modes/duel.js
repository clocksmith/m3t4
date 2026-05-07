// Duel — local play surface. Three sub-modes:
//
//   vs-AI    : human (P1, WASD+F) vs a preset bot (P2 driven by sim brain)
//   hot-seat : two humans on one keyboard, P1 WASD+F and P2 P/L/;/'+[
//   p2p      : two humans on different machines, paired over WebRTC
//
// Reuses the same stepper sim primitives as tune's HUMAN mode
// (createStepperWorld + stepWorld + readKeyboard). The sim runs locally,
// never touches /api/build/simulate, never enters the canonical match
// feed. Sandbox only — there is no ranked write path here.
//
// The browser-trust boundary still holds: vs-AI compiles a *public*
// preset config (already shipped via @m3t4/sim's STRATEGIES) into a
// brain — no private/canonical brain code is exposed by being on this
// page that wasn't already in the bundle.

import { createFrameRenderer, W, H } from "../render/index.js";
import {
  createStepperWorld,
  stepWorld,
  worldToFrame,
  runBrainForWorld,
  compileBrain,
  STAGES as SIM_STAGES,
  STRATEGIES,
} from "../sim/index.js";
import { STAGES } from "../lib/public-sim.js";
import { escapeHtml } from "../ui/html.js";
import { buttonHtml } from "../ui/actions.js";
import { contextCardHtml, pageHeaderHtml } from "../ui/shell.js";
import presetRanking from "../data/preset-ranking.v1.json" with { type: "json" };
import { startP2PDuel, isP2PSupported } from "../lib/p2p-duel.js";

const SIM_HZ = 120;
const STEP_MS = 1000 / SIM_HZ;
const MAX_CATCHUP_TICKS = 240;
const STAGE_IDS = Object.keys(STAGES);

const KEY_MAP = [
  { left: "KeyA", right: "KeyD", up: "KeyW", down: "KeyS", act: "KeyF",
    moveHint: "W/A/S/D", strikeHint: "F" },
  { left: "KeyL", right: "Quote", up: "KeyP", down: "Semicolon", act: "BracketLeft",
    moveHint: "P/L/;/'", strikeHint: "[" },
];
const GAME_KEYS = new Set([
  "KeyA", "KeyD", "KeyW", "KeyS", "KeyF",
  "KeyL", "Quote", "KeyP", "Semicolon", "BracketLeft",
]);

const SUB_MODES = ["vs-ai", "hot-seat", "p2p"];

const PRESET_NAMES = (presetRanking.rows ?? []).map((r) => r.name ?? r);
const DEFAULT_PRESET = PRESET_NAMES[0] ?? "standby";

// --- module state ---
let state = null; // populated by mount()

function freshState() {
  return {
    subMode: "vs-ai",
    stageId: STAGE_IDS.includes("datacenter") ? "datacenter" : STAGE_IDS[0],
    presetName: DEFAULT_PRESET,
    keyset: new Set(),
    canvas: null,
    renderer: null,
    rendererId: 0,
    rafId: 0,
    running: false,
    world: null,
    brainP2: null,
    seed: 0,
    playedAtMs: 0,
    accumMs: 0,
    p2p: null,        // populated when p2p sub-mode is active
    remoteInput: { left: false, right: false, up: false, down: false, action: false },
    hostSide: 0,      // 0 = P1, 1 = P2 (for p2p, assigned when pairing)
    statusMsg: "",
  };
}

// --- input ---
function isTypingTarget(el) {
  if (!el) return false;
  const t = el.tagName;
  return t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || el.isContentEditable;
}
function onKeyDown(e) {
  if (!state || isTypingTarget(e.target)) return;
  state.keyset.add(e.code);
  if (GAME_KEYS.has(e.code)) e.preventDefault();
}
function onKeyUp(e) {
  if (!state) return;
  state.keyset.delete(e.code);
}
function onBlur() {
  if (state) state.keyset.clear();
}
function readKeyboard(slot) {
  const k = KEY_MAP[slot];
  const ks = state.keyset;
  return {
    left: ks.has(k.left), right: ks.has(k.right),
    up: ks.has(k.up), down: ks.has(k.down),
    action: ks.has(k.act),
  };
}

// --- sim wiring ---
function freshSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

function startMatch() {
  if (!state) return;
  const stage = SIM_STAGES[state.stageId] ?? SIM_STAGES.datacenter;
  state.seed = freshSeed();
  state.world = createStepperWorld({ stage, seed: state.seed });
  state.brainP2 = state.subMode === "vs-ai"
    ? compileBrain(STRATEGIES[state.presetName] ?? STRATEGIES[DEFAULT_PRESET])
    : null;
  state.playedAtMs = performance.now();
  state.accumMs = 0;
  state.statusMsg = state.subMode === "p2p" && !state.p2p?.linked
    ? "waiting for opponent…"
    : "fight";
  if (state.p2p?.linked && typeof state.p2p.broadcastSeed === "function") {
    state.p2p.broadcastSeed(state.seed);
  }
  refreshHud();
}

function actionFor(slot) {
  if (state.subMode === "vs-ai") {
    if (slot === 0) return readKeyboard(0);
    return runBrainForWorld(state.world, state.brainP2, 1);
  }
  if (state.subMode === "hot-seat") {
    return readKeyboard(slot);
  }
  // p2p: local human drives one side, remote input drives the other.
  if (slot === state.hostSide) return readKeyboard(0);
  return state.remoteInput;
}

function step(nowMs) {
  if (!state.world) return null;
  if (state.world.matchWinner !== -1) return worldToFrame(state.world);
  let dt = nowMs - state.playedAtMs;
  state.playedAtMs = nowMs;
  if (!Number.isFinite(dt) || dt < 0) dt = 0;
  state.accumMs += dt;
  let steps = 0;
  while (
    state.accumMs >= STEP_MS &&
    steps < MAX_CATCHUP_TICKS &&
    state.world.matchWinner === -1
  ) {
    const actA = actionFor(0);
    const actB = actionFor(1);
    if (state.p2p?.linked && state.subMode === "p2p") {
      // Send local input to the remote peer each tick. The peer mirrors
      // and applies it on their side. Simple input-broadcast lockstep —
      // the host's seed makes both sims deterministic from the same
      // start, so identical input streams produce identical worlds.
      const localAct = state.hostSide === 0 ? actA : actB;
      state.p2p.sendInput(state.world.tick, localAct);
    }
    stepWorld(state.world, actA, actB);
    state.accumMs -= STEP_MS;
    steps++;
  }
  if (state.accumMs > STEP_MS * MAX_CATCHUP_TICKS) {
    state.accumMs = STEP_MS * MAX_CATCHUP_TICKS;
  }
  return worldToFrame(state.world);
}

function loop() {
  if (!state || !state.running) return;
  if (state.renderer) {
    const stage = SIM_STAGES[state.stageId] ?? SIM_STAGES.datacenter;
    const frame = step(performance.now()) ?? emptyFrame();
    state.renderer.drawFrame(stage, frame, labels());
    refreshHud(frame);
  }
  state.rafId = requestAnimationFrame(loop);
}

function emptyFrame() {
  return {
    tick: 0, roundStartTick: 0,
    p0: { x: 300, y: 590, vx: 0, vy: 0, facing: 1, onGround: true, wall: 0, stun: 0, swipeT: 0, diveT: 0, lastClashTick: -9999, dead: false },
    p1: { x: 980, y: 590, vx: 0, vy: 0, facing: -1, onGround: true, wall: 0, stun: 0, swipeT: 0, diveT: 0, lastClashTick: -9999, dead: false },
    token: { exists: false, x: 0, y: 0, carrier: -1, dwellT: 0 },
    goal: { exists: false, x: 0, y: 0, label: "", timer: 0 },
    scoreboard: [0, 0],
    rounds: [0, 0],
  };
}

function labels() {
  if (state.subMode === "vs-ai") return { p1: "you", p2: state.presetName };
  if (state.subMode === "hot-seat") return { p1: "P1", p2: "P2" };
  return state.hostSide === 0 ? { p1: "you", p2: "remote" } : { p1: "remote", p2: "you" };
}

// --- HUD ---
function refreshHud(frame = state.world ? worldToFrame(state.world) : emptyFrame()) {
  const score = state.world
    ? `${state.world.fighters[0].score}-${state.world.fighters[1].score}`
    : "0-0";
  const rounds = state.world
    ? `${state.world.fighters[0].rounds}-${state.world.fighters[1].rounds}`
    : "0-0";
  setText("duel-stat-tick", String(frame?.tick ?? 0));
  setText("duel-stat-score", score);
  setText("duel-stat-rounds", rounds);
  setText("duel-stat-seed", state.seed ? String(state.seed) : "—");
  setText("duel-status", duelStatusText());
}

function duelStatusText() {
  if (!state.world) return "press fight to start";
  if (state.world.matchWinner !== -1) {
    const w = state.world.matchWinner;
    return `${w === 0 ? labels().p1 : labels().p2} wins`;
  }
  return state.statusMsg || "fight";
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// --- HTML scaffolds ---
function presetOptions(selected) {
  const rows = presetRanking.rows ?? PRESET_NAMES.map((name) => ({ name, wr: 0 }));
  return rows.map((r) => {
    const pct = (Number(r.wr) * 100).toFixed(0);
    return `<option value="${escapeHtml(r.name)}" ${r.name === selected ? "selected" : ""}>${escapeHtml(r.name)} · ${pct}%</option>`;
  }).join("");
}

function stageOptions(selected) {
  return STAGE_IDS.map(
    (id) => `<option value="${escapeHtml(id)}" ${id === selected ? "selected" : ""}>${escapeHtml(STAGES[id]?.name ?? id)}</option>`
  ).join("");
}

function subModeRowHtml() {
  return `
    <div class="duel-mode-row" role="radiogroup" aria-label="duel mode">
      ${SUB_MODES.map((m) => `
        <label class="mode-pill ${m === state.subMode ? "is-active" : ""}" data-submode="${m}">
          <input type="radio" name="duel-submode" value="${m}" ${m === state.subMode ? "checked" : ""}>
          <span>${m === "vs-ai" ? "VS AI" : m === "hot-seat" ? "HOT-SEAT" : "P2P"}</span>
        </label>`).join("")}
    </div>`;
}

function controlsCardHtml() {
  return `
    <div class="duel-controls">
      ${subModeRowHtml()}

      <div class="duel-row">
        <label class="tight">stage
          <select id="duel-stage">${stageOptions(state.stageId)}</select>
        </label>
        <label class="tight" id="duel-preset-row" ${state.subMode === "vs-ai" ? "" : "hidden"}>
          opponent
          <select id="duel-preset">${presetOptions(state.presetName)}</select>
        </label>
      </div>

      <div class="duel-row" id="duel-p2p-row" ${state.subMode === "p2p" ? "" : "hidden"}>
        <div class="duel-p2p-panel" id="duel-p2p-panel">
          ${p2pPanelHtml()}
        </div>
      </div>

      <div class="duel-keys" id="duel-keys"></div>

      <div class="duel-row">
        ${buttonHtml({ id: "duel-start", variant: "primary", text: "fight", attrs: { title: "Start a fresh match" } })}
        ${buttonHtml({ id: "duel-reset", text: "reset", attrs: { title: "Reset to a fresh match with a new seed" } })}
      </div>
    </div>`;
}

function p2pPanelHtml() {
  if (!isP2PSupported()) {
    return `<div class="duel-p2p-warning">P2P needs WebRTC + Firebase. Check your config.js.</div>`;
  }
  return `
    <div class="duel-p2p-row">
      ${buttonHtml({ id: "duel-p2p-host", text: "host", attrs: { title: "Create a session and share the code" } })}
      <span class="duel-p2p-divider">or</span>
      <input type="text" id="duel-p2p-code" placeholder="paste code" autocomplete="off" spellcheck="false" />
      ${buttonHtml({ id: "duel-p2p-join", text: "join", attrs: { title: "Join an existing session" } })}
    </div>
    <div class="duel-p2p-status tight" id="duel-p2p-status">offline</div>`;
}

function keysHtml() {
  if (state.subMode === "vs-ai") {
    return `<span class="tight"><b>YOU</b> ${escapeHtml(KEY_MAP[0].moveHint)} · strike <b>${escapeHtml(KEY_MAP[0].strikeHint)}</b></span>`;
  }
  if (state.subMode === "hot-seat") {
    return `
      <span class="tight"><b>P1</b> ${escapeHtml(KEY_MAP[0].moveHint)} · strike <b>${escapeHtml(KEY_MAP[0].strikeHint)}</b></span>
      <span class="tight"><b>P2</b> ${escapeHtml(KEY_MAP[1].moveHint)} · strike <b>${escapeHtml(KEY_MAP[1].strikeHint)}</b></span>`;
  }
  // p2p — local user always plays with P1 keys regardless of side
  return `<span class="tight"><b>YOU</b> ${escapeHtml(KEY_MAP[0].moveHint)} · strike <b>${escapeHtml(KEY_MAP[0].strikeHint)}</b></span>`;
}

function statsListHtml() {
  return `
    <div class="duel-stats" aria-live="polite">
      <span class="stat"><span class="stat-label">tick</span><span class="stat-value" id="duel-stat-tick">0</span></span>
      <span class="stat"><span class="stat-label">score</span><span class="stat-value" id="duel-stat-score">0-0</span></span>
      <span class="stat"><span class="stat-label">rounds</span><span class="stat-value" id="duel-stat-rounds">0-0</span></span>
      <span class="stat"><span class="stat-label">seed</span><span class="stat-value" id="duel-stat-seed">—</span></span>
      <span class="stat duel-status"><span class="stat-label">status</span><span class="stat-value" id="duel-status">press fight</span></span>
    </div>`;
}

// --- mode lifecycle ---

export function mount(root, ctx = {}) {
  ctx.setStatus?.("duel");
  state = freshState();

  root.innerHTML = `
    <div class="page duel-page">
      ${pageHeaderHtml({
        title: "Duel",
        subtitle: "play a match yourself · sandbox only · not ranked",
      })}
      ${contextCardHtml({
        className: "duel-context-card",
        body: controlsCardHtml(),
      })}
      <section class="panel canvas-panel">
        <canvas id="duel-canvas" class="u-canvas-fill" width="${W}" height="${H}" tabindex="0"></canvas>
        ${statsListHtml()}
      </section>
    </div>`;

  state.canvas = root.querySelector("#duel-canvas");
  void attachRenderer(state.canvas);
  refreshKeysHint();
  bindControls();

  addEventListener("keydown", onKeyDown);
  addEventListener("keyup", onKeyUp);
  addEventListener("blur", onBlur);

  state.running = true;
  loop();
  refreshHud();
}

export function unmount() {
  removeEventListener("keydown", onKeyDown);
  removeEventListener("keyup", onKeyUp);
  removeEventListener("blur", onBlur);
  if (state) {
    state.running = false;
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.renderer?.destroy();
    state.renderer = null;
    if (state.p2p?.stop) {
      try { state.p2p.stop(); } catch {}
    }
    state.p2p = null;
  }
  state = null;
}

async function attachRenderer(canvas) {
  state.rendererId++;
  const id = state.rendererId;
  let renderer = null;
  try {
    renderer = await createFrameRenderer(canvas);
  } catch (err) {
    console.error("[duel] renderer init failed", err);
    return;
  }
  if (!state || id !== state.rendererId) {
    renderer.destroy();
    return;
  }
  state.renderer?.destroy();
  state.renderer = renderer;
}

function bindControls() {
  document.querySelectorAll('input[name="duel-submode"]').forEach((inp) => {
    inp.addEventListener("change", () => {
      if (!inp.checked) return;
      switchSubMode(inp.value);
    });
  });
  const stageSel = document.getElementById("duel-stage");
  stageSel?.addEventListener("change", () => {
    if (!STAGE_IDS.includes(stageSel.value)) return;
    state.stageId = stageSel.value;
    state.world = null;
    refreshHud();
    refocusCanvas();
  });
  const presetSel = document.getElementById("duel-preset");
  presetSel?.addEventListener("change", () => {
    state.presetName = presetSel.value;
    state.world = null;
    refreshHud();
    refocusCanvas();
  });
  document.getElementById("duel-start")?.addEventListener("click", () => {
    startMatch();
    refocusCanvas();
  });
  document.getElementById("duel-reset")?.addEventListener("click", () => {
    state.world = null;
    refreshHud();
    refocusCanvas();
  });

  bindP2PControls();
}

function bindP2PControls() {
  const hostBtn = document.getElementById("duel-p2p-host");
  const joinBtn = document.getElementById("duel-p2p-join");
  const codeInp = document.getElementById("duel-p2p-code");
  hostBtn?.addEventListener("click", () => beginP2P("host"));
  joinBtn?.addEventListener("click", () => {
    const code = (codeInp?.value || "").trim();
    if (!code) {
      setP2PStatus("paste a code first");
      return;
    }
    beginP2P("join", code);
  });
}

async function beginP2P(role, sessionId) {
  if (!isP2PSupported()) {
    setP2PStatus("P2P unavailable in this build");
    return;
  }
  if (state.p2p?.stop) {
    try { state.p2p.stop(); } catch {}
  }
  state.hostSide = role === "host" ? 0 : 1;
  setP2PStatus(role === "host" ? "creating session…" : "connecting…");
  try {
    const handle = await startP2PDuel({
      role,
      sessionId,
      onStatus: (msg) => setP2PStatus(msg),
      onLink: () => {
        setP2PStatus("linked");
        // Start a match when both sides are linked. Host generates the
        // seed in startMatch and broadcasts via handle.broadcastSeed.
        if (role === "host") {
          startMatch();
        }
      },
      onSeed: (seed) => {
        // Guest receives host's seed; mirror world creation.
        const stage = SIM_STAGES[state.stageId] ?? SIM_STAGES.datacenter;
        state.seed = seed;
        state.world = createStepperWorld({ stage, seed });
        state.brainP2 = null;
        state.playedAtMs = performance.now();
        state.accumMs = 0;
        state.statusMsg = "fight";
        refreshHud();
      },
      onRemoteInput: (input) => {
        state.remoteInput = input;
      },
      onClose: () => setP2PStatus("disconnected"),
    });
    state.p2p = handle;
  } catch (e) {
    setP2PStatus(`P2P error: ${e?.message ?? e}`);
  }
}

function setP2PStatus(text) {
  const el = document.getElementById("duel-p2p-status");
  if (el) el.textContent = text;
}

function switchSubMode(value) {
  if (!SUB_MODES.includes(value)) return;
  state.subMode = value;
  document.querySelectorAll(".duel-mode-row .mode-pill").forEach((p) => {
    p.classList.toggle("is-active", p.dataset.submode === value);
  });
  document.getElementById("duel-preset-row").hidden = value !== "vs-ai";
  document.getElementById("duel-p2p-row").hidden = value !== "p2p";
  refreshKeysHint();
  state.world = null;
  // Tear down any running p2p session if leaving p2p mode.
  if (value !== "p2p" && state.p2p?.stop) {
    try { state.p2p.stop(); } catch {}
    state.p2p = null;
    setP2PStatus("offline");
  }
  refreshHud();
  refocusCanvas();
}

function refreshKeysHint() {
  const el = document.getElementById("duel-keys");
  if (el) el.innerHTML = keysHtml();
}

function refocusCanvas() {
  state?.keyset.clear();
  state?.canvas?.focus();
}
