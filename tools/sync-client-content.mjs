#!/usr/bin/env node
// Sync source-of-truth editorial content into the static client bundle.
// The browser imports from client/content/, while editors should only edit
// content/. This script keeps the shipped copy exact.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const checkOnly = process.argv.includes("--check");

const files = [
  {
    source: "content/game-copy.v1.json",
    target: "client/content/game-copy.v1.json",
  },
];

let changed = false;

for (const file of files) {
  const sourcePath = path.resolve(repoRoot, file.source);
  const targetPath = path.resolve(repoRoot, file.target);
  const source = fs.readFileSync(sourcePath, "utf8");
  JSON.parse(source);

  const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : null;
  if (existing === source) {
    process.stdout.write(`content sync ok: ${file.target}\n`);
    continue;
  }

  changed = true;
  if (checkOnly) {
    process.stderr.write(`content out of sync: ${file.target} differs from ${file.source}\n`);
    continue;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, source);
  process.stdout.write(`synced ${file.source} -> ${file.target}\n`);
}

if (checkOnly && changed) process.exit(1);
