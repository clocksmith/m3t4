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

### Character Prompt Aliases

Generated prompt text uses neutral aliases so image tools do not receive
real-world or final in-game character names. Runtime IDs and asset paths
still use the stable internal keys.

| prompt alias | internal character |
|---|---|
| Character A | Sama |
| Character B | Darrius |
| Character C | Demis |
| Character D | Mark |

### Launch scope

Launch ships **Character A (Sama) + Character B (Darrius) only** and the
**Datacenter stage only**. Character C/D and the other two stages are
marked `"status": "deferred"` in the SSOT and stay out of the default
batch until `--include-deferred` is passed.

### Batches

| batch | command | count |
|---|---|---:|
| Launch, copy/paste (Chars A+B, Datacenter only) | `node tools/build-prompts.mjs` | **25 files** |
| Characters A+B, 4-row strip copy/paste | `node tools/build-prompts.mjs --only characters` | 8 files |
| Launch, GPT-sized copy/paste | `node tools/build-prompts.mjs --format gpt` | **25 files** |
| Launch, Midjourney copy/paste | `node tools/build-prompts.mjs --format mj` | **25 files** |
| With deferred (unlocks Chars C+D, boardroom/demoday, epic/legendary) | `node tools/build-prompts.mjs --include-deferred` | 61 |
| Missing assets, one paste-ready `.txt` per asset | `node tools/build-prompts.mjs --include-deferred --missing-only` | varies |
| Launch, Gemini JSONL | `node tools/build-prompts.mjs --format gemini-jsonl` | **25** |
| Launch, GPT image JSONL | `node tools/build-prompts.mjs --format gpt-jsonl` | **25** |

### Common commands

```bash
# Copy/paste launch batch (default). Writes a timestamped directory in
# theming/generated-prompts/. Every .txt inside is one paste-ready prompt.
# INDEX.md maps prompt filenames back to asset paths.
node tools/build-prompts.mjs

# Single bucket: stages | characters | portraits | weapons | objectives | ui
node tools/build-prompts.mjs --only weapons
node tools/build-prompts.mjs --only characters --format gemini
node tools/build-prompts.mjs --only characters --format chat

# Easiest manual generation mode: writes one .txt per asset, and every
# .txt file contains only the prompt body you paste into the generator.
# INDEX.md in the generated directory maps filenames back to asset paths.
node tools/build-prompts.mjs --include-deferred --missing-only

# Character sheets are generated as 4 strips per character:
# generate proportional 2:1 raw strips, then post-process to 384x192
# final strips, then compose 4 strips into 384x768.
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

# Unlock deferred (later)
node tools/build-prompts.mjs --include-deferred --format gemini
```

### Storage

- Raw generations (pre-downscale, gitignored): `generations/raw/<asset-path>`
- Generated prompt files (gitignored): `theming/generated-prompts/`
- Promoted assets (final, served by client): `client/<asset-path>`
- The SSOT's `out` field is the authoritative promoted path.

### Post-process before promoting

Use `tools/postprocess-generation.mjs` after saving the raw PNG under
`generations/raw/<asset-path>`. The tool infers the final size from the
visual theme when possible.

```bash
node tools/postprocess-generation.mjs generations/raw/assets/chars/sama/monastic_infra/row-strips/rows-00-02.png
```

The post-processor:

1. Reads oversized proportional PNGs from the image generator.
2. Center-crops only enough to match the target aspect ratio.
3. Nearest-neighbor downsizes to the theme target size.
4. Keys the near-`#FF00FF` background to alpha with RGB-distance tolerance 24.
5. Clears cells beyond each animation row's declared frame count.
6. Clears inferred sprite-grid separator lines unless `--keep-grid-lines` is passed.
7. Writes the promoted asset under `client/<asset-path>`.

After four character strips are promoted, assemble the final runtime
sprite sheet:

```bash
node tools/assemble-character-sheet.mjs client/assets/chars/sama/monastic_infra
```

### Deferred assets

Entries with `"status": "deferred"` are skipped in the launch batch.
Today's deferred set:

- **Characters C + D** (Demis, Mark) — sprite sheets, portrait sheets,
  large portraits, and launch weapon sheets. All appear in the UI as
  locked character slots until unlocked.
- **Boardroom + Demoday stages** — all 18 entries (4 layers + 4
  textures + 1 preview thumb × 2 stages). The current renderer doesn't
  load images and there's no stage-select UI yet, so deferring all of
  them costs nothing visible. When a stage-select UI ships, regenerate
  with `--include-deferred`.
- **Epic + Legendary weapon sheets** (all 4 characters). UI shows the
  shared `lockedSlot` placeholder in those slots at launch.

Run `node tools/build-prompts.mjs --include-deferred` when unlocking.
