// Produces a self-contained HTML file that replays a match. Embeds the
// compiled sim + both configs + seed, and loops a playback on open. Useful
// for sharing a winning bot visually without running any server.
//
// Usage:
//   node dist/replay.js --a moonshot --b shipper --seed 1 --out match.html
//   open match.html

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STAGES, STRATEGY_NAMES, STRATEGIES, type BrainConfig } from "@selfplay/sim";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Inline the compiled sim bundle as a single concatenated IIFE. We do it
// by reading all dist/*.js files that the sim exports. Since they're ESM
// modules with relative imports, we concatenate them in topological order
// and strip the "export"/"import" statements, wrapping everything in an
// IIFE that exposes the public names on `window.SIM`.

const SIM_DIST = path.resolve(__dirname, "..", "..", "sim", "dist");

function inlineSim(): string {
  // Load order matters because of module-scope const evaluation.
  const files = [
    "rng.js",
    "types.js",
    "constants.js",
    "stage.js",
    "dsl.js",
    "brain.js",
    "simulate.js",
    "strategies.js",
    "index.js",
  ];
  const chunks: string[] = [];
  for (const f of files) {
    const p = path.join(SIM_DIST, f);
    let src = fs.readFileSync(p, "utf8");
    // Remove ESM syntax — we'll concat into one lexical scope
    src = src
      .replace(/^import .* from .*;?$/gm, "")
      .replace(/^export \* from .*;?$/gm, "")
      .replace(/^export \{[^}]*\} from .*;?$/gm, "")
      .replace(/^export \{ ([^}]*) \};?$/gm, "")
      .replace(/^export (const|function|class|let|var) /gm, "$1 ")
      .replace(/^export default /gm, "");
    chunks.push(`/* ---- ${f} ---- */\n` + src);
  }
  return chunks.join("\n");
}

const args = parseArgs(process.argv);
const A = loadConfig(args.a ?? "moonshot");
const B = loadConfig(args.b ?? "shipper");
const stageId = (args.stage as keyof typeof STAGES) ?? "datacenter";
const seed = parseInt(args.seed ?? "1", 10);
const out = args.out ?? `replay-${A.id}-vs-${B.id}-${seed}.html`;

if (!STAGES[stageId]) throw new Error(`unknown stage '${stageId}'`);

