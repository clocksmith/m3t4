import { getComputeClient } from "../lib/compute.js";
import { buttonHtml, linkButtonHtml } from "../ui/actions.js";
import { contextCardHtml, pageHeaderHtml } from "../ui/shell.js";
import { escapeHtml } from "../ui/html.js";

let off = null;
let refreshTimer = null;

function computeLabOrigin() {
  return String(window.__M3T4_COMPUTE_LAB_ORIGIN__ || "").replace(/\/+$/, "");
}

function supportedKernelNames() {
  const names = [];
  if (window.__M3T4_COMPUTE_LOGIT_DIVERGENCE__ === true) names.push("Cross-hardware logit divergence");
  if (window.__M3T4_COMPUTE_GENOME_KMER__ === true) names.push("Genome k-mer histograms");
  if (window.__M3T4_COMPUTE_WEBRTC_ARTIFACTS__ === true) names.push("Strict WebRTC transport");
  return names;
}

function introCardHtml() {
  const names = supportedKernelNames();
  const tail = names.length ? ` Currently exposed here: ${names.join(", ")}.` : "";
  return contextCardHtml({
    className: "compute-intro-card",
    kicker: "opt-in browser compute",
    strong: "This browser can donate idle cycles to public, receipt-backed workloads.",
    copy: `Workers run off-thread, sign receipts, and can help verify or execute bounded public tasks.${tail}`,
  });
}

function controlsPanelHtml() {
  return `
    <section class="panel compute-opt-panel" aria-label="Compute controls">
      <div class="compute-opt-head">
        <div class="compute-opt-title">
          <h3>Compute Worker</h3>
          <div id="compute-opt-status" class="tight">loading</div>
        </div>
        <div class="compute-opt-actions">
          ${buttonHtml({ id: "compute-opt-in", variant: "primary", text: "opt in" })}
          ${buttonHtml({ id: "compute-opt-out", text: "stop" })}
        </div>
      </div>
      <div class="compute-mode-block">
        <div class="compute-block-label">Mode</div>
        <div class="compute-mode-row" role="group" aria-label="Compute mode">
          ${buttonHtml({ className: "compute-mode-button", attrs: { "data-mode": "quiet" }, text: "quiet" })}
          ${buttonHtml({ className: "compute-mode-button", attrs: { "data-mode": "standard" }, text: "standard" })}
          ${buttonHtml({ className: "compute-mode-button", attrs: { "data-mode": "after-match" }, text: "after-match" })}
        </div>
      </div>
      <div class="compute-mode-block">
        <div class="compute-block-label">Pause policy</div>
        <div class="compute-policy-grid">
          <label class="compute-policy-item">
            <input type="checkbox" id="compute-policy-hidden">
            <span>Pause when tab is hidden</span>
          </label>
          <label class="compute-policy-item">
            <input type="checkbox" id="compute-policy-battery">
            <span>Pause on battery</span>
          </label>
          <label class="compute-policy-item">
            <input type="checkbox" id="compute-policy-render">
            <span>Pause during render stress</span>
          </label>
        </div>
      </div>
      <div class="compute-local-grid">
        <div><span>gate</span><strong id="compute-local-gate">—</strong></div>
        <div><span>worker</span><strong id="compute-local-worker">—</strong></div>
        <div><span>mode</span><strong id="compute-local-mode">—</strong></div>
        <div><span>accepted</span><strong id="compute-local-accepted">0</strong></div>
        <div><span>pending</span><strong id="compute-local-pending">0</strong></div>
        <div><span>rejected</span><strong id="compute-local-rejected">0</strong></div>
      </div>
      <div id="compute-opt-note" class="tight compute-opt-note"></div>
    </section>`;
}

function publicStatsPanelHtml() {
  return `
    <section class="panel compute-public-panel" aria-label="Public compute network">
      <div class="compute-public-head">
        <div>
          <h3>Network</h3>
          <div id="compute-public-note" class="tight">loading</div>
        </div>
        ${linkButtonHtml({ href: "#spectate", text: "watch live" })}
      </div>
      <div class="compute-public-grid">
        <div><span>compute score</span><strong id="compute-public-score">0</strong></div>
        <div><span>accepted receipts</span><strong id="compute-public-receipts">0</strong></div>
        <div><span>active workers</span><strong id="compute-public-workers">0</strong></div>
        <div><span>median kernel ms</span><strong id="compute-public-median">0</strong></div>
        <div><span>WebGPU correctness</span><strong id="compute-public-webgpu">0%</strong></div>
        <div><span>direct WebRTC</span><strong id="compute-public-webrtc">0%</strong></div>
      </div>
    </section>`;
}

