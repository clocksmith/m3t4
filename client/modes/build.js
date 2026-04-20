// Build mode - 15-knob hard-budget builder with live test stage.
// Sliders hard-cap at USER_BUDGET so overspend is impossible; the
// hallucination penalty is dead code from a former "pay over budget
// with noise" design and stays 0 here. The live test stage below
// plays your current config vs an empirical easy/medium/hard preset
// picked from data/preset-ranking.v1.json (copied to client/data for the SPA).

import {
  USER_BUDGET,
  computedHallucinationForSpend,
  STAGES,
  STRATEGIES,
  compileBrain,
  createStepperWorld,
  runBrainForWorld,
  stepWorld,
  worldToFrame,
} from "../sim/index.js";
import { setupCanvas, drawFrame, W, H } from "../lib/render.js";
import presetRanking from "../data/preset-ranking.v1.json" with { type: "json" };

const BUDGET = USER_BUDGET;

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

const state = {};
for (const k of KNOBS) state[k.id] = k.init;

// --- live test stage ---
const STEP = 1 / 120;
const MAX_DT = 0.05;
const STAGE_IDS = Object.keys(STAGES);
// Keymaps borrowed from the former practice mode. P1 = WASD+F, P2 = PL;'+[.
const KEY_MAP = [
  { left: "KeyA", right: "KeyD", up: "KeyW", down: "KeyS", act: "KeyF" },
  { left: "KeyL", right: "Quote", up: "KeyP", down: "Semicolon", act: "BracketLeft" },
];
const GAME_KEYS = new Set([
  "KeyA","KeyD","KeyW","KeyS","KeyF",
  "KeyL","Quote","KeyP","Semicolon","BracketLeft",
]);
const keyset = new Set();
let stageId = STAGE_IDS[0];
let difficulty = "medium";
let world = null;
let testCtx = null;
let testCanvas = null;
let testRafId = 0;
let testLastTime = 0;
let testAcc = 0;
let testRunning = false;
let compiledUser = null;
let compiledOpp = null;
let testOutcome = "";
// Slot 0 defaults to user build (AI-compiled from current knobs); slot 1
// defaults to the difficulty preset. Either can be swapped to human.
let controllers = ["user", "preset"]; // "user" | "preset" | "human"

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

function denormalize(k, ui) {
  const [lo, hi] = k.range;
  return lo + (hi - lo) * (Math.max(0, Math.min(100, ui)) / 100);
}

function currentConfig() {
  const attrs = {};
  for (const k of KNOBS) attrs[k.id] = +denormalize(k, state[k.id]).toFixed(4);
  attrs.hallucination = computedHallucinationForSpend(currentSpent());
  return { id: "user-bot-" + Date.now().toString(36), attributes: attrs };
}

function currentSpent() {
  return KNOBS.reduce((s, k) => s + state[k.id], 0);
}

