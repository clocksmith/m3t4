// Profile mode — signed-in identity, stable roster, stats, and bot
// submission. Only the owner can see this view; the sign-in gate stays
// if there's no authenticated user.

import { auth } from "../lib/auth.js";
import * as api from "../lib/api.js";
import {
  BUDGET,
  configFromState,
  dirtyCount,
  formatConfigJson,
  neutralBuildState,
  normalizeBuildConfig,
  parseBuildConfigJson,
  remainingCeilingForState,
  stateFromConfig,
  stateSpent,
} from "../lib/build-config.js";
import { renderSliderEditor } from "../lib/slider-editor.js";
import { trackProfileSignIn, trackProfileHandleClaim, trackProfileSubmitConfig } from "../lib/analytics.js";

let root = null;
let setStatus = () => {};

const ROSTER_SIZE = 5;
let selectedSlot = 0;
let rosterCache = null; // last loaded stable response, or null
let editorStateBySeat = new Map();
let activeEditorTab = "sliders";
let pendingBuildConfig = null;
let pendingAutoApplied = false;

function rosterIntroPanelHtml({ needsHandle = false } = {}) {
  const pending = sessionStorage.getItem("m3t4:pendingSubmit");
  const claimForm = needsHandle ? `
      <div class="roster-intro-claim">
        <div class="tight mb-xs">Claim a public handle first. 3-20 chars, lowercase + digits + underscore.</div>
        <div class="row">
          <input type="text" id="handle-input" placeholder="your_handle">
          <button id="handle-claim" class="primary">claim</button>
        </div>
        <div class="error" id="handle-err"></div>
      </div>` : "";
  return `
    <section class="context-card roster-intro-panel">
      <div class="context-card-kicker">ranked roster</div>
      <div class="roster-intro-copy">
        <strong>${pending ? "Bot ready for the live roster." : "Your live roster holds five bots."}</strong>
        <span>Tune one, test it, then send it into a seat. The server schedules matches. Live streams the current fight.</span>
      </div>
      ${claimForm}
    </section>`;
}

export function mount(mountEl, ctx) {
  root = mountEl;
  setStatus = ctx.setStatus;
  render();
  // Re-render on auth changes
  const off = auth.onChange(render);
  mountEl._off = off;
}

export function unmount() {
  if (root && root._off) root._off();
  root = null;
}

function render() {
  const user = auth.user();
  if (!user) return renderSignIn();
  renderDashboard(user);
}

function rosterPageHeaderHtml({ subtitle = "", action = "" } = {}) {
  return `
    <div class="page-header-row">
      <div class="page-title-stack">
        <h1 class="page-title">Roster</h1>
        ${subtitle ? `<div class="page-subtitle tight">${subtitle}</div>` : ""}
      </div>
      ${action}
    </div>`;
}

function renderSignIn() {
  setStatus("roster · not signed in");
  const authError = auth.error?.();
  if (auth.mode === "firebase") return renderFirebaseSignIn(authError);
  const isAlpha = auth.mode === "alpha-token";

  root.innerHTML = `
    <div class="page">
      ${rosterPageHeaderHtml({ subtitle: "sign in to install ranked seats" })}
      ${rosterIntroPanelHtml()}
      <div class="panel">
        <h3>${isAlpha ? "Closed alpha" : "Dev mode"}</h3>
        <p class="tight mb-lg">
          ${isAlpha
            ? "Closed alpha auth: pick your invited UID. The deploy config signs it with the shared alpha token."
            : "Local dev auth: pick any UID; the server accepts it as your identity."}
        </p>
        <div class="row">
          <input type="text" id="uid-input" class="u-fill" placeholder="pick a uid (3-64 chars, a-z 0-9 _ -)">
          <button id="signin-btn" class="primary">sign in</button>
        </div>
        <div class="error" id="signin-err"></div>
      </div>
    </div>`;
  root.querySelector("#signin-btn").addEventListener("click", async () => {
    const input = root.querySelector("#uid-input");
    const err = root.querySelector("#signin-err");
    err.textContent = "";
    try {
      await auth.signIn(input.value.trim());
      trackProfileSignIn(auth.mode === "alpha-token" ? "alpha" : "dev", true);
    } catch (e) {
      err.textContent = e.message;
      trackProfileSignIn(auth.mode === "alpha-token" ? "alpha" : "dev", false);
    }
  });
  root.querySelector("#uid-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") root.querySelector("#signin-btn").click();
  });
}

