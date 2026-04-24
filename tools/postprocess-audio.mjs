#!/usr/bin/env node
// Post-process raw text-to-audio wavs into browser-ready assets.
//
// Three pipelines, dispatched on input path:
//
//   generations/raw/audio/batches/<batchId>.wav
//     → slice on silence gaps, trim/normalize/pad each cue, contribute
//       to the global sprite. Run with --sprite after all batches are
//       processed to emit client/assets/audio/sfx/sprite.webm + manifest.
//
//   generations/raw/audio/stages/<stage>/<variant>/music.wav
//     → verify loop seam, LUFS-normalize, opus-encode stereo loop to
//       client/assets/stages/<stage>/<variant>/music.webm.
//
//   generations/raw/audio/stages/<stage>/<variant>/impact_ir.wav
//     → trim leading silence, cap tail to 800ms, unit-normalize IR
//       energy, opus-encode to .../impact_ir.webm.
//
// Requires ffmpeg + ffprobe on PATH. Also uses ffmpeg's silencedetect
// filter for batch slicing and ebur128 for LUFS.
//
// Usage:
//   node tools/postprocess-audio.mjs generations/raw/audio/batches/swipes.wav
//   node tools/postprocess-audio.mjs generations/raw/audio/stages/datacenter/cold_aisle_chapel/music.wav
//   node tools/postprocess-audio.mjs --sprite   # after all batches sliced
//   node tools/postprocess-audio.mjs --all      # every raw file + sprite

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const rawRoot = path.resolve(repoRoot, "generations/raw/audio");
const clientRoot = path.resolve(repoRoot, "client");
const cacheRoot = path.resolve(repoRoot, "generations/intermediate/audio");
const SSOT = path.resolve(repoRoot, "audio/audio-theme.v1.json");
const doc = JSON.parse(fs.readFileSync(SSOT, "utf8"));

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  process.stdout.write(fs.readFileSync(import.meta.url.replace("file://", ""), "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n") + "\n");
  process.exit(args.length === 0 ? 1 : 0);
}

assertFfmpeg();

const doAll = args.includes("--all");
const buildSprite = args.includes("--sprite") || doAll;
const inputArgs = args.filter((a) => !a.startsWith("--"));

if (doAll) {
  for (const b of Object.keys(doc.batches)) if (!b.startsWith("_")) tryProcess(path.join(rawRoot, "batches", `${b}.wav`));
  for (const [stage, vs] of Object.entries(doc.stageMusicPacks)) for (const v of Object.keys(vs)) tryProcess(path.join(rawRoot, "stages", stage, v, "music.wav"));
  for (const [stage, vs] of Object.entries(doc.stageImpactReverb.stages)) for (const v of Object.keys(vs)) tryProcess(path.join(rawRoot, "stages", stage, v, "impact_ir.wav"));
} else {
  for (const input of inputArgs) processInput(path.resolve(input));
}

if (buildSprite) assembleSprite();

function tryProcess(p) {
  if (fs.existsSync(p)) processInput(p);
  else process.stdout.write(`skip (missing): ${path.relative(process.cwd(), p)}\n`);
}

function processInput(inputPath) {
  const rel = path.relative(rawRoot, inputPath);
  if (rel.startsWith("batches/")) return processBatch(inputPath);
  if (rel.endsWith("music.wav")) return processMusic(inputPath);
  if (rel.endsWith("impact_ir.wav")) return processIr(inputPath);
  fail(`unrecognized input: ${inputPath}`);
}

