import {
  DEFAULT_PARAMS,
  nativeToUI,
  ROUND_TIMER_MAX_TICKS,
  ROUNDS_TO_WIN_MATCH,
  USER_KNOBS,
  type BrainConfig,
  type MatchResult,
  type ParamKey,
} from "@m3t4/sim";
import type { Slot } from "./stable.js";

export interface WatchlistTag {
  tag: string;
  kind: "preset" | "archetype";
  similarity?: number;
}

export interface WatchlistMatchSummary {
  tags: {
    a: WatchlistTag[];
    b: WatchlistTag[];
  };
  quality: {
    draw: boolean;
    longMatch: boolean;
    ticks: number;
    finalScore: [number, number];
    finalRounds: [number, number];
  };
}

const WATCHLIST_PRESETS = new Set(["unicorn", "disruptor", "shipper"]);
const ARCHETYPE_SIMILARITY_THRESHOLD = 0.94;

const ARCHETYPE_FINGERPRINTS: Array<{ tag: string; config: BrainConfig }> = [
  {
    tag: "v9-full-disruptor-generalist",
    config: {
      id: "v9-full-disruptor-generalist",
      attributes: {
        burnRate: 0.32, moat: 87, shipRate: 0.33, foresight: 0.1225,
        pivotSpeed: 0.22, leverage: -0.74, networking: 0.39,
        spite: -0.28, greed: 0.53, pacing: 0.39, cunning: 0.05,
        hallucination: 0,
      },
    },
  },
  {
    tag: "v9-full-shipper-generalist",
    config: {
      id: "v9-full-shipper-generalist",
      attributes: {
        burnRate: 0.82, moat: 126, shipRate: 0.78, foresight: 0,
        pivotSpeed: 0.7, leverage: -1, networking: 0,
        spite: -0.34, greed: 0, pacing: 0.25, cunning: 0.3,
        hallucination: 0,
      },
    },
  },
  {
    tag: "v9-low-unicorn-noise",
    config: {
      id: "v9-low-unicorn-noise",
      attributes: {
        burnRate: 0, moat: 15, shipRate: 0.92, foresight: 0.0075,
        pivotSpeed: 0.03, leverage: -0.3, networking: 0.27,
        spite: -0.88, greed: 0.64, pacing: 0.23, cunning: 0,
        hallucination: 0,
      },
    },
  },
];

const VECTOR_KEYS: ParamKey[] = [...USER_KNOBS];

const ARCHETYPE_VECTORS = ARCHETYPE_FINGERPRINTS.map((fp) => ({
  tag: fp.tag,
  vector: configVector(fp.config),
}));

export function watchlistTagsForSlot(slot: Pick<Slot, "config" | "name">): WatchlistTag[] {
  const tags: WatchlistTag[] = [];
  const id = slot.config.id || slot.name;
  if (WATCHLIST_PRESETS.has(id) || WATCHLIST_PRESETS.has(slot.name)) {
    tags.push({ kind: "preset", tag: `preset:${WATCHLIST_PRESETS.has(id) ? id : slot.name}` });
  }

  const v = configVector(slot.config);
  for (const fp of ARCHETYPE_VECTORS) {
    const similarity = cosine(v, fp.vector);
    if (similarity >= ARCHETYPE_SIMILARITY_THRESHOLD) {
      tags.push({ kind: "archetype", tag: fp.tag, similarity: round3(similarity) });
    }
  }
  return tags;
}

export function summarizeWatchlistMatch(
  result: MatchResult,
  tags: { a: WatchlistTag[]; b: WatchlistTag[] },
): WatchlistMatchSummary {
  return {
    tags,
    quality: {
      draw: result.winner === -1,
      longMatch: result.ticks >= Math.floor(ROUND_TIMER_MAX_TICKS * ROUNDS_TO_WIN_MATCH * 2 * 0.7),
      ticks: result.ticks,
      finalScore: result.finalScore,
      finalRounds: result.finalRounds,
    },
  };
}

export function shouldLogWatchlist(summary: WatchlistMatchSummary): boolean {
  return summary.tags.a.length > 0
    || summary.tags.b.length > 0
    || summary.quality.draw
    || summary.quality.longMatch;
}

function configVector(cfg: BrainConfig): number[] {
  return VECTOR_KEYS.map((k) => nativeToUI(k, scalarValue(cfg, k)) / 100);
}

function scalarValue(cfg: BrainConfig, key: ParamKey): number {
  const spec = cfg.attributes[key];
  if (typeof spec === "number") return spec;
  if (spec && typeof spec === "object" && typeof spec.base === "number") return spec.base;
  return DEFAULT_PARAMS[key];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (aa === 0 || bb === 0) return 0;
  return dot / (Math.sqrt(aa) * Math.sqrt(bb));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
