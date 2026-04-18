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
  console.error("Usage: node server/dist/inspect-replay.js <matchId> [--store path] [--json] [--no-verify] [--redact] [--allow-constants-mismatch]");
  console.error("  --no-verify                  skip decode/replay (still runs integrity check)");
  console.error("  --redact                     omit players[i].config from --json output (safe to share)");
  console.error("  --allow-constants-mismatch   decode ranked artifacts whose constantsHash disagrees with the");
  console.error("                               current build (archival inspection; results are NOT faithful)");
  process.exit(2);
}

interface ReplayInspectionSummary {
  matchId: string;
  mode: string;
  stageId: string;
  seed: number;
  createdAt: string;
  startedAt?: string;
  sim: ReplayArtifactV1["sim"];
  players: Array<{
    side: 0 | 1;
    kind: string;
    tier?: string;
    label: string;
    handle?: string;
    userId?: string;
    slotId?: string;
    slotName?: string;
    configHash?: string;
    hasConfig: boolean;
  }>;
  actions: {
    encoding: string;
    byteLength: number;
    decisionTicks: number;
    hash: string;
  };
  result: ReplayArtifactV1["result"];
  warnings: string[];
  integrity: "ok" | "failed" | "skipped";
  integrityError?: string;
  verified:
    | false
    | { consumedBytes: number; consumedDecisionTicks: number; result: ReplayArtifactV1["result"] };
  verifyError?: string;
}

function summarizeReplay(
  artifact: ReplayArtifactV1,
  integrity: { status: "ok" | "failed" | "skipped"; error?: string },
  verified: ReturnType<typeof replayArtifactToResultV1> | null,
  verifyError?: string,
): ReplayInspectionSummary {
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
    integrity: integrity.status,
    integrityError: integrity.error,
    verified: verified
      ? {
          consumedBytes: verified.consumedBytes,
          consumedDecisionTicks: verified.consumedDecisionTicks,
          result: verified.result,
        }
      : false,
    verifyError,
  };
}

function printSummary(s: ReplayInspectionSummary): void {
  console.log(`match ${s.matchId}`);
  console.log(`mode=${s.mode} stage=${s.stageId} seed=${s.seed}`);
  console.log(`created=${s.createdAt}${s.startedAt ? ` started=${s.startedAt}` : ""}`);
  for (const p of s.players) {
    console.log(`P${p.side + 1}: ${p.handle ? `@${p.handle} ` : ""}${p.label} config=${p.hasConfig ? "yes" : "no"} hash=${p.configHash ?? "-"}`);
  }
  console.log(`actions bytes=${s.actions.byteLength} decisionTicks=${s.actions.decisionTicks} hash=${s.actions.hash}`);
  console.log(`result winner=${s.result.winner} score=${s.result.finalScore.join("-")} rounds=${s.result.finalRounds.join("-")} ticks=${s.result.ticks} logHash=${s.result.logHash}`);
  console.log(`integrity=${s.integrity}${s.integrityError ? ` (${s.integrityError})` : ""}`);
  if (s.verified) console.log(`verify=ok bytes=${s.verified.consumedBytes}`);
  else if (s.verifyError) console.log(`verify=failed (${s.verifyError})`);
  else console.log(`verify=skipped`);
  if (s.warnings.length) console.log(`warnings=${s.warnings.join("; ")}`);
}

const args = parseArgs(process.argv);
const matchId = args.matchId;
if (!matchId) printUsage();

const storePath = args.store ?? CONFIG.storePath ?? defaultStorePath();
const store = new FileStableStore(storePath, { readOnly: true });
const artifact = await store.getReplay(matchId);
if (!artifact) {
  console.error(`Replay not found: ${matchId}`);
  process.exit(1);
}

// Integrity + decode run independently so a failure in one doesn't hide the
// other context. Forensic intent: always print what we have, then surface
// specific failures at the end.
let integrity: { status: "ok" | "failed" | "skipped"; error?: string };
try {
  verifyReplayIntegrityV1(artifact);
  integrity = { status: "ok" };
} catch (err) {
  integrity = { status: "failed", error: err instanceof Error ? err.message : String(err) };
}

let verified: ReturnType<typeof replayArtifactToResultV1> | null = null;
let verifyError: string | undefined;
if (args["no-verify"]) {
  // Left as null; summary reports "skipped".
} else if (integrity.status === "failed") {
  verifyError = "skipped: integrity failed";
} else {
  try {
    verified = replayArtifactToResultV1(artifact, {
      allowConstantsMismatch: !!args["allow-constants-mismatch"],
    });
  } catch (err) {
    verifyError = err instanceof Error ? err.message : String(err);
  }
}

const summary = summarizeReplay(artifact, integrity, verified, verifyError);

if (args.json) {
  const exported: ReplayArtifactV1 = args.redact
    ? {
        ...artifact,
        players: [
          { ...artifact.players[0], config: undefined } as ReplayArtifactV1["players"][0],
          { ...artifact.players[1], config: undefined } as ReplayArtifactV1["players"][1],
        ] as ReplayArtifactV1["players"],
      }
    : artifact;
  console.log(JSON.stringify({ artifact: exported, summary }, null, 2));
} else {
  printSummary(summary);
}

// Exit non-zero on failures so CI/scripts can detect tampered artifacts.
if (integrity.status === "failed" || verifyError) process.exit(1);