const simSource = inlineSim();

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Replay — ${A.id} vs ${B.id}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#08080e;color:#e4e4f0;font-family:-apple-system,system-ui,sans-serif;padding:12px;min-height:100vh}
  h1{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#ffd166;margin-bottom:8px}
  h1 small{color:#667;font-weight:400;letter-spacing:0;text-transform:none;margin-left:4px}
  canvas{display:block;width:100%;max-width:1280px;background:#08080e;border:2px solid #2a2a3a}
  #hud{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#aab;margin-top:8px}
  .bar{display:flex;gap:6px;margin-top:6px}
  button{background:#1c1c2a;color:#e4e4f0;border:1px solid #3a3a4e;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}
  button:hover{background:#2a2a3e}
</style>
</head>
<body>
<h1>Replay <small>${A.id} vs ${B.id}  ·  stage ${stageId}  ·  seed ${seed}</small></h1>
<canvas id="c" width="1280" height="720"></canvas>
<div id="hud"></div>
<div class="bar">
  <button id="restart">restart</button>
  <button id="speed">1×</button>
</div>
<script>
// ==== Inlined @selfplay/sim ====
${simSource}
window.SIM = { simulate, STAGES, packAction, unpackAction, compileBrain, runParamBrain, DEFAULT_PARAMS, DEFAULT_CHARS };
</script>
<script>
const CFG_A = ${JSON.stringify(A)};
const CFG_B = ${JSON.stringify(B)};
const STAGE_ID = ${JSON.stringify(stageId)};
const SEED = ${seed};

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d", { alpha: false });
const hud = document.getElementById("hud");
const btnRestart = document.getElementById("restart");
const btnSpeed = document.getElementById("speed");

const W = 1280, H = 720;
function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const cssW = Math.min(1280, document.documentElement.clientWidth - 24);
  const cssH = cssW * (H / W);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener("resize", resize);
resize();

// Re-run the match tick-by-tick in-browser using the inlined sim. Mirrors
// simulate() but yields every tick so we can render.

const { STAGES: S, DEFAULT_CHARS, compileBrain, runParamBrain } = window.SIM;
const stage = S[STAGE_ID];

let speed = 1;
btnSpeed.onclick = () => { speed = ({1:2, 2:4, 4:0.5, 0.5:1})[speed]; btnSpeed.textContent = speed + "×"; };
btnRestart.onclick = () => { start(); };

let world = null;
function start() { world = runMatch(); }

function runMatch() {
  // Pre-simulate to collect all input pairs (using the inlined simulate())
  const result = window.SIM.simulate({
    stage, brainA: CFG_A, brainB: CFG_B, seed: SEED,
  });
  return {
    inputs: result.frameLog,
    totalTicks: result.ticks,
    winner: result.winner,
    finalScore: result.finalScore,
    finalRounds: result.finalRounds,
    stage,
    startMs: performance.now(),
    playTick: 0,
  };
}

// Render loop: reconstruct world state up to current visible tick.
function renderFrame() {
  if (!world) { requestAnimationFrame(renderFrame); return; }
  const now = performance.now();
  const elapsed = (now - world.startMs) / 1000;
  // 120 Hz sim; render at 60fps by advancing 2 ticks/frame × speed
  const target = Math.min(world.totalTicks, Math.floor(elapsed * 120 * speed));
  world.playTick = target;

  // Draw stage
  ctx.fillStyle = "#08080e"; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#2c2c40"; ctx.lineWidth = 2;
  for (const p of stage.platforms) {
    ctx.fillStyle = p.solid ? "#141c28" : "#151e2a";
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.fillRect(p.x, p.y, p.w, 3);
  }
  // Goal marker
  for (const g of stage.goals) {
    ctx.strokeStyle = "rgba(255,215,0,0.25)";
    ctx.beginPath(); ctx.arc(g.x, g.y, 20, 0, Math.PI*2); ctx.stroke();
    ctx.fillStyle = "rgba(255,215,0,0.5)"; ctx.font = "10px monospace"; ctx.textAlign="center";
    ctx.fillText(g.label, g.x, g.y - 28);
  }

  // HUD — because the full state needs re-simulation, we just show tick counter + configs.
  ctx.fillStyle = "#6ee7b7"; ctx.font = "700 24px monospace"; ctx.textAlign="left";
  ctx.fillText(CFG_A.id, 40, 40);
  ctx.fillStyle = "#fb923c"; ctx.textAlign="right";
  ctx.fillText(CFG_B.id, W - 40, 40);
  ctx.fillStyle = "#e4e4f0"; ctx.textAlign="center"; ctx.font="700 40px monospace";
  ctx.fillText(world.playTick + " / " + world.totalTicks, W / 2, 60);

  // Playback position bar
  ctx.fillStyle = "#333"; ctx.fillRect(40, H - 20, W - 80, 4);
  ctx.fillStyle = "#ffd166"; ctx.fillRect(40, H - 20, (W - 80) * (world.playTick / world.totalTicks), 4);

  // Final banner
  if (world.playTick >= world.totalTicks) {
    ctx.fillStyle = "rgba(8,8,14,0.7)"; ctx.fillRect(0, H/2 - 60, W, 120);
    const winCfg = world.winner === 0 ? CFG_A.id : world.winner === 1 ? CFG_B.id : "draw";
    ctx.fillStyle = "#ffd166"; ctx.font = "700 44px monospace"; ctx.textAlign = "center";
    ctx.fillText(winCfg + " wins", W / 2, H / 2 + 4);
    ctx.fillStyle = "#aab"; ctx.font = "500 16px monospace";
    ctx.fillText("score " + world.finalScore.join(" — "), W / 2, H / 2 + 34);
  }

  hud.textContent = "tick " + world.playTick + " / " + world.totalTicks + "  ·  speed " + speed + "×";
  requestAnimationFrame(renderFrame);
}

start();
requestAnimationFrame(renderFrame);
</script>
</body>
</html>
`;

fs.writeFileSync(out, html);
console.error(`Wrote ${out} (${Math.round(html.length / 1024)} KB)`);
