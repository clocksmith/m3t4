// Workshop — editable local matches plus server-held preset previews.
// Each side (P1 blue, P2 purple) can independently be:
//   BUILD   — local editable knobs + budget + hallucination
//   PRESET  — pick any of the 16 curated preset bots
//   HUMAN   — drive the fighter directly via WASD+F (P1) or P/L/;/'+[ (P2)
// Authored builds run in the local deterministic stepper. Preset-only bot
// previews use the server boundary; manual matches remain local sandboxes.
// No Workshop result is promoted to ranked authority.

import {
  MIN_CLEAN_SPEND,
  MAX_DERIVED_HALLUCINATION,
  computedHallucinationForSpend,
  STAGES,
} from "../lib/public-sim.js";
import {
  BUDGET,
  KNOBS as SHARED_KNOBS,
  configFromState,
  formatConfigJsonV2,
  remainingCeilingForState,
  neutralBuildState,
  stateSpent,
} from "../lib/build-config.js";
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
import { renderSliderEditor } from "../lib/slider-editor.js";
import { escapeHtml } from "../ui/html.js";
import { buttonHtml } from "../ui/actions.js";
import { navigateTo } from "../navigate.js";
import { contextCardHtml, workshopHeaderHtml, disclosureHtml } from "../ui/shell.js";
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
function randomPresetName() {
  const names = (presetRanking.rows ?? DEFAULT_PRESET_NAMES.map((n) => ({ name: n })))
    .map((r) => r.name ?? r);
  return names[Math.floor(Math.random() * names.length)];
}

const initialSlotState = neutralBuildState;
const slotStates = [initialSlotState(), initialSlotState()];
const slotPresetNames = [randomPresetName(), randomPresetName()];
const modes = ["user", "user"]; // "user" | "preset" | "human" — human runs locally only.

