// Named strategy presets — v13 refined roster. Names are preserved from
// the prior roster; attributes come from legal-HOF selection with a
// ship-rate floor against the v13 behavior.

import type { BrainConfig } from "./types.js";

export const STRATEGY_NAMES = [
  "standby",
  "blitz",
  "intern",
  "pivot",
  "unicorn",
  "incumbent",
  "operator",
  "oracle",
  "shipper",
  "moonshot",
  "regulatory",
  "founder",
  "acolyte",
  "disruptor",
  "troll",
  "acquirer",
] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

export const STRATEGIES: Record<StrategyName, BrainConfig> = {
  // v13 refined source=g4-x11 spent=347
  standby: {
    id: "standby",
    attributes: {
      burnRate: 0.09, moat: 0, shipRate: 0.93, foresight: 0.155,
      pivotSpeed: 0.09, leverage: -0.92, networking: 0.17, spite: 0.8,
      greed: 0, pacing: 0, cunning: 0, lift: 0.05,
      parry: 0.22, chase: 0.14, discipline: 0.22, hallucination: 0,
    },
  },
  // v13 refined source=g1-m3 spent=294
  blitz: {
    id: "blitz",
    attributes: {
      burnRate: 0.04, moat: 51, shipRate: 0.59, foresight: 0.0525,
      pivotSpeed: 0.03, leverage: -0.88, networking: 0.13, spite: -0.5,
      greed: 0.15, pacing: 0.16, cunning: 0.07, lift: 0.01,
      parry: 0.17, chase: 0.03, discipline: 0.87, hallucination: 0,
    },
  },
  // v13 refined source=g11-axis_anchor-14 spent=282
  intern: {
    id: "intern",
    attributes: {
      burnRate: 0.26, moat: 3, shipRate: 0.45, foresight: 0.05,
      pivotSpeed: 0.01, leverage: -0.92, networking: 0.1, spite: -0.92,
      greed: 0.95, pacing: 0.03, cunning: 0.29, lift: 0.13,
      parry: 0.17, chase: 0.13, discipline: 0.01, hallucination: 0,
    },
  },
  // v13 refined source=g2-m20 spent=318
  pivot: {
    id: "pivot",
    attributes: {
      burnRate: 0, moat: 66, shipRate: 0.61, foresight: 0.07,
      pivotSpeed: 0.02, leverage: -0.84, networking: 0.16, spite: -0.8,
      greed: 0.04, pacing: 0.27, cunning: 0.09, lift: 0.06,
      parry: 0.08, chase: 0.17, discipline: 1, hallucination: 0,
    },
  },
  // v13 refined source=g11-x18 spent=324
  unicorn: {
    id: "unicorn",
    attributes: {
      burnRate: 0, moat: 27, shipRate: 0.81, foresight: 0,
      pivotSpeed: 0.43, leverage: -1, networking: 0.25, spite: 0.34,
      greed: 0, pacing: 0.06, cunning: 0, lift: 0,
      parry: 0, chase: 0.82, discipline: 0.11, hallucination: 0,
    },
  },
  // v13 refined source=g10-s31 spent=360
  incumbent: {
    id: "incumbent",
    attributes: {
      burnRate: 0.55, moat: 93, shipRate: 0.62, foresight: 0,
      pivotSpeed: 0, leverage: -1, networking: 0.48, spite: -0.5,
      greed: 0, pacing: 0, cunning: 0, lift: 0.7,
      parry: 0.69, chase: 0, discipline: 0, hallucination: 0,
    },
  },
  // v13 refined source=g10-m10 spent=278
  operator: {
    id: "operator",
    attributes: {
      burnRate: 0, moat: 27, shipRate: 0.81, foresight: 0,
      pivotSpeed: 0, leverage: -1, networking: 0, spite: -1,
      greed: 0, pacing: 0.01, cunning: 0, lift: 0.05,
      parry: 1, chase: 0.82, discipline: 0, hallucination: 0,
    },
  },
  // v13 refined source=g1-m14 spent=360
  oracle: {
    id: "oracle",
    attributes: {
      burnRate: 0, moat: 54, shipRate: 0.37, foresight: 0.1025,
      pivotSpeed: 0.32, leverage: -0.9, networking: 0, spite: -0.62,
      greed: 0.06, pacing: 0.17, cunning: 0.49, lift: 0.92,
      parry: 0.07, chase: 0.22, discipline: 0.15, hallucination: 0,
    },
  },
  // v13 refined source=g8-dirichlet_balanced-8 spent=360
  shipper: {
    id: "shipper",
    attributes: {
      burnRate: 0.55, moat: 93, shipRate: 0.62, foresight: 0,
      pivotSpeed: 0, leverage: -1, networking: 0.48, spite: -0.5,
      greed: 0, pacing: 0, cunning: 0, lift: 0.7,
      parry: 0.69, chase: 0, discipline: 0, hallucination: 0,
    },
  },
  // v13 refined source=g6-x12 spent=279
  moonshot: {
    id: "moonshot",
    attributes: {
      burnRate: 0, moat: 0, shipRate: 0.46, foresight: 0,
      pivotSpeed: 0.98, leverage: -1, networking: 0.07, spite: 0.72,
      greed: 0, pacing: 0, cunning: 0.03, lift: 0.22,
      parry: 0.17, chase: 0, discipline: 0, hallucination: 0,
    },
  },
  // v13 refined source=g1-m22 spent=327
  regulatory: {
    id: "regulatory",
    attributes: {
      burnRate: 0.13, moat: 66, shipRate: 0.93, foresight: 0.0675,
      pivotSpeed: 0.07, leverage: -0.92, networking: 0.07, spite: -0.52,
      greed: 0.51, pacing: 0.15, cunning: 0, lift: 0.09,
      parry: 0.26, chase: 0.26, discipline: 0.03, hallucination: 0,
    },
  },
  // v13 refined source=g10-m8 spent=278
  founder: {
    id: "founder",
    attributes: {
      burnRate: 0, moat: 0, shipRate: 0.81, foresight: 0.0225,
      pivotSpeed: 0, leverage: -1, networking: 0, spite: -1,
      greed: 0, pacing: 0.06, cunning: 0, lift: 0,
      parry: 1, chase: 0.82, discipline: 0, hallucination: 0,
    },
  },
  // v13 refined source=g11-x24 spent=339
  acolyte: {
    id: "acolyte",
    attributes: {
      burnRate: 0.55, moat: 93, shipRate: 0.62, foresight: 0.0225,
      pivotSpeed: 0, leverage: -1, networking: 0, spite: -0.5,
      greed: 0, pacing: 0.06, cunning: 0, lift: 0,
      parry: 0.69, chase: 0.82, discipline: 0, hallucination: 0,
    },
  },
  // v13 refined source=g10-m21 spent=278
  disruptor: {
    id: "disruptor",
    attributes: {
      burnRate: 0, moat: 27, shipRate: 0.81, foresight: 0,
      pivotSpeed: 0, leverage: -1, networking: 0, spite: -1,
      greed: 0, pacing: 0.06, cunning: 0, lift: 0,
      parry: 0.95, chase: 0.82, discipline: 0.05, hallucination: 0,
    },
  },
  // v13 refined source=g5-m17 spent=337
  troll: {
    id: "troll",
    attributes: {
      burnRate: 0, moat: 0, shipRate: 0.93, foresight: 0.1425,
      pivotSpeed: 0.09, leverage: -0.92, networking: 0, spite: 0.8,
      greed: 0, pacing: 0, cunning: 0, lift: 0.05,
      parry: 0.48, chase: 0.26, discipline: 0.05, hallucination: 0,
    },
  },
  // v13 refined source=g9-dirichlet_sparse-17 spent=278
  acquirer: {
    id: "acquirer",
    attributes: {
      burnRate: 0, moat: 27, shipRate: 0.81, foresight: 0,
      pivotSpeed: 0, leverage: -1, networking: 0, spite: -1,
      greed: 0, pacing: 0.06, cunning: 0, lift: 0,
      parry: 1, chase: 0.82, discipline: 0, hallucination: 0,
    },
  },
};

// A few illustrative DSL-based trajectories users can copy & tweak.
export const SAMPLE_TRAJECTORIES: BrainConfig[] = [
  {
    id: "ramp-aggro",
    attributes: {
      burnRate: "0.3 + 0.6 * clamp(tick / 1200, 0, 1)",
      moat: 90, shipRate: 0.9,
      pivotSpeed: "self.hp < 40 ? 0.9 : 0.2",
    },
  },
  {
    id: "oscillate-spacer",
    attributes: {
      burnRate: 0.6,
      moat: "90 + 30 * sin(tick * 0.013)",
      shipRate: 0.9, pivotSpeed: 0.6,
    },
  },
  {
    id: "panic-switcher",
    attributes: {
      burnRate: "self.hp < 30 ? 1.0 : 0.4",
      moat: "self.hp < 30 ? 0 : 100",
      shipRate: 1.0,
      hallucination: "self.hp < 20 ? 60 : 5",
    },
  },
];
