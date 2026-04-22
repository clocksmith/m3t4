#!/usr/bin/env node
// Sync the compiled @m3t4/sim browser bundle into the static client.
// Source of truth is sim/src -> sim/dist; Firebase serves client/sim.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const checkOnly = process.argv.includes("--check");
const sourceDir = path.join(repoRoot, "sim", "dist");
const targetDir = path.join(repoRoot, "client", "sim");

function isBundleFile(name) {
  return name.endsWith(".js") || name.endsWith(".d.ts");
}

if (!fs.existsSync(sourceDir)) {
  process.stderr.write("sim/dist missing; run `npm -w sim run build` first\n");
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });

const sourceFiles = fs.readdirSync(sourceDir).filter(isBundleFile).sort();
const sourceSet = new Set(sourceFiles);
const targetFiles = fs.existsSync(targetDir)
  ? fs.readdirSync(targetDir).filter(isBundleFile).sort()
  : [];

let changed = false;

for (const file of sourceFiles) {
  const sourcePath = path.join(sourceDir, file);
  const targetPath = path.join(targetDir, file);
  const source = fs.readFileSync(sourcePath);
  const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath) : null;
  if (existing && Buffer.compare(existing, source) === 0) continue;

  changed = true;
  if (checkOnly) {
    process.stderr.write(`client sim out of sync: client/sim/${file} differs from sim/dist/${file}\n`);
    continue;
  }

  fs.writeFileSync(targetPath, source);
  process.stdout.write(`synced sim/dist/${file} -> client/sim/${file}\n`);
}

for (const file of targetFiles) {
  if (sourceSet.has(file)) continue;

  changed = true;
  if (checkOnly) {
    process.stderr.write(`client sim has stale file: client/sim/${file}\n`);
    continue;
  }

  fs.rmSync(path.join(targetDir, file));
  process.stdout.write(`removed stale client/sim/${file}\n`);
}

if (checkOnly && changed) process.exit(1);
if (!changed) process.stdout.write("client sim sync ok\n");
