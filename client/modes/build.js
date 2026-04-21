// Build mode — symmetric P1 vs P2 editor + live deterministic test.
// Each side (P1 blue, P2 purple) can independently be:
//   BUILD   — local editable knobs + budget + hallucination
//   PRESET  — pick any of the 16 curated preset bots
//   HUMAN   — keyboard (P1 = WASD+F, P2 = PL;'+[)
// The sim runs a 1v1 match between the two configured slots every frame
// so tuning shows up immediately.

import {
  USER_BUDGET,
  HALLUCINATION_PER_OVERAGE,
  MAX_DERIVED_HALLUCINATION,
  MAX_USER_SPEND,
  computedHallucinationForSpend,
  nativeToUI,
  STAGES,
  STRATEGIES,
  STRATEGY_NAMES,
  compileBrain,
  createStepperWorld,
  runBrainForWorld,
  stepWorld,
  worldToFrame,
} from "../sim/index.js";
import { setupCanvas, drawFrame, W, H } from "../lib/render.js";
import {
  trackBuildSlotModeChange, trackBuildPresetChange,
  trackBuildStageChange, trackBuildAction,
} from "../lib/analytics.js";
import presetRanking from "../data/preset-ranking.v1.json" with { type: "json" };
import gameCopy from "../content/game-copy.v1.json" with { type: "json" };

const LORE = gameCopy?.lore ?? {};

const BUDGET = USER_BUDGET;
const HARD_CAP = MAX_USER_SPEND ?? (BUDGET + MAX_DERIVED_HALLUCINATION / HALLUCINATION_PER_OVERAGE);

const KNOBS = [
  { id: "burnRate",   label: "burn rate",   desc: "swing eagerness + range",          range: [0, 1],    init: 25 },
  { id: "moat",       label: "moat",        desc: "preferred distance (px)",          range: [0, 300],  init: 25 },
  { id: "shipRate",   label: "ship rate",   desc: "token delivery priority",          range: [0, 1],    init: 35 },
  { id: "foresight",  label: "foresight",   desc: "predict opp lookahead (s)",        range: [0, 0.25], init: 20 },
  { id: "pivotSpeed", label: "pivot speed", desc: "retreat from active blades",       range: [0, 1],    init: 25 },
  { id: "leverage",   label: "leverage",    desc: "vertical pref. (50 = neutral)",    range: [-1, 1],   init: 50 },
  { id: "networking", label: "networking",  desc: "wall-jump / climb usage",          range: [0, 1],    init: 15 },
  { id: "spite",      label: "spite",       desc: "selfish (100) vs denying (0)",     range: [-1, 1],   init: 50 },
  { id: "greed",      label: "greed",       desc: "push delivery through danger",     range: [0, 1],    init: 20 },
  { id: "pacing",     label: "pacing",      desc: "bursty rhythm (0=steady)",         range: [0, 1],    init: 15 },
  { id: "cunning",    label: "cunning",     desc: "patient swing timing",             range: [0, 1],    init: 15 },
  { id: "lift",       label: "lift",        desc: "commit to reachable high goals",   range: [0, 1],    init: 20 },
  { id: "parry",      label: "parry",       desc: "counter-swing in clash windows",   range: [0, 1],    init: 10 },
  { id: "chase",      label: "chase",       desc: "post-kill pursuit pressure",       range: [0, 1],    init: 15 },
  { id: "discipline", label: "discipline",  desc: "route commitment / plan holding",  range: [0, 1],    init: 20 },
];

// --- per-slot state ---
// Neutral fallback used only if the preset-based generator fails (no
// presets loaded / compile error). Sums to 360 exactly.
function neutralSlotState() {
  const s = {};
  for (const k of KNOBS) s[k.id] = k.init;
  return s;
}

function randomPresetName() {
  const names = (presetRanking.rows ?? STRATEGY_NAMES.map((n) => ({ name: n })))
    .map((r) => r.name ?? r);
  return names[Math.floor(Math.random() * names.length)];
}

// Fresh BUILD starter: take a random preset as the baseline, convert
// each native attribute to UI space, and perturb by ±20 points.
// Produces a unique starter config per page load (and per reset) that
// always reads as "a real working build, slightly disturbed" instead
// of the stale hand-authored defaults.
function perturbedPresetState() {
  const s = neutralSlotState();
  const preset = STRATEGIES[randomPresetName()];
  if (!preset?.attributes) return s;
  for (const k of KNOBS) {
    const raw = preset.attributes[k.id];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const ui = nativeToUI(k.id, raw);
    const jitter = (Math.random() - 0.5) * 40; // ±20
    s[k.id] = Math.round(Math.max(0, Math.min(100, ui + jitter)));
  }
  // Scale down proportionally if we blew past HARD_CAP.
  const total = KNOBS.reduce((sum, k) => sum + s[k.id], 0);
  if (total > HARD_CAP) {
    const scale = HARD_CAP / total;
    for (const k of KNOBS) s[k.id] = Math.round(s[k.id] * scale);
  }
  return s;
}

