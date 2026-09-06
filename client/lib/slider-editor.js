import { KNOBS } from "./build-config.js";
import { escapeHtml } from "../ui/html.js";
import { disclosureHtml } from "../ui/shell.js";

export const PRIMARY_KNOBS = ["burnRate", "moat", "shipRate", "foresight"];

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
  const extraAttrs = Object.entries(options.dataAttrs || {})
    .map(([k, v]) => `data-${escapeHtml(k)}="${escapeHtml(v)}"`)
    .join(" ");
  const extra = extraAttrs ? ` ${extraAttrs}` : "";
  const primary = new Set(options.primaryKnobs ?? PRIMARY_KNOBS);
  const advancedOpen = container.querySelector(".knobs-advanced")?.open ?? false;
  const renderKnob = ([id, label, desc]) => {
    const value = knobValue(state, id);
    return `
      <label class="knob">
        <div>
          <span class="knob-name">${escapeHtml(label)}</span>
          <span class="knob-desc">${escapeHtml(desc)}</span>
        </div>
        <input type="range" min="0" max="100" step="1" value="${value}" data-knob="${escapeHtml(id)}"${extra} ${disabled ? "disabled" : ""}>
        <output class="knob-val" data-val="${escapeHtml(id)}"${extra}>${value}</output>
      </label>
    `;
  };
  const advanced = KNOBS.filter(([id]) => !primary.has(id));
  container.innerHTML = KNOBS.filter(([id]) => primary.has(id)).map(renderKnob).join("")
    + (advanced.length ? disclosureHtml({
      label: `Advanced · ${advanced.length} traits`, className: "knobs-advanced", open: advancedOpen,
      body: advanced.map(renderKnob).join(""),
    }) : "");

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
    if (options.onCommit) {
      input.addEventListener("change", () => options.onCommit(input.dataset.knob, state));
    }
  });
}
