// Headless GIF replay. Runs simulateTrace() to collect per-tick state, then
// rasterizes each frame with a tiny pure-JS drawer (no canvas dep) and
// encodes as an animated GIF via `gifenc`.
//
// Usage:
//   node dist/gif.js --a moonshot --b shipper --seed 1 --out match.gif
//   node dist/gif.js --a bot.json --b oracle --fps 20 --scale 0.5

import fs from "node:fs";
import path from "node:path";
import {
  STAGES, STRATEGIES, STRATEGY_NAMES,
  simulateTrace, type BrainConfig, type Stage, type TraceFrame,
} from "@m3t4/sim";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
// gifenc is CJS; use Node's require() from ESM to get the named exports.
const gifenc = req("gifenc") as {
  GIFEncoder: () => { writeFrame: (idx: Uint8Array, w: number, h: number, o: { palette: number[][]; delay: number }) => void; finish: () => void; bytes: () => Uint8Array };
  quantize: (rgba: Uint8ClampedArray, maxColors: number) => number[][];
  applyPalette: (rgba: Uint8ClampedArray, palette: number[][]) => Uint8Array;
};
const { GIFEncoder, quantize, applyPalette } = gifenc;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) {
      const name = k.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { out[name] = next; i++; }
      else out[name] = "1";
    }
  }
  return out;
}

function loadConfig(spec: string): BrainConfig {
  if ((STRATEGY_NAMES as readonly string[]).includes(spec)) {
    return STRATEGIES[spec as keyof typeof STRATEGIES];
  }
  if (fs.existsSync(spec)) {
    const raw = JSON.parse(fs.readFileSync(spec, "utf8"));
    if (!raw.id) raw.id = path.basename(spec, path.extname(spec));
    return raw as BrainConfig;
  }
  throw new Error(`unknown config '${spec}'`);
}

// ---------- Tiny rasterizer ----------
//
// A plain Uint8ClampedArray RGBA buffer. We scale sim coords down so the
// output is compact. Default scale 0.5 → 640×360. Good for sharing.

class Canvas {
  readonly w: number;
  readonly h: number;
  readonly buf: Uint8ClampedArray;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.buf = new Uint8ClampedArray(w * h * 4);
    this.fill(0, 0, w, h, 8, 8, 14);
  }
  fill(x: number, y: number, w: number, h: number, r: number, g: number, b: number): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.floor(x + w));
    const y1 = Math.min(this.h, Math.floor(y + h));
    for (let py = y0; py < y1; py++) {
      let idx = (py * this.w + x0) * 4;
      for (let px = x0; px < x1; px++) {
        this.buf[idx++] = r;
        this.buf[idx++] = g;
        this.buf[idx++] = b;
        this.buf[idx++] = 255;
      }
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, thickness = 1): void {
    // Bresenham with tiny thickness via fill calls
    let x = Math.round(x0), y = Math.round(y0);
    const ex = Math.round(x1), ey = Math.round(y1);
    const dx = Math.abs(ex - x), sx = x < ex ? 1 : -1;
    const dy = -Math.abs(ey - y), sy = y < ey ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 4000; guard++) {
      this.fill(x - Math.floor(thickness / 2), y - Math.floor(thickness / 2), thickness, thickness, r, g, b);
      if (x === ex && y === ey) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }
}

// ---------- Drawing ----------

const STAGE_LINE_COL = [44, 44, 64] as const;
const PLATFORM_COL   = [20, 28, 40] as const;

function drawFrame(cv: Canvas, stage: Stage, f: TraceFrame, scale: number): void {
  // Background
  cv.fill(0, 0, cv.w, cv.h, 8, 8, 14);
  for (const p of stage.platforms) {
    cv.fill(p.x * scale, p.y * scale, p.w * scale, p.h * scale, PLATFORM_COL[0], PLATFORM_COL[1], PLATFORM_COL[2]);
    // edge highlight
    cv.fill(p.x * scale, p.y * scale, p.w * scale, Math.max(1, scale), 60, 60, 80);
  }
  // Goal marker
  if (f.goal.exists) {
    const gx = f.goal.x * scale, gy = f.goal.y * scale;
    cv.fill(gx - 12, gy - 2, 24, 4, 255, 215, 0);
    cv.fill(gx - 2, gy - 12, 4, 24, 255, 215, 0);
  }
  // Fighters
  const W = Math.max(4, Math.round(26 * scale));
  const H = Math.max(8, Math.round(52 * scale));
  drawFighter(cv, f.p0.x * scale, f.p0.y * scale, W, H, 110, 231, 183, f.p0.dead);
  drawFighter(cv, f.p1.x * scale, f.p1.y * scale, W, H, 251, 146, 60, f.p1.dead);
  // Swords (simple line indicating swipe active frames)
  drawSword(cv, f.p0, scale, 255, 250, 240);
  drawSword(cv, f.p1, scale, 255, 250, 240);
  // Token
  if (f.token.exists) {
    cv.fill(f.token.x * scale - 3, f.token.y * scale - 3, 6, 6, 255, 215, 0);
  }
  // Score pips
  const pipSize = Math.max(2, Math.round(6 * scale));
  for (let i = 0; i < f.scoreboard[0]; i++) cv.fill(8 + i * (pipSize + 2), 8, pipSize, pipSize, 110, 231, 183);
  for (let i = 0; i < f.scoreboard[1]; i++) cv.fill(cv.w - 8 - (i + 1) * (pipSize + 2), 8, pipSize, pipSize, 251, 146, 60);
}