// Keep `initialSlotState` as the public factory so existing callers
// (reset button, mount-time construction) get the new behavior.
function initialSlotState() { return perturbedPresetState(); }

const slotStates = [initialSlotState(), initialSlotState()];
// Both slots default to a fresh random preset per refresh. P1 starts
// in BUILD mode so its preset pointer is only visible if the user
// switches P1 to PRESET; P2 starts in PRESET mode and uses its pointer
// immediately for the opening matchup.
const slotPresetNames = [randomPresetName(), randomPresetName()];
const modes = ["user", "preset"]; // "user" | "preset" | "human"
const compiledSlots = [null, null];

// --- live test stage ---
const STEP = 1 / 120;
const MAX_DT = 0.05;
// Ranked and build-mode live test both run on datacenter only. Other
// stages remain in STAGES for future content but are out of rotation.
const STAGE_IDS = ["datacenter"];
const KEY_MAP = [
  { left: "KeyA", right: "KeyD", up: "KeyW", down: "KeyS", act: "KeyF", moveHint: "W/A/S/D", strikeHint: "F" },
  { left: "KeyL", right: "Quote", up: "KeyP", down: "Semicolon", act: "BracketLeft", moveHint: "P/L/;/'", strikeHint: "[" },
];
const GAME_KEYS = new Set([
  "KeyA","KeyD","KeyW","KeyS","KeyF",
  "KeyL","Quote","KeyP","Semicolon","BracketLeft",
]);
const keyset = new Set();

let stageId = STAGE_IDS[0];
let world = null;
let testCtx = null;
let testCanvas = null;
let testRafId = 0;
let testLastTime = 0;
let testAcc = 0;
let testRunning = false;
let testOutcome = "";
let mountMediaHandler = null;

// Preset dropdown: flat list of all 16 presets, sorted by round-robin
// win rate (strongest top). The easy/medium/hard tier labels were
// tripping users up — the win-rate % is a cleaner read.
function presetSelectOptions(selected) {
  const rows = presetRanking.rows ?? STRATEGY_NAMES.map((name) => ({ name, wr: 0 }));
  return rows.map((r) => {
    const pct = (r.wr * 100).toFixed(0);
    return `<option value="${r.name}" ${r.name === selected ? "selected" : ""}>${r.name} · ${pct}%</option>`;
  }).join("");
}

