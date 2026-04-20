// Submit mode — auth + handle claim + slot management.

import { auth } from "../lib/auth.js";
import * as api from "../lib/api.js";

let root = null;
let setStatus = () => {};

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
  setStatus("submit · not signed in");
  const authError = auth.error?.();
  if (auth.mode === "firebase") return renderFirebaseSignIn(authError);

  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Submit <small>— sign in first</small></h1>
      </div>
      <div class="panel">
        <h3>Dev mode</h3>
        <p class="tight" style="margin-bottom:12px;">
          Local dev auth: pick any UID; the server accepts it as your identity.
          Firebase Google/GitHub auth ships with the prod build.
        </p>
        <div class="row">
          <input type="text" id="uid-input" placeholder="pick a uid (3-64 chars, a-z 0-9 _ -)" style="flex:1;">
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
    } catch (e) { err.textContent = e.message; }
  });
  root.querySelector("#uid-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") root.querySelector("#signin-btn").click();
  });
}

function renderFirebaseSignIn(authError) {
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Submit <small>— sign in first</small></h1>
      </div>
      <div class="panel">
        <h3>Sign in</h3>
        <p class="tight" style="margin-bottom:12px;">
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
    } catch (e) {
      err.textContent = e.message;
    }
  }

  root.querySelector("#signin-google").addEventListener("click", () => doSignIn("google"));
  root.querySelector("#signin-github").addEventListener("click", () => doSignIn("github"));
}

async function renderDashboard(user) {
  setStatus(`submit · ${user.uid}`);
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Submit <small>— @${user.handle ?? "unclaimed"} (${user.uid})</small></h1>
        <button id="signout">sign out</button>
      </div>
      ${!user.handle ? handleClaimHtml() : ""}
      <div class="panel">
        <h3>Your stable</h3>
        <div id="stable-view" class="tight">loading…</div>
      </div>
      <div class="panel">
        <h3>Submit a config</h3>
        <div class="tight" style="margin-bottom:8px;">
          Paste JSON from Build mode (or your offline toolkit). Rate-limited to
          1 submission per slot per 24 h. Server validates attributes and privacy.
        </div>
        <div class="row" style="margin-bottom:6px;">
          <label>slot:
            <select id="slot-idx">
              <option>0</option><option>1</option><option>2</option><option>3</option><option>4</option>
            </select>
          </label>
          <label>name: <input type="text" id="slot-name" placeholder="e.g. bruiser-v2"></label>
          <button id="paste-pending" class="tight">paste from Build</button>
          <button id="submit-btn" class="primary">submit</button>
        </div>
        <textarea id="config-json" rows="14" spellcheck="false" placeholder='{"id":"my-bot","attributes":{"burnRate":0.5,"moat":60,...}}'></textarea>
        <div id="submit-msg"></div>
      </div>
    </div>`;

  root.querySelector("#signout").addEventListener("click", () => auth.signOut());
  if (!user.handle) wireClaimHandle();
  wireSubmit(user);
  loadStable(user);
  // If there's a pending config from Build mode, offer to paste it
  const pending = sessionStorage.getItem("m3t4:pendingSubmit");
  if (pending) {
    root.querySelector("#paste-pending").addEventListener("click", () => {
      root.querySelector("#config-json").value = pending;
    });
    root.querySelector("#paste-pending").style.background = "#1e3a2c";
  } else {
    root.querySelector("#paste-pending").disabled = true;
  }
}

function handleClaimHtml() {
  return `
    <div class="panel">
      <h3>Claim a handle</h3>
      <div class="tight" style="margin-bottom:8px;">3-20 chars, lowercase + digits + underscore. Public.</div>
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
    } catch (e) { err.textContent = e.message; }
  });
}

function wireSubmit(user) {
  root.querySelector("#submit-btn").addEventListener("click", async () => {
    const msg = root.querySelector("#submit-msg");
    msg.className = "tight";
    msg.textContent = "";
    try {
      if (!user.handle) throw new Error("claim a handle first");
      const slotIdx = parseInt(root.querySelector("#slot-idx").value, 10);
      const nameInput = root.querySelector("#slot-name").value.trim();
      const text = root.querySelector("#config-json").value;
      const cfg = JSON.parse(text);
      const r = await api.submitSlot(await auth.token(), slotIdx, cfg, nameInput || undefined);
      msg.className = "ok";
      msg.textContent = `submitted · slotId=${r.slotId}`;
      sessionStorage.removeItem("m3t4:pendingSubmit");
      loadStable(user);
    } catch (e) {
      msg.className = "error";
      msg.textContent = e.message;
    }
  });
}

async function loadStable(user) {
  const el = root.querySelector("#stable-view");
  if (!el) return;
  try {
    const s = await api.getStable(user.uid);
    el.innerHTML = `
      <div>@${s.handle} · aggregate ELO ${s.eloAggregate} · ${s.wins}w ${s.losses}l</div>
      <table style="margin-top:8px; width:100%; border-collapse:collapse;">
        <thead style="color:#889;"><tr><td>slot</td><td>name</td><td>ELO</td><td>W-L-D</td><td>last played</td></tr></thead>
        ${s.slots.map((slot, i) => `
          <tr>
            <td class="rank">${i}</td>
            <td>${slot.name}</td>
            <td class="elo">${slot.elo}</td>
            <td class="wl">${slot.wins}-${slot.losses}-${slot.draws}</td>
            <td class="tight">${slot.lastPlayedAt ? new Date(slot.lastPlayedAt).toLocaleString() : "—"}</td>
          </tr>`).join("")}
      </table>`;
  } catch (e) {
    if (e.status === 404) el.textContent = "no slots yet — submit your first config below";
    else el.textContent = `error: ${e.message}`;
  }
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
