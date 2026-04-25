// Battle-anchored compute dash. Lives as a sibling to the arena canvas on
// /spectate. Four-state cycle — battle only / compute only / battle-big
// PIP / compute-big PIP — is driven externally; this module just knows
// whether to render in "full" or "pip" mode and when to (un)poll plasma-lab.
//
// Data model:
//   - bundle      — the currently-anchored ComputeBundleManifest (from
//                   matchStart.bundle event, or recovered from public list)
//   - aggregate   — periodic GET /compute/public/bundles/:id (counts,
//                   per-chunk status, tile mosaic coordinates)
//   - quorum      — periodic GET /compute/public/matches/:matchId/witness-quorum
//   - receipts    — a short scrollback of recent events derived from
//                   aggregate diffs (no WS push; synthesized client-side)
//   - certificate — set when matchEnd arrives carrying a bundleRoot
//
// Dash unmounts all polling when set to "hidden"; display mode swaps
// between "full" and "pip" are free (just CSS class + render loop change).

import { escapeHtml } from "../ui/html.js";

const POLL_INTERVAL_MS = 5000;
const POLL_INTERVAL_AFTER_SEAL_MS = 20_000; // slow down once sealed
const POLL_INTERVAL_WHEN_HIDDEN_MS = null;  // don't poll
const FEED_LIMIT = 40;

