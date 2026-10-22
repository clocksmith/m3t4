// Offline evaluation only. This module does not choose a winner, change Elo,
// schedule featured content, or read/write any external state.
export const BACKGROUND_SCHEDULER_VERSION = 1;
export const BACKGROUND_HISTORY_LIMIT = 4096;
export const BACKGROUND_ROSTER_LIMIT = 256;

export interface EvaluationFighter {
  userId: string;
  slotId: string;
  elo: number;
  gamesPlayed: number;
  // Number of evaluations in this run, separate from imported career stats.
  evaluations: number;
  // Elo-scale scheduling heuristic, not a calibrated confidence interval.
  uncertainty?: number;
  style?: string;
}

export interface EvaluationHistoryEntry {
  sequence: number;
  a: string;
  b: string;
}

export interface BackgroundScheduleOptions {
  fighters: readonly EvaluationFighter[];
  history: readonly EvaluationHistoryEntry[];
  seed: number;
  sequence: number;
  pairCooldown?: number;
  fighterCooldown?: number;
  placementGames?: number;
}

export interface BackgroundSelection {
  a: string;
  b: string;
  pivot: string;
  reason: "placement" | "skill";
  placementBand: "lower" | "middle" | "upper" | null;
  rawEloGap: number;
  normalizedSkillGap: number;
  // Explicitly records why a requested cooldown could not be satisfied.
  fallback: "none" | "fighter-cooldown-unavoidable" | "pair-repeat-unavoidable";
  relaxedFighterCooldown: boolean;
  relaxedPairCooldown: boolean;
  priorPairingsInWindow: number;
  historySize: number;
}

export function evaluationFighterKey(fighter: Pick<EvaluationFighter, "userId" | "slotId">): string {
  // JSON tuples avoid delimiter collisions in user/slot IDs.
  return JSON.stringify([fighter.userId, fighter.slotId]);
}

export function evaluationUncertainty(fighter: EvaluationFighter): number {
  return fighter.uncertainty ?? Math.max(50, 350 / Math.sqrt(1 + fighter.gamesPlayed / 4));
}

