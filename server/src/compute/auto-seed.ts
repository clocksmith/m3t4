import { replayHashJson, stableReplayJson, type ReplayArtifactV1 } from "@m3t4/sim";
import { publicReplayArtifactFromReplay } from "../public-artifacts.js";

export interface ComputeAutoSeedConfig {
  enabled: boolean;
  replayTasksEnabled?: boolean;
  computeLabOrigin: string;
  adminToken?: string;
  timeoutMs?: number;
  seedSweep?: ComputeAutoSeedSweepConfig;
  tensorTile?: ComputeAutoSeedTensorTileConfig;
}

export interface ComputeAutoSeedSweepConfig {
  enabled: boolean;
  stageId?: string;
  brainA?: string;
  brainB?: string;
  seedCount?: number;
  seedChunkSize?: number;
  maxTicks?: number;
  minExecutions?: number;
  minAgreeing?: number;
  requiredTransport?: "http" | "webrtc";
  requiredPeerSubreceipt?: boolean;
}

export interface ComputeAutoSeedTensorTileConfig {
  enabled: boolean;
  rows?: number;
  cols?: number;
  depth?: number;
  minExecutions?: number;
  minAgreeing?: number;
  requiredTransport?: "http" | "webrtc";
  requiredPeerSubreceipt?: boolean;
}

export interface ComputeAutoSeedResult {
  endpoint: string;
  ok: boolean;
  status: number;
  taskId?: string;
  error?: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json" | "text">>;

export async function seedReplayComputeTasks(
  config: ComputeAutoSeedConfig,
  replay: ReplayArtifactV1,
  fetchImpl: FetchLike = fetch,
): Promise<ComputeAutoSeedResult[]> {
  const origin = config.computeLabOrigin.replace(/\/+$/, "");
  if (!config.enabled || !origin || !config.adminToken) return [];
  const requests: Array<{ endpoint: string; body: unknown }> = [];
  if (config.replayTasksEnabled !== false) {
    const redactedReplay = redactedReplayForCompute(replay);
    const publicArtifact = publicReplayArtifactFromReplay(replay);
    requests.push(
      {
        endpoint: "/compute/admin/tasks/public-artifact",
        body: { artifact: publicArtifact, minExecutions: 2, minAgreeing: 2 },
      },
      {
        endpoint: "/compute/admin/tasks/replay-verify",
        body: { replayArtifact: redactedReplay, artifactSha256: undefined, minExecutions: 2, minAgreeing: 2 },
      },
    );
  }
  const seedSweep = seedSweepRequest(config.seedSweep, replay);
  if (seedSweep) requests.push(seedSweep);
  const tensorTile = tensorTileRequest(config.tensorTile, replay);
  if (tensorTile) requests.push(tensorTile);
  const out: ComputeAutoSeedResult[] = [];
  for (const request of requests) {
    out.push(await postComputeSeedTask({
      url: origin + request.endpoint,
      endpoint: request.endpoint,
      adminToken: config.adminToken,
      body: request.body,
      timeoutMs: config.timeoutMs ?? 1500,
      fetchImpl,
    }));
  }
  return out;
}

export function redactedReplayForCompute(replay: ReplayArtifactV1): ReplayArtifactV1 {
  return JSON.parse(stableReplayJson({
    ...replay,
    players: replay.players.map((player) => {
      const { config: _config, ...publicPlayer } = player;
      return publicPlayer;
    }),
  })) as ReplayArtifactV1;
}

function seedSweepRequest(
  config: ComputeAutoSeedSweepConfig | undefined,
  replay: ReplayArtifactV1,
): { endpoint: string; body: Record<string, unknown> } | null {
  if (!config?.enabled) return null;
  const seedCount = clampInt(config.seedCount ?? 32, 1, 512);
  const seedChunkSize = clampInt(config.seedChunkSize ?? 8, 1, Math.min(64, seedCount));
  const seedStart = deterministicSeedStart(replay);
  return {
    endpoint: "/compute/admin/tasks/seed-sweep",
    body: {
      stageId: config.stageId || replay.match.stageId || "boardroom",
      brainA: config.brainA || "unicorn",
      brainB: config.brainB || "disruptor",
      seedStart,
      seedEndExclusive: seedStart + seedCount,
      seedChunkSize,
      ...(config.maxTicks === undefined ? {} : { maxTicks: config.maxTicks }),
      minExecutions: config.minExecutions ?? 2,
      minAgreeing: config.minAgreeing ?? 2,
      ...(config.requiredTransport === undefined ? {} : { requiredTransport: config.requiredTransport }),
      ...(config.requiredPeerSubreceipt === undefined ? {} : { requiredPeerSubreceipt: config.requiredPeerSubreceipt }),
    },
  };
}

function tensorTileRequest(
  config: ComputeAutoSeedTensorTileConfig | undefined,
  replay: ReplayArtifactV1,
): { endpoint: string; body: Record<string, unknown> } | null {
  if (!config?.enabled) return null;
  return {
    endpoint: "/compute/admin/tasks/tensor-tile",
    body: {
      seed: deterministicTensorSeed(replay),
      rows: clampInt(config.rows ?? 16, 1, 64),
      cols: clampInt(config.cols ?? 16, 1, 64),
      depth: clampInt(config.depth ?? 32, 1, 256),
      minExecutions: config.minExecutions ?? 2,
      minAgreeing: config.minAgreeing ?? 2,
      ...(config.requiredTransport === undefined ? {} : { requiredTransport: config.requiredTransport }),
      ...(config.requiredPeerSubreceipt === undefined ? {} : { requiredPeerSubreceipt: config.requiredPeerSubreceipt }),
    },
  };
}

function deterministicSeedStart(replay: ReplayArtifactV1): number {
  const hash = replayHashJson({
    matchId: replay.match.matchId,
    seed: replay.match.seed,
    stageId: replay.match.stageId,
  });
  return parseInt(hash, 16) % 2_000_000_000;
}

function deterministicTensorSeed(replay: ReplayArtifactV1): number {
  const hash = replayHashJson({
    matchId: replay.match.matchId,
    seed: replay.match.seed,
    stageId: replay.match.stageId,
    purpose: "tensor-tile",
  });
  return parseInt(hash, 16) % 2_000_000_000;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

async function postComputeSeedTask(input: {
  url: string;
  endpoint: string;
  adminToken: string;
  body: unknown;
  timeoutMs: number;
  fetchImpl: FetchLike;
}): Promise<ComputeAutoSeedResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchImpl(input.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-plasma-admin-token": input.adminToken,
      },
      body: JSON.stringify(input.body),
    });
    const body = await safeJson(response);
    return {
      endpoint: input.endpoint,
      ok: response.ok,
      status: response.status,
      taskId: typeof body?.taskId === "string" ? body.taskId : undefined,
      error: response.ok ? undefined : stringValue(body?.error) ?? await safeText(response),
    };
  } catch (e) {
    return {
      endpoint: input.endpoint,
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function safeJson(response: Pick<Response, "json">): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function safeText(response: Pick<Response, "text">): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