// --- remote preview playback ---
const SIM_HZ = 120;
const STAGE_IDS = Object.keys(STAGES);
const STAGE_THUMBS = {
  datacenter: "/assets/stages/datacenter/cold_aisle_chapel/ui/preview_thumb.png",
  boardroom: "/assets/stages/boardroom/fiduciary_basement/ui/preview_thumb.png",
  demoday: "/assets/stages/demoday/demo_day_afterparty/ui/preview_thumb.png",
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
let previewLabels = { p1: "BUILD P1", p2: "BUILD P2" };
let previewResult = null;
let previewStride = 2;
let previewStartedAt = 0;
let previewLoading = false;
let previewDirty = false;
let previewError = "";
let previewRequestId = 0;
let previewEditVersion = 0;

// Local stepper for authored builds and manual play. Compile each bot once
// per match, and read the keyboard only for human-controlled sides.
let localWorld = null;
const localBrains = [null, null];
let localPlayedAtMs = 0;
let localTickAccumMs = 0;
const LOCAL_STEP_MS = 1000 / SIM_HZ;
const LOCAL_MAX_CATCHUP_TICKS = 240;

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

// --- keyboard handling ---
function isTypingTarget(el) {
  if (!el) return false;
  const t = el.tagName;
  return t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || el.isContentEditable;
}
function startPrompt() {
  if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) {
    return "tap to fight";
  }
  return "press space to fight";
}
function onKeyDown(e) {
  if (isTypingTarget(e.target) || e.target?.closest?.("button, summary, a")) return;
  if (e.code === "Space") {
    e.preventDefault();
    requestPreview({ newSeed: true });
    refocusCanvas();
    return;
  }
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
      ${workshopHeaderHtml({
        subtitle: previewSubtitle(),
      })}
      ${contextCardHtml({
        className: "build-context-card",
        body: `
          <div class="build-preview-topbar">
            <div class="build-preview-controls">
              ${stagePickerHtml()}
              <div class="build-preview-actions">
                ${buttonHtml({ id: "test-reset", text: "new matchup", attrs: { title: "Start again with a new random seed" } })}
                ${buttonHtml({ id: "test-resim", variant: "primary", text: "test fight", attrs: { title: "Test the current fighters using the same seed" } })}
              </div>
            </div>
            ${buildPreviewBriefingHtml()}
          </div>`,
      })}

      <div class="grid-3">
        ${playerPanelHtml(0)}
        <section class="panel canvas-panel">
          <canvas id="test-canvas" aria-label="Local fighter test arena. Change traits, then select test fight." class="u-canvas-fill" width="${W}" height="${H}" tabindex="0"></canvas>
          <div class="build-preview-stats">
            <div class="build-preview-copy tight" id="build-preview-copy">${escapeHtml(previewCopy())}</div>
            ${disclosureHtml({ label: "Match details", body: statListHtml([
              { label: "P1", id: "build-stat-p1" },
              { label: "P2", id: "build-stat-p2" },
              { label: "stage", id: "build-stat-stage" },
              { label: "execution", id: "build-stat-server" },
              { label: "seed", id: "build-stat-seed" },
              { label: "tick", id: "build-stat-tick" },
              { label: "frames", id: "build-stat-frames" },
              { label: "result", id: "build-stat-result" },
            ]) })}
          </div>
        </section>
        ${playerPanelHtml(1)}
      </div>

      <div id="build-msg" class="tight"></div>
    </div>`;

  const rendererId = ++rendererMountId;
  testCanvas = root.querySelector("#test-canvas");
  void attachTestRenderer(rendererId, testCanvas);

  // Tap the canvas to (re)run a fresh test fight; mirrors the spacebar
  // shortcut for touch users.
  testCanvas.addEventListener("click", () => {
    requestPreview({ newSeed: true });
    refocusCanvas();
  });

  wireSlot(root, 0);
  wireSlot(root, 1);
  wireMatchBar(root);

  // Keep the primary fighter editable on mobile; fold the rival initially.
  // Both can be opened or closed. Widening reopens the symmetric panels.
  const narrowMq = typeof window !== "undefined"
    ? window.matchMedia("(max-width: 900px)") : null;
  const allFolds = () =>
    root.querySelectorAll("details.player-fold");
  const setBuildFoldState = () => {
    allFolds().forEach((d) => {
      if (!narrowMq || !narrowMq.matches) d.open = true;
    });
  };
  allFolds().forEach((d) => {
    d.open = d.dataset.slot === "0" || !(narrowMq && narrowMq.matches);
  });
  narrowMq?.addEventListener("change", setBuildFoldState);
  // Stash the listener so unmount can detach it.
  mountMediaHandler = () => narrowMq?.removeEventListener("change", setBuildFoldState);

  addEventListener("keydown", onKeyDown);
  addEventListener("keyup", onKeyUp);
  addEventListener("blur", onBlur);

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
  previewRequestId++;
  if (testRafId) cancelAnimationFrame(testRafId);
  testRenderer?.destroy();
  testRenderer = null;
  removeEventListener("keydown", onKeyDown);
  removeEventListener("keyup", onKeyUp);
  removeEventListener("blur", onBlur);
  keyset.clear();
  teardownLocalWorld();
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
          <span class="player-title">${label} · ${slot === 0 ? "your fighter" : "rival"}</span>
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
          <div class="player-human-quip">CARBON INPUT STANDBY.</div>
          <div class="player-human-keys tight"></div>
        </div>
      </div>

      <div class="player-build-body" data-section="build">
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
            ${buttonHtml({ className: "slot-submit", variant: "primary", attrs: { "data-slot": slot, title: "Save this build in a roster seat" }, text: "save fighter" })}
          </div>
          <div class="build-install-note tight">Local tests are not ranked matches.</div>
          <details class="json-fold">
            <summary title="Toggle JSON config">JSON config</summary>
            <pre class="code-export slot-export" data-slot="${slot}"></pre>
          </details>
        </div>
      </div>
      </details>
    </section>`;
}

