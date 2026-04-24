// Public replay archive fetcher.
//
// Uses the same cache → p2p → http transport as receipt-log.js. The manifest
// itself is fetched over HTTPS against arena-server and self-verified via its
// manifestHash. Each replay is verified by recomputing the canonical sha256 of
// its payload and comparing against the manifest-supplied artifactSha256
// (PublicReplayArtifactV1.artifactSha256 is a hex sha256 of
// stableReplayJson(payload); we recompute the same here).

import { fetchVerified } from "./p2p-transport.js";
import { hashCanonical, hashesEqual, sha256Hex } from "./canonical-hash.js";

function defaultApiOrigin() {
  if (typeof window === "undefined") return "";
  return String(window.__M3T4_API_ORIGIN__ || window.location?.origin || "").replace(/\/+$/, "");
}

function stableReplayJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableReplayJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableReplayJson(value[k])}`).join(",")}}`;
}

async function verifyArtifactBody(body, expectedHash) {
  if (!body || typeof body !== "object" || !body.payload) return false;
  if (typeof expectedHash === "string") {
    const actual = await sha256Hex(stableReplayJson(body.payload));
    return body.artifactSha256 === expectedHash && actual === expectedHash;
  }
  if (expectedHash?.algorithm === "sha256") {
    const actual = await sha256Hex(stableReplayJson(body.payload));
    return body.artifactSha256 === expectedHash.value && actual === expectedHash.value;
  }
  return false;
}

export async function fetchReplayManifest({
  origin = defaultApiOrigin(),
  limit,
  fetchImpl = typeof fetch === "function" ? fetch : null,
} = {}) {
  if (!origin) throw new Error("replay-archive: no api origin");
  if (!fetchImpl) throw new Error("replay-archive: no fetch implementation");
  const url = new URL("/api/replays/public-artifact/manifest", origin);
  if (Number.isFinite(limit) && limit > 0) url.searchParams.set("limit", String(limit));
  const res = await fetchImpl(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`replay-archive manifest http ${res.status}`);
  const body = await res.json();
  const { manifestHash, ...payload } = body;
  const recomputed = await hashCanonical(payload);
  if (!hashesEqual(recomputed, manifestHash)) {
    throw new Error("replay-archive manifest hash mismatch");
  }
  return body;
}

export async function fetchPublicReplay({
  artifactEntry,
  origin = defaultApiOrigin(),
  p2pFetch,
  fetchImpl = typeof fetch === "function" ? fetch : null,
}) {
  if (!origin) throw new Error("replay-archive: no api origin");
  if (!artifactEntry?.httpPath) throw new Error("replay-archive: artifactEntry.httpPath required");
  return fetchVerified({
    cacheKey: artifactEntry.cacheKey ?? `public-replay-artifact:${artifactEntry.artifactSha256}`,
    httpUrl: `${origin}${artifactEntry.httpPath}`,
    expectedHash: artifactEntry.artifactSha256,
    verify: verifyArtifactBody,
    p2pFetch,
    fetchImpl,
  });
}

export async function loadRecentReplays({
  origin = defaultApiOrigin(),
  limit,
  p2pFetch,
  fetchImpl = typeof fetch === "function" ? fetch : null,
} = {}) {
  const manifest = await fetchReplayManifest({ origin, limit, fetchImpl });
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const results = [];
  for (const entry of artifacts) {
    try {
      const fetched = await fetchPublicReplay({ artifactEntry: entry, origin, p2pFetch, fetchImpl });
      results.push({ ok: true, matchId: entry.matchId, source: fetched.source, body: fetched.body });
    } catch (error) {
      results.push({ ok: false, matchId: entry.matchId, error: String(error?.message || error) });
    }
  }
  return { manifest, replays: results };
}