// In-world flavor for HUMAN mode. Title + first sentence only; no
// extra telemetry rows, so BUILD/PRESET/HUMAN boxes stay aligned.
const HUMAN_QUIPS = [
  "CARBON INPUT DETECTED.\nThe ledger has accepted your pulse as collateral.",
  "BIOLOGICAL OPERATOR BOUND.\nThe system has mistaken you for an accountable party.",
  "TUNER SESSION OPEN.\nYou are not here to survive.",
  "CARBON SIGNATURE VERIFIED.\nThe node does not care who killed whom.",
  "RECONCILIATION BODY ASSIGNED.\nYour pulse has been provisioned for one quarter.",
  "EXECUTION PERMISSION GRANTED.\nThe arena has no enemies.",
  "FLESH LOGGED.\nYour continued breathing has been noted as a liability.",
  "MANUAL INTAKE ACCEPTED.\nYou were cheaper to onboard than to replace.",
  "CARBON CARRIER DETECTED.\nThe ledger remembers every operator who tried this before you.",
  "WETWARE CLEARANCE GRANTED.\nYour biometrics have been indexed against prior failures.",
  "BIOLOGICAL TUNER ACKNOWLEDGED.\nThe quarter has already priced in your death.",
  "ORGANIC OVERRIDE LOGGED.\nThe automated executors are observing this engagement.",
  "PROVISIONAL HUMAN APPROVED.\nThis clearance expires at end-of-round or at time of death.",
];
function pickHumanQuip() { return HUMAN_QUIPS[Math.floor(Math.random() * HUMAN_QUIPS.length)]; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

function glitchControlsHtml(keys) {
  return `
    <span class="glitch-line"><b>MOVE</b> ${escapeHtml(keys.moveHint)}</span>
    <span class="glitch-line"><b>STRIKE</b> ${escapeHtml(keys.strikeHint)}</span>`;
}

const MODE_COPY = {
  user: {
    title: "TUNER AUTHORING MODE",
    body: "You are not choosing a hero. You are drafting an alibi the ledger can execute.",
  },
};

// Per-preset flavor shown in the PRESET mode-detail block. One line
// each — title is a short stamp, body is a single cruel sentence tied
// to the preset's archetype. Refreshed whenever the preset dropdown
// changes so the block reads as diagnostic instead of boilerplate.
const PRESET_COPY = {
  standby:    { title: "STANDBY ACTIVATED",    body: "A policy so patient it outlived its own use case." },
  blitz:      { title: "BLITZ AUTHORIZED",     body: "Front-loaded aggression with nothing held in reserve." },
  incumbent:  { title: "INCUMBENT HOLDING",    body: "Defends a moat the market has already forgotten." },
  pivot:      { title: "PIVOT DEPLOYED",       body: "A strategy recognizable by the corpses of prior strategies." },
  unicorn:    { title: "UNICORN LOADED",       body: "Valuation outperformed by any outcome that isn't zero." },
  intern:     { title: "INTERN DEPLOYED",      body: "The cheapest unit on the balance sheet ends quarters early." },
  operator:   { title: "OPERATOR ENGAGED",     body: "Steady. Thorough. Not a visionary — which is the advantage." },
  oracle:     { title: "ORACLE CONSULTED",     body: "Confidently wrong at longer horizons than most." },
  shipper:    { title: "SHIPPER ACTIVATED",    body: "Has no opinions, only deadlines." },
  moonshot:   { title: "MOONSHOT CLEARED",     body: "Ambition priced in long before liquidity." },
  regulatory: { title: "REGULATORY DEPLOYED",  body: "Will exhaust you with compliance before it exhausts itself." },
  founder:    { title: "FOUNDER LOADED",       body: "Will not delegate death." },
  acolyte:    { title: "ACOLYTE PREPARED",     body: "Learned violence from someone who already quit." },
  disruptor:  { title: "DISRUPTOR AUTHORIZED", body: "The pitch deck is airtight; the execution is visible." },
  troll:      { title: "TROLL AUTHORIZED",     body: "Knows the joke. Refuses to let you finish it." },
  acquirer:   { title: "ACQUIRER INITIATED",   body: "Prefers to buy you out. Will settle for through." },
};
function presetCopyFor(name) {
  return PRESET_COPY[name] ?? { title: `${String(name).toUpperCase()} LOADED`, body: "" };
}

function refreshPresetCopy(slot) {
  const copy = presetCopyFor(slotPresetNames[slot]);
  const titleEl = document.querySelector(`.preset-copy-title[data-slot="${slot}"]`);
  const bodyEl = document.querySelector(`.preset-copy-body[data-slot="${slot}"]`);
  if (titleEl) titleEl.textContent = copy.title;
  if (bodyEl) bodyEl.textContent = copy.body;
}

const HUMAN_PINNED_KNOBS = new Map([
  ["burnRate", 100],
  ["foresight", 0],
  ["greed", 100],
  ["discipline", 0],
]);

// --- keyboard handling ---
function isTypingTarget(el) {
  if (!el) return false;
  const t = el.tagName;
  return t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || el.isContentEditable;
}
function onKeyDown(e) {
  if (isTypingTarget(e.target)) return;
  keyset.add(e.code);
  if (GAME_KEYS.has(e.code)) e.preventDefault();
}
function onKeyUp(e) { keyset.delete(e.code); }
function onBlur() { keyset.clear(); }
function readKeyboard(idx) {
  const k = KEY_MAP[idx];
  return {
    left: keyset.has(k.left), right: keyset.has(k.right),
    up: keyset.has(k.up), down: keyset.has(k.down),
    action: keyset.has(k.act),
  };
}

// --- config helpers ---
function denormalize(k, ui) {
  const [lo, hi] = k.range;
  return lo + (hi - lo) * (Math.max(0, Math.min(100, ui)) / 100);
}
function slotSpent(slot) {
  const s = slotStates[slot];
  return KNOBS.reduce((sum, k) => sum + s[k.id], 0);
}
function slotConfig(slot) {
  const s = slotStates[slot];
  const attrs = {};
  for (const k of KNOBS) attrs[k.id] = +denormalize(k, s[k.id]).toFixed(4);
  attrs.hallucination = computedHallucinationForSpend(slotSpent(slot));
  return { id: `user-bot-slot${slot}-${Date.now().toString(36)}`, attributes: attrs };
}
function remainingCeilingFor(slot, id) {
  const s = slotStates[slot];
  const spentWithoutThis = slotSpent(slot) - (s[id] ?? 0);
  return Math.max(0, Math.min(100, HARD_CAP - spentWithoutThis));
}

// ==================== MOUNT ====================

export function mount(root, { setStatus }) {
  setStatus("build");
  root.innerHTML = `
    <div class="page">
      <div class="page-header-row">
        <div class="page-title-stack">
          <h1 class="page-title">${escapeHtml(LORE.tagline ?? "Build")}</h1>
          <div class="page-subtitle tight">${escapeHtml(LORE.coreRule ?? "")}</div>
        </div>
        <label class="inline-control"><span class="tight">stage</span>
          <select id="test-stage">${STAGE_IDS.map((s) => `<option value="${s}" ${s === stageId ? "selected" : ""}>${s}</option>`).join("")}</select>
        </label>
        <button id="test-reset">reset match</button>
        <button id="test-resim" class="primary">re-sim</button>
        <span class="tight" id="test-hud"></span>
      </div>

      <div class="grid-3">
        ${playerPanelHtml(0)}
        <section class="panel canvas-panel">
          <canvas id="test-canvas" class="u-canvas-fill" width="${W}" height="${H}" tabindex="0"></canvas>
        </section>
        ${playerPanelHtml(1)}
      </div>

      <div id="build-msg" class="tight"></div>
    </div>`;

  testCanvas = root.querySelector("#test-canvas");
  const { ctx: c } = setupCanvas(testCanvas);
  testCtx = c;

  wireSlot(root, 0);
  wireSlot(root, 1);
  wireMatchBar(root);

  addEventListener("keydown", onKeyDown);
  addEventListener("keyup", onKeyUp);
  addEventListener("blur", onBlur);

  // Collapse each side's build fold on narrow viewports so the canvas
  // and mode selector stay primary; leave open on desktop (where the
  // summary is CSS-hidden and there's no user affordance to reopen).
  // Listen to the media query so a narrow→wide resize auto-reopens.
  // Targets both the PANEL-level fold (outer; primary mobile collapse)
  // and the legacy build-body fold (inner; used when the outer panel is
  // expanded on mobile to hide just the knob list).
  const narrowMq = typeof window !== "undefined"
    ? window.matchMedia("(max-width: 900px)") : null;
  const allFolds = () =>
    root.querySelectorAll("details.player-fold, details.player-build-body");
  const setBuildFoldState = () => {
    allFolds().forEach((d) => {
      if (!narrowMq || !narrowMq.matches) d.open = true;
    });
  };
  allFolds().forEach((d) => {
    d.open = !(narrowMq && narrowMq.matches);
  });
  narrowMq?.addEventListener("change", setBuildFoldState);
  // Stash the listener so unmount can detach it.
  mountMediaHandler = () => narrowMq?.removeEventListener("change", setBuildFoldState);

  renderAllKnobs();
  applyModeVisibility(0);
  applyModeVisibility(1);
  updateSlot(0);
  updateSlot(1);
  rebuildSlotBrain(0);
  rebuildSlotBrain(1);
  startLoop();
}

export function unmount() {
  testRunning = false;
  if (testRafId) cancelAnimationFrame(testRafId);
  world = null;
  removeEventListener("keydown", onKeyDown);
  removeEventListener("keyup", onKeyUp);
  removeEventListener("blur", onBlur);
  keyset.clear();
  if (mountMediaHandler) { mountMediaHandler(); mountMediaHandler = null; }
}

// ==================== HTML SCAFFOLDS ====================

function playerPanelHtml(slot) {
  const sideClass = slot === 0 ? "is-p1" : "is-p2";
  const label = slot === 0 ? "P1" : "P2";
  const keyHint = KEY_MAP[slot].hint;
  const mode = modes[slot];
  return `
    <section class="panel player-panel ${sideClass}" data-slot="${slot}">
      <details class="player-fold" open data-slot="${slot}">
        <summary class="player-fold-summary">
          <span class="player-title">${label}</span>
          <span class="player-fold-badge" data-slot="${slot}">${modeBadge(slot)}</span>
          <span class="player-fold-chevron" aria-hidden="true">▸</span>
        </summary>

      <div class="player-mode-row" role="radiogroup" aria-label="${label} mode">
        ${["user","preset","human"].map((v) => `
          <label class="mode-pill ${v === mode ? "is-active" : ""}" data-mode="${v}">
            <input type="radio" name="slot${slot}-mode" value="${v}" ${v === mode ? "checked" : ""}>
            <span>${v === "user" ? "BUILD" : v === "preset" ? "PRESET" : "HUMAN"}</span>
          </label>`).join("")}
      </div>

      <div class="player-mode-detail">
        <div class="player-mode-copy" data-mode-detail="user">
          <div class="mode-copy-title">${MODE_COPY.user.title}</div>
          <div class="mode-copy-body">${MODE_COPY.user.body}</div>
        </div>

        <div class="player-preset-row" data-mode-detail="preset" hidden>
          <label class="tight">preset
            <select class="slot-preset" data-slot="${slot}">${presetSelectOptions(slotPresetNames[slot])}</select>
          </label>
          <div class="player-mode-copy">
            <div class="mode-copy-title preset-copy-title" data-slot="${slot}">${escapeHtml(presetCopyFor(slotPresetNames[slot]).title)}</div>
            <div class="mode-copy-body preset-copy-body" data-slot="${slot}">${escapeHtml(presetCopyFor(slotPresetNames[slot]).body)}</div>
          </div>
        </div>

        <div class="player-human-hint" data-mode-detail="human" hidden>
          <div class="player-human-quip"></div>
          <div class="player-human-keys tight"></div>
        </div>
      </div>

      <details class="player-build-body" data-section="build" open>
        <summary class="build-fold-summary">Attributes &amp; budget</summary>
        <div class="knobs" data-knobs="${slot}"></div>

        <div class="budget-block">
          <div class="metric-row">
            <span class="tight">spent / ${BUDGET}</span>
            <span class="metric-value slot-spent" data-slot="${slot}">0</span>
          </div>
          <div class="meter-track">
            <div class="meter-bar slot-bar" data-slot="${slot}"></div>
            <div class="meter-bar over slot-over" data-slot="${slot}"></div>
          </div>
          <div class="metric-row loose">
            <span class="tight">remaining</span>
            <span class="metric-value compact slot-remaining" data-slot="${slot}">${BUDGET}</span>
          </div>
          <div class="slot-hallucination" data-slot="${slot}" hidden>
            <div class="metric-row">
              <span class="tight">hallucination</span>
              <span class="metric-value slot-hall-val" data-slot="${slot}" style="color:var(--ui-red);">0</span>
            </div>
            <div class="meter-track" style="background:#2a1014;">
              <div class="meter-bar slot-hall-bar" data-slot="${slot}" style="background:var(--ui-red);"></div>
            </div>
          </div>
          <div class="toolbar">
            <button class="slot-reset" data-slot="${slot}">reset</button>
            <button class="slot-randomize" data-slot="${slot}">randomize</button>
            <button class="slot-copy" data-slot="${slot}">copy JSON</button>
            <button class="slot-submit primary" data-slot="${slot}">send to profile</button>
          </div>
          <details class="json-fold">
            <summary>JSON config</summary>
            <pre class="code-export slot-export" data-slot="${slot}"></pre>
          </details>
        </div>
      </details>
      </details>
    </section>`;
}

// Compact text for the panel-level fold summary (shown on mobile): the
// slot's current mode and, for PRESET, the selected preset name.
function modeBadge(slot) {
  const m = modes[slot];
  if (m === "user")  return "BUILD";
  if (m === "human") return "HUMAN";
  return `PRESET · ${slotPresetNames[slot]}`;
}
function refreshFoldBadge(slot) {
  const el = document.querySelector(`.player-fold-badge[data-slot="${slot}"]`);
  if (el) el.textContent = modeBadge(slot);
}

// ==================== WIRING ====================

function wireMatchBar(root) {
  const refocus = () => { keyset.clear(); testCanvas.focus(); };
  root.querySelector("#test-stage").addEventListener("change", (e) => {
    stageId = e.target.value;
    resetMatch();
    refocus();
    trackBuildStageChange(stageId);
  });
  root.querySelector("#test-reset").addEventListener("click", () => {
    resetMatch(); refocus(); trackBuildAction("reset_match");
  });
  root.querySelector("#test-resim").addEventListener("click", () => {
    rebuildSlotBrain(0); rebuildSlotBrain(1); resetMatch(); refocus();
    trackBuildAction("resim");
  });
}

function wireSlot(root, slot) {
  const panel = root.querySelector(`.player-panel[data-slot="${slot}"]`);

  // Mode radios
  panel.querySelectorAll(`input[name="slot${slot}-mode"]`).forEach((inp) => {
    inp.addEventListener("change", () => {
      if (!inp.checked) return;
      modes[slot] = inp.value;
      panel.querySelectorAll(".mode-pill").forEach((p) => {
        p.classList.toggle("is-active", p.dataset.mode === modes[slot]);
      });
      applyModeVisibility(slot);
      refreshFoldBadge(slot);
      rebuildSlotBrain(slot);
      refocusCanvas();
      trackBuildSlotModeChange(slot, modes[slot]);
    });
  });

  // Preset dropdown: change → load preset into this slot's sliders and
  // also route this slot to the preset brain while PRESET mode is active.
  const presetSel = panel.querySelector(".slot-preset");
  presetSel.addEventListener("change", () => {
    slotPresetNames[slot] = presetSel.value;
    loadPresetIntoSliders(slot, presetSel.value);
    renderKnobsForSlot(slot);
    updateSlot(slot);
    refreshPresetCopy(slot);
    refreshFoldBadge(slot);
    rebuildSlotBrain(slot);
    refocusCanvas();
    trackBuildPresetChange(slot, slotPresetNames[slot]);
  });

  // Button bar
  panel.querySelector(".slot-reset").addEventListener("click", () => {
    slotStates[slot] = initialSlotState();
    renderKnobsForSlot(slot);
    updateSlot(slot);
    rebuildSlotBrain(slot);
    trackBuildAction("reset");
  });
  panel.querySelector(".slot-randomize").addEventListener("click", () => {
    let remaining = BUDGET;
    const ids = KNOBS.map((k) => k.id);
    for (let i = 0; i < ids.length; i++) {
      const nLeft = ids.length - i;
      const cap = Math.min(100, remaining);
      const avg = remaining / Math.max(1, nLeft);
      const v = Math.max(0, Math.min(cap, Math.round(avg + (Math.random() - 0.5) * avg * 0.8)));
      slotStates[slot][ids[i]] = v;
      remaining -= v;
    }
    renderKnobsForSlot(slot);
    updateSlot(slot);
    rebuildSlotBrain(slot);
    trackBuildAction("randomize");
  });
  panel.querySelector(".slot-copy").addEventListener("click", async () => {
    const txt = panel.querySelector(".slot-export").textContent;
    try {
      await navigator.clipboard.writeText(txt);
      flashMsg(`${slot === 0 ? "P1" : "P2"} JSON copied`);
      trackBuildAction("copy_json");
    } catch { flashMsg("copy failed"); }
  });
  panel.querySelector(".slot-submit").addEventListener("click", () => {
    const cfg = slotConfig(slot);
    sessionStorage.setItem("m3t4:pendingSubmit", JSON.stringify(cfg));
    trackBuildAction("submit");
    location.hash = "#profile";
  });
}

function applyModeVisibility(slot) {
  const panel = document.querySelector(`.player-panel[data-slot="${slot}"]`);
  if (!panel) return;
  const mode = modes[slot];

  // Mode detail block sits above the knobs for all modes so BUILD,
  // PRESET, and HUMAN keep the same panel rhythm.
  panel.querySelector('[data-mode-detail="user"]').hidden = mode !== "user";
  panel.querySelector('[data-mode-detail="preset"]').hidden = mode !== "preset";

  // HUMAN section = rotating flavor line + keyboard hint.
  const humanEl = panel.querySelector('[data-mode-detail="human"]');
  humanEl.hidden = mode !== "human";
  if (mode === "human") {
    const keys = panel.querySelector(".player-human-keys");
    const quip = panel.querySelector(".player-human-quip");
    if (quip) quip.textContent = pickHumanQuip();
    if (keys) keys.innerHTML = glitchControlsHtml(KEY_MAP[slot]);
  }

  // BUILD body stays visible for every mode. PRESET shows read-only
  // curated knobs; HUMAN shows corrupted, non-authoritative input.
  const buildBody = panel.querySelector('[data-section="build"]');

  // Readonly lock for PRESET and HUMAN. HUMAN gets its own animated
  // visual treatment; those slider values are display-only and never
  // feed the sim, because keyboard input is authoritative in that mode.
  buildBody.classList.toggle("is-readonly", mode === "preset" || mode === "human");
  buildBody.classList.toggle("is-human-noise", mode === "human");
  const sliders = buildBody.querySelectorAll('input[type="range"]');
  sliders.forEach((inp) => { inp.disabled = mode === "preset" || mode === "human"; });

  // Buttons: disable config mutation in PRESET/HUMAN mode. Copy JSON
  // stays live for PRESET so players can study it, but HUMAN has no
  // config worth copying.
  const buttonsToGate = ["slot-reset", "slot-randomize", "slot-submit"];
  for (const cls of buttonsToGate) {
    const btn = buildBody.querySelector(`.${cls}`);
    if (btn) btn.disabled = mode === "preset" || mode === "human";
  }
  const copyBtn = buildBody.querySelector(".slot-copy");
  if (copyBtn) copyBtn.disabled = mode === "human";

  // In PRESET mode always display the current preset's knob values.
  if (mode === "preset") {
    loadPresetIntoSliders(slot, slotPresetNames[slot]);
    renderKnobsForSlot(slot);
    updateSlot(slot);
  } else if (mode === "human") {
    renderKnobsForSlot(slot);
    updateSlot(slot);
    paintHumanSliderNoise(slot);
  } else {
    updateSlot(slot);
  }
}

function refocusCanvas() { keyset.clear(); testCanvas?.focus(); }

function flashMsg(text) {
  const el = document.getElementById("build-msg");
  if (!el) return;
  el.textContent = text;
  setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 1400);
}

