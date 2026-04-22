import { simulate } from "./simulate.js";
import type { BrainConfig, Stage } from "./types.js";

export type ReciprocalSideBiasOptions = {
  stage: Stage;
  brainA: BrainConfig;
  brainB: BrainConfig;
  seeds: number[];
};

export type ReciprocalSideBiasResult = {
  samples: number;
  aWinsAsP0: number;
  aWinsAsP1: number;
  bWinsAsP0: number;
  bWinsAsP1: number;
  drawsAsP0: number;
  drawsAsP1: number;
  aWinRateAsP0: number;
  aWinRateAsP1: number;
  sideBias: number;
  reciprocalDisagreements: number;
};

function winRate(wins: number, draws: number, samples: number): number {
  const decided = samples - draws;
  return decided > 0 ? wins / decided : 0;
}

function resultForA(winner: -1 | 0 | 1, aSide: 0 | 1): -1 | 0 | 1 {
  if (winner === -1) return -1;
  return winner === aSide ? 1 : 0;
}

export function evaluateReciprocalSideBias(opts: ReciprocalSideBiasOptions): ReciprocalSideBiasResult {
  const seeds = opts.seeds.map((seed) => seed >>> 0);
  let aWinsAsP0 = 0;
  let aWinsAsP1 = 0;
  let bWinsAsP0 = 0;
  let bWinsAsP1 = 0;
  let drawsAsP0 = 0;
  let drawsAsP1 = 0;
  let reciprocalDisagreements = 0;

  for (const seed of seeds) {
    const ab = simulate({ stage: opts.stage, brainA: opts.brainA, brainB: opts.brainB, seed });
    const ba = simulate({ stage: opts.stage, brainA: opts.brainB, brainB: opts.brainA, seed });

    if (ab.winner === 0) aWinsAsP0++;
    else if (ab.winner === 1) bWinsAsP1++;
    else drawsAsP0++;

    if (ba.winner === 1) aWinsAsP1++;
    else if (ba.winner === 0) bWinsAsP0++;
    else drawsAsP1++;

    if (resultForA(ab.winner, 0) !== resultForA(ba.winner, 1)) {
      reciprocalDisagreements++;
    }
  }

  const samples = seeds.length;
  const aWinRateAsP0 = winRate(aWinsAsP0, drawsAsP0, samples);
  const aWinRateAsP1 = winRate(aWinsAsP1, drawsAsP1, samples);
  return {
    samples,
    aWinsAsP0,
    aWinsAsP1,
    bWinsAsP0,
    bWinsAsP1,
    drawsAsP0,
    drawsAsP1,
    aWinRateAsP0,
    aWinRateAsP1,
    sideBias: aWinRateAsP0 - aWinRateAsP1,
    reciprocalDisagreements,
  };
}
