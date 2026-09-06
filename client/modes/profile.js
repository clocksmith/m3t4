// Profile mode — signed-in identity, stable roster, stats, and bot
// submission. Only the owner can see this view; the sign-in gate stays
// if there's no authenticated user.

import { auth } from "../lib/auth.js";
import * as api from "../lib/api.js";
import {
  BUDGET,
  configFromState,
  dirtyCount,
  neutralBuildState,
  normalizeBuildConfig,
  parseBuildConfigJson,
  remainingCeilingForState,
  stateFromConfig,
  stateSpent,
} from "../lib/build-config.js";
import { renderSliderEditor } from "../lib/slider-editor.js";
import { trackProfileSignIn, trackProfileHandleClaim, trackProfileSubmitConfig } from "../lib/analytics.js";
import { escapeHtml } from "../ui/html.js";
import { buttonHtml } from "../ui/actions.js";
import { contextCardHtml, workshopHeaderHtml } from "../ui/shell.js";
import gameCopy from "../content/game-copy.v1.json" with { type: "json" };
import rosterCatalog from "../content/roster-catalog.v1.json" with { type: "json" };
import { BODY_VARIANTS, BODY_PORTRAIT_SHEETS } from "../content/character-presentation.js";

let root = null;
let setStatus = () => {};

const DEFAULT_ROSTER_SIZE = 4;
const BODY_IDS = rosterCatalog.bodies;
const DEFAULT_SLOT_NAMES = [
  "wingus", "dingus", "hambone", "zapper", "bonk", "dialup", "floppy", "shareware",
  "lanparty", "hotseat", "modem", "megabyte", "joystick", "gamepad", "turbo", "pog",
  "slammer", "radmax", "dozer", "widget", "sprocket", "kludge", "glitch", "zipdrive",
  "winamp", "geocities", "tripod", "angelfire", "boombox", "vhs", "jolt", "neon",
];
let selectedSlot = 0;
let rosterSize = DEFAULT_ROSTER_SIZE;
let rosterCache = null; // last loaded stable response, or null
let editorStateBySeat = new Map();
let cosmeticsBySeat = new Map();
let nameBySeat = new Map();
let pendingBuildConfig = null;
let pendingAutoApplied = false;

