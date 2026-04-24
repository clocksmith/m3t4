#!/usr/bin/env node
// Expand audio/audio-theme.v1.json into paste-ready text-to-audio prompts.
//
// 15 batch prompts (each produces a wav containing multiple sfx separated
// by 1000ms silence; sliced by tools/postprocess-audio.mjs), plus 3 stage
// music prompts and 3 impact-IR prompts = 21 prompts total.
//
// Usage:
//   node tools/build-audio-prompts.mjs                        # playable batch, .txt per prompt
//   node tools/build-audio-prompts.mjs --only batches         # (batches | music | ir)
//   node tools/build-audio-prompts.mjs --only music
//   node tools/build-audio-prompts.mjs --only ir
//   node tools/build-audio-prompts.mjs --format jsonl         # raw JSONL to stdout
//   node tools/build-audio-prompts.mjs --format jsonl --out prompts.jsonl
//   node tools/build-audio-prompts.mjs --stdout               # print .txt blocks to stdout

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const SSOT = path.resolve(repoRoot, "audio/audio-theme.v1.json");
const doc = JSON.parse(fs.readFileSync(SSOT, "utf8"));

const args = process.argv.slice(2);
const only = arg("--only");
const format = arg("--format") ?? "text";
const stdout = args.includes("--stdout");
const explicitOut = arg("--out");
const outputDir = arg("--output-dir") ?? path.resolve(repoRoot, "audio/generated-prompts");

const records = [];
if (!only || only === "batches") records.push(...collectBatches());
if (!only || only === "music")   records.push(...collectMusic());
if (!only || only === "ir")      records.push(...collectIr());

if (format === "jsonl") {
  const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  if (stdout || !explicitOut) process.stdout.write(text);
  else { fs.writeFileSync(path.resolve(explicitOut), text); process.stdout.write(`wrote ${records.length} prompts to ${explicitOut}\n`); }
  process.exit(0);
}

if (stdout) {
  for (const r of records) process.stdout.write(splitBlock(r) + "\n\n");
  process.exit(0);
}

const dir = explicitOut ? path.resolve(explicitOut) : defaultOutputDir();
fs.mkdirSync(dir, { recursive: true });
const rows = [];
for (const [i, r] of records.entries()) {
  const n = String(i + 1).padStart(3, "0");
  const file = `${n}-${slug(r.id)}.txt`;
  fs.writeFileSync(path.join(dir, file), splitBlock(r).trimEnd() + "\n");
  rows.push({ n, file, r });
}
fs.writeFileSync(path.join(dir, "INDEX.md"), buildIndex(rows));
process.stdout.write(`wrote ${rows.length} audio prompt files to ${path.relative(process.cwd(), dir)}\n`);
process.stdout.write(`index: ${path.relative(process.cwd(), path.join(dir, "INDEX.md"))}\n`);

function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function collectBatches() {
  const tone = doc.meta.audioTone;
  const out = [];
  for (const [id, b] of Object.entries(doc.batches)) {
    if (id.startsWith("_")) continue;
    const cues = b.cuesOrder.map((cueId) => ({ id: cueId, durationSec: doc.sfx[cueId]?.durationSec }));
    out.push({
      kind: "batch",
      id,
      rawPath: `generations/raw/audio/batches/${id}.wav`,
      prompt: [tone, "", b.prompt].join("\n"),
      cuesOrder: b.cuesOrder,
      cues,
      interCueSilenceMs: doc.batches._batchProtocol.interCueSilenceMs,
      trailingSilenceMs: doc.batches._batchProtocol.trailingSilenceMs,
    });
  }
  return out;
}

function collectMusic() {
  const tone = doc.meta.audioTone;
  const out = [];
  for (const [stageId, variants] of Object.entries(doc.stageMusicPacks)) {
    for (const [variantId, entry] of Object.entries(variants)) {
      out.push({
        kind: "music",
        id: `music_${stageId}_${variantId}`,
        stageId, variantId,
        out: entry.out,
        rawPath: `generations/raw/audio/stages/${stageId}/${variantId}/music.wav`,
        durationSec: entry.durationSec,
        loop: entry.loop === true,
        prompt: [tone, "", entry.prompt].join("\n"),
      });
    }
  }
  return out;
}

function collectIr() {
  const tone = doc.meta.audioTone;
  const out = [];
  for (const [stageId, variants] of Object.entries(doc.stageImpactReverb.stages)) {
    for (const [variantId, entry] of Object.entries(variants)) {
      out.push({
        kind: "ir",
        id: `ir_${stageId}_${variantId}`,
        stageId, variantId,
        out: entry.out,
        rawPath: `generations/raw/audio/stages/${stageId}/${variantId}/impact_ir.wav`,
        durationSec: entry.durationSec,
        wetSendDb: entry.wetSendDb,
        prompt: [tone, "", entry.prompt].join("\n"),
      });
    }
  }
  return out;
}

function splitBlock(r) {
  if (r.kind === "batch") {
    const cueLines = r.cues.map((c, i) => `  ${i + 1}. ${c.id} (~${Math.round((c.durationSec ?? 0) * 1000)}ms)`).join("\n");
    return [
      `=== ${r.id} (batch, ${r.cues.length} cues)`,
      `# raw output path: ${r.rawPath}`,
      `# inter-cue silence: ${r.interCueSilenceMs}ms  trailing: ${r.trailingSilenceMs}ms`,
      `# slice order:`,
      cueLines,
      "",
      r.prompt,
    ].join("\n");
  }
  if (r.kind === "music") {
    return [
      `=== ${r.id} (music loop, ${r.durationSec}s)`,
      `# raw output path: ${r.rawPath}`,
      `# promoted path: ${r.out}`,
      `# loop: ${r.loop}`,
      "",
      r.prompt,
    ].join("\n");
  }
  return [
    `=== ${r.id} (impact IR, ${r.durationSec}s, wetSend ${r.wetSendDb} dB)`,
    `# raw output path: ${r.rawPath}`,
    `# promoted path: ${r.out}`,
    "",
    r.prompt,
  ].join("\n");
}

function buildIndex(rows) {
  const lines = [
    "# Generated Audio Prompts",
    "",
    `- Bucket: ${only ?? "launch"}`,
    `- Count: ${rows.length}`,
    `- SSOT: audio/audio-theme.v1.json`,
    "",
    "Every `.txt` file is a paste-ready text-to-audio prompt. Drop raw wavs into `generations/raw/audio/…` paths listed at the top of each file, then run `tools/postprocess-audio.mjs`.",
    "",
    "| # | file | id | kind | raw path |",
    "|---:|---|---|---|---|",
  ];
  for (const { n, file, r } of rows) {
    lines.push(`| ${n} | [${file}](./${file}) | \`${r.id}\` | ${r.kind} | \`${r.rawPath}\` |`);
  }
  return lines.join("\n") + "\n";
}

function defaultOutputDir() {
  const iso = new Date().toISOString();
  const date = iso.slice(0, 10).replace(/-/g, "");
  const time = iso.slice(11, 19).replace(/:/g, "");
  const bucket = only ?? "launch";
  return path.join(outputDir, `${date}-${time}-${bucket}-audio-files`);
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
