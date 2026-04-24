// Build mode — symmetric P1 vs P2 editor + server-rendered deterministic preview.
// Each side (P1 blue, P2 purple) can independently be:
//   BUILD   — local editable knobs + budget + hallucination
//   PRESET  — pick any of the 16 curated preset bots
// The canonical sim runs server-side; the browser receives sanitized frames.

import {
  MIN_CLEAN_SPEND,
  MAX_DERIVED_HALLUCINATION,
  computedHallucinationForSpend,
  STAGES,
} from "../lib/public-sim.js";
import {
  BUDGET,
  HARD_CAP,
  KNOBS as SHARED_KNOBS,
  configFromState,
  formatConfigJsonV2,
  remainingCeilingForState,
  scaledStateFromValues,
  stateSpent,
} from "../lib/build-config.js";
import { createFrameRenderer, W, H } from "../render/index.js";
import { renderSliderEditor } from "../lib/slider-editor.js";
import { escapeHtml } from "../ui/html.js";
import { buttonHtml } from "../ui/actions.js";
import { navigateTo } from "../navigate.js";
import { contextCardHtml, pageHeaderHtml } from "../ui/shell.js";
import { statListHtml } from "../ui/stats.js";
import { simulateBuildPreview } from "../lib/api.js";
import { auth } from "../lib/auth.js";
import {
  trackBuildSlotModeChange, trackBuildPresetChange,
  trackBuildStageChange, trackBuildAction,
} from "../lib/analytics.js";
import presetRanking from "../data/preset-ranking.v1.json" with { type: "json" };

const DEFAULT_PRESET_NAMES = [
  "standby", "blitz", "intern", "pivot",
  "unicorn", "incumbent", "operator", "oracle",
  "shipper", "moonshot", "regulatory", "founder",
  "acolyte", "disruptor", "troll", "acquirer",
];

const KNOBS = SHARED_KNOBS.map(([id, label, desc, init]) => ({ id, label, desc, init }));

// --- per-slot state ---
// Neutral fallback used only if the preset-based generator fails (no
// presets loaded / compile error). Sums to 360 exactly.
function neutralSlotState() {
  const s = {};
  for (const k of KNOBS) s[k.id] = k.init;
  return s;
}

function randomPresetName() {
  const names = (presetRanking.rows ?? DEFAULT_PRESET_NAMES.map((n) => ({ name: n })))
    .map((r) => r.name ?? r);
  return names[Math.floor(Math.random() * names.length)];
}

