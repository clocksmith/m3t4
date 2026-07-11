import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import {
  STAGES,
  STRATEGIES,
  STRATEGY_NAMES,
  USER_BUDGET,
  USER_KNOBS,
  computedHallucinationForSpend,
  simulate,
  uiToNative,
  type BrainConfig,
  type ParamKey,
} from "@m3t4/sim";
import { db, COLLECTIONS } from "./firestore.js";
import {
  MAX_SLOTS,
  normalizeStableTotals,
  publicStableDoc,
  type StableDoc,
  type StableSlotDoc,
} from "./stable-public.js";
import {
  writePublicBotEvent,
  writePublicBotProjection,
} from "./public-bots.js";
import { BOT_NAME_SPACE, generatedBotName } from "./bot-names.js";

const REGION = "us-central1";
export const CHAMPION_DEFAULT_CANDIDATE_COUNT = 24;
export const CHAMPION_DEFAULT_REFERENCE_COUNT = 8;
const DEFAULT_RELEASE_COUNT = 1;
export const CHAMPION_RELEASE_SCHEDULE = "0 */6 * * *";
export const CHAMPION_RELEASE_TIMEOUT_SECONDS = 180;

export const releaseChampionCandidates = onSchedule(
  {
    region: REGION,
    schedule: CHAMPION_RELEASE_SCHEDULE,
    memory: "1GiB",
    timeoutSeconds: CHAMPION_RELEASE_TIMEOUT_SECONDS,
  },
  async (event) => {
    if (!envFlag("CHAMPION_RELEASE_ENABLED", false)) {
      logger.info("releaseChampionCandidates skipped; disabled");
      return;
    }

    const now = scheduledReleaseAt(event.scheduleTime);
    const seed = mix32(hashText(String(now)) ^ 0x9e3779b9);
    const candidateCount = positiveIntEnv(
      "CHAMPION_FRONTIER_CANDIDATES",
      CHAMPION_DEFAULT_CANDIDATE_COUNT,
    );
    const referenceCount = positiveIntEnv(
      "CHAMPION_FRONTIER_REFERENCES",
      CHAMPION_DEFAULT_REFERENCE_COUNT,
    );
    const releaseCount = Math.min(
      MAX_SLOTS,
      positiveIntEnv("CHAMPION_RELEASE_SLOTS", DEFAULT_RELEASE_COUNT),
    );
    logger.info("releaseChampionCandidates started", {
      scheduledAt: now,
      candidateCount,
      referenceCount,
      releaseCount,
    });

    const evaluationStartedAt = Date.now();
    const release = buildChampionRelease({
      seed,
      releaseId: now.toString(36),
      candidateCount,
      referenceCount,
      releaseCount,
    });
    if (release.selected.length === 0) {
      logger.warn("releaseChampionCandidates found no selected candidates", {
        candidateCount: release.candidateCount,
      });
      return;
    }

    const firestore = db();
    const stables = championStableDocs(release, now);

    const batch = firestore.batch();
    for (const stable of stables) {
      batch.set(firestore.collection(COLLECTIONS.stables).doc(stable.userId), stable);
      batch.set(
        firestore.collection(COLLECTIONS.publicStables).doc(stable.userId),
        publicStableDoc(stable),
      );
      batch.set(
        firestore.collection(COLLECTIONS.handles).doc(stable.handle),
        { handle: stable.handle, userId: stable.userId, updatedAt: now },
      );
      writePublicBotProjection(batch, firestore, stable);
      for (const slot of stable.slots) {
        writePublicBotEvent(batch, firestore, stable, slot, "released", now);
      }
    }
    await batch.commit();

    logger.info("releaseChampionCandidates complete", {
      releaseId: release.releaseId,
      candidateCount: release.candidateCount,
      selectedCount: release.selected.length,
      references: release.references,
      nameSpace: BOT_NAME_SPACE,
      evaluationMs: Date.now() - evaluationStartedAt,
      players: stables.map((stable) => ({
        userId: stable.userId,
        handle: stable.handle,
        bot: stable.slots[0]?.name,
      })),
    });
  },
);

