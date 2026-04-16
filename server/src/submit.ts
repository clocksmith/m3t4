// POST /api/ranked/submit handler. Validates auth, parses config, enforces
// rate limits, stores to stable.

import type { IncomingMessage, ServerResponse } from "node:http";
import { validateUserSubmission, type BrainConfig } from "@m3t4/sim";
import type { StableStore } from "./stable.js";
import { verifyAuth } from "./auth.js";

async function readBody(req: IncomingMessage): Promise<string> {
  let buf = "";
  for await (const chunk of req) buf += chunk;
  return buf;
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

export async function handleSubmit(req: IncomingMessage, res: ServerResponse, store: StableStore): Promise<void> {
  try {
    const auth = await verifyAuth(req.headers.authorization);
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}") as {
      slotIdx?: number;
      config?: unknown;
      name?: string;
    };
    if (typeof body.slotIdx !== "number") return send(res, 400, { error: "slotIdx required" });
    if (!body.config || typeof body.config !== "object") return send(res, 400, { error: "config required" });

    const cfg = body.config as { id?: string; attributes?: Record<string, unknown> };
    if (!cfg.id || typeof cfg.id !== "string") cfg.id = `${auth.uid}-${body.slotIdx}-${Date.now().toString(36)}`;

    const validation = validateUserSubmission(cfg as unknown as BrainConfig);
    if (!validation.ok || !validation.config) {
      return send(res, 400, { error: "invalid user config", details: validation.errors });
    }

    const { slotId } = await store.submitToSlot(auth.uid, body.slotIdx, validation.config, body.name);
    send(res, 200, { ok: true, slotId });
  } catch (e) {
    send(res, 400, { error: (e as Error).message });
  }
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
