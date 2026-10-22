# Theming

Visual assets only.

This directory owns:

- stage palettes, textures, parallax layers, and visual particles
- character sprite sheets, portraits, and color palettes
- weapon sprites, trails, and hit VFX
- objective payload/target sprites and VFX
- image-generation prompts and visual art direction

This directory must not own:

- gameplay rules, scoring, hitboxes, or replay semantics
- goal labels, HUD text, fighter names, voice lines, or weapon names
- reward tracks or economy metadata
- release selection such as which pack is active
- generated balance data such as preset rankings

Those live in `content/`, `config/`, `data/`, or `docs/`.

## Asset generation workflow

SSOT: `theming/visual-theme.v1.json`. Expand to per-asset prompts
with `tools/build-prompts.mjs`. Seeds, target dimensions, background-
key rule, and grid directives are locked per entry.

Prompt requests must use exact `1x`, `2x`, or `3x` dimensions. The builder validates the request, not the returned image: providers can ignore it. Never assume a generation meets the grid. Unexpected source sizes or shifted cells are drafts until explicitly inspected, normalized through nearest-neighbor export and reviewed per-pose crop/packing, then validated against final frame bounds. Preserve a receipt of source hashes, crop rectangles and any export normalization. Do not silently clip limbs at nominal grid cuts.

Stage prompts also receive a shared runtime scale contract: the arena is
`1280x720`, fighters render from unscaled `64x64` sprite cells, and the
readable body / sim hitbox target is about `28x56`. Use that contract when
judging whether props and backgrounds make fighters look correctly sized.
The prompt builder also injects a depth contract per stage asset so `sky`,
`far_parallax`, `mid_parallax`, `near_parallax`, platform textures, walls,
and floor decals each know how far they sit from the combat plane.

### Character Prompt Aliases

Legacy prompts use Character A–D aliases. New parody prompts explicitly describe their intended identity and non-graphic m3t4.com game context. Never disguise a request to bypass a tool rejection. Runtime IDs remain stable.

| prompt alias | internal character |
|---|---|
| Character A | Sama |
| Character B | Darrius |
| Character C | Demis |
| Character D | Mark |
| Jensen parody | Jensen |
| Elon parody | Elon |

### Playable scope

Six bodies are authored: Sama, Darrius, Demis, Mark, Jensen and Elon. Each has 41 runtime body poses, four portrait cells and a four-item weapon atlas. The three live stages use code-native faceted scenery in `client/render/stage-art.js`. Stage image prompts and source textures remain archived design references; generating them does not update the live scene.

The builder's counts are derived from entries: `--only characters` currently emits 18 packed prompts, and portraits/weapons each emit six. Effects remain code-native; no universal effects-sheet contract is claimed.

### Batches

| batch | command | count |
|---|---|---:|
| Playable, copy/paste (six fighters, all 3 stages) | `node tools/build-prompts.mjs` | **40 files** |
| Six fighters, packed 4x4 copy/paste | `node tools/build-prompts.mjs --only characters` | 18 files |
| Stage atlases only | `node tools/build-prompts.mjs --only stages` | 7 files |
| Playable, flat one prompt per stage asset | `node tools/build-prompts.mjs --flat-stages` | **57 files** |
| Playable, GPT-sized copy/paste | `node tools/build-prompts.mjs --format gpt` | **40 files** |
| Playable, Midjourney copy/paste | `node tools/build-prompts.mjs --format mj` | **40 files** |
| Missing assets, one paste-ready `.txt` per asset | `node tools/build-prompts.mjs --missing-only` | varies |
| Playable, Gemini JSONL | `node tools/build-prompts.mjs --format gemini-jsonl` | **40** |
| Playable, GPT image JSONL | `node tools/build-prompts.mjs --format gpt-jsonl` | **40** |

### Common commands

```bash
# Copy/paste playable batch (default). Writes a timestamped directory in
# theming/generated-prompts/. Every .txt inside is one paste-ready prompt.
# INDEX.md maps prompt filenames back to asset paths.
node tools/build-prompts.mjs

# Single bucket: stages | characters | portraits | weapons | objectives | ui
node tools/build-prompts.mjs --only weapons
node tools/build-prompts.mjs --only characters --format gemini
node tools/build-prompts.mjs --only characters --format chat

# Stage atlas prompts: preview thumbnails are one atlas, each stage has one
# layer atlas and one texture atlas. Slice metadata in INDEX.md / ASSEMBLY
# maps each atlas row back to the promoted asset paths.
node tools/build-prompts.mjs --only stages

# Old flat stage path, useful for regenerating a single stage asset by path.
node tools/build-prompts.mjs --only stages --flat-stages

# Easiest manual generation mode: writes one .txt per asset, and every
# .txt file contains only the prompt body you paste into the generator.
# INDEX.md in the generated directory maps filenames back to asset paths.
node tools/build-prompts.mjs --missing-only

# Character sheets are generated as 3 packed sheets per character:
# generate 768x768 raw packs, then post-process 3x down to 256x256
# packed sheets, then compose 3 packs into the 384x768 runtime sheet.
# Paste the whole .txt file into the image tool.

# Midjourney /imagine lines; also writes a timestamped .txt by default.
node tools/build-prompts.mjs --only portraits --format mj

# Full JSONL for batch API ingestion
node tools/build-prompts.mjs --format jsonl > prompts.jsonl

# Provider-specific JSONL
node tools/build-prompts.mjs --format gemini-jsonl > prompts.gemini.jsonl
node tools/build-prompts.mjs --format gpt-jsonl > prompts.gpt.jsonl

# Print copy/paste blocks to stdout instead of writing a timestamped file.
node tools/build-prompts.mjs --format gemini --stdout

# Legacy combined copy/paste file, mostly useful for bulk review.
node tools/build-prompts.mjs --combined-file

```

