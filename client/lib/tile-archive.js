// Public tile archive fetcher.
//
// Workers running tile-shaped kernels reference tiles by sha256 instead of
// receiving bytes inline in chunk.params. This module fetches the tile via
// the shared cache → p2p → http transport, verifying that the returned
// document's bytes hash to the manifest-declared sha256.

import { fetchVerified } from "./p2p-transport.js";
import { hashCanonical, hashesEqual, sha256Hex } from "./canonical-hash.js";

function defaultLabOrigin() {
  const fromWindow = typeof window !== "undefined" ? window.__M3T4_COMPUTE_LAB_ORIGIN__ : null;
  return String(fromWindow || "").replace(/\/+$/, "");
}

// Server returns a PublicTile document with self-reported sha256 plus
// inline bytesBase64. Verification: decode the bytes and compare their
// sha256 to both the manifest value and the doc's self-report.
async function verifyTileBody(body, expectedHash) {
  if (!body || typeof body !== "object") return false;
  if (body.mimeType !== "image/rgba") return false;
  if (typeof body.bytesBase64 !== "string" || body.bytesBase64.length === 0) return false;
  const expected = typeof expectedHash === "string" ? expectedHash : expectedHash?.value;
  if (!expected) return false;
  if (body.sha256 !== expected) return false;
  try {
    const binary = atob(body.bytesBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.length !== body.byteLength) return false;
    if (bytes.length !== body.widthPx * body.heightPx * 4) return false;
    const actual = await sha256Hex(bytes);
    return actual === expected;
  } catch {
    return false;
  }
}

export async function fetchTileManifest({
  origin = defaultLabOrigin(),
  limit,
  fetchImpl = typeof fetch === "function" ? fetch : null,
} = {}) {
  if (!origin) throw new Error("tile-archive: no lab origin");
  if (!fetchImpl) throw new Error("tile-archive: no fetch implementation");
  const url = new URL("/compute/public/tiles/manifest", origin);
  if (Number.isFinite(limit) && limit > 0) url.searchParams.set("limit", String(limit));
  const res = await fetchImpl(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`tile manifest http ${res.status}`);
  const body = await res.json();
  const { manifestHash, ...payload } = body;
  const recomputed = await hashCanonical(payload);
  if (!hashesEqual(recomputed, manifestHash)) {
    throw new Error("tile manifest hash mismatch");
  }
  return body;
}

// Fetch a single tile by sha256. Callers supply the sha either on its own
// or as part of a manifest entry. Returns { source: "cache"|"p2p"|"http", body }
// where body is the PublicTile document.
export async function fetchPublicTile({
  sha256,
  origin = defaultLabOrigin(),
  p2pFetch,
  fetchImpl = typeof fetch === "function" ? fetch : null,
}) {
  if (!origin) throw new Error("tile-archive: no lab origin");
  if (!/^[0-9a-f]{64}$/.test(String(sha256 ?? ""))) throw new Error("tile-archive: valid sha256 required");
  return fetchVerified({
    cacheKey: `public-tile:${sha256}`,
    httpUrl: `${origin}/compute/public/tiles/${encodeURIComponent(sha256)}`,
    expectedHash: sha256,
    verify: verifyTileBody,
    p2pFetch,
    fetchImpl,
  });
}

// Convenience: fetch bytes directly, decoded from the manifest-verified body.
export async function fetchPublicTileBytes({ sha256, origin, p2pFetch, fetchImpl } = {}) {
  const { body, source } = await fetchPublicTile({ sha256, origin, p2pFetch, fetchImpl });
  const binary = atob(body.bytesBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return {
    source,
    bytes,
    widthPx: body.widthPx,
    heightPx: body.heightPx,
    provenance: body.provenance,
  };
}
