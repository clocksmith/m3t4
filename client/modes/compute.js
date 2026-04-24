import { getComputeClient } from "../lib/compute.js";
import { buttonHtml, chipHtml, linkButtonHtml, toggleSwitchHtml } from "../ui/actions.js";
import { contextCardHtml, pageHeaderHtml } from "../ui/shell.js";
import { escapeHtml } from "../ui/html.js";

let off = null;
let refreshTimer = null;
let contactMapTimer = null;
let myWorkTimer = null;
const PUBLIC_REFRESH_OPEN_MS = 30_000;
const PUBLIC_REFRESH_CLOSED_MS = 120_000;
const CONTACT_MAP_REGION_LIMIT = 6;
const CONTACT_MAP_ACCEPTED_LIMIT = 4;

function computeLabOrigin() {
  return String(window.__M3T4_COMPUTE_LAB_ORIGIN__ || "").replace(/\/+$/, "");
}

function computeStateNote(snapshot) {
  if (!snapshot.available) return "This browser does not support the required worker APIs.";
  if (!snapshot.originConfigured) return "Public compute is not configured in this environment.";
  if (!snapshot.workerFeatureEnabled) return "Browser compute opt-in is disabled by the current deployment flag. Public stats remain visible.";
  if (snapshot.enabled && snapshot.gate) {
    return `Paused by ${snapshot.gate.replace(/-/g, " ")}.`;
  }
  if (snapshot.enabled) return "Donating from this browser.";
  if (snapshot.optIn) return "Opted in, but currently paused.";
  return "Ready to donate from this browser.";
}

function computeStatusText(snapshot) {
  if (!snapshot.available) return "browser unsupported";
  if (!snapshot.originConfigured) return "not configured";
  if (!snapshot.workerFeatureEnabled) return "opt-in disabled";
  if (snapshot.enabled) return `${snapshot.state}${snapshot.gate ? ` · ${snapshot.gate}` : ""}`;
  return snapshot.optIn ? "opted in · paused" : "opted out";
}

function introCardHtml() {
  return contextCardHtml({
    className: "compute-intro-card",
    kicker: "public browser compute",
    strong: "The durable view for receipts and workload lanes.",
    copy: "Live keeps the match-tied bundle mosaic; this page keeps the slower aggregate state.",
  });
}

function controlsPanelHtml() {
  return `
    <section class="panel compute-opt-panel" aria-label="This browser">
      <div class="compute-opt-head">
        <div class="compute-opt-title">
          <h3>This Browser</h3>
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
        <div><span>pause reason</span><strong id="compute-local-gate">—</strong></div>
        <div><span>worker id</span><strong id="compute-local-worker">—</strong></div>
        <div><span>pace</span><strong id="compute-local-mode">—</strong></div>
        <div><span>accepted (session)</span><strong id="compute-local-accepted">0</strong></div>
        <div><span>pending (session)</span><strong id="compute-local-pending">0</strong></div>
        <div><span>rejected (session)</span><strong id="compute-local-rejected">0</strong></div>
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
        ${linkButtonHtml({ href: "/live", text: "live compute view", attrs: { title: "Open the live match compute mosaic" } })}
      </div>
      <div class="compute-public-grid">
        <div><span>network score</span><strong id="compute-public-score">0</strong></div>
        <div><span>network accepted receipts</span><strong id="compute-public-receipts">0</strong></div>
        <div><span>active workers</span><strong id="compute-public-workers">0</strong></div>
        <div><span>median job runtime</span><strong id="compute-public-median">0</strong></div>
        <div><span>witness pass rate</span><strong id="compute-public-webgpu">0%</strong></div>
        <div><span>direct peer transfer rate</span><strong id="compute-public-webrtc">0%</strong></div>
      </div>
    </section>`;
}

