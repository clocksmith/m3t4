import crypto from "node:crypto";
import type { StableStore } from "../stable.js";
import { handleSpectateTuple, handleVerifyReplay } from "../verify.js";
import { json } from "../http-utils.js";
import type { RouteList } from "./types.js";

export interface ReplayRouteDeps {
  store: StableStore;
}

export function registerReplayVerifyRoutes(routes: RouteList, deps: ReplayRouteDeps): void {
  routes.push(async (req, res, url) => {
    if (req.method === "POST" && url.pathname === "/api/verify/replay") {
      await handleVerifyReplay(req, res);
      return true;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/spectate/tuple/")) {
      const matchId = url.pathname.slice("/api/spectate/tuple/".length);
      if (!matchId) json(res, 400, { error: "matchId required" });
      else await handleSpectateTuple(deps.store, matchId, req, res);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/replays/public-artifact/manifest") {
      const raw = url.searchParams.get("limit");
      const parsed = raw === null ? undefined : Number(raw);
      const limit = Number.isFinite(parsed) && parsed! > 0 ? parsed : undefined;
      const summaries = await deps.store.listPublicReplayArtifactSummaries({ limit });
      const artifacts = summaries.map((s) => ({
        matchId: s.matchId,
        exportedAt: s.exportedAt,
        replayCreatedAt: s.replayCreatedAt,
        artifactHash: s.artifactHash,
        artifactSha256: s.artifactSha256,
        httpPath: `/api/replays/public-artifact/${encodeURIComponent(s.matchId)}`,
        cacheKey: `public-replay-artifact:${s.artifactSha256}`,
      }));
      const body = {
        kind: "m3t4.public-replay-artifact.manifest.v0",
        generatedAt: Date.now(),
        sourceOrder: ["cache", "p2p", "http"],
        fallback: { onHit: "return", onMiss: "next", onFailure: "terminal" },
        artifacts,
      };
      const manifestHash = manifestContentHash(body);
      json(res, 200, { ...body, manifestHash });
      return true;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/replays/public-artifact/")) {
      const matchId = url.pathname.slice("/api/replays/public-artifact/".length);
      if (!matchId) {
        json(res, 400, { error: "matchId required" });
        return true;
      }
      const artifact = await deps.store.getPublicReplayArtifact(matchId);
      if (!artifact) json(res, 404, { error: "public replay artifact not found" });
      else json(res, 200, artifact);
      return true;
    }

    return false;
  });
}

// Content hash over the manifest body excluding manifestHash itself,
// matching the hashCanonical(body) → { algorithm, value } pattern used by
// plasma-lab's receipt-log manifest.
function manifestContentHash(body: unknown): { algorithm: "sha256"; value: string } {
  return { algorithm: "sha256", value: crypto.createHash("sha256").update(canonicalJson(body)).digest("hex") };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON does not support non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      out[key] = normalize(inner);
    }
    return out;
  }
  throw new Error(`canonical JSON does not support ${typeof value}`);
}
