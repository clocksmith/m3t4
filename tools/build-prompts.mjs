#!/usr/bin/env node
// Expand theming/visual-theme.v1.json into one prompt-per-asset,
// ready to paste into an image generator (Gemini / GPT image / Midjourney).
//
// Launch batch (default): 41 prompts. Emits three-row character sprite
// strips plus the other launch assets. Skips anything marked
// "status": "deferred" in the SSOT — boardroom/demoday stage layers +
// textures, and the epic/legendary weapon sheets.
//
// Usage:
//   node tools/build-prompts.mjs                       # launch batch, Gemini copy/paste .txt
//   node tools/build-prompts.mjs --only stages         # single bucket
//   node tools/build-prompts.mjs --only characters     # (stages | characters |
//   node tools/build-prompts.mjs --only portraits      #  portraits | weapons |
//   node tools/build-prompts.mjs --only weapons        #  objectives | ui)
//   node tools/build-prompts.mjs --only objectives
//   node tools/build-prompts.mjs --only ui             # locked-slot placeholder
//   node tools/build-prompts.mjs --include-deferred    # launch + deferred
//   node tools/build-prompts.mjs --format gemini       # Gemini copy/paste .txt (default)
//   node tools/build-prompts.mjs --format gpt          # GPT image copy/paste .txt
//   node tools/build-prompts.mjs --format chat         # alias for Gemini copy/paste .txt
//   node tools/build-prompts.mjs --format mj           # Midjourney /imagine .txt
//   node tools/build-prompts.mjs --format text         # human-readable .txt
//   node tools/build-prompts.mjs --format gemini-jsonl # Gemini-ready JSONL to stdout
//   node tools/build-prompts.mjs --format gpt-jsonl    # GPT image-ready JSONL to stdout
//   node tools/build-prompts.mjs --format jsonl        # raw records JSONL to stdout
//   node tools/build-prompts.mjs --stdout              # print copy/paste formats instead
//
// Launch → 41 prompts. With --include-deferred → 61 (adds 16 boardroom/demoday
// stage assets + 4 epic/legendary weapon sheets).
//
// Each emitted record has:
//   out          — asset path the renderer expects
//   genW/genH    — resolution to generate at
//   outW/outH    — final pixel size after nearest-neighbor downscale
//   seed         — deterministic seed
//   prompt       — full prompt (base + styleSuffix)
//   negative     — negative prompt
//   grid         — sprite-sheet layout (sheets only)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SSOT = path.resolve(__dirname, "../theming/visual-theme.v1.json");
const doc = JSON.parse(fs.readFileSync(SSOT, "utf8"));

const STYLE = doc.artDirection.styleSuffix;
const NEG = doc.artDirection.negativePrompt;

const args = process.argv.slice(2);
const only = arg("--only");
const requestedFormat = arg("--format") ?? "gemini";
const format = normalizeFormat(requestedFormat);
const stdout = args.includes("--stdout");
const explicitOut = arg("--out");
const outputDir = arg("--output-dir") ?? path.resolve(__dirname, "../theming/generated-prompts");
// Deferred assets (non-playable stages, epic+legendary weapons) are
// hidden from the launch batch. Pass --include-deferred to emit them
// (e.g. when unlocking Boardroom/Demoday or higher weapon rarities).
const includeDeferred = args.includes("--include-deferred");

const records = [];
if (!only || only === "stages")     records.push(...collectStages());
if (!only || only === "characters") records.push(...collectCharacterSheets());
if (!only || only === "portraits")  records.push(...collectPortraits());
if (!only || only === "weapons")    records.push(...collectWeapons());
if (!only || only === "objectives") records.push(...collectObjectives());
if (!only || only === "ui")         records.push(...collectUi());

// Filter deferred unless explicitly opted in.
const filtered = includeDeferred ? records : records.filter((r) => !r.deferred);
const rendered = renderRecords(format, filtered);
const shouldWriteFile = explicitOut || (rendered.autoFile && !stdout);