function rosterIntroPanelHtml({ needsHandle = false } = {}) {
  const pending = sessionStorage.getItem("m3t4:pendingSubmit");
  const claimForm = needsHandle ? `
      <div class="roster-intro-claim">
        <div class="tight mb-xs">Claim a public handle first. 3-20 chars, lowercase + digits + underscore.</div>
        <div class="row">
          <input type="text" id="handle-input" placeholder="your_handle">
          ${buttonHtml({ id: "handle-claim", variant: "primary", text: "claim", attrs: { title: "Reserve this handle permanently" } })}
        </div>
        <div class="error" id="handle-err"></div>
      </div>` : "";
  return contextCardHtml({
    className: "roster-intro-panel",
    autoHeight: true,
    body: `
      <div class="context-card-kicker">ranked roster</div>
      <div class="roster-intro-copy">
        <strong>${pending ? "Your tuned fighter is ready to save." : "Keep your fighters. Refine your rivalry."}</strong>
        <span>Save up to four fighters here. Ranked scheduling is server-controlled; archive playback does not enter them in new matches.</span>
      </div>
      ${claimForm}`,
  });
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
  return workshopHeaderHtml({ active: "roster", subtitle, action });
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
          ${buttonHtml({ id: "signin-btn", variant: "primary", text: "sign in", attrs: { title: "Sign in to save your roster and track ranked progress" } })}
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
          ${buttonHtml({ id: "signin-google", variant: "primary", text: "sign in with Google", attrs: { title: "Sign in with your Google account" } })}
          ${buttonHtml({ id: "signin-github", text: "sign in with GitHub", attrs: { title: "Sign in with your GitHub account" } })}
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
  cosmeticsBySeat = new Map();
  nameBySeat = new Map();
  pendingBuildConfig = readPendingBuildConfig();
  pendingAutoApplied = false;
  root.innerHTML = `
    <div class="page">
      ${rosterPageHeaderHtml({
        subtitle: `@${user.handle ?? "unclaimed"} · ${user.uid}`,
        action: buttonHtml({ id: "signout", text: "sign out", attrs: { title: "End your current session" } }),
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
            <label>body <select id="slot-body"></select></label>
            <div class="weapon-field">
              <div class="field-label">weapon</div>
              <div class="weapon-list" id="slot-weapon-list" role="listbox" aria-label="weapon"></div>
            </div>
            <div class="weapon-unlock-hint" id="weapon-unlock-hint"></div>
            <div class="profile-submit-actions">
              ${buttonHtml({ id: "reroll-name", className: "tight", text: "reroll name", attrs: { title: "Generate a new random handle suggestion" } })}
              ${buttonHtml({ id: "reset-editor", className: "tight", text: "reset", attrs: { title: "Discard edits and return to the current saved build" } })}
              ${buttonHtml({ id: "paste-pending", className: "tight", text: "load tuned build", attrs: { title: "Import the most recently tuned build into this seat" } })}
              ${buttonHtml({ id: "submit-btn", variant: "primary", text: "install", attrs: { title: "Save this build into the selected roster seat" } })}
            </div>
          </div>
          <div class="profile-editor-meter" id="profile-editor-meter"></div>
          <div id="profile-slider-panel" class="profile-slider-panel"></div>
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

function useFirebaseRoster() {
  return auth.mode === "firebase" && Boolean(window.__M3T4_FIREBASE_CONFIG__ ?? window.__M3T4_FIREBASE__);
}

function firebaseSubmitApi() {
  return import("../lib/submit.js");
}

function wireClaimHandle() {
  root.querySelector("#handle-claim").addEventListener("click", async () => {
    const input = root.querySelector("#handle-input");
    const err = root.querySelector("#handle-err");
    err.textContent = "";
    try {
      const r = useFirebaseRoster()
        ? await (await firebaseSubmitApi()).claimHandle(input.value.trim())
        : await api.claimHandle(await auth.token(), input.value.trim());
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
      const nameInput = nameForSeat(selectedSlot).trim();
      const draft = draftForSeat(selectedSlot);
      const cfg = normalizeBuildConfig(configFromState(draft.state));
      const cosmetics = selectedCosmeticsForSeat(selectedSlot);
      assertClientUniqueBody(selectedSlot, cosmetics);
      const r = useFirebaseRoster()
        ? await (await firebaseSubmitApi()).submitStable({
          handle: rosterCache?.handle ?? user.handle,
          slotIdx: selectedSlot,
          config: cfg,
          name: nonGenericNameOrEmpty(nameInput) || undefined,
          cosmetics,
        })
        : await api.submitSlot(
          await auth.token(),
          selectedSlot,
          cfg,
          nonGenericNameOrEmpty(nameInput) || undefined,
          cosmetics,
        );
      msg.className = "ok";
      msg.textContent = `seat ${seatNumber(selectedSlot)} ${wasFilled ? "revised" : "installed"} · slotId=${r.slotId}`;
      sessionStorage.removeItem("m3t4:pendingSubmit");
      pendingBuildConfig = null;
      editorStateBySeat.delete(selectedSlot);
      cosmeticsBySeat.delete(selectedSlot);
      nameBySeat.delete(selectedSlot);
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
      msg.textContent = friendlySubmitError(e, selectedSlot);
      if (/rate limited/i.test(e.message ?? "")) loadStable(user);
      trackProfileSubmitConfig(false);
    }
  });
}

function isFilled(slotIdx) {
  const slot = rosterSlotAt(rosterCache, slotIdx);
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
  const slot = rosterSlotAt(rosterCache, slotIdx);
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
  root.querySelector("#slot-name").addEventListener("input", (e) => {
    nameBySeat.set(selectedSlot, e.target.value);
  });
  root.querySelector("#reroll-name").addEventListener("click", () => {
    nameBySeat.set(selectedSlot, randomDefaultName());
    updateEditor();
  });
  root.querySelector("#reset-editor").addEventListener("click", () => {
    editorStateBySeat.delete(selectedSlot);
    updateEditor();
  });
}

async function loadStable(user) {
  const subtitle = root.querySelector("#roster-subtitle");
  const grid = root.querySelector("#roster-grid");
  if (!grid) return;
  try {
    let s = null;
    if (useFirebaseRoster()) {
      s = await (await firebaseSubmitApi()).getMyStableOnce();
      rosterSize = DEFAULT_ROSTER_SIZE;
    } else {
      const token = await auth.token();
      const [status, stable] = await Promise.all([
        api.status().catch(() => null),
        api.getMyStable(token).catch((e) => {
          if (e.status === 404) return null;
          throw e;
        }),
      ]);
      s = stable;
      rosterSize = normalizeRosterSize(status?.maxSlots);
    }
    if (selectedSlot >= rosterSize) selectedSlot = Math.max(0, rosterSize - 1);
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
  const slots = Array.from({ length: rosterSize }, (_, i) => rosterSlotAt(stable, i));
  grid.innerHTML = slots.map((slot, i) => {
    const filled = !!(slot && slot.slotId);
    const cooldownMs = cooldownMsForSlot(slot);
    const locked = cooldownMs > 0;
    const cosmetics = cosmeticForSlot(slot, i);
    const active = i === selectedSlot ? "is-active" : "";
    const state = filled ? "is-filled" : "is-empty";
    const lockedClass = locked ? "is-locked" : "";
    const name = filled ? escapeHtml(slot.name ?? "unnamed") : "vacant seat";
    const elo = filled ? `<div class="seat-elo">${slot.elo}</div>` : "";
    const wl = filled ? `<div class="seat-wl">${slot.wins}-${slot.losses}-${slot.draws}</div>` : "";
    const body = bodyLabel(cosmetics.body);
    const weapon = weaponLabel(cosmetics.body, cosmetics.weapon);
    const portrait = bodyPortraitHtml(cosmetics.body, filled);
    const last = locked
      ? `<div class="seat-last is-cooldown">revise in ${cooldownLabel(cooldownMs)}</div>`
      : filled && slot.lastPlayedAt
      ? `<div class="seat-last">${relativeTime(slot.lastPlayedAt)}</div>`
      : filled
      ? `<div class="seat-last">unplayed</div>`
      : `<div class="seat-last">vacant</div>`;
    const seatTitle = locked
      ? `Seat ${seatNumber(i)} · ${slot.name ?? "unnamed"} · ${body} · ${weapon} · ${slot.elo} ELO · revise in ${cooldownLabel(cooldownMs)}`
      : filled
      ? `Seat ${seatNumber(i)} · ${slot.name ?? "unnamed"} · ${body} · ${weapon} · ${slot.elo} ELO`
      : `Seat ${seatNumber(i)} · vacant`;
    return `
      <button type="button" class="seat-card ${state} ${active} ${lockedClass}" data-slot="${i}" title="${escapeHtml(seatTitle)}">
        <div class="seat-head">
          <span class="seat-label">SEAT ${seatNumber(i)}</span>
          <span class="seat-state-dot"></span>
        </div>
        <div class="seat-main">
          ${portrait}
          <div class="seat-copy">
            <div class="seat-name">${name}</div>
            <div class="seat-cosmetics">${escapeHtml(body)} · ${escapeHtml(weapon)}</div>
            ${elo}${wl}
            ${last}
          </div>
        </div>
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
  const slots = Array.from({ length: rosterSize }, (_, i) => rosterSlotAt(stable, i))
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
  const slot = rosterSlotAt(rosterCache, selectedSlot);
  const filled = !!(slot && slot.slotId);
  const draft = draftForSeat(selectedSlot);
  const cosmetics = selectedCosmeticsForSeat(selectedSlot);
  const changes = dirtyCount(draft.baseState, draft.state);
  const cooldownMs = cooldownMsForSlot(slot);
  title.textContent = filled ? `Revise seat ${seatNumber(selectedSlot)}` : `Install seat ${seatNumber(selectedSlot)}`;
  if (nameInput) {
    nameInput.value = nameForSeat(selectedSlot);
    nameInput.placeholder = "random if blank";
  }
  if (note) {
    note.textContent = cooldownMs > 0
      ? `${slot.elo} ELO · ${slot.wins}-${slot.losses}-${slot.draws} · revise in ${cooldownLabel(cooldownMs)}`
      : filled
      ? `${slot.elo} ELO · ${slot.wins}-${slot.losses}-${slot.draws} · ${slot.lastPlayedAt ? relativeTime(slot.lastPlayedAt) : "unplayed"}`
      : "vacant";
  }
  btn.disabled = cooldownMs > 0;
  btn.textContent = cooldownMs > 0
    ? `revise in ${cooldownLabel(cooldownMs)}`
    : `${filled ? "revise" : "install"}${changes > 0 ? ` · ${changes} changed` : ""}`;
  btn.title = btn.textContent;
  btn.classList.toggle("is-dirty", changes > 0);
  renderCosmeticsControls(cosmetics);
  renderEditorPanels(draft);
}

