#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  replayArtifactToResultV1,
  replayArtifactWarningsV1,
  verifyReplayIntegrityV1,
  type ReplayArtifactV1,
} from "@m3t4/sim";
import { CONFIG } from "./config.js";
import { FileStableStore } from "./stable.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "1";
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional[0]) out.matchId = positional[0];
  return out;
}

function defaultStorePath(): string {
  if (process.env.STORE_PATH) return process.env.STORE_PATH;
  return path.join(__dirname, "..", "data", "m3t4.json");
}

function printUsage(): never {
  console.error("Usage: node server/dist/inspect-replay.js <matchId> [--store path] [--json] [--no-verify]");
  process.exit(2);
}

function summarizeReplay(artifact: ReplayArtifactV1, verified: ReturnType<typeof replayArtifactToResultV1> | null): object {
  return {
    matchId: artifact.match.matchId,
    mode: artifact.match.mode,
    stageId: artifact.match.stageId,
    seed: artifact.match.seed,
    createdAt: artifact.createdAt,
    startedAt: artifact.match.startedAt,
    sim: artifact.sim,
    players: artifact.players.map((p) => ({
      side: p.side,
      kind: p.kind,
      tier: p.tier,
      label: p.label,
      handle: p.handle,
      userId: p.userId,
      slotId: p.slotId,
      slotName: p.slotName,
      configHash: p.configHash,
      hasConfig: !!p.config,
    })),
    actions: {
      encoding: artifact.actions.encoding,
      byteLength: artifact.actions.byteLength,
      decisionTicks: artifact.actions.decisionTicks,
      hash: artifact.actions.hash,
    },
    result: artifact.result,
    warnings: replayArtifactWarningsV1(artifact),
    verified: verified
      ? {
          consumedBytes: verified.consumedBytes,
          consumedDecisionTicks: verified.consumedDecisionTicks,
          result: verified.result,
        }
      : false,
  };
}

function printSummary(summary: ReturnType<typeof summarizeReplay>): void {
  const s = summary as {
    matchId: string;
    mode: string;
    stageId: string;
    seed: number;
    createdAt: string;
    startedAt?: string;
    players: Array<{ side: number; label: string; handle?: string; configHash?: string; hasConfig: boolean }>;
    actions: { byteLength: number; decisionTicks: number; hash: string };
    result: { winner: 0 | 1 | -1; finalScore: [number, number]; finalRounds: [number, number]; ticks: number; logHash: string };
    warnings: string[];
    verified: false | { consumedBytes: number; consumedDecisionTicks: number };
  };
  console.log(`match ${s.matchId}`);
  console.log(`mode=${s.mode} stage=${s.stageId} seed=${s.seed}`);
  console.log(`created=${s.createdAt}${s.startedAt ? ` started=${s.startedAt}` : ""}`);
  for (const p of s.players) {
    console.log(`P${p.side + 1}: ${p.handle ? `@${p.handle} ` : ""}${p.label} config=${p.hasConfig ? "yes" : "no"} hash=${p.configHash ?? "-"}`);
  }
  console.log(`actions bytes=${s.actions.byteLength} decisionTicks=${s.actions.decisionTicks} hash=${s.actions.hash}`);
  console.log(`result winner=${s.result.winner} score=${s.result.finalScore.join("-")} rounds=${s.result.finalRounds.join("-")} ticks=${s.result.ticks} logHash=${s.result.logHash}`);
  console.log(`verify=${s.verified ? `ok bytes=${s.verified.consumedBytes}` : "skipped"}`);
  if (s.warnings.length) console.log(`warnings=${s.warnings.join("; ")}`);
}

const args = parseArgs(process.argv);
const matchId = args.matchId;
if (!matchId) printUsage();

const storePath = args.store ?? CONFIG.storePath ?? defaultStorePath();
const store = new FileStableStore(storePath);
const artifact = await store.getReplay(matchId);
if (!artifact) {
  console.error(`Replay not found: ${matchId}`);
  process.exit(1);
}

verifyReplayIntegrityV1(artifact);
const verified = args["no-verify"] ? null : replayArtifactToResultV1(artifact);

if (args.json) {
  console.log(JSON.stringify({
    artifact,
    summary: summarizeReplay(artifact, verified),
  }, null, 2));
} else {
  printSummary(summarizeReplay(artifact, verified));
}
