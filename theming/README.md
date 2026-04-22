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

Every generated source canvas must be an exact `1x`, `2x`, or `3x`
multiple of the promoted output dimensions. The prompt builder enforces
this rule before it writes prompts, so fractional downscales and larger
ratios cannot silently enter the art pipeline.

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

### Playable scope

The current playable art set ships **Character A (Sama) + Character B
(Darrius)** and **all three stages**: Datacenter, Boardroom, and Demo
Day. Character C/D and epic/legendary weapon sheets stay marked
`"status": "deferred"` in the SSOT and stay out of the default batch
until `--include-deferred` is passed.

### Batches

| batch | command | count |
|---|---|---:|
| Playable, copy/paste (Chars A+B, all 3 stages) | `node tools/build-prompts.mjs` | **43 files** |
| Characters A+B, 4-row strip copy/paste | `node tools/build-prompts.mjs --only characters` | 8 files |
| Playable, GPT-sized copy/paste | `node tools/build-prompts.mjs --format gpt` | **43 files** |
| Playable, Midjourney copy/paste | `node tools/build-prompts.mjs --format mj` | **43 files** |
| With deferred (unlocks Chars C+D and epic/legendary weapons) | `node tools/build-prompts.mjs --include-deferred` | 61 |
| Missing assets, one paste-ready `.txt` per asset | `node tools/build-prompts.mjs --include-deferred --missing-only` | varies |
| Playable, Gemini JSONL | `node tools/build-prompts.mjs --format gemini-jsonl` | **43** |
| Playable, GPT image JSONL | `node tools/build-prompts.mjs --format gpt-jsonl` | **43** |

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

# Easiest manual generation mode: writes one .txt per asset, and every
# .txt file contains only the prompt body you paste into the generator.
# INDEX.md in the generated directory maps filenames back to asset paths.
node tools/build-prompts.mjs --include-deferred --missing-only

# Character sheets are generated as 4 strips per character:
# generate 1152x576 raw strips, then post-process 3x down to 384x192
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

# Include deferred locked characters/weapons (later)
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

Entries with `"status": "deferred"` are skipped in the default playable batch.
Today's deferred set:

- **Characters C + D** (Demis, Mark) — sprite sheets, portrait sheets,
  large portraits, and launch weapon sheets. All appear in the UI as
  locked character slots until unlocked.
- **Epic + Legendary weapon sheets** (all 4 characters). UI shows the
  shared `lockedSlot` placeholder in those slots at launch.

Run `node tools/build-prompts.mjs --include-deferred` when unlocking.