function renderCosmeticsControls(cosmetics) {
  const bodySelect = root.querySelector("#slot-body");
  const weaponList = root.querySelector("#slot-weapon-list");
  if (!bodySelect || !weaponList) return;
  const used = usedBodiesByOtherSeats(selectedSlot);
  bodySelect.innerHTML = BODY_IDS.map((body) => {
    const disabled = used.has(body) ? " disabled" : "";
    const selected = body === cosmetics.body ? " selected" : "";
    return `<option value="${body}"${selected}${disabled}>${escapeHtml(bodyLabel(body))}</option>`;
  }).join("");
  const weaponOptions = weaponOptionsForSeat(cosmetics.body, selectedSlot);
  weaponList.innerHTML = weaponOptions.map((option) => {
    const selected = option.id === cosmetics.weapon;
    const label = weaponLabel(cosmetics.body, option.id);
    const meta = option.locked ? `unlocks at ${option.minElo} ELO` : "available";
    const title = `${label} · ${meta}`;
    return `
      <button
        type="button"
        class="weapon-option${selected ? " is-selected" : ""}${option.locked ? " is-locked" : ""}"
        data-weapon="${escapeHtml(option.id)}"
        role="option"
        aria-selected="${selected ? "true" : "false"}"
        title="${escapeHtml(title)}"
        ${option.locked ? `aria-disabled="true" disabled` : ""}
      >
        ${weaponOptionVisualHtml(cosmetics.body, option)}
        <span class="weapon-option-copy">
          <span class="weapon-option-name">${escapeHtml(label)}</span>
          <span class="weapon-option-meta">${escapeHtml(meta)}</span>
        </span>
      </button>`;
  }).join("");
  const hint = root.querySelector("#weapon-unlock-hint");
  if (hint) hint.textContent = weaponUnlockHint(cosmetics.body, selectedSlot);
  bodySelect.onchange = () => {
    const body = BODY_IDS.includes(bodySelect.value) ? bodySelect.value : defaultCosmetics(selectedSlot).body;
    const weapon = availableWeaponIdsForSeat(body, selectedSlot)[0];
    cosmeticsBySeat.set(selectedSlot, { body, weapon });
    updateEditor();
  };
  weaponList.onclick = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest(".weapon-option");
    if (!button || button.disabled) return;
    const current = selectedCosmeticsForSeat(selectedSlot);
    const weapons = availableWeaponIdsForSeat(current.body, selectedSlot);
    const weapon = weapons.includes(button.dataset.weapon) ? button.dataset.weapon : weapons[0];
    cosmeticsBySeat.set(selectedSlot, { ...current, weapon });
    updateEditor();
  };
}

