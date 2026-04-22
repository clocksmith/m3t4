// Intro mode — auto-scrolling CRT crawl. Late-80s/early-90s terminal
// aesthetic: amber-green phosphor, mono, scanlines, type-on reveal,
// enter-on-click. Renders content/game-copy.v1.json in a fixed
// sequence (approved in PR: tagline → prologue[0..4] → stinger).

import gameCopy from "../content/game-copy.v1.json" with { type: "json" };

const REVEAL_SPEED_MULTIPLIER = 1.5;
const REVEAL_SLOWDOWN_MULTIPLIER = 1.2;
const TICK_MS_FAST = Math.round((22 / REVEAL_SPEED_MULTIPLIER) * REVEAL_SLOWDOWN_MULTIPLIER); // headers, tagline, tail, stinger
const TICK_MS_SLOW = Math.round((38 / REVEAL_SPEED_MULTIPLIER) * REVEAL_SLOWDOWN_MULTIPLIER); // prologue paragraphs
const CHARS_PER_TICK_FAST = 2;
const CHARS_PER_TICK_SLOW = 1;
const PAUSE_BETWEEN_BLOCKS_MS = Math.round(1300 / REVEAL_SPEED_MULTIPLIER);
const PAUSE_AFTER_STINGER_MS = Math.round(1700 / REVEAL_SPEED_MULTIPLIER);
const PAUSE_BETWEEN_STINGER_LINES_MS = Math.round(420 / REVEAL_SPEED_MULTIPLIER);
const THINKING_PAUSE_MS = 2000;
const THINKING_DOT_MS = 240;
const THINKING_STATES = ["Thinking.", "Thinking..", "Thinking..."];

function blockCadence(kind) {
  if (kind === "paragraph") {
    return { tickMs: TICK_MS_SLOW, charsPerTick: CHARS_PER_TICK_SLOW };
  }
  return { tickMs: TICK_MS_FAST, charsPerTick: CHARS_PER_TICK_FAST };
}

function revealTextAtWordBoundary(text, targetPos) {
  if (targetPos >= text.length) return text;
  if (targetPos <= 0) return "";
  let end = Math.min(targetPos, text.length);
  while (end < text.length && !/\s/.test(text[end])) end++;
  return text.slice(0, end);
}

let root = null;
let rafHandle = 0;
let tickHandle = 0;
let running = false;
let eventController = null;

function buildSequence() {
  const intro = gameCopy.intro ?? {};
  const prologue = intro.prologue?.body ?? [];
  const tagline = String(intro.tagline ?? "").replace(/^Play SELF Play\.\s*/i, "");
  const blocks = [];
  blocks.push({ kind: "header", text: "// M3T4 TERMINAL · SESSION OPEN" });
  blocks.push({ kind: "header", text: `// Play SELF Play` });
  if (tagline) blocks.push({ kind: "tagline", text: tagline });
  for (const para of prologue) {
    blocks.push({ kind: "paragraph", text: para });
  }
  blocks.push({ kind: "stinger", lines: intro.stinger ?? [] });
  blocks.push({ kind: "tail", text: "// END OF TRANSMISSION" });
  return blocks;
}

