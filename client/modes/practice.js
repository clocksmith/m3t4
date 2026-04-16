// Practice mode — local 11-attribute sim. Human keyboard + AI preset,
// mix and match. Drives the same engine the server uses via the stepper
// API (@m3t4/sim createStepperWorld/stepWorld).

import {
  STAGES, STRATEGIES, STRATEGY_NAMES,
  createStepperWorld, runBrainForWorld, stepWorld, worldToFrame,
  compileBrain,
} from "../sim/index.js";
import { setupCanvas, drawFrame, W, H } from "../lib/render.js";

const STEP = 1 / 120;
const MAX_DT = 0.05;

const KEY_MAP = [
  { left: "KeyA", right: "KeyD", up: "KeyW", down: "KeyS", act: "KeyF", tag: "WASD+F" },
  { left: "KeyL", right: "Quote", up: "KeyP", down: "Semicolon", act: "BracketLeft", tag: "PL;'+[" },
];

const keyset = new Set();
function onKeyDown(e) {
  keyset.add(e.code);
  if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Space","Semicolon"].includes(e.code)) e.preventDefault();
}
function onKeyUp(e) { keyset.delete(e.code); }

let world = null;
let ctx = null;
let canvas = null;
let rafId = 0;
let lastTime = performance.now();
let acc = 0;
let running = false;

let controllers = ["ai", "ai"];
let presets = ["blitz", "shipper"];
let compiled = [null, null];

function recompileBrains() {
  for (let i = 0; i < 2; i++) {
    if (controllers[i] === "ai") {
      try { compiled[i] = compileBrain(STRATEGIES[presets[i]]); }
      catch (e) { compiled[i] = null; }
    } else compiled[i] = null;
  }
}

function readKeyboard(idx) {
  const k = KEY_MAP[idx];
  const left = keyset.has(k.left);
  const right = keyset.has(k.right);
  return {
    left, right,
    up: keyset.has(k.up),
    down: keyset.has(k.down),
    action: keyset.has(k.act),
  };
}

function readBrain(idx) {
  const brain = compiled[idx];
  if (!brain) return {};
  const a = runBrainForWorld(world, brain, idx) || {};
  return {
    left: !!a.left, right: !!a.right,
    up: !!a.up, down: !!a.down,
    action: !!a.action,
  };
}

function readInput(idx) {
  return controllers[idx] === "human" ? readKeyboard(idx) : readBrain(idx);
}

function resetMatch() {
  world = createStepperWorld({
    stage: STAGES.datacenter,
    seed: Math.floor(Math.random() * 1e9),
  });
}

export function mount(root, { setStatus }) {
  setStatus("practice");
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Practice <small>— local sim, 11-attribute canonical balance</small></h1>
        <div id="practice-hud" class="tight"></div>
      </div>
      <div class="panel">
        <div class="row" style="flex-wrap:wrap; gap:14px;">
          <label>P1 <select id="p1ctrl">
            <option value="human">Human (WASD+F)</option>
            <option value="ai" selected>AI Brain</option>
          </select></label>
          <select id="p1preset">${STRATEGY_NAMES.map((n) => `<option ${n === "blitz" ? "selected" : ""}>${n}</option>`).join("")}</select>
          <span class="tight">vs</span>
          <label>P2 <select id="p2ctrl">
            <option value="human">Human (PL;'+[)</option>
            <option value="ai" selected>AI Brain</option>
          </select></label>
          <select id="p2preset">${STRATEGY_NAMES.map((n) => `<option ${n === "shipper" ? "selected" : ""}>${n}</option>`).join("")}</select>
          <button id="reset-btn">Reset match</button>
          <span class="tight" id="tick-hud"></span>
        </div>
      </div>
      <canvas id="practice-canvas" width="${W}" height="${H}" tabindex="0"></canvas>
      <div class="panel tight">
        <h3>Controls</h3>
        P1: W/A/S/D move, F attack &nbsp;·&nbsp; P2: P/L/;/' move, [ attack<br>
        Down-while-airborne + attack = dive. Hold up for full jump.
      </div>
    </div>`;

  canvas = root.querySelector("#practice-canvas");
  const { ctx: c } = setupCanvas(canvas);
  ctx = c;
  canvas.focus();

  const p1ctrl = root.querySelector("#p1ctrl");
  const p2ctrl = root.querySelector("#p2ctrl");
  const p1preset = root.querySelector("#p1preset");
  const p2preset = root.querySelector("#p2preset");

  p1ctrl.addEventListener("change", () => { controllers[0] = p1ctrl.value; recompileBrains(); });
  p2ctrl.addEventListener("change", () => { controllers[1] = p2ctrl.value; recompileBrains(); });
  p1preset.addEventListener("change", () => { presets[0] = p1preset.value; recompileBrains(); });
  p2preset.addEventListener("change", () => { presets[1] = p2preset.value; recompileBrains(); });
  root.querySelector("#reset-btn").addEventListener("click", resetMatch);

  addEventListener("keydown", onKeyDown);
  addEventListener("keyup", onKeyUp);

  recompileBrains();
  resetMatch();

  running = true;
  lastTime = performance.now();
  acc = 0;
  loop();
}

export function unmount() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  removeEventListener("keydown", onKeyDown);
  removeEventListener("keyup", onKeyUp);
  keyset.clear();
  world = null;
}

function loop() {
  if (!running) return;
  const now = performance.now();
  const dt = Math.min(MAX_DT, (now - lastTime) / 1000);
  lastTime = now;
  acc += dt;
  while (acc >= STEP) {
    if (world && world.matchWinner === -1) {
      const a = readInput(0);
      const b = readInput(1);
      stepWorld(world, a, b);
    }
    acc -= STEP;
  }
  if (world) {
    const frame = worldToFrame(world);
    const labels = {
      p1: `${controllers[0] === "human" ? "Human" : presets[0]}`,
      p2: `${controllers[1] === "human" ? "Human" : presets[1]}`,
    };
    drawFrame(ctx, world.stage, frame, labels);
    const hud = document.getElementById("tick-hud");
    if (hud) hud.textContent = `tick ${world.tick}  ·  ${world.matchWinner === -1 ? "live" : "winner P" + (world.matchWinner + 1)}`;
  }
  rafId = requestAnimationFrame(loop);
}