function processBatch(inputPath) {
  const batchId = path.basename(inputPath, ".wav");
  const batch = doc.batches[batchId];
  if (!batch) fail(`unknown batch: ${batchId}`);
  const cues = batch.cuesOrder;
  const proto = doc.batches._batchProtocol;
  const minSilenceS = (proto.interCueSilenceMs * 0.7) / 1000;
  const floorDb = proto.sliceFloorDbfs;

  const silences = detectSilence(inputPath, floorDb, minSilenceS);
  // silencedetect emits start/end per silence region; split points are at
  // midpoints, producing N = silenceCount + 1 slices. For the last trailing
  // silence we ignore its "end" past the tail.
  const splits = silences.map((s) => (s.start + s.end) / 2);
  const expectedSlices = cues.length;
  if (splits.length + 1 !== expectedSlices) {
    fail(`batch ${batchId}: expected ${expectedSlices} slices, detected ${splits.length + 1} from ${silences.length} silence regions. check that the wav has ${expectedSlices - 1} gaps >= ${proto.interCueSilenceMs}ms.`);
  }

  const batchDir = path.join(cacheRoot, "cues", batchId);
  fs.mkdirSync(batchDir, { recursive: true });
  const duration = probeDuration(inputPath);
  const bounds = [0, ...splits, duration];
  const targetLUFS = doc.meta.format.targetLUFS.sfx;
  const peakCeil = doc.meta.format.peakCeilingDb;
  const padMs = doc.spritePack.padTrailingMs;

  for (let i = 0; i < expectedSlices; i++) {
    const cueId = cues[i];
    const targetSec = doc.sfx[cueId].durationSec;
    const start = bounds[i];
    const end = bounds[i + 1];
    const rawSlice = path.join(batchDir, `${cueId}.raw.wav`);
    const processed = path.join(batchDir, `${cueId}.wav`);
    run(["ffmpeg", "-y", "-loglevel", "error", "-ss", String(start), "-to", String(end), "-i", inputPath, "-ac", "1", "-ar", "48000", rawSlice]);
    // trim leading silence, cut/pad to target, normalize, peak-limit, append pad
    const filter = [
      "silenceremove=start_periods=1:start_duration=0.01:start_threshold=-50dB",
      `atrim=0:${targetSec}`,
      `apad=pad_dur=${Math.max(0, targetSec - 0.0001)}`,
      `atrim=0:${targetSec}`,
      `loudnorm=I=${targetLUFS}:TP=${peakCeil}:LRA=7`,
      `apad=pad_dur=${padMs / 1000}`,
    ].join(",");
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", rawSlice, "-af", filter, "-ac", "1", "-ar", "48000", processed]);
    process.stdout.write(`cue ${cueId}: sliced [${fmt(start)}–${fmt(end)}] → ${path.relative(repoRoot, processed)}\n`);
  }
}