export function mount(mountEl, { setStatus }) {
  root = mountEl;
  setStatus("start · signal received");
  root.innerHTML = `
    <div class="intro-crt" id="intro-crt">
      <div class="intro-scanlines"></div>
      <div class="intro-vignette"></div>
      <section class="intro-fork" aria-label="start">
        <div class="intro-fork-kicker">// START HERE</div>
        <h1>Your inputs end at policy</h1>
        <div class="intro-fork-lines">
          <a class="intro-line-cta is-blue" href="#build" data-intro-nav>tune a bot</a>
          <a class="intro-line-cta is-red" href="#spectate" data-intro-nav>watch it fail</a>
          <a class="intro-line-cta is-purple" href="#profile" data-intro-nav>make it public</a>
        </div>
      </section>
      <div class="intro-crawl" id="intro-crawl"></div>
      <div class="intro-hint" id="intro-hint">[ terminal continues below ]</div>
    </div>`;

  const crawlEl = root.querySelector("#intro-crawl");
  const hintEl = root.querySelector("#intro-hint");
  const crtEl = root.querySelector("#intro-crt");

  running = true;
  eventController?.abort();
  eventController = new AbortController();
  const sequence = buildSequence();
  let idx = 0;
  let charPos = 0;
  let currentEl = null;
  let lastTick = 0;
  let pausedUntil = 0;
  let thinkingEl = null;
  let thinkingStartedAt = 0;
  let thinkingUntil = 0;
  let finished = false;
  let autoFollowCrawl = true;

  function nextBlock() {
    if (idx >= sequence.length) { finish(); return; }
    const block = sequence[idx];
    currentEl = document.createElement("div");
    currentEl.className = `intro-block intro-${block.kind}`;
    if (block.kind === "stinger") {
      currentEl.dataset.lines = JSON.stringify(block.lines);
      currentEl.dataset.lineIdx = "0";
      const first = document.createElement("div");
      first.className = "intro-stinger-line";
      currentEl.appendChild(first);
    }
    crawlEl.appendChild(currentEl);
    charPos = 0;
  }

  function finish() {
    if (finished) return;
    finished = true;
    hintEl.textContent = "[ click / space / enter to watch live ]";
    hintEl.classList.add("is-final");
  }

  function shouldThinkBeforeNextParagraph(completedBlock) {
    return completedBlock.kind === "paragraph" && sequence[idx]?.kind === "paragraph";
  }

  function renderThinking(now) {
    if (!thinkingEl) return;
    const stateIdx = Math.floor((now - thinkingStartedAt) / THINKING_DOT_MS) % THINKING_STATES.length;
    thinkingEl.textContent = THINKING_STATES[stateIdx];
  }

  function startThinkingPause(now) {
    thinkingEl = document.createElement("div");
    thinkingEl.className = "intro-thinking";
    crawlEl.appendChild(thinkingEl);
    thinkingStartedAt = now;
    thinkingUntil = now + THINKING_PAUSE_MS;
    renderThinking(now);
    followCrawl();
  }

  function clearThinking() {
    thinkingEl?.remove();
    thinkingEl = null;
    thinkingStartedAt = 0;
    thinkingUntil = 0;
  }

  function enter() {
    location.hash = "#spectate";
  }

  function syncCrtHeight() {
    const viewportH = window.visualViewport?.height ?? window.innerHeight;
    const top = crtEl.getBoundingClientRect().top;
    const bottomGap = 16;
    crtEl.style.height = `${Math.max(280, viewportH - top - bottomGap)}px`;
  }

  function isNearCrawlBottom() {
    return crawlEl.scrollHeight - crawlEl.scrollTop - crawlEl.clientHeight < 36;
  }

  function followCrawl() {
    if (autoFollowCrawl) {
      crawlEl.scrollTop = crawlEl.scrollHeight;
    }
  }

  function onKey(e) {
    if (!running) return;
    if (e.code === "Space" || e.code === "Enter") {
      e.preventDefault();
      if (finished) enter();
    }
  }

  function tick(now) {
    if (!running) return;
    if (thinkingEl) {
      renderThinking(now);
      followCrawl();
      if (now < thinkingUntil) {
        rafHandle = requestAnimationFrame(tick);
        return;
      }
      clearThinking();
      lastTick = now;
      rafHandle = requestAnimationFrame(tick);
      return;
    }
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
      activeEl.textContent = revealTextAtWordBoundary(line, charPos);
      if (charPos >= line.length) {
        activeEl.textContent = line;
        if (lineIdx + 1 < lines.length) {
          currentEl.dataset.lineIdx = String(lineIdx + 1);
          const next = document.createElement("div");
          next.className = "intro-stinger-line";
          currentEl.appendChild(next);
          charPos = 0;
          pausedUntil = now + PAUSE_BETWEEN_STINGER_LINES_MS;
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
      currentEl.textContent = revealTextAtWordBoundary(text, charPos);
      if (charPos >= text.length) {
        currentEl.textContent = text;
        idx++;
        currentEl = null;
        charPos = 0;
        if (shouldThinkBeforeNextParagraph(block)) {
          startThinkingPause(now);
        } else {
          pausedUntil = now + PAUSE_BETWEEN_BLOCKS_MS;
        }
      }
    }

    followCrawl();
    rafHandle = requestAnimationFrame(tick);
  }

  syncCrtHeight();
  window.addEventListener("resize", syncCrtHeight, { signal: eventController.signal });
  window.visualViewport?.addEventListener("resize", syncCrtHeight, { signal: eventController.signal });
  crawlEl.addEventListener("scroll", () => {
    autoFollowCrawl = isNearCrawlBottom();
  }, { signal: eventController.signal });
  hintEl.addEventListener("click", () => {
    if (finished) enter();
  }, { signal: eventController.signal });
  root.querySelectorAll("[data-intro-nav]").forEach((link) => {
    link.addEventListener("click", (e) => e.stopPropagation(), { signal: eventController.signal });
  });
  document.addEventListener("keydown", onKey, { signal: eventController.signal });

  rafHandle = requestAnimationFrame(tick);

  // Remember viewer saw it — app.js can respect this for first-visit redirects.
  try { localStorage.setItem("m3t4:introSeen", "1"); } catch {}
}

export function unmount() {
  running = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  if (tickHandle) clearTimeout(tickHandle);
  eventController?.abort();
  eventController = null;
  root = null;
}
