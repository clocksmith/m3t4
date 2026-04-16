// Quick verification: the pre-nerf 85% bot should drop substantially under
// new rules (budget 200 is still respected, but 0.5s dwell kills delivery
// cheese).

import fs from "node:fs";
import os from "node:os";
import { STAGES, STRATEGIES, STRATEGY_NAMES, type BrainConfig } from "@selfplay/sim";
import { scoreBatch } from "./score.js";

const PRE_PATH = process.argv[2] ?? "/tmp/budget-best.json";
const POST_PATH = process.argv[3] ?? "/tmp/budget-post-nerf.json";

const refs = STRATEGY_NAMES.map((n) => STRATEGIES[n]);
const stages = Object.values(STAGES);
const WORKERS = os.cpus().length;

console.log(`\n# Nerf verification\n`);

async function evaluate(label: string, cfg: BrainConfig): Promise<number> {
  console.error(`  scoring ${label} (${cfg.id})...`);
  const recs = await scoreBatch({
    candidates: [cfg], references: refs, stages,
    seedsPerMatchup: 3, workers: WORKERS,
  });
  return recs[0].winRate;
}

// Old exploit: 194-pt pure shipper from pre-nerf evolution
let preCfg: BrainConfig;
if (fs.existsSync(PRE_PATH)) {
  const raw = JSON.parse(fs.readFileSync(PRE_PATH, "utf8"));
  preCfg = raw.bestEver?.config ?? raw.config ?? raw;
} else {
  console.error(`missing ${PRE_PATH} — run evolve-budget first`);
  process.exit(1);
}

// Current best: from post-nerf evolve
let postCfg: BrainConfig | null = null;
if (fs.existsSync(POST_PATH)) {
  const raw = JSON.parse(fs.readFileSync(POST_PATH, "utf8"));
  postCfg = raw.bestEver?.config ?? raw.config ?? raw;
}

// Also a dumb-shipper control: pure delivery, max shipRate
const dumbShipper: BrainConfig = {
  id: "dumb-shipper-control",
  attributes: {
    burnRate: 0, moat: 0, shipRate: 1.0, foresight: 0,
    pivotSpeed: 0, leverage: 0, networking: 0, hallucination: 0,
  },
};

const preWr = await evaluate("pre-nerf 85% bot", preCfg);
const dumbWr = await evaluate("dumb pure-shipper", dumbShipper);
const postWr = postCfg ? await evaluate("post-nerf best", postCfg) : 0;

console.log(`\n| bot | pre-nerf WR claim | now (w/ dwell) | Δ |`);
console.log(`|---|---|---|---|`);
console.log(`| ${preCfg.id} (194 pts pre-nerf exploit) | 85.0% | **${(preWr * 100).toFixed(1)}%** | ${((preWr - 0.85) * 100).toFixed(1)}% |`);
console.log(`| dumb-shipper (max shipRate, nothing else) | untested | **${(dumbWr * 100).toFixed(1)}%** | — |`);
if (postCfg) {
  console.log(`| ${postCfg.id} (post-nerf evolved) | — | **${(postWr * 100).toFixed(1)}%** | — |`);
}

console.log(`\n## Verdict`);
if (preWr < 0.6) {
  console.log(`✓ Dwell-time nerf successfully neutralized the shipper exploit (${(preWr * 100).toFixed(1)}% << 85%)`);
} else if (preWr < 0.75) {
  console.log(`~ Partial nerf: ${(preWr * 100).toFixed(1)}% (was 85%). Good improvement but shipper-style still strong`);
} else {
  console.log(`✗ Nerf ineffective: bot still at ${(preWr * 100).toFixed(1)}%. Need to tighten further.`);
}