function workloadsPanelHtml() {
  return `
    <section class="panel compute-workloads-panel" aria-label="Available compute lanes">
      <div class="compute-workloads-head">
        <div class="compute-workloads-title">
          <h3>Available Lanes</h3>
          <div id="compute-workloads-note" class="tight">loading</div>
        </div>
        <div id="compute-workloads-intake" class="compute-workloads-intake" aria-live="polite"></div>
      </div>
      <div class="compute-workloads-table-wrap">
        <table class="compute-workloads-table">
          <thead>
            <tr>
              <th scope="col">Lane</th>
              <th scope="col">Family</th>
              <th scope="col">Runtime</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody id="compute-workloads-rows"></tbody>
        </table>
      </div>
    </section>`;
}

function contactMapPanelHtml() {
  return `
    <section class="panel compute-contact-map-panel" aria-label="Science workload snapshot">
      <div class="compute-contact-map-head">
        <div class="compute-contact-map-title">
          <h3>Science Queue</h3>
          <div id="compute-contact-map-note" class="tight">loading</div>
        </div>
        ${linkButtonHtml({ href: "/live", text: "live bundle view", attrs: { title: "Watch active bundle chunks on the Live page" } })}
      </div>
      <div class="compute-contact-map-summary">
        <div><span>queued tasks</span><strong id="compute-contact-map-tasks">0</strong></div>
        <div><span>regions</span><strong id="compute-contact-map-regions">0</strong></div>
        <div><span>regions with receipts</span><strong id="compute-contact-map-active">0</strong></div>
        <div><span>accepted receipts</span><strong id="compute-contact-map-receipts">0</strong></div>
      </div>
      <div id="compute-contact-map-rollup" class="compute-contact-map-rollup"></div>
    </section>`;
}

