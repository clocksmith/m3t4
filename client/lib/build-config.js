import {
  MAX_DERIVED_HALLUCINATION,
  MAX_USER_SPEND,
  RANGES,
  USER_BUDGET,
  computedHallucinationForSpend,
  nativeToUI,
  uiToNative,
  validateUserSubmission,
} from "./public-sim.js";

export const BUDGET = USER_BUDGET;
export const HARD_CAP = MAX_USER_SPEND;

export const KNOBS = [
  ["burnRate", "burn", "How aggressively the bot spends capacity.", 25],
  ["moat", "moat", "How much distance it tries to keep.", 25],
  ["shipRate", "ship", "How often it tries to carry proof home.", 35],
  ["foresight", "foresight", "How much future danger it anticipates.", 20],
  ["pivotSpeed", "pivot", "How quickly it changes plans.", 25],
  ["leverage", "leverage", "Willingness to take contested trades.", 50],
  ["networking", "networking", "How strongly it routes through the objective.", 15],
  ["spite", "spite", "Preference for denial over clean scoring.", 50],
  ["greed", "greed", "Preference for risky score attempts.", 20],
  ["pacing", "pacing", "How patiently it waits for openings.", 15],
  ["cunning", "cunning", "How much it values indirect routes.", 15],
  ["lift", "lift", "How much it favors vertical movement.", 20],
  ["parry", "parry", "How much it times defensive counters.", 10],
  ["chase", "chase", "How hard it follows exposed targets.", 15],
  ["discipline", "discipline", "How strongly it avoids noisy overcommit.", 20],
];

const KNOB_IDS = new Set(KNOBS.map(([id]) => id));

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function neutralBuildState() {
  const state = {};
  for (const [id, , , init] of KNOBS) state[id] = init;
  return state;
}

export function scaledStateFromValues(values, cap = BUDGET) {
  const rawValues = KNOBS.map(([id, , , init], index) => {
    const raw = Array.isArray(values) ? values[index] : values?.[id];
    return clamp(Math.round(finiteNumber(raw, init)), 0, 100);
  });
  const total = rawValues.reduce((sum, value) => sum + value, 0) || 1;
  const scale = Math.min(1, cap / total);
  const state = {};
  rawValues.forEach((value, index) => {
    state[KNOBS[index][0]] = clamp(Math.round(value * scale), 0, 100);
  });
  return state;
}

export function stateSpent(state) {
  return KNOBS.reduce((sum, [id]) => sum + clamp(Math.round(finiteNumber(state?.[id], 0)), 0, 100), 0);
}

export function remainingCeilingForState(state, id) {
  const current = clamp(Math.round(finiteNumber(state?.[id], 0)), 0, 100);
  const spentWithout = stateSpent(state) - current;
  return clamp(HARD_CAP - spentWithout, 0, 100);
}

// Build a BrainConfig from editor state.
// - opts.configVersion === 2 → emit UI-space (0..100) attributes + configVersion:2.
//   This is the user-facing form. Values read as they appear on the sliders.
// - default (omitted / 1) → emit native (pixels, seconds, signed -1..1).
//   Canonical internal/transport form; downstream sim consumers never need to
//   branch on version.
export function configFromState(state, opts = {}) {
  const asUI = opts.configVersion === 2;
  const attributes = {};
  for (const [id] of KNOBS) {
    const ui = clamp(Math.round(finiteNumber(state?.[id], 0)), 0, 100);
    attributes[id] = asUI ? ui : +uiToNative(id, ui).toFixed(4);
  }
  const halluNative = Math.min(
    MAX_DERIVED_HALLUCINATION,
    computedHallucinationForSpend(stateSpent(state)),
  );
  attributes.hallucination = asUI
    ? Math.round(nativeToUI("hallucination", halluNative))
    : halluNative;

  const config = { attributes };
  if (opts.id && String(opts.id).trim()) config.id = String(opts.id).trim();
  if (asUI) config.configVersion = 2;
  return config;
}

