// Battle-anchored compute bundle orchestration for the firehose matchmaker.
//
// At match start we call plasma-lab to materialize a science bundle
// (contact-map tiles over a public preset, adaptive-sized). The returned
// bundleId is broadcast on the matchStart event so spectator clients can
// poll /compute/public/bundles/:bundleId for live progress — no new WS
// multiplex needed, the plasma-lab aggregate is cached-public-read.
//
// At match end we seal the science bundle against the public replay
// artifact's sha256 (that is the canonical battle-receipt hash) and
// materialize a proof bundle pointing at the replay_verify task that
// re-executes the full match under quorum.

import { publicReplayArtifactFromReplay } from "../public-artifacts.js";
import type { ReplayArtifactV1 } from "@m3t4/sim";

export interface BundleClientConfig {
  enabled: boolean;
  computeLabOrigin: string;
  adminToken?: string;
  timeoutMs?: number;
}

export interface MaterializedBundle {
  bundleId: string;
  kernelId: string;
  chunkCount: number;
  sponsors: string[];
  matchId: string;
  presetId?: string;
  deadlineAt?: number | null;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json" | "text">>;

function normalizedOrigin(config: BundleClientConfig): string {
  return (config.computeLabOrigin || "").replace(/\/+$/, "");
}

function ready(config: BundleClientConfig): boolean {
  return !!(config.enabled && config.adminToken && normalizedOrigin(config));
}

async function adminPost(
  config: BundleClientConfig,
  path: string,
  body: unknown,
  fetchImpl: FetchLike,
): Promise<{ ok: boolean; status: number; body: any }> {
  const origin = normalizedOrigin(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 3000);
  try {
    const response = await fetchImpl(origin + path, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-plasma-admin-token": config.adminToken!,
      },
      body: JSON.stringify(body),
    });
    let parsed: any = null;
    try { parsed = await response.json(); } catch { parsed = null; }
    return { ok: response.ok, status: response.status, body: parsed };
  } catch (e) {
    return { ok: false, status: 0, body: { error: e instanceof Error ? e.message : String(e) } };
  } finally {
    clearTimeout(timer);
  }
}

// Called at match start. Returns null when the bundle pipeline is disabled
// or the admin call fails — match streaming continues either way.
export async function materializeScienceBundle(
  config: BundleClientConfig,
  input: {
    matchId: string;
    sponsors: string[];
    expectedMatchSec?: number;
    presetId?: string;
    tileRows?: number;
    tileCols?: number;
  },
  fetchImpl: FetchLike = fetch,
): Promise<MaterializedBundle | null> {
  if (!ready(config)) return null;
  const res = await adminPost(config, "/compute/admin/bundles/materialize-contact-map", {
    matchId: input.matchId,
    sponsors: input.sponsors,
    expectedMatchSec: input.expectedMatchSec ?? 180,
    presetId: input.presetId,
    tileRows: input.tileRows,
    tileCols: input.tileCols,
  }, fetchImpl);
  if (!res.ok || !res.body?.bundle?.bundleId) return null;
  return {
    bundleId: res.body.bundle.bundleId,
    kernelId: res.body.bundle.kernelId,
    chunkCount: res.body.chunkCount ?? res.body.bundle.chunkIds?.length ?? 0,
    sponsors: res.body.bundle.sponsors ?? [],
    matchId: input.matchId,
    presetId: res.body.preset,
    deadlineAt: res.body.bundle.deadlineAt ?? null,
  };
}

// Called at match end. Materializes a proof bundle that wraps a
// replay_verify task so spectator browsers independently re-execute the
// match. Returns null when disabled or on admin failure.
export async function materializeProofBundle(
  config: BundleClientConfig,
  input: {
    matchId: string;
    sponsors: string[];
    replay: ReplayArtifactV1;
  },
  fetchImpl: FetchLike = fetch,
): Promise<MaterializedBundle | null> {
  if (!ready(config)) return null;
  // Strip player.config (private) before handing the replay to plasma-lab.
  const redactedPlayers = input.replay.players.map((p) => {
    const { config: _c, ...rest } = p;
    return rest as typeof p;
  }) as [typeof input.replay.players[0], typeof input.replay.players[1]];
  const redacted: ReplayArtifactV1 = {
    ...input.replay,
    players: redactedPlayers,
  };
  const res = await adminPost(config, "/compute/admin/bundles/materialize-replay-verify", {
    matchId: input.matchId,
    sponsors: input.sponsors,
    replayArtifactJson: JSON.stringify(redacted),
    minExecutions: 5,
    minAgreeing: 3,
  }, fetchImpl);
  if (!res.ok || !res.body?.bundle?.bundleId) return null;
  return {
    bundleId: res.body.bundle.bundleId,
    kernelId: res.body.bundle.kernelId,
    chunkCount: res.body.bundle.chunkIds?.length ?? 1,
    sponsors: res.body.bundle.sponsors ?? [],
    matchId: input.matchId,
    deadlineAt: res.body.bundle.deadlineAt ?? null,
  };
}

// Seal a bundle against the battle-receipt hash. The hash is derived from
// the public replay artifact's sha256 — that's the canonical "this match
// happened deterministically" anchor.
export async function sealBundleAgainstMatch(
  config: BundleClientConfig,
  input: {
    bundleId: string;
    matchId: string;
    replay: ReplayArtifactV1;
  },
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: boolean; status: number; bundleRoot?: { algorithm: string; value: string } }> {
  if (!ready(config)) return { ok: false, status: 0 };
  const publicArtifact = publicReplayArtifactFromReplay(input.replay);
  const matchReceiptHash = { algorithm: "sha256", value: publicArtifact.artifactSha256 };
  const res = await adminPost(config, `/compute/admin/bundles/${encodeURIComponent(input.bundleId)}/seal`, {
    matchReceiptHash,
    matchId: input.matchId,
  }, fetchImpl);
  return {
    ok: res.ok,
    status: res.status,
    bundleRoot: res.body?.bundle?.bundleRoot,
  };
}

export function bundleFeaturesEnabled(input: {
  featureFlag: boolean;
  computeLabOrigin: string;
  adminToken?: string;
}): boolean {
  return Boolean(input.featureFlag && input.computeLabOrigin && input.adminToken);
}
