// Build mode - 15-knob builder with live deterministic test stage.
// Base budget is USER_BUDGET; sliders may overspend only up to the
// derived hallucination cap. The live test stage plays your current
// config vs an empirical easy/medium/hard preset picked from
// data/preset-ranking.v1.json (copied to client/data for the SPA).

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
import presetRanking from "../data/preset-ranking.v1.json" with { type: "json" };

const BUDGET = USER_BUDGET;
// Hallucination saturates at MAX_DERIVED_HALLUCINATION, reached at
// BUDGET + MAX/COST total spend. Past this point every extra knob point
// was free under the old design — cap sliders there.
const HARD_CAP = MAX_USER_SPEND;

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
let presetName = presetRanking.tiers.medium;
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
const BENCHMARK_TIERS = ["easy", "medium", "hard"];
const BENCHMARK_PRESETS = new Set(BENCHMARK_TIERS.map((tier) => presetRanking.tiers[tier]).filter(Boolean));

function presetSelectOptions() {
  const benchmark = BENCHMARK_TIERS
    .map((tier) => {
      const name = presetRanking.tiers[tier];
      if (!name) return "";
      return `<option value="${name}" ${name === presetName ? "selected" : ""}>${tier} - ${name}</option>`;
    })
    .join("");
  const rest = STRATEGY_NAMES
    .filter((name) => !BENCHMARK_PRESETS.has(name))
    .map((name) => `<option value="${name}" ${name === presetName ? "selected" : ""}>${name}</option>`)
    .join("");
  return `<optgroup label="benchmarks">${benchmark}</optgroup><optgroup label="more presets">${rest}</optgroup>`;
}

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
          <div class="live-test-controls mb-sm">
            <label class="live-control role-preset" id="preset-control"><span>preset</span>
              <select id="opp-preset">${presetSelectOptions()}</select>
            </label>
            <label class="live-control role-build" id="p1-control"><span>P1</span><select id="p1ctrl">
              <option value="user" selected>BUILD - your build</option>
              <option value="preset">PRESET - opponent</option>
              <option value="human">HUMAN - WASD+F</option>
            </select></label>
            <label class="live-control role-preset" id="p2-control"><span>P2</span><select id="p2ctrl">
              <option value="preset" selected>PRESET - opponent</option>
              <option value="user">BUILD - your build</option>
              <option value="human">HUMAN - PL;'+[</option>
            </select></label>
            <label class="live-control"><span>stage</span>
              <select id="test-stage">${STAGE_IDS.map((s) => `<option value="${s}" ${s === stageId ? "selected" : ""}>${s}</option>`).join("")}</select>
            </label>
            <button id="test-reset">reset match</button>
            <button id="test-resim" class="primary">re-sim</button>
          </div>
          <canvas id="test-canvas" class="u-canvas-fill" width="${W}" height="${H}" tabindex="0"></canvas>
          <div class="tight mt-xs" id="test-hud"></div>
        </section>
        <section class="panel">
          <h3>Budget <small class="tight">soft ${BUDGET} · hard cap ${HARD_CAP}</small></h3>
          <div id="budget-row" class="metric-row">
            <span class="tight">spent / ${HARD_CAP}</span>
            <span id="budget-spent" class="metric-value">0</span>
          </div>
          <div id="budget-track" class="meter-track" style="position:relative;">
            <div id="budget-bar" class="meter-bar"></div>
            <div id="budget-over" class="meter-bar over" style="position:absolute; left:100%; top:0; height:100%; background:var(--ui-red); width:0%;"></div>
          </div>
          <div id="remaining-row" class="metric-row loose">
            <span class="tight">remaining</span>
            <span id="budget-remaining" class="metric-value compact">${BUDGET}</span>
          </div>
          <div id="hallucination-block" hidden style="margin-top:10px;">
            <div class="metric-row">
              <span class="tight">hallucination (overspend × ${HALLUCINATION_PER_OVERAGE})</span>
              <span id="hallucination-val" class="metric-value" style="color:var(--ui-red);">0</span>
            </div>
            <div class="meter-track" style="background:#2a1014;">
              <div id="hallucination-bar" class="meter-bar" style="background:var(--ui-red);"></div>
            </div>
          </div>
          <div class="tight mb-md">over ${BUDGET}: ${HALLUCINATION_PER_OVERAGE} hallucination per extra point. sliders stop at ${HARD_CAP} where hallucination saturates at ${MAX_DERIVED_HALLUCINATION}.</div>
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
    rebuildUserBrainAndReset();
  });
  root.querySelector("#randomize").addEventListener("click", () => {
    // Stay at/under BUDGET by default — randomize shouldn't auto-burn
    // hallucination on the user.
    let remaining = BUDGET;
    const ids = KNOBS.map((k) => k.id);
    for (let i = 0; i < ids.length; i++) {
      const nLeft = ids.length - i;
      const cap = Math.min(100, remaining);
      const avg = remaining / Math.max(1, nLeft);
      const v = Math.max(0, Math.min(cap, Math.round(avg + (Math.random() - 0.5) * avg * 0.8)));
      state[ids[i]] = v;
      remaining -= v;
    }
    renderKnobs();
    update();
    rebuildUserBrainAndReset();
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
  const presetSelect = root.querySelector("#opp-preset");
  const p1ctrl = root.querySelector("#p1ctrl");
  const p2ctrl = root.querySelector("#p2ctrl");
  const refocus = () => { keyset.clear(); testCanvas.focus(); };
  presetSelect.addEventListener("change", () => {
    presetName = presetSelect.value;
    // Changing the difficulty/preset pulls that bot's config into the
    // sliders so the user can inspect and tune from it. Their previous
    // edits overwrite; this is explicit load behavior. Human slots are
    // unaffected (they don't have a config).
    loadPresetIntoSliders(presetName);
    renderKnobs();
    update();
    syncLiveControls();
    rebuildUserBrainAndReset(); // sliders changed, so user-brain changed too
    refocus();
  });
  p1ctrl.addEventListener("change", () => {
    controllers[0] = p1ctrl.value;
    syncLiveControls();
    refocus();
  });
  p2ctrl.addEventListener("change", () => {
    controllers[1] = p2ctrl.value;
    syncLiveControls();
    refocus();
  });
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

  syncLiveControls();
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
  // Sliders cap at the HARD_CAP (390 default = 360 budget + 30 points
  // of overage before hallucination saturates). Total spend above
  // BUDGET (360) is legal but activates the hallucination penalty.
  const spentWithoutThis = currentSpent() - (state[id] ?? 0);
  return Math.max(0, Math.min(100, HARD_CAP - spentWithoutThis));
}

// Reverse-map a preset's native attributes back to the UI slider
// 0-100 space, so picking "easy · unicorn" or "hard · acolyte" loads
// that preset into the knobs as a starting point the user can tune.
function loadPresetIntoSliders(name) {
  const preset = STRATEGIES[name];
  if (!preset) return;
  for (const k of KNOBS) {
    const raw = preset.attributes?.[k.id];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    state[k.id] = Math.round(nativeToUI(k.id, raw));
  }
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
      e.target.style.setProperty("--fill", `${next}%`);
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
  // Only sync the displayed VALUE + --fill custom prop + number label.
  // Never update the `max` — that was what made the thumbs appear to
  // "move together" when one slider was dragged near budget.
  document.querySelectorAll("input[type=range][data-knob]").forEach((inp) => {
    const id = inp.dataset.knob;
    const v = state[id];
    inp.value = String(v);
    // Drives the themed linear-gradient track fill in app.css.
    inp.style.setProperty("--fill", `${v}%`);
    const display = document.querySelector(`[data-val="${id}"]`);
    if (display) display.textContent = v;
  });
}

function update() {
  const spent = currentSpent();
  const over = Math.max(0, spent - BUDGET);
  const remaining = Math.max(0, BUDGET - spent);
  const hallucination = computedHallucinationForSpend(spent);
  syncKnobControls();

  const spentEl = document.getElementById("budget-spent");
  spentEl.textContent = spent;
  spentEl.classList.toggle("is-full", remaining === 0);
  spentEl.classList.toggle("is-over", over > 0);

  // Green bar fills the legal slider range. Crossing BUDGET switches the
  // value text to red and also extends the small overflow marker.
  document.getElementById("budget-bar").style.width = Math.min(100, (spent / HARD_CAP) * 100) + "%";
  const overEl = document.getElementById("budget-over");
  if (overEl) overEl.style.width = ((over / BUDGET) * 100) + "%";

  const remainingEl = document.getElementById("budget-remaining");
  remainingEl.textContent = over > 0 ? `over by ${over}` : remaining;
  remainingEl.classList.toggle("is-full", remaining === 0);
  remainingEl.classList.toggle("is-over", over > 0);

  // Hallucination row: hidden until overspend, then fills 0..MAX.
  const hallBlock = document.getElementById("hallucination-block");
  const hallBar = document.getElementById("hallucination-bar");
  const hallVal = document.getElementById("hallucination-val");
  if (hallBlock && hallBar && hallVal) {
    const showHall = over > 0;
    hallBlock.hidden = !showHall;
    hallBar.style.width = ((hallucination / MAX_DERIVED_HALLUCINATION) * 100) + "%";
    hallVal.textContent = `${hallucination} / ${MAX_DERIVED_HALLUCINATION}`;
  }

  document.getElementById("export").textContent = JSON.stringify(currentConfig(), null, 2);
}

// ---------------- Live test helpers ----------------

function oppName() { return STRATEGIES[presetName] ? presetName : presetRanking.tiers.medium; }

function roleClass(ctrl) {
  if (ctrl === "human") return "role-human";
  if (ctrl === "preset") return "role-preset";
  return "role-build";
}

function syncLiveControls() {
  const preset = document.getElementById("opp-preset");
  const p1 = document.getElementById("p1-control");
  const p2 = document.getElementById("p2-control");
  if (preset) preset.value = oppName();
  for (const el of [p1, p2]) {
    if (!el) continue;
    el.classList.remove("role-build", "role-preset", "role-human");
  }
  p1?.classList.add(roleClass(controllers[0]));
  p2?.classList.add(roleClass(controllers[1]));
}

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
  if (ctrl === "human") return `HUMAN P${idx + 1}`;
  return ctrl === "user" ? "BUILD" : `PRESET ${oppName()}`;
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
    if (hud) hud.textContent = `${labelForSlot(0)} vs ${labelForSlot(1)}  -  ${stageId}  -  tick ${world.tick}  -  ${world.matchWinner === -1 ? "live" : testOutcome}`;
  }
  testRafId = requestAnimationFrame(loopTest);
}