function renderEditorPanels(draft) {
  const sliderPanel = root.querySelector("#profile-slider-panel");
  renderSliderEditor(sliderPanel, draft.state, {
    remainingCeilingFor: (id) => remainingCeilingForState(draft.state, id),
    onChange: () => {
      draft.source = "user";
      updateEditorMeter(draft);
      updateSubmitButtonState(draft);
    },
  });
  updateEditorMeter(draft);
  const pendingButton = root.querySelector("#paste-pending");
  if (pendingButton && pendingBuildConfig) {
    pendingButton.textContent = draft.source === "pending" ? "tuned build loaded" : "load tuned build";
    pendingButton.title = pendingButton.textContent;
  }
}

function updateSubmitButtonState(draft) {
  const btn = root.querySelector("#submit-btn");
  if (!btn) return;
  const filled = isFilled(selectedSlot);
  const changes = dirtyCount(draft.baseState, draft.state);
  const cooldownMs = cooldownMsForSlot(rosterSlotAt(rosterCache, selectedSlot));
  btn.disabled = cooldownMs > 0;
  btn.textContent = cooldownMs > 0
    ? `revise in ${cooldownLabel(cooldownMs)}`
    : `${filled ? "revise" : "install"}${changes > 0 ? ` · ${changes} changed` : ""}`;
  btn.title = btn.textContent;
  btn.classList.toggle("is-dirty", changes > 0);
}

