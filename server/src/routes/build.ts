import type { IncomingMessage } from "node:http";
import {
  STAGES,
  STRATEGIES,
  simulateTrace,
  validateUserSubmission,
  type BrainConfig,
  type Stage,
  type TraceFrame,
} from "@m3t4/sim";
import { json } from "../http-utils.js";
import type { RouteList } from "./types.js";

const MAX_BODY_BYTES = 64 * 1024;
const PREVIEW_MAX_TICKS = 60 * 120;
const DEFAULT_FRAME_STRIDE = 2;
const MAX_FRAME_STRIDE = 8;
const RATE_LIMIT_MAX = 24;
const RATE_LIMIT_WINDOW_MS = 60_000;

const previewLimiter = new Map<string, { count: number; resetAt: number }>();

type PreviewSide =
  | { kind?: "user"; config?: unknown }
  | { kind?: "preset"; preset?: unknown };

interface PreviewBody {
  stageId?: unknown;
  seed?: unknown;
  frameStride?: unknown;
  maxTicks?: unknown;
  a?: PreviewSide;
  b?: PreviewSide;
}

export function registerBuildRoutes(routes: RouteList): void {
  routes.push(async (req, res, url) => {
    if (req.method !== "POST" || url.pathname !== "/api/build/simulate") return false;

    const rate = checkPreviewRateLimit(req);
    if (!rate.ok) {
      res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
      json(res, 429, { error: "rate limited", retryAfterMs: rate.retryAfterMs });
      return true;
    }

    try {
      const body = await readJsonBody<PreviewBody>(req);
      const stage = resolveStage(body.stageId);
      const seed = resolveSeed(body.seed);
      const frameStride = clampInt(body.frameStride, 1, MAX_FRAME_STRIDE, DEFAULT_FRAME_STRIDE);
      const maxTicks = clampInt(body.maxTicks, 120, PREVIEW_MAX_TICKS, PREVIEW_MAX_TICKS);
      const brainA = resolveSide(body.a, 0);
      const brainB = resolveSide(body.b, 1);

      const trace = simulateTrace({ stage, seed, brainA: brainA.config, brainB: brainB.config, maxTicks });
      const frames = downsampleFrames(trace.frames, frameStride).map(sanitizeFrame);

      json(res, 200, {
        ok: true,
        seed,
        stage,
        frameStride,
        labels: { p1: brainA.label, p2: brainB.label },
        result: {
          winner: trace.result.winner,
          finalScore: trace.result.finalScore,
          finalRounds: trace.result.finalRounds,
          ticks: trace.result.ticks,
        },
        frames,
      });
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  });
}

function resolveStage(raw: unknown): Stage {
  const id = typeof raw === "string" ? raw : "datacenter";
  const stage = STAGES[id as keyof typeof STAGES];
  if (!stage) throw new Error(`unknown stageId: ${id}`);
  return stage;
}

function resolveSeed(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(1, Math.floor(raw)) >>> 0;
  return (Math.floor(Math.random() * 0xffffffff) + 1) >>> 0;
}

function resolveSide(raw: PreviewSide | undefined, slot: 0 | 1): { label: string; config: BrainConfig } {
  if (!raw || typeof raw !== "object") throw new Error(`slot ${slot} required`);
  if (raw.kind === "preset") {
    const name = typeof raw.preset === "string" ? raw.preset : "";
    const config = STRATEGIES[name as keyof typeof STRATEGIES];
    if (!config) throw new Error(`unknown preset: ${name}`);
    return { label: name, config };
  }

  const cfg = "config" in raw ? raw.config : undefined;
  if (!cfg || typeof cfg !== "object") throw new Error(`slot ${slot} config required`);
  const candidate = cfg as { id?: string; attributes?: unknown };
  if (!candidate.id || typeof candidate.id !== "string") candidate.id = `build-preview-${slot}`;
  const validation = validateUserSubmission(candidate as BrainConfig);
  if (!validation.ok || !validation.config) {
    throw new Error(`invalid slot ${slot} config: ${validation.errors.join("; ")}`);
  }
  return { label: slot === 0 ? "BUILD P1" : "BUILD P2", config: validation.config };
}

function downsampleFrames(frames: TraceFrame[], stride: number): TraceFrame[] {
  if (stride <= 1) return frames;
  const out = frames.filter((_, i) => i % stride === 0);
  const last = frames[frames.length - 1];
  if (last && out[out.length - 1]?.tick !== last.tick) out.push(last);
  return out;
}

function sanitizeFrame(f: TraceFrame): TraceFrame {
  return {
    tick: f.tick,
    p0: sanitizeFighter(f.p0),
    p1: sanitizeFighter(f.p1),
    token: {
      exists: !!f.token.exists,
      x: round2(f.token.x),
      y: round2(f.token.y),
      carrier: f.token.carrier,
      dwellT: round3(f.token.dwellT),
    },
    goal: {
      exists: !!f.goal.exists,
      x: round2(f.goal.x),
      y: round2(f.goal.y),
      label: String(f.goal.label ?? ""),
      timer: round3(f.goal.timer),
    },
    scoreboard: [f.scoreboard[0], f.scoreboard[1]],
    rounds: [f.rounds[0], f.rounds[1]],
  };
}

function sanitizeFighter(f: TraceFrame["p0"]): TraceFrame["p0"] {
  return {
    x: round2(f.x),
    y: round2(f.y),
    vx: round2(f.vx),
    vy: round2(f.vy),
    facing: f.facing,
    onGround: !!f.onGround,
    wall: f.wall,
    stun: round3(f.stun),
    swipeT: round3(f.swipeT),
    diveT: round3(f.diveT),
    lastClashTick: typeof f.lastClashTick === "number" ? Math.trunc(f.lastClashTick) : -9999,
    dead: !!f.dead,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function clampInt(raw: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(raw)));
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return (raw ? JSON.parse(raw) : {}) as T;
}

function checkPreviewRateLimit(req: IncomingMessage): { ok: true } | { ok: false; retryAfterMs: number } {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = previewLimiter.get(ip);
  if (!rec || rec.resetAt <= now) {
    previewLimiter.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { ok: true };
  }
  rec.count++;
  if (rec.count <= RATE_LIMIT_MAX) return { ok: true };
  return { ok: false, retryAfterMs: rec.resetAt - now };
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}
