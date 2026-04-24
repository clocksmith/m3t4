// Graceful-fallback fetcher for content-addressed bytes.
//
//   sourceOrder = [cache, p2p, http]
//   onHit:     'return'
//   onMiss:    'next'
//   onFailure: 'terminal' (for http; cache/p2p fall through)
//
// Every source that returns bytes is hash-verified against the manifest-supplied
// expected hash before being accepted. A verification failure is treated as a
// miss so the next source is tried; HTTPS is always the last, mandatory source.
// The manifest itself must be fetched over HTTPS from a server-authoritative
// origin — do not trust peer-advertised manifests.

import { hashesEqual, hashCanonical } from "./canonical-hash.js";

const CACHE_NAME = "m3t4-p2p-v1";

async function openCache() {
  if (typeof caches === "undefined") return null;
  try { return await caches.open(CACHE_NAME); } catch { return null; }
}

async function readCache(cacheKey) {
  const cache = await openCache();
  if (!cache) return null;
  const hit = await cache.match(cacheKey);
  if (!hit) return null;
  try { return await hit.clone().json(); } catch { return null; }
}

async function writeCache(cacheKey, value) {
  const cache = await openCache();
  if (!cache) return;
  try {
    const body = JSON.stringify(value);
    await cache.put(cacheKey, new Response(body, { headers: { "content-type": "application/json" } }));
  } catch {
    // cache.put can fail on private browsing; never let that block a fetch
  }
}

// Fetch bytes via cache → p2p → http, rejecting any source whose hash does not
// match expectedHash. `p2pFetch` is optional; omit (or return null) to disable
// the P2P layer cleanly while keeping cache + http. `verify` is optional; the
// default hashes the full body canonically, which matches the common
// `hashCanonical(body)` server pattern. Pass a custom verifier when the payload
// is hashed over a subset of fields (e.g. receipt-log segments).
export async function fetchVerified({
  cacheKey,
  httpUrl,
  expectedHash,
  verify,
  p2pFetch,
  fetchImpl = typeof fetch === "function" ? fetch : null,
}) {
  if (!expectedHash) throw new Error("fetchVerified: expectedHash required");
  if (!cacheKey) throw new Error("fetchVerified: cacheKey required");
  if (!httpUrl) throw new Error("fetchVerified: httpUrl required");
  if (!fetchImpl) throw new Error("fetchVerified: no fetch implementation");

  const check = typeof verify === "function"
    ? async (body) => verify(body, expectedHash)
    : async (body) => hashesEqual(await hashCanonical(body), expectedHash);

  const fromCache = await readCache(cacheKey);
  if (fromCache && await check(fromCache)) {
    return { source: "cache", body: fromCache };
  }

  if (typeof p2pFetch === "function") {
    try {
      const fromPeer = await p2pFetch({ cacheKey, expectedHash });
      if (fromPeer && await check(fromPeer)) {
        await writeCache(cacheKey, fromPeer);
        return { source: "p2p", body: fromPeer };
      }
    } catch {
      // p2p miss falls through to http
    }
  }

  const res = await fetchImpl(httpUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`fetchVerified http ${res.status} ${httpUrl}`);
  const body = await res.json();
  if (!await check(body)) {
    throw new Error(`fetchVerified http hash mismatch ${httpUrl}`);
  }
  await writeCache(cacheKey, body);
  return { source: "http", body };
}

export async function clearTransportCache() {
  if (typeof caches === "undefined") return;
  try { await caches.delete(CACHE_NAME); } catch { /* noop */ }
}
