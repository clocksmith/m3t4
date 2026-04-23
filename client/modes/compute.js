import { getComputeClient } from "../lib/compute.js";
import { buttonHtml, chipHtml, linkButtonHtml, toggleSwitchHtml } from "../ui/actions.js";
import { contextCardHtml, pageHeaderHtml } from "../ui/shell.js";
import { escapeHtml } from "../ui/html.js";

let off = null;
let refreshTimer = null;
let contactMapTimer = null;
let myWorkTimer = null;

function computeLabOrigin() {
  return String(window.__M3T4_COMPUTE_LAB_ORIGIN__ || "").replace(/\/+$/, "");
}

function computeStateNote(snapshot) {
  if (!snapshot.available) return "This browser does not support the required worker APIs.";
  if (!snapshot.configured) return "Public compute is not configured in this environment.";
  if (snapshot.enabled && snapshot.gate) {
    return `Paused by ${snapshot.gate.replace(/-/g, " ")}.`;
  }
  if (snapshot.enabled) return "Donating from this browser.";
  if (snapshot.optIn) return "Opted in, but currently paused.";
  return "Ready to donate from this browser.";
}

function introCardHtml() {
  return contextCardHtml({
    className: "compute-intro-card",
    kicker: "opt-in browser compute",
    strong: "This browser can donate idle cycles to public, receipt-backed workloads.",
    copy: "Workers run off-thread and sign a receipt for every chunk they complete. You can pause or stop them any time.",
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
          ${buttonHtml({ id: "compute-opt-in", variant: "primary", text: "opt in", attrs: { title: "Register this browser as a compute worker and start accepting jobs" } })}
          ${buttonHtml({ id: "compute-opt-out", text: "stop", attrs: { title: "Stop donating compute and clear the opt-in preference" } })}
        </div>
      </div>
      <div class="compute-mode-block">
        <div class="compute-block-label">Mode</div>
        <div class="compute-mode-row" role="group" aria-label="Compute mode">
          ${buttonHtml({ className: "compute-mode-button", attrs: { "data-mode": "quiet", title: "Quiet pace — only donate cycles when the renderer is idle" }, text: "quiet" })}
          ${buttonHtml({ className: "compute-mode-button", attrs: { "data-mode": "standard", title: "Standard pace — donate cycles whenever the guards allow" }, text: "standard" })}
          ${buttonHtml({ className: "compute-mode-button", attrs: { "data-mode": "after-match", title: "Only donate between matches, never during live play" }, text: "after-match" })}
        </div>
      </div>
      <div class="compute-mode-block">
        <div class="compute-block-label">Pause policy</div>
        <div class="compute-policy-grid">
          ${toggleSwitchHtml({ id: "compute-policy-hidden", label: "Pause when tab is hidden", title: "Stop donating while this tab is backgrounded", className: "compute-policy-item" })}
          ${toggleSwitchHtml({ id: "compute-policy-battery", label: "Pause on battery", title: "Stop donating when the device is on battery", className: "compute-policy-item" })}
          ${toggleSwitchHtml({ id: "compute-policy-render", label: "Pause during render stress", title: "Stop donating when frame timing suggests the renderer is struggling", className: "compute-policy-item" })}
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
        ${linkButtonHtml({ href: "/spectate", text: "watch live", attrs: { title: "Leave this page and watch live matches" } })}
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

function contactMapPanelHtml() {
  return `
    <section class="panel compute-contact-map-panel" aria-label="Contact-map receipt trail">
      <div class="compute-contact-map-head">
        <h3>Contact-map receipts</h3>
        <div id="compute-contact-map-note" class="tight">loading</div>
      </div>
      <div class="compute-contact-map-summary">
        <div><span>tasks</span><strong id="compute-contact-map-tasks">0</strong></div>
        <div><span>accepted receipts</span><strong id="compute-contact-map-receipts">0</strong></div>
      </div>
      <div id="compute-contact-map-tiles" class="compute-contact-map-tiles"></div>
    </section>`;
}

function myWorkPanelHtml() {
  return `
    <section class="panel compute-my-work-panel" aria-label="Your recent work">
      <div class="compute-my-work-head">
        <h3>Your recent work</h3>
        <div id="compute-my-work-note" class="tight">loading</div>
      </div>
      <div id="compute-my-work-by-kernel" class="compute-my-work-by-kernel"></div>
      <div id="compute-my-work-recent" class="compute-my-work-recent"></div>
    </section>`;
}

export function mount(root, { setStatus }) {
  setStatus("compute");
  root.innerHTML = `
    <div class="page compute-page">
      ${pageHeaderHtml({
        title: "Compute",
        subtitle: "Donate spare browser cycles. Every chunk returns a signed receipt.",
        action: linkButtonHtml({ href: "/about", text: "about", attrs: { title: "Read what m3t4.ai is and the compute pitch" } }),
      })}
      ${introCardHtml()}
      ${controlsPanelHtml()}
      ${publicStatsPanelHtml()}
      ${workloadsPanelHtml()}
      ${myWorkPanelHtml()}
      ${contactMapPanelHtml()}
    </div>`;
  wireControls(root);
  wirePublicData(root);
  wireContactMapData(root);
  wireMyWorkData(root);
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
    noteEl.textContent = computeStateNote(snapshot);
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
          <div class="compute-workload-chips">
            ${workloadChipsHtml(entry)}
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

function wireContactMapData(root) {
  const noteEl = must(root, "#compute-contact-map-note");
  const tasksEl = must(root, "#compute-contact-map-tasks");
  const receiptsEl = must(root, "#compute-contact-map-receipts");
  const tilesEl = must(root, "#compute-contact-map-tiles");

  async function refresh() {
    const origin = computeLabOrigin();
    if (!origin) {
      noteEl.textContent = "offline";
      tilesEl.innerHTML = `<div class="tight">No public compute origin is configured.</div>`;
      return;
    }
    try {
      const res = await fetch(`${origin}/compute/public/contact-map/aggregate`, { cache: "no-store" });
      if (!res.ok) throw new Error(`aggregate ${res.status}`);
      const body = await res.json();
      const tiles = Array.isArray(body.tiles) ? body.tiles : [];
      tasksEl.textContent = formatInt(body.totalTasks);
      receiptsEl.textContent = formatInt(body.totalAcceptedReceipts);
      if (tiles.length === 0) {
        noteEl.textContent = "no accepted receipts yet";
        tilesEl.innerHTML = `<div class="tight">Accepted contact-map receipts will appear here once workers complete tiles.</div>`;
        return;
      }
      noteEl.textContent = `${tiles.length} tile${tiles.length === 1 ? "" : "s"}`;
      tilesEl.innerHTML = tiles.map((tile) => contactMapTileHtml(tile)).join("");
    } catch {
      noteEl.textContent = "offline";
      tilesEl.innerHTML = `<div class="tight">Contact-map aggregate is temporarily unavailable.</div>`;
    }
  }

  if (contactMapTimer) clearInterval(contactMapTimer);
  void refresh();
  contactMapTimer = setInterval(refresh, 30000);
}

function contactMapTileHtml(tile) {
  const receipts = Array.isArray(tile.receipts) ? tile.receipts : [];
  const rowLen = String(tile.rowResidues ?? "").length;
  const colLen = String(tile.colResidues ?? "").length;
  const cells = Math.max(0, rowLen * colLen);
  const header = `
    <div class="compute-contact-map-tile-head">
      <div>
        <strong>${escapeHtml(String(tile.taskId || ""))}</strong>
        <div class="tight">row ${formatInt(tile.rowStart)}..${formatInt(tile.rowStart + rowLen)} · col ${formatInt(tile.colStart)}..${formatInt(tile.colStart + colLen)} · ${formatInt(cells)} cells</div>
      </div>
      <div class="tight">accepted ${formatInt(tile.acceptedCount)} / ${formatInt(tile.receiptCount)}</div>
    </div>`;
  const receiptRows = receipts.map((receipt) => `
    <li class="compute-contact-map-receipt">
      <code>${escapeHtml(shortId(receipt.receiptId || ""))}</code>
      <span>${escapeHtml(receipt.transport || "—")}</span>
      <span>${escapeHtml(receipt.executionMode || "—")}</span>
      <span>${escapeHtml(receipt.signatureStatus || "unsigned")}</span>
      <code class="tight">${escapeHtml(String(receipt.outputHash?.value ?? "").slice(0, 16))}…</code>
    </li>
  `).join("");
  return `
    <article class="compute-contact-map-tile">
      ${header}
      <ul class="compute-contact-map-receipts">${receiptRows}</ul>
    </article>`;
}

function wireMyWorkData(root) {
  const noteEl = must(root, "#compute-my-work-note");
  const kernelsEl = must(root, "#compute-my-work-by-kernel");
  const recentEl = must(root, "#compute-my-work-recent");
  const client = getComputeClient();

  async function refresh() {
    const receipts = await client.fetchMyReceipts(50);
    if (!Array.isArray(receipts) || receipts.length === 0) {
      noteEl.textContent = "no receipts yet";
      kernelsEl.innerHTML = "";
      recentEl.innerHTML = `<div class="tight">Opt in and accept a job to see your own receipts here.</div>`;
      return;
    }
    noteEl.textContent = `${receipts.length} receipt${receipts.length === 1 ? "" : "s"} · last ${relativeTime(receipts[0].receivedAt)}`;
    kernelsEl.innerHTML = renderByKernel(receipts);
    recentEl.innerHTML = renderRecentList(receipts.slice(0, 12));
  }

  if (myWorkTimer) clearInterval(myWorkTimer);
  void refresh();
  myWorkTimer = setInterval(refresh, 30000);
}

const FAMILY_CHIP_LABELS = {
  m3t4: { label: "m3t4", title: "Arena-specific workload" },
  science: { label: "science", title: "Science-adjacent workload on public data" },
  ml: { label: "ml", title: "Machine-learning workload" },
  plasma: { label: "plasma", title: "Plasma substrate workload" },
  "device-witness": { label: "device-witness", title: "Scheduler-facing capability witness" },
  infra: { label: "infra", title: "Transport or infrastructure lane" },
};

const RUNTIME_CHIP_LABELS = {
  webgpu: { label: "webgpu", title: "Requires WebGPU-capable hardware" },
  webrtc: { label: "webrtc", title: "Runs over the WebRTC data plane" },
};

function workloadChipsHtml(entry) {
  const chips = [];
  const family = FAMILY_CHIP_LABELS[entry.family];
  if (family) {
    chips.push(chipHtml({ variant: `family-${entry.family}`, label: family.label, title: family.title }));
  }
  const runtime = entry.runtime && entry.runtime !== "cpu" ? RUNTIME_CHIP_LABELS[entry.runtime] : null;
  if (runtime) {
    chips.push(chipHtml({ variant: `runtime-${entry.runtime}`, label: runtime.label, title: runtime.title }));
  }
  return chips.join("");
}

function renderByKernel(receipts) {
  const groups = new Map();
  for (const r of receipts) {
    const key = r.kernelId || r.taskKind || "unknown";
    if (!groups.has(key)) {
      groups.set(key, { kernelId: key, accepted: 0, pending: 0, rejected: 0, lastAcceptedAt: 0 });
    }
    const g = groups.get(key);
    if (r.decision === "accepted") {
      g.accepted++;
      if (r.receivedAt > g.lastAcceptedAt) g.lastAcceptedAt = r.receivedAt;
    } else if (r.decision === "pending") g.pending++;
    else g.rejected++;
  }
  const rows = Array.from(groups.values())
    .sort((a, b) => (b.lastAcceptedAt - a.lastAcceptedAt) || (b.accepted - a.accepted));
  return rows.map((g) => `
    <article class="compute-my-work-kernel">
      <div class="compute-my-work-kernel-head">
        <strong>${escapeHtml(g.kernelId)}</strong>
        <span class="tight">${g.lastAcceptedAt ? `last accepted ${relativeTime(g.lastAcceptedAt)}` : "no accepted yet"}</span>
      </div>
      <div class="compute-my-work-kernel-counts">
        <span><em>${formatInt(g.accepted)}</em> accepted</span>
        <span><em>${formatInt(g.pending)}</em> pending</span>
        <span><em>${formatInt(g.rejected)}</em> rejected</span>
      </div>
    </article>
  `).join("");
}

function renderRecentList(receipts) {
  if (!receipts.length) return "";
  return `
    <ul class="compute-my-work-list">
      ${receipts.map((r) => `
        <li class="compute-my-work-row" data-decision="${escapeHtml(r.decision)}">
          <code>${escapeHtml(shortId(r.receiptId || ""))}</code>
          <span>${escapeHtml(r.kernelId || r.taskKind || "")}</span>
          <span>${escapeHtml(r.decision)}</span>
          <span>${escapeHtml(r.transport || "—")}</span>
          <span>${escapeHtml(r.executionMode || "—")}</span>
          <span class="tight">${relativeTime(r.receivedAt)}</span>
        </li>
      `).join("")}
    </ul>`;
}

function relativeTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const delta = Math.max(0, Date.now() - n);
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
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
  if (contactMapTimer) clearInterval(contactMapTimer);
  contactMapTimer = null;
  if (myWorkTimer) clearInterval(myWorkTimer);
  myWorkTimer = null;
}
