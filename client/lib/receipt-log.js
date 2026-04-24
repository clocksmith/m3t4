// Receipt-log public fetcher.
//
// The manifest is fetched over HTTPS and self-verified via its manifestHash
// (hashCanonical of the manifest minus that field). Individual segments are
// then pulled through the cache → p2p → http transport, each verified against
// the segmentHash that the manifest advertised, using the same formula the
// server used to seal the segment.

import { fetchVerified } from "./p2p-transport.js";
import { canonicalJson, hashCanonical, hashesEqual, sha256Hex } from "./canonical-hash.js";

function defaultLabOrigin() {
  const fromWindow = typeof window !== "undefined" ? window.__M3T4_COMPUTE_LAB_ORIGIN__ : null;
  return String(fromWindow || "").replace(/\/+$/, "");
}

async function expectedSegmentHash(segment) {
  return {
    algorithm: "sha256",
    value: await sha256Hex(canonicalJson({
      receiptLogSegmentVersion: 1,
      firstSequence: segment.firstSequence,
      lastSequence: segment.lastSequence,
      prevSegmentHash: segment.prevSegmentHash,
      entryHashes: segment.entryHashes,
      entryCount: segment.entryCount,
      sealedAt: segment.sealedAt,
    })),
  };
}

async function verifySegmentBody(body, expectedHash) {
  if (!body || typeof body !== "object") return false;
  const computed = await expectedSegmentHash(body);
  return hashesEqual(computed, expectedHash)
    && hashesEqual(body.segmentHash, expectedHash);
}

export async function fetchReceiptLogManifest({
  origin = defaultLabOrigin(),
  fetchImpl = typeof fetch === "function" ? fetch : null,
} = {}) {
  if (!origin) throw new Error("receipt-log: no compute lab origin");
  if (!fetchImpl) throw new Error("receipt-log: no fetch implementation");
  const res = await fetchImpl(`${origin}/compute/public/receipt-log/manifest`, { cache: "no-store" });
  if (!res.ok) throw new Error(`receipt-log manifest http ${res.status}`);
  const body = await res.json();
  const { manifestHash, ...payload } = body;
  const recomputed = await hashCanonical(payload);
  if (!hashesEqual(recomputed, manifestHash)) {
    throw new Error("receipt-log manifest hash mismatch");
  }
  return body;
}

export async function fetchReceiptLogSegment({
  segment,
  origin = defaultLabOrigin(),
  p2pFetch,
  fetchImpl = typeof fetch === "function" ? fetch : null,
}) {
  if (!origin) throw new Error("receipt-log: no compute lab origin");
  if (!segment?.httpPath) throw new Error("receipt-log: segment.httpPath required");
  return fetchVerified({
    cacheKey: segment.cacheKey ?? `receipt-log-segment:${segment.segmentHash?.value ?? segment.segmentId}`,
    httpUrl: `${origin}${segment.httpPath}`,
    expectedHash: segment.segmentHash,
    verify: verifySegmentBody,
    p2pFetch,
    fetchImpl,
  });
}

// Convenience: pull manifest and every segment it advertises, verified.
export async function loadReceiptLog({
  origin = defaultLabOrigin(),
  limit,
  p2pFetch,
  fetchImpl = typeof fetch === "function" ? fetch : null,
} = {}) {
  const manifest = await fetchReceiptLogManifest({ origin, fetchImpl });
  const segmentsMeta = Array.isArray(manifest.segments) ? manifest.segments : [];
  const selected = Number.isFinite(limit) && limit > 0 ? segmentsMeta.slice(0, limit) : segmentsMeta;
  const results = [];
  for (const segment of selected) {
    try {
      const fetched = await fetchReceiptLogSegment({ segment, origin, p2pFetch, fetchImpl });
      results.push({ ok: true, segmentId: segment.segmentId, source: fetched.source, body: fetched.body });
    } catch (error) {
      results.push({ ok: false, segmentId: segment.segmentId, error: String(error?.message || error) });
    }
  }
  return { manifest, segments: results };
}