export interface ChampionReleaseInput {
  seed: number;
  releaseId?: string;
  candidateCount: number;
  referenceCount: number;
  releaseCount: number;
}

export interface ChampionCandidate {
  config: BrainConfig;
  ui: number[];
  score: number;
  novelty: number;
  frontierRank: number;
  source: string;
}

export interface ChampionRelease {
  releaseId: string;
  candidateCount: number;
  references: string[];
  selected: ChampionCandidate[];
}

export function buildChampionRelease(input: ChampionReleaseInput): ChampionRelease {
  const candidateCount = Math.max(input.releaseCount, input.candidateCount);
  const rng = seededRng(input.seed);
  const references = selectReferences(input.seed, input.referenceCount);
  const candidates = sampleCandidates(candidateCount, rng, input.seed);
  const scored = candidates.map((candidate) => ({
    ...candidate,
    score: scoreCandidate(candidate.config, references, input.seed),
    novelty: noveltyScore(candidate.ui, references),
    frontierRank: 0,
  }));
  const ranked = assignFrontierRanks(scored);
  const selected = selectDiverse(ranked, input.releaseCount);
  return {
    releaseId: normalizedReleaseId(input.releaseId, input.seed),
    candidateCount,
    references: references.map((ref) => ref.id),
    selected,
  };
}

export function championStableDocs(release: ChampionRelease, now: number): StableDoc[] {
  const usedNames = new Set<string>();
  return release.selected.map((candidate, idx) => {
    const userId = `system:frontier:${release.releaseId}:${idx}`;
    const handle = `frontier_${release.releaseId.slice(-8)}_${idx}`;
    const elo = candidateElo(candidate.score);
    const slot: StableSlotDoc = {
      slotIdx: 0,
      slotId: `${userId}-0`,
      name: uniqueGeneratedName(
        mix32(hashText(`${release.releaseId}:${candidate.config.id}:${idx}`)),
        usedNames,
      ),
      config: candidate.config,
      cosmetics: frontierCosmetics(idx),
      elo,
      peakElo: elo,
      wins: 0,
      losses: 0,
      draws: 0,
      lastPlayedAt: 0,
      submittedAt: now,
      rateLockedUntil: now,
    };
    return normalizeStableTotals({
      userId,
      handle,
      slots: [slot],
      lastActiveAt: now,
      updatedAt: now,
      createdAt: now,
    });
  });
}

function normalizedReleaseId(value: string | undefined, seed: number): string {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(-10);
  return normalized || (seed >>> 0).toString(36);
}

function scheduledReleaseAt(scheduleTime: string | undefined): number {
  const parsed = Date.parse(scheduleTime ?? "");
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function uniqueGeneratedName(seed: number, usedNames: Set<string>): string {
  for (let offset = 0; offset < BOT_NAME_SPACE; offset++) {
    const name = generatedBotName(seed + offset);
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
  }
  const fallback = `frontier-${mix32(seed).toString(36)}`;
  usedNames.add(fallback);
  return fallback;
}

function sampleCandidates(count: number, rng: () => number, seed: number): Array<Omit<ChampionCandidate, "score" | "novelty" | "frontierRank">> {
  const out: Array<Omit<ChampionCandidate, "score" | "novelty" | "frontierRank">> = [];
  for (let i = 0; i < count; i++) {
    const source = sourceKind(i);
    const ui = source === "axis"
      ? axisCandidate(i, rng)
      : source === "pair"
        ? pairCandidate(i, rng)
        : source === "balanced"
          ? balancedCandidate(rng)
          : sparseCandidate(rng);
    const config = configFromUi(ui, `frontier-${mix32(seed ^ i ^ hashUi(ui)).toString(36)}`);
    out.push({ config, ui, source });
  }
  return out;
}

function sourceKind(index: number): string {
  const kinds = ["axis", "pair", "sparse", "balanced"];
  return kinds[index % kinds.length];
}

function sparseCandidate(rng: () => number): number[] {
  const ui = new Array(USER_KNOBS.length).fill(0);
  const order = shuffledIndexes(rng);
  let remaining = USER_BUDGET;
  const active = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < active && remaining > 0; i++) {
    const value = Math.min(remaining, 60 + Math.floor(rng() * 41));
    ui[order[i]] = value;
    remaining -= value;
  }
  for (let i = active; i < order.length && remaining > 0; i++) {
    const value = Math.min(remaining, Math.floor(rng() * 24));
    ui[order[i]] = value;
    remaining -= value;
  }
  settleBudget(ui, USER_BUDGET - remaining, rng);
  return ui;
}

