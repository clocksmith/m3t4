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
import rosterCatalog from "../content/roster-catalog.v1.json" with { type: "json" };
import gameCopy from "../content/game-copy.v1.json" with { type: "json" };
import { BODY_PORTRAIT_SHEETS, BODY_VARIANTS } from "../content/character-presentation.js";
import { startP2PDuel, isP2PSupported } from "../lib/p2p-duel.js";

const SIM_HZ = 120;
const STEP_MS = 1000 / SIM_HZ;
const MAX_CATCHUP_TICKS = 240;
const STAGE_IDS = Object.keys(STAGES);
const P2P_SPECTATOR_FRAME_STRIDE = 12;

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
const EMPTY_INPUT = Object.freeze({ left: false, right: false, up: false, down: false, action: false });
const REMOTE_INPUT_BUFFER_LIMIT = 720;

const SUB_MODES = ["vs-ai", "hot-seat", "p2p"];

const PRESET_NAMES = (presetRanking.rows ?? []).map((r) => r.name ?? r);
const DEFAULT_PRESET = PRESET_NAMES[0] ?? "standby";
const BODY_IDS = rosterCatalog.bodies ?? [];
const PLAYER_PALETTES = [
  { col: "#6ee7b7", trim: "#d1fae5", shadow: "#047857" },
  { col: "#fb923c", trim: "#fed7aa", shadow: "#9a3412" },
];

function weaponEntriesForBody(body) {
  return (rosterCatalog.weapons?.[body] ?? []).filter((weapon) => weapon.available);
}

function availableWeaponIds(body) {
  const ids = weaponEntriesForBody(body).map((weapon) => weapon.id).filter(Boolean);
  return ids.length ? ids : [""];
}

function defaultCosmetics(side) {
  const body = BODY_IDS[((side % BODY_IDS.length) + BODY_IDS.length) % BODY_IDS.length] ?? "sama";
  return { body, weapon: availableWeaponIds(body)[0] };
}

function normalizeCosmetics(value, side) {
  const fallback = defaultCosmetics(side);
  const body = BODY_IDS.includes(value?.body) ? value.body : fallback.body;
  const weapons = availableWeaponIds(body);
  const weapon = weapons.includes(value?.weapon) ? value.weapon : weapons[0];
  return { body, weapon };
}

function normalizeCosmeticsPair(value) {
  const pair = Array.isArray(value) ? value : [];
  return [normalizeCosmetics(pair[0], 0), normalizeCosmetics(pair[1], 1)];
}

function selectedCosmetics() {
  return normalizeCosmeticsPair(state?.cosmetics);
}

function bodyCopy(body) {
  const variant = BODY_VARIANTS[body];
  return gameCopy.characters?.[body]?.[variant] ?? {};
}

function bodyLabel(body) {
  return bodyCopy(body).name ?? body;
}

function bodyMeta(body) {
  return bodyCopy(body).label ?? bodyCopy(body).combatFantasy ?? body;
}

function weaponLabel(body, weapon) {
  return gameCopy.weapons?.[body]?.[weapon]?.name ?? weapon;
}

function weaponMeta(body, weapon) {
  return gameCopy.weapons?.[body]?.[weapon]?.class ?? "weapon";
}

function selectedCharacters() {
  return selectedCosmetics().map((cosmetic, side) => ({
    name: bodyLabel(cosmetic.body),
    label: weaponLabel(cosmetic.body, cosmetic.weapon),
    ...PLAYER_PALETTES[side],
    body: cosmetic.body,
    weapon: cosmetic.weapon,
  }));
}

// --- module state ---
let state = null; // populated by mount()