if (shouldWriteFile) {
  const outPath = explicitOut ? path.resolve(explicitOut) : defaultOutputPath(format, rendered.ext);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, rendered.text);
  const rel = path.relative(process.cwd(), outPath);
  process.stdout.write(`wrote ${filtered.length} prompts to ${rel}\n`);
  process.stdout.write(`format: ${rendered.label}; use --stdout to print instead\n`);
} else {
  process.stdout.write(rendered.text);
}

function collectStages() {
  const stages = doc.prompts.stages;
  const out = [];
  for (const [key, v] of Object.entries(stages)) {
    out.push(promptRecord({
      out: v.out ?? `assets/stages/${key}`,
      outW: v.outW, outH: v.outH, genW: v.genW, genH: v.genH,
      seed: v.seed,
      basePrompt: v.base,
      kind: v.kind,
      deferred: v.status === "deferred",
    }));
  }
  return out;
}

function collectCharacterSheets() {
  const shared = doc.prompts.characterSheets._sharedRules;
  const rowsPerPrompt = shared.rowsPerPrompt ?? 3;
  const scale = shared.genCellW / shared.cellW;
  const rawPadding = Math.round(6 * scale);
  const rawCoreW = shared.genCellW - rawPadding * 2;
  const rawCoreH = shared.genCellH - rawPadding * 2;
  const stripGenW = shared.cols * shared.genCellW;
  const stripGenH = rowsPerPrompt * shared.genCellH;
  const stripOutW = shared.cols * shared.cellW;
  const stripOutH = rowsPerPrompt * shared.cellH;
  const out = [];
  for (const [char, v] of Object.entries(doc.prompts.characterSheets)) {
    if (char.startsWith("_")) continue;
    const characterDeferred = v.status === "deferred";
    const characterBase = stripFullSheetInstruction(v.base);
    for (let start = 0; start < shared.animationRows.length; start += rowsPerPrompt) {
      const rows = shared.animationRows.slice(start, start + rowsPerPrompt);
      const rowStart = rows[0].row;
      const rowEnd = rows[rows.length - 1].row;
      const rowLines = rows.flatMap((row, i) => {
        const used = row.frames;
        const empty = shared.cols - used;
        const emptyInstruction = empty > 0
          ? `In grid row ${i + 1}, fill cells ${used + 1}-${shared.cols} with only pure magenta #FF00FF background.`
          : `In grid row ${i + 1}, fill all six cells with animation frames.`;
        const tauntHint = row.anim === "taunt" && shared.taunt[char]
          ? [`Grid row ${i + 1} character-specific gesture: ${shared.taunt[char]}.`]
          : [];
        return [
          `Grid row ${i + 1} is source animation row ${row.row}: ${row.anim}.`,
          `Draw grid row ${i + 1}, frames 1-${used}: ${row.pose}.`,
          emptyInstruction,
          ...tauntHint,
        ];
      });
      const stripName = `rows-${String(rowStart).padStart(2, "0")}-${String(rowEnd).padStart(2, "0")}.png`;
      out.push(promptRecord({
        out: v.out.replace(/\/sprite\.png$/, `/row-strips/${stripName}`),
        finalOut: v.out,
        outW: stripOutW, outH: stripOutH, genW: stripGenW, genH: stripGenH,
        seed: v.seed + rowStart,
        basePrompt: [
          characterBase,
          `Animation strip only: source rows ${rowStart}-${rowEnd}.`,
          `Exact canvas: ${stripGenW}x${stripGenH}. Exact grid: ${shared.cols} columns x ${rows.length} rows. Each cell is exactly ${shared.genCellW}x${shared.genCellH}.`,
          ...rowLines,
          `Invisible cell boundaries are exact vertical cuts every ${shared.genCellW}px and exact horizontal cuts every ${shared.genCellH}px; no visible grid lines, no separators, no gutters, no margins, no contact sheet labels.`,
          "Same character, same outfit, same scale, same camera-facing-right orientation in every populated cell.",
          "Character-only animation frames: do not draw walls, floors, platforms, scenery, props, weapons, slash arcs, hit sparks, UI, or effects. Express actions through body pose only.",
          `Character silhouette is a TALL HUMAN FIGURE with aspect approximately 1:2 — in the final ${shared.cellW}x${shared.cellH} cell, the figure should read as ~${Math.round(shared.cellW * 0.44)} pixels wide by ~${Math.round(shared.cellH * 0.81)} pixels tall (matches the sim hitbox aspect). At the raw ${shared.genCellW}x${shared.genCellH} cell size, center the body with about ${Math.round((shared.genCellW - shared.genCellW * 0.44) / 2)}px pure magenta padding on each side and about ${Math.round((shared.genCellH - shared.genCellH * 0.81) / 2)}px magenta padding above the head and below the feet. Do NOT draw a square silhouette — human figures are roughly 1:2 tall.`,
          "Do not draw weapons on this strip.",
        ].filter(Boolean).join("\n"),
        grid: {
          cols: shared.cols,
          rows: rows.length,
          sourceRows: rows.map((row) => row.row),
          anims: rows.map((row) => row.anim),
          frames: rows.map((row) => row.frames),
          fps: rows.map((row) => row.fps),
          cellW: shared.cellW,
          cellH: shared.cellH,
          genCellW: shared.genCellW,
          genCellH: shared.genCellH,
          finalSheet: v.out,
        },
        assembly: {
          finalOut: v.out,
          rowStart,
          rowEnd,
          source: stripName,
          finalSheetSize: { width: shared.outW, height: shared.outH },
        },
        deferred: characterDeferred,
      }));
    }
  }
  return out;
}