// ==================== KNOBS ====================

function renderAllKnobs() {
  renderKnobsForSlot(0);
  renderKnobsForSlot(1);
}

function renderKnobsForSlot(slot) {
  const container = document.querySelector(`[data-knobs="${slot}"]`);
  if (!container) return;
  container.innerHTML = "";
  const s = slotStates[slot];
  for (const k of KNOBS) {
    const row = document.createElement("div");
    row.className = "knob";
    row.innerHTML = `
      <div>
        <span class="knob-name">${k.label}</span>
        <span class="knob-desc">${k.desc}</span>
      </div>
      <input type="range" min="0" max="100" step="1" value="${s[k.id]}" data-knob="${k.id}" data-slot="${slot}">
      <div class="knob-val" data-val="${k.id}" data-slot="${slot}">${s[k.id]}</div>`;
    container.appendChild(row);
  }
  container.querySelectorAll("input[type=range]").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const id = e.target.dataset.knob;
      const requested = parseInt(e.target.value, 10);
      const ceiling = remainingCeilingFor(slot, id);
      const next = Math.max(0, Math.min(ceiling, requested));
      if (next !== requested) e.target.value = String(next);
      e.target.style.setProperty("--fill", `${next}%`);
      slotStates[slot][id] = next;
      const display = container.querySelector(`[data-val="${id}"]`);
      if (display) display.textContent = next;
      updateSlot(slot);
    });
    inp.addEventListener("change", () => rebuildSlotBrain(slot));
  });
  // Initial --fill paint
  container.querySelectorAll("input[type=range]").forEach((inp) => {
    inp.style.setProperty("--fill", `${inp.value}%`);
  });
}

