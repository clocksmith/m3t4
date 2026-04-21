// Profile mode — signed-in identity, stable roster, stats, and bot
// submission. Only the owner can see this view; the sign-in gate stays
// if there's no authenticated user.

import { auth } from "../lib/auth.js";
import * as api from "../lib/api.js";
import { validateUserSubmission } from "../sim/index.js";
import { trackProfileSignIn, trackProfileHandleClaim, trackProfileSubmitConfig } from "../lib/analytics.js";

let root = null;
let setStatus = () => {};

const ROSTER_SIZE = 5;
let selectedSlot = 0;
let rosterCache = null; // last loaded stable response, or null

const SAMPLE_CONFIG = {
  attributes: {
    burnRate: 0.4,
    moat: 60,
    shipRate: 0.5,
    foresight: 0.025,
    pivotSpeed: 0.35,
    leverage: -0.4,
    networking: 0.2,
    spite: -0.4,
    greed: 0.25,
    pacing: 0.15,
    cunning: 0.15,
    lift: 0.2,
    parry: 0.1,
    chase: 0.15,
    discipline: 0.15,
    hallucination: 0,
  },
};
const SAMPLE_CONFIG_JSON = JSON.stringify(SAMPLE_CONFIG, null, 2);

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

function renderSignIn() {
  setStatus("profile · not signed in");
  const authError = auth.error?.();
  if (auth.mode === "firebase") return renderFirebaseSignIn(authError);
  const isAlpha = auth.mode === "alpha-token";

  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Profile <small>— sign in to see your boardroom roster</small></h1>
      </div>
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
      <div class="page-header">
        <h1>Profile <small>— sign in to see your boardroom roster</small></h1>
      </div>
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
  setStatus(`profile · ${user.uid}`);
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Profile <small>— @${user.handle ?? "unclaimed"} (${user.uid}) — only you can see this</small></h1>
        <button id="signout">sign out</button>
      </div>
      ${!user.handle ? handleClaimHtml() : ""}
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
              <button id="paste-pending" class="tight">paste from Build</button>
              <button id="submit-btn" class="primary">install</button>
            </div>
          </div>
          <textarea id="config-json" class="config-json-textarea" rows="18" spellcheck="false" placeholder="${escapeHtml(SAMPLE_CONFIG_JSON)}"></textarea>
          <div id="submit-msg"></div>
        </div>
      </div>
    </div>`;

  root.querySelector("#signout").addEventListener("click", () => auth.signOut());
  if (!user.handle) wireClaimHandle();
  wireSubmit(user);
  loadStable(user);
  wirePendingBuildConfig();
}

function handleClaimHtml() {
  return `
    <div class="panel">
      <h3>Claim a handle</h3>
      <div class="tight mb-sm">3-20 chars, lowercase + digits + underscore. Public.</div>
      <div class="row">
        <input type="text" id="handle-input" placeholder="your_handle">
        <button id="handle-claim" class="primary">claim</button>
      </div>
      <div class="error" id="handle-err"></div>
    </div>`;
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
    try {
      if (!user.handle) throw new Error("claim a handle first");
      const nameInput = root.querySelector("#slot-name").value.trim();
      const text = root.querySelector("#config-json").value;
      const cfg = normalizeProfileConfig(parseConfigJson(text));
      const validation = validateUserSubmission(cfg);
      if (!validation.ok || !validation.config) {
        throw new Error(`invalid config: ${validation.errors.join("; ")}`);
      }
      const r = await api.submitSlot(await auth.token(), selectedSlot, validation.config, nameInput || undefined);
      msg.className = "ok";
      msg.textContent = `seat ${selectedSlot} ${isFilled(selectedSlot) ? "revised" : "installed"} · slotId=${r.slotId}`;
      sessionStorage.removeItem("m3t4:pendingSubmit");
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
  const textarea = root.querySelector("#config-json");
  const pending = sessionStorage.getItem("m3t4:pendingSubmit");
  if (!pending) {
    btn.disabled = true;
    return;
  }

  function applyPending() {
    textarea.value = formatJsonForTextarea(pending);
  }

  applyPending();
  btn.textContent = "loaded from Build";
  btn.classList.add("is-ready");
  btn.addEventListener("click", applyPending);
}

function sanitizeConfigPaste(text) {
  return text
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, "\"")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r/g, "")
    // Terminal / markdown paste wraps can break tokens across lines as
    // `"paci\n    ng"`. Collapse newline+indent to nothing so wrapped
    // keys/values rejoin. Valid pretty-printed JSON survives because
    // JSON.parse accepts any amount of whitespace (including none)
    // between tokens.
    .replace(/\n[ \t]*/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function parseConfigJson(text) {
  const trimmed = sanitizeConfigPaste(text).trim();
  if (!trimmed) {
    throw new Error("config JSON is empty — use Build → send to profile, or paste a complete JSON object");
  }
  if (trimmed.includes("...")) {
    throw new Error("config JSON still contains a placeholder (...); paste the complete object");
  }
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`config JSON is invalid: ${(e instanceof Error ? e.message : String(e))}`);
  }
}

function normalizeProfileConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config JSON must be an object with an attributes object");
  }
  const cfg = { ...raw };
  if (!cfg.attributes && looksLikeAttributeMap(cfg)) {
    return { attributes: cfg };
  }
  if (!cfg.attributes || typeof cfg.attributes !== "object" || Array.isArray(cfg.attributes)) {
    throw new Error("config JSON must include an attributes object");
  }
  if (typeof cfg.id !== "string" || !cfg.id.trim()) {
    delete cfg.id;
  }
  return cfg;
}

function looksLikeAttributeMap(obj) {
  return obj && typeof obj === "object" && (
    "burnRate" in obj ||
    "moat" in obj ||
    "shipRate" in obj ||
    "hallucination" in obj
  );
}

function formatJsonForTextarea(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

async function loadStable(user) {
  const subtitle = root.querySelector("#roster-subtitle");
  const grid = root.querySelector("#roster-grid");
  if (!grid) return;
  try {
    const s = await api.getStable(user.uid).catch((e) => {
      if (e.status === 404) return null;
      throw e;
    });
    rosterCache = s;
    if (subtitle) {
      subtitle.textContent = s
        ? `@${s.handle} · aggregate ELO ${s.eloAggregate} · ${s.wins}w ${s.losses}l`
        : "vacant boardroom";
    }
    renderRosterGrid(grid, s);
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

function updateEditor() {
  const title = root.querySelector("#editor-title");
  const note = root.querySelector("#editor-note");
  const btn = root.querySelector("#submit-btn");
  const nameInput = root.querySelector("#slot-name");
  if (!title || !btn) return;
  const slot = rosterCache?.slots?.[selectedSlot];
  const filled = !!(slot && slot.slotId);
  title.textContent = filled ? `Revise seat ${selectedSlot}` : `Install seat ${selectedSlot}`;
  if (note) {
    note.textContent = filled
      ? `${slot.elo} ELO · ${slot.wins}-${slot.losses}-${slot.draws} · ${slot.lastPlayedAt ? relativeTime(slot.lastPlayedAt) : "unplayed"}`
      : "vacant";
  }
  btn.textContent = filled ? "revise" : "install";
  if (filled && nameInput && !nameInput.value.trim()) {
    nameInput.placeholder = slot.name ? `current: ${slot.name}` : "e.g. bruiser-v2";
  } else if (nameInput) {
    nameInput.placeholder = "e.g. bruiser-v2";
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
