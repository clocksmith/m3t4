// Recorded-match analyzer. Runs N matches between specified configs and
// pulls behavioral metrics from each trace. Surfaces dumbness:
//   - head-on same-Y approach rate
//   - clash frequency + re-clash rate (stalemates)
//   - swipe/dive counts (too passive?)
//   - time to first kill, time to deliver
//   - stuck intervals (no movement)

import { STAGES, STRATEGIES, STRATEGY_NAMES, simulateTrace, type BrainConfig, type TraceFrame } from "@m3t4/sim";

interface MatchStats {
  pair: [string, string];
  stage: string;
  seed: number;
  ticks: number;
  winner: number;
  finalScore: [number, number];
  finalRounds: [number, number];
  avgDist: number;
  minDist: number;
  timeInClashRange: number;   // % ticks with dist < 100
  timeAtSameY: number;        // % ticks with |dy| < 30 AND dist < 200
  timeSameYClashRange: number;// % ticks with |dy| < 30 AND dist < 100 (the worst pattern)
  p0Swipes: number;
  p1Swipes: number;
  p0Dives: number;
  p1Dives: number;
  clashBursts: number;        // clusters of hits within 60 ticks (proxy for stalemate)
  p0Kills: number;
  p1Kills: number;
  doubleKOs: number;          // same-tick mutual deaths
  p0LongestStall: number;     // max ticks without >20px displacement
  p1LongestStall: number;
  timeToFirstKill: number;    // ticks until first fighter dies
}

function analyzeMatch(pair: [string, string], stage: string, seed: number): MatchStats {
  const brainA = STRATEGIES[pair[0] as keyof typeof STRATEGIES];
  const brainB = STRATEGIES[pair[1] as keyof typeof STRATEGIES];
  const stg = STAGES[stage as keyof typeof STAGES];
  const result = simulateTrace({ stage: stg, brainA, brainB, seed });
  const frames = result.frames;

  let sumDist = 0;
  let minDist = Infinity;
  let clashRangeTicks = 0;
  let sameYTicks = 0;
  let sameYClashTicks = 0;
  let p0Swipes = 0, p1Swipes = 0;
  let p0Dives = 0, p1Dives = 0;
  let p0Kills = 0, p1Kills = 0;
  let doubleKOs = 0;
  let timeToFirstKill = frames.length;

  // Stall tracking: windows of 30 ticks of <20px displacement
  let p0StallTicks = 0, p1StallTicks = 0;
  let p0LongestStall = 0, p1LongestStall = 0;
  let p0LastX = frames[0]?.p0.x ?? 0, p0LastY = frames[0]?.p0.y ?? 0;
  let p1LastX = frames[0]?.p1.x ?? 0, p1LastY = frames[0]?.p1.y ?? 0;
  let prevP0Swipe = 0, prevP1Swipe = 0;
  let prevP0Dive = 0, prevP1Dive = 0;
  let prevP0Dead = false, prevP1Dead = false;
  const killTicks: number[] = [];

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const dx = f.p1.x - f.p0.x;
    const dy = f.p1.y - f.p0.y;
    const d = Math.hypot(dx, dy);
    sumDist += d;
    if (d < minDist) minDist = d;
    if (d < 100) clashRangeTicks++;
    if (Math.abs(dy) < 30 && d < 200) sameYTicks++;
    if (Math.abs(dy) < 30 && d < 100) sameYClashTicks++;

    // Attack edge detection
    if (prevP0Swipe === 0 && f.p0.swipeT > 0) p0Swipes++;
    if (prevP1Swipe === 0 && f.p1.swipeT > 0) p1Swipes++;
    if (prevP0Dive === 0 && f.p0.diveT > 0) p0Dives++;
    if (prevP1Dive === 0 && f.p1.diveT > 0) p1Dives++;
    prevP0Swipe = f.p0.swipeT;
    prevP1Swipe = f.p1.swipeT;
    prevP0Dive = f.p0.diveT;
    prevP1Dive = f.p1.diveT;

    // Death edge detection
    const p0JustDied = !prevP0Dead && f.p0.dead;
    const p1JustDied = !prevP1Dead && f.p1.dead;
    if (p0JustDied && p1JustDied) {
      doubleKOs++;
      killTicks.push(i);
    } else if (p1JustDied) {
      p0Kills++;
      killTicks.push(i);
    } else if (p0JustDied) {
      p1Kills++;
      killTicks.push(i);
    }
    if ((p0JustDied || p1JustDied) && timeToFirstKill === frames.length) {
      timeToFirstKill = i;
    }
    prevP0Dead = f.p0.dead;
    prevP1Dead = f.p1.dead;

    // Stall tracking — sample every 30 ticks
    if (i % 30 === 0 && i > 0) {
      const p0Moved = Math.hypot(f.p0.x - p0LastX, f.p0.y - p0LastY);
      const p1Moved = Math.hypot(f.p1.x - p1LastX, f.p1.y - p1LastY);
      if (p0Moved < 20) p0StallTicks += 30; else { p0LongestStall = Math.max(p0LongestStall, p0StallTicks); p0StallTicks = 0; }
      if (p1Moved < 20) p1StallTicks += 30; else { p1LongestStall = Math.max(p1LongestStall, p1StallTicks); p1StallTicks = 0; }
      p0LastX = f.p0.x; p0LastY = f.p0.y;
      p1LastX = f.p1.x; p1LastY = f.p1.y;
    }
  }
  p0LongestStall = Math.max(p0LongestStall, p0StallTicks);
  p1LongestStall = Math.max(p1LongestStall, p1StallTicks);

  // Clash bursts: count clusters of kill events within 60-tick windows
  let clashBursts = 0;
  let burstStart = -Infinity;
  for (const t of killTicks) {
    if (t - burstStart > 60) clashBursts++;
    burstStart = t;
  }

  return {
    pair,
    stage,
    seed,
    ticks: result.result.ticks,
    winner: result.result.winner,
    finalScore: result.result.finalScore,
    finalRounds: result.result.finalRounds,
    avgDist: sumDist / frames.length,
    minDist,
    timeInClashRange: clashRangeTicks / frames.length,
    timeAtSameY: sameYTicks / frames.length,
    timeSameYClashRange: sameYClashTicks / frames.length,
    p0Swipes, p1Swipes, p0Dives, p1Dives,
    clashBursts,
    p0Kills, p1Kills, doubleKOs,
    p0LongestStall, p1LongestStall,
    timeToFirstKill,
  };
}