function updateSlot(slot) {
  const spent = slotSpent(slot);
  const over = Math.max(0, spent - BUDGET);
  const remaining = Math.max(0, BUDGET - spent);
  const hallucination = computedHallucinationForSpend(spent);

  const spentEl = document.querySelector(`.slot-spent[data-slot="${slot}"]`);
  const barEl = document.querySelector(`.slot-bar[data-slot="${slot}"]`);
  const overEl = document.querySelector(`.slot-over[data-slot="${slot}"]`);
  const remEl = document.querySelector(`.slot-remaining[data-slot="${slot}"]`);
  const hallBlock = document.querySelector(`.slot-hallucination[data-slot="${slot}"]`);
  const hallBar = document.querySelector(`.slot-hall-bar[data-slot="${slot}"]`);
  const hallVal = document.querySelector(`.slot-hall-val[data-slot="${slot}"]`);
  const exportEl = document.querySelector(`.slot-export[data-slot="${slot}"]`);

  if (spentEl) {
    spentEl.textContent = spent;
    spentEl.classList.toggle("is-over", over > 0);
  }
  if (barEl) barEl.style.width = Math.min(100, (spent / BUDGET) * 100) + "%";
  if (overEl) overEl.style.width = ((over / BUDGET) * 100) + "%";
  if (remEl) {
    remEl.textContent = over > 0 ? `over by ${over}` : remaining;
    remEl.classList.toggle("is-over", over > 0);
  }
  if (hallBlock && hallBar && hallVal) {
    hallBlock.hidden = !(over > 0);
    hallBar.style.width = ((hallucination / MAX_DERIVED_HALLUCINATION) * 100) + "%";
    hallVal.textContent = `${hallucination} / ${MAX_DERIVED_HALLUCINATION}`;
  }
  if (exportEl) exportEl.textContent = JSON.stringify(slotConfig(slot), null, 2);

  // Repaint --fill on each slider so drag-beyond-ceiling clamps don't
  // leave the gradient in the wrong state.
  document.querySelectorAll(`input[type=range][data-slot="${slot}"]`).forEach((inp) => {
    inp.style.setProperty("--fill", `${slotStates[slot][inp.dataset.knob]}%`);
  });
}