function collectPortraits() {
  const out = [];
  // New shape: one 2x2 portrait sheet per character (neutral/hurt/ko/victory),
  // plus a separate large character-select portrait per character.
  const sheets = doc.prompts.portraitSheets;
  if (sheets) {
    const shared = sheets._sharedRules;
    for (const [char, v] of Object.entries(sheets)) {
      if (char.startsWith("_")) continue;
      out.push(promptRecord({
        out: v.out,
        outW: shared.outW, outH: shared.outH, genW: shared.genW, genH: shared.genH,
        seed: v.seed,
        basePrompt: `${v.base}\n\n${shared.layoutDirective}`,
        grid: { cols: shared.cols, rows: shared.rows, cellW: shared.cellW, cellH: shared.cellH,
                genCellW: shared.genCellW, genCellH: shared.genCellH, cellOrder: shared.cellOrder },
        deferred: v.status === "deferred",
      }));
    }
  }
  const large = doc.prompts.portraitsLarge;
  if (large) {
    const shared = large._sharedRules;
    for (const [char, v] of Object.entries(large)) {
      if (char.startsWith("_")) continue;
      out.push(promptRecord({
        out: v.out,
        outW: shared.outW, outH: shared.outH, genW: shared.genW, genH: shared.genH,
        seed: v.seed,
        basePrompt: `${v.base}. ${shared.layoutDirective}`,
        deferred: v.status === "deferred",
      }));
    }
  }
  return out;
}

function collectWeapons() {
  // Launch = common+rare per character. Deferred = epic+legendary per
  // character, hidden unless --include-deferred. lockedSlot is the
  // shared locked-placeholder icon, always included in launch.
  const out = [];
  const launch = doc.prompts.weaponSheetsLaunch;
  if (launch) {
    const shared = launch._sharedRules;
    for (const [char, v] of Object.entries(launch)) {
      if (char.startsWith("_")) continue;
      out.push(promptRecord({
        out: v.out,
        outW: shared.outW, outH: shared.outH, genW: shared.genW, genH: shared.genH,
        seed: v.seed,
        basePrompt: `${v.base}\n\n${shared.layoutDirective}`,
        grid: { cols: shared.cols, rows: shared.rows, cellW: shared.cellW, cellH: shared.cellH,
                genCellW: shared.genCellW, genCellH: shared.genCellH, cellOrder: shared.cellOrder },
        deferred: v.status === "deferred",
      }));
    }
  }
  const deferred = doc.prompts.weaponSheetsDeferred;
  if (deferred) {
    const shared = deferred._sharedRules;
    for (const [char, v] of Object.entries(deferred)) {
      if (char.startsWith("_")) continue;
      out.push(promptRecord({
        out: v.out,
        outW: shared.outW, outH: shared.outH, genW: shared.genW, genH: shared.genH,
        seed: v.seed,
        basePrompt: `${v.base}\n\n${shared.layoutDirective}`,
        grid: { cols: shared.cols, rows: shared.rows, cellW: shared.cellW, cellH: shared.cellH,
                genCellW: shared.genCellW, genCellH: shared.genCellH, cellOrder: shared.cellOrder },
        deferred: true,
      }));
    }
  }
  return out;
}