function renderFirebaseSignIn(authError) {
  root.innerHTML = `
    <div class="page">
      ${rosterPageHeaderHtml({ subtitle: "sign in to install ranked seats" })}
      ${rosterIntroPanelHtml()}
      <div class="panel">
        <h3>Sign in</h3>
        <p class="tight mb-lg">
          Ranked submissions require Firebase auth. Production builds must
          provide window.__M3T4_FIREBASE_CONFIG__ before app.js loads.
        </p>
        <div class="row">
          <button id="signin-google" class="primary">sign in with Google</button>
          <button id="signin-github">sign in with GitHub</button>
        </div>
        <div class="error" id="signin-err">${authError ? escapeHtml(authError) : ""}</div>
      </div>
    </div>`;

  async function doSignIn(provider) {
    const err = root.querySelector("#signin-err");
    err.textContent = "";
    try {
      await auth.signIn(provider);
      trackProfileSignIn(provider, true);
    } catch (e) {
      err.textContent = e.message;
      trackProfileSignIn(provider, false);
    }
  }

  root.querySelector("#signin-google").addEventListener("click", () => doSignIn("google"));
  root.querySelector("#signin-github").addEventListener("click", () => doSignIn("github"));
}

async function renderDashboard(user) {
  setStatus(`roster · ${user.uid}`);
  editorStateBySeat = new Map();
  activeEditorTab = "sliders";
  pendingBuildConfig = readPendingBuildConfig();
  pendingAutoApplied = false;
  root.innerHTML = `
    <div class="page">
      ${rosterPageHeaderHtml({
        subtitle: `@${user.handle ?? "unclaimed"} · ${user.uid} · only you can see this`,
        action: `<button id="signout">sign out</button>`,
      })}
      ${rosterIntroPanelHtml({ needsHandle: !user.handle })}
      <div class="panel profile-roster-panel">
        <div class="profile-roster-head">
          <h3>Boardroom Roster</h3>
          <small class="tight" id="roster-subtitle">loading…</small>
        </div>
        <div id="roster-grid" class="roster-grid"></div>
        <div class="seat-editor" id="seat-editor">
          <div class="seat-editor-head">
            <h3 id="editor-title">Install seat 0</h3>
            <div class="tight" id="editor-note">vacant</div>
          </div>
          <div class="profile-submit-row">
            <label>name <input type="text" id="slot-name" placeholder="e.g. bruiser-v2"></label>
            <div class="profile-submit-actions">
              <button id="reset-editor" class="tight">reset</button>
              <button id="paste-pending" class="tight">load tuned build</button>
              <button id="submit-btn" class="primary">install</button>
            </div>
          </div>
          <div class="profile-editor-meter" id="profile-editor-meter"></div>
          <div class="profile-editor-tabs" role="tablist" aria-label="roster editor mode">
            <button type="button" data-editor-tab="sliders" class="is-active">sliders</button>
            <button type="button" data-editor-tab="json">json</button>
          </div>
          <div id="profile-slider-panel" class="profile-slider-panel"></div>
          <div id="profile-json-panel" class="profile-json-panel" hidden>
            <div class="profile-json-actions">
              <button type="button" id="copy-config-json">copy json</button>
              <button type="button" id="import-config-json">import json</button>
            </div>
            <pre id="config-json-preview" class="config-json-preview"></pre>
          </div>
          <dialog id="json-import-dialog" class="json-import-dialog">
            <div class="json-import-card">
              <h3>import json</h3>
              <textarea id="json-import-textarea" class="config-json-textarea" rows="12" spellcheck="false" placeholder="paste a complete config JSON object"></textarea>
              <div class="profile-submit-actions">
                <button type="button" id="cancel-json-import">cancel</button>
                <button type="button" id="apply-json-import" class="primary">load</button>
              </div>
              <div id="json-import-msg" class="tight"></div>
            </div>
          </dialog>
          <div id="submit-msg"></div>
        </div>
      </div>
    </div>`;

  root.querySelector("#signout").addEventListener("click", () => auth.signOut());
  if (!user.handle) wireClaimHandle();
  wireEditorControls();
  wireSubmit(user);
  loadStable(user);
  wirePendingBuildConfig();
}


