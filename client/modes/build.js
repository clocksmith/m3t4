// Build mode — 11-knob budgeted builder. Overspending derives hallucination.
// Exports arena-compatible BrainConfig JSON. "Send to submit" button
// hands off to submit mode.

import {
  HALLUCINATION_PER_OVERAGE,
  MAX_DERIVED_HALLUCINATION,
  USER_BUDGET,
  computedHallucinationForSpend,
} from "../sim/index.js";

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
];

const state = {};
for (const k of KNOBS) state[k.id] = k.init;

let overBudgetNoticeArmed = true;

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
  overBudgetNoticeArmed = true;
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Build <small>— 11 knobs, budget ${BUDGET}</small></h1>
        <div class="tight">tighten knobs to out-engineer the meta</div>
      </div>
      <div class="grid-2">
        <section class="panel">
          <h3>Attributes</h3>
          <div id="knobs"></div>
        </section>
        <section class="panel">
          <h3>Budget</h3>
          <div id="budget-row" style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px;">
            <span class="tight">spent / ${BUDGET}</span>
            <span id="budget-spent" style="font-family:ui-monospace; font-size:22px; font-weight:700; color:#6ee7b7;">0</span>
          </div>
          <div id="budget-track" style="position:relative; height:6px; background:#1f1f2a; margin-bottom:10px; overflow:visible;">
            <div id="budget-bar" style="height:100%; background:#6ee7b7; width:0%; transition:width 0.15s;"></div>
            <div id="budget-over" style="position:absolute; left:100%; top:0; height:100%; background:#ef4444; width:0%; transition:width 0.15s;"></div>
          </div>
          <div id="hallucination-row" style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px;">
            <span class="tight">hallucination</span>
            <span id="hallucination-val" style="font-family:ui-monospace; font-size:18px; font-weight:700; color:#6ee7b7;">0</span>
          </div>
          <div class="tight" style="margin-bottom:10px;">each point over budget costs ${HALLUCINATION_PER_OVERAGE} hallucination, capped at ${MAX_DERIVED_HALLUCINATION}</div>
          <div style="display:flex; gap:6px; margin-bottom:10px;">
            <button id="reset-build">reset</button>
            <button id="randomize">randomize</button>
            <button id="copy-json" class="primary">copy JSON</button>
            <button id="go-submit" class="primary">send to submit →</button>
          </div>
          <pre id="export" style="background:#0a0a14; border:1px solid #2a2a3a; padding:10px; font-family:ui-monospace; font-size:10.5px; color:#c8e0c8; white-space:pre; overflow:auto; max-height:280px;"></pre>
          <div id="build-msg" class="tight"></div>
        </section>
      </div>
      <dialog id="hallucination-dialog" style="background:#0a0a14; border:1px solid #ef4444; color:#f8fafc; padding:18px; max-width:360px;">
        <div style="font-weight:700; margin-bottom:8px;">you can't see more than 360 deg in reality</div>
        <div class="tight" style="margin-bottom:14px;">hallucination kicking in</div>
        <button id="close-hallucination-dialog" class="primary">ok</button>
      </dialog>
    </div>`;

  const warningDialog = root.querySelector("#hallucination-dialog");
  root.querySelector("#close-hallucination-dialog").addEventListener("click", () => warningDialog.close());
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
      root.querySelector("#build-msg").textContent = "copied ✓";
      setTimeout(() => (root.querySelector("#build-msg").textContent = ""), 1200);
    } catch (e) { root.querySelector("#build-msg").textContent = "copy failed"; }
  });
  root.querySelector("#go-submit").addEventListener("click", () => {
    const cfg = currentConfig();
    sessionStorage.setItem("m3t4:pendingSubmit", JSON.stringify(cfg));
    location.hash = "#submit";
  });
}

export function unmount() {
  overBudgetNoticeArmed = true;
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
      state[id] = requested;
      const display = document.querySelector(`[data-val="${id}"]`);
      if (display) display.textContent = requested;
      update();
    });
  });
}

function update() {
  const spent = currentSpent();
  const hallucination = computedHallucinationForSpend(spent);
  const over = Math.max(0, spent - BUDGET);
  if (over === 0) overBudgetNoticeArmed = true;
  else if (overBudgetNoticeArmed) {
    overBudgetNoticeArmed = false;
    const dialog = document.getElementById("hallucination-dialog");
    if (dialog?.showModal && !dialog.open) dialog.showModal();
    else document.getElementById("build-msg").textContent = "you can't see more than 360 deg in reality; hallucination kicking in";
  }
  const spentEl = document.getElementById("budget-spent");
  spentEl.textContent = spent;
  spentEl.style.color = over > 0 ? "#ef4444" : "#6ee7b7";
  document.getElementById("budget-bar").style.width = Math.min(100, (spent / BUDGET) * 100) + "%";
  document.getElementById("budget-over").style.width = (over / BUDGET) * 100 + "%";
  const hallEl = document.getElementById("hallucination-val");
  hallEl.textContent = hallucination;
  hallEl.style.color =
    hallucination === 0 ? "#6ee7b7" :
    hallucination <= 50 ? "#facc15" :
    hallucination <= 150 ? "#fb923c" : "#ef4444";
  const cfg = currentConfig();
  document.getElementById("export").textContent = JSON.stringify(cfg, null, 2);
}