function updateEditorMeter(draft) {
  const meter = root.querySelector("#profile-editor-meter");
  if (!meter) return;
  const spent = stateSpent(draft.state);
  const over = Math.max(0, spent - BUDGET);
  const source = draft.source === "pending" ? " · tuned build" : "";
  meter.innerHTML = `
    <span>spent ${spent} / ${BUDGET}</span>
    ${over > 0 ? `<span class="is-over">over by ${over}</span>` : `<span>${BUDGET - spent} left</span>`}
    ${source ? `<span>${source}</span>` : ""}
  `;
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

function normalizeRosterSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_ROSTER_SIZE;
  return Math.max(1, Math.min(8, Math.trunc(n)));
}

function rosterSlotAt(stable, slotIdx) {
  const direct = stable?.slots?.[slotIdx];
  if (direct?.slotId) return direct;
  return stable?.slots?.find?.((slot) => slot?.slotId && Number(slot.slotIdx) === slotIdx) ?? null;
}

function cooldownMsForSlot(slot) {
  const until = Number(slot?.rateLockedUntil ?? 0);
  return Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0;
}

function cooldownLabel(ms) {
  const secs = Math.ceil(Math.max(0, ms) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.ceil(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.ceil(mins / 60)}h`;
}

function seatNumber(slotIdx) {
  return slotIdx + 1;
}

function friendlySubmitError(error, slotIdx) {
  const message = error?.message ?? String(error);
  const retryMs = Number(error?.body?.retryAfterMs ?? 0);
  const retry = Number.isFinite(retryMs) && retryMs > 0 ? ` (${cooldownLabel(retryMs)})` : "";
  if (/rate limited/i.test(message)) {
    return `seat ${seatNumber(slotIdx)} is saved; edits unlock after the cooldown${retry}`;
  }
  if (/please wait/i.test(message) || error?.code === "resource-exhausted") {
    return `seat ${seatNumber(slotIdx)} is saved; edits unlock after the cooldown${retry}`;
  }
  return message;
}

function nameForSeat(slotIdx) {
  if (nameBySeat.has(slotIdx)) return nameBySeat.get(slotIdx) ?? "";
  const slot = rosterSlotAt(rosterCache, slotIdx);
  const name = nonGenericNameOrEmpty(slot?.name) || randomDefaultName(slotIdx);
  nameBySeat.set(slotIdx, name);
  return name;
}

function nonGenericNameOrEmpty(value) {
  const clean = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!clean || /^(slot|seat)[\s_-]*\d+$/i.test(clean)) return "";
  return clean;
}

function randomDefaultName(seed = Math.floor(Math.random() * DEFAULT_SLOT_NAMES.length)) {
  const offset = Math.floor(Math.random() * DEFAULT_SLOT_NAMES.length);
  return DEFAULT_SLOT_NAMES[(seed + offset) % DEFAULT_SLOT_NAMES.length];
}

function selectedCosmeticsForSeat(slotIdx) {
  const existing = cosmeticsBySeat.get(slotIdx);
  if (existing) return normalizeCosmetics(existing, slotIdx);
  const slot = rosterSlotAt(rosterCache, slotIdx);
  const normalized = cosmeticForSlot(slot, slotIdx);
  cosmeticsBySeat.set(slotIdx, normalized);
  return normalized;
}

function cosmeticForSlot(slot, slotIdx) {
  return normalizeCosmetics(slot?.cosmetics, slotIdx);
}

function normalizeCosmetics(value, slotIdx) {
  const fallback = defaultCosmetics(slotIdx);
  const body = BODY_IDS.includes(value?.body) ? value.body : fallback.body;
  const weapons = availableWeaponIdsForSeat(body, slotIdx);
  const weapon = weapons.includes(value?.weapon) ? value.weapon : weapons[0];
  return { body, weapon };
}

function defaultCosmetics(slotIdx) {
  const body = BODY_IDS[((slotIdx % BODY_IDS.length) + BODY_IDS.length) % BODY_IDS.length];
  return { body, weapon: availableWeaponIdsForSeat(body, slotIdx)[0] };
}

function usedBodiesByOtherSeats(slotIdx) {
  const used = new Set();
  for (let i = 0; i < rosterSize; i++) {
    if (i === slotIdx) continue;
    const slot = rosterSlotAt(rosterCache, i);
    if (!slot?.slotId) continue;
    used.add(cosmeticForSlot(slot, i).body);
  }
  return used;
}

function assertClientUniqueBody(slotIdx, cosmetics) {
  const used = usedBodiesByOtherSeats(slotIdx);
  if (used.has(cosmetics.body)) {
    throw new Error(`${bodyLabel(cosmetics.body)} is already assigned to another seat`);
  }
}

function weaponEntriesForBody(body) {
  return rosterCatalog.weapons?.[body] ?? [];
}

function unlockEloForSeat(slotIdx) {
  const slot = rosterSlotAt(rosterCache, slotIdx);
  const peak = Number(slot?.peakElo);
  const elo = Number(slot?.elo);
  return Math.max(
    Number.isFinite(peak) ? peak : 1000,
    Number.isFinite(elo) ? elo : 1000,
    1000,
  );
}

function availableWeaponIdsForSeat(body, slotIdx) {
  const ids = weaponOptionsForSeat(body, slotIdx)
    .filter((weapon) => !weapon.locked)
    .map((weapon) => weapon.id);
  return ids.length ? ids : weaponEntriesForBody(body).filter((weapon) => weapon.available).slice(0, 1).map((weapon) => weapon.id);
}

function weaponOptionsForSeat(body, slotIdx) {
  const unlockElo = unlockEloForSeat(slotIdx);
  return weaponEntriesForBody(body)
    .filter((weapon) => weapon.available)
    .map((weapon) => {
      const minElo = Number(weapon.minElo ?? 0);
      return {
        id: weapon.id,
        asset: weapon.asset ?? null,
        minElo,
        locked: unlockElo < minElo,
      };
    });
}

function weaponUnlockHint(body, slotIdx) {
  const unlockElo = unlockEloForSeat(slotIdx);
  const next = weaponEntriesForBody(body)
    .filter((weapon) => weapon.available && Number(weapon.minElo ?? 0) > unlockElo)
    .sort((a, b) => Number(a.minElo ?? 0) - Number(b.minElo ?? 0))[0];
  return next
    ? `next weapon unlocks at ${Number(next.minElo)} ELO`
    : "all weapons unlocked";
}

function bodyLabel(body) {
  const variant = BODY_VARIANTS[body];
  return gameCopy.characters?.[body]?.[variant]?.name ?? body;
}

function weaponLabel(body, weapon) {
  return gameCopy.weapons?.[body]?.[weapon]?.name ?? weapon;
}

function weaponOptionVisualHtml(body, option) {
  const spriteStyle = weaponSpriteStyle(body, option.asset);
  const statusMarkup = option.locked
    ? `<img class="weapon-lock-glyph" src="assets/ui/locked_slot.png" alt="" width="16" height="16">`
    : `<span class="weapon-unlocked-dot" aria-hidden="true"></span>`;
  return `
    <span class="weapon-option-visual" aria-hidden="true">
      <span class="weapon-option-sprite${spriteStyle ? "" : " is-missing"}${option.locked ? " is-locked" : ""}"${spriteStyle ? ` style="${spriteStyle}"` : ""}></span>
      <span class="weapon-option-status">${statusMarkup}</span>
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
    .filter((weapon) => weapon.available && weapon.asset?.url === asset.url)
    .reduce((max, weapon) => Math.max(max, Number(weapon.asset?.cell ?? 0) || 0), Number(asset.cell ?? 0) || 0);
  return Math.max(1, Math.floor(maxCell / cols) + 1);
}

function bodyPortraitHtml(body, filled) {
  const url = BODY_PORTRAIT_SHEETS[body];
  const style = url ? ` style="background-image:url('${escapeHtml(url)}')"` : "";
  return `<div class="seat-portrait${filled ? "" : " is-empty"}"${style} aria-hidden="true"></div>`;
}