function wireClaimHandle() {
  root.querySelector("#handle-claim").addEventListener("click", async () => {
    const input = root.querySelector("#handle-input");
    const err = root.querySelector("#handle-err");
    err.textContent = "";
    try {
      const r = await api.claimHandle(await auth.token(), input.value.trim());
      auth.setHandle(r.handle);
      trackProfileHandleClaim(true);
    } catch (e) { err.textContent = e.message; trackProfileHandleClaim(false); }
  });
}

function wireSubmit(user) {
  root.querySelector("#submit-btn").addEventListener("click", async () => {
    const msg = root.querySelector("#submit-msg");
    msg.className = "tight";
    msg.textContent = "";
    const wasFilled = isFilled(selectedSlot);
    try {
      if (!(rosterCache?.handle ?? user.handle)) throw new Error("claim a handle first");
      const nameInput = root.querySelector("#slot-name").value.trim();
      const draft = draftForSeat(selectedSlot);
      const cfg = normalizeBuildConfig(configFromState(draft.state));
      const r = await api.submitSlot(await auth.token(), selectedSlot, cfg, nameInput || undefined);
      msg.className = "ok";
      msg.textContent = `seat ${selectedSlot} ${wasFilled ? "revised" : "installed"} · slotId=${r.slotId}`;
      sessionStorage.removeItem("m3t4:pendingSubmit");
      pendingBuildConfig = null;
      editorStateBySeat.delete(selectedSlot);
      const pendingButton = root.querySelector("#paste-pending");
      if (pendingButton) {
        pendingButton.disabled = true;
        pendingButton.classList.remove("is-ready");
        pendingButton.textContent = "load tuned build";
      }
      loadStable(user);
      trackProfileSubmitConfig(true);
    } catch (e) {
      msg.className = "error";
      msg.textContent = e.message;
      trackProfileSubmitConfig(false);
    }
  });
}

function isFilled(slotIdx) {
  const slot = rosterCache?.slots?.[slotIdx];
  return !!(slot && slot.slotId);
}

function wirePendingBuildConfig() {
  const btn = root.querySelector("#paste-pending");
  if (!pendingBuildConfig) {
    btn.disabled = true;
    return;
  }

  btn.textContent = "load tuned build";
  btn.classList.add("is-ready");
  btn.addEventListener("click", () => {
    applyPendingBuildToSeat(selectedSlot);
    updateEditor();
  });
}

function readPendingBuildConfig() {
  const raw = sessionStorage.getItem("m3t4:pendingSubmit");
  if (!raw) return null;
  try {
    return parseBuildConfigJson(raw);
  } catch {
    return null;
  }
}

function savedStateForSeat(slotIdx) {
  const slot = rosterCache?.slots?.[slotIdx];
  if (!slot?.config) return neutralBuildState();
  try {
    return stateFromConfig(slot.config);
  } catch {
    return neutralBuildState();
  }
}

function cloneState(state) {
  return { ...state };
}

function draftForSeat(slotIdx) {
  const existing = editorStateBySeat.get(slotIdx);
  if (existing) return existing;
  const baseState = savedStateForSeat(slotIdx);
  const draft = { state: cloneState(baseState), baseState: cloneState(baseState), source: "server" };
  editorStateBySeat.set(slotIdx, draft);
  return draft;
}

function setDraftForSeat(slotIdx, state, source = "user") {
  const baseState = savedStateForSeat(slotIdx);
  const draft = { state: cloneState(state), baseState: cloneState(baseState), source };
  editorStateBySeat.set(slotIdx, draft);
  return draft;
}

function applyPendingBuildToSeat(slotIdx) {
  if (!pendingBuildConfig) return null;
  return setDraftForSeat(slotIdx, stateFromConfig(pendingBuildConfig), "pending");
}

function maybeAutoApplyPendingBuild() {
  if (pendingAutoApplied || !pendingBuildConfig) return;
  applyPendingBuildToSeat(selectedSlot);
  pendingAutoApplied = true;
}

