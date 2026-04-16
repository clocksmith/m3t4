// Run matches across worker threads. Blocks until all matches complete.
// The main thread should batch up all pairings and let the pool chew through
// them. A 10-core laptop gets ~9x over a single-threaded sweep.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { STAGES, type BrainConfig } from "@m3t4/sim";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface MatchSpec {
  a: BrainConfig;
  b: BrainConfig;
  stageId: keyof typeof STAGES;
  seed: number;
  meta?: Record<string, unknown>; // passthrough for caller bookkeeping
}

export interface MatchOutcome {
  spec: MatchSpec;
  winner: 0 | 1 | -1;
  finalScore: [number, number];
  finalRounds: [number, number];
  ticks: number;
  logHash: string;
}

export interface PoolOptions {
  workers?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function runMatches(matches: MatchSpec[], opts: PoolOptions = {}): Promise<MatchOutcome[]> {
  const numWorkers = Math.max(1, Math.min(opts.workers ?? os.cpus().length, matches.length));
  if (numWorkers === 1) return runMatchesSerial(matches, opts);

  const workerPath = path.resolve(__dirname, "worker.js");
  const workers: Worker[] = [];
  for (let i = 0; i < numWorkers; i++) workers.push(new Worker(workerPath));

  const results = new Array<MatchOutcome | null>(matches.length).fill(null);
  let done = 0;
  let dispatched = 0;
  let finished = false;

  return new Promise<MatchOutcome[]>((resolve, reject) => {
    const dispatchTo = (worker: Worker) => {
      if (dispatched >= matches.length) return; // nothing more to do; worker idles
      const id = dispatched++;
      const m = matches[id];
      worker.postMessage({ id, a: m.a, b: m.b, stageId: m.stageId, seed: m.seed });
    };

    const finishAll = () => {
      finished = true;
      for (const w of workers) w.terminate().catch(() => {});
      resolve(results as MatchOutcome[]);
    };

    for (const w of workers) {
      w.on("message", (outcome: { id: number } & Omit<MatchOutcome, "spec">) => {
        results[outcome.id] = { ...outcome, spec: matches[outcome.id] };
        done++;
        if (opts.onProgress) opts.onProgress(done, matches.length);
        if (done === matches.length) finishAll();
        else dispatchTo(w);
      });
      w.on("error", (e) => { if (!finished) reject(e); });
      w.on("exit", (code) => {
        if (!finished && code !== 0 && done < matches.length) {
          reject(new Error(`worker exited ${code}`));
        }
      });
      dispatchTo(w);
    }
  });
}

async function runMatchesSerial(matches: MatchSpec[], opts: PoolOptions): Promise<MatchOutcome[]> {
  const { simulate } = await import("@m3t4/sim");
  const { STAGES: S } = await import("@m3t4/sim");
  const out: MatchOutcome[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const stage = S[m.stageId];
    const r = simulate({ stage, brainA: m.a, brainB: m.b, seed: m.seed });
    out.push({
      spec: m,
      winner: r.winner,
      finalScore: r.finalScore,
      finalRounds: r.finalRounds,
      ticks: r.ticks,
      logHash: r.logHash,
    });
    if (opts.onProgress) opts.onProgress(i + 1, matches.length);
  }
  return out;
}