function drawFighter(cv: Canvas, cx: number, cy: number, w: number, h: number, r: number, g: number, b: number, dead: boolean): void {
  if (dead) return;
  const x = cx - w / 2;
  const y = cy - h;
  cv.fill(x - 1, y - 1, w + 2, h + 2, 2, 2, 4);
  cv.fill(x, y, w, h, r, g, b);
}

function drawSword(cv: Canvas, p: TraceFrame["p0"], scale: number, r: number, g: number, b: number): void {
  if (p.swipeT <= 0 && p.diveT <= 0) return;
  const bx = p.x * scale + p.facing * 8 * scale;
  const by = p.y * scale - 20 * scale;
  let angle = 0;
  if (p.diveT > 0) angle = Math.PI * 0.46;
  else if (p.swipeT > 0) {
    // approximate mid-swing
    angle = 0;
  }
  const dx = Math.cos(angle) * p.facing;
  const dy = Math.sin(angle);
  const len = 52 * scale;
  const tx = bx + dx * len;
  const ty = by + dy * len;
  cv.line(bx, by, tx, ty, r, g, b, Math.max(2, Math.round(4 * scale)));
}

// ---------- Main ----------

const args = parseArgs(process.argv);
const a = loadConfig(args.a ?? "moonshot");
const b = loadConfig(args.b ?? "shipper");
const stageId = (args.stage as keyof typeof STAGES) ?? "datacenter";
const seed = parseInt(args.seed ?? "1", 10);
const fps = parseInt(args.fps ?? "15", 10);
const scale = parseFloat(args.scale ?? "0.5");
const out = args.out ?? `match-${a.id}-vs-${b.id}-${seed}.gif`;
const maxSec = parseInt(args.maxSec ?? "60", 10);

const stage = STAGES[stageId];
if (!stage) throw new Error(`unknown stage '${stageId}'`);

console.error(`Simulating ${a.id} vs ${b.id}, stage=${stageId}, seed=${seed} ...`);
const t0 = Date.now();
const trace = simulateTrace({ stage, brainA: a, brainB: b, seed });
console.error(`  ticks=${trace.result.ticks}, winner=${trace.result.winner === 0 ? a.id : trace.result.winner === 1 ? b.id : "draw"}`);

// Sample frames. Sim is 120 Hz; we emit at fps Hz.
const stride = Math.max(1, Math.round(120 / fps));
const maxFrames = Math.floor((maxSec * 120) / stride);
const frames: TraceFrame[] = [];
for (let i = 0; i < trace.frames.length; i += stride) {
  frames.push(trace.frames[i]);
  if (frames.length >= maxFrames) break;
}
// Always include the last frame (final scoreboard)
if (trace.frames.length > 0) frames.push(trace.frames[trace.frames.length - 1]);

const W = Math.round(1280 * scale);
const H = Math.round(720 * scale);
console.error(`Encoding ${frames.length} frames at ${W}×${H}, ${fps} fps ...`);

const gif = GIFEncoder();
const delay = Math.round(1000 / fps);
let framesEncoded = 0;
for (const f of frames) {
  const cv = new Canvas(W, H);
  drawFrame(cv, stage, f, scale);
  const palette = quantize(cv.buf, 128);
  const index = applyPalette(cv.buf, palette);
  gif.writeFrame(index, W, H, { palette, delay });
  framesEncoded++;
  if (framesEncoded % 30 === 0) process.stderr.write(`\r  encoding ${framesEncoded}/${frames.length}`);
}
process.stderr.write("\n");
gif.finish();
const bytes = gif.bytes();
fs.writeFileSync(out, bytes);
console.error(`Wrote ${out} (${Math.round(bytes.length / 1024)} KB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