function myWorkPanelHtml() {
  return `
    <section class="panel compute-my-work-panel" aria-label="Your recent work">
      <div class="compute-my-work-head">
        <div>
          <h3>Your recent work</h3>
          <div id="compute-my-work-scope" class="tight">this browser</div>
        </div>
        <div id="compute-my-work-note" class="tight">loading</div>
      </div>
      <div id="compute-my-work-linking" class="compute-my-work-linking" hidden></div>
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
        subtitle: "Receipts, lanes, and network health.",
      })}
      ${introCardHtml()}
      ${controlsPanelHtml()}
      ${myWorkPanelHtml()}
      ${publicStatsPanelHtml()}
      ${workloadsPanelHtml()}
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
  const panelEl = must(root, ".compute-opt-panel");
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
    panelEl.hidden = !(snapshot.originConfigured && snapshot.workerFeatureEnabled);
    const gate = snapshot.gate ? snapshot.gate : snapshot.enabled ? "open" : "idle";
    const statusText = computeStatusText(snapshot);
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
    const optInDisabledReason = !snapshot.available
      ? "This browser does not support the required worker APIs"
      : !snapshot.originConfigured
        ? "Public compute is not configured in this environment"
        : !snapshot.workerFeatureEnabled
          ? "Browser compute opt-in is disabled by the current deployment flag"
          : "Register this browser as a compute worker and start accepting jobs";
    optInBtn.disabled = !snapshot.available || !snapshot.originConfigured || !snapshot.workerFeatureEnabled || snapshot.enabled;
    optInBtn.title = snapshot.enabled ? "This browser is already donating compute" : optInDisabledReason;
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
  const workloadsRowsEl = must(root, "#compute-workloads-rows");
  const intakeEl = must(root, "#compute-workloads-intake");

  function renderEmptyRows(message) {
    workloadsRowsEl.innerHTML = `<tr><td colspan="4" class="tight">${escapeHtml(message)}</td></tr>`;
  }

  function renderIntake(status) {
    if (!status) {
      intakeEl.innerHTML = "";
      return;
    }
    const open = status.acceptAssignments === true;
    const closesAt = Number(status.assignmentIntakeClosesAt);
    let tail = "";
    if (open && Number.isFinite(closesAt) && closesAt > 0) {
      const remainingMs = Math.max(0, closesAt - Date.now());
      if (remainingMs > 0) tail = ` · ${formatDuration(remainingMs)} left`;
    }
    const variant = open ? "intake-open" : "intake-closed";
    const label = open ? `Intake open${tail}` : "Intake closed";
    const title = open
      ? "Coordinator is currently accepting assignments from opted-in browsers"
      : "Coordinator is not accepting assignments right now; browsers will stay idle";
    intakeEl.innerHTML = chipHtml({ variant, label, title });
  }

  async function fetchPublicSummary(origin) {
    const summaryRes = await fetch(`${origin}/compute/public/summary`, { cache: "no-store" });
    if (summaryRes.ok) {
      const summary = await summaryRes.json();
      return {
        stats: summary.stats,
        useCases: Array.isArray(summary.useCases) ? summary.useCases : [],
        status: summary.status ?? null,
      };
    }
    if (summaryRes.status !== 404) throw new Error(`summary ${summaryRes.status}`);
    const [statsRes, useCasesRes, statusRes] = await Promise.all([
      fetch(`${origin}/compute/public/stats`, { cache: "no-store" }),
      fetch(`${origin}/compute/use-cases`, { cache: "no-store" }),
      fetch(`${origin}/compute/status`, { cache: "no-store" }),
    ]);
    let status = null;
    if (statusRes.ok) {
      try { status = await statusRes.json(); } catch { status = null; }
    }
    if (!statsRes.ok) throw new Error(`stats ${statsRes.status}`);
    if (!useCasesRes.ok) throw new Error(`use-cases ${useCasesRes.status}`);
    const stats = await statsRes.json();
    const useCasesPayload = await useCasesRes.json();
    return {
      stats,
      useCases: Array.isArray(useCasesPayload.useCases) ? useCasesPayload.useCases : [],
      status,
    };
  }

  function schedulePublicRefresh(status) {
    if (refreshTimer) clearTimeout(refreshTimer);
    const waitMs = status?.acceptAssignments === true ? PUBLIC_REFRESH_OPEN_MS : PUBLIC_REFRESH_CLOSED_MS;
    refreshTimer = setTimeout(refresh, waitMs);
  }

  async function refresh() {
    const origin = computeLabOrigin();
    if (!origin) {
      noteEl.textContent = "offline";
      workloadsNoteEl.textContent = "offline";
      renderEmptyRows("No public compute origin is configured.");
      renderIntake(null);
      schedulePublicRefresh(null);
      return;
    }
    try {
      const { stats, useCases, status } = await fetchPublicSummary(origin);
      renderIntake(status);
      noteEl.textContent = stats.privacy === "suppressed" ? "aggregate" : "live aggregate";
      scoreEl.textContent = formatInt(stats.computeScore);
      receiptsEl.textContent = formatInt(stats.totalReceipts ?? stats.scoreBreakdown?.acceptedReceipts);
      workersEl.textContent = formatInt(stats.activeWorkers);
      medianEl.textContent = stats.medianKernelMs == null ? "—" : formatMs(stats.medianKernelMs);
      webgpuEl.textContent = formatPct(stats.webgpuCorrectnessPct);
      webrtcEl.textContent = formatPct(stats.webrtcDirectSuccessPct);

      // The server applies publicVisible via the workload policy; trust
      // what it returns instead of hand-rolling a whitelist here. Still
      // filter to advisory entries that name a workload, since device-witness
      // "profiles" meta-entries don't describe a schedulable lane.
      const shown = useCases
        .filter((entry) => entry.authority === "advisory")
        .filter((entry) => typeof entry.workload === "string" && entry.workload.length > 0);
      workloadsNoteEl.textContent = `${shown.length} lanes`;
      workloadsRowsEl.innerHTML = shown.map((entry) => `
        <tr class="compute-workloads-row">
          <td>
            <strong>${escapeHtml(entry.title || entry.id || entry.workload)}</strong>
            <div class="tight"><code>${escapeHtml(entry.workload || "")}</code></div>
          </td>
          <td>${familyChipHtml(entry)}</td>
          <td>${runtimeChipHtml(entry)}</td>
          <td><span class="compute-workloads-status">${escapeHtml(entry.policy?.release || entry.status || "unknown")}</span></td>
        </tr>
      `).join("");
      schedulePublicRefresh(status);
    } catch {
      noteEl.textContent = "offline";
      workloadsNoteEl.textContent = "offline";
      renderEmptyRows("Public compute data is temporarily unavailable.");
      renderIntake(null);
      schedulePublicRefresh(null);
    }
  }

  if (refreshTimer) clearTimeout(refreshTimer);
  void refresh();
}

function wireContactMapData(root) {
  const noteEl = must(root, "#compute-contact-map-note");
  const tasksEl = must(root, "#compute-contact-map-tasks");
  const regionsEl = must(root, "#compute-contact-map-regions");
  const activeEl = must(root, "#compute-contact-map-active");
  const receiptsEl = must(root, "#compute-contact-map-receipts");
  const rollupEl = must(root, "#compute-contact-map-rollup");

  async function refresh() {
    const origin = computeLabOrigin();
    if (!origin) {
      noteEl.textContent = "offline";
      rollupEl.innerHTML = `<div class="tight">No public compute origin is configured.</div>`;
      return;
    }
    try {
      const res = await fetch(`${origin}/compute/public/contact-map/aggregate`, { cache: "no-store" });
      if (!res.ok) throw new Error(`aggregate ${res.status}`);
      const body = await res.json();
      const tiles = Array.isArray(body.tiles) ? body.tiles : [];
      const totalTasks = Math.max(0, Number(body.totalTasks ?? tiles.length) || 0);
      const totalAcceptedReceipts = Math.max(0, Number(body.totalAcceptedReceipts) || 0);
      const receiptTiles = tiles.filter((tile) => Number(tile.receiptCount) > 0).length;
      const acceptedTiles = tiles.filter((tile) => Number(tile.acceptedCount) > 0).length;
      const groups = contactMapRegionGroups(tiles);
      tasksEl.textContent = formatInt(totalTasks);
      regionsEl.textContent = formatInt(groups.length);
      activeEl.textContent = formatInt(receiptTiles);
      receiptsEl.textContent = formatInt(totalAcceptedReceipts);
      if (totalTasks === 0) {
        noteEl.textContent = "empty";
        rollupEl.innerHTML = `<div class="tight">No contact-map tasks are queued.</div>`;
        return;
      }
      noteEl.textContent = totalAcceptedReceipts > 0
        ? `${formatInt(totalAcceptedReceipts)} accepted across ${formatInt(acceptedTiles)} region${acceptedTiles === 1 ? "" : "s"}`
        : `${formatInt(totalTasks)} queued · no accepted receipts yet`;
      rollupEl.innerHTML = contactMapRollupHtml({
        groups,
        tiles,
        totalTasks,
        receiptTiles,
        totalAcceptedReceipts,
      });
    } catch {
      noteEl.textContent = "offline";
      rollupEl.innerHTML = `<div class="tight">Contact-map aggregate is temporarily unavailable.</div>`;
    }
  }

  if (contactMapTimer) clearInterval(contactMapTimer);
  void refresh();
  contactMapTimer = setInterval(refresh, 30000);
}

function contactMapRollupHtml({ groups, tiles, totalTasks, receiptTiles, totalAcceptedReceipts }) {
  const acceptedSamples = tiles
    .filter((tile) => Number(tile.acceptedCount) > 0)
    .sort((a, b) =>
      Number(b.acceptedCount) - Number(a.acceptedCount) ||
      Number(b.receiptCount) - Number(a.receiptCount) ||
      Number(a.rowStart) - Number(b.rowStart) ||
      Number(a.colStart) - Number(b.colStart)
    )
    .slice(0, CONTACT_MAP_ACCEPTED_LIMIT);
  const shownGroups = groups.slice(0, CONTACT_MAP_REGION_LIMIT);
  const hiddenGroups = Math.max(0, groups.length - shownGroups.length);
  const groupRows = shownGroups.map(contactMapRegionHtml).join("");
  const acceptedHtml = acceptedSamples.length
    ? `
      <div class="compute-contact-map-section">
        <div class="compute-block-label">Accepted receipt samples</div>
        <div class="compute-contact-map-samples">
          ${acceptedSamples.map(contactMapAcceptedTileHtml).join("")}
        </div>
      </div>`
    : `
      <div class="compute-contact-map-empty">
        ${receiptTiles > 0
          ? `${formatInt(receiptTiles)} region${receiptTiles === 1 ? "" : "s"} have receipts waiting on acceptance.`
          : "Queued contact-map tasks have not produced receipts yet."}
      </div>`;
  return `
    <div class="compute-contact-map-section">
      <div class="compute-block-label">Coverage rollup</div>
      <div class="compute-contact-map-regions">${groupRows}</div>
      ${hiddenGroups > 0 ? `<div class="tight">+${formatInt(hiddenGroups)} more region${hiddenGroups === 1 ? "" : "s"} summarized away from this page.</div>` : ""}
    </div>
    ${acceptedHtml}
    <div class="tight">
      ${formatInt(totalTasks)} task${totalTasks === 1 ? "" : "s"} · ${formatInt(totalAcceptedReceipts)} accepted receipt${totalAcceptedReceipts === 1 ? "" : "s"}
    </div>`;
}

function contactMapRegionGroups(tiles) {
  const groups = new Map();
  for (const tile of tiles) {
    const rowStart = Number(tile.rowStart) || 0;
    const colStart = Number(tile.colStart) || 0;
    const rowLen = String(tile.rowResidues ?? "").length;
    const colLen = String(tile.colResidues ?? "").length;
    const cells = Math.max(0, rowLen * colLen);
    const key = `${rowStart}:${rowLen}:${colStart}:${colLen}`;
    if (!groups.has(key)) {
      groups.set(key, {
        rowStart,
        rowEnd: rowStart + rowLen,
        colStart,
        colEnd: colStart + colLen,
        cells,
        tasks: 0,
        receiptCount: 0,
        acceptedCount: 0,
      });
    }
    const group = groups.get(key);
    group.tasks++;
    group.receiptCount += Math.max(0, Number(tile.receiptCount) || 0);
    group.acceptedCount += Math.max(0, Number(tile.acceptedCount) || 0);
  }
  return Array.from(groups.values()).sort((a, b) =>
    b.acceptedCount - a.acceptedCount ||
    b.receiptCount - a.receiptCount ||
    b.cells - a.cells ||
    b.tasks - a.tasks ||
    a.rowStart - b.rowStart ||
    a.colStart - b.colStart
  );
}

function contactMapRegionHtml(group) {
  return `
    <article class="compute-contact-map-region">
      <div>
        <strong>row ${formatInt(group.rowStart)}..${formatInt(group.rowEnd)} · col ${formatInt(group.colStart)}..${formatInt(group.colEnd)}</strong>
        <div class="tight">${formatInt(group.cells)} cell${group.cells === 1 ? "" : "s"}</div>
      </div>
      <div class="compute-contact-map-region-counts">
        <span><em>${formatInt(group.tasks)}</em> task${group.tasks === 1 ? "" : "s"}</span>
        <span><em>${formatInt(group.receiptCount)}</em> receipt${group.receiptCount === 1 ? "" : "s"}</span>
        <span><em>${formatInt(group.acceptedCount)}</em> accepted</span>
      </div>
    </article>`;
}

function contactMapAcceptedTileHtml(tile) {
  const receipts = Array.isArray(tile.receipts) ? tile.receipts : [];
  const rowLen = String(tile.rowResidues ?? "").length;
  const colLen = String(tile.colResidues ?? "").length;
  const cells = Math.max(0, rowLen * colLen);
  const header = `
    <div class="compute-contact-map-tile-head">
      <div>
        <strong>row ${formatInt(tile.rowStart)}..${formatInt(tile.rowStart + rowLen)} · col ${formatInt(tile.colStart)}..${formatInt(tile.colStart + colLen)}</strong>
        <div class="tight">${formatInt(cells)} cell${cells === 1 ? "" : "s"}</div>
      </div>
      <div class="tight">accepted ${formatInt(tile.acceptedCount)} / ${formatInt(tile.receiptCount)}</div>
    </div>`;
  const receiptRows = receipts.slice(0, 2).map((receipt) => `
    <li class="compute-contact-map-receipt">
      ${tilePreviewHtml(receipt.preview)}
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
  const scopeEl = must(root, "#compute-my-work-scope");
  const linkingEl = must(root, "#compute-my-work-linking");
  const kernelsEl = must(root, "#compute-my-work-by-kernel");
  const recentEl = must(root, "#compute-my-work-recent");
  const client = getComputeClient();

  function renderLinking(body) {
    const signedIn = body?.scope === "account" && body?.accountUid;
    if (signedIn) {
      linkingEl.hidden = true;
      linkingEl.innerHTML = "";
      return;
    }
    linkingEl.hidden = false;
    linkingEl.innerHTML = `
      <span>Signed in? Link this browser to your account to merge receipts across devices.</span>
      <a href="/roster" title="Go to the roster page to sign in or link this browser">sign in</a>`;
  }

  async function refresh() {
    const body = await client.fetchMyReceipts(50);
    const receipts = Array.isArray(body?.receipts) ? body.receipts : [];
    scopeEl.textContent = scopeLabel(body);
    renderLinking(body);
    if (receipts.length === 0) {
      const workerControlsEnabled = client.snapshot().originConfigured && client.snapshot().workerFeatureEnabled;
      noteEl.textContent = "no receipts yet";
      kernelsEl.innerHTML = "";
      recentEl.innerHTML = `<div class="tight">${workerControlsEnabled
        ? "Opt in and accept a job to see your own receipts here."
        : "Receipts linked to this browser or account will appear here."}</div>`;
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

function scopeLabel(body) {
  if (!body) return "this browser session";
  if (body.scope === "account" && body.accountUid) {
    const handle = typeof window.__M3T4_COMPUTE_ACCOUNT_HANDLE__ === "string"
      ? window.__M3T4_COMPUTE_ACCOUNT_HANDLE__
      : null;
    return handle ? `linked to @${handle}` : `linked to account`;
  }
  if (body.scope === "browser" && body.clientId) return "this browser, across tabs and reloads";
  return "this browser session";
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

function familyChipHtml(entry) {
  const family = FAMILY_CHIP_LABELS[entry.family];
  if (!family) return "";
  return chipHtml({ variant: `family-${entry.family}`, label: family.label, title: family.title });
}

function runtimeChipHtml(entry) {
  if (!entry.runtime) return "";
  if (entry.runtime === "cpu") return chipHtml({ variant: `runtime-cpu`, label: "cpu", title: "Runs on CPU; no GPU required" });
  const runtime = RUNTIME_CHIP_LABELS[entry.runtime];
  if (!runtime) return "";
  return chipHtml({ variant: `runtime-${entry.runtime}`, label: runtime.label, title: runtime.title });
}

function workloadChipsHtml(entry) {
  return `${familyChipHtml(entry)}${runtimeChipHtml(entry)}`;
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

// Advisory preview attached to a receipt. Never affects acceptance — the
// bytes render here only if the server-persisted preview.sha256 matched
// the actual bytes when the receipt was submitted.
function tilePreviewHtml(preview) {
  if (!preview || preview.encoding !== "png" || !preview.bytesBase64) return "";
  const src = `data:image/png;base64,${preview.bytesBase64}`;
  const w = Number(preview.widthPx) || 0;
  const h = Number(preview.heightPx) || 0;
  const alt = `output tile preview ${w}x${h}`;
  return `<img class="compute-tile-preview" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">`;
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

function formatDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 60_000) return `${Math.max(1, Math.round(n / 1000))}s`;
  if (n < 3_600_000) return `${Math.round(n / 60_000)}m`;
  if (n < 86_400_000) return `${Math.round(n / 3_600_000)}h`;
  return `${Math.round(n / 86_400_000)}d`;
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