function workloadsPanelHtml() {
  return `
    <section class="panel compute-workloads-panel" aria-label="Public workloads">
      <div class="compute-workloads-head">
        <h3>Public Workloads</h3>
        <div id="compute-workloads-note" class="tight">loading</div>
      </div>
      <div id="compute-workloads-list" class="compute-workloads-list"></div>
    </section>`;
}

export function mount(root, { setStatus }) {
  setStatus("compute");
  root.innerHTML = `
    <div class="page compute-page">
      ${pageHeaderHtml({
        title: "Compute",
        subtitle: "Opt in a browser worker for receipt-backed public workloads",
        action: linkButtonHtml({ href: "#about", text: "about" }),
      })}
      ${introCardHtml()}
      ${controlsPanelHtml()}
      ${publicStatsPanelHtml()}
      ${workloadsPanelHtml()}
    </div>`;
  wireControls(root);
  wirePublicData(root);
}

function wireControls(root) {
  const client = getComputeClient();
  void client.maybeAutoStart();
  const statusEl = must(root, "#compute-opt-status");
  const noteEl = must(root, "#compute-opt-note");
  const gateEl = must(root, "#compute-local-gate");
  const workerEl = must(root, "#compute-local-worker");
  const modeEl = must(root, "#compute-local-mode");
  const acceptedEl = must(root, "#compute-local-accepted");
  const pendingEl = must(root, "#compute-local-pending");
  const rejectedEl = must(root, "#compute-local-rejected");
  const optInBtn = must(root, "#compute-opt-in");
  const optOutBtn = must(root, "#compute-opt-out");
  const hiddenBox = must(root, "#compute-policy-hidden");
  const batteryBox = must(root, "#compute-policy-battery");
  const renderBox = must(root, "#compute-policy-render");
  const modeButtons = Array.from(root.querySelectorAll(".compute-mode-button"));

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      client.setMode(button.dataset.mode);
    });
  });
  optInBtn.addEventListener("click", () => {
    const active = modeButtons.find((button) => button.classList.contains("is-active"));
    void client.start({ mode: active?.dataset.mode ?? "quiet", persist: true });
  });
  optOutBtn.addEventListener("click", () => {
    void client.stop({ persist: true });
  });
  hiddenBox.addEventListener("change", () => client.setPolicy({ pauseWhenHidden: hiddenBox.checked }));
  batteryBox.addEventListener("change", () => client.setPolicy({ pauseOnLowBattery: batteryBox.checked }));
  renderBox.addEventListener("change", () => client.setPolicy({ pauseOnRenderStruggle: renderBox.checked }));

  off?.();
  off = client.subscribe((snapshot) => {
    const gate = snapshot.gate ? snapshot.gate : snapshot.enabled ? "open" : "idle";
    const statusText = !snapshot.available
      ? "browser unsupported"
      : !snapshot.configured
        ? "not configured"
        : snapshot.enabled
          ? `${snapshot.state}${snapshot.gate ? ` · ${snapshot.gate}` : ""}`
          : snapshot.optIn
            ? "opted in · paused"
            : "opted out";
    statusEl.textContent = statusText;
    noteEl.textContent = snapshot.configured
      ? `origin ${snapshot.origin || "—"}`
      : "Compute is unavailable until the public worker origin is configured.";
    gateEl.textContent = gate;
    workerEl.textContent = snapshot.workerId ? shortId(snapshot.workerId) : "—";
    modeEl.textContent = snapshot.mode;
    acceptedEl.textContent = formatInt(snapshot.totals.accepted);
    pendingEl.textContent = formatInt(snapshot.totals.pending);
    rejectedEl.textContent = formatInt(snapshot.totals.rejected);
    hiddenBox.checked = snapshot.policy.pauseWhenHidden === true;
    batteryBox.checked = snapshot.policy.pauseOnLowBattery === true;
    renderBox.checked = snapshot.policy.pauseOnRenderStruggle === true;
    optInBtn.disabled = !snapshot.available || !snapshot.configured || snapshot.enabled;
    optOutBtn.disabled = !snapshot.enabled;
    modeButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.mode === snapshot.mode);
    });
  });
}

