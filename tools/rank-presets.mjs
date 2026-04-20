// Round-robin the 16 curated presets and pick tiers for the builder
// difficulty picker: easy=worst, medium=median, hard=top-25%.
//
// Writes data/preset-ranking.v1.json and the browser copy under client/data/.
// Run after any roster change.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STRATEGIES, STRATEGY_NAMES, STAGES, simulate } from "../sim/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../data/preset-ranking.v1.json");
const CLIENT_OUT = path.resolve(__dirname, "../client/data/preset-ranking.v1.json");
const SEEDS = 3;
const STAGE_IDS = Object.keys(STAGES);

const names = [...STRATEGY_NAMES];
const wins = Object.fromEntries(names.map((n) => [n, 0]));
const losses = Object.fromEntries(names.map((n) => [n, 0]));
const draws = Object.fromEntries(names.map((n) => [n, 0]));

const t0 = Date.now();
let matches = 0;
for (const a of names) {
  for (const b of names) {
    if (a === b) continue;
    for (let s = 0; s < SEEDS; s++) {
      const stage = STAGES[STAGE_IDS[s % STAGE_IDS.length]];
      const r = simulate({ brainA: STRATEGIES[a], brainB: STRATEGIES[b], stage, seed: s + 1 });
      matches++;
      if (r.winner === 0) { wins[a]++; losses[b]++; }
      else if (r.winner === 1) { wins[b]++; losses[a]++; }
      else { draws[a]++; draws[b]++; }
    }
  }
}

const rows = names.map((n) => {
  const total = wins[n] + losses[n] + draws[n];
  const wr = total ? (wins[n] + draws[n] * 0.5) / total : 0;
  return { name: n, wins: wins[n], losses: losses[n], draws: draws[n], wr };
}).sort((a, b) => b.wr - a.wr);

const N = rows.length;
const tiers = {
  hard: rows[Math.floor(N * 0.25) - 1]?.name ?? rows[0].name, // top-25% (rank 4 of 16)
  medium: rows[Math.floor(N * 0.5)]?.name ?? rows[Math.floor(N / 2)].name, // median
  easy: rows[N - 1].name, // worst
};

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`ranked ${N} presets via ${matches} matches in ${elapsed}s`);
for (const [i, r] of rows.entries()) {
  console.log(`  #${i + 1}  ${r.name.padEnd(12)} wr=${(r.wr * 100).toFixed(1)}%  ${r.wins}w ${r.losses}l ${r.draws}d`);
}
console.log(`tiers: easy=${tiers.easy}  medium=${tiers.medium}  hard=${tiers.hard}`);

const doc = {
  version: 1,
  computedAt: new Date().toISOString(),
  seedsPerPairing: SEEDS,
  totalMatches: matches,
  rows,
  tiers,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.mkdirSync(path.dirname(CLIENT_OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");
fs.writeFileSync(CLIENT_OUT, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${OUT}`);
console.log(`wrote ${CLIENT_OUT}`);
