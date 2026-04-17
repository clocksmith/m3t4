// One-shot: does the spacer exploit still win after server-side budget
// validation forces legal hallucination? If legal h=300 kills it, the
// 90% WR was a forged-config artifact and the fix is enforcement, not
// rebalancing. If it still wins, the meta is actually broken.

import fs from "node:fs";
import os from "node:os";
import {
  STAGES, STRATEGIES, STRATEGY_NAMES,
  budgetSpent, computedHallucinationForSpend,
  type BrainConfig,
} from "@m3t4/sim";
import { scoreBatch } from "./score.js";

const PATH = process.argv[2] ?? "/tmp/spacer-exploit.json";
const SEEDS = parseInt(process.argv[3] ?? "5", 10);

const raw = JSON.parse(fs.readFileSync(PATH, "utf8"));
const forged: BrainConfig = raw.config ?? raw;

const spent = budgetSpent(forged);
const legalH = computedHallucinationForSpend(spent);

const legal: BrainConfig = {
  ...forged,
  id: `${forged.id}-legal`,
  attributes: { ...forged.attributes, hallucination: legalH },
};

const refs = STRATEGY_NAMES.map((n) => STRATEGIES[n]);
const stages = Object.values(STAGES);
const WORKERS = os.cpus().length;

console.log(`\n# Spacer exploit — legal validation test\n`);
console.log(`- UI-space spent: ${spent} (budget ${360})`);
console.log(`- Overage: ${Math.max(0, spent - 360)}`);
console.log(`- Forged h: ${forged.attributes.hallucination}`);
console.log(`- Legal h:  ${legalH}`);
console.log(`- Seeds per matchup: ${SEEDS}\n`);

async function score(label: string, cfg: BrainConfig): Promise<number> {
  console.error(`  scoring ${label}...`);
  const recs = await scoreBatch({
    candidates: [cfg], references: refs, stages,
    seedsPerMatchup: SEEDS, workers: WORKERS,
  });
  return recs[0].winRate;
}

const forgedWr = await score("forged (h=10)", forged);
const legalWr = await score(`legal (h=${legalH})`, legal);

console.log(`\n| config | hallucination | WR vs named meta |`);
console.log(`|---|---|---|`);
console.log(`| forged (raw) | ${forged.attributes.hallucination} | **${(forgedWr * 100).toFixed(1)}%** |`);
console.log(`| legal (validated) | ${legalH} | **${(legalWr * 100).toFixed(1)}%** |`);

console.log(`\n## Verdict`);
if (legalWr < 0.6) {
  console.log(`✓ Legal validation neutralizes the spacer (${(legalWr * 100).toFixed(1)}% < 60%).`);
  console.log(`  The 90% WR was a forged-config artifact. The fix is enforcement, not rebalance.`);
} else if (legalWr < 0.75) {
  console.log(`~ Legal validation partially neutralizes (${(legalWr * 100).toFixed(1)}%).`);
  console.log(`  Budget rules helped but the archetype still has legs. Consider targeted rebalance.`);
} else {
  console.log(`✗ Legal validation does NOT neutralize (${(legalWr * 100).toFixed(1)}% >= 75%).`);
  console.log(`  The meta has a real hole. Rebalance required.`);
}

fs.writeFileSync("/tmp/spacer-legal-check.json", JSON.stringify({
  spent, overage: Math.max(0, spent - 360),
  forgedH: forged.attributes.hallucination, legalH,
  forgedWr, legalWr,
  verdict: legalWr < 0.6 ? "enforcement-only" : legalWr < 0.75 ? "partial" : "rebalance-needed",
}, null, 2));