function printStats(s: MatchStats): void {
  const ticksToSec = (t: number) => (t / 120).toFixed(1);
  console.log(`\n${s.pair[0]} vs ${s.pair[1]} @ ${s.stage} (seed=${s.seed})`);
  console.log(`  duration=${ticksToSec(s.ticks)}s  winner=P${s.winner + 1}  final=${s.finalRounds[0]}-${s.finalRounds[1]} rounds  ${s.finalScore[0]}-${s.finalScore[1]} pts`);
  console.log(`  kills P${0 + 1}=${s.p0Kills} P${1 + 1}=${s.p1Kills}  doubleKOs=${s.doubleKOs}  firstKill@${ticksToSec(s.timeToFirstKill)}s  totalKills=${s.p0Kills + s.p1Kills + s.doubleKOs * 2}`);
  console.log(`  swipes P1=${s.p0Swipes} P2=${s.p1Swipes}  dives P1=${s.p0Dives} P2=${s.p1Dives}  attacks/min P1=${((s.p0Swipes + s.p0Dives) / (s.ticks / 7200)).toFixed(1)} P2=${((s.p1Swipes + s.p1Dives) / (s.ticks / 7200)).toFixed(1)}`);
  console.log(`  avgDist=${s.avgDist.toFixed(0)}px  minDist=${s.minDist.toFixed(0)}px`);
  console.log(`  timeInClashRange=${(s.timeInClashRange * 100).toFixed(1)}%  sameY=${(s.timeAtSameY * 100).toFixed(1)}%  sameY+clashRange=${(s.timeSameYClashRange * 100).toFixed(1)}%`);
  console.log(`  stall P1=${ticksToSec(s.p0LongestStall)}s  P2=${ticksToSec(s.p1LongestStall)}s`);
}

// Pairings — mix of dominant vs weak, similar vs different, same vs distinct archetypes.
const pairings: Array<[string, string, string, number]> = [
  ["unicorn", "founder", "datacenter", 42],          // strong vs joke-weak
  ["unicorn", "disruptor", "boardroom", 101],        // two strong specialists
  ["blitz", "incumbent", "demoday", 7],              // aggressor vs fortifier
  ["acquirer", "troll", "datacenter", 55],           // close-pressure vs bait
  ["oracle", "moonshot", "boardroom", 23],           // foresight vs chaos
  ["pivot", "shipper", "demoday", 88],               // dodger vs deliverer
  ["regulatory", "acolyte", "datacenter", 13],       // patient vs chaotic
  ["operator", "operator", "boardroom", 99],         // mirror (test desync)
  ["unicorn", "unicorn", "datacenter", 77],          // dominant mirror
  ["intern", "intern", "demoday", 33],               // minimalist mirror
];

console.log(`# Match analyzer — ${pairings.length} pairings on the final brain/roster\n`);
const allStats: MatchStats[] = [];
for (const [a, b, stg, seed] of pairings) {
  const s = analyzeMatch([a, b], stg, seed);
  allStats.push(s);
  printStats(s);
}

// Aggregate patterns
console.log(`\n## Aggregate patterns\n`);
const total = allStats.length;
const avg = (f: (s: MatchStats) => number) => allStats.reduce((a, s) => a + f(s), 0) / total;
const totalDoubleKOs = allStats.reduce((a, s) => a + s.doubleKOs, 0);
const totalKills = allStats.reduce((a, s) => a + s.p0Kills + s.p1Kills, 0);
console.log(`- mean duration: ${(avg(s => s.ticks) / 120).toFixed(1)}s`);
console.log(`- mean avg-dist: ${avg(s => s.avgDist).toFixed(0)}px`);
console.log(`- mean time in clash range: ${(avg(s => s.timeInClashRange) * 100).toFixed(1)}%`);
console.log(`- mean time at same Y: ${(avg(s => s.timeAtSameY) * 100).toFixed(1)}%`);
console.log(`- mean time same-Y + clash-range: ${(avg(s => s.timeSameYClashRange) * 100).toFixed(1)}%`);
console.log(`- mean attacks/min: ${(avg(s => (s.p0Swipes + s.p1Swipes + s.p0Dives + s.p1Dives) / (s.ticks / 7200))).toFixed(1)}`);
console.log(`- total kills: ${totalKills}  double-KOs: ${totalDoubleKOs}  double-KO rate: ${(totalDoubleKOs / (totalKills + totalDoubleKOs) * 100).toFixed(1)}%`);
console.log(`- mean longest stall: P1=${(avg(s => s.p0LongestStall) / 120).toFixed(1)}s P2=${(avg(s => s.p1LongestStall) / 120).toFixed(1)}s`);