function balancedCandidate(rng: () => number): number[] {
  const ui = new Array(USER_KNOBS.length).fill(0);
  const order = shuffledIndexes(rng);
  const active = 5 + Math.floor(rng() * 4);
  const shares = Array.from({ length: active }, () => 0.4 + rng());
  const shareSum = shares.reduce((sum, value) => sum + value, 0);
  let spent = 0;
  for (let i = 0; i < active; i++) {
    const value = Math.min(100, Math.round((shares[i] / shareSum) * USER_BUDGET));
    ui[order[i]] = value;
    spent += value;
  }
  settleBudget(ui, spent, rng);
  return ui;
}

function axisCandidate(index: number, rng: () => number): number[] {
  const ui = new Array(USER_KNOBS.length).fill(0);
  const axis = index % USER_KNOBS.length;
  ui[axis] = 82 + Math.floor(rng() * 19);
  const support = (axis + 3 + Math.floor(rng() * (USER_KNOBS.length - 3))) % USER_KNOBS.length;
  ui[support] = 48 + Math.floor(rng() * 28);
  fillRemaining(ui, rng);
  return ui;
}

function pairCandidate(index: number, rng: () => number): number[] {
  const ui = new Array(USER_KNOBS.length).fill(0);
  const a = index % USER_KNOBS.length;
  const b = (a + 5 + Math.floor(rng() * (USER_KNOBS.length - 5))) % USER_KNOBS.length;
  ui[a] = 62 + Math.floor(rng() * 32);
  ui[b] = 52 + Math.floor(rng() * 34);
  fillRemaining(ui, rng);
  return ui;
}

function fillRemaining(ui: number[], rng: () => number): void {
  let spent = ui.reduce((sum, value) => sum + value, 0);
  const order = shuffledIndexes(rng);
  for (const idx of order) {
    if (spent >= USER_BUDGET) break;
    const value = Math.min(USER_BUDGET - spent, Math.floor(rng() * 26));
    ui[idx] += value;
    spent += value;
  }
  settleBudget(ui, spent, rng);
}

function settleBudget(ui: number[], spent: number, rng: () => number): void {
  while (spent > USER_BUDGET) {
    const idx = ui.indexOf(Math.max(...ui));
    ui[idx] -= 1;
    spent -= 1;
  }
  while (spent < USER_BUDGET) {
    const candidates = shuffledIndexes(rng).filter((idx) => ui[idx] < 100);
    const idx = candidates[0];
    if (idx === undefined) break;
    ui[idx] += 1;
    spent += 1;
  }
}

function configFromUi(ui: number[], id: string): BrainConfig {
  const attributes: Partial<Record<ParamKey, number>> = {};
  let spent = 0;
  for (let i = 0; i < USER_KNOBS.length; i++) {
    const key = USER_KNOBS[i];
    const value = Math.max(0, Math.min(100, Math.round(ui[i])));
    attributes[key] = uiToNative(key, value);
    spent += value;
  }
  attributes.hallucination = computedHallucinationForSpend(spent);
  return { id, attributes };
}

