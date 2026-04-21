// About mode — product/technology overview plus player-facing mechanics.
// Keep sensitive implementation internals out of this surface; players need
// to understand the arena and the trust boundary, not the source.

import gameCopy from "../content/game-copy.v1.json" with { type: "json" };
import { getComputeClient } from "../lib/compute.js";

let computeWitnessOff = null;

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sectionHtml(section) {
  const body = Array.isArray(section.body) ? section.body : [];
  return `
    <article class="rules-card">
      <h2>${escapeHtml(section.title)}</h2>
      <ul>
        ${body.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}
      </ul>
    </article>`;
}

function aboutCardHtml(about) {
  const body = Array.isArray(about?.body) ? about.body : [];
  if (!body.length) return "";
  const firstSentence = body[0].split(/(?<=\.)\s+/)[0] ?? body[0];
  const rest = body[0].slice(firstSentence.length).trim();
  return `
    <section class="context-card rules-card-feature">
      <div class="context-card-kicker">${escapeHtml(about.title ?? "about")}</div>
      <div class="context-card-copy">
        <strong>${escapeHtml(firstSentence)}</strong>
        ${rest ? `<span>${escapeHtml(rest)}</span>` : ""}
      </div>
    </section>`;
}

function aboutDetailHtml(about) {
  const body = Array.isArray(about?.body) ? about.body.slice(1) : [];
  if (!body.length) return "";
  return `
    <section class="rules-about-copy" aria-label="About details">
      ${body.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
    </section>`;
}

function computeWitnessEnabled() {
  return window.__M3T4_FEATURES__?.computeSlackWorker === true ||
    window.__M3T4_COMPUTE_SLACK_WORKER__ === true;
}

function computeWitnessHtml() {
  if (!computeWitnessEnabled()) return "";
  return `
    <section class="panel compute-witness-panel" aria-label="Device Witness">
      <div class="compute-witness-title">
        <h3>Device Witness</h3>
        <span id="compute-witness-status" class="tight">off</span>
      </div>
      <div class="compute-witness-controls" role="group" aria-label="Device Witness mode">
        <button class="compute-witness-mode" data-mode="quiet">quiet</button>
        <button class="compute-witness-mode" data-mode="after-match">after-match</button>
        <button class="compute-witness-mode" data-mode="standard">standard</button>
      </div>
      <div class="compute-witness-actions">
        <button id="compute-witness-start" class="primary">start</button>
        <button id="compute-witness-stop">stop</button>
      </div>
    </section>`;
}

export function mount(root, { setStatus }) {
  setStatus("about");
  const rules = gameCopy.rules ?? {};
  const sections = Array.isArray(rules.sections) ? rules.sections : [];

  root.innerHTML = `
    <div class="page rules-page">
      <div class="page-header-row rules-hero">
        <div class="page-title-stack">
          <h1 class="page-title">${escapeHtml(rules.title ?? "Rules")}</h1>
          <div class="page-subtitle tight">${escapeHtml(rules.subtitle ?? "")}</div>
        </div>
        <a class="buttonish primary" href="#spectate">watch live</a>
      </div>

      ${aboutCardHtml(rules.about)}
      ${computeWitnessHtml()}

      <div class="rules-main-layout">
        ${aboutDetailHtml(rules.about)}
        <div class="rules-rules-column">
          <div class="rules-section-label">Rules</div>
          <section class="rules-grid">
            ${sections.map(sectionHtml).join("")}
          </section>
        </div>
      </div>
    </div>`;

  wireComputeWitness(root);
}

function wireComputeWitness(root) {
  if (!computeWitnessEnabled()) return;
  const panel = root.querySelector(".compute-witness-panel");
  if (!panel) return;
  computeWitnessOff?.();
  computeWitnessOff = null;
  const client = getComputeClient();
  const statusEl = panel.querySelector("#compute-witness-status");
  const startBtn = panel.querySelector("#compute-witness-start");
  const stopBtn = panel.querySelector("#compute-witness-stop");
  const modeButtons = Array.from(panel.querySelectorAll(".compute-witness-mode"));

  function paint(snapshot) {
    const gate = snapshot.gate ? ` · ${snapshot.gate}` : "";
    statusEl.textContent = snapshot.enabled ? `${snapshot.mode} · ${snapshot.state}${gate}` : "off";
    startBtn.disabled = !snapshot.available || !snapshot.configured || snapshot.enabled;
    stopBtn.disabled = !snapshot.enabled;
    modeButtons.forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.mode === snapshot.mode);
    });
  }

  modeButtons.forEach((btn) => {
    btn.addEventListener("click", () => client.setMode(btn.dataset.mode));
  });
  startBtn.addEventListener("click", () => {
    const active = modeButtons.find((btn) => btn.classList.contains("is-active"));
    void client.start({ mode: active?.dataset.mode ?? "quiet", persist: true });
  });
  stopBtn.addEventListener("click", () => {
    void client.stop({ persist: true });
  });

  computeWitnessOff = client.subscribe(paint);
}

export function unmount() {
  computeWitnessOff?.();
  computeWitnessOff = null;
}
