// POST /api/ranked/submit handler. Validates auth, parses config, enforces
// rate limits, stores to stable.

import type { IncomingMessage, ServerResponse } from "node:http";
import { validateUserSubmission, type BrainConfig } from "@m3t4/sim";
import type { SlotCosmeticsInput, StableStore } from "./stable.js";
import { verifyAuth } from "./auth.js";
import { CONFIG } from "./config.js";
import { corsHeaders } from "./http-utils.js";

const submitLimiter = new Map<string, { count: number; resetAt: number }>();

async function readBody(req: IncomingMessage): Promise<string> {
  let buf = "";
  for await (const chunk of req) buf += chunk;
  return buf;
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json", ...corsHeaders() });
  res.end(JSON.stringify(body));
}

export async function handleSubmit(req: IncomingMessage, res: ServerResponse, store: StableStore): Promise<void> {
  try {
    const rate = checkSubmitRateLimit(req);
    if (!rate.ok) {
      res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
      return send(res, 429, { error: "rate limited", retryAfterMs: rate.retryAfterMs });
    }
    const auth = await verifyAuth(req.headers.authorization);
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}") as {
      slotIdx?: number;
      config?: unknown;
      name?: string;
      cosmetics?: SlotCosmeticsInput;
    };
    if (typeof body.slotIdx !== "number") return send(res, 400, { error: "slotIdx required" });
    if (!body.config || typeof body.config !== "object") return send(res, 400, { error: "config required" });

    const cfg = body.config as { id?: string; attributes?: Record<string, unknown> };
    if (!cfg.id || typeof cfg.id !== "string") cfg.id = `${auth.uid}-${body.slotIdx}-${Date.now().toString(36)}`;

    const validation = validateUserSubmission(cfg as unknown as BrainConfig);
    if (!validation.ok || !validation.config) {
      return send(res, 400, { error: "invalid user config", details: validation.errors });
    }

    const { slotId } = await store.submitToSlot(auth.uid, body.slotIdx, validation.config, body.name, body.cosmetics);
    send(res, 200, { ok: true, slotId });
  } catch (e) {
    send(res, 400, { error: (e as Error).message });
  }
}

function checkSubmitRateLimit(req: IncomingMessage): { ok: true } | { ok: false; retryAfterMs: number } {
  const limit = Math.max(1, CONFIG.submitIpRateLimitMax);
  const windowMs = Math.max(1000, CONFIG.submitIpRateLimitWindowMs);
  const ip = clientIp(req);
  const now = Date.now();
  const rec = submitLimiter.get(ip);
  if (!rec || rec.resetAt <= now) {
    submitLimiter.set(ip, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  rec.count++;
  if (rec.count <= limit) return { ok: true };
  return { ok: false, retryAfterMs: rec.resetAt - now };
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

export async function handleClaimHandle(req: IncomingMessage, res: ServerResponse, store: StableStore): Promise<void> {
  try {
    const auth = await verifyAuth(req.headers.authorization);
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}") as { handle?: string };
    if (!body.handle) return send(res, 400, { error: "handle required" });
    const st = await store.upsertHandle(auth.uid, body.handle);
    send(res, 200, { ok: true, handle: st.handle });
  } catch (e) {
    send(res, 400, { error: (e as Error).message });
  }
}