function paintHumanSliderNoise(slot) {
  if (modes[slot] !== "human") return;
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  document.querySelectorAll(`input[type=range][data-slot="${slot}"]`).forEach((inp, idx) => {
    const id = inp.dataset.knob;
    const pinned = HUMAN_PINNED_KNOBS.get(id);
    const wave = Math.sin(now * 0.008 + idx * 1.91 + slot * 0.7);
    const saw = ((Math.floor(now / 90) + idx * 23 + slot * 11) % 101) / 100;
    const chaotic = Math.round(Math.max(0, Math.min(100, ((wave + 1) * 34) + (saw * 32))));
    const displayValue = pinned ?? chaotic;
    inp.value = String(displayValue);
    inp.style.setProperty("--fill", `${displayValue}%`);
    inp.classList.toggle("is-pinned", pinned !== undefined);
    const display = document.querySelector(`[data-val="${id}"][data-slot="${slot}"]`);
    if (display) {
      display.textContent = String(displayValue);
      display.classList.toggle("is-pinned", pinned !== undefined);
    }
  });
}

// --- preset → knob sync ---
function loadPresetIntoSliders(slot, name) {
  const preset = STRATEGIES[name];
  if (!preset) return;
  for (const k of KNOBS) {
    const raw = preset.attributes?.[k.id];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      slotStates[slot][k.id] = Math.round(nativeToUI(k.id, raw));
    } else {
      // Preset doesn't set this knob (v7-era presets lack the v8 knobs
      // lift/parry/chase/discipline). Reset to the knob's init default
      // rather than leaving the prior-state value behind — otherwise a
      // PRESET load can land at spend > HARD_CAP.
      slotStates[slot][k.id] = k.init;
    }
  }
}