function buildPreviewBriefingHtml() {
  return `
    <div class="build-preview-briefing">
      <div class="build-preview-side is-p1" id="build-brief-side-0">
        <span class="build-preview-side-label">P1</span>
        <strong class="build-preview-side-name" id="build-brief-p1">${escapeHtml(labelForSlot(0))}</strong>
      </div>
      <div class="build-preview-center">
        <div class="build-preview-result" id="build-brief-result">starting match</div>
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
    requestPreview({ newSeed: false }); refocus();
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

  // Keep the authored build intact across modes. Preset internals are not
  // client data; keyboard input is not a numerical policy.
  buildBody.hidden = mode !== "user";
  renderKnobsForSlot(slot);
  updateSlot(slot);

  refreshPreviewCopy();
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

// ==================== REMOTE PREVIEW LOOP ====================

function labelForSlot(idx) {
  const mode = modes[idx];
  if (mode === "preset") return `${slotPresetNames[idx]}`;
  if (mode === "human") return `HUMAN ${idx === 0 ? "P1" : "P2"}`;
  return `BUILD ${idx === 0 ? "P1" : "P2"}`;
}

function sidePayload(slot) {
  if (modes[slot] === "preset") {
    return { kind: "preset", preset: slotPresetNames[slot] };
  }
  return { kind: "user", config: slotConfig(slot) };
}

function slotIsHuman(slot) { return modes[slot] === "human"; }
function hasHuman() { return slotIsHuman(0) || slotIsHuman(1); }
function usesLocalPreview() { return hasHuman() || modes.every((mode) => mode === "user"); }

function previewSubtitle() {
  return hasHuman()
    ? "local sandbox · keyboard input · not ranked"
    : usesLocalPreview() ? "Tune a fighter. Win the proof. Ship it home. · local sandbox" : "server preset preview · not ranked";
}
function previewCopy() {
  return usesLocalPreview() ? "Kill → collect the Proof Core → deliver. Two deliveries win a round; two rounds win the match." : "server test fight · not ranked";
}
function refreshPreviewCopy() {
  const subtitleEl = document.querySelector(".build-page .page-subtitle");
  if (subtitleEl) subtitleEl.textContent = previewSubtitle();
  const copyEl = document.getElementById("build-preview-copy");
  if (copyEl) copyEl.textContent = previewCopy();
}

function brainConfigForSlot(slot) {
  if (modes[slot] === "preset") {
    const cfg = STRATEGIES[slotPresetNames[slot]];
    if (!cfg) throw new Error(`unknown preset: ${slotPresetNames[slot]}`);
    return cfg;
  }
  return slotConfig(slot, { runtimeId: true });
}

function freshLocalSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

function teardownLocalWorld() {
  localWorld = null;
  localBrains[0] = null;
  localBrains[1] = null;
}

function startLocalWorld({ newSeed = false } = {}) {
  const seed = newSeed ? freshLocalSeed() : (previewResult?.seed ?? freshLocalSeed());
  const stage = SIM_STAGES[stageId] ?? SIM_STAGES.datacenter;
  localBrains[0] = slotIsHuman(0) ? null : compileBrain(brainConfigForSlot(0));
  localBrains[1] = slotIsHuman(1) ? null : compileBrain(brainConfigForSlot(1));
  localWorld = createStepperWorld({ stage, seed });
  localPlayedAtMs = performance.now();
  localTickAccumMs = 0;
  previewStage = stage;
  previewLabels = { p1: labelForSlot(0), p2: labelForSlot(1) };
  previewResult = { seed, ticks: 0, winner: -1, finalScore: [0, 0] };
  previewFrames = [];
  previewStride = 1;
  previewLoading = false;
  previewError = "";
  previewDirty = false;
}

function actionForSlot(slot) {
  if (slotIsHuman(slot)) return readKeyboard(slot);
  return runBrainForWorld(localWorld, localBrains[slot], slot);
}

function stepLocalSim(nowMs) {
  if (!localWorld) return null;
  if (localWorld.matchWinner !== -1) return worldToFrame(localWorld);
  let dt = nowMs - localPlayedAtMs;
  localPlayedAtMs = nowMs;
  if (!Number.isFinite(dt) || dt < 0) dt = 0;
  localTickAccumMs += dt;
  let stepsTaken = 0;
  while (
    localTickAccumMs >= LOCAL_STEP_MS &&
    stepsTaken < LOCAL_MAX_CATCHUP_TICKS &&
    localWorld.matchWinner === -1
  ) {
    const actA = actionForSlot(0);
    const actB = actionForSlot(1);
    stepWorld(localWorld, actA, actB);
    localTickAccumMs -= LOCAL_STEP_MS;
    stepsTaken++;
  }
  if (localTickAccumMs > LOCAL_STEP_MS * LOCAL_MAX_CATCHUP_TICKS) {
    localTickAccumMs = LOCAL_STEP_MS * LOCAL_MAX_CATCHUP_TICKS;
  }
  if (previewResult) previewResult.ticks = localWorld.tick;
  return worldToFrame(localWorld);
}

function markPreviewDirty() {
  previewEditVersion++;
  previewDirty = true;
  updatePreviewHud();
}

async function requestPreview({ newSeed = false } = {}) {
  // Bump request id so any in-flight server response is ignored.
  const requestId = ++previewRequestId;
  const requestEditVersion = previewEditVersion;

  if (usesLocalPreview()) {
    try {
      startLocalWorld({ newSeed });
    } catch (e) {
      teardownLocalWorld();
      previewLoading = false;
      previewError = e?.message ?? String(e);
    }
    updatePreviewHud();
    return;
  }

  teardownLocalWorld();
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
    let frame;
    if (localWorld) {
      frame = stepLocalSim(performance.now());
    } else {
      frame = currentPreviewFrame();
    }
    testRenderer.drawFrame(previewStage, frame ?? emptyFrame(), previewLabels);
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
    p0: { x: 300, y: 612, vx: 0, vy: 0, facing: 1, onGround: true, wall: 0, stun: 0, swipeT: 0, diveT: 0, lastClashTick: -9999, dead: false },
    p1: { x: 980, y: 612, vx: 0, vy: 0, facing: -1, onGround: true, wall: 0, stun: 0, swipeT: 0, diveT: 0, lastClashTick: -9999, dead: false },
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

  if (localWorld) {
    const score = `${localWorld.fighters[0].score}-${localWorld.fighters[1].score}`;
    const rounds = `${localWorld.fighters[0].rounds}-${localWorld.fighters[1].rounds}`;
    if (localWorld.matchWinner !== -1) {
      const winner = localWorld.matchWinner;
      const name = winner === 0 ? previewLabels.p1 : previewLabels.p2;
      setBuildStat("build-brief-result", `${name} wins · ${score}`);
      setBriefWinnerState(winner);
    } else {
      setBuildStat("build-brief-result", previewDirty ? "traits changed · test again" : `rounds ${rounds} · score ${score}`);
    }
    setBuildStat(
      "build-brief-meta",
      `${stageLabel(stageId)} · local sandbox`
    );
    return;
  }

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
    setBuildStat("build-brief-result", startPrompt());
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

  if (localWorld) {
    const score = `${localWorld.fighters[0].score}-${localWorld.fighters[1].score}`;
    setBuildStat("build-stat-server", "local");
    setBuildStat("build-stat-tick", `${localWorld.tick} / live`);
    if (localWorld.matchWinner !== -1) {
      const winner = localWorld.matchWinner;
      const name = winner === 0 ? previewLabels.p1 : previewLabels.p2;
      setBuildStat("build-stat-result", `${name} wins ${score}`);
    } else {
      setBuildStat("build-stat-result", `live ${score}`);
    }
    return;
  }

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
    setBuildStat("build-stat-result", startPrompt());
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
  if (el && el.textContent !== String(value)) el.textContent = String(value);
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