export function createSpectateComputeDash({ root, computeLabOrigin }) {
  if (!root) throw new Error("createSpectateComputeDash requires root");
  const origin = String(computeLabOrigin || "").replace(/\/+$/, "");

  // --- state ---
  let display = "hidden"; // "hidden" | "full" | "pip"
  let bundleRef = null;   // { bundleId, kernelId, chunkCount, sponsors, presetId }
  let matchId = null;
  let aggregate = null;   // { bundle, chunkStatus, acceptedReceiptCount, ... }
  let quorum = null;      // { matchId, totalSubmitters, ticks: [...] }
  let certificate = null; // { winnerHandle, bundleRoot, bundleManifestHash, matchReceiptHash, counts }
  let matchMeta = null;   // { winnerHandle } set on matchEnd
  let lastAcceptedCounts = new Map(); // chunkId -> accepted count, for synthetic feed diffs
  let feed = [];          // [{ t, kind, text, emphasis }]
  let pollTimer = null;
  let abortController = null;
  let sealed = false;
  let destroyed = false;

  // --- DOM ---
  root.classList.add("compute-dash");
  root.dataset.mode = display;
  root.innerHTML = "";

  // --- public API ---
  function setDisplay(next) {
    if (next !== "hidden" && next !== "full" && next !== "pip") return;
    const prev = display;
    display = next;
    root.dataset.mode = display;
    if (display === "hidden") {
      stopPolling();
      // Hidden still keeps bundle/match state so toggling back restores it.
    } else {
      scheduleNextPoll(0);
    }
    renderAll();
    if (prev !== display) emit("display-changed", { display });
  }

  function onMatchStart({ matchId: nextMatchId, bundle, match }) {
    matchId = nextMatchId ?? null;
    bundleRef = bundle ? normalizeBundleRef(bundle) : null;
    aggregate = null;
    quorum = null;
    certificate = null;
    matchMeta = { winnerHandle: null, a: match?.a ?? null, b: match?.b ?? null };
    sealed = false;
    lastAcceptedCounts = new Map();
    feed = [];
    if (bundleRef) pushBundleStartFeed(bundleRef);
    if (display !== "hidden") scheduleNextPoll(0);
    renderAll();
  }

  function onMatchEnd({ matchId: nextMatchId, winner, bundles, a, b }) {
    if (nextMatchId && matchId && nextMatchId !== matchId) {
      // Out-of-order event — ignore rather than confuse the dash.
      return;
    }
    const winnerHandle = winner === 0 ? a?.handle : winner === 1 ? b?.handle : null;
    matchMeta = { ...(matchMeta ?? {}), winnerHandle, a: a ?? matchMeta?.a, b: b ?? matchMeta?.b };
    if (bundles?.bundleRoot && bundleRef) {
      sealed = true;
      certificate = {
        winnerHandle,
        bundleId: bundleRef.bundleId,
        bundleRoot: bundles.bundleRoot,
        proofBundleId: bundles.proofBundleId ?? null,
      };
      pushFeed({
        t: Date.now(),
        kind: "bundle-sealed",
        text: `bundle sealed · root ${shortHash(bundles.bundleRoot)}${winnerHandle ? ` · winner @${winnerHandle}` : ""}`,
        emphasis: true,
      });
    }
    if (display !== "hidden") scheduleNextPoll(0);
    renderAll();
  }

  function destroy() {
    // Set the kill flag first so any in-flight runPoll.finally skips
    // its scheduleNextPoll. stopPolling clears timers + aborts fetches.
    destroyed = true;
    display = "hidden";
    stopPolling();
    root.innerHTML = "";
    root.classList.remove("compute-dash");
    delete root.dataset.mode;
    listeners.clear();
  }

  const listeners = new Set();
  function on(cb) { listeners.add(cb); return () => listeners.delete(cb); }
  function emit(type, detail) { for (const cb of listeners) try { cb(type, detail); } catch {} }

  // --- polling ---
  function scheduleNextPoll(delayMs) {
    if (destroyed || display === "hidden") return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(runPoll, delayMs);
  }
  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (abortController) { try { abortController.abort(); } catch {} abortController = null; }
  }
  async function runPoll() {
    pollTimer = null;
    if (destroyed || display === "hidden" || !origin) return;
    if (!bundleRef && !matchId) {
      scheduleNextPoll(POLL_INTERVAL_MS);
      return;
    }
    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;
    const fetchJson = async (path) => {
      const res = await fetch(origin + path, { cache: "no-store", signal });
      if (!res.ok) throw new Error(`${path} ${res.status}`);
      return res.json();
    };
    try {
      if (!bundleRef && matchId) await discoverBundleForMatch(fetchJson);
      const [aggJson, quorumJson] = await Promise.all([
        bundleRef ? fetchJson(`/compute/public/bundles/${encodeURIComponent(bundleRef.bundleId)}`).catch((e) => ({ error: e.message })) : Promise.resolve(null),
        matchId ? fetchJson(`/compute/public/matches/${encodeURIComponent(matchId)}/witness-quorum`).catch((e) => ({ error: e.message })) : Promise.resolve(null),
      ]);
      if (aggJson && !aggJson.error) {
        const next = aggJson;
        synthesizeFeedFromDiff(next);
        aggregate = next;
        if (next.bundle?.status === "sealed") sealed = true;
      }
      if (quorumJson && !quorumJson.error) {
        quorum = quorumJson;
      }
      renderAll();
    } catch (e) {
      if (e?.name !== "AbortError") {
        // Don't spam the UI with transient network errors; just keep showing last good data.
      }
    } finally {
      if (!destroyed && display !== "hidden") {
        const interval = sealed ? POLL_INTERVAL_AFTER_SEAL_MS : POLL_INTERVAL_MS;
        scheduleNextPoll(interval);
      }
    }
  }

  function synthesizeFeedFromDiff(next) {
    if (!next?.chunkStatus) return;
    for (const { chunkId, accepted, rejected, pending } of next.chunkStatus) {
      const prev = lastAcceptedCounts.get(chunkId) ?? 0;
      if (accepted > prev) {
        const delta = accepted - prev;
        for (let i = 0; i < delta; i++) {
          pushFeed({
            t: Date.now(),
            kind: "accepted",
            text: `${chunkLabel(chunkId)} accepted`,
            emphasis: false,
          });
        }
      }
      lastAcceptedCounts.set(chunkId, accepted);
    }
  }

  function pushFeed(entry) {
    feed.unshift(entry);
    if (feed.length > FEED_LIMIT) feed.length = FEED_LIMIT;
  }

  async function discoverBundleForMatch(fetchJson) {
    const json = await fetchJson("/compute/public/bundles?limit=25").catch(() => null);
    const bundles = Array.isArray(json?.bundles) ? json.bundles : [];
    const matches = bundles.filter((bundle) => bundle?.matchId === matchId);
    const science = matches.find((bundle) => bundle.kernelId === "science.contact_map_tile.v0") ?? matches[0];
    if (!science?.bundleId) return;
    bundleRef = normalizeBundleRef(science);
    if (bundleRef) pushBundleStartFeed(bundleRef, "recovered");
  }

  function normalizeBundleRef(bundle) {
    if (!bundle?.bundleId) return null;
    return {
      bundleId: bundle.bundleId,
      kernelId: bundle.kernelId ?? "unknown",
      chunkCount: bundle.chunkCount ?? bundle.targetChunkCount ?? bundle.chunkIds?.length ?? 0,
      presetId: bundle.presetId,
      sponsors: Array.isArray(bundle.sponsors) ? bundle.sponsors : [],
    };
  }

  function pushBundleStartFeed(ref, source = "opened") {
    pushFeed({
      t: Date.now(),
      kind: "bundle-start",
      text: `bundle ${ref.bundleId.slice(0, 14)} ${source} · ${ref.kernelId} · ${ref.chunkCount} chunks`,
      emphasis: true,
    });
  }

  // --- rendering ---
  function renderAll() {
    if (display === "hidden") {
      root.innerHTML = "";
      return;
    }
    root.innerHTML = display === "full" ? fullLayoutHtml() : pipLayoutHtml();
  }

  function fullLayoutHtml() {
    return `
      <div class="compute-dash-frame compute-dash-full">
        <div class="compute-dash-mosaic-col">${mosaicHtml({ compact: false })}</div>
        <div class="compute-dash-status-col">
          ${statusBlockHtml()}
          ${witnessBlockHtml()}
          ${certificateHtml()}
        </div>
        <div class="compute-dash-feed-col">
          ${feedHtml({ compact: false })}
        </div>
      </div>`;
  }

  function pipLayoutHtml() {
    return `
      <div class="compute-dash-frame compute-dash-pip" title="click to expand" data-action="expand">
        <div class="compute-dash-pip-top">${pipStatusLine()}</div>
        <div class="compute-dash-pip-body">
          <div class="compute-dash-pip-mosaic">${mosaicHtml({ compact: true })}</div>
          <div class="compute-dash-pip-side">${pipSideHtml()}</div>
        </div>
      </div>`;
  }

  function statusBlockHtml() {
    if (!bundleRef) {
      return `<div class="compute-dash-block"><div class="compute-dash-title">No bundle anchored</div><div class="tight">Waiting for matchStart with a compute bundle.</div></div>`;
    }
    const counts = aggregateCounts();
    const statusLabel = sealed ? "sealed" : (aggregate?.bundle?.status ?? "running");
    const quorumPolicy = aggregate?.bundle?.quorum ?? { minExecutions: "?", minAgreeing: "?" };
    return `
      <div class="compute-dash-block">
        <div class="compute-dash-title">Bundle</div>
        <dl class="compute-dash-kv">
          <dt>kernel</dt><dd><code>${escapeHtml(bundleRef.kernelId)}</code></dd>
          <dt>preset</dt><dd>${escapeHtml(bundleRef.presetId ?? "—")}</dd>
          <dt>chunks</dt><dd>${counts.accepted} / ${bundleRef.chunkCount} accepted · ${counts.pending} pending · ${counts.rejected} rejected</dd>
          <dt>quorum</dt><dd>${quorumPolicy.minAgreeing}-of-${quorumPolicy.minExecutions}</dd>
          <dt>state</dt><dd>${escapeHtml(statusLabel)}</dd>
          ${bundleRef.sponsors?.length ? `<dt>sponsors</dt><dd>${bundleRef.sponsors.map((h) => `@${escapeHtml(h)}`).join(" · ")}</dd>` : ""}
        </dl>
        ${progressBarHtml(counts.accepted, bundleRef.chunkCount)}
      </div>`;
  }

  function witnessBlockHtml() {
    if (!quorum || !quorum.ticks?.length) {
      return `<div class="compute-dash-block"><div class="compute-dash-title">Witness quorum</div><div class="tight">No checkpoints yet.</div></div>`;
    }
    const latest = quorum.ticks[quorum.ticks.length - 1];
    const rows = quorum.ticks.slice(-6).map((t) => {
      const winnerCount = t.winner?.count ?? 0;
      const dissent = t.totalAgreements - winnerCount;
      const mark = dissent === 0 ? "✓" : dissent === 1 ? "!" : "✗";
      const cls = dissent === 0 ? "ok" : dissent === 1 ? "warn" : "err";
      return `<tr class="${cls}"><td>${t.tick}</td><td>${mark}</td><td>${winnerCount}/${t.totalAgreements}</td></tr>`;
    }).join("");
    return `
      <div class="compute-dash-block">
        <div class="compute-dash-title">Witness quorum · ${quorum.totalSubmitters} spectators</div>
        <table class="compute-dash-quorum">
          <thead><tr><th>tick</th><th></th><th>agree</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="tight">latest tick ${latest.tick}: ${latest.winner?.count ?? 0} of ${latest.totalAgreements} agree</div>
      </div>`;
  }

  function certificateHtml() {
    if (!certificate) return "";
    const rootHash = certificate.bundleRoot;
    const rootStr = rootHash ? `${rootHash.algorithm}:${rootHash.value.slice(0, 16)}…` : "—";
    const verifierPath = `${origin}/compute/public/bundles/${encodeURIComponent(certificate.bundleId)}/verifier-bundle`;
    return `
      <div class="compute-dash-block compute-dash-certificate">
        <div class="compute-dash-title">Certificate</div>
        ${certificate.winnerHandle ? `<div>winner <strong>@${escapeHtml(certificate.winnerHandle)}</strong></div>` : ""}
        <div>bundle root <code>${escapeHtml(rootStr)}</code></div>
        ${certificate.proofBundleId ? `<div>proof <code>${escapeHtml(certificate.proofBundleId.slice(0, 14))}</code></div>` : ""}
        <a class="compute-dash-verifier-link" href="${escapeHtml(verifierPath)}" download="bundle-${escapeHtml(certificate.bundleId)}.json">⇣ download verifier bundle</a>
      </div>`;
  }

  function feedHtml({ compact }) {
    if (!feed.length) {
      return `<div class="compute-dash-block"><div class="compute-dash-title">Receipts</div><div class="tight">No receipts yet.</div></div>`;
    }
    const shown = compact ? feed.slice(0, 5) : feed.slice(0, 20);
    const rows = shown.map((e) => `<li class="compute-dash-feed-item ${e.emphasis ? "emph" : ""}"><code>${formatClock(e.t)}</code> ${escapeHtml(e.text)}</li>`).join("");
    return `
      <div class="compute-dash-block">
        <div class="compute-dash-title">Receipts</div>
        <ul class="compute-dash-feed">${rows}</ul>
      </div>`;
  }

  function mosaicHtml({ compact }) {
    if (!bundleRef || !aggregate) {
      const sizeClass = compact ? "compute-dash-mosaic-compact" : "";
      return `<div class="compute-dash-mosaic ${sizeClass}"><div class="compute-dash-mosaic-empty">Waiting for chunks…</div></div>`;
    }
    const chunkStatus = aggregate.chunkStatus ?? [];
    const sizeClass = compact ? "compute-dash-mosaic-compact" : "";
    const grid = inferMosaicGrid(chunkStatus);
    const cells = chunkStatus.map((cs, idx) => {
      const state = cs.accepted > 0 ? "accepted" : cs.rejected > 0 ? "rejected" : cs.pending > 0 ? "pending" : "idle";
      const placement = grid.placement[idx]
        ? `style="grid-column: ${grid.placement[idx].col + 1}; grid-row: ${grid.placement[idx].row + 1};"`
        : "";
      // When the chunk has an accepted preview PNG, render it inline.
      // preview.bytesBase64 is advisory — see validateReceiptPreview on
      // the server; bytes only stored if they hash-checked at admission.
      if (cs.preview?.bytesBase64) {
        return `<div class="compute-dash-cell compute-dash-cell-accepted compute-dash-cell-preview" ${placement} title="${escapeHtml(chunkLabel(cs.chunkId))}">
          <img src="data:image/png;base64,${escapeHtml(cs.preview.bytesBase64)}" alt="tile" loading="lazy" />
        </div>`;
      }
      return `<div class="compute-dash-cell compute-dash-cell-${state}" ${placement} data-idx="${idx}" title="${escapeHtml(chunkLabel(cs.chunkId))} · ${cs.accepted} accepted"></div>`;
    }).join("");
    return `<div class="compute-dash-mosaic ${sizeClass}" style="--grid-cols: ${grid.cols}; --grid-rows: ${grid.rows};">${cells}</div>`;
  }

  // Figure out the mosaic grid. When chunks carry row/col positions
  // (contact-map tiles do), lay them out spatially. Otherwise fall back
  // to a near-square grid in chunk order.
  function inferMosaicGrid(chunkStatus) {
    const withPosition = chunkStatus.filter((cs) => cs.position && typeof cs.position.rowStart === "number" && typeof cs.position.colStart === "number");
    if (withPosition.length === chunkStatus.length && chunkStatus.length > 0) {
      // Rank the distinct rowStart and colStart values to form a dense grid.
      const rowStarts = Array.from(new Set(withPosition.map((cs) => cs.position.rowStart))).sort((a, b) => a - b);
      const colStarts = Array.from(new Set(withPosition.map((cs) => cs.position.colStart))).sort((a, b) => a - b);
      const placement = chunkStatus.map((cs) => ({
        row: rowStarts.indexOf(cs.position.rowStart),
        col: colStarts.indexOf(cs.position.colStart),
      }));
      return { rows: rowStarts.length, cols: colStarts.length, placement };
    }
    const side = Math.max(1, Math.ceil(Math.sqrt(chunkStatus.length)));
    const placement = chunkStatus.map((_, idx) => ({ row: Math.floor(idx / side), col: idx % side }));
    return { rows: side, cols: side, placement };
  }

  function progressBarHtml(done, total) {
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    return `
      <div class="compute-dash-progress" aria-label="bundle progress" role="progressbar"
        aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
        <div class="compute-dash-progress-fill" style="width: ${pct}%;"></div>
        <div class="compute-dash-progress-label">${pct}%</div>
      </div>`;
  }

  function pipStatusLine() {
    if (!bundleRef) return `<span class="tight">no bundle</span>`;
    const counts = aggregateCounts();
    const total = bundleRef.chunkCount;
    const quorumInfo = quorum?.ticks?.at(-1);
    const qText = quorumInfo ? `${quorumInfo.winner?.count ?? 0}/${quorumInfo.totalAgreements} ✓` : "—";
    const workers = aggregate?.bundle ? `${(aggregate.acceptedReceiptCount ?? 0) + (aggregate.pendingReceiptCount ?? 0)} receipts` : "— workers";
    return `bundle ${counts.accepted}/${total} · witness ${qText} · ${workers}`;
  }

  function pipSideHtml() {
    const latest = feed[0];
    const preset = bundleRef?.presetId ?? "—";
    const deadline = aggregate?.bundle?.deadlineAt ? formatRelative(aggregate.bundle.deadlineAt) : null;
    return `
      <div class="compute-dash-pip-event">
        ${latest ? escapeHtml(latest.text) : "waiting for activity…"}
      </div>
      <div class="tight compute-dash-pip-meta">
        preset ${escapeHtml(preset)}${deadline ? ` · ${escapeHtml(deadline)}` : ""}
      </div>`;
  }

  function aggregateCounts() {
    if (!aggregate) return { accepted: 0, pending: 0, rejected: 0 };
    let accepted = 0; let pending = 0; let rejected = 0;
    for (const cs of aggregate.chunkStatus ?? []) {
      if (cs.accepted > 0) accepted++;
      else if (cs.pending > 0) pending++;
      else if (cs.rejected > 0) rejected++;
    }
    return { accepted, pending, rejected };
  }

  function chunkLabel(chunkId) {
    if (!chunkId) return "?";
    return chunkId.split("-").slice(-1)[0] || chunkId.slice(-8);
  }
  function shortHash(hash) {
    if (!hash?.value) return "—";
    return `${hash.algorithm}:${hash.value.slice(0, 10)}…`;
  }
  function formatClock(ms) {
    const d = new Date(ms);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
  }
  function formatRelative(ms) {
    const delta = ms - Date.now();
    if (delta <= 0) return "deadline passed";
    const s = Math.round(delta / 1000);
    if (s < 60) return `${s}s left`;
    return `${Math.round(s / 60)}m left`;
  }

  // Click-to-expand on the PIP. The parent mode decides what "expand" means.
  root.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest("[data-action='expand']") : null;
    if (target) emit("expand-request", {});
  });

  renderAll();

  return {
    setDisplay,
    getDisplay: () => display,
    onMatchStart,
    onMatchEnd,
    destroy,
    on,
  };
}
