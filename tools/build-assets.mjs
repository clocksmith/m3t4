#!/usr/bin/env node
// One-command driver: raw generations → client/assets.
//
// Walks generations/raw/assets/ and for each file:
//   1. Invokes tools/postprocess-generation.mjs to promote it (atlas-aware;
//      emits per-slice .png into client/assets/).
// Then, for each character variant with a packed/ dir, runs
//   2. tools/assemble-character-sheet.mjs to build sprite.png.
// Finally, for every promoted .png whose runtime consumer loads .webp
// (stage layers + preview_thumb), emits a .webp alongside via cwebp.
//
// Idempotent-ish: always re-runs postprocess (fast + deterministic).
// Webp conversion skips when the .webp is newer than the source .png
// unless --force is set.
//
// Usage:
//   node tools/build-assets.mjs                # full pipeline
//   node tools/build-assets.mjs --dry-run      # print plan only
//   node tools/build-assets.mjs --only stages  # stages | chars | objectives | ui
//   node tools/build-assets.mjs --sync-webp    # only refresh .webp from existing .png
//   node tools/build-assets.mjs --force        # rewrite webp even if newer than png

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const rawRoot = path.join(repoRoot, "generations/raw/assets");
const clientRoot = path.join(repoRoot, "client");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const syncWebpOnly = args.includes("--sync-webp");
const only = arg("--only");

const WEBP_RE = /\/(layers\/(sky|far_parallax|mid_parallax|near_parallax)|ui\/preview_thumb)\.png$/;

const hasCwebp = checkCwebp();
if (!hasCwebp) {
  process.stdout.write("warn: cwebp not on PATH; webp step will be skipped. Install: brew install webp (macOS) or apt install webp (Linux).\n");
}

const counts = { postprocessed: 0, skipped: 0, assembled: 0, webp: 0, webpSkipped: 0 };
const failures = [];

if (!syncWebpOnly) {
  for (const raw of listRaws()) {
    process.stdout.write(`postprocess: ${path.relative(repoRoot, raw)}\n`);
    if (dryRun) { counts.postprocessed++; continue; }
    const res = tryRun(["node", path.join(__dirname, "postprocess-generation.mjs"), raw]);
    if (res.ok) counts.postprocessed++;
    else { counts.skipped++; failures.push({ path: raw, msg: res.msg }); }
  }
  if (!only || only === "chars") {
    for (const variant of charVariantsWithPackedDir()) {
      process.stdout.write(`assemble: ${path.relative(repoRoot, variant)}\n`);
      if (!dryRun) run(["node", path.join(__dirname, "assemble-character-sheet.mjs"), variant]);
      counts.assembled++;
    }
  }
}

if (hasCwebp) {
  for (const png of listPromotedWebpTargets()) {
    const webp = png.replace(/\.png$/, ".webp");
    if (!force && fs.existsSync(webp) && fs.statSync(webp).mtimeMs >= fs.statSync(png).mtimeMs) {
      counts.webpSkipped++;
      continue;
    }
    process.stdout.write(`webp: ${path.relative(repoRoot, png)} -> .webp\n`);
    if (!dryRun) run(["cwebp", "-quiet", "-q", "85", png, "-o", webp]);
    counts.webp++;
  }
}

if (failures.length) {
  process.stdout.write(`\nskipped ${failures.length} unrecognized raw(s):\n`);
  for (const f of failures) process.stdout.write(`  ${path.relative(repoRoot, f.path)}\n`);
}
process.stdout.write(`\ndone: postprocessed=${counts.postprocessed} skipped=${counts.skipped} assembled=${counts.assembled} webp=${counts.webp} webp-skipped=${counts.webpSkipped}\n`);

function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }

function listRaws() {
  if (!fs.existsSync(rawRoot)) return [];
  const all = [];
  walk(rawRoot, (p) => { if (p.endsWith(".png")) all.push(p); });
  if (!only) return all;
  const prefix = path.join(rawRoot, only === "ui" ? "ui" : only === "chars" ? "chars" : only === "stages" ? "stages" : only === "objectives" ? "objectives" : "");
  return all.filter((p) => p.startsWith(prefix));
}

function listPromotedWebpTargets() {
  const root = path.join(clientRoot, "assets", "stages");
  if (!fs.existsSync(root)) return [];
  const all = [];
  walk(root, (p) => { if (WEBP_RE.test(p)) all.push(p); });
  return all;
}

function charVariantsWithPackedDir() {
  const root = path.join(clientRoot, "assets", "chars");
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const char of fs.readdirSync(root)) {
    const charDir = path.join(root, char);
    if (!fs.statSync(charDir).isDirectory()) continue;
    for (const variant of fs.readdirSync(charDir)) {
      const variantDir = path.join(charDir, variant);
      const packedDir = path.join(variantDir, "packed");
      if (fs.existsSync(packedDir) && fs.statSync(packedDir).isDirectory()) out.push(variantDir);
    }
  }
  return out;
}

function walk(root, visit) {
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) walk(p, visit);
    else visit(p);
  }
}

function run(argv) {
  const res = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
  if (res.status !== 0) { process.stderr.write(`error: ${argv.join(" ")} exited ${res.status}\n`); process.exit(res.status ?? 1); }
}

function tryRun(argv) {
  const res = spawnSync(argv[0], argv.slice(1), { stdio: ["ignore", "inherit", "pipe"], encoding: "utf8" });
  if (res.stderr) process.stderr.write(res.stderr);
  return { ok: res.status === 0, msg: res.stderr?.trim() ?? "" };
}

function checkCwebp() {
  const res = spawnSync("cwebp", ["-version"], { stdio: "ignore" });
  return res.status === 0;
}
