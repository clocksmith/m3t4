// Worker thread: reads match tasks over MessagePort, runs simulate(),
// emits results. Spawned by ../src/parallel.ts.

import { parentPort, workerData } from "node:worker_threads";
import { simulate, STAGES, type BrainConfig } from "@m3t4/sim";

interface MatchTask {
  id: number;
  a: BrainConfig;
  b: BrainConfig;
  stageId: keyof typeof STAGES;
  seed: number;
}

interface MatchOutcome {
  id: number;
  winner: 0 | 1 | -1;
  finalScore: [number, number];
  finalRounds: [number, number];
  ticks: number;
  logHash: string;
}

if (!parentPort) throw new Error("worker must be spawned as a Worker");

parentPort.on("message", (task: MatchTask) => {
  const stage = STAGES[task.stageId];
  const r = simulate({ stage, brainA: task.a, brainB: task.b, seed: task.seed });
  const out: MatchOutcome = {
    id: task.id,
    winner: r.winner,
    finalScore: r.finalScore,
    finalRounds: r.finalRounds,
    ticks: r.ticks,
    logHash: r.logHash,
  };
  parentPort!.postMessage(out);
});

// Keep TS happy about unused workerData
void workerData;