/** Stable across pool ordering, process clocks, and calls to Math.random. */
export function evaluationSeed(seed: number, sequence: number, label = "match"): number {
  let value = (seed ^ Math.imul(sequence + 1, 0x9e3779b9)) >>> 0;
  for (let i = 0; i < label.length; i++) {
    value = Math.imul(value ^ label.charCodeAt(i), 16777619) >>> 0;
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return value >>> 0;
}

export function selectBackgroundPair(options: BackgroundScheduleOptions): BackgroundSelection | null {
  const { seed, sequence } = options;
  integer(seed, "seed", 0, 0xffffffff);
  integer(sequence, "sequence", 0, 1_000_000_000);
  const pairCooldown = options.pairCooldown ?? 8;
  const fighterCooldown = options.fighterCooldown ?? 1;
  const placementGames = options.placementGames ?? 6;
  integer(pairCooldown, "pairCooldown", 0, 256);
  integer(fighterCooldown, "fighterCooldown", 0, 256);
  integer(placementGames, "placementGames", 1, 32);
  if (options.fighters.length > BACKGROUND_ROSTER_LIMIT) throw new Error("evaluation roster is too large");
  if (options.history.length > BACKGROUND_HISTORY_LIMIT) throw new Error("evaluation history must be bounded");

  const fighters = [...options.fighters].sort((a, b) => compareText(evaluationFighterKey(a), evaluationFighterKey(b)));
  const byKey = new Map<string, EvaluationFighter>();
  for (const fighter of fighters) {
    if (typeof fighter.userId !== "string" || !fighter.userId || typeof fighter.slotId !== "string" || !fighter.slotId) throw new Error("fighter requires userId and slotId");
    if (fighter.style !== undefined && typeof fighter.style !== "string") throw new Error("fighter style must be a string");
    finite(fighter.elo, "elo");
    integer(fighter.gamesPlayed, "gamesPlayed", 0, Number.MAX_SAFE_INTEGER);
    integer(fighter.evaluations, "evaluations", 0, Number.MAX_SAFE_INTEGER);
    if (fighter.uncertainty !== undefined && (!Number.isFinite(fighter.uncertainty) || fighter.uncertainty < 0 || fighter.uncertainty > 1000)) {
      throw new Error("uncertainty must be in [0, 1000]");
    }
    const key = evaluationFighterKey(fighter);
    if (byKey.has(key)) throw new Error("duplicate evaluation fighter");
    byKey.set(key, fighter);
  }
  const lastFighter = new Map<string, number>();
  const lastPair = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  const styleCounts = new Map<string, Map<string, number>>();
  let previousSequence = -1;
  for (const entry of options.history) {
    integer(entry.sequence, "history.sequence", 0, sequence - 1);
    if (entry.sequence <= previousSequence || entry.a === entry.b) throw new Error("history must be chronological, with distinct fighters");
    previousSequence = entry.sequence;
    const key = pairKey(entry.a, entry.b);
    lastPair.set(key, entry.sequence);
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    for (const [self, opponent] of [[entry.a, entry.b], [entry.b, entry.a]]) {
      lastFighter.set(self, entry.sequence);
      const style = byKey.get(opponent)?.style;
      if (style) {
        const counts = styleCounts.get(self) ?? new Map<string, number>();
        counts.set(style, (counts.get(style) ?? 0) + 1);
        styleCounts.set(self, counts);
      }
    }
  }
  const recent = (last: number | undefined, cooldown: number) => last !== undefined && sequence - last <= cooldown;
  type Candidate = { a: string; b: string; pairBlocked: boolean; fighterBlocked: boolean };
  const candidates: Candidate[] = [];
  let bestTier = Infinity;
  for (let i = 0; i < fighters.length; i++) {
    for (let j = i + 1; j < fighters.length; j++) {
      if (fighters[i].userId === fighters[j].userId) continue;
      const a = evaluationFighterKey(fighters[i]), b = evaluationFighterKey(fighters[j]);
      const pairBlocked = recent(lastPair.get(pairKey(a, b)), pairCooldown);
      const fighterBlocked = recent(lastFighter.get(a), fighterCooldown) || recent(lastFighter.get(b), fighterCooldown);
      // A fresh opponent takes precedence over resting a fighter. A pair
      // repeats inside cooldown only when EVERY legal pair is cooling down.
      const tier = pairBlocked ? 2 : fighterBlocked ? 1 : 0;
      if (tier < bestTier) { candidates.length = 0; bestTier = tier; }
      if (tier === bestTier) candidates.push({ a, b, pairBlocked, fighterBlocked });
    }
  }
  if (!candidates.length) return null;
  const eligible = new Set(candidates.flatMap(({ a, b }) => [a, b]));
  const pivots = fighters.filter((fighter) => eligible.has(evaluationFighterKey(fighter)));
  pivots.sort((a, b) =>
    a.evaluations - b.evaluations ||
    Number(a.gamesPlayed >= placementGames) - Number(b.gamesPlayed >= placementGames) ||
    evaluationUncertainty(b) - evaluationUncertainty(a) ||
    evaluationSeed(seed, sequence, evaluationFighterKey(a)) - evaluationSeed(seed, sequence, evaluationFighterKey(b)) ||
    compareText(evaluationFighterKey(a), evaluationFighterKey(b)));
  const pivot = pivots[0], pivotKey = evaluationFighterKey(pivot);
  const opponents = candidates.filter(({ a, b }) => a === pivotKey || b === pivotKey)
    .map((pair) => ({ pair, fighter: byKey.get(pair.a === pivotKey ? pair.b : pair.a)! }));
  const placement = pivot.gamesPlayed < placementGames;
  const bandIndex = (evaluationSeed(seed, 0, pivotKey) + pivot.gamesPlayed) % 3;
  // Probe lower/middle/upper available skill bands during placement, not
  // only a narrow incumbent cluster. No outcomes are used to force variety.
  const ratings = opponents.map(({ fighter }) => fighter.elo).sort((a, b) => a - b);
  const targetRating = placement ? ratings[Math.round((ratings.length - 1) * bandIndex / 2)] : pivot.elo;
  const normalizedGap = (other: EvaluationFighter, target = pivot.elo) =>
    Math.abs(target - other.elo) / (200 + Math.hypot(evaluationUncertainty(pivot), evaluationUncertainty(other)));
  const rank = ({ pair, fighter }: typeof opponents[number]): number[] => {
    const repeats = pairCounts.get(pairKey(pair.a, pair.b)) ?? 0;
    const styles = fighter.style ? styleCounts.get(pivotKey)?.get(fighter.style) ?? 0 : 0;
    return [
      // Least recent pair wins when a repeat is genuinely unavoidable.
      pair.pairBlocked ? lastPair.get(pairKey(pair.a, pair.b))! : -1,
      // Cover the complete roster before recycling opponents where cooldowns
      // permit. New arrivals need not wait behind already-served incumbents.
      Number(fighter.evaluations > 0),
      ...(placement ? [repeats, styles, normalizedGap(fighter, targetRating)] : [normalizedGap(fighter) + repeats * 0.35]),
      fighter.evaluations,
      evaluationSeed(seed, sequence, evaluationFighterKey(fighter)),
    ];
  };
  opponents.sort((a, b) => compareRanks(rank(a), rank(b)) || compareText(evaluationFighterKey(a.fighter), evaluationFighterKey(b.fighter)));
  const chosen = opponents[0];
  const swap = (evaluationSeed(seed, sequence, "order") & 1) === 1;
  return {
    a: swap ? chosen.pair.b : chosen.pair.a,
    b: swap ? chosen.pair.a : chosen.pair.b,
    pivot: pivotKey,
    reason: placement ? "placement" : "skill",
    placementBand: placement ? (["lower", "middle", "upper"] as const)[bandIndex] : null,
    rawEloGap: Math.abs(pivot.elo - chosen.fighter.elo),
    normalizedSkillGap: normalizedGap(chosen.fighter),
    fallback: bestTier === 0 ? "none" : bestTier === 1 ? "fighter-cooldown-unavoidable" : "pair-repeat-unavoidable",
    relaxedFighterCooldown: chosen.pair.fighterBlocked,
    relaxedPairCooldown: chosen.pair.pairBlocked,
    priorPairingsInWindow: pairCounts.get(pairKey(chosen.pair.a, chosen.pair.b)) ?? 0,
    historySize: options.history.length,
  };
}

function pairKey(a: string, b: string): string { return JSON.stringify([a, b].sort(compareText)); }
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
function finite(value: number, name: string): void { if (!Number.isFinite(value)) throw new Error(`${name} must be finite`); }
function integer(value: number, name: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
}