function collectUi() {
  const ui = doc.prompts.lockedSlot;
  if (!ui) return [];
  const shared = ui._sharedRules;
  const out = [];
  for (const [key, v] of Object.entries(ui)) {
    if (key.startsWith("_")) continue;
    out.push(promptRecord({
      out: v.out,
      outW: v.outW ?? shared.outW,
      outH: v.outH ?? shared.outH,
      genW: v.genW ?? shared.genW,
      genH: v.genH ?? shared.genH,
      seed: v.seed,
      basePrompt: `${v.base} ${shared.layoutDirective}`,
    }));
  }
  return out;
}

function collectObjectives() {
  const objectives = doc.prompts.objectives ?? {};
  const out = [];
  for (const [key, v] of Object.entries(objectives)) {
    if (key.startsWith("_")) continue;
    out.push(promptRecord({
      out: v.out,
      outW: v.outW,
      outH: v.outH,
      genW: v.genW,
      genH: v.genH,
      seed: v.seed,
      basePrompt: v.base,
      kind: v.kind,
    }));
  }
  return out;
}

function stripFullSheetInstruction(base) {
  return base.replace(/\s*Include all 12 animation rows in the shared sprite-sheet layout\.$/, "");
}

function promptRecord({ out, finalOut, outW, outH, genW, genH, seed, basePrompt, grid, assembly, deferred }) {
  return {
    out, finalOut, outW, outH, genW, genH, seed,
    prompt: `${basePrompt}\n\nSTYLE: ${STYLE}`,
    negative: NEG,
    grid,
    assembly,
    deferred: deferred ?? false,
  };
}

function renderRecords(format, sourceRecords) {
  let text = "";
  if (format === "raw-jsonl") {
    for (const r of sourceRecords) text += JSON.stringify(r) + "\n";
    return { text, ext: "jsonl", label: "raw prompt JSONL", autoFile: false };
  }
  if (format === "mj") {
    for (const r of sourceRecords) {
      const ar = reduceAr(r.genW, r.genH);
      text +=
        `/imagine prompt: ${r.prompt} --ar ${ar} --style raw --seed ${r.seed} --stylize 100\n` +
        `# out: ${r.out}  target ${r.outW}x${r.outH}  from ${r.genW}x${r.genH}${r.deferred ? "  DEFERRED" : ""}\n\n`;
    }
    return { text, ext: "txt", label: "Midjourney copy/paste text", autoFile: true };
  }
  if (format === "gemini-jsonl") {
    for (const r of sourceRecords) text += JSON.stringify(providerRecord("gemini", r)) + "\n";
    return { text, ext: "jsonl", label: "Gemini provider JSONL", autoFile: false };
  }
  if (format === "gpt-jsonl") {
    for (const r of sourceRecords) text += JSON.stringify(providerRecord("gpt", r)) + "\n";
    return { text, ext: "jsonl", label: "GPT image provider JSONL", autoFile: false };
  }
  if (format === "gemini-copy") {
    for (const r of sourceRecords) text += copyPasteBlock("gemini", r);
    return { text, ext: "txt", label: "copy/paste prompt text", autoFile: true };
  }
  if (format === "gpt-copy") {
    for (const r of sourceRecords) text += copyPasteBlock("gpt", r);
    return { text, ext: "txt", label: "fixed-canvas copy/paste prompt text", autoFile: true };
  }
  if (format === "text") {
    for (const r of sourceRecords) {
      const header = `=== ${r.out}  (gen ${r.genW}x${r.genH} -> out ${r.outW}x${r.outH}, seed ${r.seed}${r.deferred ? ", DEFERRED" : ""})`;
      text += header + "\n" + r.prompt + "\n\nNEGATIVE: " + r.negative + "\n\n";
      if (r.grid) text += "GRID: " + JSON.stringify(r.grid) + "\n\n";
    }
    return { text, ext: "txt", label: "human-readable prompt text", autoFile: true };
  }
  throw new Error(`unhandled format ${format}`);
}

