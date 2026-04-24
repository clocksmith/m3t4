#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const DEFAULT_KERNELS = Object.freeze([
  "replay-verify",
  "seed-sweep",
  "asset-tile-audit",
  "image-tile-infer",
  "microscopy-tile-score",
  "exploit-search",
]);

const kernels = (process.env.PLASMA_LAB_SMOKE_LADDER || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const selected = kernels.length ? kernels : DEFAULT_KERNELS;
const smokeScript = path.join(__dirname, "smoke-webrtc-client-artifact.cjs");
const results = [];

for (const kernel of selected) {
  const startedAt = Date.now();
  console.error(`[plasma-lab] strict WebRTC smoke: ${kernel}`);
  const result = spawnSync(process.execPath, [smokeScript, `--kernel=${kernel}`], {
    stdio: "inherit",
    env: {
      ...process.env,
      PLASMA_LAB_SMOKE_KERNEL: kernel,
    },
  });
  results.push({
    kernel,
    ok: result.status === 0,
    status: result.status,
    elapsedMs: Date.now() - startedAt,
  });
  if (result.error) {
    console.error(`[plasma-lab] ${kernel} failed: ${result.error.message}`);
    process.exitCode = 1;
    break;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}

console.error(JSON.stringify({
  ok: results.every((result) => result.ok),
  kernels: selected,
  results,
}, null, 2));
