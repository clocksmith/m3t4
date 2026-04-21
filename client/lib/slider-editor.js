import { KNOBS } from "./build-config.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function knobValue(state, id) {
  const n = Math.round(Number(state?.[id] ?? 0));
  return Number.isFinite(n) ? clamp(n, 0, 100) : 0;
}

export function paintSliderFills(container, state) {
  if (!container) return;
  container.querySelectorAll("input[type='range'][data-knob]").forEach((input) => {
    const id = input.dataset.knob;
    const value = knobValue(state, id);
    input.value = String(value);
    input.style.setProperty("--fill", `${value}%`);
    const output = container.querySelector(`[data-val="${id}"]`);
    if (output) output.textContent = String(value);
  });
}

export function renderSliderEditor(container, state, options = {}) {
  if (!container) return;
  const disabled = Boolean(options.disabled);
  container.innerHTML = KNOBS.map(([id, label, desc]) => {
    const value = knobValue(state, id);
    return `
      <label class="knob">
        <div>
          <span class="knob-name">${escapeHtml(label)}</span>
          <span class="knob-desc">${escapeHtml(desc)}</span>
        </div>
        <input type="range" min="0" max="100" step="1" value="${value}" data-knob="${escapeHtml(id)}" ${disabled ? "disabled" : ""}>
        <div class="knob-val" data-val="${escapeHtml(id)}">${value}</div>
      </label>
    `;
  }).join("");

  paintSliderFills(container, state);

  container.querySelectorAll("input[type='range'][data-knob]").forEach((input) => {
    input.addEventListener("input", () => {
      const id = input.dataset.knob;
      const max = options.remainingCeilingFor ? Number(options.remainingCeilingFor(id)) : 100;
      const next = clamp(Math.round(Number(input.value) || 0), 0, Number.isFinite(max) ? max : 100);
      state[id] = next;
      paintSliderFills(container, state);
      options.onChange?.(id, next, state);
    });
  });
}
