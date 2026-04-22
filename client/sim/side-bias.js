import { simulate } from "./simulate.js";
function winRate(wins, draws, samples) {
    const decided = samples - draws;
    return decided > 0 ? wins / decided : 0;
}
function resultForA(winner, aSide) {
    if (winner === -1)
        return -1;
    return winner === aSide ? 1 : 0;
}
export function evaluateReciprocalSideBias(opts) {
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
        if (ab.winner === 0)
            aWinsAsP0++;
        else if (ab.winner === 1)
            bWinsAsP1++;
        else
            drawsAsP0++;
        if (ba.winner === 1)
            aWinsAsP1++;
        else if (ba.winner === 0)
            bWinsAsP0++;
        else
            drawsAsP1++;
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