### Storage

- Raw generations (pre-downscale, gitignored): `generations/raw/<asset-path>`
- Generated prompt files (gitignored): `theming/generated-prompts/`
- Promoted assets (final, served by client): `client/<asset-path>`
- The SSOT's `out` field is the authoritative promoted path.

### Importing numbered raw generations

When you paste a complete prompt batch into an image generator and download each
as sequentially numbered PNGs into a single folder, import them in one pass:

```bash
node tools/import-raws.mjs theming/generated-prompts/<ts>-launch-gemini-files ~/Downloads/new
```

The tool reads the prompt run's `INDEX.md`, maps each numbered input to
its declared `generations/raw/assets/...` path, erases the bottom-right
Gemini sparkle watermark via `tools/lib/erase-watermark.mjs`, and writes
the result to the raw path. Flags: `--dry-run`, `--only '00[1-7]'`,
`--no-erase`, `--force`.

Follow with a single end-to-end build:

```bash
node tools/build-assets.mjs
```

which walks `generations/raw/assets/` to run postprocess per file, then
`assemble-character-sheet.mjs` per character variant, then `cwebp` for
stage layers + preview thumbnails. Install `cwebp` first (macOS:
`brew install webp`) or the runtime will keep loading stale `.webp` files.

### Post-process before promoting

Use `tools/postprocess-generation.mjs` after saving the raw PNG under
`generations/raw/<asset-path>`. The tool infers the final size from the
visual theme when possible. Stage atlas paths are inferred as multi-output
assets and are sliced into the promoted stage files automatically.

```bash
node tools/postprocess-generation.mjs generations/raw/assets/chars/sama/monastic_infra/packed/pack-00.png
node tools/postprocess-generation.mjs generations/raw/assets/stages/datacenter/cold_aisle_chapel/_atlases/layers.png
```

The post-processor:

1. Reads oversized proportional PNGs from the image generator.
2. Center-crops only enough to match the target aspect ratio.
3. Nearest-neighbor downsizes to the theme target size.
4. Keys the near-`#FF00FF` background to alpha with RGB-distance tolerance 24.
5. Clears unused packed-sheet cells such as the intentional bottom-right blank.
6. Clears inferred sprite-grid separator lines unless `--keep-grid-lines` is passed.
7. Writes the promoted asset under `client/<asset-path>`.

For stage atlases, the post-processor first normalizes the atlas canvas, then
extracts each row/active crop into the existing promoted asset paths. The
default stage atlas batch contains one preview atlas, one layer atlas per
stage, and one texture atlas per stage.

Character prompts now use three packed 4x4 sheets per character:

- Raw generation size: `768x768`.
- Promoted packed-sheet size: `256x256`.
- Cells 1-15 are populated left-to-right, top-to-bottom.
- Cell 16, the bottom-right cell, is intentionally blank pure `#FF00FF`.
- The final pack includes four populated overflow cells so each prompt stays visually full; local assembly ignores those cells.

After the three packed character sheets are promoted, assemble the final runtime
sprite sheet:

```bash
node tools/assemble-character-sheet.mjs client/assets/chars/sama/monastic_infra
```

### Full Batch

The prompt SSOT no longer defers Character C/D or advanced weapon art.
All four bodies and all four weapon lines are generated from the default
command. The shared `lockedSlot` prompt still exists for UI states that
need a generic locked icon.

### Current runtime contract

- Body: 384×768, 6×12, 64px cells, 41 unique poses. Right-facing source, empty hands, no baked slash effects.
- Portrait: 192×192, 2×2, 96px cells: neutral/hurt/KO/full-body.
- Weapon: 96×96, 2×2, 48px cells: common/rare/epic/legendary. Four static items, not animation rows. Opaque grip/tip pixels are calibrated to the same live collision segment in `fighter-art.js`.
- Alpha: transparent background or keyed magenta export, normalized transparent matte. Pixel-art weapon export quantizes the generated soft alpha at128 before padding/cell calibration.
- New source poses may be cropped and packed, never replaced with idle stand-ins. Preserve all intended silhouette pixels at runtime scale; keep blank cell cuts. No per-character physics changes.

See `docs/render-contract.md` for actual runtime ownership and `client/test/new-roster-art.test.mjs` for the new fighters' per-cell acceptance gate.