function looksLikeAttributeMap(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  let hits = 0;
  for (const key of Object.keys(obj)) {
    if (KNOB_IDS.has(key) || key === "hallucination") hits += 1;
  }
  return hits >= 3;
}

function coerceConfigObject(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config must be a JSON object");
  }
  const cfg = looksLikeAttributeMap(raw) ? { attributes: raw } : { ...raw };
  if (!cfg.attributes || typeof cfg.attributes !== "object" || Array.isArray(cfg.attributes)) {
    throw new Error("config must include an attributes object");
  }
  const id = typeof cfg.id === "string" && cfg.id.trim() ? cfg.id.trim() : undefined;
  const configVersion = cfg.configVersion === 2 ? 2 : 1;
  return { id, configVersion, attributes: { ...cfg.attributes } };
}

// Parse a BrainConfig into editor state (0..100 UI-space). Accepts either
// native (configVersion omitted / 1) or UI-space (configVersion: 2) input.
// Output is always UI-space state suitable for sliders.
export function stateFromConfig(raw) {
  const cfg = coerceConfigObject(raw);
  const state = {};
  for (const [id, , , init] of KNOBS) {
    if (cfg.configVersion === 2) {
      const ui = finiteNumber(cfg.attributes[id], init);
      state[id] = clamp(Math.round(ui), 0, 100);
    } else {
      const range = RANGES[id];
      const native = finiteNumber(cfg.attributes[id], uiToNative(id, init));
      const clampedNative = clamp(native, range[0], range[1]);
      state[id] = clamp(Math.round(nativeToUI(id, clampedNative)), 0, 100);
    }
  }
  return state;
}

// Normalize to canonical native-format BrainConfig suitable for transport
// and server-side consumers. Accepts either v1 or v2 input; output is
// always v1 (no configVersion field, attributes in native units).
export function normalizeBuildConfig(raw) {
  const cfg = coerceConfigObject(raw);
  for (const [id] of KNOBS) {
    const value = cfg.attributes[id];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${id} must be a finite numeric scalar`);
    }
  }
  const normalized = configFromState(stateFromConfig(cfg), { id: cfg.id });
  const validation = validateUserSubmission(normalized);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; ") || "config failed validation");
  }
  return validation.config;
}

export function sanitizeConfigPaste(text) {
  return String(text || "")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, "\"")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r/g, "")
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .replace(/\n[ \t]*/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim();
}

export function parseBuildConfigJson(text) {
  const clean = sanitizeConfigPaste(text);
  if (!clean) throw new Error("paste a complete JSON object");
  if (clean.includes("...")) {
    throw new Error("config JSON still contains a placeholder (...); paste the complete object");
  }
  try {
    return normalizeBuildConfig(JSON.parse(clean));
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`config JSON is invalid: ${e.message}`);
    throw e;
  }
}

export function formatConfigJson(raw) {
  return JSON.stringify(normalizeBuildConfig(raw), null, 2);
}

// User-facing JSON: values on 0..100 UI scale (match the sliders), plus
// `configVersion: 2` so the server/import path can convert back to native.
// Use this for Tune copy/send, Profile JSON tab, and any clipboard-facing
// surface. Internal transport should keep using formatConfigJson() /
// normalizeBuildConfig() which emit canonical native.
export function formatConfigJsonV2(raw) {
  const native = normalizeBuildConfig(raw);
  const state = stateFromConfig(native);
  const v2 = configFromState(state, { id: native.id, configVersion: 2 });
  return JSON.stringify(v2, null, 2);
}

export function dirtyCount(baseState, currentState) {
  let count = 0;
  for (const [id] of KNOBS) {
    const base = clamp(Math.round(finiteNumber(baseState?.[id], 0)), 0, 100);
    const current = clamp(Math.round(finiteNumber(currentState?.[id], 0)), 0, 100);
    if (base !== current) count += 1;
  }
  return count;
}