function wireEditorControls() {
  root.querySelectorAll("[data-editor-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      activeEditorTab = button.dataset.editorTab || "sliders";
      updateEditor();
    });
  });

  root.querySelector("#reset-editor").addEventListener("click", () => {
    editorStateBySeat.delete(selectedSlot);
    updateEditor();
  });

  root.querySelector("#copy-config-json").addEventListener("click", async () => {
    const msg = root.querySelector("#submit-msg");
    try {
      const json = formatConfigJson(configFromState(draftForSeat(selectedSlot).state));
      await navigator.clipboard.writeText(json);
      msg.className = "ok";
      msg.textContent = "json copied";
    } catch (e) {
      msg.className = "error";
      msg.textContent = e.message;
    }
  });

  root.querySelector("#import-config-json").addEventListener("click", () => {
    const dialog = root.querySelector("#json-import-dialog");
    const textarea = root.querySelector("#json-import-textarea");
    const msg = root.querySelector("#json-import-msg");
    textarea.value = "";
    msg.className = "tight";
    msg.textContent = "";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  });

  root.querySelector("#cancel-json-import").addEventListener("click", closeImportDialog);
  root.querySelector("#apply-json-import").addEventListener("click", () => {
    const textarea = root.querySelector("#json-import-textarea");
    const msg = root.querySelector("#json-import-msg");
    msg.className = "tight";
    msg.textContent = "";
    try {
      const cfg = parseBuildConfigJson(textarea.value);
      setDraftForSeat(selectedSlot, stateFromConfig(cfg), "json");
      closeImportDialog();
      activeEditorTab = "sliders";
      updateEditor();
    } catch (e) {
      msg.className = "error";
      msg.textContent = e.message;
    }
  });
}