function processMusic(inputPath) {
  const parts = path.relative(rawRoot, inputPath).split(path.sep);
  const [, stage, variant] = parts;
  const entry = doc.stageMusicPacks[stage]?.[variant];
  if (!entry) fail(`unknown music stage/variant: ${stage}/${variant}`);
  verifyLoopSeam(inputPath, stage === "demoday" ? 0.75 : 0.5);
  const outPath = path.resolve(clientRoot, entry.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const targetLUFS = doc.meta.format.targetLUFS.music;
  const peakCeil = doc.meta.format.peakCeilingDb;
  run([
    "ffmpeg", "-y", "-loglevel", "error", "-i", inputPath,
    "-af", `loudnorm=I=${targetLUFS}:TP=${peakCeil}:LRA=11`,
    "-c:a", "libopus", "-b:a", "128k", "-ac", "2", "-ar", "48000",
    outPath,
  ]);
  process.stdout.write(`music ${stage}/${variant} → ${path.relative(repoRoot, outPath)}\n`);
}

function processIr(inputPath) {
  const parts = path.relative(rawRoot, inputPath).split(path.sep);
  const [, stage, variant] = parts;
  const entry = doc.stageImpactReverb.stages[stage]?.[variant];
  if (!entry) fail(`unknown ir stage/variant: ${stage}/${variant}`);
  const maxTail = doc.stageImpactReverb.runtimeBus.maxTailMs / 1000;
  const outPath = path.resolve(clientRoot, entry.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const filter = [
    "silenceremove=start_periods=1:start_duration=0.005:start_threshold=-60dB",
    `atrim=0:${maxTail}`,
    "loudnorm=I=-23:TP=-1:LRA=7",
  ].join(",");
  run([
    "ffmpeg", "-y", "-loglevel", "error", "-i", inputPath,
    "-af", filter,
    "-c:a", "libopus", "-b:a", "96k", "-ar", "48000",
    outPath,
  ]);
  process.stdout.write(`ir ${stage}/${variant} → ${path.relative(repoRoot, outPath)}\n`);
}

function assembleSprite() {
  const cuesDir = path.join(cacheRoot, "cues");
  const clips = [];
  for (const id of doc.spritePack.order) {
    const batch = doc.sfx[id].batch;
    const p = path.join(cuesDir, batch, `${id}.wav`);
    if (!fs.existsSync(p)) fail(`missing processed cue: ${p} — run the batch that contains ${id} first`);
    clips.push(p);
  }

  const listFile = path.join(cacheRoot, "sprite-concat.txt");
  fs.writeFileSync(listFile, clips.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  const concatWav = path.join(cacheRoot, "sprite.wav");
  run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-ac", "1", "-ar", "48000", concatWav]);

  // build manifest from processed cue durations, offsets NOT including
  // the trailing pad so runtime playback windows land on the cue end.
  const padMs = doc.spritePack.padTrailingMs;
  const manifest = {};
  let cursor = 0;
  for (const id of doc.spritePack.order) {
    const batch = doc.sfx[id].batch;
    const p = path.join(cuesDir, batch, `${id}.wav`);
    const total = probeDuration(p) * 1000;
    const cueEnd = total - padMs;
    manifest[id] = [Math.round(cursor), Math.round(cursor + cueEnd)];
    cursor += total;
  }

  const spriteOut = path.resolve(clientRoot, doc.spritePack.out);
  const manifestOut = path.resolve(clientRoot, doc.spritePack.manifestOut);
  fs.mkdirSync(path.dirname(spriteOut), { recursive: true });
  run(["ffmpeg", "-y", "-loglevel", "error", "-i", concatWav, "-c:a", "libopus", "-b:a", "96k", "-ac", "1", "-ar", "48000", spriteOut]);
  fs.writeFileSync(manifestOut, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(`sprite → ${path.relative(repoRoot, spriteOut)}\n`);
  process.stdout.write(`manifest → ${path.relative(repoRoot, manifestOut)} (${Object.keys(manifest).length} regions, ${Math.round(cursor)}ms total)\n`);
}

function detectSilence(inputPath, floorDb, minDurSec) {
  const res = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", inputPath, "-af", `silencedetect=noise=${floorDb}dB:d=${minDurSec}`, "-f", "null", "-"], { encoding: "utf8" });
  const text = (res.stderr ?? "") + (res.stdout ?? "");
  const starts = [...text.matchAll(/silence_start:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  const ends = [...text.matchAll(/silence_end:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  const out = [];
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) out.push({ start: starts[i], end: ends[i] });
  return out;
}

function verifyLoopSeam(inputPath, headTailSec) {
  const duration = probeDuration(inputPath);
  if (duration < headTailSec * 2 + 1) fail(`music too short for seam check: ${inputPath}`);
  const head = sliceStats(inputPath, 0, headTailSec);
  const tail = sliceStats(inputPath, duration - headTailSec, headTailSec);
  const rmsDelta = Math.abs(head.rmsDb - tail.rmsDb);
  if (rmsDelta > 1.0) fail(`loop seam RMS mismatch ${rmsDelta.toFixed(2)} dB > 1 dB in ${inputPath}`);
}

function sliceStats(inputPath, startSec, durSec) {
  const tmp = path.join(os.tmpdir(), `m3t4-seam-${Math.random().toString(36).slice(2)}.wav`);
  run(["ffmpeg", "-y", "-loglevel", "error", "-ss", String(startSec), "-t", String(durSec), "-i", inputPath, tmp]);
  const res = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", tmp, "-af", "astats=metadata=1:reset=0", "-f", "null", "-"], { encoding: "utf8" });
  fs.unlinkSync(tmp);
  const text = (res.stderr ?? "") + (res.stdout ?? "");
  const rms = Number([...text.matchAll(/RMS level dB:\s*(-?[0-9.]+)/g)].map((m) => Number(m[1])).pop() ?? -Infinity);
  return { rmsDb: rms };
}

function probeDuration(inputPath) {
  const res = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputPath], { encoding: "utf8" });
  if (res.status !== 0) fail(`ffprobe failed for ${inputPath}: ${res.stderr}`);
  return Number(res.stdout.trim());
}

function run(argv) {
  const res = spawnSync(argv[0], argv.slice(1), { stdio: ["ignore", "inherit", "inherit"] });
  if (res.status !== 0) fail(`command failed: ${argv.join(" ")}`);
}

function assertFfmpeg() {
  const a = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  const b = spawnSync("ffprobe", ["-version"], { encoding: "utf8" });
  if (a.status !== 0 || b.status !== 0) {
    process.stderr.write("ffmpeg and ffprobe are required on PATH. Install: brew install ffmpeg (macOS) or apt install ffmpeg (Linux).\n");
    process.exit(1);
  }
}

function fmt(s) { return `${s.toFixed(2)}s`; }
function fail(msg) { process.stderr.write(`error: ${msg}\n`); process.exit(1); }
