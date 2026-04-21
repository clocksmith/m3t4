// Lore mode — auto-scrolling CRT crawl. Late-80s/early-90s terminal
// aesthetic: amber-green phosphor, mono, scanlines, type-on reveal,
// skip-on-click. Renders content/game-copy.v1.json in a fixed
// sequence (approved in PR: tagline → prologue[0..4] → stinger).

import gameCopy from "../content/game-copy.v1.json" with { type: "json" };

const TICK_MS_FAST = 22;        // headers, tagline, tail, stinger
const TICK_MS_SLOW = 38;        // prologue paragraphs
const CHARS_PER_TICK_FAST = 2;
const CHARS_PER_TICK_SLOW = 1;
const PAUSE_BETWEEN_BLOCKS_MS = 1300;
const PAUSE_AFTER_STINGER_MS = 1700;

function blockCadence(kind) {
  if (kind === "paragraph") {
    return { tickMs: TICK_MS_SLOW, charsPerTick: CHARS_PER_TICK_SLOW };
  }
  return { tickMs: TICK_MS_FAST, charsPerTick: CHARS_PER_TICK_FAST };
}

let root = null;
let rafHandle = 0;
let tickHandle = 0;
let running = false;

function buildSequence() {
  const { lore } = gameCopy;
  const blocks = [];
  blocks.push({ kind: "header", text: "// M3T4 TERMINAL · SESSION OPEN" });
  blocks.push({ kind: "header", text: `// EPOCH 2038 · LEDGER AWAITING RECONCILIATION` });
  blocks.push({ kind: "tagline", text: lore.tagline });
  for (const para of lore.prologue.body) {
    blocks.push({ kind: "paragraph", text: para });
  }
  blocks.push({ kind: "stinger", lines: lore.stinger });
  blocks.push({ kind: "tail", text: "// END OF TRANSMISSION" });
  return blocks;
}

export function mount(mountEl, { setStatus }) {
  root = mountEl;
  setStatus("lore · signal received");
  root.innerHTML = `
    <div class="lore-crt" id="lore-crt">
      <div class="lore-scanlines"></div>
      <div class="lore-vignette"></div>
      <div class="lore-crawl" id="lore-crawl"></div>
      <div class="lore-hint" id="lore-hint">[ click / tap / any key to skip ]</div>
    </div>`;

  const crawlEl = root.querySelector("#lore-crawl");
  const hintEl = root.querySelector("#lore-hint");
  const crtEl = root.querySelector("#lore-crt");

  running = true;
  const sequence = buildSequence();
  let idx = 0;
  let charPos = 0;
  let currentEl = null;
  let lastTick = 0;
  let pausedUntil = 0;
  let finished = false;

  function nextBlock() {
    if (idx >= sequence.length) { finish(); return; }
    const block = sequence[idx];
    currentEl = document.createElement("div");
    currentEl.className = `lore-block lore-${block.kind}`;
    if (block.kind === "stinger") {
      currentEl.dataset.lines = JSON.stringify(block.lines);
      currentEl.dataset.lineIdx = "0";
      const first = document.createElement("div");
      first.className = "lore-stinger-line";
      currentEl.appendChild(first);
    }
    crawlEl.appendChild(currentEl);
    charPos = 0;
  }

  function finish() {
    if (finished) return;
    finished = true;
    hintEl.textContent = "[ click to enter ]";
    hintEl.classList.add("is-final");
    crtEl.addEventListener("click", enter, { once: true });
    document.addEventListener("keydown", onKey, { once: true });
  }

  function enter() {
    location.hash = "#spectate";
  }

  function onKey(e) {
    if (!running) return;
    if (finished) { enter(); return; }
    skipAll();
  }

  function skipAll() {
    while (idx < sequence.length) renderBlockInstant(sequence[idx++]);
    currentEl = null;
    charPos = 0;
    finish();
  }

  function renderBlockInstant(block) {
    const el = document.createElement("div");
    el.className = `lore-block lore-${block.kind}`;
    if (block.kind === "stinger") {
      for (const line of block.lines) {
        const ln = document.createElement("div");
        ln.className = "lore-stinger-line";
        ln.textContent = line;
        el.appendChild(ln);
      }
    } else {
      el.textContent = block.text;
    }
    crawlEl.appendChild(el);
    crawlEl.scrollTop = crawlEl.scrollHeight;
  }

  function tick(now) {
    if (!running) return;
    if (now < pausedUntil) { rafHandle = requestAnimationFrame(tick); return; }
    if (!currentEl) { nextBlock(); }
    if (finished) return;
    const block = sequence[idx];
    const cadence = blockCadence(block.kind);
    if (now - lastTick < cadence.tickMs) { rafHandle = requestAnimationFrame(tick); return; }
    lastTick = now;

    if (block.kind === "stinger") {
      const lines = JSON.parse(currentEl.dataset.lines);
      let lineIdx = parseInt(currentEl.dataset.lineIdx, 10);
      const line = lines[lineIdx];
      const activeEl = currentEl.children[lineIdx];
      charPos += cadence.charsPerTick;
      activeEl.textContent = line.slice(0, charPos);
      if (charPos >= line.length) {
        if (lineIdx + 1 < lines.length) {
          currentEl.dataset.lineIdx = String(lineIdx + 1);
          const next = document.createElement("div");
          next.className = "lore-stinger-line";
          currentEl.appendChild(next);
          charPos = 0;
          pausedUntil = now + 420;
        } else {
          idx++;
          currentEl = null;
          charPos = 0;
          pausedUntil = now + PAUSE_AFTER_STINGER_MS;
        }
      }
    } else {
      const text = block.text;
      charPos += cadence.charsPerTick;
      currentEl.textContent = text.slice(0, charPos);
      if (charPos >= text.length) {
        idx++;
        currentEl = null;
        charPos = 0;
        pausedUntil = now + PAUSE_BETWEEN_BLOCKS_MS;
      }
    }

    crawlEl.scrollTop = crawlEl.scrollHeight;
    rafHandle = requestAnimationFrame(tick);
  }

  crtEl.addEventListener("click", () => { if (!finished) skipAll(); });
  document.addEventListener("keydown", onKey);

  rafHandle = requestAnimationFrame(tick);

  // Remember viewer saw it — app.js can respect this for first-visit redirects.
  try { localStorage.setItem("m3t4:loreSeen", "1"); } catch {}
}

export function unmount() {
  running = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  if (tickHandle) clearTimeout(tickHandle);
  root = null;
}