function providerRecord(provider, r) {
  const defaults = doc.artDirection.modelDefaults?.[provider] ?? {};
  const backgroundInstruction =
    `Use ${doc.artDirection.bgKeyColor} as the keyed background for sprites and isolated moving assets. ` +
    doc.artDirection.silhouetteRule;
  const postProcess = [
    doc.artDirection.downscale,
    ...(doc.artDirection.postProcess ?? []),
  ];
  // Gemini and GPT have no native negative-prompt slot. Fold negatives
  // into the prompt body as "Avoid: ..." so the emitted `combinedPrompt`
  // is directly paste-ready with no further assembly required.
  const combinedPrompt = promptBody(provider, r);
  const logicalAspect = reduceAr(r.genW, r.genH);
  let apiSize = null;
  let seedSupported = false;
  if (provider === "gpt") {
    apiSize = nearestGptSize(r.genW, r.genH);
    seedSupported = false;
  } else if (provider === "gemini") {
    apiSize = null;
    seedSupported = true;
  }

  return {
    provider,
    modelDefaults: defaults,
    out: r.out,
    finalOut: r.finalOut ?? null,
    targetSize: { width: r.outW, height: r.outH },
    generationSize: { width: r.genW, height: r.genH },
    apiSize,
    aspectRatio: logicalAspect,
    seed: r.seed,
    seedSupported,
    prompt: r.prompt,
    negativePrompt: r.negative,
    combinedPrompt,
    backgroundInstruction,
    postProcess,
    grid: r.grid ?? null,
    assembly: r.assembly ?? null,
    deferred: r.deferred,
  };
}

function copyPasteBlock(provider, r) {
  const grid = r.grid
    ? [`GRID METADATA: ${JSON.stringify(r.grid)}`]
    : [];
  const postProcess = [
    `POST-PROCESS AFTER GENERATION: nearest-neighbor downscale ${r.genW}x${r.genH} to ${r.outW}x${r.outH}.`,
    "Then key the near-#FF00FF background to alpha with RGB-distance tolerance 24, crop only generator-added outer borders, and preserve exact grid cuts.",
  ];
  const assembly = r.assembly
    ? [`ASSEMBLY: ${JSON.stringify(r.assembly)}`]
    : [];
  const deferred = r.deferred ? "  DEFERRED" : "";
  const aspect = reduceAr(r.genW, r.genH);
  const canvasHint = provider === "gpt"
    ? `GENERATOR CANVAS: use ${nearestGptSizeLabel(r.genW, r.genH)} if the tool requires a fixed canvas; preserve logical ${aspect}.`
    : `GENERATOR CANVAS: ${r.genW}x${r.genH}, aspect ${aspect}.`;
  const finalOut = r.finalOut ? [`FINAL SHEET: ${r.finalOut}`] : [];
  return [
    "================================================================================",
    `ASSET: ${r.out}${deferred}`,
    ...finalOut,
    canvasHint,
    `SEED: ${r.seed}`,
    ...postProcess,
    ...assembly,
    ...grid,
    "",
    "COPY FROM BEGIN PROMPT TO END PROMPT:",
    "BEGIN PROMPT",
    promptBody(provider, r),
    "",
    "END PROMPT",
    "",
  ].join("\n") + "\n";
}

function promptBody(provider, r) {
  return [
    "Create exactly the game asset sprite sheet or image described below. Output image only; do not add captions, labels, watermarks, UI chrome, contact sheets, filenames, or explanatory text.",
    "",
    ...assetContract(provider, r),
    "",
    r.prompt,
    "",
    `Avoid: ${r.negative}`,
    "",
    "Technical requirements:",
    `- Use ${doc.artDirection.bgKeyColor} as the exact background color where the prompt requests an isolated sprite, portrait, weapon, objective, or transparent layer.`,
    `- ${doc.artDirection.silhouetteRule}`,
    "- Keep hard pixel edges, clean silhouettes, and exact grid alignment where a grid is specified.",
  ].join("\n");
}

