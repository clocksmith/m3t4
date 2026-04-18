// Ceiling-test deep report.
//
// evolve-budget only reports the aggregate WR of its best discovered
// candidate. That's a warning light, not a diagnosis. This tool
// post-processes the ceiling output and tells you *which* preset(s)
// create the gap, how the winner allocates its budget, and whether
// the winner came from the HOF pool (selector miss) or is a novel
// out-of-HOF specialist (Phase-4 hardening target).
//
// Usage:
//   node pareto/dist/ceiling-report.js \
//     --ceiling /tmp/legal-ceiling-v5a.json \
//     --hof /tmp/new-roster-v5.hof.json \
//     --out /tmp/ceiling-report-v5a.json

import fs from "node:fs";
import os from "node:os";
import {
  STAGES, STRATEGIES, STRATEGY_NAMES,
  USER_KNOBS, nativeToUI,
  type BrainConfig,
} from "@m3t4/sim";
import { runMatches, type MatchSpec } from "./parallel.js";
import { featureVector } from "./novelty.js";

interface CeilingOutput {
  bestEver: { wr: number; spent: number; config: BrainConfig };
  stats?: Array<{ gen: number; bestWr: number; meanWr: number }>;
}

interface HofEntry {
  id: string;
  attributes: BrainConfig["attributes"];
  wr: number;
  gen: number;
  meta?: { sourceKind?: string; mutationKind?: string };
}

interface PerPresetWr {
  presetId: string;
  wr: number;
  matches: number;
}

interface ReportOutput {
  bestCandidate: {
    id: string;
    config: BrainConfig;
    uiVector: number[];
    topAxes: Array<{ knob: string; ui: number }>;
    spent: number;
  };
  bestWr: number;
  perPresetWr: PerPresetWr[];
  nearestPresetByAttr: { id: string; distance: number };
  farthestPresetByAttr: { id: string; distance: number };
  closestHofMember: {
    id: string;
    distance: number;
    hofWr: number;
    wasSelected: boolean;
    sourceKind?: string;
  } | null;
  interpretation: {
    weakestPresets: string[];   // presets the winner beats by >60%
    weakestWr: Array<{ presetId: string; wr: number }>;
    uniformPressure: boolean;   // does counter beat most presets similarly?
    cameFromHof: boolean;       // counter resembles unselected HOF candidate?
  };
}

function uiVector(cfg: BrainConfig): number[] {
  return USER_KNOBS.map((k) => {
    const v = cfg.attributes[k];
    if (typeof v !== "number") return 0;
    return Math.round(nativeToUI(k, v));
  });
}

function attrDistance(a: BrainConfig, b: BrainConfig): number {
  const va = featureVector(a); const vb = featureVector(b);
  let s = 0;
  for (let i = 0; i < va.length; i++) { const d = va[i] - vb[i]; s += d * d; }
  return Math.sqrt(s);
}

