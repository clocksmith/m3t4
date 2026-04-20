// Candidate generators: random, mutate, crossover — now with DSL-aware
// operators that can promote scalars into trajectories and add triggers.

import type { AttributeSpec, BrainConfig, ParamKey } from "@m3t4/sim";
import { DEFAULT_PARAMS, PARAM_KEYS, RANGES } from "@m3t4/sim";

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

function quantize(v: number, step: number): number {
  return Math.round(v / step) * step;
}

export function randomScalar(k: ParamKey): number {
  const [lo, hi] = RANGES[k];
  return quantize(rand(lo, hi), (hi - lo) / 20);
}

// ---------- Random / mutate / crossover (scalar) ----------

export function randomConfig(id: string): BrainConfig {
  const attrs: Partial<Record<ParamKey, AttributeSpec>> = {};
  for (const k of PARAM_KEYS) attrs[k] = randomScalar(k);
  return { id, attributes: attrs };
}

function getScalar(cfg: BrainConfig, k: ParamKey): number {
  const v = cfg.attributes[k];
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "base" in v && typeof v.base === "number") return v.base;
  return DEFAULT_PARAMS[k];
}

export function mutateConfig(src: BrainConfig, id: string, rate = 0.4, amount = 0.25): BrainConfig {
  const attrs: Partial<Record<ParamKey, AttributeSpec>> = {};
  for (const k of PARAM_KEYS) {
    const cur = getScalar(src, k);
    const [lo, hi] = RANGES[k];
    if (Math.random() < rate) {
      const span = (hi - lo) * amount;
      const v = cur + (Math.random() * 2 - 1) * span;
      attrs[k] = Math.max(lo, Math.min(hi, v));
    } else {
      // Preserve original spec (could be a trajectory)
      attrs[k] = src.attributes[k] ?? cur;
    }
  }
  return { id, attributes: attrs };
}

export function crossoverConfig(a: BrainConfig, b: BrainConfig, id: string): BrainConfig {
  const attrs: Partial<Record<ParamKey, AttributeSpec>> = {};
  for (const k of PARAM_KEYS) {
    attrs[k] = Math.random() < 0.5 ? a.attributes[k] ?? getScalar(a, k) : b.attributes[k] ?? getScalar(b, k);
  }
  return { id, attributes: attrs };
}

// ---------- DSL-aware mutators ----------
//
// These randomly promote a scalar attribute into a trajectory representation
// (ramp / oscillate / triggers) or a short DSL expression. This expands the
// search space into the NP-hard territory: time-varying & conditional.

const TRIGGER_CONDS = [
  "self.hp < 30",
  "self.hp < 50",
  "opp.hp < 30",
  "self.hasToken",
  "opp.hasToken",
  "game.goalExists",
  "game.absDx < 100",
  "game.absDx > 200",
  "self.onGround",
  "opp.swipeT > 0",
] as const;

const EXPRESSION_TEMPLATES: Array<(k: ParamKey) => string> = [
  (k) => {
    const [lo, hi] = RANGES[k];
    const a = quantize(rand(lo, hi), (hi - lo) / 10);
    const b = quantize(rand(lo, hi), (hi - lo) / 10);
    const span = 600 + Math.floor(Math.random() * 2400);
    return `${a} + ${(b - a).toFixed(3)} * clamp(tick / ${span}, 0, 1)`;
  },
  (k) => {
    const [lo, hi] = RANGES[k];
    const base = quantize((lo + hi) / 2 + rand(-1, 1) * (hi - lo) * 0.2, (hi - lo) / 10);
    const amp = (hi - lo) * (0.1 + Math.random() * 0.2);
    const rate = 0.005 + Math.random() * 0.02;
    return `${base.toFixed(3)} + ${amp.toFixed(3)} * sin(tick * ${rate.toFixed(4)})`;
  },
  (k) => {
    const [lo, hi] = RANGES[k];
    const a = quantize(rand(lo, hi), (hi - lo) / 10);
    const b = quantize(rand(lo, hi), (hi - lo) / 10);
    const cond = TRIGGER_CONDS[Math.floor(Math.random() * TRIGGER_CONDS.length)];
    return `${cond} ? ${a} : ${b}`;
  },
];

