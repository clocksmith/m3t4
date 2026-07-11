import crypto from "node:crypto";
import type { StableStore } from "../stable.js";
import { effectiveRateLockedUntil, slotCosmetics, stablePublic } from "../stable.js";
import { handleClaimHandle, handleSubmit } from "../submit.js";
import { verifyAuth } from "../auth.js";
import { json } from "../http-utils.js";
import type { RouteList } from "./types.js";
import { matchmakerPressure } from "../matchmaker-pressure.js";

export interface RankedRouteDeps {
  store: StableStore;
  features: Record<string, boolean>;
  config: {
    activePoolMs: number;
    authMode?: string;
    authProviders: readonly string[];
    cycleMs: number;
    computeLabOrigin?: string;
    computeStunUrls?: readonly string[];
    maxSlots: number;
    serverRole?: string;
    storeBackend?: string;
    wsClientSoftLimit?: number;
  };
}

export function registerRankedRoutes(routes: RouteList, deps: RankedRouteDeps): void {
  const { store, features, config } = deps;

  routes.push(async (req, res, url) => {
    if (req.method === "GET" && url.pathname === "/api/status") {
      const active = await store.listActive(config.activePoolMs);
      res.setHeader("cache-control", "public, max-age=10, stale-while-revalidate=30");
      json(res, 200, {
        ok: true,
        cycleMs: config.cycleMs,
        computeLabOrigin: config.computeLabOrigin,
        computeStunUrls: config.computeStunUrls ?? [],
        maxSlots: config.maxSlots,
        authMode: config.authMode,
        authProviders: config.authProviders,
        role: config.serverRole,
        storeBackend: config.storeBackend,
        wsClientSoftLimit: config.wsClientSoftLimit,
        matchmaker: matchmakerPressure(active, config.cycleMs),
        features,
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/features") {
      json(res, 200, { features });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/leaderboard") {
      const active = await store.listActive(config.activePoolMs);
      const rows = active
        .map((st) => stablePublic(st))
        .sort((a, b) => b.eloAggregate - a.eloAggregate);
      const limit = boundedInteger(url.searchParams.get("limit"), 50, 1, 100);
      const offset = boundedInteger(url.searchParams.get("offset"), 0, 0, rows.length);
      const pageRows = rows.slice(offset, offset + limit);
      res.setHeader("cache-control", "public, max-age=20, stale-while-revalidate=40");
      if (url.searchParams.get("page") === "1") {
        json(res, 200, {
          rows: pageRows,
          offset,
          limit,
          total: rows.length,
          hasMore: offset + pageRows.length < rows.length,
        });
      } else {
        json(res, 200, pageRows);
      }
      return true;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/stables/")) {
      const uid = url.pathname.slice("/api/stables/".length);
      const st = await store.getStable(uid);
      if (!st) json(res, 404, { error: "not found" });
      else json(res, 200, stablePublic(st));
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/me/stable") {
      try {
        const auth = await verifyAuth(req.headers.authorization);
        const st = await store.getStable(auth.uid);
        if (!st) json(res, 404, { error: "not found" });
        else json(res, 200, {
          ...stablePublic(st),
          slots: Array.from({ length: config.maxSlots }, (_, slotIdx) => {
            const slot = st.slots[slotIdx];
            return slot ? {
              ...slot,
              slotIdx,
              cosmetics: slotCosmetics(slot, slotIdx),
              rateLockedUntil: effectiveRateLockedUntil(slot),
            } : null;
          }),
          createdAt: st.createdAt,
          updatedAt: st.updatedAt,
        });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/ranked/submit") {
      await handleSubmit(req, res, store);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/handle") {
      await handleClaimHandle(req, res, store);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/internal/elo-decay") {
      const internal = verifyInternalRequest(req.headers.authorization, req.headers["x-m3t4-internal-token"]);
      if (!internal.ok) {
        json(res, internal.code, { error: internal.error });
        return true;
      }
      const count = await store.applyDecay();
      json(res, 200, { ok: true, decayed: count });
      return true;
    }

    return false;
  });
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function verifyInternalRequest(
  authHeader: string | undefined,
  tokenHeader: string | string[] | undefined,
): { ok: true } | { ok: false; code: number; error: string } {
  if (process.env.NODE_ENV !== "production") return { ok: true };
  const expected = process.env.M3T4_INTERNAL_TOKEN;
  if (!expected) return { ok: false, code: 503, error: "internal token not configured" };

  const token = Array.isArray(tokenHeader)
    ? tokenHeader[0]
    : tokenHeader ?? (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "");
  const got = Buffer.from(token ?? "");
  const want = Buffer.from(expected);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return { ok: false, code: 403, error: "forbidden" };
  }
  return { ok: true };
}