async function scorePerPreset(
  candidate: BrainConfig,
  roster: BrainConfig[],
  seeds = 5,
): Promise<PerPresetWr[]> {
  const stages = Object.values(STAGES);
  const workers = os.cpus().length;
  const specs: MatchSpec[] = [];
  roster.forEach((r, ri) => {
    if (r.id === candidate.id) return;
    for (const stage of stages) {
      for (let s = 0; s < seeds; s++) {
        const seed = ((s * 113 + stage.id.length * 41 + ri * 17) | 0) >>> 0;
        specs.push({ a: candidate, b: r, stageId: stage.id as MatchSpec["stageId"], seed, meta: { ri, side: 0 } });
        specs.push({ a: r, b: candidate, stageId: stage.id as MatchSpec["stageId"], seed, meta: { ri, side: 1 } });
      }
    }
  });
  const outcomes = await runMatches(specs, { workers });
  const wins = new Array(roster.length).fill(0);
  const played = new Array(roster.length).fill(0);
  for (const o of outcomes) {
    const m = o.spec.meta as { ri: number; side: 0 | 1 };
    played[m.ri]++;
    if (o.winner === m.side) wins[m.ri]++;
    else if (o.winner === -1) wins[m.ri] += 0.5;
  }
  return roster.map((r, i) => ({
    presetId: r.id,
    wr: played[i] > 0 ? wins[i] / played[i] : 0,
    matches: played[i],
  }));
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out[k.slice(2)] = next; i++; }
      else out[k.slice(2)] = "1";
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const ceilingPath = args.ceiling ?? "/tmp/legal-ceiling-v5a.json";
  const hofPath = args.hof ?? "/tmp/new-roster-v5.hof.json";
  const outPath = args.out ?? "/tmp/ceiling-report-v5a.json";

  const ceiling: CeilingOutput = JSON.parse(fs.readFileSync(ceilingPath, "utf8"));
  const best = ceiling.bestEver.config;
  const bestWrAggregate = ceiling.bestEver.wr;

  const roster = STRATEGY_NAMES.map((n) => STRATEGIES[n as keyof typeof STRATEGIES]);

  console.error(`Scoring ceiling winner "${best.id}" vs each of the ${roster.length} installed presets (5 seeds × 3 stages)...`);
  const perPreset = await scorePerPreset(best, roster, 5);

  // Attribute distance to each preset
  const distances = roster.map((r) => ({ id: r.id, distance: attrDistance(best, r) }));
  distances.sort((a, b) => a.distance - b.distance);
  const nearest = distances[0];
  const farthest = distances[distances.length - 1];

  // HOF resemblance: does the winner match something in the HOF pool?
  let closestHof: ReportOutput["closestHofMember"] = null;
  if (fs.existsSync(hofPath)) {
    const hofRaw = JSON.parse(fs.readFileSync(hofPath, "utf8"));
    const hof: HofEntry[] = hofRaw.hof ?? hofRaw ?? [];
    if (hof.length > 0) {
      const candidates = hof.map((h) => ({
        entry: h,
        cfg: { id: h.id, attributes: h.attributes } as BrainConfig,
      }));
      const hofDistances = candidates
        .map(({ entry, cfg }) => ({ entry, distance: attrDistance(best, cfg) }))
        .sort((a, b) => a.distance - b.distance);
      const top = hofDistances[0];
      const selectedIds = new Set<string>(STRATEGY_NAMES);
      // "Selected" means the HOF member was installed as a preset. Since
      // we renamed evolved-ids to preset names, we can only detect this
      // approximately via the closest preset attribute distance.
      const closestPresetDist = nearest.distance;
      const wasSelected = Math.abs(top.distance - closestPresetDist) < 0.01 || selectedIds.has(top.entry.id);
      closestHof = {
        id: top.entry.id,
        distance: top.distance,
        hofWr: top.entry.wr,
        wasSelected,
        sourceKind: top.entry.meta?.sourceKind,
      };
    }
  }

  const topAxes = uiVector(best)
    .map((v, i) => ({ knob: USER_KNOBS[i], ui: v }))
    .sort((a, b) => b.ui - a.ui)
    .slice(0, 5);

  // Interpretation
  const weakest = perPreset.filter((p) => p.wr > 0.6).map((p) => p.presetId);
  const weakestWr = perPreset.slice().sort((a, b) => b.wr - a.wr).slice(0, 5).map(({ presetId, wr }) => ({ presetId, wr }));
  const uniformPressure = weakest.length >= 10; // beats most presets = universal pressure
  const cameFromHof = closestHof !== null && closestHof.distance < 0.15;

  const report: ReportOutput = {
    bestCandidate: {
      id: best.id,
      config: best,
      uiVector: uiVector(best),
      topAxes,
      spent: ceiling.bestEver.spent,
    },
    bestWr: bestWrAggregate,
    perPresetWr: perPreset,
    nearestPresetByAttr: nearest,
    farthestPresetByAttr: farthest,
    closestHofMember: closestHof,
    interpretation: {
      weakestPresets: weakest,
      weakestWr,
      uniformPressure,
      cameFromHof,
    },
  };

  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  // Human-readable output
  console.log(`\n# Ceiling report\n`);
  console.log(`## Winner`);
  console.log(`  id: ${best.id}  spent=${ceiling.bestEver.spent}  aggregateWr=${(bestWrAggregate * 100).toFixed(1)}%`);
  console.log(`  top axes: ${topAxes.map((a) => `${a.knob}=${a.ui}`).join("  ")}`);
  console.log();
  console.log(`## Per-preset WR (5 seeds × 3 stages each, both sides)`);
  const sorted = perPreset.slice().sort((a, b) => b.wr - a.wr);
  for (const p of sorted) {
    const bar = "█".repeat(Math.round(p.wr * 40));
    const flag = p.wr > 0.65 ? " ⚠" : p.wr > 0.55 ? " ~" : "";
    console.log(`  ${p.presetId.padEnd(12)} ${(p.wr * 100).toFixed(1).padStart(5)}% ${bar}${flag}`);
  }
  console.log();
  console.log(`## Attribute neighborhood`);
  console.log(`  nearest preset:  ${nearest.id} (distance=${nearest.distance.toFixed(3)})`);
  console.log(`  farthest preset: ${farthest.id} (distance=${farthest.distance.toFixed(3)})`);
  console.log();
  if (closestHof) {
    console.log(`## HOF resemblance`);
    console.log(`  closest HOF member: ${closestHof.id} (distance=${closestHof.distance.toFixed(3)})`);
    console.log(`  HOF member's own WR: ${(closestHof.hofWr * 100).toFixed(1)}%`);
    console.log(`  sourceKind: ${closestHof.sourceKind ?? "unknown"}`);
    console.log(`  was this HOF member installed as a preset? ${closestHof.wasSelected ? "yes (approx)" : "no — selector missed it"}`);
  }
  console.log();
  console.log(`## Diagnosis`);
  console.log(`  preset(s) winner beats >60%: ${weakest.length > 0 ? weakest.join(", ") : "none"}`);
  console.log(`  uniform pressure (beats ≥10 of 16 at >60%): ${uniformPressure ? "YES — transferable counter family" : "no — targeted pressure"}`);
  console.log(`  winner in HOF region: ${cameFromHof ? "YES — selector excluded this family" : "no — novel out-of-HOF specialist"}`);
  console.log();
  console.log(`Wrote ${outPath}`);
}

await main();