export function mount(root, { setStatus }) {
  setStatus("build");
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Build <small>- 15 knobs, budget ${BUDGET} - live test vs a preset or human</small></h1>
      </div>
      <div class="grid-3">
        <section class="panel">
          <h3>Attributes</h3>
          <div id="knobs"></div>
        </section>
        <section class="panel">
          <h3>Live test <small class="tight">- deterministic match</small></h3>
          <div class="row mb-sm">
            <div class="row" role="radiogroup" aria-label="difficulty">
              <button data-diff="easy"   class="diff-btn">easy - ${presetRanking.tiers.easy}</button>
              <button data-diff="medium" class="diff-btn">medium - ${presetRanking.tiers.medium}</button>
              <button data-diff="hard"   class="diff-btn">hard - ${presetRanking.tiers.hard}</button>
            </div>
          </div>
          <div class="row mb-sm">
            <label>P1 <select id="p1ctrl">
              <option value="user" selected>your build</option>
              <option value="human">human (WASD+F)</option>
              <option value="preset">preset opponent</option>
            </select></label>
            <label>P2 <select id="p2ctrl">
              <option value="preset" selected>preset opponent</option>
              <option value="human">human (PL;'+[)</option>
              <option value="user">your build</option>
            </select></label>
            <label>stage
              <select id="test-stage">${STAGE_IDS.map((s) => `<option value="${s}" ${s === stageId ? "selected" : ""}>${s}</option>`).join("")}</select>
            </label>
            <button id="test-reset">reset match</button>
            <button id="test-resim" class="primary">re-sim</button>
          </div>
          <canvas id="test-canvas" class="u-canvas-fill" width="${W}" height="${H}" tabindex="0"></canvas>
          <div class="tight mt-xs" id="test-hud"></div>
          <div class="tight mt-xs">tiers from round-robin (${presetRanking.totalMatches} matches, ${presetRanking.seedsPerPairing} seeds): easy=worst, medium=median, hard=top-25%. P1: W/A/S/D move, F attack. P2: P/L/;/' move, [ attack.</div>
        </section>
        <section class="panel">
          <h3>Budget <small class="tight">hard cap ${BUDGET}</small></h3>
          <div id="budget-row" class="metric-row">
            <span class="tight">spent / ${BUDGET}</span>
            <span id="budget-spent" class="metric-value">0</span>
          </div>
          <div id="budget-track" class="meter-track">
            <div id="budget-bar" class="meter-bar"></div>
          </div>
          <div id="remaining-row" class="metric-row loose">
            <span class="tight">remaining</span>
            <span id="budget-remaining" class="metric-value compact">${BUDGET}</span>
          </div>
          <div class="tight mb-md">sliders stop at total ${BUDGET}; submitted JSON over that limit is rejected by the server.</div>
          <div class="toolbar">
            <button id="reset-build">reset</button>
            <button id="randomize">randomize</button>
            <button id="copy-json" class="primary">copy JSON</button>
            <button id="go-submit" class="primary">send to profile</button>
          </div>
          <pre id="export" class="code-export"></pre>
          <div id="build-msg" class="tight"></div>
        </section>
      </div>
    </div>`;

  renderKnobs();
  update();

  root.querySelector("#reset-build").addEventListener("click", () => {
    for (const k of KNOBS) state[k.id] = k.init;
    renderKnobs();
    update();
  });
  root.querySelector("#randomize").addEventListener("click", () => {
    let remaining = BUDGET;
    const ids = KNOBS.map((k) => k.id);
    for (let i = 0; i < ids.length; i++) {
      const nLeft = ids.length - i;
      const cap = Math.min(100, remaining);
      const avg = remaining / nLeft;
      const v = Math.max(0, Math.min(cap, Math.round(avg + (Math.random() - 0.5) * avg * 0.8)));
      state[ids[i]] = v;
      remaining -= v;
    }
    renderKnobs();
    update();
  });
  root.querySelector("#copy-json").addEventListener("click", async () => {
    const out = document.getElementById("export").textContent;
    try {
      await navigator.clipboard.writeText(out);
      root.querySelector("#build-msg").textContent = "copied";
      setTimeout(() => (root.querySelector("#build-msg").textContent = ""), 1200);
    } catch (e) { root.querySelector("#build-msg").textContent = "copy failed"; }
  });
  root.querySelector("#go-submit").addEventListener("click", () => {
    const cfg = currentConfig();
    sessionStorage.setItem("m3t4:pendingSubmit", JSON.stringify(cfg));
    location.hash = "#profile";
  });

  // Live test wiring
  testCanvas = root.querySelector("#test-canvas");
  const { ctx: c } = setupCanvas(testCanvas);
  testCtx = c;
  const diffButtons = Array.from(root.querySelectorAll(".diff-btn"));
  const syncDiffHighlight = () => diffButtons.forEach((b) => b.classList.toggle("primary", b.dataset.diff === difficulty));
  diffButtons.forEach((b) => b.addEventListener("click", () => {
    difficulty = b.dataset.diff;
    syncDiffHighlight();
    rebuildOppBrainAndReset();
  }));
  syncDiffHighlight();
  const p1ctrl = root.querySelector("#p1ctrl");
  const p2ctrl = root.querySelector("#p2ctrl");
  const refocus = () => { keyset.clear(); testCanvas.focus(); };
  p1ctrl.addEventListener("change", () => { controllers[0] = p1ctrl.value; refocus(); });
  p2ctrl.addEventListener("change", () => { controllers[1] = p2ctrl.value; refocus(); });
  root.querySelector("#test-stage").addEventListener("change", (e) => {
    stageId = e.target.value;
    resetMatch();
    refocus();
  });
  root.querySelector("#test-reset").addEventListener("click", () => { resetMatch(); refocus(); });
  root.querySelector("#test-resim").addEventListener("click", () => { rebuildUserBrainAndReset(); refocus(); });

  addEventListener("keydown", onKeyDown);
  addEventListener("keyup", onKeyUp);
  addEventListener("blur", onBlur);

  rebuildUserBrainAndReset();
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
}

// Ceiling on how high THIS knob can go right now, given what the
// other knobs already spend. The slider's DOM `max` stays at 100
// — we clamp the value instead — so the thumb always shows
// value/100 and siblings don't visually jump when you're near budget.
function remainingCeiling(id) {
  const spentWithoutThis = currentSpent() - (state[id] ?? 0);
  return Math.max(0, Math.min(100, BUDGET - spentWithoutThis));
}

function renderKnobs() {
  const container = document.getElementById("knobs");
  container.innerHTML = "";
  for (const k of KNOBS) {
    const row = document.createElement("div");
    row.className = "knob";
    row.innerHTML = `
      <div>
        <span class="knob-name">${k.label}</span>
        <span class="knob-desc">${k.desc}</span>
      </div>
      <input type="range" min="0" max="100" step="1" value="${state[k.id]}" data-knob="${k.id}">
      <div class="knob-val" data-val="${k.id}">${state[k.id]}</div>`;
    container.appendChild(row);
  }
  container.querySelectorAll("input[type=range]").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const id = e.target.dataset.knob;
      const requested = parseInt(e.target.value, 10);
      const ceiling = remainingCeiling(id);
      const next = Math.max(0, Math.min(ceiling, requested));
      if (next !== requested) e.target.value = String(next);
      state[id] = next;
      const display = document.querySelector(`[data-val="${id}"]`);
      if (display) display.textContent = next;
      update();
    });
    // On release: re-compile the user's brain so the live test stage
    // reflects the latest knob values.
    inp.addEventListener("change", rebuildUserBrainAndReset);
  });
}

function syncKnobControls() {
  // Only sync the displayed VALUE + number label — never the `max`.
  // Changing max on every tick is what made the thumbs appear to
  // "move together" when one slider was dragged near budget.
  document.querySelectorAll("input[type=range][data-knob]").forEach((inp) => {
    const id = inp.dataset.knob;
    inp.value = String(state[id]);
    const display = document.querySelector(`[data-val="${id}"]`);
    if (display) display.textContent = state[id];
  });
}

function update() {
  const spent = currentSpent();
  const remaining = Math.max(0, BUDGET - spent);
  syncKnobControls();

  const spentEl = document.getElementById("budget-spent");
  spentEl.textContent = spent;
  spentEl.classList.toggle("is-full", remaining === 0);

  document.getElementById("budget-bar").style.width = Math.min(100, (spent / BUDGET) * 100) + "%";

  const remainingEl = document.getElementById("budget-remaining");
  remainingEl.textContent = remaining;
  remainingEl.classList.toggle("is-full", remaining === 0);

  document.getElementById("export").textContent = JSON.stringify(currentConfig(), null, 2);
}

// ---------------- Live test helpers ----------------

function oppName() { return presetRanking.tiers[difficulty] ?? presetRanking.tiers.medium; }

function rebuildUserBrainAndReset() {
  try { compiledUser = compileBrain(currentConfig()); }
  catch (e) { compiledUser = null; console.warn("user brain compile failed", e); }
  rebuildOppBrainAndReset();
}
function rebuildOppBrainAndReset() {
  try { compiledOpp = compileBrain(STRATEGIES[oppName()]); }
  catch (e) { compiledOpp = null; console.warn("opp brain compile failed", e); }
  resetMatch();
}
function readSlot(idx) {
  const ctrl = controllers[idx];
  if (ctrl === "human") return readKeyboard(idx);
  const brain = ctrl === "user" ? compiledUser : compiledOpp;
  if (!brain) return {};
  const a = runBrainForWorld(world, brain, idx) || {};
  return { left: !!a.left, right: !!a.right, up: !!a.up, down: !!a.down, action: !!a.action };
}
function labelForSlot(idx) {
  const ctrl = controllers[idx];
  if (ctrl === "human") return idx === 0 ? "human P1" : "human P2";
  return ctrl === "user" ? "your build" : oppName();
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
    drawFrame(testCtx, world.stage, worldToFrame(world), { p1: labelForSlot(0), p2: labelForSlot(1) });
    const hud = document.getElementById("test-hud");
    if (hud) hud.textContent = `tick ${world.tick}  -  ${world.matchWinner === -1 ? "live" : testOutcome}`;
  }
  testRafId = requestAnimationFrame(loopTest);
}