function freshState() {
  return {
    subMode: "vs-ai",
    stageId: STAGE_IDS.includes("datacenter") ? "datacenter" : STAGE_IDS[0],
    presetName: DEFAULT_PRESET,
    keyset: new Set(),
    touchPointers: new Map(),
    touchInput: { ...EMPTY_INPUT },
    page: null,
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
    remoteInputs: new Map(),
    lastRemoteTick: -1,
    waitingRemoteTick: null,
    hostSide: 0,      // 0 = P1, 1 = P2 (for p2p, assigned when pairing)
    spectating: false,
    spectatorFrame: null,
    lastSpectatorFrameTick: -1,
    statusMsg: "",
    cosmetics: [defaultCosmetics(0), defaultCosmetics(1)],
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
  if (e.code === "Space" && (!state.world || state.world.matchWinner !== -1)) {
    e.preventDefault();
    startMatch();
    refocusCanvas();
    return;
  }
  state.keyset.add(e.code);
  if (GAME_KEYS.has(e.code)) e.preventDefault();
}
function onKeyUp(e) {
  if (!state) return;
  state.keyset.delete(e.code);
}
function onBlur() {
  if (!state) return;
  state.keyset.clear();
  clearTouchInput();
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

function readLocalInput() {
  const keys = readKeyboard(0);
  const touch = state.touchInput ?? EMPTY_INPUT;
  return {
    left: keys.left || touch.left,
    right: keys.right || touch.right,
    up: keys.up || touch.up,
    down: keys.down || touch.down,
    action: keys.action || touch.action,
  };
}

function updateTouchInput() {
  if (!state) return;
  const active = new Set(state.touchPointers.values());
  state.touchInput = {
    left: active.has("left"),
    right: active.has("right"),
    up: active.has("up"),
    down: active.has("down"),
    action: active.has("action"),
  };
  document.querySelectorAll(".duel-touch-control").forEach((button) => {
    button.classList.toggle("is-pressed", active.has(button.dataset.touchAction));
  });
}

function clearTouchInput() {
  if (!state) return;
  state.touchPointers.clear();
  updateTouchInput();
}

function normalizeInput(input = EMPTY_INPUT) {
  return {
    left: input.left === true,
    right: input.right === true,
    up: input.up === true,
    down: input.down === true,
    action: input.action === true,
  };
}

function clearRemoteInputs() {
  if (!state) return;
  state.remoteInputs.clear();
  state.lastRemoteTick = -1;
  state.waitingRemoteTick = null;
}

function pruneRemoteInputs(currentTick) {
  if (!state || state.remoteInputs.size <= REMOTE_INPUT_BUFFER_LIMIT) return;
  for (const tick of state.remoteInputs.keys()) {
    if (tick < currentTick) state.remoteInputs.delete(tick);
    if (state.remoteInputs.size <= REMOTE_INPUT_BUFFER_LIMIT) break;
  }
}

function bufferRemoteInput(tick, input) {
  if (!state || !Number.isInteger(tick) || tick < 0) return;
  const currentTick = state.world?.tick ?? 0;
  if (tick < currentTick) return;
  state.remoteInputs.set(tick, normalizeInput(input));
  state.lastRemoteTick = Math.max(state.lastRemoteTick, tick);
  pruneRemoteInputs(currentTick);
}

// --- sim wiring ---
function freshSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

function startMatch() {
  if (!state) return;
  if (state.subMode === "p2p") {
    if (state.spectating || state.p2p?.spectator) {
      state.statusMsg = "spectating host match";
      refreshHud(state.spectatorFrame ?? emptyFrame());
      return;
    }
    if (!state.p2p?.linked) {
      state.world = null;
      state.statusMsg = state.p2p ? "waiting for opponent…" : "host or join first";
      syncPlayClass();
      refreshHud();
      return;
    }
    if (state.hostSide !== 0) {
      state.statusMsg = "waiting for host match";
      refreshHud();
      return;
    }
  }
  const stage = SIM_STAGES[state.stageId] ?? SIM_STAGES.datacenter;
  clearRemoteInputs();
  state.seed = freshSeed();
  state.world = createStepperWorld({ stage, seed: state.seed, chars: selectedCharacters() });
  state.brainP2 = state.subMode === "vs-ai"
    ? compileBrain(STRATEGIES[state.presetName] ?? STRATEGIES[DEFAULT_PRESET])
    : null;
  state.playedAtMs = performance.now();
  state.accumMs = 0;
  state.spectating = false;
  state.spectatorFrame = null;
  state.lastSpectatorFrameTick = -1;
  state.statusMsg = state.subMode === "p2p" && !state.p2p?.linked
    ? "waiting for opponent…"
    : "fight";
  if (state.p2p?.linked && typeof state.p2p.broadcastMatch === "function") {
    state.p2p.broadcastMatch({ seed: state.seed, stageId: state.stageId, cosmetics: selectedCosmetics() });
    state.p2p.postSpectatorFrame?.(worldToFrame(state.world));
  }
  syncPlayClass();
  refreshHud();
}

function actionFor(slot) {
  if (state.subMode === "vs-ai") {
    if (slot === 0) return readLocalInput();
    return runBrainForWorld(state.world, state.brainP2, 1);
  }
  if (state.subMode === "hot-seat") {
    if (slot === 0) return readLocalInput();
    return readKeyboard(slot);
  }
  // p2p: local human drives one side, remote input drives the other.
  if (slot === state.hostSide) return readLocalInput();
  return EMPTY_INPUT;
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
    let actA;
    let actB;
    if (state.subMode === "p2p") {
      if (!state.p2p?.linked) {
        state.statusMsg = "waiting for opponent…";
        break;
      }
      const tick = state.world.tick >>> 0;
      const localAct = readLocalInput();
      state.p2p.sendInput(tick, localAct);
      const remoteAct = state.remoteInputs.get(tick);
      if (!remoteAct) {
        state.waitingRemoteTick = tick;
        state.statusMsg = `waiting for ${state.hostSide === 0 ? "P2" : "host"} input @${tick}`;
        break;
      }
      state.remoteInputs.delete(tick);
      state.waitingRemoteTick = null;
      state.statusMsg = "fight";
      actA = state.hostSide === 0 ? localAct : remoteAct;
      actB = state.hostSide === 1 ? localAct : remoteAct;
    } else {
      actA = actionFor(0);
      actB = actionFor(1);
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
    const frame = (state.subMode === "p2p" && (state.spectating || state.p2p?.spectator))
      ? (state.spectatorFrame ?? emptyFrame())
      : (step(performance.now()) ?? emptyFrame());
    maybePostSpectatorFrame(frame);
    state.renderer.drawFrame(stage, frame, labels());
    refreshHud(frame);
  }
  state.rafId = requestAnimationFrame(loop);
}

function maybePostSpectatorFrame(frame) {
  if (state.subMode !== "p2p" || state.hostSide !== 0 || state.p2p?.spectator) return;
  if (!state.p2p?.linked || !state.world || !frame) return;
  const tick = Number(frame.tick ?? -1);
  if (!Number.isInteger(tick) || tick < 0) return;
  if (tick === state.lastSpectatorFrameTick || tick % P2P_SPECTATOR_FRAME_STRIDE !== 0) return;
  state.lastSpectatorFrameTick = tick;
  state.p2p.postSpectatorFrame?.(frame);
}

function emptyFrame() {
  return {
    tick: 0, roundStartTick: 0,
    p0: { x: 300, y: 612, vx: 0, vy: 0, facing: 1, onGround: true, wall: 0, stun: 0, swipeT: 0, diveT: 0, lastClashTick: -9999, dead: false },
    p1: { x: 980, y: 612, vx: 0, vy: 0, facing: -1, onGround: true, wall: 0, stun: 0, swipeT: 0, diveT: 0, lastClashTick: -9999, dead: false },
    token: { exists: false, x: 0, y: 0, carrier: -1, dwellT: 0 },
    goal: { exists: false, x: 0, y: 0, label: "", timer: 0 },
    scoreboard: [0, 0],
    rounds: [0, 0],
  };
}

function labels() {
  const cosmetics = selectedCosmetics();
  if (state.subMode === "vs-ai") return { p1: "you", p2: state.presetName, cosmetics };
  if (state.subMode === "hot-seat") return { p1: "P1", p2: "P2", cosmetics };
  if (state.spectating || state.p2p?.spectator) return { p1: "host", p2: "player", cosmetics };
  return state.hostSide === 0
    ? { p1: "you", p2: "P2", cosmetics }
    : { p1: "host", p2: "you", cosmetics };
}

// --- HUD ---
function refreshHud(frame = state.world ? worldToFrame(state.world) : emptyFrame()) {
  const score = state.world
    ? `${state.world.fighters[0].score}-${state.world.fighters[1].score}`
    : Array.isArray(frame?.scoreboard)
      ? `${frame.scoreboard[0] ?? 0}-${frame.scoreboard[1] ?? 0}`
    : "0-0";
  const rounds = state.world
    ? `${state.world.fighters[0].rounds}-${state.world.fighters[1].rounds}`
    : Array.isArray(frame?.rounds)
      ? `${frame.rounds[0] ?? 0}-${frame.rounds[1] ?? 0}`
    : "0-0";
  setText("duel-stat-tick", String(frame?.tick ?? 0));
  setText("duel-stat-score", score);
  setText("duel-stat-rounds", rounds);
  setText("duel-stat-seed", state.seed ? String(state.seed) : "—");
  setText("duel-status", duelStatusText());
}

function startPrompt() {
  // Coarse pointer = touch-first device; show tap copy. Desktop falls
  // through to spacebar copy. Cached lookups would be brittle if the
  // user drags between displays, so we re-check on each call (cheap).
  if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) {
    return "tap to fight";
  }
  return "press space to fight";
}

function duelStatusText() {
  if (state.spectating || state.p2p?.spectator) return state.statusMsg || "spectating";
  if (!state.world) return state.statusMsg || startPrompt();
  if (state.world.matchWinner !== -1) {
    const w = state.world.matchWinner;
    return `${w === 0 ? labels().p1 : labels().p2} wins · ${startPrompt()} again`;
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

function characterSelectHtml() {
  const cosmetics = selectedCosmetics();
  return cosmetics.map((cosmetic, side) => `
    <div class="duel-fighter-slot" data-side="${side}">
      <div class="duel-fighter-head">
        <span class="duel-fighter-kicker">P${side + 1}</span>
        <strong>${escapeHtml(bodyLabel(cosmetic.body))}</strong>
        <span>${escapeHtml(weaponLabel(cosmetic.body, cosmetic.weapon))}</span>
      </div>
      <div class="duel-body-grid" aria-label="P${side + 1} character select">
        ${BODY_IDS.map((body) => {
          const selected = body === cosmetic.body;
          return `
            <button type="button" class="duel-body-option${selected ? " is-selected" : ""}" data-side="${side}" data-body="${escapeHtml(body)}" title="${escapeHtml(bodyMeta(body))}">
              ${bodyPortraitHtml(body)}
              <span>${escapeHtml(bodyLabel(body))}</span>
            </button>`;
        }).join("")}
      </div>
      <div class="duel-weapon-grid" aria-label="P${side + 1} weapon select">
        ${weaponEntriesForBody(cosmetic.body).map((weapon) => {
          const selected = weapon.id === cosmetic.weapon;
          return `
            <button type="button" class="duel-weapon-option${selected ? " is-selected" : ""}" data-side="${side}" data-weapon="${escapeHtml(weapon.id)}">
              ${weaponOptionVisualHtml(cosmetic.body, weapon)}
              <span class="duel-weapon-copy">
                <span class="duel-weapon-name">${escapeHtml(weaponLabel(cosmetic.body, weapon.id))}</span>
                <span class="duel-weapon-meta">${escapeHtml(weaponMeta(cosmetic.body, weapon.id))}</span>
              </span>
            </button>`;
        }).join("")}
      </div>
    </div>`).join("");
}

function bodyPortraitHtml(body) {
  const url = BODY_PORTRAIT_SHEETS[body];
  const style = url ? ` style="background-image:url('${escapeHtml(url)}')"` : "";
  return `<span class="duel-body-portrait"${style} aria-hidden="true"></span>`;
}

function weaponOptionVisualHtml(body, weapon) {
  const spriteStyle = weaponSpriteStyle(body, weapon.asset);
  return `
    <span class="duel-weapon-visual" aria-hidden="true">
      <span class="duel-weapon-sprite${spriteStyle ? "" : " is-missing"}"${spriteStyle ? ` style="${spriteStyle}"` : ""}></span>
    </span>`;
}

function weaponSpriteStyle(body, asset) {
  if (!asset?.url) return "";
  const cols = Math.max(1, Number(asset.cols ?? 1) || 1);
  const cell = Math.max(0, Number(asset.cell ?? 0) || 0);
  const rows = weaponSheetRows(body, asset, cols);
  const col = cell % cols;
  const row = Math.floor(cell / cols);
  const x = cols > 1 ? (col / (cols - 1)) * 100 : 0;
  const y = rows > 1 ? (row / (rows - 1)) * 100 : 0;
  return [
    `background-image:url('${escapeHtml(asset.url)}')`,
    `background-size:${cols * 100}% ${rows * 100}%`,
    `background-position:${x}% ${y}%`,
  ].join(";");
}

function weaponSheetRows(body, asset, cols) {
  const maxCell = weaponEntriesForBody(body)
    .filter((weapon) => weapon.asset?.url === asset.url)
    .reduce((max, weapon) => Math.max(max, Number(weapon.asset?.cell ?? 0) || 0), Number(asset.cell ?? 0) || 0);
  return Math.max(1, Math.floor(maxCell / cols) + 1);
}

function controlsCardHtml() {
  return `
    <div class="duel-controls">
      ${subModeRowHtml()}
      <div class="duel-character-select" id="duel-character-select">
        ${characterSelectHtml()}
      </div>

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
    <div class="duel-p2p-warning tight">
      first joiner plays P2. later joiners spectate. STUN only; some NATs will not pair.
    </div>
    <div class="duel-p2p-row">
      ${buttonHtml({ id: "duel-p2p-host", text: "host", attrs: { title: "Create a session and share the invite link" } })}
      <span class="duel-p2p-divider">or</span>
      <input type="text" id="duel-p2p-code" placeholder="paste invite link" autocomplete="off" spellcheck="false" />
      ${buttonHtml({ id: "duel-p2p-join", text: "join", attrs: { title: "Join an existing session" } })}
    </div>
    <div class="duel-p2p-share" id="duel-p2p-share" hidden></div>
    <div class="duel-p2p-status tight" id="duel-p2p-status">ready: host or paste invite link</div>`;
}

function controlCardHtml({ role, owner, keyboard, touch = false, remote = false }) {
  return `
    <span class="duel-key-card${remote ? " is-remote" : ""}">
      <b>${escapeHtml(role)}</b>
      <span>${escapeHtml(owner)}</span>
      <span>${escapeHtml(keyboard)}</span>
      ${touch ? `<span class="duel-touch-hint">touch D-pad + strike</span>` : ""}
    </span>`;
}

function keysHtml() {
  if (state.subMode === "vs-ai") {
    return `
      ${controlCardHtml({ role: "P1", owner: "you", keyboard: "W/A/S/D + F", touch: true })}
      ${controlCardHtml({ role: "P2", owner: "AI opponent", keyboard: "no local controls", remote: true })}`;
  }
  if (state.subMode === "hot-seat") {
    return `
      ${controlCardHtml({ role: "P1", owner: "local player", keyboard: "W/A/S/D + F", touch: true })}
      ${controlCardHtml({ role: "P2", owner: "same device", keyboard: "P/L/;/' + [", remote: true })}`;
  }
  if (state.spectating || state.p2p?.spectator) {
    return `
      ${controlCardHtml({ role: "spectator", owner: "watching this match", keyboard: "no controls", remote: true })}
      ${controlCardHtml({ role: "players", owner: "host + P2", keyboard: "their W/A/S/D + F or touch", remote: true })}`;
  }
  const paired = !!state.p2p;
  const role = state.hostSide === 1 ? "P2" : "P1";
  const owner = paired
    ? "you on this device"
    : "host is P1, joiner is P2";
  const peerRole = paired && state.hostSide === 0 ? "P2" : "host";
  return `
    ${controlCardHtml({ role, owner, keyboard: "W/A/S/D + F", touch: true })}
    ${controlCardHtml({ role: paired ? peerRole : "peer", owner: "their device", keyboard: "their W/A/S/D + F or touch", remote: true })}`;
}

function statsListHtml() {
  return `
    <div class="duel-stats" aria-live="polite">
      <span class="stat"><span class="stat-label">tick</span><span class="stat-value" id="duel-stat-tick">0</span></span>
      <span class="stat"><span class="stat-label">score</span><span class="stat-value" id="duel-stat-score">0-0</span></span>
      <span class="stat"><span class="stat-label">rounds</span><span class="stat-value" id="duel-stat-rounds">0-0</span></span>
      <span class="stat"><span class="stat-label">seed</span><span class="stat-value" id="duel-stat-seed">—</span></span>
      <span class="stat duel-status"><span class="stat-label">status</span><span class="stat-value" id="duel-status">${escapeHtml(startPrompt())}</span></span>
    </div>`;
}

function touchControlsHtml() {
  return `
    <div class="duel-touch-controls" id="duel-touch-controls" aria-label="touch controls">
      <div class="duel-touch-pad" aria-label="move">
        <button type="button" class="duel-touch-control is-up" data-touch-action="up" aria-label="jump">UP</button>
        <button type="button" class="duel-touch-control is-left" data-touch-action="left" aria-label="move left">LEFT</button>
        <button type="button" class="duel-touch-control is-down" data-touch-action="down" aria-label="drop">DOWN</button>
        <button type="button" class="duel-touch-control is-right" data-touch-action="right" aria-label="move right">RIGHT</button>
      </div>
      <div class="duel-touch-actions" aria-label="actions">
        <button type="button" class="duel-touch-control is-action" data-touch-action="action" aria-label="strike">STRIKE</button>
      </div>
    </div>
    <button type="button" class="duel-touch-setup" id="duel-touch-setup">setup</button>`;
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
        autoHeight: true,
      })}
      <section class="panel canvas-panel">
        <canvas id="duel-canvas" class="u-canvas-fill" width="${W}" height="${H}" tabindex="0"></canvas>
        ${statsListHtml()}
        ${touchControlsHtml()}
      </section>
    </div>`;

  state.page = root.querySelector(".duel-page");
  state.canvas = root.querySelector("#duel-canvas");
  document.body.classList.add("duel-mounted");
  void attachRenderer(state.canvas);
  refreshKeysHint();
  bindControls();
  applyJoinLinkFromLocation();

  // Tap the canvas to start a fresh match when nothing is running.
  // Mirrors the spacebar shortcut for touch users.
  state.canvas.addEventListener("click", () => {
    if (!state.world || state.world.matchWinner !== -1) {
      startMatch();
    }
    refocusCanvas();
  });

  addEventListener("keydown", onKeyDown);
  addEventListener("keyup", onKeyUp);
  addEventListener("blur", onBlur);
  addEventListener("hashchange", onHashChange);

  state.running = true;
  syncPlayClass();
  loop();
  refreshHud();
}

export function unmount() {
  removeEventListener("keydown", onKeyDown);
  removeEventListener("keyup", onKeyUp);
  removeEventListener("blur", onBlur);
  removeEventListener("hashchange", onHashChange);
  if (state) {
    state.running = false;
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.renderer?.destroy();
    state.renderer = null;
    clearTouchInput();
    if (state.p2p?.stop) {
      try { state.p2p.stop(); } catch {}
    }
    state.p2p = null;
  }
  document.body.classList.remove("duel-mounted", "duel-match-active");
  state = null;
}

function onHashChange() {
  applyJoinLinkFromLocation();
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
    state.spectating = false;
    state.spectatorFrame = null;
    state.statusMsg = "";
    clearRemoteInputs();
    syncPlayClass();
    refreshHud();
    refocusCanvas();
  });
  const presetSel = document.getElementById("duel-preset");
  presetSel?.addEventListener("change", () => {
    state.presetName = presetSel.value;
    state.world = null;
    state.spectating = false;
    state.spectatorFrame = null;
    state.statusMsg = "";
    clearRemoteInputs();
    syncPlayClass();
    refreshHud();
    refocusCanvas();
  });
  document.getElementById("duel-start")?.addEventListener("click", () => {
    startMatch();
    refocusCanvas();
  });
  document.getElementById("duel-reset")?.addEventListener("click", () => {
    state.world = null;
    state.spectating = false;
    state.spectatorFrame = null;
    state.statusMsg = "";
    clearRemoteInputs();
    syncPlayClass();
    refreshHud();
    refocusCanvas();
  });
  document.getElementById("duel-touch-setup")?.addEventListener("click", () => {
    state.world = null;
    state.spectating = false;
    state.spectatorFrame = null;
    state.statusMsg = "";
    clearRemoteInputs();
    clearTouchInput();
    syncPlayClass();
    refreshHud();
  });

  bindCharacterSelect();
  bindP2PControls();
  bindTouchControls();
}

function bindTouchControls() {
  const el = document.getElementById("duel-touch-controls");
  if (!el) return;

  const releasePointer = (event) => {
    if (!state) return;
    state.touchPointers.delete(event.pointerId);
    updateTouchInput();
  };

  el.addEventListener("pointerdown", (event) => {
    const button = event.target instanceof Element ? event.target.closest(".duel-touch-control") : null;
    const action = button?.dataset.touchAction;
    if (!action) return;
    event.preventDefault();
    try { button.setPointerCapture?.(event.pointerId); } catch {}
    state.touchPointers.set(event.pointerId, action);
    updateTouchInput();
  });
  el.addEventListener("pointerup", releasePointer);
  el.addEventListener("pointercancel", releasePointer);
  el.addEventListener("lostpointercapture", releasePointer);
  el.addEventListener("contextmenu", (event) => event.preventDefault());
}

function bindCharacterSelect() {
  const el = document.getElementById("duel-character-select");
  el?.addEventListener("click", (event) => {
    const bodyButton = event.target instanceof Element ? event.target.closest(".duel-body-option") : null;
    const weaponButton = event.target instanceof Element ? event.target.closest(".duel-weapon-option") : null;
    const button = bodyButton ?? weaponButton;
    if (!button) return;
    const side = Number(button.dataset.side);
    if (!Number.isInteger(side) || side < 0 || side > 1) return;

    if (bodyButton) {
      const body = BODY_IDS.includes(bodyButton.dataset.body) ? bodyButton.dataset.body : defaultCosmetics(side).body;
      state.cosmetics[side] = normalizeCosmetics({ body, weapon: availableWeaponIds(body)[0] }, side);
    } else if (weaponButton) {
      const current = normalizeCosmetics(state.cosmetics[side], side);
      const weapons = availableWeaponIds(current.body);
      const weapon = weapons.includes(weaponButton.dataset.weapon) ? weaponButton.dataset.weapon : current.weapon;
      state.cosmetics[side] = normalizeCosmetics({ ...current, weapon }, side);
    }

    state.world = null;
    state.spectating = false;
    state.spectatorFrame = null;
    state.statusMsg = "";
    clearRemoteInputs();
    syncPlayClass();
    renderCharacterSelect();
    refreshHud();
    refocusCanvas();
  });
}

function renderCharacterSelect() {
  const el = document.getElementById("duel-character-select");
  if (el) el.innerHTML = characterSelectHtml();
}

function joinCodeFromParts(search, hash) {
  const fromSearch = new URLSearchParams(search || "").get("join");
  if (fromSearch) return fromSearch.trim();

  const rawHash = String(hash || "").replace(/^#/, "").trim();
  if (!rawHash) return "";
  const hashParams = new URLSearchParams(rawHash.startsWith("?") ? rawHash.slice(1) : rawHash);
  const fromHash = hashParams.get("join");
  if (fromHash) return fromHash.trim();
  if (!rawHash.includes("=") && rawHash.length > 8) return rawHash;
  return "";
}

function normalizeJoinCode(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text, window.location.origin);
    const code = joinCodeFromParts(url.search, url.hash);
    if (code) return code;
  } catch {}
  if (text.startsWith("#") || text.startsWith("?")) {
    const code = joinCodeFromParts(text.startsWith("?") ? text : "", text.startsWith("#") ? text : "");
    if (code) return code;
  }
  return text;
}

function joinCodeFromLocation() {
  return normalizeJoinCode(`${window.location.search}${window.location.hash}`);
}

function duelShareUrl(sessionId) {
  const url = new URL("/duel", window.location.origin);
  url.hash = `join=${encodeURIComponent(sessionId)}`;
  return url.toString();
}

function applyJoinLinkFromLocation() {
  if (!state) return;
  const code = joinCodeFromLocation();
  if (!code) return;
  if (state.subMode !== "p2p") switchSubMode("p2p");
  const codeInp = document.getElementById("duel-p2p-code");
  if (codeInp) codeInp.value = code;
  state.statusMsg = "join link ready";
  setP2PStatus("link loaded — sign in, then join");
  refreshHud();
}

function bindP2PControls() {
  const hostBtn = document.getElementById("duel-p2p-host");
  const joinBtn = document.getElementById("duel-p2p-join");
  const codeInp = document.getElementById("duel-p2p-code");
  hostBtn?.addEventListener("click", () => beginP2P("host"));
  joinBtn?.addEventListener("click", () => {
    const code = normalizeJoinCode(codeInp?.value || "");
    if (!code) {
      setP2PStatus("paste a link first");
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
  // Force the sub-mode to p2p so labels, character panel, control
  // hints, and the actionFor branch all switch off vs-AI / hot-seat
  // copy. Without this, an in-flight vs-AI render state can persist
  // through a paired channel because every UI gating selector reads
  // state.subMode, not state.p2p.
  if (state.subMode !== "p2p") switchSubMode("p2p");
  if (state.p2p?.stop) {
    try { state.p2p.stop(); } catch {}
  }
  state.p2p = null;
  state.spectating = false;
  state.spectatorFrame = null;
  state.lastSpectatorFrameTick = -1;
  state.world = null;
  state.brainP2 = null;
  clearRemoteInputs();
  state.hostSide = role === "host" ? 0 : 1;
  clearP2PShare();
  refreshKeysHint();
  setP2PStatus(role === "host" ? "creating session…" : "connecting…");
  try {
    const handle = await startP2PDuel({
      role,
      sessionId,
      onStatus: (msg) => handleP2PStatus(msg),
      onLink: (link = {}) => {
        if (link.spectator) {
          state.spectating = true;
          state.hostSide = 0;
          setP2PStatus("spectating");
          state.statusMsg = "spectating";
          refreshKeysHint();
          syncPlayClass();
          refreshHud(state.spectatorFrame ?? emptyFrame());
          return;
        }
        setP2PStatus(role === "host" ? "P2 joined" : "joined host");
        // Defensive UI refresh: keysHtml + character panel are only
        // re-rendered via explicit calls (the render loop reads labels
        // every frame, but the surrounding control DOM doesn't). After
        // pairing we want both sides to visibly drop any vs-AI / hot-
        // seat copy.
        refreshKeysHint();
        renderCharacterSelect();
        // Start a match when both sides are linked. Host generates the
        // seed + stage in startMatch and broadcasts via handle.broadcastMatch.
        if (role === "host") {
          startMatch();
        }
      },
      onMatch: ({ seed, stageId, cosmetics }) => {
        if (role === "host") return;
        // Guest mirrors host's match parameters so both worlds start
        // from the same seed *and* the same stage.
        clearRemoteInputs();
        if (stageId && STAGE_IDS.includes(stageId)) {
          state.stageId = stageId;
          const stageSel = document.getElementById("duel-stage");
          if (stageSel) stageSel.value = stageId;
        }
        state.cosmetics = normalizeCosmeticsPair(cosmetics);
        renderCharacterSelect();
        if (state.spectating || state.p2p?.spectator) {
          state.seed = seed;
          state.world = null;
          state.statusMsg = "spectating";
          syncPlayClass();
          refreshHud(state.spectatorFrame ?? emptyFrame());
          return;
        }
        const stage = SIM_STAGES[state.stageId] ?? SIM_STAGES.datacenter;
        state.seed = seed;
        state.world = createStepperWorld({ stage, seed, chars: selectedCharacters() });
        state.brainP2 = null;
        state.playedAtMs = performance.now();
        state.accumMs = 0;
        state.statusMsg = "fight";
        syncPlayClass();
        refreshHud();
      },
      onRemoteInput: (tick, input) => {
        bufferRemoteInput(tick, input);
      },
      onFrame: (frame) => {
        state.spectating = true;
        state.spectatorFrame = frame;
        state.statusMsg = "spectating";
        syncPlayClass();
        refreshHud(frame);
      },
      onSpectatorLink: () => {
        if (!state.world || !state.p2p?.linked) return;
        state.p2p.broadcastMatch?.({ seed: state.seed, stageId: state.stageId, cosmetics: selectedCosmetics() });
        state.p2p.postSpectatorFrame?.(worldToFrame(state.world));
      },
      onClose: () => setP2PStatus("disconnected"),
    });
    state.p2p = handle;
    if (handle.spectator) {
      state.spectating = true;
      state.hostSide = 0;
      state.statusMsg = "spectating";
      setP2PStatus("spectating");
    }
    refreshKeysHint();
    syncPlayClass();
  } catch (e) {
    const message = String(e?.message ?? e);
    if (/sign in (first|required)/i.test(message)) {
      setP2PStatus(message);
    } else {
      setP2PStatus(`P2P error: ${message}`);
    }
  }
}

function setP2PStatus(text) {
  const el = document.getElementById("duel-p2p-status");
  if (el) el.textContent = text;
}

function handleP2PStatus(text) {
  const match = /^code:\s*(.+)$/i.exec(String(text || ""));
  if (match) {
    const sessionId = match[1].trim();
    renderP2PShare(sessionId);
    setP2PStatus("magic link ready");
    return;
  }
  setP2PStatus(text);
}

function renderP2PShare(sessionId) {
  const el = document.getElementById("duel-p2p-share");
  if (!el || !sessionId) return;
  const url = duelShareUrl(sessionId);
  el.hidden = false;
  el.innerHTML = `
    <label class="duel-p2p-link-label">invite link
      <input type="text" id="duel-p2p-link" readonly value="${escapeHtml(url)}" />
    </label>
    ${buttonHtml({ id: "duel-p2p-copy-link", text: "copy link", attrs: { title: "Copy the invite link" } })}`;
  document.getElementById("duel-p2p-copy-link")?.addEventListener("click", () => {
    void copyP2PLink(url);
  });
}

function clearP2PShare() {
  const el = document.getElementById("duel-p2p-share");
  if (!el) return;
  el.hidden = true;
  el.innerHTML = "";
}

async function copyP2PLink(url) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      setP2PStatus("link copied");
      return;
    }
  } catch {}
  const input = document.getElementById("duel-p2p-link");
  if (input?.select) {
    input.select();
    try {
      document.execCommand("copy");
      setP2PStatus("link copied");
      return;
    } catch {}
  }
  setP2PStatus("copy failed — select the link");
}

function switchSubMode(value) {
  if (!SUB_MODES.includes(value)) return;
  state.subMode = value;
  document.querySelectorAll(".duel-mode-row .mode-pill").forEach((p) => {
    p.classList.toggle("is-active", p.dataset.submode === value);
  });
  document.querySelectorAll('input[name="duel-submode"]').forEach((inp) => {
    inp.checked = inp.value === value;
  });
  document.getElementById("duel-preset-row").hidden = value !== "vs-ai";
  document.getElementById("duel-p2p-row").hidden = value !== "p2p";
  if (value !== "p2p") clearP2PShare();
  refreshKeysHint();
  state.world = null;
  state.spectating = false;
  state.spectatorFrame = null;
  state.lastSpectatorFrameTick = -1;
  state.statusMsg = "";
  clearRemoteInputs();
  clearTouchInput();
  syncPlayClass();
  // Tear down any running p2p session if leaving p2p mode.
  if (value !== "p2p" && state.p2p?.stop) {
    try { state.p2p.stop(); } catch {}
    state.p2p = null;
    setP2PStatus("ready: host or paste invite link");
  }
  refreshHud();
  refocusCanvas();
}

function refreshKeysHint() {
  const el = document.getElementById("duel-keys");
  if (el) el.innerHTML = keysHtml();
}

function syncPlayClass() {
  const playing = !!state?.world || !!state?.spectating;
  state?.page?.classList.toggle("is-playing", playing);
  document.body.classList.toggle("duel-match-active", playing);
}

function refocusCanvas() {
  state?.keyset.clear();
  state?.canvas?.focus();
}