function closeImportDialog() {
  const dialog = root.querySelector("#json-import-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

async function loadStable(user) {
  const subtitle = root.querySelector("#roster-subtitle");
  const grid = root.querySelector("#roster-grid");
  if (!grid) return;
  try {
    const s = await api.getMyStable(await auth.token()).catch((e) => {
      if (e.status === 404) return null;
      throw e;
    });
    rosterCache = s;
    if (s?.handle && user.handle !== s.handle) {
      auth.setHandle(s.handle);
      return;
    }
    if (subtitle) {
      const summary = stableSummary(s);
      subtitle.textContent = s
        ? `@${s.handle} · aggregate ELO ${summary.eloAggregate} · ${summary.wins}w ${summary.losses}l`
        : "vacant boardroom";
    }
    renderRosterGrid(grid, s);
    maybeAutoApplyPendingBuild();
    updateEditor();
  } catch (e) {
    grid.innerHTML = `<div class="error">roster error: ${escapeHtml(e.message)}</div>`;
  }
}

function renderRosterGrid(grid, stable) {
  const slots = Array.from({ length: ROSTER_SIZE }, (_, i) => stable?.slots?.[i] ?? null);
  grid.innerHTML = slots.map((slot, i) => {
    const filled = !!(slot && slot.slotId);
    const active = i === selectedSlot ? "is-active" : "";
    const state = filled ? "is-filled" : "is-empty";
    const name = filled ? escapeHtml(slot.name ?? "unnamed") : "vacant seat";
    const elo = filled ? `<div class="seat-elo">${slot.elo}</div>` : "";
    const wl = filled ? `<div class="seat-wl">${slot.wins}-${slot.losses}-${slot.draws}</div>` : "";
    const last = filled && slot.lastPlayedAt
      ? `<div class="seat-last">${relativeTime(slot.lastPlayedAt)}</div>`
      : filled
      ? `<div class="seat-last">unplayed</div>`
      : `<div class="seat-last">vacant</div>`;
    return `
      <button type="button" class="seat-card ${state} ${active}" data-slot="${i}">
        <div class="seat-head">
          <span class="seat-label">SEAT ${i}</span>
          <span class="seat-state-dot"></span>
        </div>
        <div class="seat-name">${name}</div>
        ${elo}${wl}
        ${last}
      </button>`;
  }).join("");
  grid.querySelectorAll(".seat-card").forEach((card) => {
    card.addEventListener("click", () => {
      selectedSlot = parseInt(card.dataset.slot, 10);
      grid.querySelectorAll(".seat-card").forEach((c) => c.classList.toggle("is-active", c === card));
      updateEditor();
    });
  });
}

function stableSummary(stable) {
  if (!stable) return { eloAggregate: 1000, wins: 0, losses: 0 };
  const slots = Array.from({ length: ROSTER_SIZE }, (_, i) => stable.slots?.[i] ?? null)
    .filter((slot) => slot && slot.slotId);
  const wins = Number.isFinite(stable.wins)
    ? stable.wins
    : slots.reduce((sum, slot) => sum + Number(slot.wins ?? 0), 0);
  const losses = Number.isFinite(stable.losses)
    ? stable.losses
    : slots.reduce((sum, slot) => sum + Number(slot.losses ?? 0), 0);
  const eloAggregate = Number.isFinite(stable.eloAggregate)
    ? stable.eloAggregate
    : slots.length
      ? Math.round(slots.reduce((sum, slot) => sum + Number(slot.elo ?? 1000), 0) / slots.length)
      : 1000;
  return { eloAggregate, wins, losses };
}

function updateEditor() {
  const title = root.querySelector("#editor-title");
  const note = root.querySelector("#editor-note");
  const btn = root.querySelector("#submit-btn");
  const nameInput = root.querySelector("#slot-name");
  if (!title || !btn) return;
  const slot = rosterCache?.slots?.[selectedSlot];
  const filled = !!(slot && slot.slotId);
  const draft = draftForSeat(selectedSlot);
  const changes = dirtyCount(draft.baseState, draft.state);
  title.textContent = filled ? `Revise seat ${selectedSlot}` : `Install seat ${selectedSlot}`;
  if (note) {
    note.textContent = filled
      ? `${slot.elo} ELO · ${slot.wins}-${slot.losses}-${slot.draws} · ${slot.lastPlayedAt ? relativeTime(slot.lastPlayedAt) : "unplayed"}`
      : "vacant";
  }
  btn.textContent = `${filled ? "revise" : "install"}${changes > 0 ? ` · ${changes} changed` : ""}`;
  btn.classList.toggle("is-dirty", changes > 0);
  if (filled && nameInput && !nameInput.value.trim()) {
    nameInput.placeholder = slot.name ? `current: ${slot.name}` : "e.g. bruiser-v2";
  } else if (nameInput) {
    nameInput.placeholder = "e.g. bruiser-v2";
  }
  updateEditorTabs();
  renderEditorPanels(draft);
}

function updateEditorTabs() {
  root.querySelectorAll("[data-editor-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.editorTab === activeEditorTab);
  });
  const sliderPanel = root.querySelector("#profile-slider-panel");
  const jsonPanel = root.querySelector("#profile-json-panel");
  if (sliderPanel) sliderPanel.hidden = activeEditorTab !== "sliders";
  if (jsonPanel) jsonPanel.hidden = activeEditorTab !== "json";
}

function renderEditorPanels(draft) {
  const sliderPanel = root.querySelector("#profile-slider-panel");
  renderSliderEditor(sliderPanel, draft.state, {
    remainingCeilingFor: (id) => remainingCeilingForState(draft.state, id),
    onChange: () => {
      draft.source = "user";
      updateEditorMeter(draft);
      updateJsonPreview(draft);
      updateSubmitButtonState(draft);
    },
  });
  updateEditorMeter(draft);
  updateJsonPreview(draft);
  const pendingButton = root.querySelector("#paste-pending");
  if (pendingButton && pendingBuildConfig) {
    pendingButton.textContent = draft.source === "pending" ? "tuned build loaded" : "load tuned build";
  }
}

function updateSubmitButtonState(draft) {
  const btn = root.querySelector("#submit-btn");
  if (!btn) return;
  const filled = isFilled(selectedSlot);
  const changes = dirtyCount(draft.baseState, draft.state);
  btn.textContent = `${filled ? "revise" : "install"}${changes > 0 ? ` · ${changes} changed` : ""}`;
  btn.classList.toggle("is-dirty", changes > 0);
}

function updateEditorMeter(draft) {
  const meter = root.querySelector("#profile-editor-meter");
  if (!meter) return;
  const spent = stateSpent(draft.state);
  const over = Math.max(0, spent - BUDGET);
  const source = draft.source === "pending" ? " · tuned build" : draft.source === "json" ? " · json import" : "";
  meter.innerHTML = `
    <span>spent ${spent} / ${BUDGET}</span>
    ${over > 0 ? `<span class="is-over">over by ${over}</span>` : `<span>${BUDGET - spent} left</span>`}
    ${source ? `<span>${source}</span>` : ""}
  `;
}

function updateJsonPreview(draft) {
  const preview = root.querySelector("#config-json-preview");
  if (!preview) return;
  try {
    preview.textContent = formatConfigJson(configFromState(draft.state));
  } catch (e) {
    preview.textContent = e.message;
  }
}

function relativeTime(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const secs = Math.max(0, (Date.now() - t) / 1000);
  if (secs < 60) return `${Math.round(secs)}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[c]));
}