function assetContract(provider, r) {
  const aspect = reduceAr(r.genW, r.genH);
  const lines = [
    "Asset contract:",
    `- Raw generator canvas target: ${r.genW}x${r.genH}, aspect ${aspect}.`,
    `- Final asset after local post-process: ${r.outW}x${r.outH}.`,
    `- If the generator outputs a larger proportional image, preserve the same ${aspect} aspect ratio and the same internal layout proportions.`,
    `- Local post-process will center-crop only generator-added outer border or slight aspect drift, nearest-neighbor resize to ${r.outW}x${r.outH}, then key the near-${doc.artDirection.bgKeyColor} background to transparent alpha with RGB-distance tolerance 24.`,
    "- Compose the image so it remains clean and correctly aligned after that exact post-process.",
  ];
  if (provider === "gpt") {
    lines.push(`- If the image tool forces ${nearestGptSizeLabel(r.genW, r.genH)}, keep the active art area in a centered ${aspect} rectangle and fill any extra outer area with ${doc.artDirection.bgKeyColor}.`);
  }
  if (r.grid) {
    lines.push(
      "Sprite grid contract:",
      `- Raw grid: ${r.grid.cols} columns x ${r.grid.rows} rows.`,
      `- Raw cell size: ${r.grid.genCellW}x${r.grid.genCellH}.`,
      `- Final cell size after local post-process: ${r.grid.cellW}x${r.grid.cellH}.`,
      "- Cell boundaries are invisible layout coordinates only; do not draw visible grid lines, separators, gutters, labels, rulers, borders, or decorative frames."
    );
  }
  if (r.assembly) {
    lines.push(
      "Sprite assembly contract:",
      `- This strip is source rows ${r.assembly.rowStart}-${r.assembly.rowEnd} of a ${r.assembly.finalSheetSize.width}x${r.assembly.finalSheetSize.height} final sprite sheet.`,
      "- Keep scale, pose registration, and horizontal facing consistent with the other strips for the same character."
    );
  }
  return lines;
}

function nearestGptSize(genW, genH) {
  const ratio = genW / genH;
  const choices = [
    { w: 1024, h: 1024, r: 1.0 },
    { w: 1536, h: 1024, r: 1.5 },
    { w: 1024, h: 1536, r: 2 / 3 },
  ];
  let best = choices[0], bestDist = Infinity;
  for (const c of choices) {
    const dist = Math.abs(Math.log(ratio) - Math.log(c.r));
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return { width: best.w, height: best.h };
}

function nearestGptSizeLabel(genW, genH) {
  const size = nearestGptSize(genW, genH);
  return `${size.width}x${size.height}`;
}

function normalizeFormat(value) {
  switch (value) {
    // Chat/copy are convenience aliases for the default manual-paste path.
    // Keep them mapped to an existing renderer so the format table cannot
    // drift into an unhandled state.
    case "chat":
    case "copy":
      return "gemini-copy";
    case "gemini":
    case "gemini-text":
    case "gemini-copy":
      return "gemini-copy";
    case "gpt":
    case "gpt-text":
    case "gpt-copy":
      return "gpt-copy";
    case "gemini-jsonl":
      return "gemini-jsonl";
    case "gpt-jsonl":
      return "gpt-jsonl";
    case "jsonl":
      return "raw-jsonl";
    case "mj":
    case "text":
      return value;
    default:
      process.stderr.write(
        `Unknown --format ${JSON.stringify(value)}. ` +
        "Use gemini (default), chat, gpt, mj, text, gemini-jsonl, gpt-jsonl, or jsonl.\n"
      );
      process.exit(1);
  }
}

function formatFileSlug(format) {
  if (requestedFormat === "chat" || requestedFormat === "copy") return "chat";
  if (format === "gemini-copy") return "gemini";
  if (format === "gpt-copy") return "gpt";
  return format;
}

function defaultOutputPath(format, ext) {
  const bucket = only ?? "launch";
  const deferred = includeDeferred ? "-with-deferred" : "";
  const stamp = timestamp();
  return path.join(outputDir, `${stamp}-${slug(bucket)}-${formatFileSlug(format)}${deferred}.${ext}`);
}


function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function reduceAr(w, h) {
  const g = gcd(w, h); return `${w / g}:${h / g}`;
}
function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
