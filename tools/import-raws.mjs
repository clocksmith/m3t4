#!/usr/bin/env node
// Import numbered raw generations into the pipeline.
//
// You paste the 30 prompts from a theming/generated-prompts/<ts>/ run into
// an image generator, download each as NNN.png into one folder, then run:
//
//   node tools/import-raws.mjs <prompts-dir> <numbered-png-dir>
//
// The tool:
//   1. Reads INDEX.md in <prompts-dir> to map NNN -> asset path
//   2. For each NNN.png in <numbered-png-dir>:
//        - erases the Gemini bottom-right sparkle watermark (unless --no-erase)
//        - writes to generations/raw/assets/<asset-path>
//   3. Prints a summary of imported + skipped + unmapped
//
// Afterwards, run `node tools/build-assets.mjs` to slice atlases, assemble
// character sheets, and emit webp.
//
// Flags:
//   --no-erase      skip watermark removal (just copy)
//   --dry-run       print the mapping, touch nothing
//   --only <glob>   only import numbers matching glob (e.g. --only '00[1-7]')
//   --force         overwrite existing raw files

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./lib/png.mjs";
import { eraseBottomRightSparkle } from "./lib/erase-watermark.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const rawRoot = path.join(repoRoot, "generations/raw");

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
if (positional.length < 2 || args.includes("--help") || args.includes("-h")) {
  process.stdout.write("usage: node tools/import-raws.mjs <prompts-dir> <numbered-png-dir> [--no-erase] [--dry-run] [--only <pat>] [--force]\n");
  process.exit(positional.length < 2 ? 1 : 0);
}
const [promptsDirArg, srcDirArg] = positional;
const promptsDir = path.resolve(promptsDirArg);
const srcDir = path.resolve(srcDirArg);
const noErase = args.includes("--no-erase");
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const onlyPat = arg("--only");

const indexPath = path.join(promptsDir, "INDEX.md");
if (!fs.existsSync(indexPath)) { fail(`INDEX.md not found in ${promptsDir}`); }
const mapping = parseIndex(fs.readFileSync(indexPath, "utf8"));

const pngs = fs.readdirSync(srcDir).filter((f) => /^\d{3}\.png$/.test(f)).sort();
if (!pngs.length) fail(`no NNN.png files in ${srcDir}`);

const counts = { imported: 0, skipped: 0, unmapped: 0, overwrote: 0 };
const unmapped = [];

for (const file of pngs) {
  const n = file.slice(0, 3);
  if (onlyPat && !matches(n, onlyPat)) continue;
  const assetPath = mapping.get(n);
  if (!assetPath) { unmapped.push(n); counts.unmapped++; continue; }
  const dst = path.join(rawRoot, assetPath);
  const src = path.join(srcDir, file);
  const exists = fs.existsSync(dst);
  if (exists && !force) {
    process.stdout.write(`skip (exists): ${n} -> ${assetPath}\n`);
    counts.skipped++;
    continue;
  }
  process.stdout.write(`${noErase ? "copy " : "erase"}: ${n} -> ${assetPath}${exists ? "  (overwrite)" : ""}\n`);
  if (dryRun) { counts.imported++; continue; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (noErase) {
    fs.copyFileSync(src, dst);
  } else {
    const img = decodePng(fs.readFileSync(src));
    const bbox = eraseBottomRightSparkle(img);
    fs.writeFileSync(dst, encodePng(img.width, img.height, img.data));
    process.stdout.write(`  erased bbox x=${bbox.x} y=${bbox.y} w=${bbox.width} h=${bbox.height}\n`);
  }
  counts.imported++;
  if (exists) counts.overwrote++;
}

if (unmapped.length) process.stdout.write(`\nunmapped: ${unmapped.join(", ")}\n`);
process.stdout.write(`\ndone: imported=${counts.imported} skipped=${counts.skipped} overwrote=${counts.overwrote} unmapped=${counts.unmapped}\n`);

function parseIndex(text) {
  const m = new Map();
  const re = /^\|\s*(\d{3})\s*\|\s*\[[^\]]+\]\([^)]+\)\s*\|\s*`([^`]+)`\s*\|/gm;
  let match;
  while ((match = re.exec(text)) !== null) m.set(match[1], match[2]);
  return m;
}

function matches(n, pat) {
  const re = new RegExp("^" + pat.replace(/\[/g, "[").replace(/\]/g, "]").replace(/\?/g, ".").replace(/\*/g, ".*") + "$");
  return re.test(n);
}

function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
function fail(msg) { process.stderr.write(`error: ${msg}\n`); process.exit(1); }