export function promoteToTrajectory(cfg: BrainConfig, id: string, rate = 0.3): BrainConfig {
  const attrs: Partial<Record<ParamKey, AttributeSpec>> = {};
  for (const k of PARAM_KEYS) {
    const cur = cfg.attributes[k] ?? getScalar(cfg, k);
    if (Math.random() < rate && typeof cur === "number") {
      attrs[k] = promoteOne(k, cur);
    } else {
      attrs[k] = cur;
    }
  }
  return { id, attributes: attrs };
}

function promoteOne(k: ParamKey, base: number): AttributeSpec {
  const form = Math.floor(Math.random() * 4);
  const [lo, hi] = RANGES[k];
  if (form === 0) {
    // ramp {base, ramp}
    const to = quantize(rand(lo, hi), (hi - lo) / 10);
    const overTicks = 600 + Math.floor(Math.random() * 2400);
    return { base, ramp: { to, overTicks } };
  }
  if (form === 1) {
    // oscillate {base, oscillate}
    const amp = (hi - lo) * (0.1 + Math.random() * 0.2);
    const period = 200 + Math.floor(Math.random() * 600);
    return { base, oscillate: { amp, period } };
  }
  if (form === 2) {
    // triggers
    const trigCount = 1 + Math.floor(Math.random() * 2);
    const triggers = [];
    for (let i = 0; i < trigCount; i++) {
      const when = TRIGGER_CONDS[Math.floor(Math.random() * TRIGGER_CONDS.length)];
      const value = quantize(rand(lo, hi), (hi - lo) / 10);
      triggers.push({ when, value });
    }
    return { base, triggers };
  }
  // inline DSL expression
  const tpl = EXPRESSION_TEMPLATES[Math.floor(Math.random() * EXPRESSION_TEMPLATES.length)];
  return tpl(k);
}

// Mutate an existing trajectory: tweak its numbers, add/remove triggers,
// or collapse back to a scalar. Keeps the population diverse.
export function mutateTrajectory(cfg: BrainConfig, id: string, rate = 0.3): BrainConfig {
  const attrs: Partial<Record<ParamKey, AttributeSpec>> = {};
  for (const k of PARAM_KEYS) {
    const cur = cfg.attributes[k] ?? getScalar(cfg, k);
    if (Math.random() >= rate) { attrs[k] = cur; continue; }
    if (typeof cur === "number") {
      attrs[k] = promoteOne(k, cur);
    } else if (typeof cur === "string") {
      // Keep it: DSL strings are opaque to us
      attrs[k] = cur;
    } else {
      attrs[k] = tweakStructured(k, cur);
    }
  }
  return { id, attributes: attrs };
}

function tweakStructured(k: ParamKey, spec: Extract<AttributeSpec, { base?: number }>): AttributeSpec {
  const [lo, hi] = RANGES[k];
  const cp: typeof spec = { ...spec };
  if (cp.base !== undefined) {
    const span = (hi - lo) * 0.2;
    cp.base = Math.max(lo, Math.min(hi, cp.base + (Math.random() * 2 - 1) * span));
  }
  if (cp.ramp) {
    cp.ramp = { ...cp.ramp };
    if (Math.random() < 0.5) cp.ramp.to = Math.max(lo, Math.min(hi, cp.ramp.to + (Math.random() * 2 - 1) * (hi - lo) * 0.2));
    if (Math.random() < 0.5) cp.ramp.overTicks = Math.max(120, cp.ramp.overTicks + (Math.random() * 2 - 1) * 600);
  }
  if (cp.oscillate) {
    cp.oscillate = { ...cp.oscillate };
    if (Math.random() < 0.5) cp.oscillate.amp = Math.max(0, cp.oscillate.amp + (Math.random() * 2 - 1) * (hi - lo) * 0.1);
    if (Math.random() < 0.5) cp.oscillate.period = Math.max(60, cp.oscillate.period + (Math.random() * 2 - 1) * 200);
  }
  if (cp.triggers && Math.random() < 0.4) {
    const t = [...cp.triggers];
    if (Math.random() < 0.3 && t.length > 0) t.pop();
    else if (Math.random() < 0.6) {
      t.push({
        when: TRIGGER_CONDS[Math.floor(Math.random() * TRIGGER_CONDS.length)],
        value: quantize(rand(lo, hi), (hi - lo) / 10),
      });
    }
    cp.triggers = t;
  }
  return cp;
}