function wirePublicData(root) {
  const noteEl = must(root, "#compute-public-note");
  const scoreEl = must(root, "#compute-public-score");
  const receiptsEl = must(root, "#compute-public-receipts");
  const workersEl = must(root, "#compute-public-workers");
  const medianEl = must(root, "#compute-public-median");
  const webgpuEl = must(root, "#compute-public-webgpu");
  const webrtcEl = must(root, "#compute-public-webrtc");
  const workloadsNoteEl = must(root, "#compute-workloads-note");
  const workloadsListEl = must(root, "#compute-workloads-list");

  async function refresh() {
    const origin = computeLabOrigin();
    if (!origin) {
      noteEl.textContent = "offline";
      workloadsNoteEl.textContent = "offline";
      workloadsListEl.innerHTML = `<div class="tight">No public compute origin is configured.</div>`;
      return;
    }
    try {
      const [statsRes, useCasesRes] = await Promise.all([
        fetch(`${origin}/compute/public/stats`, { cache: "no-store" }),
        fetch(`${origin}/compute/use-cases`, { cache: "no-store" }),
      ]);
      if (!statsRes.ok) throw new Error(`stats ${statsRes.status}`);
      if (!useCasesRes.ok) throw new Error(`use-cases ${useCasesRes.status}`);
      const stats = await statsRes.json();
      const useCasesPayload = await useCasesRes.json();
      noteEl.textContent = stats.privacy === "suppressed" ? "aggregate" : "live aggregate";
      scoreEl.textContent = formatInt(stats.computeScore);
      receiptsEl.textContent = formatInt(stats.totalReceipts ?? stats.scoreBreakdown?.acceptedReceipts);
      workersEl.textContent = formatInt(stats.activeWorkers);
      medianEl.textContent = stats.medianKernelMs == null ? "—" : formatMs(stats.medianKernelMs);
      webgpuEl.textContent = formatPct(stats.webgpuCorrectnessPct);
      webrtcEl.textContent = formatPct(stats.webrtcDirectSuccessPct);

      const useCases = Array.isArray(useCasesPayload.useCases) ? useCasesPayload.useCases : [];
      const shown = useCases
        .filter((entry) => entry.authority === "advisory")
        .filter((entry) =>
          entry.workload === "ml.logit_divergence.v0" ||
          entry.workload === "science.genome_kmer.v0" ||
          entry.workload === "science.contact_map_tile.v0" ||
          entry.workload === "m3t4.seed_sweep.v0" ||
          entry.workload === "m3t4.replay_verify.v1" ||
          entry.workload === "m3t4.public_artifact_verify.v0"
        );
      workloadsNoteEl.textContent = `${shown.length} public lanes`;
      workloadsListEl.innerHTML = shown.map((entry) => `
        <article class="compute-workload-card">
          <div class="compute-workload-head">
            <strong>${escapeHtml(entry.title || entry.id || entry.workload)}</strong>
            <span>${escapeHtml(entry.status || "unknown")}</span>
          </div>
          <div class="tight">${escapeHtml(entry.workload || "")}</div>
          <p>${escapeHtml(entry.notes || entry.validation || "")}</p>
        </article>
      `).join("");
    } catch {
      noteEl.textContent = "offline";
      workloadsNoteEl.textContent = "offline";
      workloadsListEl.innerHTML = `<div class="tight">Public compute data is temporarily unavailable.</div>`;
    }
  }

  if (refreshTimer) clearInterval(refreshTimer);
  void refresh();
  refreshTimer = setInterval(refresh, 30000);
}

function must(root, selector) {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`missing compute element: ${selector}`);
  return element;
}

function formatInt(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : "0";
}

function formatPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n)}%`;
}

function formatMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n)}ms`;
}

function shortId(value) {
  const text = String(value || "");
  if (text.length <= 12) return text;
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

export function unmount() {
  off?.();
  off = null;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}