function scoreCandidate(config: BrainConfig, refs: BrainConfig[], seed: number): number {
  let points = 0;
  let total = 0;
  const stages = Object.values(STAGES);
  for (let refIdx = 0; refIdx < refs.length; refIdx++) {
    const ref = refs[refIdx];
    for (let stageIdx = 0; stageIdx < stages.length; stageIdx++) {
      const stage = stages[stageIdx];
      const forward = simulate({
        stage,
        brainA: config,
        brainB: ref,
        seed: mix32(seed ^ hashText(config.id) ^ hashText(ref.id) ^ stageIdx),
      });
      points += forward.winner === 0 ? 1 : forward.winner === -1 ? 0.5 : 0;
      total += 1;

      const reverse = simulate({
        stage,
        brainA: ref,
        brainB: config,
        seed: mix32(seed ^ hashText(config.id) ^ hashText(ref.id) ^ stageIdx ^ 0xa5a5a5a5),
      });
      points += reverse.winner === 1 ? 1 : reverse.winner === -1 ? 0.5 : 0;
      total += 1;
    }
  }
  return total > 0 ? points / total : 0;
}

function selectReferences(seed: number, count: number): BrainConfig[] {
  const names = [...STRATEGY_NAMES];
  const rng = seededRng(seed ^ 0x51f15e);
  names.sort(() => rng() - 0.5);
  return names.slice(0, Math.max(1, Math.min(count, names.length))).map((name) => STRATEGIES[name]);
}

function noveltyScore(ui: number[], refs: BrainConfig[]): number {
  const refVectors = refs.map(uiFromConfig);
  const minDistance = refVectors.reduce(
    (best, ref) => Math.min(best, vectorDistance(ui, ref)),
    Number.POSITIVE_INFINITY,
  );
  return Number.isFinite(minDistance) ? minDistance : 0;
}

function uiFromConfig(config: BrainConfig): number[] {
  return USER_KNOBS.map((key) => {
    const raw = config.attributes[key];
    if (typeof raw !== "number") return 0;
    const [lo, hi] = knobRange(key);
    return Math.max(0, Math.min(100, ((raw - lo) / (hi - lo)) * 100));
  });
}

function knobRange(key: ParamKey): [number, number] {
  const zero = uiToNative(key, 0);
  const hundred = uiToNative(key, 100);
  return [zero, hundred];
}

function assignFrontierRanks(candidates: ChampionCandidate[]): ChampionCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    frontierRank: candidates.filter((other) => dominates(other, candidate)).length,
  }));
}

function dominates(a: ChampionCandidate, b: ChampionCandidate): boolean {
  const atLeast = a.score >= b.score && a.novelty >= b.novelty;
  const better = a.score > b.score || a.novelty > b.novelty;
  return atLeast && better;
}

function selectDiverse(candidates: ChampionCandidate[], count: number): ChampionCandidate[] {
  const ordered = candidates.slice().sort((a, b) =>
    a.frontierRank - b.frontierRank ||
    b.score - a.score ||
    b.novelty - a.novelty,
  );
  const selected: ChampionCandidate[] = [];
  for (const candidate of ordered) {
    if (selected.length >= count) break;
    const tooClose = selected.some((existing) => vectorDistance(existing.ui, candidate.ui) < 0.18);
    if (!tooClose) selected.push(candidate);
  }
  for (const candidate of ordered) {
    if (selected.length >= count) break;
    if (!selected.includes(candidate)) selected.push(candidate);
  }
  return selected;
}

function vectorDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const diff = (a[i] - b[i]) / 100;
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function candidateElo(score: number): number {
  return Math.max(1200, Math.min(1800, Math.round(1500 + (score - 0.5) * 500)));
}

function frontierCosmetics(idx: number): { body: string; weapon: string } {
  const kits = [
    { body: "sama", weapon: "worldcoin_orb_flail" },
    { body: "darrius", weapon: "rolled_constitution_bat" },
    { body: "demis", weapon: "nobel_medal_flail" },
    { body: "mark", weapon: "rolled_constitution_bat" },
  ];
  return kits[idx % kits.length];
}

function shuffledIndexes(rng: () => number): number[] {
  return Array.from({ length: USER_KNOBS.length }, (_, i) => i).sort(() => rng() - 0.5);
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(1664525, state) + 1013904223 >>> 0;
    return state / 0x100000000;
  };
}

function hashUi(ui: number[]): number {
  return hashText(ui.map((value) => Math.round(value)).join(","));
}

function hashText(text: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function mix32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}