function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function seededUnit(seed, i) {
  let x = (seed + Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 0x100000000;
}

function presetDisplayState(name) {
  const seed = hashString(String(name));
  const values = {};
  for (let i = 0; i < KNOBS.length; i++) {
    const k = KNOBS[i];
    values[k.id] = Math.round(10 + seededUnit(seed, i) * 80);
  }
  return scaledStateFromValues(values, BUDGET);
}

// Fresh BUILD starter: take a random preset as the baseline, convert
// each native attribute to UI space, and perturb by ±20 points.
// Produces a unique starter config per page load (and per reset) that
// always reads as "a real working build, slightly disturbed" instead
// of the stale hand-authored defaults.
function perturbedPresetState() {
  const values = {};
  for (const k of KNOBS) values[k.id] = k.init + (Math.random() - 0.5) * 40;
  return scaledStateFromValues(values, HARD_CAP);
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
const modes = ["user", "preset"]; // "user" | "preset"; no browser-executed brain.

// --- remote preview playback ---
const SIM_HZ = 120;
const STAGE_IDS = Object.keys(STAGES);
const STAGE_THUMBS = {
  datacenter: "assets/stages/datacenter/cold_aisle_chapel/ui/preview_thumb.webp",
  boardroom: "assets/stages/boardroom/fiduciary_basement/ui/preview_thumb.webp",
  demoday: "assets/stages/demoday/demo_day_afterparty/ui/preview_thumb.webp",
};
const KEY_MAP = [
  { left: "KeyA", right: "KeyD", up: "KeyW", down: "KeyS", act: "KeyF", moveHint: "W/A/S/D", strikeHint: "F" },
  { left: "KeyL", right: "Quote", up: "KeyP", down: "Semicolon", act: "BracketLeft", moveHint: "P/L/;/'", strikeHint: "[" },
];
const GAME_KEYS = new Set([
  "KeyA","KeyD","KeyW","KeyS","KeyF",
  "KeyL","Quote","KeyP","Semicolon","BracketLeft",
]);
const keyset = new Set();

let stageId = STAGE_IDS.includes("datacenter") ? "datacenter" : STAGE_IDS[0];
let testRenderer = null;
let testCanvas = null;
let testRafId = 0;
let testRunning = false;
let rendererMountId = 0;
let mountMediaHandler = null;
let previewFrames = [];
let previewStage = STAGES.datacenter;
let previewLabels = { p1: "BUILD P1", p2: "PRESET" };
let previewResult = null;
let previewStride = 2;
let previewStartedAt = 0;
let previewLoading = false;
let previewDirty = false;
let previewError = "";
let previewRequestId = 0;
let previewEditVersion = 0;

function stageLabel(id) {
  return STAGES[id]?.name ?? id;
}

function stagePickerHtml() {
  return `
        <div class="stage-picker" id="test-stage" aria-label="stage">
          <span class="stage-picker-label tight">stage</span>
          ${STAGE_IDS.map((id) => stagePickerOptionHtml(id)).join("")}
        </div>`;
}

function stagePickerOptionHtml(id) {
  const thumb = STAGE_THUMBS[id];
  const selected = id === stageId;
  const classes = `stage-option${thumb ? " has-thumb" : " no-thumb"}${selected ? " is-selected" : ""}`;
  const thumbStyle = thumb ? ` style="--stage-thumb: url('${thumb}')"` : "";
  const label = stageLabel(id);
  const title = `${selected ? "Selected" : "Choose"} stage: ${label}`;
  return `
          <button type="button" class="${classes}" aria-pressed="${selected ? "true" : "false"}" data-stage-id="${escapeHtml(id)}" title="${escapeHtml(title)}">
            <span class="stage-option-thumb"${thumbStyle} aria-hidden="true"></span>
            <span class="stage-option-label">${escapeHtml(label)}</span>
          </button>`;
}

function syncStagePicker(root = document) {
  root.querySelectorAll(".stage-option[data-stage-id]").forEach((btn) => {
    const selected = btn.dataset.stageId === stageId;
    btn.classList.toggle("is-selected", selected);
    btn.setAttribute("aria-pressed", selected ? "true" : "false");
    btn.title = `${selected ? "Selected" : "Choose"} stage: ${stageLabel(btn.dataset.stageId)}`;
  });
}

// Preset dropdown: flat list of all 16 presets, sorted by round-robin
// win rate (strongest top). The easy/medium/hard tier labels were
// tripping users up — the win-rate % is a cleaner read.
function presetSelectOptions(selected) {
  const rows = presetRanking.rows ?? DEFAULT_PRESET_NAMES.map((name) => ({ name, wr: 0 }));
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
function slotSpent(slot) {
  return stateSpent(slotStates[slot]);
}
function slotConfig(slot, opts = {}) {
  return configFromState(slotStates[slot], { id: opts.runtimeId ? `build-slot-${slot}` : "" });
}
function remainingCeilingFor(slot, id) {
  return remainingCeilingForState(slotStates[slot], id);
}

// ==================== MOUNT ====================

export function mount(root, { setStatus }) {
  setStatus("tune");
  root.innerHTML = `
    <div class="page build-page">
      ${pageHeaderHtml({
        title: "Tune",
        subtitle: "server preview · not ranked until sent live",
      })}
      ${contextCardHtml({
        className: "build-context-card",
        body: `
          <div class="build-preview-topbar">
            <div class="build-preview-controls">
              ${stagePickerHtml()}
              <div class="build-preview-actions">
                ${buttonHtml({ id: "test-reset", text: "reset match", attrs: { title: "Rewind the test match to tick zero" } })}
                ${buttonHtml({ id: "test-resim", variant: "primary", text: "test fight", attrs: { title: "Run a deterministic test match against the current build" } })}
              </div>
            </div>
            ${buildPreviewBriefingHtml()}
          </div>`,
      })}

      <div class="grid-3">
        ${playerPanelHtml(0)}
        <section class="panel canvas-panel">
          <canvas id="test-canvas" class="u-canvas-fill" width="${W}" height="${H}" tabindex="0"></canvas>
          <div class="build-preview-stats" aria-live="polite">
            <div class="build-preview-copy tight">server test fight</div>
            ${statListHtml([
              { label: "P1", id: "build-stat-p1" },
              { label: "P2", id: "build-stat-p2" },
              { label: "stage", id: "build-stat-stage" },
              { label: "server", id: "build-stat-server" },
              { label: "seed", id: "build-stat-seed" },
              { label: "tick", id: "build-stat-tick" },
              { label: "frames", id: "build-stat-frames" },
              { label: "result", id: "build-stat-result" },
            ])}
          </div>
        </section>
        ${playerPanelHtml(1)}
      </div>

      <div id="build-msg" class="tight"></div>
    </div>`;

  const rendererId = ++rendererMountId;
  testCanvas = root.querySelector("#test-canvas");
  void attachTestRenderer(rendererId, testCanvas);

  wireSlot(root, 0);
  wireSlot(root, 1);
  wireMatchBar(root);

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
  startLoop();
  requestPreview({ newSeed: true });
}

export function unmount() {
  rendererMountId++;
  testRunning = false;
  if (testRafId) cancelAnimationFrame(testRafId);
  testRenderer?.destroy();
  testRenderer = null;
  removeEventListener("keydown", onKeyDown);
  removeEventListener("keyup", onKeyUp);
  removeEventListener("blur", onBlur);
  keyset.clear();
  if (mountMediaHandler) { mountMediaHandler(); mountMediaHandler = null; }
}

async function attachTestRenderer(rendererId, canvas) {
  let nextRenderer = null;
  try {
    nextRenderer = await createFrameRenderer(canvas);
  } catch (error) {
    console.error("[m3t4] failed to initialize build renderer", error);
    return;
  }
  if (rendererId !== rendererMountId || !testCanvas) {
    nextRenderer.destroy();
    return;
  }
  testRenderer?.destroy();
  testRenderer = nextRenderer;
  testCanvas = nextRenderer.canvas ?? canvas;
}

// ==================== HTML SCAFFOLDS ====================

function playerPanelHtml(slot) {
  const sideClass = slot === 0 ? "is-p1" : "is-p2";
  const label = slot === 0 ? "P1" : "P2";
  const mode = modes[slot];
  return `
    <section class="panel player-panel ${sideClass}" data-slot="${slot}">
      <details class="player-fold" open data-slot="${slot}">
        <summary class="player-fold-summary" title="Toggle player ${label} controls">
          <span class="player-title">${label}</span>
          <span class="player-fold-badge" data-slot="${slot}">${modeBadge(slot)}</span>
          <span class="player-fold-chevron" aria-hidden="true">▸</span>
        </summary>

      <div class="player-mode-row" role="radiogroup" aria-label="${label} mode">
        ${["user","preset"].map((v) => `
          <label class="mode-pill ${v === mode ? "is-active" : ""}" data-mode="${v}">
            <input type="radio" name="slot${slot}-mode" value="${v}" ${v === mode ? "checked" : ""}>
            <span>${v === "user" ? "BUILD" : "PRESET"}</span>
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
          <div class="player-human-quip">MANUAL CONTROL REVOKED.</div>
          <div class="player-human-keys tight">The browser may watch. It may not think.</div>
        </div>
      </div>

      <details class="player-build-body" data-section="build" open>
        <summary class="build-fold-summary" title="Toggle attributes and budget">Attributes &amp; budget</summary>
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
              <span class="metric-value slot-hall-val" data-slot="${slot}">0</span>
            </div>
            <div class="meter-track meter-track--hallucination">
              <div class="meter-bar slot-hall-bar" data-slot="${slot}"></div>
            </div>
          </div>
          <div class="toolbar">
            ${buttonHtml({ className: "slot-reset", attrs: { "data-slot": slot, title: `Discard changes in slot ${Number(slot) + 1}` }, text: "reset" })}
            ${buttonHtml({ className: "slot-randomize", attrs: { "data-slot": slot, title: "Randomize this slot's build" }, text: "randomize" })}
            ${buttonHtml({ className: "slot-submit", variant: "primary", attrs: { "data-slot": slot, title: "Promote this tuned build into your live roster seat" }, text: "send to live roster" })}
          </div>
          <div class="build-install-note tight">Preview only until sent live.</div>
          <details class="json-fold">
            <summary title="Toggle JSON config">JSON config</summary>
            <pre class="code-export slot-export" data-slot="${slot}"></pre>
          </details>
        </div>
      </details>
      </details>
    </section>`;
}

function buildPreviewBriefingHtml() {
  return `
    <div class="build-preview-briefing" aria-live="polite">
      <div class="build-preview-side is-p1" id="build-brief-side-0">
        <span class="build-preview-side-label">P1</span>
        <strong class="build-preview-side-name" id="build-brief-p1">${escapeHtml(labelForSlot(0))}</strong>
      </div>
      <div class="build-preview-center">
        <div class="build-preview-result" id="build-brief-result">simulating on server</div>
        <div class="build-preview-meta" id="build-brief-meta">${escapeHtml(stageLabel(stageId))} · seed —</div>
      </div>
      <div class="build-preview-side is-p2" id="build-brief-side-1">
        <span class="build-preview-side-label">P2</span>
        <strong class="build-preview-side-name" id="build-brief-p2">${escapeHtml(labelForSlot(1))}</strong>
      </div>
    </div>`;
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
  const setStage = (nextStageId) => {
    if (!STAGE_IDS.includes(nextStageId) || nextStageId === stageId) return;
    stageId = nextStageId;
    syncStagePicker(root);
    requestPreview({ newSeed: true });
    refocus();
    trackBuildStageChange(stageId);
  };
  root.querySelectorAll(".stage-option[data-stage-id]").forEach((btn) => {
    btn.addEventListener("click", () => setStage(btn.dataset.stageId));
  });
  root.querySelector("#test-reset").addEventListener("click", () => {
    requestPreview({ newSeed: true }); refocus(); trackBuildAction("reset_match");
  });
  root.querySelector("#test-resim").addEventListener("click", () => {
    requestPreview({ newSeed: true }); refocus();
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
      requestPreview({ newSeed: true });
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
    requestPreview({ newSeed: true });
    refocusCanvas();
    trackBuildPresetChange(slot, slotPresetNames[slot]);
  });

  // Button bar
  panel.querySelector(".slot-reset").addEventListener("click", () => {
    slotStates[slot] = initialSlotState();
    renderKnobsForSlot(slot);
    updateSlot(slot);
    markPreviewDirty();
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
    markPreviewDirty();
    trackBuildAction("randomize");
  });
  panel.querySelector(".slot-submit").addEventListener("click", () => {
    const cfg = slotConfig(slot);
    sessionStorage.setItem("m3t4:pendingSubmit", JSON.stringify(cfg));
    trackBuildAction("submit");
    navigateTo("roster");
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

  // Buttons: disable config mutation in PRESET/HUMAN mode. Preset
  // internals are server-side; the browser only gets a label.
  const buttonsToGate = ["slot-reset", "slot-randomize", "slot-submit"];
  for (const cls of buttonsToGate) {
    const btn = buildBody.querySelector(`.${cls}`);
    if (btn) btn.disabled = mode === "preset" || mode === "human";
  }
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
  renderSliderEditor(container, slotStates[slot], {
    dataAttrs: { slot: String(slot) },
    remainingCeilingFor: (id) => remainingCeilingFor(slot, id),
    onChange: () => {
      updateSlot(slot);
      markPreviewDirty();
    },
    onCommit: () => markPreviewDirty(),
  });
}

function updateSlot(slot) {
  const spent = slotSpent(slot);
  const over = Math.max(0, spent - BUDGET);
  const under = Math.max(0, MIN_CLEAN_SPEND - spent);
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
    spentEl.classList.toggle("is-over", over > 0 || under > 0);
  }
  if (barEl) barEl.style.width = Math.min(100, (spent / BUDGET) * 100) + "%";
  if (overEl) overEl.style.width = ((over / BUDGET) * 100) + "%";
  if (remEl) {
    remEl.textContent = over > 0 ? `over by ${over}` : under > 0 ? `under by ${under}` : remaining;
    remEl.classList.toggle("is-over", over > 0 || under > 0);
  }
  if (hallBlock && hallBar && hallVal) {
    hallBlock.hidden = hallucination <= 0;
    hallBar.style.width = ((hallucination / MAX_DERIVED_HALLUCINATION) * 100) + "%";
    hallVal.textContent = `${hallucination} / ${MAX_DERIVED_HALLUCINATION}`;
  }
  if (exportEl) {
    exportEl.textContent = modes[slot] === "preset"
      ? JSON.stringify({ preset: slotPresetNames[slot], attributes: "server-side" }, null, 2)
      : formatConfigJsonV2(slotConfig(slot));
  }

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
  slotStates[slot] = presetDisplayState(name);
}

// ==================== REMOTE PREVIEW LOOP ====================

function labelForSlot(idx) {
  const mode = modes[idx];
  if (mode === "preset") return `${slotPresetNames[idx]}`;
  return `BUILD ${idx === 0 ? "P1" : "P2"}`;
}

function sidePayload(slot) {
  if (modes[slot] === "preset") {
    return { kind: "preset", preset: slotPresetNames[slot] };
  }
  return { kind: "user", config: slotConfig(slot) };
}

function markPreviewDirty() {
  previewEditVersion++;
  previewDirty = true;
  updatePreviewHud();
}

async function requestPreview({ newSeed = false } = {}) {
  const requestId = ++previewRequestId;
  const requestEditVersion = previewEditVersion;
  previewLoading = true;
  previewDirty = false;
  previewError = "";
  updatePreviewHud();

  try {
    const response = await simulateBuildPreview({
      stageId,
      seed: newSeed ? undefined : previewResult?.seed,
      frameStride: 2,
      a: sidePayload(0),
      b: sidePayload(1),
    });
    if (requestId !== previewRequestId) return;
    previewFrames = Array.isArray(response.frames) ? response.frames : [];
    previewStage = response.stage ?? STAGES[stageId] ?? STAGES.datacenter;
    previewLabels = response.labels ?? { p1: labelForSlot(0), p2: labelForSlot(1) };
    previewResult = response.result ? { ...response.result, seed: response.seed } : { seed: response.seed };
    previewStride = response.frameStride || 2;
    previewStartedAt = performance.now();
    previewLoading = false;
    previewDirty = previewEditVersion !== requestEditVersion;
    previewError = "";
    updatePreviewHud();
  } catch (e) {
    if (requestId !== previewRequestId) return;
    previewLoading = false;
    previewError = e?.message ?? String(e);
    updatePreviewHud();
  }
}

function startLoop() {
  testRunning = true;
  previewStartedAt = performance.now();
  loopTest();
}

function loopTest() {
  if (!testRunning) return;
  if (testRenderer) {
    paintHumanSliderNoise(0);
    paintHumanSliderNoise(1);
    const frame = currentPreviewFrame();
    if (frame) {
      testRenderer.drawFrame(previewStage, frame, previewLabels);
    } else {
      testRenderer.drawFrame(previewStage, emptyFrame(), previewLabels);
    }
    updatePreviewHud(frame);
  }
  testRafId = requestAnimationFrame(loopTest);
}

function currentPreviewFrame() {
  if (!previewFrames.length) return null;
  const elapsedTicks = Math.floor(((performance.now() - previewStartedAt) / 1000) * SIM_HZ);
  const idx = Math.min(previewFrames.length - 1, Math.floor(elapsedTicks / Math.max(1, previewStride)));
  return previewFrames[idx];
}

function emptyFrame() {
  return {
    tick: 0,
    roundStartTick: 0,
    p0: { x: 300, y: 590, vx: 0, vy: 0, facing: 1, onGround: true, wall: 0, stun: 0, swipeT: 0, diveT: 0, lastClashTick: -9999, dead: false },
    p1: { x: 980, y: 590, vx: 0, vy: 0, facing: -1, onGround: true, wall: 0, stun: 0, swipeT: 0, diveT: 0, lastClashTick: -9999, dead: false },
    token: { exists: false, x: 0, y: 0, carrier: -1, dwellT: 0 },
    goal: { exists: false, x: 0, y: 0, label: "", timer: 0 },
    scoreboard: [0, 0],
    rounds: [0, 0],
  };
}

function updatePreviewHud(frame = currentPreviewFrame()) {
  updatePreviewControls();
  updatePreviewBriefing(frame);
  updatePreviewStats(frame);
}

function updatePreviewBriefing(frame = currentPreviewFrame()) {
  setBuildStat("build-brief-p1", labelForSlot(0));
  setBuildStat("build-brief-p2", labelForSlot(1));
  setBriefWinnerState(-1);

  if (previewLoading) {
    setBuildStat("build-brief-result", "simulating on server");
    setBuildStat("build-brief-meta", `${stageLabel(stageId)} · seed pending`);
    return;
  }
  if (previewError) {
    setBuildStat("build-brief-result", "preview failed");
    setBuildStat("build-brief-meta", previewError);
    return;
  }
  if (!frame) {
    setBuildStat("build-brief-result", "press test fight");
    setBuildStat("build-brief-meta", `${stageLabel(stageId)} · seed —`);
    return;
  }

  const finalTick = previewResult?.ticks ?? previewFrames[previewFrames.length - 1]?.tick ?? "—";
  const winner = previewResult?.winner;
  const score = Array.isArray(previewResult?.finalScore)
    ? `${previewResult.finalScore[0]}-${previewResult.finalScore[1]}`
    : "";
  const replayState = previewDirty ? "changed · test again" : `replay ${frame.tick}/${finalTick}`;
  const result = previewDirty
    ? "changed · test again"
    : winner === -1
      ? `draw${score ? ` · ${score}` : ""}`
      : winner === 0 || winner === 1
        ? `${winner === 0 ? previewLabels.p1 : previewLabels.p2} wins${score ? ` · ${score}` : ""}`
        : "replay ready";

  setBuildStat("build-brief-result", result);
  setBuildStat(
    "build-brief-meta",
    `${stageLabel(stageId)} · seed ${previewResult?.seed ?? "—"} · ${replayState}`
  );
  if (!previewDirty && (winner === 0 || winner === 1)) setBriefWinnerState(winner);
}

function setBriefWinnerState(winner) {
  for (let side = 0; side < 2; side++) {
    const el = document.getElementById(`build-brief-side-${side}`);
    if (!el) continue;
    el.classList.toggle("is-winner", winner === side);
    el.classList.toggle("is-loser", winner === 0 || winner === 1 ? winner !== side : false);
  }
}

function updatePreviewStats(frame = currentPreviewFrame()) {
  setBuildStat("build-stat-p1", labelForSlot(0));
  setBuildStat("build-stat-p2", labelForSlot(1));
  setBuildStat("build-stat-stage", stageId);
  setBuildStat("build-stat-seed", previewResult?.seed ?? "—");
  setBuildStat("build-stat-frames", previewFrames.length ? `${previewFrames.length} @ ${previewStride}f` : "—");

  if (previewLoading) {
    setBuildStat("build-stat-server", "simulating");
    setBuildStat("build-stat-tick", "—");
    setBuildStat("build-stat-result", "pending");
    return;
  }
  if (previewError) {
    setBuildStat("build-stat-server", "failed");
    setBuildStat("build-stat-tick", "—");
    setBuildStat("build-stat-result", previewError);
    return;
  }
  if (!frame) {
    setBuildStat("build-stat-server", "ready");
    setBuildStat("build-stat-tick", "—");
    setBuildStat("build-stat-result", "press test fight");
    return;
  }

  const finalTick = previewResult?.ticks ?? previewFrames[previewFrames.length - 1]?.tick ?? "—";
  const ended = previewResult && frame === previewFrames[previewFrames.length - 1];
  const serverState = previewDirty ? "changed" : ended ? "complete" : "replay";
  setBuildStat("build-stat-server", serverState);
  setBuildStat("build-stat-tick", `${frame.tick} / ${finalTick}`);

  if (previewDirty) {
    setBuildStat("build-stat-result", "changed - test again");
    return;
  }
  const winner = previewResult?.winner;
  const score = Array.isArray(previewResult?.finalScore) ? ` ${previewResult.finalScore[0]}-${previewResult.finalScore[1]}` : "";
  const result = !ended ? "in playback"
    : winner === -1 ? `draw${score}`
    : `${winner === 0 ? previewLabels.p1 : previewLabels.p2} wins${score}`;
  setBuildStat("build-stat-result", result);
}

function setBuildStat(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

function updatePreviewControls() {
  const resim = document.getElementById("test-resim");
  const reset = document.getElementById("test-reset");
  const stageButtons = document.querySelectorAll(".stage-option[data-stage-id]");

  if (resim) {
    resim.disabled = previewLoading;
    resim.textContent = previewLoading ? "simulating..." : previewDirty ? "test fight*" : "test fight";
    resim.title = resim.textContent;
    resim.classList.toggle("is-simulating", previewLoading);
    resim.classList.toggle("needs-resim", previewDirty && !previewLoading);
    resim.setAttribute("aria-busy", previewLoading ? "true" : "false");
  }
  if (reset) reset.disabled = previewLoading;
  stageButtons.forEach((btn) => { btn.disabled = previewLoading; });
}