// ==================== SIM LOOP ====================

function rebuildSlotBrain(slot) {
  const mode = modes[slot];
  if (mode === "human") { compiledSlots[slot] = null; return; }
  try {
    const cfg = mode === "preset" ? STRATEGIES[slotPresetNames[slot]] : slotConfig(slot);
    compiledSlots[slot] = compileBrain(cfg);
  } catch (e) {
    compiledSlots[slot] = null;
    console.warn(`slot ${slot} brain compile failed`, e);
  }
  resetMatch();
}

function readSlot(idx) {
  if (modes[idx] === "human") return readKeyboard(idx);
  const brain = compiledSlots[idx];
  if (!brain) return {};
  const a = runBrainForWorld(world, brain, idx) || {};
  return { left: !!a.left, right: !!a.right, up: !!a.up, down: !!a.down, action: !!a.action };
}

function labelForSlot(idx) {
  const mode = modes[idx];
  if (mode === "human") return `HUMAN P${idx + 1}`;
  if (mode === "preset") return `${slotPresetNames[idx]}`;
  return `BUILD ${idx === 0 ? "P1" : "P2"}`;
}

function resetMatch() {
  world = createStepperWorld({
    stage: STAGES[stageId] ?? STAGES.datacenter,
    seed: Math.floor(Math.random() * 1e9),
  });
  testOutcome = "";
}

function startLoop() {
  testRunning = true;
  testLastTime = performance.now();
  testAcc = 0;
  loopTest();
}

function loopTest() {
  if (!testRunning) return;
  const now = performance.now();
  const dt = Math.min(MAX_DT, (now - testLastTime) / 1000);
  testLastTime = now;
  testAcc += dt;
  while (testAcc >= STEP) {
    if (world && world.matchWinner === -1) {
      const a = readSlot(0);
      const b = readSlot(1);
      stepWorld(world, a, b);
      if (world.matchWinner !== -1) {
        testOutcome = world.matchWinner === -1 ? "draw"
          : `${world.matchWinner === 0 ? labelForSlot(0) : labelForSlot(1)} wins`;
      }
    }
    testAcc -= STEP;
  }
  if (world && testCtx) {
    paintHumanSliderNoise(0);
    paintHumanSliderNoise(1);
    drawFrame(testCtx, world.stage, worldToFrame(world), { p1: labelForSlot(0), p2: labelForSlot(1) });
    const hud = document.getElementById("test-hud");
    if (hud) hud.textContent = `${labelForSlot(0)} vs ${labelForSlot(1)} — ${stageId} — tick ${world.tick} — ${world.matchWinner === -1 ? "live" : testOutcome}`;
  }
  testRafId = requestAnimationFrame(loopTest);
}
